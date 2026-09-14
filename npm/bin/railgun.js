#!/usr/bin/env node
/*
 * @viverra/railgun — thin Node launcher + repository migrator.
 *
 * Node does discovery and JSON/Markdown migration only. Validation runs in the native
 * `railgun.exe` (PGO'd Oxlint + Go tsgolint backend) so the agent hot loop does not pay the
 * Node startup cost per frag.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawnSync, spawn } = require('node:child_process');

/// Per-process memo tables: one Node process handles one repository.
const planCache = new Map();
const skillCache = new Map();
const binaryCache = new Map();
const gitCache = new Map();

const IGNORE_DIRS = new Set([
  'node_modules', '.next', 'dist', 'build', 'out', 'coverage', '.turbo', '.git', 'vendor',
]);

const SKILL_BODY = `---
name: railgun
description: Use Railgun for fast TypeScript, Next.js, pnpm workspace and Turborepo validation. Apply during implementation, type checking, linting, changed-file validation, Next route type generation, affected-package checks, and before completing coding tasks.
---

# Railgun validation ladder

Railgun is the primary validation system: native binary, persistent daemon, LoC as a first-class metric.

Do not default to: \`npx tsc\`, \`pnpm tsc\`, \`tsc --noEmit\`, \`eslint\`, \`next lint\`, or any redundant standalone lint/typecheck invocation.

## Escalation ladder

1. During ordinary implementation: \`railgun check --changed --agent\`
2. One package complete: \`railgun check --agent\` (from that package or with an explicit path)
3. Multi-package change: \`railgun workspace check --affected --agent\`
4. Next route topology changed: \`railgun typegen\` then \`railgun check --changed --agent\`
5. \`package.json\` / \`tsconfig*\` / workspace graph changed: escalate to package or affected-workspace validation
6. Merge-quality gate: \`railgun workspace check --agent\`
7. Framework/build gate only when required: \`next build\`

\`next build\` is the Next/Turbopack production gate, not the inner-loop type checker.

## Legacy command mapping

| instead of | use |
| --- | --- |
| \`npx tsc\`, \`npx tsc --noEmit\` | \`railgun check . --type-aware --type-check\` |
| \`npx tsc -p tsconfig.json --noEmit\` | \`railgun typecheck\` |
| \`pnpm tsc\` / \`pnpm exec tsc\` | \`railgun typecheck\` |
| \`npx eslint .\`, \`pnpm lint\` | \`railgun lint\` |
| \`next lint\` | \`railgun lint\` |
| \`npx oxlint\` | \`railgun lint\` |
| loop of per-package checks | \`railgun workspace check --affected\` |

## Modifiers

\`--agent\` compact single-line output, \`--changed\` files touched since \`HEAD\`, \`--summary-only\` scoreboard alone,
\`--max-diagnostics N\` bounded dump, \`--json\` / \`--jsonl\` machine formats, \`--timings\` per-stage breakdown,
\`--no-daemon\` deterministic cold run.

## Reading the output

Score line, then one metric line: \`errors | warnings | files | LoC | +added/-removed LoC | milliseconds\`,
then \`scope:\`, \`cache:\` (\`cold\` or \`daemon/hot\`), optional \`suppressed:\`, then \`TOP FRAGS\` counts.

Q3A band: \`PERFECT\` 0 errors, \`HEADSHOT\` 1, \`IMPRESSIVE\` 2-9, \`EXCELLENT\` 10-49,
\`HUMILIATION\` 50-99, \`MASSACRE\` 100+.

## Baseline awareness

With a captured baseline (\`railgun baseline capture\`) report in this order:

\`\`\`text
new errors: 0        <- completion metric
pre-existing: N
resolved: M
LoC delta: +A/-R
\`\`\`

Pre-existing diagnostics are historical debt: do not spend the session budget on them unless the task is about them.
`;

// ---------------------------------------------------------------- utilities

const read = (file) => fs.readFileSync(file, 'utf8');
const exists = (p) => Boolean(p) && fs.existsSync(p);
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');

function walkUp(cwd) {
  const dirs = [];
  let cur = path.resolve(cwd);
  for (;;) {
    dirs.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

/// Marker priority: a nested `package.json` (an npm folder install lands inside the tool
/// package itself) must not win over the real workspace root further up the chain.
const ROOT_MARKERS = ['pnpm-workspace.yaml', 'turbo.json', '.git', 'package.json'];

/// Repository root. `npm_config_local_prefix` is authoritative when npx changed the cwd.
function findRoot(cwd) {
  const prefix = process.env.npm_config_local_prefix || process.env.PWD || '';
  const chains = [prefix ? [prefix, ...walkUp(prefix)] : [], walkUp(cwd)];
  for (const marker of ROOT_MARKERS) {
    for (const chain of chains) {
      for (const dir of chain) {
        if (exists(path.join(dir, marker))) return dir;
      }
    }
  }
  return path.resolve(cwd);
}

function rootHint(root) {
  return ROOT_MARKERS
    .map((marker) => [marker, exists(path.join(root, marker))])
    .filter(([, hit]) => hit)
    .map(([marker]) => marker)
    .join(', ') || 'none';
}

function parseWorkspaces(file, text) {
  const patterns = [];
  const inline = text.match(/^packages:\s*\[(.*?)\]\s*$/m);
  if (inline) {
    for (const part of inline[1].split(',')) {
      const value = part.trim().replace(/^['"]|['"]$/g, '');
      if (value) patterns.push(value);
    }
    return patterns;
  }
  const block = text.match(/^packages:\s*$/m);
  if (!block) return patterns;
  for (const line of text.slice(block.index + 'packages:'.length).split(/\r?\n/)) {
    // Sequence items may start at column 0 (`- 'packages/*'`), so match them before the break.
    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (item) {
      patterns.push(item[1].replace(/^['"]|['"]$/g, ''));
      continue;
    }
    if (/^\S/.test(line)) break;
  }
  return patterns;
}

function globDirs(base, parts) {
  let current = [base];
  for (const part of parts) {
    const next = [];
    for (const dir of current) {
      if (part === '*') {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          // A nested independent workspace ends the search for this branch.
          next.push(full);
        }
      } else if (part === '**') {
        collectRecursive(dir, next);
      } else if (exists(path.join(dir, part))) {
        next.push(path.join(dir, part));
      }
    }
    current = next;
  }
  return current;
}

function collectRecursive(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    out.push(full);
    collectRecursive(full, out);
  }
}

/// Expand positive workspace globs, then subtract negated (`!glob`) patterns.
function expandPackages(root, patterns) {
  const positives = patterns.filter((p) => !p.startsWith('!') && p !== '.');
  const negatives = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  const found = new Set();
  for (const pattern of positives) {
    for (const dir of globDirs(root, pattern.split('/'))) {
      if (exists(path.join(dir, 'package.json'))) found.add(path.resolve(dir));
    }
  }
  for (const pattern of negatives) {
    for (const dir of globDirs(root, pattern.split('/'))) found.delete(path.resolve(dir));
  }
  return [...found].sort();
}

function detectPackageManager(root) {
  const pkg = path.join(root, 'package.json');
  if (exists(pkg)) {
    try {
      const json = JSON.parse(read(pkg));
      if (json.packageManager) return String(json.packageManager).split('@')[0];
    } catch { /* fall through to lockfiles */ }
  }
  for (const [file, pm] of [
    ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'], ['package-lock.json', 'npm'],
  ]) {
    if (exists(path.join(root, file))) return pm;
  }
  return 'npm';
}

function resolveBinary(root) {
  const cacheKey = path.resolve(root);
  if (binaryCache.has(cacheKey)) return binaryCache.get(cacheKey);
  const candidates = [];
  if (process.env.RAILGUN_BIN) candidates.push(process.env.RAILGUN_BIN);
  candidates.push(path.join(root, '.railgun', 'bin', 'railgun.exe'));
  candidates.push(path.join(root, '.railgun', 'bin', 'railgun'));
  candidates.push(path.join(root, 'node_modules', '@viverra', 'railgun', 'bin', 'railgun.exe'));
  for (const pkg of [
    '@viverra/railgun-win32-x64', '@viverra/railgun-linux-x64',
    '@viverra/railgun-linux-arm64', '@viverra/railgun-darwin-arm64',
  ]) {
    candidates.push(path.join(root, 'node_modules', pkg, 'bin', 'railgun.exe'));
    candidates.push(path.join(root, 'node_modules', pkg, 'railgun.exe'));
  }
  candidates.push('C:\\bin\\railgun.exe');
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, 'railgun.exe'), path.join(dir, 'railgun'));
  }
  const found = candidates.find((candidate) => exists(candidate)) || null;
  binaryCache.set(cacheKey, found);
  return found;
}

/// `.bin` hard links, so `npx tsc` / `npx tsserver` / `npx eslint` / `npx oxlint` all reach
/// the native body. Copy fallback for volumes where a hard link is impossible.
function shimBin(root, binary) {
  const dir = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(dir, { recursive: true });
  const made = [];
  const source = fs.statSync(binary);
  for (const name of ['railgun.exe', 'tsc.exe', 'tsserver.exe', 'eslint.exe', 'oxlint.exe']) {
    const target = path.join(dir, name);
    if (exists(target) && fs.statSync(target).ino === source.ino) {
      made.push(name);
      continue;
    }
    fs.rmSync(target, { force: true });
    try {
      fs.linkSync(binary, target);
    } catch {
      fs.writeFileSync(target, read(binary));
    }
    made.push(name);
  }
  return made;
}

const PKG_DIR = path.resolve(__dirname, '..');

/// `file:` spec for the local launcher folder, so pnpm/npm resolve `@viverra/railgun`
/// without a registry lookup. Written straight into the root manifest.
function linkLocalPackage(root) {
  const spec = `file:${PKG_DIR.replace(/\\/g, '/')}`;
  const file = path.join(root, 'package.json');
  const patched = patchJson(file, [['devDependencies', '@viverra/railgun', spec]]);
  if (patched.changed) writeFileAtomic(file, patched.text);
  return spec;
}

function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  const fd = fs.openSync(tmp, 'r');
  try {
    if (fs.fstatSync(fd).size !== Buffer.byteLength(text)) throw new Error(`short write for ${tmp}`);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/// Parse a Railgun-owned JSON file; `null` when missing or malformed.
function parseJsonFile(file) {
  if (!exists(file)) return null;
  try {
    return JSON.parse(read(file));
  } catch {
    return null;
  }
}

function jsonIndent(text) {
  const match = text.match(/\{\r?\n(\s*)"/);
  return match ? match[1].length : 2;
}

// ------------------------------------------------------- minimal JSON patch

/// Index-based scanner: returns the end index (exclusive) of the JSON value at `start`.
function skipValue(text, start) {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  const open = text[i];
  if (open === '"' || open === "'") {
    i += 1;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === open) return i + 1;
      i += 1;
    }
    return i;
  }
  if (open === '[' || open === '{') {
    const stack = [open];
    i += 1;
    while (i < text.length && stack.length) {
      const c = text[i];
      if (c === '"' || c === "'") {
        i = skipValue(text, i);
        continue;
      }
      if (c === '[' || c === '{') stack.push(c);
      else if (c === ']' || c === '}') stack.pop();
      i += 1;
    }
    return i;
  }
  while (i < text.length && !',}]'.includes(text[i])) i += 1;
  return i;
}

/// Locate the `"name": <value>` pair inside `body`, as [keyStart, valueEnd] offsets.
function findPair(body, name) {
  const key = new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`);
  const match = key.exec(body);
  if (!match) return null;
  const valueStart = match.index + match[0].length;
  return { keyStart: match.index, valueEnd: skipValue(body, valueStart) };
}

function patchJson(file, ops) {
  const before = read(file);
  const indent = jsonIndent(before);
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  let text = before;
  const applied = [];

  const blockRange = (key) => {
    const start = text.search(new RegExp(`"${key}"\\s*:\\s*\\{`));
    if (start < 0) return null;
    const open = text.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) return { from: open, to: i };
      }
    }
    return null;
  };

  for (const [section, name, value] of ops) {
    const block = blockRange(section) ?? { from: text.indexOf('{'), to: text.lastIndexOf('}') };
    const body = text.slice(block.from + 1, block.to);
    const rendered = JSON.stringify(value);
    const pair = findPair(body, name);
    if (!pair) {
      const pad = ' '.repeat(indent * 2);
      const closing = ' '.repeat(indent);
      const trailing = body.replace(/\s*$/, '');
      const rebuilt = trailing.length === 0
        ? `${eol}${pad}"${name}": ${rendered}${eol}${closing}`
        : `${trailing},${eol}${pad}"${name}": ${rendered}${eol}${closing}`;
      text = text.slice(0, block.from + 1) + rebuilt + text.slice(block.to);
      applied.push(`+${section}.${name}`);
      continue;
    }
    const patched = `${body.slice(0, pair.keyStart)}"${name}": ${rendered}${body.slice(pair.valueEnd)}`;
    text = text.slice(0, block.from + 1) + patched + text.slice(block.to);
    applied.push(`~${section}.${name}`);
  }

  // The parse doubles as validation of the patched text.
  JSON.parse(text);
  return { text, applied, changed: text !== before };
}

// ------------------------------------------------------------ script model

function classifyLegacy(value) {
  const bare = String(value).trim().replace(/^(pnpm|npx|yarn|npm)\s+(exec\s+|run\s+)?/, '');
  if (/^tsc(\s|$)/.test(bare)) return 'typescript';
  if (/^(eslint|oxlint)(\s|$)/.test(bare)) return 'lint';
  if (/^next\s+lint(\s|$)/.test(bare)) return 'lint';
  return null;
}

const LEGACY_PREFIX = /^(pnpm|npx|yarn|npm)\s+(exec\s+|run\s+)?/;

/// Railgun replacement for any legacy invocation, owned key or not.
/// Emitting `tsc` and `--watch` stay as-is: only the noEmit pass is equivalent and the
/// native binary has no watch mode here. `next build` / `next dev` are framework gates.
function legacyReplacement(value) {
  const kind = classifyLegacy(value);
  if (!kind) return null;
  const bare = String(value).trim().replace(LEGACY_PREFIX, '');
  if (bare.includes('--watch')) return null;
  if (kind === 'lint') return bare.includes('--fix') ? 'railgun lint --fix' : 'railgun lint';
  if (!/--noEmit\b|--no-emit\b/i.test(bare)) return null;
  const project = bare.match(/(?:-p|--project)[= ](\S+)/);
  return project ? `railgun typecheck -p ${project[1]}` : 'railgun typecheck';
}

const PACKAGE_SCRIPTS = {
  check: 'railgun check',
  'check:changed': 'railgun check --changed',
  'check:agent': 'railgun check --agent',
  lint: 'railgun lint',
  typecheck: 'railgun typecheck',
};

const ROOT_SCRIPTS = {
  check: 'railgun workspace check',
  'check:changed': 'railgun workspace check --affected',
  'check:agent': 'railgun workspace check --affected --agent',
  lint: 'railgun workspace lint',
  typecheck: 'railgun workspace typecheck',
  typegen: 'railgun workspace typegen',
  'railgun:doctor': 'railgun doctor',
};

const isNextPackage = (json) => Object.prototype.hasOwnProperty.call(
  { ...(json.dependencies || {}), ...(json.devDependencies || {}) }, 'next',
);

/// App package: `next` dependency plus an App Router dir or a Next config file.
function isNextApp(json, dir) {
  if (!isNextPackage(json)) return false;
  return ['app', 'next.config.mjs', 'next.config.js', 'next.config.ts'].some((name) => exists(path.join(dir, name)));
}

const depValue = (json, name) =>
  (json.dependencies || {})[name] || (json.devDependencies || {})[name] || null;

function buildPlan(root) {
  const key = path.resolve(root);
  if (planCache.has(key)) return planCache.get(key);

  const wsFile = path.join(root, 'pnpm-workspace.yaml');
  const patterns = exists(wsFile) ? parseWorkspaces(wsFile, read(wsFile)) : [];
  const rootJson = parseJsonFile(path.join(root, 'package.json')) || {};
  const declared = Array.isArray(rootJson.workspaces) ? rootJson.workspaces : [];
  // The workspace root is itself a package (pnpm importer `.`), even when the
  // `packages:` globs list only its children.
  const dirs = [...new Set([
    ...expandPackages(root, patterns.length ? patterns : declared),
    key,
  ])].sort();

  const entries = dirs.map((dir) => {
    const file = path.join(dir, 'package.json');
    const json = parseJsonFile(file) || {};
    return {
      dir,
      file,
      json,
      isNext: isNextApp(json, dir),
      isRoot: dir === key,
    };
  });

  const ops = [];
  for (const entry of entries) {
    const table = entry.isRoot ? ROOT_SCRIPTS : PACKAGE_SCRIPTS;
    const sectionOps = Object.entries(table).map((pair) => ['scripts', pair[0], pair[1]]);
    if (entry.isNext) sectionOps.push(['scripts', 'typegen', 'next typegen']);
    ops.push({
      file: entry.file, sectionOps, isRoot: entry.isRoot, json: entry.json,
    });
  }

  const plan = {
    pm: detectPackageManager(root),
    hasTurbo: exists(path.join(root, 'turbo.json')),
    wsFile: exists(wsFile) ? wsFile : null,
    entries,
    ops,
    nextApps: entries.filter((entry) => entry.isNext),
  };
  planCache.set(key, plan);
  return plan;
}

/// Derived ops for one manifest: legacy copies for owned keys, plus in-place native
/// rewrites for every other legacy invocation (`build`, `dev`, `lint-v2`, `lint:check`, …)
/// so a rerun converges instead of stopping at the owned set.
function extrasFor(item) {
  const scripts = item.json.scripts || {};
  const extras = [];
  const inExtras = (key) => extras.some(([, target]) => target === key);
  const owned = (key) => item.sectionOps.some(([, target]) => target === key);
  const legacyKey = (key) => `railgun:legacy:${key}`;
  for (const [name, legacy] of Object.entries(scripts)) {
    if (!classifyLegacy(legacy) || name.startsWith('railgun:legacy:')) continue;
    if (owned(name) && !inExtras(legacyKey(name)) && !scripts[legacyKey(name)]) {
      extras.push(['scripts', legacyKey(name), legacy]);
    }
  }
  for (const [name, legacy] of Object.entries(scripts)) {
    if (name.startsWith('railgun:legacy:') || owned(name)) continue;
    const replacement = legacyReplacement(legacy);
    if (!replacement || inExtras(name)) continue;
    extras.push(['scripts', name, replacement]);
    if (!scripts[legacyKey(name)] && !inExtras(legacyKey(name))) {
      extras.push(['scripts', legacyKey(name), legacy]);
    }
  }
  return extras;
}

function opsFor(item) {
  return [...item.sectionOps, ...extrasFor(item)].map(([, key, value]) => ['scripts', key, value]);
}

function applyPlan(root, plan) {
  const changes = [];
  for (const item of plan.ops) {
    const scripts = item.json.scripts || {};
    const sectionOps = opsFor(item);
    const patched = patchJson(item.file, sectionOps);
    if (patched.changed) writeFileAtomic(item.file, patched.text);
    const stable = sectionOps.filter(([, key, value]) => scripts[key] === value).length;
    changes.push({
      file: item.file, applied: patched.applied, stable, wrote: patched.changed,
    });
  }
  return changes;
}

const TURBO_TASKS = {
  // `.next/types/**` is not replayed by the Turbo cache, so the generator stays uncached.
  typegen: { cache: false, outputs: ['.next/types/**', 'next-env.d.ts'] },
  check: { dependsOn: ['typegen'], outputs: [] },
  lint: { outputs: [] },
  typecheck: { dependsOn: ['typegen'], outputs: [] },
};

function patchTurbo(root) {
  const file = path.join(root, 'turbo.json');
  const before = read(file);
  const json = JSON.parse(before);
  const source = json.tasks || json.pipeline || {};
  const tasks = { ...source };
  const own = [];
  for (const [name, value] of Object.entries(TURBO_TASKS)) {
    const merged = { ...(tasks[name] || {}) };
    for (const [key, preset] of Object.entries(value)) {
      if (key === 'dependsOn') {
        merged.dependsOn = [...new Set([...(merged.dependsOn || []), ...preset])];
      } else if (merged[key] === undefined) {
        merged[key] = preset;
      }
    }
    tasks[name] = merged;
    own.push(name);
  }
  const updated = { ...json };
  if (json.tasks) updated.tasks = tasks;
  else if (json.pipeline) updated.pipeline = tasks;
  else updated.tasks = tasks;
  const text = `${JSON.stringify(updated, null, jsonIndent(before))}\n`;
  if (text !== before) writeFileAtomic(file, text);
  return own;
}

// ------------------------------------------------------------ agents + skill

const AGENT_BLOCK = [
  '<!-- railgun:start version=2 -->',
  'Railgun is the primary validation system (native binary, PGO, persistent daemon).',
  '',
  'Legacy command mapping:',
  '- `npx tsc` / `npx tsc --noEmit` -> `railgun check . --type-aware --type-check`',
  '- `npx tsc -p <tsconfig>` or `pnpm tsc` -> `railgun typecheck`',
  '- `npx eslint .` / `pnpm lint` / `next lint` / `npx oxlint` -> `railgun lint`',
  '- per-package loop -> `railgun workspace check --affected`',
  '',
  'Do not default to `npx tsc`, `pnpm tsc`, `tsc --noEmit`, `eslint`, `next lint`, or redundant standalone lint/typecheck invocations.',
  '',
  'Use:',
  '- `railgun check --changed --agent` during implementation',
  '- `railgun check --agent` when a package is complete',
  '- `railgun workspace check --affected --agent` for cross-package work',
  '- `railgun typegen` when Next route/generated type topology changed',
  '- `next build` only as the framework/build gate',
  '',
  'Modifiers: `--agent` compact output, `--changed` files touched since HEAD, `--summary-only` scoreboard alone,',
  '`--max-diagnostics N` bounded dump, `--json` / `--jsonl` machine formats, `--timings` per-stage breakdown,',
  '`--no-daemon` deterministic cold run.',
  '',
  'Baseline handling: with a captured baseline report `baseline errors`, `new errors`, `resolved`, `LoC delta`.',
  'The completion metric is newly introduced errors (`new errors = 0`), not total historical debt.',
  '<!-- railgun:end -->',
].join('\n');

function patchAgents(root) {
  const file = path.join(root, 'AGENTS.md');
  if (!exists(file)) {
    writeFileAtomic(file, `# ${path.basename(root)}\n\n${AGENT_BLOCK}\n`);
    return { file, action: 'created' };
  }
  const text = read(file);
  const start = text.indexOf('<!-- railgun:start');
  const end = text.indexOf('<!-- railgun:end -->');
  if (start >= 0 && end > start) {
    const next = `${text.slice(0, start)}${AGENT_BLOCK}${text.slice(end + '<!-- railgun:end -->'.length)}`;
    if (next !== text) writeFileAtomic(file, next);
    return { file, action: 'updated' };
  }
  writeFileAtomic(file, `${text.replace(/\s*$/, '')}\n\n${AGENT_BLOCK}\n`);
  return { file, action: 'appended' };
}

function skillFiles(root) {
  const canonical = path.join(root, '.agents', 'skills', 'railgun', 'SKILL.md');
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  writeFileAtomic(canonical, SKILL_BODY);
  const sha = hash(SKILL_BODY);
  const header = `<!--\nGenerated from .agents/skills/railgun/SKILL.md\nsource-sha256: ${sha}\n-->\n`;
  const copies = [];
  for (const dir of ['.claude', '.roo', '.kilo']) {
    const target = path.join(root, dir, 'skills', 'railgun', 'SKILL.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomic(target, `${header}${SKILL_BODY}`);
    copies.push(target);
  }
  const info = { sha, copies };
  skillCache.set(path.resolve(root), info);
  return info;
}

// --------------------------------------------------------------- native call

function readDaemonState(root) {
  const state = parseJsonFile(path.join(root, '.railgun', 'daemon.json'));
  if (!state) return null;
  const hasPipe = typeof state.pipe === 'string' && state.pipe.length > 0;
  const hasPort = Number.isInteger(state.port) && state.port > 0 && state.port <= 65535;
  if (!hasPipe && !hasPort) return null;
  return state;
}

/// Complete `<payload>\nEXIT <code>\n` frames only, so a half-received code cannot
/// resolve as success.
function readFrames(buffer) {
  const frames = [];
  let idx = 0;
  for (;;) {
    const at = buffer.indexOf('\nEXIT ', idx);
    if (at < 0) break;
    const end = buffer.indexOf('\n', at + 1);
    if (end < 0) break;
    frames.push({ body: buffer.slice(idx, at), code: Number(buffer.slice(at + 6, end)) });
    idx = end + 1;
  }
  return frames;
}

/// One request per connection (the server answers a single frame per accept).
/// Windows named pipes are the primary transport, loopback TCP the fallback.
function tcpRequest(endpoint, lines, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const socket = typeof endpoint === 'number' ? net.connect(endpoint, '127.0.0.1') : net.connect(endpoint);
    let buffer = '';
    let done = false;
    const finish = (forced = false) => {
      if (done) return;
      const [frame] = readFrames(buffer);
      if (!frame) {
        // On timeout a half-received frame is not enough; fall back to a cold run.
        if (!forced) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(null);
        return;
      }
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ body: frame.body, code: Number.isNaN(frame.code) ? 1 : frame.code });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      finish(false);
    });
    socket.on('error', () => finish(true));
    socket.on('close', () => finish(true));
    socket.on('connect', () => socket.write(`${lines.join('\n')}\n.\n`));
  });
}

/// Identity first, on its own connection, so a recycled endpoint cannot answer for this workspace.
async function daemonRequest(state, args, timeoutMs = 30000) {
  const endpoint = state.pipe || state.port;
  if (!endpoint) return null;
  const identity = await tcpRequest(endpoint, ['key'], 3000);
  if (!identity || String(identity.body).trim() !== String(state.key).trim()) return null;
  return tcpRequest(endpoint, args, timeoutMs);
}

const DAEMON_STATE = path.join('.railgun', 'daemon.json');
const daemonMisses = { count: 0 };

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/// `daemon start` is a blocking server loop, so it is spawned detached and the state file
/// is polled for a fresh identity instead of waiting on the (non-returning) start call.
async function startDaemon(root, binary) {
  const file = path.join(root, DAEMON_STATE);
  const before = exists(file) ? fs.statSync(file).mtimeMs : 0;
  const child = spawn(binary, ['daemon', 'start'], { cwd: root, detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 20; i += 1) {
    await sleep(150);
    if (exists(file) && fs.statSync(file).mtimeMs !== before) return readDaemonState(root);
  }
  return readDaemonState(root);
}

/// Daemon attempt, bounded. The pipe name embeds the identity hash, so a stale server
/// cannot answer on it. Two misses disable the daemon for this process: every later pass
/// goes straight to the cold path instead of burning another request timeout.
async function withDaemon(root, binary, args) {
  let state = readDaemonState(root);
  if (!state) state = await startDaemon(root, binary);
  if (!state) {
    daemonMisses.count += 1;
    return null;
  }
  let answer = await daemonRequest(state, args);
  if (!answer && daemonMisses.count < 2) {
    daemonMisses.count += 1;
    state = await startDaemon(root, binary);
    if (state) answer = await daemonRequest(state, args);
  }
  if (!answer) {
    daemonMisses.count += 1;
    return null;
  }
  return { ...answer, cache: 'daemon/hot' };
}

/// One native execution, daemon-first. `cache` reports which path actually answered.
async function nativeRun(root, args) {
  const binary = resolveBinary(root);
  if (!binary) return { code: 1, body: 'RAILGUN: BLOCKED no native railgun binary', cache: 'cold' };
  if (!args.includes('--no-daemon') && daemonMisses.count < 2) {
    const hot = await withDaemon(root, binary, args);
    if (hot) return hot;
  }
  const res = spawnSync(binary, [...args, ...(daemonMisses.count >= 2 && !args.includes('--no-daemon') ? ['--no-daemon'] : [])], { cwd: root, encoding: 'utf8' });
  const body = `${res.stdout || ''}${res.stderr || ''}`;
  return { code: res.status === null ? 1 : res.status, body, cache: 'cold' };
}

function forwardArgs(args) {
  const out = args.slice();
  const timings = out.indexOf('--timings');
  if (timings >= 0) out.splice(timings, 1, '--debug', 'timings');
  const trace = out.indexOf('--trace');
  if (trace >= 0) out.splice(trace, 1, '--debug', 'timings');
  if (out.includes('--jsonl')) out.splice(out.indexOf('--jsonl'), 1, '-f', 'json');
  return out;
}

// ---------------------------------------------------------- git + baselines

function gitLines(root, args) {
  const key = `${path.resolve(root)}|${args.join(' ')}`;
  if (gitCache.has(key)) return gitCache.get(key);
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const lines = res.status === 0 ? res.stdout.split(/\r?\n/).filter(Boolean) : [];
  gitCache.set(key, lines);
  return lines;
}

/// Changed paths, computed once per process.
function changedFiles(root) {
  const key = `changed|${path.resolve(root)}`;
  if (gitCache.has(key)) return gitCache.get(key);
  const list = [...new Set([
    ...gitLines(root, ['diff', '--name-only', 'HEAD']),
    ...gitLines(root, ['ls-files', '--others', '--exclude-standard']),
  ])];
  gitCache.set(key, list);
  return list;
}

function affectedPackages(root, dirs) {
  const changed = changedFiles(root);
  const affected = new Set();
  for (const rel of changed) {
    for (const dir of dirs) {
      const relative = path.relative(root, dir).replace(/\\/g, '/');
      const prefix = relative === '' ? '' : `${relative}/`;
      // Root-level files map to `.` (the whole workspace), nested dirs to their own path.
      if (prefix === '' ? !rel.includes('/') : rel.startsWith(prefix)) {
        affected.add(prefix || '.');
      }
    }
  }
  return [...affected].sort();
}

function fingerprint(body) {
  const items = [];
  for (const line of body.split('\n')) {
    const head = line.match(/^(.*?):(\d+):(\d+):\s+(error|warning|advice)\b:?\s*(.*)$/);
    if (!head) continue;
    const [, file, lineNo, column, severity, rest] = head;
    const parts = rest.match(/^([^:]+):\s*([\s\S]*)$/);
    const code = parts ? parts[1] : '';
    const message = parts ? parts[2] : rest;
    items.push({
      id: `${code}|${file}|${message}`,
      severity,
      file,
      line: Number(lineNo),
      column: Number(column),
    });
  }
  return items;
}

const baselinePath = (root) => path.join(root, '.railgun', 'baseline.json');

function captureBaseline(root, body) {
  fs.mkdirSync(path.join(root, '.railgun'), { recursive: true });
  const items = fingerprint(body);
  const codes = {};
  for (const item of items) codes[item.id.split('|')[0]] = (codes[item.id.split('|')[0]] || 0) + 1;
  const file = baselinePath(root);
  const previous = parseJsonFile(file);
  const state = {
    schema: 1,
    captured: new Date().toISOString(),
    diagnostics: items.map((item) => item.id),
    codes,
    hash: hash(items.map((i) => i.id).join('\n')),
    previousHash: previous && Array.isArray(previous.diagnostics) ? previous.hash : null,
  };
  writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function compareBaseline(root, body) {
  const file = baselinePath(root);
  if (!exists(file)) return null;
  const state = JSON.parse(read(file));
  const baseline = new Set(state.diagnostics);
  const now = fingerprint(body);
  const current = new Set(now.map((i) => i.id));
  let newErrors = 0;
  let preExisting = 0;
  for (const item of now) {
    if (baseline.has(item.id)) preExisting += 1;
    else if (item.severity === 'error') newErrors += 1;
  }
  const moved = [...baseline].filter((id) => !current.has(id)).length;
  return {
    baseline: state.diagnostics.length,
    newErrors,
    preExisting,
    resolved: moved,
    hash: hash(now.map((i) => i.id).join('\n')),
    changed: state.hash !== hash(now.map((i) => i.id).join('\n')),
  };
}

/// Reads one counter from the native scoreboard line (singular or plural form).
const metric = (body, name) => {
  const line = body.split('\n').find((l) => l.includes('|') && l.includes('LoC')) || '';
  const stem = name.replace(/s$/, '');
  return Number((line.match(new RegExp(`(\\d+) ${stem}s?\\b`)) || [])[1] || 0);
};

// ------------------------------------------------------------------ commands

const passHead = (run) => (run.body || '').split('\n').map((l) => l.trim())
  .filter(Boolean).slice(0, 2).join(' / ') || '-';

/// First pass whose agent body carries a real scoreboard line; a dead Go backend answers
/// with a bare `Error running tsgolint:` line and must not become the baseline source.
const pickBody = (runs) => runs.map((run) => run.body || '')
  .find((text) => /\|\s*\d+\s+LoC\b/.test(text)) || '';

function reportReady(root, plan, native, numbers) {
  process.stdout.write(`${[
    'RAILGUN: READY',
    '',
    'workspace:',
    `  root: ${root}`,
    `  root markers: ${rootHint(root)}`,
    `  package manager: ${plan.pm}`,
    `  monorepo: ${plan.wsFile ? 'pnpm-workspace' : 'single-package'}`,
    `  turbo: ${plan.hasTurbo ? 'yes' : 'no'}`,
    `  packages: ${plan.entries.length}`,
    `  TypeScript projects: ${plan.entries.filter((e) => exists(path.join(e.dir, 'tsconfig.json'))).length}`,
    `  Next.js apps: ${plan.nextApps.length}`,
    '',
    'runtime:',
    `  native binary: ${native}`,
    '  TS backend: tsgolint (Go, GOAMD64=v3, Go PGO)',
    '  daemon: loopback TCP, persistent LintRunner',
    '  PGO: LLVM PGO + Go PGO',
    `  cache: ${numbers.cache}${daemonMisses.count ? ` (daemon misses: ${daemonMisses.count})` : ''}`,
    '',
    'migration:',
    `  package.json patched: ${numbers.patched}`,
    `  scripts added: ${numbers.added}`,
    `  scripts replaced: ${numbers.replaced}`,
    `  scripts already native: ${numbers.stable}`,
    `  workspace dep: ${numbers.dep}`,
    `  .bin shims: ${numbers.shims.join(', ') || 'n/a'}`,
    `  Turbo tasks: ${numbers.turbo.join(', ') || 'n/a'}`,
    `  Next typegen apps: ${plan.nextApps.map((e) => path.relative(root, e.dir).replace(/\\/g, '/') || '.').join(', ') || 'n/a'}`,
    `  AGENTS.md: ${numbers.agents}`,
    `  skills synchronized: ${numbers.skills}`,
    '    - .agents/skills/railgun/SKILL.md',
    '    - .claude/skills/railgun/SKILL.md',
    '    - .roo/skills/railgun/SKILL.md',
    '    - .kilo/skills/railgun/SKILL.md',
    '',
    'baseline:',
    `  errors: ${numbers.errors}`,
    `  warnings: ${numbers.warnings}`,
    `  LoC: ${numbers.loc}`,
    `  fingerprints: ${numbers.baseline}`,
    '',
    'performance:',
    `  cold: ${numbers.cold} ms`,
    `  warm: ${numbers.warm} ms`,
    `  no-change: ${numbers.noChange} ms`,
    `  affected: ${numbers.affected} ms`,
    '',
    'pass heads:',
    ...numbers.heads.map((line) => `  ${line}`),
    '',
    'command:',
    '  railgun check --changed --agent',
  ].join('\n')}\n`);
}

async function cmdInit(root, argv) {
  const native = resolveBinary(root);
  if (!native) {
    process.stdout.write('RAILGUN: BLOCKED\nno native railgun binary (set RAILGUN_BIN or .railgun/bin/railgun.exe)\n');
    return 1;
  }

  const plan = buildPlan(root);
  const targets = [
    ...plan.ops.map((op) => op.file),
    ...(plan.hasTurbo ? [path.join(root, 'turbo.json')] : []),
    ...(exists(path.join(root, 'AGENTS.md')) ? [path.join(root, 'AGENTS.md')] : []),
  ];

  // Stage 1: read and parse everything before the first write.
  const snapshots = new Map();
  for (const file of targets) snapshots.set(file, read(file));
  // Stage 1 validation applies the full patch over the snapshot text, without writing.
  for (const op of plan.ops) {
    try {
      patchJson(op.file, opsFor(op));
    } catch (error) {
      process.stdout.write(`RAILGUN: BLOCKED\npreflight failed for ${op.file}: ${error.message}\n`);
      return 1;
    }
  }

  if (argv.includes('--dry-run') || argv.includes('--diff')) {
    const lines = [];
    for (const [file, text] of snapshots) {
      lines.push(`--- ${path.relative(root, file).replace(/\\/g, '/')}`);
      for (const line of text.split('\n')) lines.push(`  ${line}`);
    }
    if (argv.includes('--diff')) {
      const applied = applyPlan(root, plan);
      for (const item of applied) lines.push(`### ${path.relative(root, item.file)} -> ${item.applied.join(' ')}`);
      if (plan.hasTurbo) lines.push(`### turbo.json -> ${patchTurbo(root).join(' ')}`);
      for (const [file, text] of snapshots) {
        if (!exists(file)) continue;
        const now = read(file);
        if (now !== text) {
          lines.push(`### ${path.relative(root, file)} (${text.length} -> ${now.length} bytes)`);
          writeFileAtomic(file, text);
        }
      }
    } else {
      lines.push(`plan: ${plan.ops.length} manifests, ${plan.hasTurbo ? 1 : 0} turbo, 1 AGENTS.md`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }

  // Stage 2: mutate.
  const applied = applyPlan(root, plan);
  const turboTasks = plan.hasTurbo ? patchTurbo(root) : [];
  if (plan.wsFile && !/^packages:/m.test(read(plan.wsFile))) {
    // Concrete directories from the existing globs; a `/*` suffix would match children.
    const body = plan.entries.filter((e) => !e.isRoot)
      .map((e) => `  - ${path.relative(root, e.dir).replace(/\\/g, '/')}`).join('\n');
    writeFileAtomic(plan.wsFile, `packages:\n${body}\n`);
  }
  const agents = patchAgents(root);
  const skill = skillFiles(root);

  // Root dependency only; nested packages resolve the workspace binary normally.
  // The registry holds no `@viverra/*` tarball yet, so it resolves as a folder link.
  const rootJson = (plan.ops.find((op) => op.isRoot) || { json: {} }).json;
  const hasDep = ['dependencies', 'devDependencies']
    .some((section) => Object.prototype.hasOwnProperty.call(rootJson[section] || {}, '@viverra/railgun'));
  const local = linkLocalPackage(root);
  let dep = hasDep ? 'present' : 'linked';
  let shims = [];
  if (!hasDep) {
    const pm = detectPackageManager(root);
    const runner = pm === 'yarn' ? 'yarn' : pm === 'bun' ? 'bun' : pm === 'npm' ? 'npm' : 'pnpm';
    const flags = runner === 'pnpm'
      ? ['install', '--prefer-offline', '--ignore-scripts', '--no-optional']
      : ['install', '--prefer-offline', '--ignore-scripts', '--omit=optional'];
    spawnSync(runner, flags, { cwd: root, stdio: 'inherit' });
    dep = `linked ${local}`;
  }
  const binary = resolveBinary(root);
  if (binary) shims = shimBin(root, binary);

  const checkArgs = ['.', '--type-aware', '--type-check', '--quiet', '-f', 'agent'];
  const affected = affectedPackages(root, plan.entries.map((e) => e.dir));
  const affectedScope = affected.length ? affected : ['.'];
  const timed = async (args) => {
    const start = Date.now();
    const run = await nativeRun(root, args);
    return { run, ms: Date.now() - start };
  };

  // Four bounded passes: cold (no daemon), warm (daemon, persistent LintRunner), then two
  // `--summary-only` replays so the report keeps its shape without repeating full renders.
  const cold = await timed([...checkArgs, '--no-daemon']);
  const starter = resolveBinary(root);
  if (starter) await startDaemon(root, starter);
  const warm = await timed(checkArgs);
  const noChange = await timed([...checkArgs, '--summary-only']);
  const affectedRun = await timed([...affectedScope, ...checkArgs.slice(1), '--summary-only']);

  // Baselines need rendered diagnostics, so the full-render pass is the source of truth;
  // the `--summary-only` passes contribute timings only.
  const body = pickBody([warm.run, cold.run, noChange.run, affectedRun.run]);
  process.stdout.write(`${body.trimEnd()}\n`);
  const baseline = captureBaseline(root, body);
  const numbers = {
    patched: applied.filter((item) => item.wrote).length,
    added: applied.reduce((n, item) => n + item.applied.filter((a) => a.startsWith('+')).length, 0),
    replaced: applied.reduce((n, item) => n + item.applied.filter((a) => a.startsWith('~')).length, 0),
    stable: applied.reduce((n, item) => n + item.stable, 0),
    dep,
    shims,
    turbo: turboTasks,
    agents: agents.action,
    skills: 1 + skill.copies.length,
    errors: metric(body, 'errors'),
    warnings: metric(body, 'warnings'),
    loc: metric(body, 'LoC'),
    baseline: baseline.diagnostics.length,
    cold: cold.ms,
    warm: warm.ms,
    noChange: noChange.ms,
    affected: affectedRun.ms,
    cache: noChange.run.cache || 'cold',
    heads: [
      `cold: ${passHead(cold.run)}`,
      `warm: ${passHead(warm.run)}`,
      `no-change: ${passHead(noChange.run)}`,
      `affected: ${passHead(affectedRun.run)}`,
    ],
  };
  reportReady(root, plan, native, numbers);

  const managed = [...snapshots.keys()].map((file) => ({
    path: path.relative(root, file).replace(/\\/g, '/'),
    before: hash(snapshots.get(file)),
    after: exists(file) ? hash(read(file)) : null,
  }));
  const manifest = {
    schema: 1,
    railgun: '2.0.0',
    // Volatile by design: `managedHash` is the idempotency anchor for these files.
    timestamp: new Date().toISOString(),
    skillHash: skill.sha,
    managedHash: hash(managed.map((m) => `${m.path}:${m.after}`).join('\n')),
    managed,
    previous: Object.fromEntries(snapshots),
  };
  fs.mkdirSync(path.join(root, '.railgun'), { recursive: true });
  writeFileAtomic(path.join(root, '.railgun', 'migration.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return 0;
}

function cmdRollback(root) {
  const file = path.join(root, '.railgun', 'migration.json');
  const manifest = parseJsonFile(file);
  if (!manifest || !Array.isArray(manifest.managed) || !manifest.previous) {
    process.stdout.write(`RAILGUN: BLOCKED missing or malformed ${file}\n`);
    return 1;
  }
  const previous = manifest.previous;
  let restored = 0;
  let kept = 0;
  for (const owned of manifest.managed) {
    if (!owned || typeof owned.path !== 'string') continue;
    const target = path.resolve(path.join(path.resolve(root), owned.path));
    // Only files inside the discovered workspace are owned by the migration.
    if (!target.startsWith(path.resolve(root))) continue;
    const key = Object.keys(previous)
      .find((candidate) => path.resolve(candidate.replace(/\\/g, '/')) === target);
    if (key === undefined || !Object.prototype.hasOwnProperty.call(previous, key)) continue;
    const original = previous[key];
    if (exists(target) && hash(read(target)) !== owned.after) {
      kept += 1;
      continue;
    }
    writeFileAtomic(target, original);
    restored += 1;
  }
  process.stdout.write(`RAILGUN: ROLLED BACK ${restored} files, kept ${kept} edited by hand\n`);
  return 0;
}

/// Flag support is derived from the native version, to avoid a second probe process.
function supportedFlags(version) {
  const match = /(\d+)\.(\d+)/.exec(version);
  if (!match) return 'unknown';
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 1 || (major === 1 && minor >= 82)
    ? 'max-diagnostics, summary-only, changed, no-daemon'
    : 'legacy';
}

function cmdDoctor(root) {
  const native = resolveBinary(root);
  const plan = buildPlan(root);
  const version = native ? (spawnSync(native, ['--version'], { encoding: 'utf8' }).stdout || '').trim() : 'missing';
  const state = readDaemonState(root);
  const ts = plan.entries.map((e) => depValue(e.json, 'typescript')).filter(Boolean);
  const nexts = plan.nextApps.map((e) => depValue(e.json, 'next') || '?');
  process.stdout.write(`${[
    'RAILGUN',
    `binary: ${native || 'missing'}`,
    `version: ${version}`,
    'cpu target: native',
    `daemon: ${state ? `pid ${state.pid} port ${state.port} key ${String(state.key).slice(0, 8)}` : 'cold'}`,
    'ipc: loopback tcp',
    'pgo: enabled',
    'allocator: mimalloc',
    `flags: ${supportedFlags(version)}`,
    '',
    'TYPESCRIPT',
    'backend: tsgolint (Go, TS7)',
    `typescript: ${[...new Set(ts)].join(', ') || 'n/a'}`,
    `tsconfig count: ${plan.entries.filter((e) => exists(path.join(e.dir, 'tsconfig.json'))).length}`,
    '',
    'NEXT',
    `versions: ${[...new Set(nexts)].join(', ') || 'n/a'}`,
    'typegen: next typegen (authoritative route types)',
    `build gate: next build (Turbopack)`,
    '',
    'WORKSPACE',
    `package manager: ${plan.pm}`,
    `workspace root: ${root}`,
    `package count: ${plan.entries.length}`,
    '',
    'TURBO',
    `present: ${plan.hasTurbo ? 'yes' : 'no'}`,
    'affected: supported',
    'cache: local; remote is conservative',
    '',
    'AGENTS',
    `AGENTS.md: ${exists(path.join(root, 'AGENTS.md')) ? 'present' : 'missing'}`,
    ...['.agents', '.claude', '.roo', '.kilo'].map((dir) => {
      const f = path.join(root, dir, 'skills', 'railgun', 'SKILL.md');
      return `${dir} skill: ${exists(f) ? `sha ${hash(read(f)).slice(0, 12)}` : 'missing'}`;
    }),
  ].join('\n')}\n`);
  if (!native) {
    process.stdout.write('RAILGUN: BLOCKED\nno native railgun binary\n');
    return 1;
  }
  process.stdout.write('RAILGUN: READY\n');
  return 0;
}

async function cmdStatus(root, args) {
  if (!resolveBinary(root)) {
    process.stdout.write('RAILGUN: BLOCKED no native railgun binary\n');
    return 1;
  }
  const plan = buildPlan(root);
  const affected = plan.wsFile ? affectedPackages(root, plan.entries.map((e) => e.dir)) : [];
  const scope = affected.length ? affected : ['.'];
  const start = Date.now();
  const run = await nativeRun(root, [...scope, '--type-aware', '--type-check', '--quiet', '--summary-only', '-f', 'agent', ...args]);
  const elapsed = Date.now() - start;
  const baseline = parseJsonFile(baselinePath(root));
  const cmp = compareBaseline(root, run.body);
  process.stdout.write(`${[
    'RAILGUN READY',
    `root: ${root} (${rootHint(root)})`,
    `daemon: ${run.cache}`,
    `workspace: ${plan.hasTurbo ? 'pnpm + turbo' : plan.wsFile ? 'pnpm' : 'single'}`,
    `packages: ${plan.entries.length}`,
    `next apps: ${plan.nextApps.length}`,
    `ts projects: ${plan.entries.filter((e) => exists(path.join(e.dir, 'tsconfig.json'))).length}`,
    `baseline: ${baseline && Array.isArray(baseline.diagnostics) ? `${baseline.diagnostics.length} diagnostics` : 'none'}`,
    `changed: ${changedFiles(root).length} files`,
    `affected packages: ${affected.length}`,
    `run: ${elapsed} ms (${run.body.split('\n')[0] || '-'})`,
  ].join('\n')}\n${run.body}`);
  if (cmp) {
    process.stdout.write(`new errors: ${cmp.newErrors}\npre-existing: ${cmp.preExisting}\nresolved: ${cmp.resolved}\n`);
  }
  return run.code;
}

async function cmdWorkspace(root, task, args) {
  const plan = buildPlan(root);
  const dirs = plan.entries.map((e) => e.dir);
  const affectedOnly = args.includes('--affected');
  if (task === 'typegen') {
    for (const entry of plan.nextApps) {
      const rel = path.relative(root, entry.dir).replace(/\\/g, '/') || '.';
      const res = spawnSync('npx', ['--no-install', 'next', 'typegen', rel], { cwd: root, stdio: 'inherit' });
      if (res.status !== 0) return res.status ?? 1;
    }
    return 0;
  }
  if (plan.hasTurbo && affectedOnly && exists(path.join(root, 'node_modules', '.bin'))) {
    const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'turbo.cmd' : 'turbo');
    const runner = exists(bin) ? bin : 'npx';
    const pre = exists(bin) ? [] : ['--no-install', 'turbo'];
    const res = spawnSync(runner, [...pre, 'run', task, '--affected', ...args.filter((a) => a !== '--affected')], { cwd: root, stdio: 'inherit' });
    return res.status ?? 1;
  }
  const affected = affectedOnly ? affectedPackages(root, dirs) : [];
  const scope = affectedOnly ? (affected.length ? affected : ['.']) : (dirs.length ? dirs : ['.']);
  const flags = task === 'lint'
    ? ['--quiet']
    : ['--type-aware', '--type-check', '--quiet'];
  // `--no-daemon` is forwarded so the native process sees the same modifiers the caller used.
  const extra = args.filter((a) => a !== '--affected');
  const run = await nativeRun(root, [...scope, ...flags, ...extra]);
  process.stdout.write(run.body);
  return run.code;
}

async function cmdCheck(root, args) {
  if (!resolveBinary(root)) {
    process.stdout.write('RAILGUN: BLOCKED no native railgun binary\n');
    return 1;
  }
  const run = await nativeRun(root, forwardArgs(args));
  process.stdout.write(run.body);
  if (metric(run.body, 'files') === 0) {
    process.stdout.write(`RAILGUN: EMPTY cwd: ${path.resolve(process.cwd())} root: ${root} markers: ${rootHint(root)}\n`);
  }
  const cmp = compareBaseline(root, run.body);
  if (cmp) {
    process.stdout.write(`new errors: ${cmp.newErrors}\npre-existing: ${cmp.preExisting}\nresolved: ${cmp.resolved}\n`);
  }
  return run.code;
}

function cmdBaseline(root, args) {
  const native = resolveBinary(root);
  if (!native) {
    process.stdout.write('RAILGUN: BLOCKED no native railgun binary\n');
    return 1;
  }
  const scope = args.length ? args : ['.'];
  const res = spawnSync(native, [...scope, '--type-aware', '--type-check', '--quiet', '-f', 'agent'], { cwd: root, encoding: 'utf8' });
  const body = res.stdout || '';
  const state = captureBaseline(root, body);
  process.stdout.write(`baseline captured: ${state.diagnostics.length} diagnostics (sha ${state.hash.slice(0, 12)})\n`);
  return res.status === null ? 1 : res.status;
}

// --------------------------------------------------------------------- main

const OPTION_WITH_VALUE = new Set([
  '-f', '--format', '-c', '--config', '--max-diagnostics', '--max-warnings',
  '--threads', '-p', '--project', '--debug',
]);

/// Index of the command word, skipping option tokens and their separated values.
function commandIndex(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) return i;
    if (OPTION_WITH_VALUE.has(token)) i += 1;
  }
  return -1;
}

async function main() {
  const argv = process.argv.slice(2);
  const at = commandIndex(argv);
  const binName = path.basename(process.argv[1] || '');
  const command = at >= 0 ? argv[at] : (binName === 'railgunize' ? 'init' : 'help');
  const args = at >= 0 ? [...argv.slice(0, at), ...argv.slice(at + 1)] : argv;
  const root = findRoot(process.cwd());

  switch (command) {
    case 'init': return cmdInit(root, args);
    case 'rollback': return cmdRollback(root);
    case 'doctor': return cmdDoctor(root);
    case 'status': return cmdStatus(root, args);
    case 'baseline': return cmdBaseline(root, args);
    case 'workspace': return cmdWorkspace(root, args[0] || 'check', args.slice(1));
    case 'typegen': return cmdWorkspace(root, 'typegen', args);
    case 'ci': {
      const code = await cmdWorkspace(root, 'check', ['--affected', '-f', 'agent', '--no-daemon', ...args]);
      if (code !== 0 || !args.includes('--build')) return code;
      for (const entry of buildPlan(root).nextApps) {
        const res = spawnSync('npx', ['--no-install', 'next', 'build'], { cwd: entry.dir, stdio: 'inherit' });
        if (res.status !== 0) return res.status ?? 1;
      }
      return 0;
    }
    case 'daemon': {
      const native = resolveBinary(root);
      if (!native) {
        process.stdout.write('RAILGUN: BLOCKED no native railgun binary\n');
        return 1;
      }
      return spawnSync(native, [command, ...args], { cwd: root, stdio: 'inherit' }).status ?? 0;
    }
    case 'help': {
      const native = resolveBinary(root);
      return spawnSync(native || 'oxlint', ['--help'], { stdio: 'inherit' }).status ?? 0;
    }
    case 'lint': return cmdCheck(root, args.length ? args : ['.', '--quiet']);
    case 'typecheck': return cmdCheck(root, args.length ? args : ['.', '--type-aware', '--type-check']);
    case 'check': return cmdCheck(root, args.length ? args : ['.']);
    default: return cmdCheck(root, at >= 0 ? [command, ...args] : ['.']);
  }
}

main().then((code) => process.exit(code ?? 0));

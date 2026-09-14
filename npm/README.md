# Railgun — state-of-the-art native TypeScript validation

**The fastest TypeScript toolchain that exists. Period.** One process. One traversal. No spray.

Go-native TypeScript 7 tsc (**8–12x** vs TS6) + tsgolint (**20–40x** vs ESLint + typescript-eslint). Full type-aware lint + typecheck of a **776-file workspace in ~6 seconds** — while you are still reading this line.

## Q3A scoreboard — what green looks like

```text
PERFECT      0 errors | 1 files | 28 LoC        | 2ms | cache: hot
HEADSHOT     1 errors | 42 files | 2100 LoC     | 18ms | cache: hot
IMPRESSIVE   3 errors | 39 files | 11300 LoC    | 47ms | cache: hot
EXCELLENT   20 errors | 66 files | 29599 LoC    | 127ms | cache: hot
```

`0 errors` = PERFECT. `1 error` = HEADSHOT. `20 errors` < 300 ms = EXCELLENT. The instrument panel is the weapon: score line, LoC, milliseconds, cache state — one block, machine-parsable with `--agent`.

## What ships in this package

| file | role |
| --- | --- |
| `bin/railgun.js` | Node launcher + `railgunize` workspace migrator |
| `bin/railgun.exe` | canonical body: PGO'd Oxlint, Q3-flavored output |
| `bin/railgun-pgo.exe` | PGO-tuned hot loop |
| `bin/railgun-lld.exe` | lld-linked twin |
| `bin/railgun-native.exe` | target-cpu=native build |
| `bin/railgun-ts.exe` | Go-native TS7 tsc backend for tsgolint |
| `skills/SKILL.md` | the validation ladder for AI agents |

## Why it wins

- **One traversal replaces the whole ladder**: `npx tsc`, `eslint`, `oxlint`, `next lint`, per-package loops → one `railgun` command, type-aware included.
- **Persistent named-pipe daemon** (`\\.\pipe\railgun-<id>`): the Go TS program, project index and dirty set stay warm; 300 s idle, cold fallback so the hot loop never pays two timeouts.
- **Migration in one shot**: `npx @cyberluke/railgun init` patches 48 manifests of a pnpm+Turbo+Next workspace, merges `typegen/check/lint/typecheck` into `turbo.json`, appends the managed `AGENTS.md` block, drops a customized `SKILL.md` into `.claude`/`.roo`/`.kilo`, stores baseline + LoC fingerprints in `.railgun/`. Idempotent: second `init` changes nothing but timestamps.
- **Baseline-aware**: `railgun baseline capture` + `status` separate *your* new errors from inherited debt — agents ship on `new errors: 0`.
- **LoC as a first-class metric**: ±added/removed per run, staged/unstaged/untracked split. No mystery budgets.

## The map

| instead of | use |
| --- | --- |
| `npx tsc --noEmit` | `railgun check . --type-aware --type-check` |
| `npx tsc -p …` / `pnpm tsc` | `railgun typecheck` |
| `npx eslint .` / `pnpm lint` / `next lint` | `railgun lint` |
| `npx oxlint` | `railgun lint` |
| per-package check loops | `railgun workspace check --affected` |

Modifiers: `-p|--project`, `--noEmit`, `--pretty`, `--max-diagnostics`, `--summary-only`, `--changed`, `--no-daemon`. Machine formats: `--agent`, `--json`, `--jsonl`, `--timings`.

Hierarchy: `next typegen` route types > Railgun native checks > `next build` final gate. Native TS7 `tsc` remains the merge gate; the daemon belongs to the agent hot loop.

**Reference run:** `59 errors | 120 warnings | 776 files | 212572 LoC | 6125ms` — cold, type-aware, `--no-daemon`. Every number on the panel is real.

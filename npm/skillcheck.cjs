/* Visible check: SKILL_BODY embedded in bin/railgun.js vs shipped skills/SKILL.md. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname);
console.log('[skillcheck] start');
const src = fs.readFileSync(path.join(dir, 'bin', 'railgun.js'), 'utf8');
const m = src.match(/const SKILL_BODY = `([\s\S]*?)`;/);
if (!m) {
  console.log('[skillcheck] FAIL: SKILL_BODY not found');
  process.exit(1);
}
const disk = fs.readFileSync(path.join(dir, 'skills', 'SKILL.md'), 'utf8');
const norm = (s) => s.replace(/\r\n/g, '\n').trimEnd().split('\n');
const A = norm(m[1]);
const B = norm(disk);
console.log(`[skillcheck] body-lines=${A.length} disk-lines=${B.length}`);
let diffs = 0;
for (let i = 0; i < Math.max(A.length, B.length); i += 1) {
  if (A[i] === B[i]) continue;
  diffs += 1;
  console.log(`[skillcheck] line ${i + 1}\n  body: ${A[i] ?? '-'}\n  disk: ${B[i] ?? '-'}`);
}
console.log(`[skillcheck] complete diffs=${diffs}`);

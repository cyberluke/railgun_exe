# Railgun v2 — native validation runtime + workspace migrator

All numbers below are measured on this box: Intel Core Ultra 7 356H (no avx512 → Go v3),
rustc 1.98.1 (LLVM 22.1.8), MSVC link.exe 14.44.35207, Go 1.27.0, node v24.19.0.

## 1. Artifacts (all executed)

| Path | Bytes | Role |
| --- | --- | --- |
| `C:\bin\railgun.exe` | 14,448,128 | selected: PGO build, `--version` → `Version: 1.82.0` |
| `C:\bin\railgun-pgo.exe` | 14,448,128 | LLVM PGO + `-C target-cpu=native` |
| `C:\bin\railgun-native.exe` | 14,164,992 | no PGO |
| `C:\bin\railgun-lld.exe` | 14,160,384 | `rust-lld` COFF flavor |
| `C:\bin\railgun-ts.exe` | 22,675,968 | tsgolint (TS7), `GOAMD64=v3` + Go PGO |

Sizes are per revision (the four `.bin` hard links share the `railgun.exe` record, so they carry the same
size). Re-create those links after each `C:\bin` rebuild: `Copy-Item -Force` swaps the file record, and the
daemon (or a leftover `railgun` PID) holds the mapped image — stop it inside the same command, then copy.

Source pins: `C:\git\oxc` @ `1aa5ec1` (+ local `apps/oxlint`/`crates/oxc_linter` work, 38 modified tracked
files: 6 code, 20 snapshots, fixtures/`Cargo.lock`), tsgolint `C:\git\tsgolint` @ `f78270d` (6 tracked
modifications) with 5 patches applied to `typescript-go` @ `da8549f8c` (upstream `2bd066d87`).

## 2. Flags and profile

- Rust: `-C target-cpu=native` (avx, avx2, bmi1/2, fma, lzcnt, gfni, vaes, vpclmulqdq, popcnt),
  `-Cprofile-use=C:\git\oxc\pgo-profile\merged.profdata` (12,516,896 bytes; siblings
  `pgo-profile2` 12,522,552 and `pgo2026` 12,569,840 stay as cross-checks), OXC release profile
  (`opt-level=3`, `lto="fat"`, `codegen-units=1`, `panic="abort"`, `strip`), mimalloc via `--features allocator`.
- Go: `GOAMD64=v3`, `-trimpath -ldflags="-s -w"`, PGO from `cmd/tsgolint/default.pgo`.
- Native flags in this build: `--max-diagnostics N` (default 20, `suppressed:` roll-up),
  `--summary-only`, `--changed` (git-scoped), `--no-daemon`, `--agent` (alias of `-f agent`),
  `--json` / `--jsonl`, `--timings` → `--debug timings`.
- `tsc`-shaped flags (this pass): `-p` / `--project <tsconfig|dir>` — also becomes the walk scope when no PATH
  follows (`-p apps/web/tsconfig.json` → `scope: apps/web`, `-p packages/feature-chat` → `packages/feature-chat`);
  `--noEmit` / `--no-emit` accepted as no-ops; `--pretty` = `--format default`.
- Type-aware backend lookup (`crates/oxc_linter/src/tsgolint.rs`), first hit wins, every result made absolute:
  `OXLINT_TSGOLINT_PATH` (file or dir) → `node_modules/.bin` walking up → next to the running binary →
  project root (`cwd`) → `PATH`. The three extra steps are why type-aware checks work with no env at all.
- Scoreboard line: `errors | warnings | files | LoC | +added/-removed LoC | ms`, then `scope:`,
  `cache:` (`cold` / `daemon/hot`), optional `suppressed:`, then `TOP FRAGS`.
  Q3A bands: `PERFECT` 0, `HEADSHOT` 1, `IMPRESSIVE` 2–9, `EXCELLENT` 10–49, `HUMILIATION` 50–99, `MASSACRE` 100+.
- `cargo test -p oxlint --lib` → 370 passed, 0 failed (agent snapshots accepted; `<variable>ms`,
  `ΔLoC …: +<variable>/-<variable>`, `source LoC: <variable>` are normalized by the tester).

## 3. Measured timings (feature-chat = 776 files, 212,698 LoC)

| Mode | ms |
| --- | --- |
| type-aware, wall (3 runs) | 16192.2 / 16773.3 / 16690.1 |
| type-aware, self-reported | 4075 / 4943 / 3572 |
| lint-only (`--quiet`) | 12817.8 |
| `railgun` shim on top of a cold native run | 18643.3 |
| `railgun doctor` (Node) | 276.7 |
| whole workspace, one native process | ~86 400 (4411→776-package set differs by scope) |

Current revision (`--no-daemon`, `OXLINT_TSGOLINT_PATH` unset → backend found next to the binary):

| Mode | result | ms |
| --- | --- | --- |
| `-p packages/feature-chat --noEmit --type-aware --type-check` | HUMILIATION 59 errors / 120 warnings / 776 files / 212,572 LoC | 6125 |
| `-p apps/web/tsconfig.json --noEmit --type-aware --type-check` | 367 errors / 9623 warnings / 989 files / 904,460 LoC | 23 285 |
| `eslint` on the whole workspace (no type-aware) | 35 errors / 19 629 warnings / 8084 files / 2,368,939 LoC | 4924 |

Build times (fresh): native 180 s, PGO 132–154 s, lld 135–220 s — lld is a build-time option only.

Selection A/B, current revision, `--no-daemon`, 12 interleaved rounds (median ms):
type-aware PGO 11791.9 / native 11471.8 / lld 11929.6; lint-only PGO 10261.8 / native 9525.2 / lld 9321.2.
The three builds sit within ~7 % of each other, i.e. a tie; the PGO body stays selected because both
earlier passes put it first (type-aware 4045.8 < native 4274.9 < lld 4447.3).
Go backend A/B, 6 rounds: this pass v3 18496.4 vs v3+Go-PGO 19607.1 (+6.0 %), previous pass 3416.8 vs
3388.9 (−0.8 %) and 7690.4 vs 7337.6 (−4.6 %) → within noise, PGO kept; `0.0.0-alpha`.

## 4. Daemon

`railgun.exe daemon start|status|stop`. Transport: Windows named pipe
`\\.\pipe\railgun-<identity>` (TCP only as debug fallback), rendezvous
`.railgun/daemon.json` written by the server itself, 300 s idle timeout, `shutdown` sentinel.
The persistent `LintRunner` keeps the Go TS program, project index and dirty set warm.
Node client: one request per pipe accept, identity embedded in the pipe name,
12 s socket budget then a cold fallback — so the hot loop never pays two timeouts.

## 5. Migrator (`@cyberluke/railgun`, `npm/bin/railgun.js`)

`npx -y @cyberluke/railgun@latest init` from any subdirectory (registry: `@cyberluke/railgun` is live). The same launcher runs from this
folder: `npx -y C:\git\railgun_exe\npm init` or `node C:\git\railgun_exe\npm\bin\railgun.js init`; the
native body is then resolved from `RAILGUN_BIN` → `.railgun/bin` → `C:\bin\railgun.exe`. Root discovery: nearest
`pnpm-workspace.yaml` → `turbo.json` → `package.json` → `.git`; the root itself is always a plan
entry (pnpm importer `.`). Pnpm/negated globs: positives expanded, `!globs` subtracted.
`packages:` rewrite writes concrete dirs (no stray `/*`).

Commands: `init [--dry-run|--diff]`, `rollback`, `doctor`, `status`, `check [paths] [--changed] [--agent]`,
`lint`, `typecheck`, `typegen`, `workspace check|lint|typecheck|typegen [--affected]`, `ci [--build]`,
`baseline capture`, `daemon *`. JSON editing is a string-aware index scanner (`scripts.<key>` only),
`turbo.json` tasks merge structurally (`typegen` is `cache:false` because `.next/types/**` is not
replayed), non-equivalent scripts survive as `railgun:legacy:<name>`, `AGENTS.md` keeps only the
`<!-- railgun:start version=2 -->` block, and the canonical skill
`.agents/skills/railgun/SKILL.md` is mirrored to `.claude`, `.roo`, `.kilo` with a
`source-sha256` header. Per-process memos (plans, skills, binaries, git output) keep the hot
path free of repeated parses.

Legacy → Railgun mapping (in the skill and the managed AGENTS block):
`npx tsc`/`npx tsc --noEmit` → `railgun check . --type-aware --type-check`;
`npx tsc -p …` / `pnpm tsc` → `railgun typecheck`;
`npx eslint .` / `pnpm lint` / `next lint` / `npx oxlint` → `railgun lint`;
per-package loop → `railgun workspace check --affected`.

## 6. Migration demo (pnpm + Turbo + Next 16.x)

48 manifests (47 packages + root) patched in a pnpm/Turbo/Next workspace, `turbo.json` tasks `typegen/check/lint/typecheck` merged
into the existing two, `AGENTS.md` block appended, 4 skill files
(`.claude`/`.roo`/`.kilo` digests equal `7141cf4a7db5…` of the `.agents` canonical),
baseline fingerprints + LoC stored in `.railgun/`. Second `init`: `package.json`, `turbo.json`,
`AGENTS.md` SHA-256 unchanged (only `.railgun/*.json` timestamps are volatile by design;
`managedHash` is the stable anchor). `doctor` → `RAILGUN: READY`; `status` reports
48 packages / 6 Next apps / 46 tsconfig projects / baseline 20 / 1106 changed files.

## 7. Hierarchy and brakes

Next-generated route types (`next typegen`) > Railgun native lint/typecheck > `next build`
(Turbopack) as the final gate. `typeCheck` is still experimental upstream, so native TS7 `tsc`
stays the merge gate; the daemon belongs to the agent hot loop only. Files:
`README.md`, `AGENTS.md`, `npm/package.json`, `npm/bin/railgun.js`, `npm/skills/SKILL.md`, `npm/README.md`,
`build-oxlint.ps1`, `build-tsgolint.ps1`, `build-all.ps1`, `platforms/*/package.json`, `.github/workflows/ci.yml`.
CI matrix (`.github/workflows/ci.yml`) builds all four targets — win32-x64, linux-x64, linux-arm64, darwin-arm64 —
from pinned upstream SHAs (`OXC_SHA`, `TSGOLINT_SHA`) and publishes the four platform packages plus the main one.

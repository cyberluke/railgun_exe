# railgun.exe — Q3A-flavored native TS toolchain

ONE PROCESS. ONE TRAVERSAL. NO SPRAY.

## Validation contract

```text
VALIDATION COMMAND:
C:\bin\railgun.exe packages/feature-chat --changed --type-aware --type-check --quiet --agent

required env: none (backend auto-resolves); optional override OXLINT_TSGOLINT_PATH=C:\bin\railgun-ts.exe
(accepts a file or a directory; else searched in node_modules/.bin, next to the binary, project root, PATH)

modifiers: -p|--project PATH | --noEmit | --pretty | --max-diagnostics N (default 20) | --summary-only | --changed | --no-daemon
machine formats: --agent (short for -f agent) | --json | --jsonl | --timings
defaults (always on, no flag needed): --quiet, -f agent (via --agent); explicit flags still override
daemon: C:\bin\railgun.exe daemon start|status|stop (named pipe \\.\pipe\railgun-<identity>, persistent LintRunner, 300 s idle)

submodules (relative to this repo root): ./oxc -> github.com/cyberluke/oxc, ./tsgolint -> github.com/cyberluke/tsgolint
(nested ./tsgolint/typescript-go -> github.com/cyberluke/typescript-go); populate with
`git submodule update --init --recursive`; rebuild wiring with `pwsh -File vendor-setup.ps1`

Do not run:
- npx tsc
- pnpm tsc
- eslint
- pnpm lint
- biome lint
- separate TypeScript typecheck
```

Mapping: `npx tsc --noEmit` → `railgun check . --type-aware --type-check`; `npx tsc -p …` / `pnpm tsc` → `railgun typecheck`
(native `-p`/`--project` is also accepted: `tsc.exe -p packages/feature-chat --noEmit --type-aware --type-check`);
`npx eslint .` / `pnpm lint` / `next lint` / `npx oxlint` → `railgun lint`; per-package loop → `railgun workspace check --affected`.

Known state on this machine: 776 files, 60 errors + 429 warnings; type-aware ~3.6–4.9 s self-timed
(16.2–16.8 s wall, tsgolint dominated), lint-only 12.8 s wall, `railgun doctor` 277 ms.
Current revision: `cargo test -p oxlint --lib` 370 passed / 0 failed; cold `--no-daemon` type-aware run
prints `59 errors | 120 warnings | 776 files | 212572 LoC | 6125ms`.

## Weapon theme

| Token | Q3A meaning |
| --- | --- |
| `railgun` | weapon switch |
| `-f agent` | zoom |
| `--quiet` | no spray |
| exit `0` | IMPRESSIVE |
| 20 errors < 300 ms | EXCELLENT |
| `0 errors` | PERFECT |
| `1 error` | HEADSHOT |
| `20 errors` | HUMILIATION |

## Build notes

- `tsc` is Go-native since TypeScript 7 (~8–12x vs TS6); tsgolint sits on TS7 (~20–40x vs ESLint + typescript-eslint).
- oxlint `--type-aware --type-check` replaces separate `tsc --noEmit` + `oxlint` CI steps.
- Release profile: `opt-level=3`, fat LTO, `codegen-units=1`, `panic=abort`, mimalloc via `--features allocator`, plus `-C target-cpu=native`.
- PGO: earlier passes showed −4.0 % type-aware / −10.3 % lint-only; the latest 12-round pass is a tie
  (type-aware PGO 11791.9 vs native 11471.8 vs lld 11929.6 ms). PGO body remains selected.
- `typeCheck` is still experimental upstream; native TS7 `tsc` stays the authoritative merge/release gate, never in the agent hot loop.

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

## Build instructions — full parameters per target

Fat package = `npm/` only; bodies land in `npm/bin/<os>-<cpu>/`. Step 0 everywhere:
`git submodule update --init --recursive` (populates `./oxc`, `./tsgolint`, nested `tsgolint/typescript-go`).

### A. win32-x64 + railgun-ts (Windows host, pwsh)

```powershell
pwsh -File build-oxlint.ps1     # writes C:\bin\railgun{,-native,-pgo}.exe
pwsh -File build-tsgolint.ps1   # writes C:\bin\railgun-ts.exe
```

Expanded, the exact invocations:

```powershell
# Rust body (native variant)
Set-Location .\oxc
$env:RUSTFLAGS = '-C target-cpu=native'
cargo build --release -p oxlint --features allocator
# -> target\release\oxlint.exe (14,393,344 B at rev 1.82.0)

# Rust body (PGO, selected): instrument
$env:RUSTFLAGS = '-C target-cpu=native -Cprofile-generate=.\pgo-profile'
cargo build --release -p oxlint --features allocator --target-dir .\target-pgo
# train: 6 workloads, each with $env:LLVM_PROFILE_FILE=.\pgo-profile\corpusN.profraw:
#   target-pgo\release\oxlint.exe apps --type-aware --type-check
#   target-pgo\release\oxlint.exe crates --quiet
#   target-pgo\release\oxlint.exe apps/oxlint/fixtures
#   target-pgo\release\oxlint.exe -p apps/oxlint/fixtures/tsconfig/. --noEmit --type-aware --type-check
#   target-pgo\release\oxlint.exe . --summary-only
#   target-pgo\release\oxlint.exe crates/oxc_linter --agent
rustup component add llvm-tools
# llvm-profdata merge -o .\pgo-profile\merged.profdata .\pgo-profile\*.profraw
$env:RUSTFLAGS = '-C target-cpu=native -Cprofile-use=.\pgo-profile\merged.profdata'
cargo build --release -p oxlint --features allocator --target-dir .\target-pgo-final
# -> target-pgo-final\release\oxlint.exe

# Go backend (TS7)
Set-Location ..\tsgolint
git submodule update --init
Push-Location typescript-go; Get-ChildItem ..\patches\*.patch | % { git am --3way --no-gpg-sign $_.FullName }; Pop-Location
New-Item -ItemType Directory -Force .\internal\collections | Out-Null
Get-ChildItem .\typescript-go\internal\collections\* -File | ? { $_.Name -notlike '*_test.go' } | % { Copy-Item $_.FullName .\internal\collections\ -Force }
$env:GOOS = 'windows'; $env:GOARCH = 'amd64'; $env:GOAMD64 = 'v3'
go test -cpuprofile .\pgo\cpu.prof -run '^$' -bench . .\cmd\tsgolint
Copy-Item .\pgo\cpu.prof .\cmd\tsgolint\default.pgo -Force
go build -trimpath -ldflags='-s -w' -o .\pgo\railgun-ts.exe .\cmd\tsgolint   # -pgo=auto is default
# (comparison build only: `-pgo=off`)

# stage into the fat package
Copy-Item .\oxc\target-pgo-final\release\oxlint.exe ..\npm\bin\win32-x64\railgun.exe -Force
Copy-Item .\tsgolint\pgo\railgun-ts.exe            ..\npm\bin\win32-x64\railgun-ts.exe -Force
```

### B. linux-x64 + linux-arm64 (Docker, same as `ci/build-linux-rust.sh` / `ci/build-linux-go.sh`)

Image `rust:1.98.1` (Rust) and `golang:1.27` (Go); workspace mounted at `/w`
(`/w/oxc`, `/w/tsgolint`, `/w/railgun_exe`). `CARGO_BUILD_TARGET_DIR=/w/t`.

```sh
# stage 1 — rust bodies (from repo root):
docker run --rm -v "$PWD:/w" -w /w rust:1.98.1 sh ci/build-linux-rust.sh
# stage 2 — go backends:
docker run --rm -v "$PWD:/w" -w /w golang:1.27 sh ci/build-linux-go.sh
```

```sh
# one-time toolchain + musl cross linkers
apt-get update -qq; dpkg --add-architecture arm64; apt-get update -qq
apt-get install -y -qq musl-tools musl-dev musl-dev:arm64 gcc-aarch64-linux-gnu g++ g++-aarch64-linux-gnu cmake
cp /usr/bin/x86_64-linux-gnu-g++ /usr/bin/x86_64-linux-musl-g++
cp /usr/bin/aarch64-linux-gnu-g++ /usr/bin/aarch64-linux-musl-g++
rustup target add aarch64-unknown-linux-musl x86_64-unknown-linux-musl

# linux-x64 body (static musl, x86-64-v3):
cd /w/oxc
CARGO_BUILD_TARGET_DIR=/w/t RUSTFLAGS="-C target-cpu=x86-64-v3 -L /usr/lib/x86_64-linux-musl" \
  cargo build --release -p oxlint --features allocator --target x86_64-unknown-linux-musl -j 8
# -> /w/t/x86_64-unknown-linux-musl/release/oxlint  (16,118,656 B)

# linux-arm64 body (musl, gcc-aarch64-linux-gnu linker; clean mimalloc build dir first):
rm -rf /w/t/aarch64-unknown-linux-musl/release/build/libmimalloc-sys2-*
CARGO_BUILD_TARGET_DIR=/w/t RUSTFLAGS="-C linker=aarch64-linux-gnu-gcc -L /usr/lib/aarch64-linux-musl" \
  cargo build --release -p oxlint --features allocator --target aarch64-unknown-linux-musl -j 8
# -> /w/t/aarch64-unknown-linux-musl/release/oxlint  (13,787,632 B)

cp /w/t/x86_64-unknown-linux-musl/release/oxlint   /w/railgun_exe/npm/bin/linux-x64/railgun
cp /w/t/aarch64-unknown-linux-musl/release/oxlint  /w/railgun_exe/npm/bin/linux-arm64/railgun

# Go backends (same internal/collections vendor step as section A):
cd /w/tsgolint
GOOS=linux GOARCH=amd64 GOAMD64=v3 GOTOOLCHAIN=local \
  go build -trimpath -pgo=auto '-ldflags=-s -w' -o /w/railgun_exe/npm/bin/linux-x64/railgun-ts ./cmd/tsgolint
GOOS=linux GOARCH=arm64 GOTOOLCHAIN=local \
  go build -trimpath -pgo=auto '-ldflags=-s -w' -o /w/railgun_exe/npm/bin/linux-arm64/railgun-ts ./cmd/tsgolint
# sizes: linux-x64/railgun-ts 22,429,856 B; linux-arm64/railgun-ts 21,561,504 B
```

### C. darwin-arm64 (macos-14 lane, `ci/build-darwin-arm64.sh` + `verify-darwin-arm64.sh`)

Pinned: rust 1.98.1 (`+llvm-tools`), Go 1.27.0, `-C target-cpu=apple-m1`.
Go: 3-way A/B (`-pgo=off` | old `default.pgo` | fresh native corpus) → fastest to `npm/bin/darwin-arm64/railgun-ts`.
Rust: baseline vs `llvm-profdata`-merged 6-workload PGO, A/B 3 rounds → `npm/bin/darwin-arm64/railgun`.
Verified with `otool -L/-hv` (arm64 Mach-O, no /opt/homebrew links) + PERFECT fixture (`app/page.tsx` + `bad.ts`).

### D. Pack the single package

```sh
cd npm && npm pack    # -> cyberluke-railgun-<ver>.tgz, 11 files, ~50 MB gz
```

Then: `npm publish @cyberluke/railgun` (granular token), no optional deps.
Tray note: `railgun daemon` (the server) creates the system-tray icon in-process; Win11 pumps Win32 msgs inside the np loop, Linux uses the KSNI D-Bus worker.

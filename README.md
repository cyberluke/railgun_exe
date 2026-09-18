# railgun.exe

Native TypeScript validation toolchain: Oxlint (Rust, PGO) + tsgolint (Go, TypeScript 7) behind one binary pair, with a persistent named-pipe daemon, system-tray UI (Windows 11 / Linux KSNI) and the `railgunize` workspace migrator.

Package: one fat npm package `@cyberluke/railgun` (no optional deps), bodies in `bin/<os>-<cpu>/`.

Quick index:

| what | where |
| --- | --- |
| validation contract + modifiers | `AGENTS.md` §Validation contract |
| full build parameters (win32 / linux x64 / linux arm64 / darwin-arm64) | `AGENTS.md` §Build instructions |
| pack / publish | `AGENTS.md` §D. Pack the single package |
| launcher + migrator | `npm/bin/railgun.js` (`railgun`, `railgunize`) |
| package readme | `npm/README.md` |

One-liners:

```text
pwsh -File build-oxlint.ps1 && pwsh -File build-tsgolint.ps1   # win bodies -> C:\bin
docker run --rm -v "$PWD:/w" -w /w rust:1.98.1 sh ci/build-linux-rust.sh
docker run --rm -v "$PWD:/w" -w /w golang:1.27   sh ci/build-linux-go.sh
cd npm && npm pack && npm publish @cyberluke/railgun            # granular token
```

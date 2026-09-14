# Build railgun.exe bodies from oxlint (native / PGO / lld variants).
$ErrorActionPreference = 'Stop'

# Repository layout: script lives next to the source tree roots.
param(
    [string]$OxcRoot = 'C:\git\oxc',
    [string]$BinDir  = 'C:\bin'
)

Set-Location $OxcRoot
$env:PATH = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64;' + $env:PATH
$env:RUSTFLAGS = '-C target-cpu=native'

cargo build --release -p oxlint --features allocator
if ($LASTEXITCODE) { throw "cargo native build failed (exit $LASTEXITCODE)" }

New-Item -ItemType Directory -Force $BinDir | Out-Null
Copy-Item -LiteralPath "$OxcRoot\target\release\oxlint.exe" -Destination "$BinDir\railgun-native.exe" -Force

# PGO stage 1: instrumented
$env:RUSTFLAGS = '-C target-cpu=native -Cprofile-generate='"$OxcRoot"\pgo-profile'
cargo build --release -p oxlint --features allocator --target-dir "$OxcRoot\target-pgo"
if ($LASTEXITCODE) { throw "cargo PGO instrumentation build failed (exit $LASTEXITCODE)" }

# train (see README training matrix), then merge (needs: rustup component add llvm-tools)
# $env:LLVM_PROFILE_FILE = "$OxcRoot\pgo-profile\corpusN.profraw" per run
# llvm-profdata merge -o $OxcRoot\pgo-profile\merged.profdata corpus1..6.profdata

$env:RUSTFLAGS = '-C target-cpu=native -Cprofile-use='"$OxcRoot"\pgo-profile\merged.profdata'
cargo build --release -p oxlint --features allocator --target-dir "$OxcRoot\target-pgo-final"
if ($LASTEXITCODE) { throw "cargo PGO build failed (exit $LASTEXITCODE)" }

Copy-Item -LiteralPath "$OxcRoot\target-pgo-final\release\oxlint.exe" -Destination "$BinDir\railgun-pgo.exe" -Force
Copy-Item -LiteralPath "$BinDir\railgun-pgo.exe" -Destination "$BinDir\railgun.exe" -Force
& "$BinDir\railgun.exe" --version

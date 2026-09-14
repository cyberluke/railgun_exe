Set-Location C:\git\oxc

$env:PATH = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64;" + $env:PATH
$env:RUSTFLAGS = "-C target-cpu=native"

cargo build --release -p oxlint --features allocator

New-Item -ItemType Directory -Force C:\bin | Out-Null
Copy-Item -LiteralPath C:\git\oxc\target\release\oxlint.exe -Destination C:\bin\railgun-native.exe -Force

# PGO stage 1: instrumented
$env:RUSTFLAGS = "-C target-cpu=native -Cprofile-generate=C:\git\oxc\pgo-profile"
cargo build --release -p oxlint --features allocator --target-dir C:\git\oxc\target-pgo

# train (see README training matrix), then merge (needs: rustup component add llvm-tools)
# $env:LLVM_PROFILE_FILE = "C:\git\oxc\pgo-profile\corpusN.profraw" per run
# llvm-profdata merge -o C:\git\oxc\pgo-profile\merged.profdata corpus1..6.profraw

$env:RUSTFLAGS = "-C target-cpu=native -Cprofile-use=C:\git\oxc\pgo-profile\merged.profdata"
cargo build --release -p oxlint --features allocator --target-dir C:\git\oxc\target-pgo-final
Copy-Item -LiteralPath C:\git\oxc\target-pgo-final\release\oxlint.exe -Destination C:\bin\railgun-pgo.exe -Force
Copy-Item -LiteralPath C:\bin\railgun-pgo.exe -Destination C:\bin\railgun.exe -Force
C:\bin\railgun.exe --version

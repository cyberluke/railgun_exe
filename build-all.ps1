# Full multi-platform build for the railgun toolchain (fat npm package).
# Windows artifacts are produced locally; linux/darwin via `cross` if Docker is present.
$ErrorActionPreference = 'Stop'

Write-Host '[build-all] phase 0: submodule checkout (oxc, tsgolint)'
& git -C $PSScriptRoot submodule update --init --recursive

Write-Host '[build-all] phase 1: native bodies (windows host)'
& (Join-Path $PSScriptRoot 'build-oxlint.ps1')
& (Join-Path $PSScriptRoot 'build-tsgolint.ps1')

Write-Host '[build-all] phase 2: stage win32-x64 into the fat package'
foreach ($n in 'railgun', 'railgun-ts') {
  Copy-Item -LiteralPath "C:\bin\$n.exe" -Destination (Join-Path $PSScriptRoot "npm\bin\win32-x64\$n") -Force
}

Write-Host '[build-all] phase 3: cross targets (requires `cross` + Docker; skipped when missing)'
$hasCross = $null -ne (Get-Command cross -ErrorAction SilentlyContinue)
if ($hasCross) {
  Push-Location (Join-Path $PSScriptRoot 'oxc')
  cross build --release -p oxlint --features allocator --target x86_64-unknown-linux-musl
  cross build --release -p oxlint --features allocator --target aarch64-unknown-linux-gnu
  Copy-Item target\x86_64-unknown-linux-musl\release\oxlint (Join-Path $PSScriptRoot 'npm\bin\linux-x64\railgun') -Force
  Copy-Item target\aarch64-unknown-linux-gnu\release\oxlint  (Join-Path $PSScriptRoot 'npm\bin\linux-arm64\railgun') -Force
  Pop-Location
  Push-Location (Join-Path $PSScriptRoot 'tsgolint')
  New-Item -ItemType Directory -Force internal\collections | Out-Null
  Get-ChildItem typescript-go\internal\collections\*.go -File | Where-Object Name -notlike '*_test.go' |
    ForEach-Object { Copy-Item $_.FullName internal\collections\ -Force }
  $env:GOOS = 'linux'; $env:GOARCH = 'amd64';  $env:GOAMD64 = 'v3'
  go build -trimpath -ldflags='-s -w' -o (Join-Path $PSScriptRoot 'npm\bin\linux-x64\railgun-ts') .\cmd\tsgolint
  $env:GOARCH = 'arm64'; Remove-Item Env:GOAMD64
  go build -trimpath -ldflags='-s -w' -o (Join-Path $PSScriptRoot 'npm\bin\linux-arm64\railgun-ts') .\cmd\tsgolint
  # darwin: `ci/build-darwin-arm64.sh` (macos-14 CI) fills npm/bin/darwin-arm64/; skipped locally.
  Pop-Location
} else {
  Write-Host '[build-all] cross not found: linux/darwin artifacts will come from CI'
}

Write-Host '[build-all] phase 4: pack the single package'
Push-Location $PSScriptRoot
& npm.cmd pack npm | ForEach-Object { Write-Host "[build-all] packed $_" }
Pop-Location

Write-Host '[build-all] summary'
Get-ChildItem -Recurse $PSScriptRoot\npm -File | Select-Object Name,Length | Format-Table -AutoSize
Write-Host '[build-all] complete'

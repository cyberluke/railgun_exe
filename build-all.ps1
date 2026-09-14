# Full multi-platform build for the railgun toolchain.
# Windows artifacts are produced locally; linux/darwin via `cross` if Docker is present.
$ErrorActionPreference = 'Stop'

Write-Host '[build-all] phase 1: native bodies (windows host)'
& (Join-Path $PSScriptRoot 'build-oxlint.ps1')
& (Join-Path $PSScriptRoot 'build-tsgolint.ps1')

Write-Host '[build-all] phase 2: stage win32-x64 platform package'
New-Item -ItemType Directory -Force $PSScriptRoot\platforms\win32-x64 | Out-Null
foreach ($n in 'railgun','railgun-pgo','railgun-lld','railgun-native','railgun-ts') {
  Copy-Item -LiteralPath "C:\bin\$n.exe" -Destination (Join-Path $PSScriptRoot "platforms\win32-x64\$n.exe") -Force
}

Write-Host '[build-all] phase 3: cross targets (requires `cross` + Docker; skipped when missing)'
$hasCross = $null -ne (Get-Command cross -ErrorAction SilentlyContinue)
if ($hasCross) {
  Push-Location C:\git\oxc
  $ldAarch = 'aarch64-linux-gnu' # from apt on CI; local: install gcc-aarch64-linux-gnu
  cross build --release -p oxlint --features allocator --target x86_64-unknown-linux-musl
  cross build --release -p oxlint --features allocator --target aarch64-unknown-linux-gnu
  Copy-Item target\x86_64-unknown-linux-musl\release\oxlint (Join-Path $PSScriptRoot 'platforms\linux-x64\railgun.exe') -Force
  Copy-Item target\aarch64-unknown-linux-gnu\release\oxlint  (Join-Path $PSScriptRoot 'platforms\linux-arm64\railgun.exe') -Force
  Pop-Location
  Push-Location C:\git\tsgolint
  New-Item -ItemType Directory -Force internal\collections | Out-Null
  Get-ChildItem typescript-go\internal\collections\*.go -File | Where-Object Name -notlike '*_test.go' |
    ForEach-Object { Copy-Item $_.FullName internal\collections\ -Force }
  $env:GOOS = 'linux'; $env:GOARCH = 'amd64';  $env:GOAMD64 = 'v3'
  go build -trimpath -ldflags='-s -w' -o (Join-Path $PSScriptRoot 'platforms\linux-x64\railgun-ts.exe') .\cmd\tsgolint
  $env:GOARCH = 'arm64'; Remove-Item Env:GOAMD64
  go build -trimpath -ldflags='-s -w' -o (Join-Path $PSScriptRoot 'platforms\linux-arm64\railgun-ts.exe') .\cmd\tsgolint
  # darwin: needs osxcross sysroot; CI (macos-14) covers it.
  Pop-Location
} else {
  Write-Host '[build-all] cross not found: linux/darwin artifacts will come from CI'
}

Write-Host '[build-all] phase 4: pack all packages'
Push-Location $PSScriptRoot
foreach ($dir in @('npm', 'platforms\win32-x64', 'platforms\linux-x64', 'platforms\linux-arm64', 'platforms\darwin-arm64')) {
  $tj = Join-Path $PSScriptRoot "$dir\package.json"
  if (Test-Path $tj) { & npm.cmd pack $dir | ForEach-Object { Write-Host "[build-all] packed $_" } }
}
Pop-Location

Write-Host '[build-all] summary'
Get-ChildItem -Recurse $PSScriptRoot -Include *.tgz,*.exe | Select-Object Name,Length | Format-Table -AutoSize
Write-Host '[build-all] complete'

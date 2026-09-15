# Build railgun-ts.exe (tsgolint on Go-native TypeScript 7).
param(
    [string]$SrcRoot,
    [string]$BinDir  = 'C:\bin'
)
$ErrorActionPreference = 'Stop'

# Submodule layout: ./tsgolint (+ ./tsgolint/typescript-go) next to this script.
if (-not $SrcRoot) { $SrcRoot = Join-Path $PSScriptRoot 'tsgolint' }
if (-not (Test-Path -LiteralPath (Join-Path $SrcRoot '.git'))) {
  Write-Host "[build-tsgolint] missing submodule at $SrcRoot"
  Write-Host '[build-tsgolint] run: git submodule update --init --recursive'
  exit 1
}
Write-Host "[build-tsgolint] tsgolint root = $SrcRoot"

Set-Location $SrcRoot

git submodule update --init
if ($LASTEXITCODE) { throw "git submodule update failed (exit $LASTEXITCODE)" }
Push-Location typescript-go
Get-ChildItem ..\patches\*.patch | ForEach-Object { git am --3way --no-gpg-sign $_.FullName }
Pop-Location

New-Item -ItemType Directory -Force -Path internal\collections | Out-Null
Get-ChildItem -Path .\typescript-go\internal\collections\* -File |
  Where-Object { $_.Name -notlike '*_test.go' } |
  ForEach-Object { Copy-Item $_.FullName -Destination .\internal\collections\ -Force }

$env:GOOS = 'windows'
$env:GOARCH = 'amd64'
$env:GOAMD64 = 'v3'

# Go PGO corpus: representative headless + e2e benchmarks, then store as default.pgo.
go test -cpuprofile "$SrcRoot\pgo\cpu.prof" -run '^$' -bench . .\cmd\tsgolint
if ($LASTEXITCODE) { throw "go test (PGO corpus) failed (exit $LASTEXITCODE)" }
Copy-Item -LiteralPath "$SrcRoot\pgo\cpu.prof" -Destination .\cmd\tsgolint\default.pgo -Force

# -pgo=off is only for the non-PGO comparison build.
go build -pgo=off -trimpath -ldflags='-s -w' -o "$SrcRoot\pgo\ts_v3.exe" .\cmd\tsgolint
if ($LASTEXITCODE) { throw 'go build (non-PGO comparison) failed' }
go build -trimpath -ldflags='-s -w' -o "$BinDir\railgun-ts.exe" .\cmd\tsgolint
if ($LASTEXITCODE) { throw 'go build (PGO) failed' }

[Environment]::SetEnvironmentVariable('OXLINT_TSGOLINT_PATH', "$BinDir\railgun-ts.exe", 'User')
$env:OXLINT_TSGOLINT_PATH = "$BinDir\railgun-ts.exe"

Set-Location C:\git\tsgolint

git submodule update --init
Push-Location typescript-go
Get-ChildItem ..\patches\*.patch | ForEach-Object { git am --3way --no-gpg-sign $_.FullName }
Pop-Location

New-Item -ItemType Directory -Force -Path internal\collections | Out-Null
Get-ChildItem -Path .\typescript-go\internal\collections\* -File |
  Where-Object { $_.Name -notlike '*_test.go' } |
  ForEach-Object { Copy-Item $_.FullName -Destination .\internal\collections\ -Force }

$env:GOOS = "windows"
$env:GOARCH = "amd64"
$env:GOAMD64 = "v3"

# Go PGO corpus: representative headless + e2e benchmarks, then store as default.pgo.
go test -cpuprofile C:\git\tsgolint\pgo\cpu.prof -run "^$" -bench . .\cmd\tsgolint
Copy-Item -LiteralPath C:\git\tsgolint\pgo\cpu.prof -Destination .\cmd\tsgolint\default.pgo -Force

# -pgo=off is only for the non-PGO comparison build.
go build -pgo=off -trimpath -ldflags="-s -w" -o C:\git\tsgolint\pgo\ts_v3.exe .\cmd\tsgolint
go build -trimpath -ldflags="-s -w" -o C:\bin\railgun-ts.exe .\cmd\tsgolint

[Environment]::SetEnvironmentVariable("OXLINT_TSGOLINT_PATH", "C:\bin\railgun-ts.exe", "User")
$env:OXLINT_TSGOLINT_PATH = "C:\bin\railgun-ts.exe"

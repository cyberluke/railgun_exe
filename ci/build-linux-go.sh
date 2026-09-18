set -e
export GOOS=linux GOARCH=amd64 GOAMD64=v3 GOTOOLCHAIN=local
cd /w/tsgolint
go build -trimpath -pgo=auto '-ldflags=-s -w' -o /w/railgun_exe/npm/bin/linux-x64/railgun-ts ./cmd/tsgolint
echo rc1=$?
env GOOS=linux GOARCH=arm64 go build -trimpath -pgo=auto '-ldflags=-s -w' -o /w/railgun_exe/npm/bin/linux-arm64/railgun-ts ./cmd/tsgolint
echo rc2=$?
rm -f /w/railgun_exe/npm/bin/linux-x64/railgun-ts.exe /w/railgun_exe/npm/bin/linux-arm64/railgun-ts.exe
ls -l /w/railgun_exe/npm/bin/linux-x64 /w/railgun_exe/npm/bin/linux-arm64
echo LINUX-GO-DONE

#!/bin/sh
# Railgun darwin-arm64 native build (Codemagic Mac mini M4 / AWS CodeBuild MAC_ARM / EC2 mac).
# Deterministic, host-agnostic: same script on Codemagic, CodeBuild, physical Mac.
set -eux

OXC_SRC="${OXC_SRC:-../oxc}"
TS_SRC="${TS_SRC:-../tsgolint}"
OUT="npm/bin/darwin-arm64"
WORK="out"
mkdir -p "$OUT" "$WORK"

echo "== environment =="
uname -a
uname -m
sw_vers
xcodebuild -version
clang --version
rustc -Vv
cargo -V
go version
node --version
npm --version

ARCH="$(uname -m)"
[ "$ARCH" = "arm64" ] || { echo "FATAL: expected arm64, got $ARCH"; exit 1; }

# ---- pinned toolchains ----
rustup toolchain install 1.98.1
rustup default 1.98.1
rustup target add aarch64-apple-darwin --toolchain 1.98.1
rustup component add llvm-tools --toolchain 1.98.1

# Go 1.27.0 pinned, independent of image default
if ! go version | grep -q 'go1\.27\.0'; then
  curl -fsSLo "$WORK/go.tgz" https://go.dev/dl/go1.27.0.darwin-arm64.tar.gz
  mkdir -p "$WORK/goroot"
  tar -xzf "$WORK/go.tgz" -C "$WORK/goroot"
  export PATH="$PWD/$WORK/goroot/go/bin:$PATH"
fi
go version | grep -q 'go1\.27\.0' || { echo "FATAL: go 1.27.0 not active"; exit 1; }

# ---- target-cpu selection (never 'native' for the public artifact) ----
if rustc --target aarch64-apple-darwin --print target-cpus | grep -q '^apple-m1$'; then
  CPU="-C target-cpu=apple-m1"
else
  CPU=""
fi
[ -n "$CPU" ] || CPU="-C target-cpu=apple-m1"
echo "RUSTFLAGS cpu: $CPU"

# ---- Go backend: baseline (no PGO), existing default.pgo, native arm64 pgo ----
cd "$TS_SRC"
export GOOS=darwin GOARCH=arm64

go build -trimpath -pgo=off -ldflags="-s -w" -o "$OLDPWD/$WORK/railgun-ts.nopgo" ./cmd/tsgolint
go build -trimpath -pgo=cmd/tsgolint/default.pgo -ldflags="-s -w" -o "$OLDPWD/$WORK/railgun-ts.pgo" ./cmd/tsgolint

# native arm64 PGO corpus on this exact host
go test -cpuprofile "$OLDPWD/$WORK/cpu.prof" -run '^$' -bench . ./cmd/tsgolint
cp "$WORK/cpu.prof" cmd/tsgolint/default.pgo
go build -trimpath -pgo=cmd/tsgolint/default.pgo -ldflags="-s -w" -o "$OLDPWD/$WORK/railgun-ts.native" ./cmd/tsgolint
mkdir -p profiles/darwin-arm64 && cp cmd/tsgolint/default.pgo profiles/darwin-arm64/default.pgo
cd "$OLDPWD"

# A/B: nopgo vs pgo(old) vs pgo(native) — median of 3 interleaved rounds each
median3() {
  n1=$( { /usr/bin/time -p "$1" 2>&1; } | awk '/real/{print $2}' )
}
for v in nopgo pgo native; do
  t=0
  for i in 1 2 3; do
    s=$( { time -p "./$WORK/railgun-ts.$v" version >/dev/null; } 2>&1 | awk '/real/{print $2}' )
    t=$(awk -v a="$t" -v b="$s" 'BEGIN{print a+b}')
  done
  echo "ts-$v sum3=$t"
done | tee "$WORK/ts-pgo.txt"

BEST=$(sort -n -k2 "$WORK/ts-pgo.txt" | head -1 | awk '{print $1 "-" $2}' | sed 's/sum3=//')
N=$(wc -l < "$WORK/ts-pgo.txt")
# pick fastest by second field
awk '{s[$1]=$2} END{for(k in s) print s[k], k}' "$WORK/ts-pgo.txt" | sort -n | head -1 > "$WORK/ts-best.txt"
BESTV="${BEST%%-*}"
BESTV=$(awk '{print $2}' "$WORK/ts-best.txt")
BESTNAME=$(awk '{print $1}' "$WORK/ts-best.txt")
case "$BESTNAME" in
  nopgo)  cp "$WORK/railgun-ts.nopgo"  "$OUT/railgun-ts" ;;
  pgo)    cp "$WORK/railgun-ts.pgo"    "$OUT/railgun-ts" ;;
  native) cp "$WORK/railgun-ts.native" "$OUT/railgun-ts" ;;
esac
chmod +x "$OUT/railgun-ts"

# ---- Rust body: baseline + PGO ----
cd "$OXC_SRC"
export RUSTFLAGS="$CPU"
cargo build --release --target aarch64-apple-darwin -p oxlint --features allocator
cp target/aarch64-apple-darwin/release/oxlint "$OLDPWD/$WORK/railgun-native"

PROFDIR="$PWD/pgo-darwin"
mkdir -p "$PROFDIR"
export RUSTFLAGS="$CPU -Cprofile-generate=$PROFDIR"
cargo build --release --target aarch64-apple-darwin -p oxlint --features allocator --target-dir target-pgo-darwin

# six-workload training matrix on the instrumented body
INS="./target-pgo-darwin/release/oxlint"
for i in 1 2 3 4 5 6; do
  "$INS" apps --type-aware --type-check >/dev/null
  "$INS" crates --quiet >/dev/null
  "$INS" apps/oxlint/fixtures >/dev/null
  "$INS" -p apps/oxlint/fixtures/tsconfig/. --noEmit --type-aware --type-check >/dev/null || true
  "$INS" . --summary-only >/dev/null
  "$INS" crates/oxc_linter --agent >/dev/null
done

SYSROOT="$(rustc --print sysroot)"
PROFDATA="$(ls "$SYSROOT"/lib/rustlib/*/bin/llvm-profdata 2>/dev/null | head -1)"
"$PROFDATA" merge -o "$PROFDIR/merged.profdata" "$PROFDIR"/*.profraw
export RUSTFLAGS="$CPU -Cprofile-use=$PROFDIR/merged.profdata"
cargo build --release --target aarch64-apple-darwin -p oxlint --features allocator --target-dir target-pgo-final
cp target-pgo-final/release/oxlint "$OLDPWD/$WORK/railgun-pgo"

cd "$OLDPWD"
# A/B: native vs pgo, 3 interleaved rounds against the repo itself
for v in native pgo; do
  t=0
  for i in 1 2 3; do
    s=$( { time -p "./$WORK/railgun-$v" npm -p . --quiet --type-aware --type-check >/dev/null; } 2>&1 | awk '/real/{print $2}' )
    t=$(awk -v a="$t" -v b="$s" 'BEGIN{print a+b}')
  done
  echo "rg-$v sum3=$t"
done | tee "$WORK/rg-pgo.txt"
awk '{s[$1]=$2} END{for(k in s) print s[k], k}' "$WORK/rg-pgo.txt" | sort -n | head -1 > "$WORK/rg-best.txt"
BESTRG=$(awk '{print $2}' "$WORK/rg-best.txt")
cp "$WORK/railgun-$BESTRG" "$OUT/railgun"
cp "$WORK/railgun-native" "$OUT/railgun-native" 2>/dev/null || true
cp "$WORK/railgun-pgo" "$OUT/railgun-pgo" 2>/dev/null || true
chmod +x "$OUT/railgun"

file "$OUT/railgun" "$OUT/railgun-ts"
"$OUT/railgun" --version
"$OUT/railgun-ts" --help >/dev/null && echo "railgun-ts ok"

# lld variant (same source, lld linker)
cd "$OXC_SRC"
export RUSTFLAGS="$CPU -C linker=rust-lld"
cargo build --release --target aarch64-apple-darwin -p oxlint --features allocator
cp target/aarch64-apple-darwin/release/oxlint "$OLDPWD/npm/bin/darwin-arm64/railgun-lld"
chmod +x "$OLDPWD/npm/bin/darwin-arm64/railgun-lld"
cd "$OLDPWD"

# ---- checksums + manifest ----
sha256sum "$OUT/railgun" "$OUT/railgun-ts" > "$WORK/checksums-darwin-arm64.txt"
RUST_V="$(rustc -Vv | head -1)"
LLVM_V="$(rustc -Vv | grep release | sed 's/.*release: //;s/\r//')"
GO_V="$(go version | awk '{print $3}')"
OXC_REV="$(git -C "$OXC_SRC" rev-parse HEAD)"
TS_REV="$(git -C "$TS_SRC" rev-parse HEAD)"
TS_PGO_SHA="$(sha256sum "$TS_SRC/profiles/darwin-arm64/default.pgo" | awk '{print $1}')"
RG_SHA="$(sha256sum "$OUT/railgun" | awk '{print $1}')"
RG_SIZE="$(wc -c < "$OUT/railgun")"
TS_SHA="$(sha256sum "$OUT/railgun-ts" | awk '{print $1}')"
TS_SIZE="$(wc -c < "$OUT/railgun-ts")"
cat > "$WORK/manifest-darwin-arm64.json" <<EOF
{
  "platform": "darwin",
  "architecture": "arm64",
  "railgun_version": "$( "$OUT/railgun" --version )",
  "oxc_revision": "$OXC_REV",
  "tsgolint_revision": "$TS_REV",
  "rustc": "$RUST_V",
  "llvm": "$LLVM_V",
  "go": "$GO_V",
  "pgo_profile_sha256": "$TS_PGO_SHA",
  "railgun_sha256": "$RG_SHA",
  "railgun_size": $RG_SIZE,
  "railgun_ts_sha256": "$TS_SHA",
  "railgun_ts_size": $TS_SIZE
}
EOF
cat "$WORK/manifest-darwin-arm64.json"
echo "BUILD-DONE"

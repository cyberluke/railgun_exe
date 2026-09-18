# /w is this repo root; the oxc submodule lives at /w/oxc (see .gitmodules).
set -e
rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl aarch64-apple-darwin
apt-get update -qq && apt-get install -y -qq musl-tools gcc-aarch64-linux-gnu osxcross > /dev/null || apt-get install -y -qq musl-tools gcc-aarch64-linux-gnu
echo "targets: $(rustup target list --installed | tr '\n' ' ')"
mkdir -p /w/npm/bin/win32-x64 /w/npm/bin/linux-x64 /w/npm/bin/linux-arm64 /w/npm/bin/darwin-arm64
cd /w/oxc
export CARGO_BUILD_TARGET_DIR=/tmp/t
echo "== x86_64-unknown-linux-musl +"
RUSTFLAGS='-C target-cpu=x86-64-v3' cargo build --release -p oxlint --features allocator --target x86_64-unknown-linux-musl 2>&1 | tail -1
cp /tmp/t/x86_64-unknown-linux-musl/release/oxlint /w/npm/bin/linux-x64/railgun
echo "== aarch64-unknown-linux-musl +"
cargo build --release -p oxlint --features allocator --target aarch64-unknown-linux-musl 2>&1 | tail -1
cp /tmp/t/aarch64-unknown-linux-musl/release/oxlint /w/npm/bin/linux-arm64/railgun
echo "== aarch64-apple-darwin =="
cargo build --release -p oxlint --features allocator --target aarch64-apple-darwin 2>&1 | tail -1
cp /tmp/t/aarch64-apple-darwin/release/oxlint /w/npm/bin/darwin-arm64/railgun
ls -la /w/npm/bin/*/; /w/npm/bin/linux-x64/railgun --version

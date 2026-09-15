# /w is this repo root; the oxc submodule lives at /w/oxc (see .gitmodules).
set -e
rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl aarch64-apple-darwin
apt-get update -qq && apt-get install -y -qq musl-tools gcc-aarch64-linux-gnu osxcross > /dev/null || apt-get install -y -qq musl-tools gcc-aarch64-linux-gnu
echo "targets: $(rustup target list --installed | tr '\n' ' ')"
mkdir -p /w/out
cd /w/oxc
export CARGO_BUILD_TARGET_DIR=/tmp/t
echo "== x86_64-unknown-linux-musl +"
RUSTFLAGS='-C target-cpu=x86-64-v3' cargo build --release -p oxlint --features allocator --target x86_64-unknown-linux-musl 2>&1 | tail -1
cp /tmp/t/x86_64-unknown-linux-musl/release/oxlint /w/out/railgun-x64
echo "== aarch64-unknown-linux-musl +"
cargo build --release -p oxlint --features allocator --target aarch64-unknown-linux-musl 2>&1 | tail -1
cp /tmp/t/aarch64-unknown-linux-musl/release/oxlint /w/out/railgun-arm
echo "== aarch64-apple-darwin =="
cargo build --release -p oxlint --features allocator --target aarch64-apple-darwin 2>&1 | tail -1
cp /tmp/t/aarch64-apple-darwin/release/oxlint /w/out/railgun-darwin
ls -la /w/out; /w/out/railgun-x64 --version

set -e
apt-get update -qq; dpkg --add-architecture arm64; apt-get update -qq
apt-get install -y -qq musl-tools musl-dev musl-dev:arm64 gcc-aarch64-linux-gnu g++ g++-aarch64-linux-gnu cmake >/dev/null
cp /usr/bin/x86_64-linux-gnu-g++ /usr/bin/x86_64-linux-musl-g++
cp /usr/bin/aarch64-linux-gnu-g++ /usr/bin/aarch64-linux-musl-g++
rustup target add aarch64-unknown-linux-musl x86_64-unknown-linux-musl >/dev/null
rm -rf /w/t/aarch64-unknown-linux-musl/release/build/libmimalloc-sys2-*
cd /w/oxc
RUSTFLAGS="-C linker=aarch64-linux-gnu-gcc -L /usr/lib/aarch64-linux-musl" cargo build --release -p oxlint --features allocator --target aarch64-unknown-linux-musl -j 8 2>&1 | tail -3
cp /w/t/aarch64-unknown-linux-musl/release/oxlint /w/railgun_exe/npm/bin/linux-arm64/railgun
file /w/railgun_exe/npm/bin/linux-arm64/railgun
RUSTFLAGS="-C target-cpu=x86-64-v3 -L /usr/lib/x86_64-linux-musl" cargo build --release -p oxlint --features allocator --target x86_64-unknown-linux-musl -j 8 2>&1 | tail -3
cp /w/t/x86_64-unknown-linux-musl/release/oxlint /w/railgun_exe/npm/bin/linux-x64/railgun
file /w/railgun_exe/npm/bin/linux-x64/railgun
/w/railgun_exe/npm/bin/linux-x64/railgun --version
echo LINUX-RUST-DONE

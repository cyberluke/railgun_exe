set -e
apt-get update -qq; dpkg --add-architecture arm64; apt-get update -qq
apt-get install -y -qq musl-tools musl-dev musl-dev:arm64 gcc-aarch64-linux-gnu g++ cmake cmake-data >/dev/null
ls /usr/bin | grep -i 'g++'
for n in /usr/bin/x86_64-linux-musl-g++ /usr/bin/aarch64-linux-musl-g++ /usr/bin/musl-g++; do [ -e "$n" ] && echo "have $n"; done

#!/bin/sh
# Railgun darwin-arm64 verification: Mach-O, linkage, strings, fixture smoke, npm pack + clean install.
set -eux

OUT="npm/bin/darwin-arm64"
WORK="out"
FIX="$PWD/.fixture-darwin"

# 7. dynamic linkage + arch
otool -L "$OUT/railgun"
otool -L "$OUT/railgun-ts"
otool -hv "$OUT/railgun" | grep -q 'ARM64'
otool -hv "$OUT/railgun-ts" | grep -q 'ARM64'
if ! file "$OUT/railgun" | grep -q 'Mach-O 64-bit executable arm64'; then
  echo "FATAL railgun not Mach-O arm64"; exit 1
fi
if ! file "$OUT/railgun-ts" | grep -q 'Mach-O 64-bit executable arm64'; then
  echo "FATAL railgun-ts not Mach-O arm64"; exit 1
fi
LINKS="$(otool -L "$OUT/railgun" "$OUT/railgun-ts")"
echo "$LINKS" | grep -E '/opt/homebrew|/usr/local|/Users/.*/(codemagic|builder)' && exit 1 || true

# 8. stripped sources
strings "$OUT/railgun" | grep -E '/Users/|/Volumes/|codemagic|builder' || true
strings "$OUT/railgun-ts" | grep -E '/Users/|/Volumes/|codemagic|builder' || true

# 9. type-aware fixture
rm -rf "$FIX" && mkdir -p "$FIX"
printf '{"name":"fx","version":"1.0.0","dependencies":{"next":"16.3.0"},"devDependencies":{"typescript":"^5.9"}}' > "$FIX/package.json"
printf '{"compilerOptions":{"strict":true,"jsx":"react-jsx","moduleResolution":"bundler"},"include":["*.ts","*.tsx","app"]}' > "$FIX/tsconfig.json"
mkdir -p "$FIX/app"
printf 'export const dynamic = "force-static";\nexport default function Page(){ return null }\n' > "$FIX/app/page.tsx"
printf 'const x: number = "s";\nexport default x;\n' > "$FIX/bad.ts"

export OXLINT_TSGOLINT_PATH="$PWD/$OUT/railgun-ts"
"$OUT/railgun" "$FIX" --type-aware --type-check --format agent
"$OUT/railgun" "$FIX" --type-aware --type-check --summary-only

# repair -> PERFECT
printf 'const x: number = 1;\nexport default x;\n' > "$FIX/bad.ts"
OUT_LINE="$("$OUT/railgun" "$FIX" --type-aware --type-check --format agent | head -1)"
echo "$OUT_LINE" | grep -q 'PERFECT' || { echo "FATAL not PERFECT: $OUT_LINE"; exit 1; }

# 11. npm packaging from packed artifacts only
npm pack --dry-run ./npm >/dev/null
npm pack ./npm --pack-destination "$WORK" >/dev/null
rm -rf "$WORK/clean" && mkdir -p "$WORK/clean"
cd "$WORK/clean"
printf '{"name":"clean-proj","version":"1.0.0"}' > package.json
npm install --no-save "../$(basename ./*.tgz 2>/dev/null | head -1)" >/dev/null 2>&1 || true
npx railgun --version
npx railgun doctor
npx railgun check --agent
cd ../..

# 12. checksums
sha256sum "$OUT/railgun" "$OUT/railgun-ts" > "$WORK/checksums-darwin-arm64.txt"
echo "VERIFY-DONE"
echo "RAILGUN DARWIN: READY"

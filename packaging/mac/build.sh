#!/bin/bash
# RedGiant.app and its .dmg for macOS (2026-11-05), on a Mac (the CI's, or yours), after
# `pnpm install --frozen-lockfile && pnpm build` at the repository's root.
#
#   packaging/mac/build.sh <version>
#
# Signed with a Developer ID when MAC_SIGN_IDENTITY names one in the keychain (the CI imports it),
# otherwise ad-hoc (it runs on this Mac only). Notarized and stapled when MAC_NOTARY_KEY (an App
# Store Connect API key file, .p8), MAC_NOTARY_KEY_ID and MAC_NOTARY_ISSUER_ID are set.
# pgvector (G36.1) goes into Resources/server/pgvector, signed with the rest: from PGVECTOR_ZIP (the
# release's pgvector job), otherwise built here with engine/pgvector/build-mac.sh (a minute or two).
set -euo pipefail

version="${1:-0.0.0}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
here="$root/packaging/mac"
arch="$(uname -m)"
dist="$here/dist"
app="$dist/RedGiant.app"
res="$app/Contents/Resources"
identity="${MAC_SIGN_IDENTITY:--}"

rm -rf "$dist"
mkdir -p "$app/Contents/MacOS" "$res/node"

echo "== The server, with its production modules (real folders, no links)"
cd "$root"
pnpm --filter @redgiant/server deploy --prod --legacy --config.node-linker=hoisted "$res/server" >/dev/null
# Codex and Claude Code (hundreds of MB) come down only when a subscription is switched on.
rm -rf "$res"/server/node_modules/@openai/codex-darwin-* \
  "$res"/server/node_modules/@anthropic-ai/claude-agent-sdk-darwin-*
# Postgres' libraries come three times each from npm: the copies become links again.
for lib in "$res"/server/node_modules/@embedded-postgres/darwin-*/native/lib; do
  node "$here/dedupe-libs.mjs" "$lib" | tail -1
done
echo "== pgvector for the embedded Postgres (universal, from a folder of its own)"
pgv_zip="${PGVECTOR_ZIP:-}"
if [ -z "$pgv_zip" ]; then
  bash "$root/engine/pgvector/build-mac.sh" "$dist/pgvector" | tail -3
  pgv_zip="$(ls "$dist"/pgvector/pgvector-*-macos-universal.zip)"
fi
mkdir -p "$res/server/pgvector"
unzip -q "$pgv_zip" -d "$res/server/pgvector"
lipo -info "$res/server/pgvector/lib/vector.dylib"
cp -R packages/web/dist "$res/web"
cp "$(command -v node)" "$res/node/node"
echo "what weighs most:"
du -sh "$res/node" "$res/web" "$res"/server/node_modules/* "$res"/server/node_modules/@*/* 2>/dev/null | sort -h | tail -8

echo "== The icon"
iconset="$dist/RedGiant.iconset"
mkdir -p "$iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s packages/web/public/icon-512.png --out "$iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  if [ $d -le 512 ]; then
    sips -z $d $d packages/web/public/icon-512.png --out "$iconset/icon_${s}x${s}@2x.png" >/dev/null
  else
    cp packages/web/public/icon-512.png "$iconset/icon_${s}x${s}@2x.png"
  fi
done
iconutil -c icns "$iconset" -o "$res/RedGiant.icns"
rm -rf "$iconset"
sips -z 36 36 packages/web/public/icon-512.png --out "$res/menubar.png" >/dev/null

echo "== The menu bar program"
swiftc -O -target "$arch-apple-macos13" -o "$app/Contents/MacOS/RedGiant" "$here/RedGiant.swift"
sed "s/__VERSION__/$version/g" "$here/Info.plist" > "$app/Contents/Info.plist"

echo "== Signing ($([ "$identity" = "-" ] && echo ad-hoc || echo "$identity"))"
sign() {
  if [ "$identity" = "-" ]; then
    codesign --force --sign - "$@"
  else
    codesign --force --timestamp --options runtime --sign "$identity" "$@"
  fi
}
# Every program and library inside, deepest first: Node, Postgres, native modules.
count=0
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q "Mach-O"; then
    sign --entitlements "$here/node.entitlements" "$f"
    count=$((count + 1))
  fi
done < <(find "$res" -type f \( -name "*.node" -o -name "*.dylib" -o -name "*.so" -o -perm -u+x \) -print0)
echo "$count programs and libraries signed"
sign "$app"
codesign --verify --deep --strict "$app"

echo "== The disk image"
stage="$dist/stage"
mkdir -p "$stage"
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
dmg="$dist/RedGiant-mac-$arch.dmg"
# LZMA (macOS 10.15 and later): smaller than the default zlib.
hdiutil create -volname RedGiant -srcfolder "$stage" -ov -format ULMO "$dmg" >/dev/null
rm -rf "$stage"
if [ "$identity" != "-" ]; then
  codesign --force --timestamp --sign "$identity" "$dmg"
fi

if [ "$identity" != "-" ] && [ -n "${MAC_NOTARY_KEY:-}" ]; then
  echo "== Notarization (Apple checks it; a few minutes)"
  xcrun notarytool submit "$dmg" --key "$MAC_NOTARY_KEY" --key-id "$MAC_NOTARY_KEY_ID" \
    --issuer "$MAC_NOTARY_ISSUER_ID" --wait --timeout 30m
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  spctl -a -t open --context context:primary-signature -v "$dmg"
fi
ls -lh "$dmg"

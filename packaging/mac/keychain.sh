#!/bin/bash
# The Developer ID certificate in a keychain of this CI run only, and the notary key on disk
# (2026-11-05). Reads MAC_CERTIFICATE_P12 (base64 of the .p12), MAC_CERTIFICATE_PASSWORD and
# MAC_NOTARY_KEY (base64 of the .p8); writes MAC_SIGN_IDENTITY and MAC_NOTARY_KEY for the next
# steps into $GITHUB_ENV. Without a certificate it does nothing: the app is then signed ad-hoc.
set -euo pipefail
if [ -z "${MAC_CERTIFICATE_P12:-}" ]; then
  echo "No certificate: the app is signed ad-hoc"
  exit 0
fi
kc="$RUNNER_TEMP/build.keychain-db"
pass="$(openssl rand -hex 16)"
security create-keychain -p "$pass" "$kc"
security set-keychain-settings -lut 3600 "$kc"
security unlock-keychain -p "$pass" "$kc"
echo "$MAC_CERTIFICATE_P12" | base64 --decode > "$RUNNER_TEMP/cert.p12"
security import "$RUNNER_TEMP/cert.p12" -k "$kc" -P "${MAC_CERTIFICATE_PASSWORD:-}" -T /usr/bin/codesign
rm "$RUNNER_TEMP/cert.p12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$pass" "$kc" >/dev/null
# shellcheck disable=SC2046
security list-keychains -d user -s "$kc" $(security list-keychains -d user | tr -d '"')
id=$(security find-identity -v -p codesigning "$kc" | grep "Developer ID Application" | head -1 | sed -E 's/.*"(.*)"/\1/')
if [ -z "$id" ]; then
  echo "The certificate has no \"Developer ID Application\" identity"
  exit 1
fi
echo "Signing as: $id"
echo "MAC_SIGN_IDENTITY=$id" >> "$GITHUB_ENV"
if [ -n "${MAC_NOTARY_KEY:-}" ]; then
  echo "$MAC_NOTARY_KEY" | base64 --decode > "$RUNNER_TEMP/notary.p8"
  echo "MAC_NOTARY_KEY=$RUNNER_TEMP/notary.p8" >> "$GITHUB_ENV"
fi

#!/bin/bash
# pgvector for the embedded Postgres on macOS (G36.1): one universal library (arm64 + x86_64,
# macOS 13.0 or later, like the zonky binaries npm's embedded-postgres carries for both Macs).
# Postgres' headers, Makefile.global and pg_config come from its own source, configured here; then
# pgvector is built once per architecture and joined with lipo. PGXS would link the bundle against
# `-bundle_loader <bindir>/postgres`, a program not built here: `-undefined dynamic_lookup` instead
# resolves Postgres' symbols when the server loads the library.
#
#   bash engine/pgvector/build-mac.sh out
#
# Output: <out>/pgvector-<ver>-pg<major>-macos-universal.zip (lib/, share/extension/) and .sha256.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=engine/pgvector/versions.env
. "$here/versions.env"
out="$(mkdir -p "${1:-out}" && cd "${1:-out}" && pwd)"
jobs="${JOBS:-$(sysctl -n hw.ncpu)}"
major="${PG_VERSION%%.*}"
name="pgvector-$PGVECTOR_VERSION-pg$major-macos-universal"
export MACOSX_DEPLOYMENT_TARGET=13.0

work="$(mktemp -d)"
cd "$work"
curl -fsSL "https://ftp.postgresql.org/pub/source/v$PG_VERSION/postgresql-$PG_VERSION.tar.bz2" | tar xj
cd "postgresql-$PG_VERSION"
./configure -q --prefix="$work/pg" --without-icu --without-readline --without-zlib
make -s -j"$jobs" -C src/backend generated-headers
make -s -C src/include install
make -s -C src install-local
make -s -C src/makefiles install
make -s -j"$jobs" -C src/port install
make -s -j"$jobs" -C src/common install
make -s -C src/bin/pg_config install

cd "$work"
curl -fsSL "https://github.com/pgvector/pgvector/archive/refs/tags/v$PGVECTOR_VERSION.tar.gz" | tar xz
for a in arm64 x86_64; do
  rm -rf "build-$a" && cp -R "pgvector-$PGVECTOR_VERSION" "build-$a"
  make -s -C "build-$a" -j"$jobs" PG_CONFIG="$work/pg/bin/pg_config" OPTFLAGS="" \
    PG_CFLAGS="-arch $a -mmacosx-version-min=13.0" PG_LDFLAGS="-arch $a -mmacosx-version-min=13.0" \
    BE_DLLLIBS="-undefined dynamic_lookup"
  lipo -info "build-$a/vector.dylib"
done

stage="$work/$name"
mkdir -p "$stage/lib" "$stage/share/extension"
lipo -create "build-arm64/vector.dylib" "build-x86_64/vector.dylib" -output "$stage/lib/vector.dylib"
lipo -info "$stage/lib/vector.dylib"
for a in arm64 x86_64; do
  echo "$a minos: $(otool -arch "$a" -l "$stage/lib/vector.dylib" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; exit}')"
done
# The install script (vector--<ver>.sql) is made by make from sql/vector.sql: it exists only in the
# built copies, not in the untouched source (the CI's mac-app: "no installation script").
src="build-arm64"
cp "$src/vector.control" "$src"/sql/vector--*.sql "$stage/share/extension/"
test -f "$stage/share/extension/vector--$PGVECTOR_VERSION.sql" || { echo "vector--$PGVECTOR_VERSION.sql missing" >&2; exit 1; }
grep -q "default_version = '$PGVECTOR_VERSION'" "$stage/share/extension/vector.control" || { echo "vector.control is not $PGVECTOR_VERSION" >&2; exit 1; }
rm -f "$out/$name.zip"
(cd "$stage" && zip -q -X -r "$out/$name.zip" lib share)
(cd "$out" && shasum -a 256 "$name.zip" | tee "$name.zip.sha256")

#!/bin/bash
# pgvector for the embedded Postgres on Linux (G36.1). Runs inside ubuntu:18.04, the base of the
# zonky binaries that npm's embedded-postgres carries (glibc 2.27): the library then asks only for
# glibc 2.14 and loads on any Linux those binaries run on. Only what PGXS needs is built from the
# Postgres source (generated headers, Makefile.global, pg_config), then pgvector, with no
# -march=native (pgvector picks its SIMD code at run time).
#
#   docker run --rm -v "$PWD:/w" -w /w ubuntu:18.04 bash engine/pgvector/build-linux.sh out
#
# Output: <out>/pgvector-<ver>-pg<major>-linux-<arch>.zip (lib/, share/extension/) and .sha256.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=engine/pgvector/versions.env
. "$here/versions.env"
out="$(mkdir -p "${1:-out}" && cd "${1:-out}" && pwd)"
jobs="${JOBS:-2}"
case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo "unsupported $(uname -m)" >&2; exit 1 ;; esac
major="${PG_VERSION%%.*}"
name="pgvector-$PGVECTOR_VERSION-pg$major-linux-$arch"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends build-essential curl ca-certificates flex bison zlib1g-dev zip >/dev/null

work="$(mktemp -d)"
cd "$work"
curl -fsSL "https://ftp.postgresql.org/pub/source/v$PG_VERSION/postgresql-$PG_VERSION.tar.bz2" | tar xj
cd "postgresql-$PG_VERSION"
./configure -q --prefix=/opt/pg --without-icu --without-readline
make -s -j"$jobs" -C src/backend generated-headers
make -s -C src/include install
make -s -C src install-local
make -s -C src/makefiles install
make -s -j"$jobs" -C src/port install
make -s -j"$jobs" -C src/common install
make -s -C src/bin/pg_config install

cd "$work"
curl -fsSL "https://github.com/pgvector/pgvector/archive/refs/tags/v$PGVECTOR_VERSION.tar.gz" | tar xz
cd "pgvector-$PGVECTOR_VERSION"
make -s -j"$jobs" PG_CONFIG=/opt/pg/bin/pg_config OPTFLAGS=""

stage="$work/$name"
mkdir -p "$stage/lib" "$stage/share/extension"
cp vector.so "$stage/lib/"
cp vector.control sql/vector--*.sql "$stage/share/extension/"
# CREATE EXTENSION needs the install script make wrote, for the version the control file names.
test -f "$stage/share/extension/vector--$PGVECTOR_VERSION.sql" || { echo "vector--$PGVECTOR_VERSION.sql missing" >&2; exit 1; }
grep -q "default_version = '$PGVECTOR_VERSION'" "$stage/share/extension/vector.control" || { echo "vector.control is not $PGVECTOR_VERSION" >&2; exit 1; }
echo "glibc needed: $(objdump -T vector.so | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)"
echo "built against: $(/opt/pg/bin/pg_config --version)"
rm -f "$out/$name.zip"
(cd "$stage" && zip -q -X -r "$out/$name.zip" lib share)
(cd "$out" && sha256sum "$name.zip" | tee "$name.zip.sha256")

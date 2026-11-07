# RedGiant's Postgres for Docker (G36.1): the same postgres:17-alpine as before, with pgvector.
# Image: ghcr.io/frostmoore/redgiant2-postgres:17-pgvector0.8.7 (and :latest), built by
# release.yml. It stays on 17 and on Alpine (musl) on purpose: a volume made by postgres:17-alpine
# opens as it is (tested, study_g36_vector.md section 5), while a Debian image would sort text
# differently (en_US.utf8 in glibc) and leave the btree indexes on text wrong. Moving the volume to
# Postgres 18 is a backup and restore, another day.
#
#   docker build -f docker/postgres.Dockerfile -t ghcr.io/frostmoore/redgiant2-postgres:17-pgvector0.8.7 docker

ARG PG_IMAGE=postgres:17-alpine

FROM ${PG_IMAGE} AS build
ARG PGVECTOR_VERSION=0.8.7
RUN apk add --no-cache build-base curl
# Postgres' own build flags, no -march=native: pgvector chooses its SIMD code at run time, so the
# image runs on any CPU of its architecture. No LLVM bitcode (the JIT is not used).
RUN curl -fsSL "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" | tar xz -C /tmp \
 && cd "/tmp/pgvector-${PGVECTOR_VERSION}" \
 && make OPTFLAGS="" with_llvm=no \
 && make install with_llvm=no DESTDIR=/out

FROM ${PG_IMAGE}
ARG PGVECTOR_VERSION=0.8.7
LABEL org.opencontainers.image.title="redgiant2-postgres" \
      org.opencontainers.image.description="postgres:17-alpine with pgvector ${PGVECTOR_VERSION} for RedGiant" \
      org.opencontainers.image.source="https://github.com/Frostmoore/redgiant2" \
      org.opencontainers.image.licenses="PostgreSQL"
# Only pgvector's files (the library and its control and SQL files), into the image's own folders.
COPY --from=build /out/usr/local/ /usr/local/

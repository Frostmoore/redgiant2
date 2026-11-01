#!/usr/bin/env bash
# RedGiant's container entrypoint.
#   (default)  the server under the supervisor, from a git copy of the source in the data volume
#   egress     the egress proxy for the sandboxes
#   anything else is run as is
set -euo pipefail

APP=/opt/redgiant
DATA=${REDGIANT_DATA_DIR:-/data}
SRC=$DATA/source
VERSION=$(cat "$APP/.image-version")
log() { echo "[entrypoint] $*"; }
git_() { git -c user.name=RedGiant -c user.email=redgiant@localhost -C "$SRC" "$@"; }

case "${1:-redgiant}" in
  egress)
    shift
    exec node "$APP/packages/sandbox/dist/egress-main.js" "${1:-/etc/redgiant/egress.json}" "${2:-3128}"
    ;;
  redgiant) ;;
  *) exec "$@" ;;
esac

mkdir -p "$DATA"
if [ ! -d "$SRC/.git" ]; then
  # First start: the image's source becomes a repository God can change (G14).
  log "copying RedGiant $VERSION into $SRC"
  rm -rf "$SRC"
  cp -a "$APP" "$SRC"
  git_ init -q -b live
  git_ add -A
  git_ commit -q -m "RedGiant $VERSION"
  git_ branch upstream
  echo "$VERSION" > "$SRC/.git/redgiant-image"
  # Already built in the image: the supervisor need not build it again.
  mkdir -p "$DATA/release"
  printf '{"lastGood":null,"built":"%s","history":[]}\n' "$(git_ rev-parse HEAD)" > "$DATA/release/release.json"
  chown -R node:node "$SRC" "$DATA/release"
elif [ "$(cat "$SRC/.git/redgiant-image" 2>/dev/null)" != "$VERSION" ]; then
  # A new image: its source arrives on branch "upstream" and is merged into the live code,
  # God's changes included. The supervisor builds it and rolls back if it does not come up.
  log "updating to RedGiant $VERSION"
  tmp=$(mktemp -d)
  git_ worktree add -q "$tmp" upstream
  find "$tmp" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  (cd "$APP" && tar --exclude=./node_modules --exclude='*/node_modules' -cf - .) | tar -xf - -C "$tmp"
  git -c user.name=RedGiant -c user.email=redgiant@localhost -C "$tmp" add -A
  git -c user.name=RedGiant -c user.email=redgiant@localhost -C "$tmp" commit -q -m "RedGiant $VERSION" || true
  git_ worktree remove --force "$tmp"
  if git_ merge -q --no-edit -m "Update to RedGiant $VERSION" upstream; then
    echo "$VERSION" > "$SRC/.git/redgiant-image"
  else
    git_ merge --abort || true
    log "WARNING: RedGiant $VERSION conflicts with changes made here; still running the current code. Ask God to merge branch 'upstream'."
  fi
  chown -R node:node "$SRC"
fi

# The server runs as "node"; it may use the Docker socket (sandboxes) when one is mounted.
chown node:node "$DATA"
for d in workspaces platform release; do mkdir -p "$DATA/$d" && chown node:node "$DATA/$d"; done
# Model files (downloaded by the setup wizard) and saved KV caches, when their volumes are mounted.
for d in "${REDGIANT_MODELS_DIR:-}" "${REDGIANT_KV_DIR:-}"; do
  if [ -n "$d" ] && [ -d "$d" ]; then chown node:node "$d"; fi
done
if [ -S /var/run/docker.sock ]; then
  groups=(--groups "$(stat -c %g /var/run/docker.sock)")
else
  groups=(--init-groups)
fi

cd "$SRC"
exec setpriv --reuid=node --regid=node "${groups[@]}" \
  env HOME=/home/node REDGIANT_SOURCE_DIR="$SRC" REDGIANT_STATE_DIR="$DATA/release" \
  node "$APP/packages/supervisor/dist/main.js"

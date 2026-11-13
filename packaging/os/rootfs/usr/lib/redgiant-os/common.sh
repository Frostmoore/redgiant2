# RedGiant OS (G39.1): what the OS's own scripts share. Sourced, never run.
# shellcheck shell=bash

# Everything RedGiant keeps on this machine: Docker's data-root (images and the RedGiant volumes),
# the stack's settings and the disks mounted for backups. Mount a bigger disk here to move it all.
STATE=/var/lib/redgiant
SHARE=/usr/share/redgiant-os
STACK_DIR=$STATE/stack
# Disks the OS helper mounts for backups (redgiant-helper), seen at the same path in the container.
BACKUPS=$STATE/backups
# The one-time code of the first start (G39.3), written by the server into its data volume.
SETUP_CODE=$STATE/docker/volumes/redgiant-data/_data/setup-code.txt
PORT=7600
# Overridable in /etc/redgiant-os/os.conf (the repository whose releases update this machine).
REPO=Frostmoore/redgiant2
# shellcheck disable=SC1091
[ -r /etc/redgiant-os/os.conf ] && . /etc/redgiant-os/os.conf

arch() { case $(uname -m) in aarch64 | arm64) echo arm64 ;; *) echo amd64 ;; esac; }

log() { echo "redgiant-os: $*" >&2; }

# x.y.z comparison: prints -1, 0 or 1.
vercmp() {
  awk -v a="${1#v}" -v b="${2#v}" 'BEGIN {
    n = split(a, x, "."); m = split(b, y, "."); k = n > m ? n : m
    for (i = 1; i <= k; i++) { p = x[i] + 0; q = y[i] + 0; if (p != q) { print (p < q ? -1 : 1); exit } }
    print 0 }'
}

# The stack in use: the one an update applied when it is newer than the one built in.
current_stack() {
  local built=$SHARE/stack.json applied=$STATE/stack.json
  if [ -r "$applied" ] && [ "$(vercmp "$(jq -r .version "$applied")" "$(jq -r .version "$built")")" -ge 0 ]; then
    echo "$applied"
  else
    echo "$built"
  fi
}

installed_version() { jq -r .version "$(current_stack)"; }

compose() {
  docker compose --project-directory "$STACK_DIR" --project-name redgiant \
    -f "$STACK_DIR/compose.yaml" -f "$SHARE/compose.os.yaml" "$@"
}

env_value() { grep "^$1=" "$STATE/stack.env" 2>/dev/null | head -1 | cut -d= -f2-; }

healthy() { curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; }

# The machine's addresses, IPv4 first, without loopback, Docker's bridges or link-local ones.
addresses() {
  ip -o -4 addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth)/ { split($4, a, "/"); print a[1] }'
  ip -o -6 addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth)/ { split($4, a, "/"); print "[" a[1] "]" }'
}

# The name avahi publishes (redgiant.local, or redgiant-2.local when another machine has it).
mdns_name() {
  local n
  n=$(avahi-resolve -a "$(addresses | head -1)" 2>/dev/null | awk '{ print $2 }')
  n=${n:-$(hostname)}
  case "$n" in *.local) ;; *) n=$n.local ;; esac
  echo "$n"
}

# The login prompts' text (/etc/issue.d/50-redgiant.issue): the real addresses, never Docker's
# bridges (agetty's own \4 may pick one). Prompts already shown are redrawn when it changes.
write_issue() {
  local f=/etc/issue.d/50-redgiant.issue new a
  new=$(
    printf 'RedGiant: http://%s:%s\n' "$(mdns_name)" "$PORT"
    for a in $(addresses); do printf 'RedGiant: http://%s:%s\n' "$a" "$PORT"; done
    echo
  )
  [ "$new" = "$(cat "$f" 2>/dev/null)" ] && return 0
  printf '%s\n' "$new" >"$f.new" && mv "$f.new" "$f"
  agetty --reload 2>/dev/null || true
}

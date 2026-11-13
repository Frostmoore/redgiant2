#!/usr/bin/env bash
# RedGiant OS (G39.2): starts the container template in Incus on CI's runner (LXC, as Proxmox runs
# it: unprivileged, nesting for Docker) and checks it: systemd up, RedGiant answering, the self-test
# (redgiant-selftest) inside the container, /api/health from the host on the container's address.
#
#   sudo lxc-test.sh --template <redgiant-os-…-lxc.tar.zst> --logs <dir> [--timeout <s>]
#
# Every wait has its limit; on a failure the container's journal and log are printed.
set -uo pipefail
TEMPLATE="" LOGS=. TIMEOUT=1800 NAME=rg-lxc-test
while [ $# -gt 0 ]; do
  case "$1" in
    --template) TEMPLATE=$2 && shift ;;
    --logs) LOGS=$2 && shift ;;
    --timeout) TIMEOUT=$2 && shift ;;
    *) echo "unknown option $1" >&2 && exit 2 ;;
  esac
  shift
done
[ -r "$TEMPLATE" ] || { echo "no template" >&2; exit 2; }
mkdir -p "$LOGS"
LOG=$LOGS/lxc-journal.log
in_ct() { timeout "${T:-60}" incus exec "$NAME" -- "$@"; }
dump() {
  echo "--- the container's journal (last 250 lines, also in $LOG)"
  T=60 in_ct journalctl -b --no-pager -n 600 2>&1 | sed 's/\r$//' >"$LOG"
  tail -n 250 "$LOG"
  echo "--- units that failed"
  T=30 in_ct systemctl --failed --no-pager 2>&1
  T=30 in_ct docker ps -a 2>&1
  timeout 30 incus info --show-log "$NAME" 2>&1 | tail -n 40
}
fail() {
  echo "::error::$*"
  dump
  exit 1
}
start=$SECONDS
work=$(mktemp -d)
cat >"$work/metadata.yaml" <<EOF
architecture: $(uname -m)
creation_date: $(date +%s)
properties:
  description: RedGiant OS (CI)
  os: debian
  release: trixie
EOF
tar -C "$work" -czf "$work/metadata.tar.gz" metadata.yaml
timeout 900 incus image import "$work/metadata.tar.gz" "$TEMPLATE" --alias redgiant-os-ci ||
  fail "incus could not import the template"
echo "imported after $((SECONDS - start)) s"
timeout 600 incus launch redgiant-os-ci "$NAME" -c security.nesting=true \
  -c security.syscalls.intercept.mknod=true -c security.syscalls.intercept.setxattr=true ||
  fail "the container did not start"

wait_until() { # what seconds command…: true once the command succeeds
  local what=$1 deadline=$((SECONDS + $2))
  shift 2
  while [ $SECONDS -lt $deadline ]; do
    "$@" >/dev/null 2>&1 && { echo "$what after $((SECONDS - start)) s"; return 0; }
    sleep 5
  done
  return 1
}
# systemd answers (it stays "starting" while redgiant.service loads the images the first time).
running() { T=15 in_ct systemctl is-system-running 2>/dev/null | grep -qE '^(starting|running|degraded)'; }
healthy() { T=15 in_ct curl -fsS --max-time 5 http://127.0.0.1:7600/api/health; }
wait_until "systemd up" 300 running || fail "systemd did not come up within 300 s"
wait_until "RedGiant answering" "$TIMEOUT" healthy || fail "RedGiant did not answer within $TIMEOUT s"

ok=1
T=900 in_ct /usr/lib/redgiant-os/redgiant-selftest >/dev/null 2>&1
T=30 in_ct cat /run/redgiant-selftest.log | sed 's/\r$//'
T=30 in_ct grep -q "REDGIANT-SELFTEST PASS" /run/redgiant-selftest.log || { echo "::error::the self-test failed"; ok=0; }
addr=$(T=15 in_ct ip -4 -o addr show dev eth0 scope global | awk '{ split($4, a, "/"); print a[1]; exit }')
echo "address: ${addr:-none}"
if [ -n "$addr" ] && curl -fsS --max-time 10 "http://$addr:7600/api/health"; then echo; else echo "::error::/api/health not reachable from the host"; ok=0; fi
# The container's own touches: no disk to grow, its network file, no kernel.
[ "$(T=15 in_ct systemctl is-enabled redgiant-growroot.service 2>/dev/null)" = masked ] || { echo "::error::growroot is not masked"; ok=0; }
T=15 in_ct test ! -e /vmlinuz || { echo "::error::a kernel in the container"; ok=0; }
[ "$ok" = 1 ] || fail "the container's checks failed"
T=60 in_ct journalctl -b --no-pager -n 600 2>&1 | sed 's/\r$//' >"$LOG"
timeout 120 incus delete --force "$NAME" >/dev/null 2>&1 || true
echo "OK: the container template in $((SECONDS - start)) s"

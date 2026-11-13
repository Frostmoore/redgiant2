#!/usr/bin/env bash
# RedGiant OS on Proxmox VE (G39.2). Run it on the Proxmox host, as root, like the community helper
# scripts:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Frostmoore/redgiant2/main/packaging/os/proxmox/redgiant-proxmox.sh)"
#   bash redgiant-proxmox.sh --lxc --storage local-zfs --bridge vmbr1 --disk 64 --yes
#
# It downloads RedGiant OS from a release (the qcow2 for a virtual machine, the template for a
# container), checks the release's SHA256SUMS-os against its signature (RedGiant's update key, below)
# and the file against SHA256SUMS-os, creates the machine with sane defaults, starts it and prints
# its address. It never changes or removes a machine that exists: the id must be free.
#
#   --vm | --lxc            a virtual machine (default: q35, OVMF with Secure Boot, virtio, the guest
#                           agent) or a container (unprivileged, features nesting and keyctl for Docker)
#   --version <x.y.z>       the release (default: the latest)
#   --id <n>                the machine's id (default: the next free one)
#   --name <name>           default: redgiant
#   --storage <id>          where its disk goes (default: local-lvm, or the first storage that takes it)
#   --template-storage <id> container: where the template is kept (default: local, or the first)
#   --bridge <name>         default: vmbr0;  --vlan <tag>: a VLAN on it
#   --disk <GB>             default: 32 (the virtual machine's image is 32 GB: at least that)
#   --memory <MB>           default: 4096;  --cores <n>: default 2;  --cpu <type>: VM, default host
#   --release <tag>         a release by its tag (for example os-preview, a pre-release)
#   --from <dir>            the files already downloaded (SHA256SUMS-os, its .sig, the image): still checked
#   --backups <host dir>    container: a folder of the host (a mounted USB disk) for RedGiant's backups,
#                           bound at /var/lib/redgiant/backups/<name> (--backups-name; default: its name)
#   --no-start              create it, do not start it
#   --yes, -y               no questions (the defaults and the options given)
#   --dry-run               show what it would do, change nothing (the checks still run)
#   --repo <owner/name>, --key <pem>   another repository's releases and its update key
set -euo pipefail

REPO=Frostmoore/redgiant2
KIND=vm VERSION="" ID="" NAME=redgiant STORAGE="" TSTORAGE="" BRIDGE=vmbr0 VLAN="" DISK=32
MEMORY=4096 CORES=2 CPU=host FROM="" START=1 YES=0 DRY=0 KEY="" RELEASE="" BACKUPS="" BACKUPS_NAME=""
PORT=7600
SETUP_CODE=/var/lib/redgiant/docker/volumes/redgiant-data/_data/setup-code.txt
# The public half of RedGiant's update key (packages/server/src/release-key.ts): it signs every
# release's SHA256SUMS-os.
RELEASE_KEY='-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAmpVtgHyQOGFUMbOO+pc6
sZqcebFuyJ6MiEl4JT0dkiKS4dSY356lpcq7n2eGV97Ev1XcS0ulj9tD4NI+QjXn
d19l6kZ1CALz9SDpFtUJXQ+iXgOFepiBosdQM4IIANA8k073TNR0LciY33sOGlCM
xL1yKiJBf4j9pJpbrmGJf+7p/SMXnnx+LNz4gHAVn3lOoedcOU/8/Z3zsOuQE4nH
7ySI+fFwQ4iW4hqXmPXCNNVQPCU3N7S39xgzh2v5GdlKcBP00X0WD96NS1l4iapU
UGNukMPo5YN1Ihp5FC4wjTcMqMWDI9bNDUoLP9vEekMqNNEWMUEsXamDH4Cm3QDl
WHFR98PmrQZZPX8Rwzbz8c+2riP1O6K7zL9zGLboxwFpdMVFilx7ggYZDx+7R93q
OWg1a3mqCKuTEZlCCDgbR8Inyi4uCsjTjtUF5wpL+38ApRXIJt3hVuVcu3IukFji
sGbARheBFA8dRhrLDaHF1s1KhV1e4MW3cGIDZusf8WTHAgMBAAE=
-----END PUBLIC KEY-----'

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() {
  printf 'redgiant-proxmox: %s\n' "$*" >&2
  exit 1
}
usage() {
  sed -n '2,/^set -euo/p' "$0" 2>/dev/null | sed '$d; s/^# \{0,1\}//'
  exit "${1:-0}"
}
need() { if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --vm) KIND=vm ;;
    --lxc) KIND=lxc ;;
    --version) need "$@" && VERSION=${2#v} && shift ;;
    --id) need "$@" && ID=$2 && shift ;;
    --name) need "$@" && NAME=$2 && shift ;;
    --storage) need "$@" && STORAGE=$2 && shift ;;
    --template-storage) need "$@" && TSTORAGE=$2 && shift ;;
    --bridge) need "$@" && BRIDGE=$2 && shift ;;
    --vlan) need "$@" && VLAN=$2 && shift ;;
    --disk) need "$@" && DISK=$2 && shift ;;
    --memory) need "$@" && MEMORY=$2 && shift ;;
    --cores) need "$@" && CORES=$2 && shift ;;
    --cpu) need "$@" && CPU=$2 && shift ;;
    --from) need "$@" && FROM=$2 && shift ;;
    --release) need "$@" && RELEASE=$2 && shift ;;
    --backups) need "$@" && BACKUPS=$2 && shift ;;
    --backups-name) need "$@" && BACKUPS_NAME=$2 && shift ;;
    --no-start) START=0 ;;
    -y | --yes) YES=1 ;;
    --dry-run) DRY=1 ;;
    --repo) need "$@" && REPO=$2 && shift ;;
    --key) need "$@" && KEY=$2 && shift ;;
    -h | --help) usage 0 ;;
    *) die "unknown option $1 (--help lists them)" ;;
  esac
  shift
done

# Every change goes through run: printed first, skipped by --dry-run.
run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  [ "$DRY" = 1 ] || "$@"
}
number() { [[ $2 =~ ^[0-9]+$ ]] || die "$1: a number, not '$2'"; }
for v in DISK MEMORY CORES; do number "--${v,,}" "${!v}"; done
[ -z "$ID" ] || number --id "$ID"
[ -z "$VLAN" ] || number --vlan "$VLAN"
[[ $NAME =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]] || die "--name: letters, digits and '-' (a host name)"
[[ $BRIDGE =~ ^[A-Za-z0-9._-]+$ ]] || die "--bridge: not a bridge name: $BRIDGE"
[[ $CPU =~ ^[A-Za-z0-9._-]+$ ]] || die "--cpu: not a processor type: $CPU"
[[ $REPO =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "--repo: owner/name"
[ -z "$RELEASE" ] || [[ $RELEASE =~ ^[A-Za-z0-9._-]+$ ]] || die "--release: a release tag"
[ -z "$VERSION" ] || [[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--version: x.y.z"
[ "$KIND" = lxc ] || [ "$DISK" -ge 32 ] || die "--disk: the virtual machine's image is 32 GB, give 32 or more"
[ "$KIND" = vm ] || [ "$DISK" -ge 16 ] || die "--disk: 16 GB or more"
[ "$MEMORY" -ge 2048 ] || die "--memory: 2048 MB or more"
for c in pvesh pvesm curl openssl sha256sum base64; do
  command -v "$c" >/dev/null || die "$c is missing: run this on a Proxmox VE host"
done
command -v "$([ "$KIND" = vm ] && echo qm || echo pct)" >/dev/null || die "this is not a Proxmox VE host"
[ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || die "run it as root on the Proxmox host (or --dry-run)"

ask() { # variable question: the answer, the current value when empty (never asked with --yes)
  local answer
  [ "$YES" = 1 ] && return 0
  read -r -p "$2 [${!1}]: " answer </dev/tty || true
  [ -z "$answer" ] || printf -v "$1" '%s' "$answer"
}
interactive() { [ "$YES" = 0 ] && [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; }
interactive || YES=1

# The storages that take a content type, active ones, local-lvm (or local) first.
storages() { # content preferred
  pvesm status --content "$1" 2>/dev/null | awk 'NR > 1 && $3 == "active" { print $1 }' |
    awk -v p="$2" '$1 == p { print; next } { rest = rest $1 "\n" } END { printf "%s", rest }'
}
pick_storage() { # variable content preferred what
  local list
  list=$(storages "$2" "$3")
  [ -n "$list" ] || die "no active storage takes $4 (pvesm status --content $2)"
  [ -n "${!1}" ] || printf -v "$1" '%s' "$(head -1 <<<"$list")"
  if [ "$YES" = 0 ]; then
    echo "Storages for $4: $(tr '\n' ' ' <<<"$list")"
    ask "$1" "Storage for $4"
  fi
  grep -qxF "${!1}" <<<"$list" || die "storage '${!1}' does not take $4 (or is not active): $(tr '\n' ' ' <<<"$list")"
}

# A free id: Proxmox's next one, or the one given if no machine anywhere in the cluster has it.
free_id() {
  pvesh get /cluster/nextid --vmid "$1" >/dev/null 2>&1 || return 1
  ! ls /etc/pve/nodes/*/qemu-server/"$1".conf /etc/pve/nodes/*/lxc/"$1".conf >/dev/null 2>&1
}
if [ -z "$ID" ]; then
  ID=$(pvesh get /cluster/nextid 2>/dev/null) || die "pvesh get /cluster/nextid failed"
  number id "$ID"
fi
ask ID "Id of the new $([ "$KIND" = vm ] && echo "virtual machine" || echo container)"
number --id "$ID"
free_id "$ID" || die "id $ID is taken: nothing is changed (choose another with --id)"

if [ "$KIND" = vm ]; then
  pick_storage STORAGE images local-lvm "the disk"
else
  pick_storage STORAGE rootdir local-lvm "the container"
  pick_storage TSTORAGE vztmpl local "templates"
fi
ask BRIDGE "Network bridge"
[[ $BRIDGE =~ ^[A-Za-z0-9._-]+$ ]] || die "--bridge: not a bridge name: $BRIDGE"
ip -o link show "$BRIDGE" >/dev/null 2>&1 || die "no bridge $BRIDGE on this host (ip link)"
ask DISK "Disk size in GB"
number --disk "$DISK"
[ "$KIND" = lxc ] || [ "$DISK" -ge 32 ] || die "--disk: give 32 or more"

# The release and its files: SHA256SUMS-os first, checked against its signature, then the image.
if [ -n "$RELEASE" ]; then
  TAG=$RELEASE
elif [ -n "$VERSION" ]; then
  TAG=v$VERSION
elif [ -z "$FROM" ]; then
  latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") ||
    die "cannot reach github.com"
  TAG=${latest##*/}
fi
URL=https://github.com/$REPO/releases/download/${TAG:-}
WORK=$(mktemp -d "${TMPDIR:-/var/tmp}/redgiant-proxmox.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
fetch() { # name: into $WORK, from --from or the release (with a progress meter: speed and time left)
  if [ -n "$FROM" ]; then
    [ -r "$FROM/$1" ] || die "$FROM/$1 is missing"
    ln -s "$(cd "$FROM" && pwd)/$1" "$WORK/$1"
  else
    echo "Downloading $1"
    curl -fL --retry 3 --connect-timeout 20 -o "$WORK/$1" "$URL/$1" || die "download of $URL/$1 failed"
  fi
}
fetch SHA256SUMS-os
fetch SHA256SUMS-os.sig
if [ -n "$KEY" ]; then cp "$KEY" "$WORK/key.pem"; else printf '%s\n' "$RELEASE_KEY" >"$WORK/key.pem"; fi
base64 -d "$WORK/SHA256SUMS-os.sig" >"$WORK/sums.sig" 2>/dev/null || die "SHA256SUMS-os.sig is not a signature"
openssl dgst -sha256 -verify "$WORK/key.pem" -signature "$WORK/sums.sig" "$WORK/SHA256SUMS-os" >/dev/null 2>&1 ||
  die "SHA256SUMS-os is not signed by RedGiant's update key: nothing is changed"
echo "SHA256SUMS-os: signed by the update key"
SUFFIX=$([ "$KIND" = vm ] && echo "-x86_64.qcow2" || echo "-x86_64-lxc.tar.zst")
if [ -z "$VERSION" ]; then
  # The version the signed list carries (a pre-release's tag is not a version).
  VERSION=$(awk -v s="$SUFFIX" '{ f = $2; sub(/^\*/, "", f) } f ~ "^redgiant-os-[0-9]+\\.[0-9]+\\.[0-9]+" s "$" {
    sub(/^redgiant-os-/, "", f); sub(s "$", "", f); print f }' "$WORK/SHA256SUMS-os" | sort -V | tail -1)
fi
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "SHA256SUMS-os lists no redgiant-os-<version>$SUFFIX (a release without it?)"
FILE=redgiant-os-$VERSION$SUFFIX
want=$(awk -v f="$FILE" '$2 == f || $2 == "*" f { print $1 }' "$WORK/SHA256SUMS-os")
[[ $want =~ ^[0-9a-f]{64}$ ]] || die "SHA256SUMS-os does not list $FILE (a release without RedGiant OS?)"

# Backups on a disk of the host (a container cannot mount the host's USB disks): the host's
# folder bound into the container where RedGiant offers backup folders, owned by the container's
# user 1000 (the server's node user), which an unprivileged container maps to 101000 on the host.
BACKUPS_MP=""
if [ -n "$BACKUPS" ]; then
  [ "$KIND" = lxc ] || die "--backups: for a container (a VM gets the USB disk itself: qm set <id> -usb0 host=<vendor:product>)"
  [ -d "$BACKUPS" ] || die "--backups: $BACKUPS is not a folder on this host (mount the disk first)"
  BACKUPS=$(cd "$BACKUPS" && pwd)
  case "$BACKUPS" in / | /etc* | /usr* | /var/lib/vz | /root | /boot*) die "--backups: not a system folder" ;; esac
  BNAME=${BACKUPS_NAME:-$(basename "$BACKUPS")}
  [[ $BNAME =~ ^[A-Za-z0-9._-]+$ ]] || die "--backups-name: letters, digits, '.', '_' and '-'"
  BACKUPS_MP="$BACKUPS,mp=/var/lib/redgiant/backups/$BNAME,backup=0"
fi

summary() {
  say "RedGiant OS $VERSION on Proxmox"
  echo "  $([ "$KIND" = vm ] && echo "virtual machine" || echo "container (unprivileged)") $ID, $NAME"
  echo "  $CORES cores, $MEMORY MB of memory, a $DISK GB disk on $STORAGE, network $BRIDGE${VLAN:+ (VLAN $VLAN)}"
  [ "$KIND" = vm ] || echo "  template $FILE on $TSTORAGE"
  [ -z "$BACKUPS_MP" ] || echo "  backups: $BACKUPS (owned by 101000, the container's user 1000) at /var/lib/redgiant/backups/$BNAME"
  echo "  from ${FROM:-$URL}"
}
summary
if [ "$YES" = 0 ]; then
  reply=y
  ask reply "Create it? (y/n)"
  [[ $reply =~ ^[yYsS] ]] || die "nothing done"
fi
checked() { [ -r "$1" ] && [ "$(sha256sum "$1" | cut -d' ' -f1)" = "$want" ]; }

if [ "$KIND" = lxc ]; then
  TEMPLATE=$TSTORAGE:vztmpl/$FILE
  tpath=$(pvesm path "$TEMPLATE") || die "pvesm path $TEMPLATE failed"
  if checked "$tpath"; then
    echo "$TEMPLATE: already there, checked"
  else
    fetch "$FILE"
    checked "$WORK/$FILE" || die "$FILE does not match SHA256SUMS-os: nothing is changed"
    echo "$FILE: checked"
    [ ! -e "$tpath" ] || die "$tpath exists and is not this release's template: move it away first"
    run install -D -m 0644 "$WORK/$FILE" "$tpath"
  fi
else
  fetch "$FILE"
  checked "$WORK/$FILE" || die "$FILE does not match SHA256SUMS-os: nothing is changed"
  echo "$FILE: checked"
fi

NOTE="RedGiant OS $VERSION. Open http://$NAME.local:$PORT (or the address its console shows). https://github.com/$REPO/blob/main/docs/INSTALL-OS.md"
NET="bridge=$BRIDGE${VLAN:+,tag=$VLAN}"
free_id "$ID" || die "id $ID was taken meanwhile: nothing is changed"
if [ "$KIND" = vm ]; then
  # UEFI with Secure Boot (Debian's shim, Microsoft's keys enrolled), virtio everywhere, the disk
  # imported from the image, a serial console beside the screen, the guest agent for the address.
  run qm create "$ID" --name "$NAME" --description "$NOTE" --tags redgiant --ostype l26 \
    --machine q35 --bios ovmf --efidisk0 "$STORAGE:1,efitype=4m,pre-enrolled-keys=1" \
    --cpu "$CPU" --cores "$CORES" --memory "$MEMORY" --balloon 0 \
    --scsihw virtio-scsi-single --scsi0 "$STORAGE:0,import-from=$WORK/$FILE,discard=on,ssd=1,iothread=1" \
    --boot order=scsi0 --net0 "virtio,$NET" --serial0 socket --vga std --agent enabled=1 --onboot 1
  [ "$DISK" -le 32 ] || run qm resize "$ID" scsi0 "${DISK}G"
  [ "$START" = 0 ] || run qm start "$ID"
else
  # Unprivileged; Docker inside needs nesting and keyctl. "unmanaged": Proxmox leaves the system's
  # own network (DHCP) and names alone.
  run pct create "$ID" "$TEMPLATE" --hostname "$NAME" --description "$NOTE" --tags redgiant \
    --ostype unmanaged --arch amd64 --unprivileged 1 --features nesting=1,keyctl=1 \
    --cores "$CORES" --memory "$MEMORY" --swap 512 --rootfs "$STORAGE:$DISK" \
    --net0 "name=eth0,$NET,ip=dhcp,ip6=auto" --cmode tty --tty 2 --onboot 1
  if [ -n "$BACKUPS_MP" ]; then
    [ "$(stat -c %u "$BACKUPS")" = 101000 ] || run chown 101000:101000 "$BACKUPS"
    run pct set "$ID" -mp0 "$BACKUPS_MP"
  fi
  [ "$START" = 0 ] || run pct start "$ID"
fi
if [ "$DRY" = 1 ] || [ "$START" = 0 ]; then
  say "Done$([ "$DRY" = 1 ] && echo " (dry run: nothing changed)")."
  exit 0
fi

# The address: from the container, or from the virtual machine's guest agent.
first_ipv4() { # JSON of the guest agent's network-get-interfaces → the first real IPv4
  perl -MJSON::PP -e 'my $d = decode_json(join "", <STDIN>); $d = $d->{result} if ref $d eq "HASH";
    for my $i (@$d) { next if $i->{name} =~ /^(lo|docker|br-|veth)/;
      for my $a (@{ $i->{"ip-addresses"} || [] }) {
        if ($a->{"ip-address-type"} eq "ipv4") { print $a->{"ip-address"}, "\n"; exit } } }'
}
address() {
  if [ "$KIND" = vm ]; then
    qm guest cmd "$ID" network-get-interfaces 2>/dev/null | first_ipv4 2>/dev/null
  else
    pct exec "$ID" -- ip -4 -o addr show dev eth0 scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1]; exit }'
  fi
}
setup_code() {
  if [ "$KIND" = vm ]; then
    qm guest exec "$ID" -- cat "$SETUP_CODE" 2>/dev/null |
      perl -MJSON::PP -e 'my $d = decode_json(join "", <STDIN>); print $d->{"out-data"} // ""' 2>/dev/null
  else
    pct exec "$ID" -- cat "$SETUP_CODE" 2>/dev/null
  fi | head -c 64 | tr -cd 'A-Za-z0-9 -'
}
echo "Waiting for the address (the first start takes a few minutes)"
ADDR=""
for _ in $(seq 1 60); do
  ADDR=$(address || true)
  [ -n "$ADDR" ] && break
  sleep 5
done
[ -n "$ADDR" ] || {
  say "Started. The address is on the console: Proxmox, $ID, Console."
  exit 0
}
echo "Address $ADDR; waiting for RedGiant (it loads its images the first time)"
up=0
for _ in $(seq 1 240); do
  curl -fsS --max-time 5 "http://$ADDR:$PORT/api/health" >/dev/null 2>&1 && up=1 && break
  sleep 5
done
code=$(setup_code || true)
say "RedGiant OS $VERSION: http://$ADDR:$PORT  (also http://$NAME.local:$PORT)"
[ "$up" = 1 ] || echo "  RedGiant does not answer yet: give it a few more minutes, the console says when it does."
[ -z "$code" ] || echo "  The first start asks for this code: $code"
[ -z "$BACKUPS_MP" ] || echo "  Backups: in RedGiant, Settings, backups, choose the folder /var/lib/redgiant/backups/$BNAME"

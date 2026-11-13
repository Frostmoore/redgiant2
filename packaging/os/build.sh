#!/usr/bin/env bash
# RedGiant OS (G39.1, G39.2): builds the images from Debian 13 in the builder container
# (builder.Dockerfile). Every format starts from the same disk image:
#
#   build.sh --arch amd64|arm64 --stack <redgiant-os-stack.json> --out <dir>
#            [--formats qcow2,raw,iso] [--os-version x.y.z] [--no-preload] [--mirror <url>]
#            [--board generic|lxc|raspi]
#
#   <dir>/redgiant-os-<ver>-<arch>.qcow2      Proxmox, KVM, UTM, clouds (fills its disk at start)
#   <dir>/redgiant-os-<ver>-<arch>.raw.zst    the disk itself (what the installer writes)
#   <dir>/redgiant-os-<ver>-x86_64.iso        installer for a USB stick (amd64 only)
#   <dir>/redgiant-os-<ver>-x86_64.vhdx.zip   Hyper-V, generation 2 (format vhdx)
#   <dir>/redgiant-os-<ver>-x86_64.ova        VirtualBox, VMware (format ova)
#   --board lxc:   <dir>/redgiant-os-<ver>-<arch>-lxc.tar.zst   container template (Proxmox, LXC, Incus)
#   --board raspi: <dir>/redgiant-os-<ver>-arm64-raspi.img.xz   Raspberry Pi 4 (SD card or USB disk)
#
# Tools (all Debian's): mmdebstrap for the system, mkfs.ext4 -d, mtools and systemd-repart --offline for the disk (no loop
# devices), GRUB with Debian's signed shim for UEFI (Secure Boot included) and GRUB for BIOS on
# x86_64. The kernel, initramfs and GRUB are Debian's usual ones, so apt updates them as on any
# Debian. Reproducible from the same Debian snapshot (--mirror http://snapshot.debian.org/…) and
# SOURCE_DATE_EPOCH (the commit's time). More formats: add a function format_<name> below.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$HERE/../.." && pwd)
ARCH="" STACK="" OUT="" FORMATS="" OS_VERSION="" PRELOAD=1 BOARD=generic
MIRROR=${MIRROR:-http://deb.debian.org/debian}
SECURITY_MIRROR=${SECURITY_MIRROR:-http://deb.debian.org/debian-security}
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH=$2 && shift ;;
    --stack) STACK=$2 && shift ;;
    --out) OUT=$2 && shift ;;
    --formats) FORMATS=$2 && shift ;;
    --os-version) OS_VERSION=$2 && shift ;;
    --no-preload) PRELOAD=0 ;;
    --mirror) MIRROR=$2 && shift ;;
    --board) BOARD=$2 && shift ;;
    *) echo "unknown option $1" >&2 && exit 2 ;;
  esac
  shift
done
[ -n "$ARCH" ] && [ -r "$STACK" ] && [ -n "$OUT" ] || {
  echo "usage: build.sh --arch amd64|arm64 --stack <stack.json> --out <dir> [--formats qcow2,raw,iso]" >&2
  exit 2
}
case "$BOARD" in
  generic) FORMATS=${FORMATS:-qcow2,raw,iso} ;;
  lxc) FORMATS=${FORMATS:-lxc} ;;
  raspi)
    FORMATS=${FORMATS:-raspi}
    [ "$ARCH" = arm64 ] || { echo "raspi: arm64 only" >&2 && exit 2; }
    ;;
  *) echo "board: generic, lxc or raspi" >&2 && exit 2 ;;
esac
VERSION=$(jq -r .version "$STACK")
OS_VERSION=${OS_VERSION:-$VERSION}
export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git -C "$REPO_ROOT" log -1 --format=%ct 2>/dev/null || date +%s)}
case "$ARCH" in
  amd64) KARCH=x86_64 SDARCH=x86-64 EFI=x64 EFIUP=X64 GRUB_EFI=x86_64-efi CONSOLE="console=tty0 console=ttyS0,115200" ;;
  arm64) KARCH=arm64 SDARCH=arm64 EFI=aa64 EFIUP=AA64 GRUB_EFI=arm64-efi CONSOLE="console=tty0 console=ttyAMA0,115200" ;;
  *) echo "arch: amd64 or arm64" >&2 && exit 2 ;;
esac
NAME=redgiant-os-$OS_VERSION-$KARCH
WORK=$OUT/work-$ARCH$([ "$BOARD" = generic ] || echo "-$BOARD")
ROOT=$WORK/rootfs
mkdir -p "$OUT"
rm -rf "$WORK"
mkdir -p "$WORK"
step() { printf '\n== %s\n' "$*"; }

# Fixed for this build (the same inputs give the same ids): the disk's partitions and the file
# GRUB looks for to find the system.
uuid() { python3 -c "import uuid,sys; print(uuid.uuid5(uuid.NAMESPACE_URL, sys.argv[1]))" "redgiant-os/$OS_VERSION/$ARCH/$SOURCE_DATE_EPOCH/$1"; }
ROOT_UUID=$(uuid root)
ESP_UUID=$(uuid esp)
DISK_ID=$(uuid disk)

# 1. The system ----------------------------------------------------------------------------------
# Wi-Fi: iwd (with systemd-networkd for addresses) and the firmware of the usual cards, from
# Debian's non-free-firmware section: Intel, Realtek, Qualcomm Atheros, Broadcom (Raspberry Pi
# and many laptops) and the rest of firmware-misc-nonfree (MediaTek, Ralink…). Everything in that
# section is redistributable (Debian ships it on its own installer images since Debian 12).
# Caddy (Debian's) serves https://redgiant.local with the machine's local certificate authority.
PACKAGES=(
  systemd systemd-sysv systemd-resolved udev dbus kmod iproute2 iputils-ping netbase
  ca-certificates curl jq socat openssl qrencode less vim-tiny sudo tzdata
  avahi-daemon avahi-utils libnss-mdns
  docker.io docker-cli docker-compose
  openssh-server unattended-upgrades
  cloud-guest-utils gdisk fdisk parted e2fsprogs dosfstools exfatprogs pciutils usbutils
  initramfs-tools zstd linux-image-"$ARCH" firmware-linux-free firmware-realtek
  iwd wireless-regdb rfkill firmware-iwlwifi firmware-atheros firmware-brcm80211 firmware-misc-nonfree
  caddy
  grub2-common grub-efi-"$ARCH"-bin grub-efi-"$ARCH"-signed shim-signed
)
[ "$ARCH" = amd64 ] && PACKAGES+=(grub-pc-bin intel-microcode amd64-microcode)
# The boards (G39.2): a container has no kernel nor boot loader; a Raspberry Pi starts from its
# own firmware (Debian's raspi-firmware), not GRUB. The guest agent tells Proxmox the address.
case "$BOARD" in
  generic) PACKAGES+=(qemu-guest-agent) ;;
  lxc | raspi)
    keep=()
    for p in "${PACKAGES[@]}"; do
      case "$p" in
        grub* | shim-signed | *-microcode) ;;
        linux-image-* | initramfs-tools | firmware-* | cloud-guest-utils) [ "$BOARD" = lxc ] || keep+=("$p") ;;
        *) keep+=("$p") ;;
      esac
    done
    PACKAGES=("${keep[@]}")
    [ "$BOARD" = raspi ] && PACKAGES+=(raspi-firmware firmware-brcm80211 wireless-regdb)
    ;;
esac
step "Debian 13 for $ARCH (mmdebstrap, $MIRROR)"
# What goes over Debian: packaging/os/rootfs and the OS helper (G39.3, whose protocol is the
# server's: packages/server/src/os-helper.ts).
OVERLAY=$WORK/overlay
mkdir -p "$OVERLAY"
cp -a "$HERE/rootfs/." "$OVERLAY/"
install -D -m 0755 "$REPO_ROOT/packages/server/helpers/redgiant-helper" "$OVERLAY/usr/lib/redgiant/redgiant-helper"
mmdebstrap --variant=apt --architectures="$ARCH" --components="main non-free-firmware" \
  --include="$(IFS=,; echo "${PACKAGES[*]}")" \
  --customize-hook="sync-in $OVERLAY /" \
  --customize-hook="copy-in $HERE/setup-chroot.sh /tmp" \
  --customize-hook='chroot "$1" sh /tmp/setup-chroot.sh' \
  trixie "$ROOT" \
  "deb $MIRROR trixie main non-free-firmware" \
  "deb $MIRROR trixie-updates main non-free-firmware" \
  "deb $SECURITY_MIRROR trixie-security main non-free-firmware"

step "RedGiant $VERSION in the system"
SHARE=$ROOT/usr/share/redgiant-os
install -d "$SHARE"
install -m 0644 "$STACK" "$SHARE/stack.json"
install -m 0644 "$HERE/compose.os.yaml" "$SHARE/compose.os.yaml"
echo "$OS_VERSION" >"$SHARE/os-version"
# The public half of the update key (the same as the server's): checks what an update brings.
sed -n '/BEGIN PUBLIC KEY/,/END PUBLIC KEY/p' "$REPO_ROOT/packages/server/src/release-key.ts" |
  sed 's/^.*\(-----BEGIN\)/\1/; s/\(KEY-----\).*$/\1/' >"$SHARE/release-key.pem"
grep -q "END PUBLIC KEY" "$SHARE/release-key.pem" || : >"$SHARE/release-key.pem"
ln -sf ../run/systemd/resolve/stub-resolv.conf "$ROOT/etc/resolv.conf"
install -d "$ROOT/etc/redgiant-os"
echo "RedGiant OS $OS_VERSION" >"$ROOT/etc/redgiant-os/disk-$DISK_ID"
cat >"$ROOT/etc/fstab" <<EOF
# RedGiant OS: the system and its EFI partition (the data lives in /var/lib/redgiant).
PARTUUID=$ROOT_UUID  /          ext4  errors=remount-ro  0 1
PARTUUID=$ESP_UUID   /boot/efi  vfat  umask=0077,nofail  0 2
EOF
cat >"$ROOT/etc/default/grub" <<EOF
# RedGiant OS: Debian's update-grub reads this when a new kernel comes.
GRUB_DEFAULT=0
GRUB_TIMEOUT=3
GRUB_DISTRIBUTOR="RedGiant OS"
GRUB_CMDLINE_LINUX_DEFAULT=""
GRUB_CMDLINE_LINUX="$CONSOLE"
GRUB_DISABLE_OS_PROBER=true
GRUB_DISABLE_RECOVERY=true
EOF

if [ "$PRELOAD" = 1 ]; then
  step "The images of the stack, built in (first start without a download)"
  install -d -m 0700 "$ROOT/var/lib/redgiant/preload"
  jq -r --arg a "$ARCH" '.images[$a][] | [.ref, .digest, .id] | @tsv' "$STACK" |
    while IFS=$'\t' read -r ref digest id; do
      tar="$ROOT/var/lib/redgiant/preload/$(echo "$ref" | tr '/:' '__').tar"
      skopeo copy --quiet --retry-times 3 "docker://${ref%:*}@$digest" "docker-archive:$tar:$ref"
      # Docker gives a loaded image the id of its config: it must be the pinned one.
      config=$(tar -xOf "$tar" manifest.json | jq -r '.[0].Config' | sed 's#^blobs/sha256/##; s#\.json$##')
      [ "sha256:$config" = "$id" ] || { echo "$ref: config $config is not the pinned $id" >&2; exit 1; }
      echo "$ref $(du -h "$tar" | cut -f1)"
    done
fi

# Fails the build when the initramfs cannot reach a machine's disk and network.
initrd_has() { # module… (a module built into the kernel counts; - and _ are the same)
  local list m re
  list=$(chroot "$ROOT" lsinitramfs /initrd.img; cat "$ROOT"/usr/lib/modules/*/modules.builtin)
  for m in "$@"; do
    re=${m//[-_]/[-_]}
    grep -qE "/$re\.ko(\.[a-z]+)?$" <<<"$list" || { echo "the initramfs has no $m" >&2; exit 1; }
  done
  echo "initramfs: $*"
}

# The other boards make their own files from the system (packaging/os/<board>/<board>.sh).
if [ "$BOARD" != generic ]; then
  # shellcheck source=/dev/null
  . "$HERE/$BOARD/$BOARD.sh"
  for f in ${FORMATS//,/ }; do "format_$f"; done
  step "Done"
  ls -la "$OUT"
  exit 0
fi

# 2. Boot ----------------------------------------------------------------------------------------
step "Boot: GRUB (UEFI with Debian's signed shim$([ "$ARCH" = amd64 ] && echo ", and BIOS"))"
FIND="search --no-floppy --file --set=root /etc/redgiant-os/disk-$DISK_ID"
install -d "$ROOT/boot/grub"
cat >"$ROOT/boot/grub/grub.cfg" <<EOF
# RedGiant OS: replaced by Debian's update-grub when a new kernel comes.
set default=0
set timeout=3
menuentry 'RedGiant OS' {
  $FIND
  linux /vmlinuz root=PARTUUID=$ROOT_UUID ro $CONSOLE
  initrd /initrd.img
}
EOF
[ -e "$ROOT/vmlinuz" ] && [ -e "$ROOT/initrd.img" ] || { echo "no /vmlinuz or /initrd.img" >&2; exit 1; }
# The EFI partition's files, beside the system (mounted at /boot/efi once installed).
ESP=$WORK/esp
install -d "$ROOT/boot/efi"
install -d "$ESP/EFI/BOOT" "$ESP/EFI/debian"
for dir in BOOT debian; do
  cp "$ROOT/usr/lib/shim/shim$EFI.efi.signed" "$ESP/EFI/$dir/shim$EFI.efi"
  cp "$ROOT/usr/lib/shim/mm$EFI.efi.signed" "$ESP/EFI/$dir/mm$EFI.efi"
  cp "$ROOT/usr/lib/grub/$GRUB_EFI-signed/grub$EFI.efi.signed" "$ESP/EFI/$dir/grub$EFI.efi"
  # What it finds goes to the console too (a serial console shows why a machine does not start).
  printf 'echo "RedGiant OS: looking for the system (%s)"\n%s\necho "RedGiant OS: system on $root"\nset prefix=($root)/boot/grub\nconfigfile $prefix/grub.cfg\necho "RedGiant OS: no system disk found"\nls\n' "$DISK_ID" "$FIND" >"$ESP/EFI/$dir/grub.cfg"
done
# Wi-Fi without a screen: the example to copy as redgiant-wifi.txt (redgiant-wifi-file).
cp "$HERE/rootfs/usr/share/redgiant-os/redgiant-wifi-example.txt" "$ESP/redgiant-wifi-example.txt"
# The removable path: what any firmware starts without a boot entry of its own.
mv "$ESP/EFI/BOOT/shim$EFI.efi" "$ESP/EFI/BOOT/BOOT$EFIUP.EFI"
if [ "$ARCH" = amd64 ]; then
  cp -r "$ROOT/usr/lib/grub/i386-pc" "$ROOT/boot/grub/"
fi

# 3. The disk ------------------------------------------------------------------------------------
step "The disk: ext4 and FAT made from their folders, placed by systemd-repart (offline)"
# The two filesystems are made here (mkfs -d, mtools), not by repart's CopyFiles: repart leaves out
# of the root whatever an ESP would be mounted over (/boot, with the kernel), and no loop device
# is needed either way.
ROOTIMG=$WORK/root.ext4
ESPIMG=$WORK/esp.vfat
used=$(du -sxb "$ROOT" | cut -f1)
# Room for ext4's own structures and a little free space; the system grows into its disk at start.
size=$(((used + used / 8 + 400 * 1048576) / 1048576))
rm -f "$ROOTIMG" "$ESPIMG"
truncate -s "${size}M" "$ROOTIMG"
mkfs.ext4 -q -F -L redgiant-root -U "$ROOT_UUID" -E root_owner=0:0 -d "$ROOT" "$ROOTIMG"
truncate -s 512M "$ESPIMG"
mkfs.vfat -F 32 -n ESP "$ESPIMG" >/dev/null
mcopy -s -i "$ESPIMG" "$ESP"/* ::/
mdir -/ -i "$ESPIMG" ::/EFI | grep -iE "efi|cfg" || true
DEFS=$WORK/repart.d
mkdir -p "$DEFS"
if [ "$ARCH" = amd64 ]; then
  printf '[Partition]\nType=21686148-6449-6e6f-744e-656564454649\nLabel=bios\nSizeMinBytes=1M\nSizeMaxBytes=1M\n' >"$DEFS/00-bios.conf"
fi
printf '[Partition]\nType=esp\nLabel=esp\nUUID=%s\nCopyBlocks=%s\n' "$ESP_UUID" "$ESPIMG" >"$DEFS/10-esp.conf"
printf '[Partition]\nType=root\nLabel=redgiant-root\nUUID=%s\nCopyBlocks=%s\n' "$ROOT_UUID" "$ROOTIMG" >"$DEFS/20-root.conf"
RAW=$WORK/$NAME.raw
rm -f "$RAW"
systemd-repart --offline=yes --empty=create --size=auto --dry-run=no --no-pager \
  --architecture="$SDARCH" --seed="$DISK_ID" --definitions="$DEFS" "$RAW"
rm -f "$ROOTIMG" "$ESPIMG"
sfdisk -d "$RAW"

if [ "$ARCH" = amd64 ]; then
  step "BIOS: GRUB in the BIOS boot partition"
  G=$WORK/grub-pc
  mkdir -p "$G"
  printf '%s\nset prefix=($root)/boot/grub\n' "$FIND" >"$G/early.cfg"
  grub-mkimage -O i386-pc -d "$ROOT/usr/lib/grub/i386-pc" -c "$G/early.cfg" -p /boot/grub \
    -o "$G/core.img" biosdisk part_gpt part_msdos ext2 search search_fs_file configfile normal \
    linux echo test gzio
  cp "$ROOT/usr/lib/grub/i386-pc/boot.img" "$G/"
  # grub-bios-setup asks /proc/self/mountinfo which device holds its directory: it is told the
  # image (as mkosi does), so it embeds itself in the BIOS boot partition with no loop device.
  # The file is the shell's own (/proc/<pid>), and exec keeps that pid for grub-bios-setup.
  echo "1 0 1:1 / / - ext4 $RAW rw" >"$G/mountinfo"
  unshare --mount --propagation unchanged bash -c "mount --bind '$G/mountinfo' /proc/\$\$/mountinfo && exec /usr/lib/grub/i386-pc/grub-bios-setup --directory '$G' '$RAW'"
fi

# 4. Formats -------------------------------------------------------------------------------------
format_raw() {
  step "raw.zst"
  zstd -q -T0 -19 --long=27 -f "$RAW" -o "$OUT/$NAME.raw.zst"
  stat -c %s "$RAW" >"$OUT/$NAME.raw.size"
}
format_qcow2() {
  step "qcow2"
  qemu-img convert -c -O qcow2 "$RAW" "$OUT/$NAME.qcow2"
  # A virtual disk of 32 GB (thin): the system fills it at the first start.
  qemu-img resize -q "$OUT/$NAME.qcow2" 32G
}
format_iso() {
  [ "$ARCH" = amd64 ] || { echo "iso: x86_64 only for now"; return 0; }
  [ -r "$OUT/$NAME.raw.zst" ] || format_raw
  "$HERE/installer/build-iso.sh" --payload "$OUT/$NAME.raw.zst" --size "$(cat "$OUT/$NAME.raw.size")" \
    --version "$OS_VERSION" --efi-root "$ROOT" --mirror "$MIRROR" --security-mirror "$SECURITY_MIRROR" \
    --work "$WORK/iso" --out "$OUT/redgiant-os-$OS_VERSION-x86_64.iso"
}
# The raw disk seen as a thin 32 GB one, like the qcow2 (an overlay: nothing is copied).
grown() {
  [ -e "$WORK/grown.qcow2" ] || qemu-img create -q -f qcow2 -b "$RAW" -F raw "$WORK/grown.qcow2" 32G
  echo "$WORK/grown.qcow2"
}
format_vhdx() { # Hyper-V, generation 2 (UEFI; Secure Boot with the Microsoft UEFI CA template)
  [ "$ARCH" = amd64 ] || { echo "vhdx: x86_64 only"; return 0; }
  step "vhdx (Hyper-V), zipped"
  initrd_has hv_vmbus hv_storvsc hv_netvsc
  qemu-img convert -O vhdx -o subformat=dynamic "$(grown)" "$WORK/$NAME.vhdx"
  qemu-img info "$WORK/$NAME.vhdx" | sed -n '1,4p'
  python3 "$HERE/formats/vm.py" zip "$WORK/$NAME.vhdx" "$OUT/$NAME.vhdx.zip"
  rm -f "$WORK/$NAME.vhdx"
}
format_ova() { # VirtualBox and VMware: OVF, LSI Logic SCSI, E1000, a streamOptimized VMDK
  [ "$ARCH" = amd64 ] || { echo "ova: x86_64 only"; return 0; }
  step "ova (VirtualBox, VMware)"
  initrd_has mptspi e1000 ahci
  qemu-img convert -O vmdk -o subformat=streamOptimized,adapter_type=lsilogic "$(grown)" "$WORK/$NAME.vmdk"
  python3 "$HERE/formats/vm.py" ova --vmdk "$WORK/$NAME.vmdk" --name "$NAME" \
    --capacity "$(qemu-img info --output=json "$(grown)" | jq -r '."virtual-size"')" --out "$OUT/$NAME.ova"
  rm -f "$WORK/$NAME.vmdk"
  python3 "$HERE/formats/vm.py" check-ova "$OUT/$NAME.ova"
}
for f in ${FORMATS//,/ }; do "format_$f"; done
step "Done"
ls -la "$OUT"

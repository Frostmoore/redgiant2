#!/usr/bin/env bash
# RedGiant OS (G39.2): the installer ISO for x86_64, for a USB stick (dd, Rufus, Etcher…) or a
# virtual CD. A tiny Debian live system (live-boot) that runs redgiant-install, plus the system's
# disk image it writes. Boots with BIOS and UEFI, Secure Boot included (Debian's signed shim,
# GRUB and kernel). Called by build.sh; no loop device is used.
#   build-iso.sh --payload <raw.zst> --size <bytes> --version x.y.z --efi-root <system rootfs> \
#                --work <dir> --out <iso>
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
MIRROR=http://deb.debian.org/debian SECURITY_MIRROR=http://deb.debian.org/debian-security
while [ $# -gt 0 ]; do
  case "$1" in
    --payload) PAYLOAD=$2 && shift ;;
    --size) SIZE=$2 && shift ;;
    --version) VERSION=$2 && shift ;;
    --work) WORK=$2 && shift ;;
    --efi-root) EFI_ROOT=$2 && shift ;;
    --out) OUT=$2 && shift ;;
    --mirror) MIRROR=$2 && shift ;;
    --security-mirror) SECURITY_MIRROR=$2 && shift ;;
    *) echo "unknown option $1" >&2 && exit 2 ;;
  esac
  shift
done
LIVE=$WORK/live
ISO=$WORK/iso
rm -rf "$WORK"
mkdir -p "$ISO/live" "$ISO/redgiant" "$ISO/boot/grub" "$ISO/.disk" "$ISO/EFI/BOOT" "$ISO/EFI/debian"
CONSOLE="console=tty0 console=ttyS0,115200"

echo "== installer system (mmdebstrap)"
mmdebstrap --variant=apt --architectures=amd64 --components="main non-free-firmware" \
  --include=systemd,systemd-sysv,udev,kmod,live-boot,linux-image-amd64,initramfs-tools,zstd,pv,gdisk,parted,util-linux,firmware-linux-free,firmware-realtek \
  --customize-hook="sync-in $HERE/rootfs /" \
  --customize-hook='chroot "$1" sh -c "chmod 755 /usr/local/sbin/redgiant-install && systemctl enable redgiant-install.service && echo redgiant-installer >/etc/hostname && : >/etc/machine-id && apt-get clean && rm -rf /var/lib/apt/lists/*"' \
  trixie "$LIVE" \
  "deb $MIRROR trixie main non-free-firmware" \
  "deb $SECURITY_MIRROR trixie-security main non-free-firmware"

cp "$(readlink -f "$LIVE/vmlinuz")" "$ISO/live/vmlinuz"
cp "$(readlink -f "$LIVE/initrd.img")" "$ISO/live/initrd.img"
mksquashfs "$LIVE" "$ISO/live/filesystem.squashfs" -comp zstd -noappend -quiet \
  -e boot -wildcards -e 'usr/share/doc/*' -e 'usr/share/man/*'
cp "$PAYLOAD" "$ISO/redgiant/"
echo "$SIZE" >"$ISO/redgiant/$(basename "${PAYLOAD%.zst}").size"
(cd "$ISO/redgiant" && sha256sum ./*.zst >SHA256SUMS)
# Debian's signed GRUB finds the medium by this file, then reads /boot/grub/grub.cfg.
echo "RedGiant OS $VERSION installer" >"$ISO/.disk/info"

cat >"$ISO/boot/grub/grub.cfg" <<EOF
set default=0
set timeout=5
menuentry 'Install RedGiant OS $VERSION (erases the disk you choose)' {
  linux /live/vmlinuz boot=live quiet $CONSOLE
  initrd /live/initrd.img
}
menuentry 'Restart' { reboot }
EOF

echo "== UEFI: shim, signed GRUB (efi.img), from the system just built"
cp "$EFI_ROOT/usr/lib/shim/shimx64.efi.signed" "$ISO/EFI/BOOT/BOOTX64.EFI"
cp "$EFI_ROOT/usr/lib/shim/mmx64.efi.signed" "$ISO/EFI/BOOT/mmx64.efi"
cp "$EFI_ROOT/usr/lib/grub/x86_64-efi-signed/grubx64.efi.signed" "$ISO/EFI/BOOT/grubx64.efi"
printf 'search --no-floppy --file --set=root /.disk/info\nset prefix=($root)/boot/grub\nconfigfile $prefix/grub.cfg\n' |
  tee "$ISO/EFI/BOOT/grub.cfg" >"$ISO/EFI/debian/grub.cfg"
EFIIMG=$ISO/boot/grub/efi.img
rm -f "$EFIIMG"
mkfs.vfat -C -n REDGIANT_EFI "$EFIIMG" 8192 >/dev/null
mmd -i "$EFIIMG" ::/EFI ::/EFI/BOOT ::/EFI/debian
mcopy -i "$EFIIMG" "$ISO"/EFI/BOOT/* ::/EFI/BOOT/
mcopy -i "$EFIIMG" "$ISO/EFI/debian/grub.cfg" ::/EFI/debian/

echo "== BIOS: GRUB El Torito"
install -d "$ISO/boot/grub/i386-pc"
cp "$EFI_ROOT"/usr/lib/grub/i386-pc/*.mod "$EFI_ROOT"/usr/lib/grub/i386-pc/*.lst "$ISO/boot/grub/i386-pc/"
grub-mkimage -O i386-pc-eltorito -d "$EFI_ROOT/usr/lib/grub/i386-pc" -p /boot/grub \
  -o "$ISO/boot/grub/i386-pc/eltorito.img" biosdisk iso9660 part_gpt part_msdos search \
  search_fs_file configfile normal linux echo test gzio reboot

echo "== ISO"
xorriso -as mkisofs -r -J -joliet-long -V "REDGIANT_OS" -iso-level 3 \
  --modification-date="$(date -u -d "@${SOURCE_DATE_EPOCH:-$(date +%s)}" +%Y%m%d%H%M%S00)" \
  -b boot/grub/i386-pc/eltorito.img -no-emul-boot -boot-load-size 4 -boot-info-table \
  --grub2-boot-info --grub2-mbr "$EFI_ROOT/usr/lib/grub/i386-pc/boot_hybrid.img" \
  -eltorito-alt-boot -e boot/grub/efi.img -no-emul-boot \
  -append_partition 2 0xef "$EFIIMG" -appended_part_as_gpt \
  -o "$OUT" "$ISO"
ls -la "$OUT"

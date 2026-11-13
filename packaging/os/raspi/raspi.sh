# RedGiant OS (G39.2): the Raspberry Pi image, sourced by build.sh --board raspi (arm64). Debian's
# own way (raspi.debian.net): the Pi's firmware, Debian's kernel, its initramfs and device trees on a
# FAT partition the firmware reads (RASPIFIRM, mounted at /boot/firmware), the system on ext4
# (RASPIROOT), an MBR disk. Debian's raspi-firmware package keeps the FAT partition current: every
# kernel update copies the new kernel there and rewrites config.txt and cmdline.txt. No GRUB, no
# shim: the Pi has no UEFI of its own. Boots from an SD card or a USB disk (Pi 4 family).
# shellcheck shell=bash

step "Raspberry Pi: Debian's firmware and kernel on RASPIFIRM, the system on RASPIROOT"
rm -f "$ROOT/etc/default/grub"
cat >"$ROOT/etc/fstab" <<'EOF'
# RedGiant OS on a Raspberry Pi: the system and the firmware's partition (Debian's raspi-firmware
# writes the kernel there). The data lives in /var/lib/redgiant.
LABEL=RASPIROOT  /               ext4  errors=remount-ro  0 1
LABEL=RASPIFIRM  /boot/firmware  vfat  umask=0077,nofail  0 2
EOF
# raspi-firmware reads this at every kernel update. The console on the screen (last: boot messages
# and the emergency shell) and on the serial pins; no memory set aside for a desktop.
cat >"$ROOT/etc/default/raspi-firmware" <<'EOF'
# RedGiant OS: read by raspi-firmware when the kernel or the firmware is updated.
ROOTPART=LABEL=RASPIROOT
CONSOLES="ttyS1,115200 tty0"
CMA=0
KERNEL="auto"
INITRAMFS="auto"
EOF
# The firmware's files, made the way an update makes them (the hook wants a /proc).
install -d "$ROOT/boot/firmware"
mount -t proc proc "$ROOT/proc"
chroot "$ROOT" env DEB_MAINT_PARAMS=configure /etc/kernel/postinst.d/z50-raspi-firmware ||
  { umount "$ROOT/proc"; echo "raspi-firmware's hook failed" >&2; exit 1; }
umount "$ROOT/proc"
cp -r "$ROOT/usr/lib/raspi-firmware/." "$ROOT/boot/firmware/"
# What the boot partition offers the person who flashed it (the Wi-Fi file comes with G39.2's
# Wi-Fi support; until then: a cable).
cat >"$ROOT/boot/firmware/README-RedGiant.txt" <<'EOF'
RedGiant OS for Raspberry Pi

Put this card (or USB disk) in a Raspberry Pi 4, 400 or CM4, connect it to your router with a
cable and switch it on. After a few minutes open http://redgiant.local:7600 from a computer or a
phone on the same network (or the address the Pi's screen shows).

The files on this partition are written by the system: config.txt and cmdline.txt are rewritten at
every kernel update. https://github.com/Frostmoore/redgiant2/blob/main/docs/INSTALL-OS.md
EOF
printf 'RedGiant OS %s\r\n' "$OS_VERSION" >"$ROOT/boot/firmware/redgiant-os-version.txt"
# SD card, USB disk (through the PCIe USB controller) and the wired network, from the initramfs.
initrd_has mmc_block sdhci-iproc xhci-pci uas usb-storage pcie-brcmstb genet

format_raspi() {
  step "raspi: the SD card image (MBR: RASPIFIRM FAT32, RASPIROOT ext4), xz"
  local fw=$ROOT/boot/firmware img=$WORK/$NAME-raspi.img fat=$WORK/raspifirm.vfat rootimg=$WORK/raspiroot.ext4
  for f in config.txt cmdline.txt start4.elf fixup4.dat bcm2711-rpi-4-b.dtb bcm2711-rpi-400.dtb bcm2711-rpi-cm4.dtb; do
    [ -s "$fw/$f" ] || { echo "raspi: no $f on the boot partition" >&2; exit 1; }
  done
  ls "$fw"/vmlinuz-* "$fw"/initrd.img-* >/dev/null || { echo "raspi: no kernel on the boot partition" >&2; exit 1; }
  grep -q "root=LABEL=RASPIROOT" "$fw/cmdline.txt" || { echo "raspi: cmdline.txt: $(cat "$fw/cmdline.txt")" >&2; exit 1; }
  echo "config.txt: $(grep -v '^#' "$fw/config.txt" | grep . | tr '\n' ' ')"
  echo "cmdline.txt: $(cat "$fw/cmdline.txt")"
  echo "Raspberry Pi 5 device tree: $(ls "$fw"/bcm2712-rpi-5-b.dtb 2>/dev/null || echo "not in Debian's kernel")"
  # The FAT partition from its folder, then the mount point left empty in the system.
  rm -f "$fat" "$rootimg" "$img"
  truncate -s 512M "$fat"
  mkfs.vfat -F 32 -n RASPIFIRM -i "${DISK_ID:0:8}" "$fat" >/dev/null
  mcopy -s -i "$fat" "$fw"/* ::/
  mv "$fw" "$WORK/raspifirm.dir"
  install -d "$fw"
  local used size
  used=$(du -sxb "$ROOT" | cut -f1)
  size=$(((used + used / 8 + 400 * 1048576) / 1048576))
  truncate -s "${size}M" "$rootimg"
  mkfs.ext4 -q -F -L RASPIROOT -U "$ROOT_UUID" -E root_owner=0:0 -d "$ROOT" "$rootimg"
  mv "$WORK/raspifirm.dir"/* "$fw/" && rmdir "$WORK/raspifirm.dir"
  # The disk: 4 MiB for the firmware's alignment, FAT, then the system (it grows into the card).
  truncate -s $((4 + 512 + size))M "$img"
  printf 'label: dos\nlabel-id: 0x%s\nunit: sectors\n\nstart=8192, size=1048576, type=c, bootable\nstart=1056768, type=83\n' \
    "${DISK_ID:0:8}" | sfdisk -q "$img"
  dd if="$fat" of="$img" bs=4M conv=notrunc,sparse oflag=seek_bytes seek=$((8192 * 512)) status=none
  dd if="$rootimg" of="$img" bs=4M conv=notrunc,sparse oflag=seek_bytes seek=$((1056768 * 512)) status=none
  rm -f "$fat" "$rootimg"
  sfdisk -d "$img"
  # Checked as the firmware and the initramfs will see it: the labels at the partitions' offsets.
  [ "$(blkid -p -O $((8192 * 512)) -s LABEL -o value "$img")" = RASPIFIRM ] || { echo "raspi: no RASPIFIRM" >&2; exit 1; }
  [ "$(blkid -p -O $((1056768 * 512)) -s LABEL -o value "$img")" = RASPIROOT ] || { echo "raspi: no RASPIROOT" >&2; exit 1; }
  mdir -i "$img@@$((8192 * 512))" ::/ | grep -iE "config|cmdline|start4|vmlinuz|initrd|README" || true
  xz -T0 -6 -f "$img"
  mv "$img.xz" "$OUT/$NAME-raspi.img.xz"
  echo "raspi: $(du -h "$OUT/$NAME-raspi.img.xz" | cut -f1)"
}

# RedGiant OS (G39.2): the container template, sourced by build.sh --board lxc. The same system as
# the disk images without a kernel or a boot loader, for Proxmox (pct create … --ostype unmanaged
# --features nesting=1,keyctl=1, what packaging/os/proxmox/redgiant-proxmox.sh does), LXC and Incus.
# Docker runs inside the container: it needs nesting (and keyctl when unprivileged).
# shellcheck shell=bash

step "Container: no boot, no disk to grow; the container's network card and terminal"
cp -a "$HERE/lxc/rootfs/." "$ROOT/"
echo "# RedGiant OS in a container: the host mounts the root." >"$ROOT/etc/fstab"
rm -f "$ROOT/etc/default/grub"
ln -sf /dev/null "$ROOT/etc/systemd/system/redgiant-growroot.service"
# Unprivileged containers share the host's user ids (Proxmox maps them all from 100000): avahi's
# limit of 3 processes per user would stop the second container's avahi.
sed -i 's/^rlimit-nproc=/#rlimit-nproc=/' "$ROOT/etc/avahi/avahi-daemon.conf"
[ ! -e "$ROOT/vmlinuz" ] && [ -z "$(ls -A "$ROOT/lib/modules" 2>/dev/null)" ] || { echo "lxc: a kernel is in the container" >&2; exit 1; }

format_lxc() {
  step "lxc: the root filesystem, tar.zst"
  # The file capabilities (ping) travel as Proxmox's own tar keeps them; /dev, /proc and the
  # runtime folders are the host's to fill.
  tar --numeric-owner --xattrs --xattrs-include='security.capability' --sort=name \
    --mtime="@$SOURCE_DATE_EPOCH" --clamp-mtime -C "$ROOT" \
    --exclude='./dev/*' --exclude='./proc/*' --exclude='./sys/*' --exclude='./run/*' --exclude='./tmp/*' \
    -cf - . | zstd -q -T0 -19 --long=27 -o "$OUT/$NAME-lxc.tar.zst"
  # What a template must have: an init, systemd's units, RedGiant's stack and no kernel.
  zstd -dc --long=27 "$OUT/$NAME-lxc.tar.zst" | tar -t >"$WORK/lxc.list"
  for f in ./usr/sbin/init ./usr/lib/systemd/system/redgiant.service ./usr/share/redgiant-os/stack.json \
    ./etc/systemd/network/70-redgiant-container.network ./etc/systemd/system/redgiant-growroot.service; do
    grep -qxF "$f" "$WORK/lxc.list" || { echo "lxc: $f is missing" >&2; exit 1; }
  done
  ! grep -qE '^\./boot/vmlinuz|^\./usr/lib/modules/.+' "$WORK/lxc.list" || { echo "lxc: a kernel is in the template" >&2; exit 1; }
  echo "lxc: $(wc -l <"$WORK/lxc.list") entries, $(du -h "$OUT/$NAME-lxc.tar.zst" | cut -f1)"
}

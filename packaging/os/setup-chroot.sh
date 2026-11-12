#!/bin/sh
# RedGiant OS (G39.1): run once inside the new system (mmdebstrap's customize hook), after the
# packages and packaging/os/rootfs are in. Nothing here depends on the machine it will run on.
set -eu

# The services of the OS. SSH is installed but off: RedGiant's Settings switch it on (key only).
systemctl enable systemd-networkd.service systemd-resolved.service avahi-daemon.service \
  docker.service redgiant-growroot.service redgiant.service redgiant-console.service \
  redgiant-helper.socket redgiant-ssh-keys.service redgiant-os-check.timer redgiant-selftest.service \
  apt-daily.timer apt-daily-upgrade.timer
systemctl disable ssh.service ssh.socket 2>/dev/null || true
# Docker starts its containers itself; nothing waits for a network that may never come.
systemctl mask NetworkManager-wait-online.service 2>/dev/null || true

# The SSH user: no password (keys only, in /etc/redgiant/ssh/authorized_keys, written by the
# OS helper when Settings switch SSH on), administers the machine.
useradd --create-home --shell /bin/bash --groups docker,sudo redgiant
passwd --lock redgiant >/dev/null
passwd --lock root >/dev/null
chmod 0440 /etc/sudoers.d/redgiant

echo redgiant >/etc/hostname
cat >/etc/hosts <<'EOF'
127.0.0.1	localhost
127.0.1.1	redgiant
::1		localhost ip6-localhost ip6-loopback
EOF

# Each machine its own identity, made at the first start.
rm -f /etc/ssh/ssh_host_* /var/lib/dbus/machine-id
: >/etc/machine-id

chmod 0755 /usr/lib/redgiant-os/redgiant-* /usr/lib/redgiant/redgiant-helper
install -d -m 0700 /var/lib/redgiant
install -d -m 0755 /var/lib/redgiant/backups
apt-get clean
rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin /var/log/*.log /tmp/* /var/tmp/*

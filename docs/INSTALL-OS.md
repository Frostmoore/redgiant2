# RedGiant OS

RedGiant OS is a small Debian 13 system that does one thing: run RedGiant. Put it on a spare PC, a
mini PC, a virtual machine or a cloud server, switch it on, and open the address its screen shows
from any computer or phone on the same network. Everything else happens in the browser.

It assumes nothing about the machine: x86_64 or arm64, with or without a graphics card, with or
without a screen, real hardware or any hypervisor. 2 GB of memory is the minimum, 4 GB or more is
better; the disk needs 16 GB or more.

| You have                                    | Download                                    |
| ------------------------------------------- | ------------------------------------------- |
| A PC to dedicate to RedGiant (x86_64)       | `redgiant-os-<version>-x86_64.iso`          |
| Proxmox (a VM; or the script, below)        | `redgiant-os-<version>-x86_64.qcow2`        |
| Proxmox, LXC, Incus (a container)           | `redgiant-os-<version>-x86_64-lxc.tar.zst`  |
| KVM/libvirt, UTM, a cloud (x86_64)          | `redgiant-os-<version>-x86_64.qcow2`        |
| Hyper-V (Windows)                           | `redgiant-os-<version>-x86_64.vhdx.zip`     |
| VirtualBox, VMware                          | `redgiant-os-<version>-x86_64.ova`          |
| The same on arm64 (Ampere, Graviton, UTM)   | `redgiant-os-<version>-arm64.qcow2`         |
| A Raspberry Pi 4, 400 or CM4                | `redgiant-os-<version>-arm64-raspi.img.xz`  |
| Something that wants a raw disk             | `redgiant-os-<version>-<arch>.raw.zst`      |
| A server that already runs Docker           | not this page: see [INSTALL.md](INSTALL.md) |

All the ways to install RedGiant, RedGiant OS and the others, are on one page:
[INSTALL.md](INSTALL.md#every-way-to-install-redgiant).

Every file is listed in `SHA256SUMS-os`, signed with RedGiant's update key
(`SHA256SUMS-os.sig`). Check a download with `sha256sum -c SHA256SUMS-os --ignore-missing`.

## On a PC, from a USB stick

1. Write the ISO to a USB stick of 2 GB or more: [balenaEtcher](https://etcher.balena.io/) or
   [Rufus](https://rufus.ie/) (in Rufus choose "DD image"), or on Linux and macOS
   `sudo dd if=redgiant-os-<version>-x86_64.iso of=/dev/<stick> bs=4M status=progress`.
2. Start the PC from the stick (the boot menu key is often F12, F11, F8 or Esc). UEFI and old BIOS
   both work, Secure Boot can stay on.
3. The installer lists the disks of 16 GB or more. Choose one and type its name to confirm:
   **everything on that disk is erased**. RedGiant OS takes the whole disk.
4. When it says so, remove the stick and press Enter. The PC restarts into RedGiant OS.

Nothing else is asked: no user, no password, no network settings (the machine takes an address
from your router, by cable; for Wi-Fi see [Wi-Fi](#wi-fi)).

## On Proxmox

### With the script (a VM or a container)

In the Proxmox host's shell (as root, the node's "Shell" button):

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Frostmoore/redgiant2/main/packaging/os/proxmox/redgiant-proxmox.sh)"
```

It asks for the id (the next free one by default), the storage, the network bridge and the disk
size, shows what it will create and waits for a yes. Then it downloads the release's image,
checks `SHA256SUMS-os` against its signature (RedGiant's update key, built into the script) and
the image against `SHA256SUMS-os`, creates the machine, starts it and prints its address and the
code the first start asks for. It never touches a machine that exists: an id that is taken is
refused. The same with options, without questions:

```sh
bash redgiant-proxmox.sh --vm --storage local-lvm --bridge vmbr0 --disk 64 --memory 8192 --yes
bash redgiant-proxmox.sh --lxc --storage local-zfs --bridge vmbr1 --vlan 20 --yes
bash redgiant-proxmox.sh --lxc --dry-run      # shows the commands, changes nothing
```

`--help` lists the rest (`--id`, `--name`, `--cores`, `--cpu`, `--version`, `--from <dir>` for files
already downloaded, `--no-start`). The script is attached to every release too, listed in
`SHA256SUMS-os`.

- **VM** (`--vm`, the default): q35, OVMF (UEFI) with Secure Boot (Microsoft's keys enrolled: Debian's
  shim is signed by them), virtio disk (discard, iothread) and network, the guest agent (Proxmox's
  summary shows the address), a serial console beside the screen, started at boot.
- **Container** (`--lxc`): unprivileged, with the features **`nesting=1,keyctl=1`** (Docker runs inside
  the container and needs both), `ostype unmanaged` (Proxmox leaves the system's own network,
  DHCP, alone), started at boot. Lighter than a VM, but no backups to USB disks (a container
  cannot mount them) and the host's kernel is the one that runs. On ZFS, Docker needs ZFS 2.2 or
  newer (Proxmox VE 8.1+) for its overlay storage; on LVM-thin and directories it just works.

### By hand: a VM

Upload the qcow2 to the Proxmox host (for example into `/var/lib/vz/template/`), then in the
host's shell:

```sh
qm create 9000 --name redgiant --memory 4096 --cores 2 --cpu host \
  --net0 virtio,bridge=vmbr0 --ostype l26 --scsihw virtio-scsi-single --agent enabled=1 \
  --bios ovmf --machine q35 --efidisk0 local-lvm:1,efitype=4m,pre-enrolled-keys=1 \
  --scsi0 local-lvm:0,import-from=/var/lib/vz/template/redgiant-os-<version>-x86_64.qcow2,discard=on,ssd=1 \
  --boot order=scsi0
qm resize 9000 scsi0 64G
qm start 9000
```

Change the id (9000), the storage (`local-lvm`) and the bridge (`vmbr0`) to yours; the disk can
be any size of 32 GB or more, the system grows into it at start. SeaBIOS works too: leave out
`--bios`, `--machine` and `--efidisk0`. The console tab of the machine shows the address.

### By hand: a container

Put `redgiant-os-<version>-x86_64-lxc.tar.zst` in a storage for templates (Datacenter, the node,
`local`, CT Templates, Upload), then:

```sh
pct create 9001 local:vztmpl/redgiant-os-<version>-x86_64-lxc.tar.zst --hostname redgiant \
  --ostype unmanaged --unprivileged 1 --features nesting=1,keyctl=1 \
  --cores 2 --memory 4096 --swap 512 --rootfs local-lvm:32 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp,ip6=auto --onboot 1
pct start 9001
```

In the web interface: Create CT, the template, **unprivileged**, and after creating it Options,
Features: **keyctl** and **nesting** on, before the first start. The container's console shows
the address; `pct exec 9001 -- cat /etc/issue.d/50-redgiant.issue` too.

**LXC and Incus** outside Proxmox take the same template (`incus image import metadata.tar.gz
<template>` with a small `metadata.yaml`, then `incus launch … -c security.nesting=true`); CI starts
it that way (`packaging/os/test/lxc-test.sh`).

## On Hyper-V

Unzip `redgiant-os-<version>-x86_64.vhdx.zip` (right click, "Extract All") into the folder where
your virtual disks live, then in an administrator PowerShell:

```powershell
$vhdx = "C:\Hyper-V\redgiant-os-<version>-x86_64.vhdx"
Resize-VHD -Path $vhdx -SizeBytes 64GB          # optional: any size of 32 GB or more
New-VM -Name RedGiant -Generation 2 -MemoryStartupBytes 4GB -VHDPath $vhdx -SwitchName "Default Switch"
Set-VMFirmware RedGiant -SecureBootTemplate MicrosoftUEFICertificateAuthority
Set-VMProcessor RedGiant -Count 2
Set-VMMemory RedGiant -DynamicMemoryEnabled $false
Start-VM RedGiant
```

Or in Hyper-V Manager: New, Virtual Machine, **Generation 2**, 4096 MB of memory (dynamic memory
off), a network switch, "Use an existing virtual hard disk" with the VHDX; then, before starting it,
Settings, Security: keep Secure Boot on and choose the template **Microsoft UEFI Certificate
Authority** (the default "Microsoft Windows" template refuses Linux: RedGiant OS starts through
Debian's shim, signed by that authority). Connect shows the address.

"Default Switch" reaches the machine from this PC only. For the phones and computers of your
network, use an external virtual switch (Virtual Switch Manager, External, your network card) and
`-SwitchName` with its name.

## On VirtualBox and VMware

The OVA is one file with the machine inside: 2 processors, 4 GB of memory, a 32 GB disk (thin),
an Intel E1000 network card, which both have.

- **VirtualBox**: File, Import Appliance, choose the OVA, Finish. Before starting it: Settings,
  Network, Adapter 1, "Attached to: **Bridged Adapter**" (with NAT, only this computer reaches it).
  VirtualBox starts it through its BIOS, which works as it is; System, "Enable EFI" works too.
- **VMware Workstation and Fusion**: File, Open, choose the OVA, Import. It starts with UEFI and
  Secure Boot. The network is bridged; if the address does not open from other devices, Settings,
  Network Adapter, "Bridged".
- **VMware ESXi / vSphere**: Create / Register VM, "Deploy a virtual machine from an OVF or OVA
  file", then a port group of your network. ESXi 6.7 or newer (hardware version 14).

To make the disk bigger, enlarge it in the machine's settings before the first start (VirtualBox:
Tools, Media; VMware: Hard Disk, Expand): the system grows into it.

## On a Raspberry Pi

`redgiant-os-<version>-arm64-raspi.img.xz` is for the **Raspberry Pi 4 Model B, 400 and Compute
Module 4** (4 GB of memory or more is best; 2 GB is the minimum), from a microSD card or a USB
disk of 16 GB or more (an SSD on USB 3 is much faster than a card).

1. Write the image: in [Raspberry Pi Imager](https://www.raspberrypi.com/software/) choose your Pi,
   then "Use custom" with the `.img.xz`, then the card or disk. When Imager asks "apply OS
   customisation settings?", answer **No**: those settings are for Raspberry Pi OS, RedGiant OS
   asks for nothing. Or [balenaEtcher](https://etcher.balena.io/), or on Linux and macOS
   `xzcat redgiant-os-<version>-arm64-raspi.img.xz | sudo dd of=/dev/<card> bs=4M status=progress conv=fsync`.
2. For Wi-Fi instead of a cable: before taking the card out of the computer, copy
   `redgiant-wifi-example.txt` on its boot partition (`RASPIFIRM`) to `redgiant-wifi.txt` and write
   your network's name and password in it (see [Wi-Fi](#wi-fi)).
3. Put it in the Pi, connect the network cable (or not, with the Wi-Fi file) and switch it on. The first start fills the card
   and loads RedGiant (a few minutes, more on a slow card), then the screen (HDMI 0) shows the
   address; or open `http://redgiant.local:7600`.

To start from a USB disk, the Pi's bootloader must be recent (Raspberry Pi OS: `sudo rpi-eeprom-update`;
boards made since late 2020 already have it). The boot partition (`RASPIFIRM`, FAT, what a computer shows
when the card is plugged in) holds the firmware, Debian's kernel and `config.txt`/`cmdline.txt`,
which the system rewrites at every kernel update: settings go in `/etc/default/raspi-firmware`
(and `raspi-firmware-custom`, `raspi-extra-cmdline`) on the Pi itself.

How it is made: like Debian's own Raspberry Pi images (raspi.debian.net): Debian 13's
`raspi-firmware` and kernel, an MBR card with the FAT partition and the ext4 system, no GRUB. So
the kernel and the firmware come with Debian's security updates like everything else.

- **Raspberry Pi 5**: not yet. Debian 13's kernel knows the Pi 5 (its device tree is on the image) but
  does not drive its network and USB chip (RP1); the image will start on it when Debian's kernel does. Until then, on a Pi 5 run RedGiant
  in Docker on Raspberry Pi OS (64-bit): see [INSTALL.md](INSTALL.md#linux).
- **Raspberry Pi 3**: not supported (1 GB of memory is too little for RedGiant).
- **Tested** on QEMU (the image's own kernel and system on an emulated arm64 machine, with every
  check of the other images), and its partitions and boot files are checked in CI; a real Pi is
  not part of CI.

## On KVM / libvirt, UTM and clouds

```sh
qemu-img resize redgiant-os-<version>-x86_64.qcow2 64G     # optional: any size of 16 GB or more
virt-install --name redgiant --memory 4096 --vcpus 2 --import \
  --disk redgiant-os-<version>-x86_64.qcow2,bus=virtio --network default,model=virtio \
  --os-variant debian13 --boot uefi --graphics vnc --noautoconsole
```

- **UTM** (Mac): "Virtualize", "Other", then import the qcow2 of your Mac's processor (arm64 on
  Apple silicon).
- **Clouds** that take a qcow2 or raw image (OpenStack, Hetzner, OVH, Proxmox-based hosts): upload
  it as a custom image. RedGiant OS does not use cloud-init: it fills its disk and takes an
  address by itself. Open port 7600 only to your own network or VPN.

## First start

The first start takes a few minutes: the system fills its disk and loads RedGiant's images
(they are inside the image, so no download is needed). Then the screen of the machine shows:

- the address, `http://redgiant.local:7600` and the machine's IP addresses
  (phones that do not know `.local` names use the IP);
- a QR code that opens the address on a phone;
- the one-time code the page asks for at the first start;
- RedGiant's status and whether an update is waiting.

Press **t** to show the access link with your token (as a QR code, for one minute), **u** to
install a waiting RedGiant update, **w** to join a Wi-Fi network. The other consoles (Alt+F2…)
and the serial console show the address on their login prompt. There is no password login: the
machine is managed from RedGiant.

## Wi-Fi

A cable is the simplest and always wins when both are connected (Wi-Fi stays as a spare). The
usual Wi-Fi cards work out of the box: RedGiant OS carries Debian's firmware for Intel, Realtek,
Qualcomm Atheros, Broadcom (Raspberry Pi and many laptops), MediaTek and Ralink (Debian's
`non-free-firmware`, redistributable). Networks with a password (WPA2/WPA3 personal) and open
networks can be joined; company networks (802.1X) cannot yet. Three ways:

1. **With a screen and a keyboard**: press **w** on the machine's screen, pick the network by its
   number (or **h** for a hidden one), type the password (it is not shown).
2. **From the page**, when the machine already has a cable or another network: the first start's
   «Access from outside» step, or **Settings › System › Network** later: the networks in reach,
   «Join», «Forget», which one is in use.
3. **Without a screen**: write a file named `redgiant-wifi.txt` on the machine's EFI partition
   (the small FAT disk any computer shows when the disk, SD card or USB stick is plugged in; on a
   Raspberry Pi its boot partition, `RASPIFIRM`;
   `redgiant-wifi-example.txt` is there to copy). For the ISO, put it on the USB stick (its small
   FAT partition, or the stick itself when Rufus wrote it in ISO mode): the installer carries it
   to the new system.

   ```text
   ssid=Home network
   password=the password
   ```

   Another `ssid=` line adds one more network; `hidden=yes` for a network that hides its name;
   values with spaces at the ends go in double quotes. The file is read once at the start, the
   networks are saved, then the file is erased from the disk.

Passwords are kept only in iwd's own file for each network (`/var/lib/iwd`, readable by root
alone): never in RedGiant's data, its logs or its events, and never in a program's arguments.

## HTTPS in your network

RedGiant OS answers on `https://redgiant.local` (and on the machine's private addresses) with a
certificate of its own: at the first start the machine makes a small certificate authority (CA)
of its own, in `/var/lib/redgiant/tls` (its key readable by root alone), and Caddy (Debian's)
serves RedGiant with it on port 443, and on port 80. The CA is limited to local names (`.local`)
and private addresses: trusting it on a phone never makes it trust any website. The machine's
certificate follows its addresses and renews itself; the CA lasts ten years.

Browsers show a warning until the CA is trusted on the device. In **Settings › System ›
Network › HTTPS in your network**:

1. «Download the certificate» (on a phone, scan the QR code: it downloads `RedGiant-CA.crt` over
   http), compare the fingerprint shown in the page if you like.
2. Install it as the page says for your system (Windows: «Trusted Root Certification
   Authorities»; macOS: Keychain Access, «Always Trust»; iPhone/iPad: install the profile, then
   Settings › General › About › Certificate Trust Settings; Android: Settings › Security ›
   Encryption & credentials › Install a certificate › CA certificate; Firefox has its own list:
   Settings › Privacy & Security › Certificates › Import).
3. «Check this device»: the page reaches `https://` with the certificate. Only when that works,
   http is sent to https from then on (and HSTS, 30 days, goes with the https answers).

Until step 3 http keeps working, so nobody is locked out of their own machine. `/api/health`
and `/redgiant-ca.crt` always answer on http. When RedGiant is already reached over HTTPS another
way (Tailscale, Cloudflare, a proxy of your own: the first start says what it found), the page
says so and does not offer the redirect for that address; names other than the machine's local
ones are never redirected. «HTTPS in the local network» switches Caddy off, for instance before
choosing «Your own domain» in Access from outside (that way needs ports 80 and 443 itself).

## Where the data lives

Everything RedGiant keeps is in **`/var/lib/redgiant`**, on the system disk:

| Path                               | What                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `/var/lib/redgiant/docker`         | Docker's data: RedGiant's images and volumes (projects, database, models) |
| `/var/lib/redgiant/stack.env`      | the access token and database password (root only)                        |
| `/var/lib/redgiant/backups/<name>` | external disks mounted for backups                                        |
| `/var/lib/redgiant/stack`          | the compose files in use                                                  |
| `/var/lib/redgiant/tls`            | the local CA and the machine's certificate (root only)                    |
| `/var/lib/iwd`                     | the saved Wi-Fi networks and their passwords (root only)                  |

To keep the data on a second disk, mount that disk at `/var/lib/redgiant` before the first start
(choosing it from RedGiant's page comes later).

**Backups** go to an external disk (USB) chosen in Settings: RedGiant asks the OS helper
(`/usr/lib/redgiant/redgiant-helper`) to mount it under `/var/lib/redgiant/backups/`. Only disks
that can be unplugged are offered, never the system's; ext4, XFS, Btrfs, exFAT, FAT and NTFS work.

## SSH

The SSH server is installed but **off**. Settings switch it on with a public key: then
`ssh redgiant@<address>` works with that key only (no passwords, no root login), and the
`redgiant` user may use `sudo`. Switching it off in Settings stops it again.

## Updates

- **RedGiant** updates its containers from the signed release: the machine looks once a day
  (`redgiant-os-check.timer`), and the page and the console say when an update is there. Apply
  it from the page (**Settings › System › Updates**, or the update window of a mandatory
  release: «Update now»), with the console key **u**, or `redgiant-os-update apply`: the machine
  downloads the release's `redgiant-os-stack.json`, checks its signature with the update key
  built into the OS, pulls the images it pins by digest while RedGiant keeps working, restarts
  RedGiant and waits for it to answer; if it does not, the previous version starts again. The
  page follows each step through RedGiant's own restart and comes back by itself. A release
  marked "breaking" is never applied in place (the page and the updater both refuse): the page
  guides a backup to a USB disk, a reinstall and a restore.
- **The system** installs Debian's security updates by itself (`unattended-upgrades`: Debian 13
  and its security archive, Docker Engine included). **Settings › System › Updates** shows when
  they last ran and how many packages came; when one needs a restart (a new kernel…) it says so,
  and «Restart now» restarts the machine after a window that says what happens (RedGiant is away
  for two or three minutes). The console says so too.
- **A new Debian release** (Debian 14, around 2027) will come as a new RedGiant OS: the plan is a
  signed image of the new system written next to the current one (A/B), switched to at a restart
  and switched back if it does not come up, with the data in `/var/lib/redgiant` untouched. Until
  then a reinstall keeps the data if `/var/lib/redgiant` is on its own disk, and a backup restores
  everything otherwise.

## For developers

The images are built by `packaging/os/build.sh` in the builder container
(`packaging/os/builder.Dockerfile`, Debian 13): `mmdebstrap` makes the system, `systemd-repart
--offline` the disk (no loop devices), GRUB boots it (UEFI through Debian's signed shim, BIOS on
x86_64), and `installer/build-iso.sh` makes the ISO (a `live-boot` system that writes the disk
image). The workflow `.github/workflows/os.yml` builds both processors on GitHub's runners and
boots every image in QEMU. Every format is a `format_<name>` function in `build.sh`: the VHDX and
the OVA are converted from the same disk (`qemu-img`, the OVF descriptor by `formats/vm.py`) and
boot in CI through those files (the VHDX with UEFI, the OVA's disk with BIOS and an E1000 card).
`--board lxc` makes the container template (`lxc/lxc.sh`: the same system without a kernel or a
boot loader; CI starts it in Incus) and `--board raspi` the Raspberry Pi image (`raspi/raspi.sh`; CI
checks its partitions and files and starts its system on QEMU's arm64 machine). The Proxmox host's
script is `proxmox/redgiant-proxmox.sh` (tests: `test/proxmox.test.ts`, with stand-ins for `qm`,
`pct`, `pvesh` and `pvesm`).

```sh
node packaging/os/stack.mjs --version 3.7.0 --out out/redgiant-os-stack.json
docker build -f packaging/os/builder.Dockerfile -t redgiant-os-builder packaging/os
docker run --rm --privileged -v "$PWD:/src" -v "$PWD/out:/out" redgiant-os-builder \
  /src/packaging/os/build.sh --arch amd64 --stack /out/redgiant-os-stack.json --out /out
packaging/os/test/boot-test.sh boot --arch amd64 --firmware uefi --disk out/redgiant-os-3.7.0-x86_64.qcow2 --logs out/logs
```

The builder image `redgiant-os-builder` is built from `debian:trixie`.

The boot test checks, inside the machine, HTTPS with the local CA (by name and by address, TLS
1.2 at least, the CA's key root-only), the OS helper's update commands, and from outside the
machine `https://redgiant.local` trusting only the machine's CA. With `--wifi` it also loads
`mac80211_hwsim` (two simulated radios), installs hostapd on the test machine as a WPA2 access
point and joins it three ways: `redgiant-wifi.txt`, the helper's `wifi-connect` (a wrong password
leaves nothing saved) and `wifi-forget`. The workflow's `quick` input builds only the x86_64
qcow2 and boots it once with those checks.

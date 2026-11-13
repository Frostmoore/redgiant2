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
| Proxmox, KVM/libvirt, UTM, a cloud (x86_64) | `redgiant-os-<version>-x86_64.qcow2`        |
| The same on arm64 (Ampere, Graviton, UTM)   | `redgiant-os-<version>-arm64.qcow2`         |
| Something that wants a raw disk             | `redgiant-os-<version>-<arch>.raw.zst`      |
| A server that already runs Docker           | not this page: see [INSTALL.md](INSTALL.md) |

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

Upload the qcow2 to the Proxmox host (for example into `/var/lib/vz/template/`), then in the
host's shell:

```sh
qm create 9000 --name redgiant --memory 4096 --cores 2 --cpu host \
  --net0 virtio,bridge=vmbr0 --ostype l26 --scsihw virtio-scsi-single \
  --bios ovmf --machine q35 --efidisk0 local-lvm:0,efitype=4m,pre-enrolled-keys=1
qm importdisk 9000 redgiant-os-<version>-x86_64.qcow2 local-lvm
qm set 9000 --scsi0 local-lvm:vm-9000-disk-1,discard=on,ssd=1 --boot order=scsi0
qm resize 9000 scsi0 64G
qm start 9000
```

Change the id (9000), the storage (`local-lvm`) and the bridge (`vmbr0`) to yours; the disk can
be any size of 16 GB or more, the system grows into it at start. SeaBIOS works too: leave out
`--bios`, `--machine` and `--efidisk0`. The console tab of the machine shows the address.

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
   (the small FAT disk any computer shows when the disk, SD card or USB stick is plugged in;
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
boots every image in QEMU. More formats (VHDX, OVA, LXC, Raspberry Pi) are a `format_<name>`
function in `build.sh`.

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

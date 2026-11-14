#!/usr/bin/env bash
# RedGiant OS (G39.1): boots an image in QEMU, headless, and checks it (CI's job os.yml).
#
#   boot-test.sh boot    --arch amd64|arm64 --firmware uefi|bios [--secureboot] [--wifi] --disk <qcow2> --logs <dir>
#                        [--nic e1000]   (--disk: any format qemu-img reads: qcow2, vhdx, vmdk, raw)
#   boot-test.sh boot    --arch arm64 --firmware direct --kernel <vmlinuz> --initrd <initrd> --append <args> …
#                        (the kernel started by QEMU itself: the Raspberry Pi image's system on QEMU's virt)
#   boot-test.sh install --iso <iso> --disk <new qcow2> --logs <dir> [--firmware bios|uefi]
#
# boot: the machine gets the credential redgiant.selftest, so redgiant-selftest prints its checks on
# the serial console (unit active, /api/health, images pinned, redgiant.local over mDNS, the
# console's issue, SSH off, the OS helper, unattended-upgrades); this script also asks
# /api/health from outside through a forwarded port, then over HTTPS with the machine's own CA
# (printed by the self-test), and looks for the login prompt's address. --wifi adds the Wi-Fi
# checks inside the machine (mac80211_hwsim, hostapd: redgiant-selftest-wifi) and requires its
# password checks by name (a wrong password refused, fresh and after a good join).
# install: boots the ISO with an empty disk and the credentials that answer the installer, and
# waits for it to write the disk and power off.
# Uses KVM when /dev/kvm is there, otherwise QEMU's emulation (slow: minutes become tens).
set -uo pipefail
MODE=${1:-}
shift || true
ARCH=amd64 FIRMWARE=uefi SECUREBOOT=0 WIFI=0 DISK="" ISO="" LOGS=. WORK="" TIMEOUT=${TIMEOUT:-3600} PORT=17600 TLS_PORT=17643
NIC=virtio-net-pci KERNEL="" INITRD="" APPEND=""
# The machine's CA certificate as the self-test printed it on the console (the last one), base64.
ca_from_console() {
  sed 's/\r$//' "$1" | awk '
    /\033/ { next }
    /REDGIANT-SELFTEST ca / { c = 1; buf = ""; sub(/^.*REDGIANT-SELFTEST ca /, "") }
    c && /REDGIANT-SELFTEST/ && !/REDGIANT-SELFTEST ca / { c = 0; last = buf; next }
    c { sub(/\[ *[0-9]+\.[0-9]+\].*$/, ""); buf = buf $0 }
    END { print (c ? buf : last) }
  ' | tr -cd 'A-Za-z0-9+/='
}

while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH=$2 && shift ;;
    --firmware) FIRMWARE=$2 && shift ;;
    --secureboot) SECUREBOOT=1 ;;
    --wifi) WIFI=1 ;;
    --disk) DISK=$2 && shift ;;
    --iso) ISO=$2 && shift ;;
    --logs) LOGS=$2 && shift ;;
    # Where the copies QEMU writes go (default: the logs folder).
    --work) WORK=$2 && shift ;;
    --timeout) TIMEOUT=$2 && shift ;;
    # The network card (VirtualBox and VMware: e1000).
    --nic) NIC=$2 && shift ;;
    --kernel) KERNEL=$2 && shift ;;
    --initrd) INITRD=$2 && shift ;;
    --append) APPEND=$2 && shift ;;
    *) echo "unknown option $1" >&2 && exit 2 ;;
  esac
  shift
done
mkdir -p "$LOGS"
WORK=${WORK:-$LOGS}
mkdir -p "$WORK"
SERIAL=$LOGS/serial-$MODE-$ARCH-$FIRMWARE$([ "$SECUREBOOT" = 1 ] && echo -sb).log
: >"$SERIAL"

# KVM when the runner has it; otherwise emulation, with longer limits.
# FORCE_TCG=1: emulation even with KVM (nested KVM may not run the SMM that Secure Boot firmware needs).
# KVM only for a guest of the host's own processor.
case "$(uname -m)" in x86_64) HOST=amd64 ;; aarch64) HOST=arm64 ;; *) HOST=other ;; esac
if [ -w /dev/kvm ] && [ "$HOST" = "$ARCH" ] && [ -z "${FORCE_TCG:-}" ]; then ACCEL=kvm CPU=host BOOT_LIMIT=${BOOT_LIMIT:-600}; else ACCEL=tcg CPU=max BOOT_LIMIT=${BOOT_LIMIT:-3600}; fi
echo "QEMU: $ARCH, $FIRMWARE$([ "$SECUREBOOT" = 1 ] && echo " (Secure Boot)"), $ACCEL"

firmware() { # args for UEFI: a private copy of the variables
  local code vars
  case "$ARCH" in
    amd64)
      if [ "$SECUREBOOT" = 1 ]; then
        code=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd vars=/usr/share/OVMF/OVMF_VARS_4M.ms.fd
      else
        code=/usr/share/OVMF/OVMF_CODE_4M.fd vars=/usr/share/OVMF/OVMF_VARS_4M.fd
      fi
      ;;
    arm64) code=/usr/share/AAVMF/AAVMF_CODE.fd vars=/usr/share/AAVMF/AAVMF_VARS.fd ;;
  esac
  cp "$vars" "$WORK/vars-$ARCH.fd"
  echo "-drive if=pflash,format=raw,unit=0,readonly=on,file=$code -drive if=pflash,format=raw,unit=1,file=$WORK/vars-$ARCH.fd"
}

machine() {
  local fw=""
  [ "$FIRMWARE" = uefi ] && fw=$(firmware)
  case "$ARCH" in
    amd64)
      if [ "$SECUREBOOT" = 1 ]; then
        echo "qemu-system-x86_64 -machine q35,smm=on,accel=$ACCEL -global driver=cfi.pflash01,property=secure,value=on -cpu $CPU $fw"
      else
        echo "qemu-system-x86_64 -machine q35,accel=$ACCEL -cpu $CPU $fw"
      fi
      ;;
    arm64) echo "qemu-system-aarch64 -machine virt,accel=$ACCEL -cpu $CPU $fw" ;;
  esac
}

run_qemu() { # extra args…; runs in the background, PID in QEMU_PID
  # shellcheck disable=SC2046 # the words of machine() are meant to split
  $(machine) -m 4096 -smp 4 -display none -monitor none -no-user-config \
    -serial "file:$SERIAL" "$@" &
  QEMU_PID=$!
}

stop_qemu() { kill "$QEMU_PID" 2>/dev/null; wait "$QEMU_PID" 2>/dev/null; }

wait_for() { # regex seconds: true once the serial console shows it
  local deadline=$((SECONDS + $2))
  while [ $SECONDS -lt $deadline ]; do
    grep -aqE "$1" "$SERIAL" && return 0
    # Nothing to boot, or a kernel that cannot go on: no point waiting for the rest.
    if grep -aqE "No bootable option or device was found|grub> |Kernel panic|Booting from Hard Disk\.\.\.[[:space:]]*Boot failed|error: no such device|ALERT! .* does not exist" "$SERIAL"; then
      echo "::error::the machine did not boot"
      return 1
    fi
    kill -0 "$QEMU_PID" 2>/dev/null || { echo "::error::QEMU exited"; return 1; }
    sleep 5
  done
  return 1
}

case "$MODE" in
  boot)
    [ -r "$DISK" ] || { echo "no disk" >&2; exit 2; }
    RUN=$WORK/run-$ARCH-$FIRMWARE.qcow2
    qemu-img create -q -f qcow2 -b "$(readlink -f "$DISK")" -F "$(qemu-img info --output=json "$DISK" | jq -r .format)" "$RUN"
    start=$SECONDS
    creds=(-smbios "type=11,value=io.systemd.credential:redgiant.selftest=1")
    [ "$WIFI" = 1 ] && creds+=(-smbios "type=11,value=io.systemd.credential:redgiant.selftest.wifi=1")
    DIRECT=()
    [ "$FIRMWARE" = direct ] && DIRECT=(-kernel "$KERNEL" -initrd "$INITRD" -append "$APPEND")
    run_qemu "${DIRECT[@]}" -drive "file=$RUN,if=virtio,format=qcow2" \
      -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$PORT-:7600,hostfwd=tcp:127.0.0.1:$TLS_PORT-:443" -device "$NIC,netdev=net0,romfile=" \
      "${creds[@]}"
    ok=1
    # First stage, its own limit: firmware, GRUB, kernel and systemd up to a login prompt.
    if ! wait_for "login: " "$BOOT_LIMIT"; then
      echo "::error::no login prompt within $BOOT_LIMIT s"
      stop_qemu
      echo "--- serial console (last 200 lines)"
      tail -n 200 "$SERIAL"
      exit 1
    fi
    echo "login prompt after $((SECONDS - start)) s"
    # The self-test says it started: a unit that never starts (an ordering loop) fails here, early.
    if ! wait_for "REDGIANT-SELFTEST started" "${START_LIMIT:-900}"; then
      echo "::error::the self-test did not start within ${START_LIMIT:-900} s"
      stop_qemu
      echo "--- serial console (last 200 lines)"
      tail -n 200 "$SERIAL"
      exit 1
    fi
    if wait_for "REDGIANT-SELFTEST (PASS|FAIL)[[:space:]]*$" "$TIMEOUT"; then
      echo "self-test finished after $((SECONDS - start)) s"
    else
      echo "::error::no self-test result (after $((SECONDS - start)) s)"
      ok=0
    fi
    grep -a "REDGIANT-SELFTEST" "$SERIAL" | grep -av "REDGIANT-SELFTEST ca " | sed 's/\r$//'
    if ! grep -aq "REDGIANT-SELFTEST PASS" "$SERIAL"; then
      # Which checks failed, by name, in the error line itself.
      failed=$(grep -a "REDGIANT-SELFTEST FAIL " "$SERIAL" | sed 's/\r$//; s/^.*REDGIANT-SELFTEST FAIL *//' | paste -sd ';' -)
      echo "::error::self-test failed: ${failed:-no check named (see the serial console)}"
      ok=0
    fi
    # With --wifi, the password checks must have run and passed (a self-test that skipped them
    # would still say PASS). Lines may end in CR LF: fixed substrings, never "$" anchors.
    if [ "$WIFI" = 1 ]; then
      for c in "wifi wrong password refused on a fresh iwd" "wifi refused password not kept" \
        "wifi not connected after a refused password" "wifi-status connected" \
        "wifi wrong password refused after a good one" "wifi good password restored" \
        "wifi joined again with the good password" "wifi password in no log"; do
        grep -aqF "REDGIANT-SELFTEST ok   $c" "$SERIAL" || { echo "::error::Wi-Fi check missing or failed: $c"; ok=0; }
      done
    fi
    # From outside the machine, through the forwarded port.
    if curl -fsS --max-time 10 "http://127.0.0.1:$PORT/api/health"; then echo; else echo "::error::/api/health not reachable from the host"; ok=0; fi
    # HTTPS from outside, trusting only the machine's own CA (its certificate from the console).
    # The kernel may write in the middle of that long line (seen: «[  156.785042] wlan0:
    # deauthenticated …» and a line break inside the base64): its messages are cut out and the
    # base64 is joined again up to the next self-test line.
    ca_from_console "$SERIAL" | base64 -d >"$WORK/ca.crt" 2>/dev/null
    if [ -s "$WORK/ca.crt" ] && curl -fsS --max-time 10 --cacert "$WORK/ca.crt" --resolve "redgiant.local:$TLS_PORT:127.0.0.1" "https://redgiant.local:$TLS_PORT/api/health"; then
      echo
      echo "https from the host with the local CA: ok"
    else
      echo "::error::https://redgiant.local not reachable from the host with the machine's CA"
      ok=0
    fi
    # The login prompt of the serial console carries the address (/etc/issue.d/50-redgiant.issue).
    if grep -aqE "RedGiant: http://10\.0\.2\.15:7600" "$SERIAL"; then
      echo "issue: $(grep -aE "RedGiant: http://" "$SERIAL" | head -1 | sed 's/\r$//')"
    else
      echo "::error::the console's issue does not show the address"
      ok=0
    fi
    stop_qemu
    [ "$ok" = 1 ] || { echo "--- serial console (last 200 lines)"; tail -n 200 "$SERIAL"; exit 1; }
    echo "OK: $ARCH $FIRMWARE$([ "$SECUREBOOT" = 1 ] && echo " secure boot") in $((SECONDS - start)) s"
    ;;
  install)
    if [ ! -r "$ISO" ] || [ -z "$DISK" ]; then echo "--iso and --disk are needed" >&2; exit 2; fi
    qemu-img create -q -f qcow2 "$DISK" 32G
    start=$SECONDS
    run_qemu -cdrom "$ISO" -boot d -no-reboot \
      -drive "file=$DISK,if=virtio,format=qcow2" -netdev user,id=net0 -device virtio-net-pci,netdev=net0,romfile= \
      -smbios "type=11,value=io.systemd.credential:redgiant.install.disk=/dev/vda" \
      -smbios "type=11,value=io.systemd.credential:redgiant.install.confirm=yes"
    deadline=$((SECONDS + TIMEOUT))
    while kill -0 "$QEMU_PID" 2>/dev/null && [ $SECONDS -lt $deadline ]; do sleep 5; done
    grep -a "REDGIANT-INSTALL" "$SERIAL" | sed 's/\r$//'
    if kill -0 "$QEMU_PID" 2>/dev/null; then
      stop_qemu
      echo "::error::the installer did not finish within $TIMEOUT s"
      tail -n 120 "$SERIAL"
      exit 1
    fi
    grep -aq "REDGIANT-INSTALL DONE /dev/vda" "$SERIAL" || { echo "::error::the installer failed"; tail -n 120 "$SERIAL"; exit 1; }
    echo "OK: installed from the ISO ($FIRMWARE) in $((SECONDS - start)) s"
    ;;
  *)
    echo "usage: boot-test.sh boot|install …" >&2
    exit 2
    ;;
esac

#!/usr/bin/env bash
# RedGiant OS (G39.1): boots an image in QEMU, headless, and checks it (CI's job os.yml).
#
#   boot-test.sh boot    --arch amd64|arm64 --firmware uefi|bios [--secureboot] --disk <qcow2> --logs <dir>
#   boot-test.sh install --iso <iso> --disk <new qcow2> --logs <dir> [--firmware bios|uefi]
#
# boot: the machine gets the credential redgiant.selftest, so redgiant-selftest prints its checks on
# the serial console (unit active, /api/health, images pinned, redgiant.local over mDNS, the
# console's issue, SSH off, the OS helper, unattended-upgrades); this script also asks
# /api/health from outside through a forwarded port and looks for the login prompt's address.
# install: boots the ISO with an empty disk and the credentials that answer the installer, and
# waits for it to write the disk and power off.
# Uses KVM when /dev/kvm is there, otherwise QEMU's emulation (slow: minutes become tens).
set -uo pipefail
MODE=${1:-}
shift || true
ARCH=amd64 FIRMWARE=uefi SECUREBOOT=0 DISK="" ISO="" LOGS=. TIMEOUT=${TIMEOUT:-3600} PORT=17600
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH=$2 && shift ;;
    --firmware) FIRMWARE=$2 && shift ;;
    --secureboot) SECUREBOOT=1 ;;
    --disk) DISK=$2 && shift ;;
    --iso) ISO=$2 && shift ;;
    --logs) LOGS=$2 && shift ;;
    --timeout) TIMEOUT=$2 && shift ;;
    *) echo "unknown option $1" >&2 && exit 2 ;;
  esac
  shift
done
mkdir -p "$LOGS"
SERIAL=$LOGS/serial-$MODE-$ARCH-$FIRMWARE$([ "$SECUREBOOT" = 1 ] && echo -sb).log
: >"$SERIAL"

# KVM when the runner has it; otherwise emulation, with longer limits.
if [ -w /dev/kvm ]; then ACCEL=kvm CPU=host BOOT_LIMIT=${BOOT_LIMIT:-600}; else ACCEL=tcg CPU=max BOOT_LIMIT=${BOOT_LIMIT:-3600}; fi
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
  cp "$vars" "$LOGS/vars-$ARCH.fd"
  echo "-drive if=pflash,format=raw,unit=0,readonly=on,file=$code -drive if=pflash,format=raw,unit=1,file=$LOGS/vars-$ARCH.fd"
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
    RUN=$LOGS/run-$ARCH-$FIRMWARE.qcow2
    qemu-img create -q -f qcow2 -b "$(readlink -f "$DISK")" -F qcow2 "$RUN"
    start=$SECONDS
    run_qemu -drive "file=$RUN,if=virtio,format=qcow2" \
      -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$PORT-:7600" -device virtio-net-pci,netdev=net0,romfile= \
      -smbios "type=11,value=io.systemd.credential:redgiant.selftest=1"
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
    if wait_for "REDGIANT-SELFTEST (PASS|FAIL)$" "$TIMEOUT"; then
      echo "self-test finished after $((SECONDS - start)) s"
    else
      echo "::error::no self-test result (after $((SECONDS - start)) s)"
      ok=0
    fi
    grep -a "REDGIANT-SELFTEST" "$SERIAL" | sed 's/\r$//'
    grep -aq "REDGIANT-SELFTEST PASS" "$SERIAL" || ok=0
    # From outside the machine, through the forwarded port.
    if curl -fsS --max-time 10 "http://127.0.0.1:$PORT/api/health"; then echo; else echo "::error::/api/health not reachable from the host"; ok=0; fi
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
    [ -r "$ISO" ] && [ -n "$DISK" ] || { echo "--iso and --disk are needed" >&2; exit 2; }
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

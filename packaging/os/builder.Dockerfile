# RedGiant OS (G39.1): the tools that build the images, Debian's own, pinned to Debian 13.
#   docker build -f packaging/os/builder.Dockerfile -t redgiant-os-builder packaging/os
#   docker run --rm --privileged -v "$PWD:/src" -v "$OUT:/out" redgiant-os-builder \
#     /src/packaging/os/build.sh --arch amd64 --stack /out/redgiant-os-stack.json --out /out
# Privileged only for mmdebstrap's chroot (mounting /proc) and grub-bios-setup's view of the
# image; no loop device is ever used: the disk is put together from files (systemd-repart --offline).
FROM debian:trixie
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    mmdebstrap debian-archive-keyring ca-certificates systemd-repart \
    dosfstools mtools e2fsprogs fdisk gdisk util-linux mount \
    qemu-utils zstd xz-utils xorriso squashfs-tools skopeo jq python3 \
    grub-common $(case "$(dpkg --print-architecture)" in amd64) echo grub-pc-bin grub-efi-amd64-bin ;; arm64) echo grub-efi-arm64-bin ;; esac) \
 && rm -rf /var/lib/apt/lists/*

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { BlockDisk } from "@redgiant/protocol";
import { describe, expect, it } from "vitest";
import {
  backupCandidates,
  checkBackupDisk,
  isSystemMount,
  parseUdisksMount,
  safeLabel,
} from "../src/backup-disks.js";
import {
  containerHint,
  discoverSystem,
  drmGpus,
  localOffer,
  parseDetectVirt,
  parseLsblk,
  parseLspci,
  parseNvidiaSmi,
} from "../src/discovery.js";
import type { Hardware } from "../src/hardware.js";
import {
  hostName,
  localDnsServer,
  parseTailscaleStatus,
  proxiesRunning,
  proxyInFront,
} from "../src/net-detect.js";
import { helperRequest, parseHelperReply, sshPublicKey } from "../src/os-helper.js";

/** A mini PC: NVMe system disk, a USB disk «Eternatus», a SD card, a USB stick with swap. */
const LSBLK = JSON.stringify({
  blockdevices: [
    { name: "loop0", path: "/dev/loop0", type: "loop", size: 1000, rm: false },
    {
      name: "nvme0n1",
      path: "/dev/nvme0n1",
      type: "disk",
      size: 512110190592,
      rm: false,
      hotplug: false,
      tran: "nvme",
      model: "Fanxiang S500",
      children: [
        {
          name: "nvme0n1p1",
          path: "/dev/nvme0n1p1",
          type: "part",
          size: 536870912,
          rm: false,
          fstype: "vfat",
          uuid: "AB12-CD34",
          mountpoint: "/boot/efi",
        },
        {
          name: "nvme0n1p2",
          path: "/dev/nvme0n1p2",
          type: "part",
          size: 511000000000,
          rm: false,
          fstype: "ext4",
          uuid: "1111-2222",
          mountpoint: "/",
        },
      ],
    },
    {
      name: "sda",
      path: "/dev/sda",
      type: "disk",
      size: "2000398934016",
      rm: "0",
      hotplug: "1",
      tran: "usb",
      model: "Elements 25A3",
      children: [
        {
          name: "sda1",
          path: "/dev/sda1",
          type: "part",
          size: "2000397795328",
          rm: "0",
          hotplug: "1",
          tran: null,
          fstype: "exfat",
          label: "Eternatus",
          uuid: "5E3A-91F0",
          mountpoint: null,
        },
      ],
    },
    {
      name: "mmcblk0",
      path: "/dev/mmcblk0",
      type: "disk",
      size: 31914983424,
      rm: true,
      tran: "",
      fstype: "ext4",
      label: "photos card",
      uuid: "c0ffee00-1234-4abc-9def-001122334455",
      mountpoint: "/media/pi/photos",
    },
    {
      name: "sdb",
      path: "/dev/sdb",
      type: "disk",
      size: 16000000000,
      rm: true,
      tran: "usb",
      children: [
        {
          name: "sdb1",
          path: "/dev/sdb1",
          type: "part",
          size: 8000000000,
          fstype: "swap",
          uuid: "aaaa-bbbb",
          mountpoint: "[SWAP]",
        },
        {
          name: "sdb2",
          path: "/dev/sdb2",
          type: "part",
          size: 8000000000,
          fstype: "ext4",
          uuid: "cccc-dddd",
        },
      ],
    },
  ],
});

const disks = parseLsblk(LSBLK);
const byName = (n: string) => disks.find((d) => d.name === n) as BlockDisk;

describe("lsblk (G39.3)", () => {
  it("flattens disks and partitions, leaves out loops, and takes the disk's transport", () => {
    expect(disks.map((d) => d.name)).toEqual([
      "nvme0n1",
      "nvme0n1p1",
      "nvme0n1p2",
      "sda",
      "sda1",
      "mmcblk0",
      "sdb",
      "sdb1",
      "sdb2",
    ]);
    expect(byName("sda1")).toMatchObject({
      type: "part",
      disk: "sda",
      transport: "usb",
      hotplug: true,
      removable: false,
      label: "Eternatus",
      fstype: "exfat",
      sizeBytes: 2000397795328,
      mountpoint: "",
    });
    expect(byName("mmcblk0")).toMatchObject({ removable: true, disk: "mmcblk0" });
  });

  it.each([
    ["not JSON", "lsblk: unknown column"],
    ["no devices", "{}"],
  ])("gives nothing for %s", (_, text) => {
    expect(parseLsblk(text)).toEqual([]);
  });
});

describe("the disks that may take backups (G39.3)", () => {
  const data = ["/var/lib/redgiant/data"];
  it.each([
    ["a USB disk not mounted", "sda1", { ok: true, target: "/var/lib/redgiant/backups/Eternatus" }],
    ["a card already mounted by the desktop", "mmcblk0", { ok: true, target: "/media/pi/photos" }],
    ["the system disk's root", "nvme0n1p2", { ok: false, why: "not_removable" }],
    ["the system disk's boot partition", "nvme0n1p1", { ok: false, why: "not_removable" }],
    ["a removable disk with swap in use", "sdb2", { ok: false, why: "system_disk" }],
  ])("%s", (_, name, want) => {
    expect(checkBackupDisk(byName(name), disks, data)).toEqual(want);
  });

  const usb = (o: Partial<BlockDisk>): BlockDisk => ({
    ...byName("sda1"),
    ...o,
  });
  it.each([
    [
      "holding RedGiant's data",
      usb({ mountpoint: "/media/x" }),
      ["/media/x/redgiant"],
      "system_disk",
    ],
    ["mounted on a system path", usb({ mountpoint: "/data" }), data, "system_disk"],
    ["mounted at the root", usb({ mountpoint: "/" }), data, "system_disk"],
    ["without a filesystem", usb({ fstype: "" }), data, "no_filesystem"],
    ["an encrypted container", usb({ fstype: "crypto_luks" }), data, "unsupported_filesystem"],
    ["an LVM member", usb({ fstype: "lvm2_member" }), data, "unsupported_filesystem"],
    ["without a UUID", usb({ uuid: "" }), data, "no_uuid"],
    ["an internal SATA disk", usb({ transport: "sata", hotplug: false }), data, "not_removable"],
    ["a loop device", usb({ type: "other" }), data, "not_a_disk"],
  ])("refuses a disk %s", (_, d, dirs, why) => {
    expect(checkBackupDisk(d, [d], dirs)).toEqual({ ok: false, why });
  });

  it("lists only removable filesystems, never a system disk, with why one is not usable", () => {
    const list = backupCandidates(disks, data);
    expect(list.map((d) => [d.name, d.usable, d.why ?? d.target])).toEqual([
      ["sda1", true, "/var/lib/redgiant/backups/Eternatus"],
      ["mmcblk0", true, "/media/pi/photos"],
    ]);
  });

  it.each([
    ["/", true],
    ["/boot/efi", true],
    ["[SWAP]", true],
    ["/srv/stuff", true],
    ["/media/pi/x", false],
    ["/run/media/me/x", false],
    ["/var/lib/redgiant/backups/x", false],
    ["", false],
  ])("system mount %s: %s", (mp, want) => {
    expect(isSystemMount(mp, [])).toBe(want);
  });

  it.each([
    ["Eternatus", "x", "Eternatus"],
    ["photos card", "x", "photos-card"],
    ["../../etc", "x", "etc"],
    ["", "5E3A-91F0", "disk-5e3a91f0"],
    ["..", "", "disk"],
    ["Città", "x", "Citta"],
  ])("label %j becomes %j", (label, uuid, want) => {
    expect(safeLabel(label, uuid)).toBe(want);
  });

  it("reads where udisks mounted a disk", () => {
    expect(parseUdisksMount("Mounted /dev/sda1 at /media/root/Eternatus\n")).toBe(
      "/media/root/Eternatus",
    );
    expect(parseUdisksMount("Error mounting")).toBeNull();
  });
});

describe("graphics cards (G39.3)", () => {
  it.each([
    [
      "01:00.0 VGA compatible controller: NVIDIA Corporation AD103 [GeForce RTX 4080 SUPER] (rev a1)",
      [{ maker: "nvidia", name: "NVIDIA GeForce RTX 4080 SUPER", vramGb: null }],
    ],
    [
      "00:02.0 VGA compatible controller: Intel Corporation Alder Lake-N [UHD Graphics]",
      [{ maker: "intel", name: "Intel UHD Graphics", vramGb: null }],
    ],
    [
      "03:00.0 Display controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31 [Radeon RX 7900 XTX] (rev c8)",
      [{ maker: "amd", name: "AMD Radeon RX 7900 XTX", vramGb: null }],
    ],
    ["00:1f.3 Audio device: Intel Corporation Device 54c8", []],
    ["", []],
  ])("lspci %j", (out, want) => {
    expect(parseLspci(out)).toEqual(want);
  });

  it("names cards from their PCI vendor when lspci is missing", () => {
    expect(drmGpus(["0x10de\n", "0x8086", "0x1af4", ""]).map((g) => g.maker)).toEqual([
      "nvidia",
      "intel",
      "other",
    ]);
  });

  it("reads nvidia-smi's names and memory", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 3060, 12288\nbroken\n")).toEqual([
      { maker: "nvidia", name: "NVIDIA GeForce RTX 3060", vramGb: 12 },
    ]);
  });
});

describe("virtual machine or container (G39.3)", () => {
  it.each([
    ["none\n", { kind: "none", name: "" }],
    ["kvm\n", { kind: "vm", name: "kvm" }],
    ["microsoft", { kind: "vm", name: "microsoft" }],
    ["oracle", { kind: "vm", name: "oracle" }],
    ["lxc\n", { kind: "container", name: "lxc" }],
    ["docker", { kind: "container", name: "docker" }],
    ["wsl", { kind: "container", name: "wsl" }],
    ["", { kind: "none", name: "" }],
  ])("systemd-detect-virt %j", (out, want) => {
    expect(parseDetectVirt(out)).toEqual(want);
  });

  it.each([
    [{ dockerenv: true, containerenv: false, cgroup: "" }, "docker"],
    [{ dockerenv: false, containerenv: true, cgroup: "" }, "podman"],
    [{ dockerenv: false, containerenv: false, cgroup: "0::/lxc/104/ns" }, "lxc"],
    [{ dockerenv: false, containerenv: false, cgroup: "0::/init.scope" }, undefined],
  ])("hints %j → %s", (h, want) => {
    expect(containerHint(h)?.name).toBe(want);
  });
});

describe("what to offer (G39.3)", () => {
  const s = (kind: Hardware["suggestion"]["kind"], maxModelGb: number) => ({
    engine: "cpu" as const,
    kind,
    maxModelGb,
    vramGb: 0,
  });
  it.each([
    ["2 GB of RAM on the processor", s("cpu", 1), { local: false, reason: "too_little_memory" }],
    ["8 GB of RAM", s("cpu", 4), { local: true, reason: "cpu", maxModelGb: 4 }],
    ["a 16 GB card", s("gpu", 12.8), { local: true, reason: "gpu", maxModelGb: 12.8 }],
    ["a card in the processor", s("igpu", 6), { local: true, reason: "cpu" }],
  ])("%s", (_, sug, want) => {
    const o = localOffer(sug);
    expect(o.cloud).toBe(true);
    expect(o).toMatchObject(want);
  });
});

describe("reading the machine (G39.3)", () => {
  const hw = {
    os: "linux",
    cpu: "Intel N100",
    cores: 4,
    ramGb: 16,
    freeRamGb: 10,
    disks: [],
    gpus: [],
    suggestion: s0(),
  } as unknown as Hardware;
  function s0() {
    return { engine: "cpu", kind: "cpu", maxModelGb: 6, vramGb: 0 };
  }
  it("says what is missing instead of guessing (no lsblk, no lspci, no detect-virt)", async () => {
    const info = await discoverSystem({
      hardware: hw,
      platform: "linux",
      run: async () => null,
      readFile: async () => null,
      exists: async () => false,
    });
    expect(info.disks).toEqual({ missing: "not_installed" });
    expect(info.virt).toEqual({ missing: "not_installed" });
    expect(info.ram.freeGb).toEqual({ missing: "unreadable" });
  });
  it("on Windows and Mac: no disks of its own, no virtual machine check", async () => {
    const info = await discoverSystem({ hardware: hw, platform: "darwin" });
    expect(info.disks).toEqual({ missing: "unsupported" });
    expect(info.virt).toEqual({ missing: "unsupported" });
    expect(info.ram.freeGb).toEqual({ value: 10 });
  });
  it("takes the helper's disks first (the host's, seen from a container)", async () => {
    const info = await discoverSystem({
      hardware: hw,
      platform: "linux",
      listDisks: async () => disks,
      run: async (file) => (file === "systemd-detect-virt" ? "kvm\n" : null),
      readFile: async (p) => (p === "/proc/meminfo" ? "MemAvailable: 8388608 kB\n" : null),
      exists: async () => false,
    });
    expect("value" in info.disks && info.disks.value.length).toBe(disks.length);
    expect(info.virt).toEqual({ value: { kind: "vm", name: "kvm" } });
    expect(info.ram.freeGb).toEqual({ value: 8 });
  });
});

describe("what already reaches the machine (G39.3)", () => {
  it.each([
    [
      JSON.stringify({
        BackendState: "Running",
        Self: { DNSName: "coder.tail1234.ts.net.", TailscaleIPs: ["100.64.0.7"] },
      }),
      { state: "running", name: "coder.tail1234.ts.net", ip: "100.64.0.7" },
    ],
    [JSON.stringify({ BackendState: "NeedsLogin" }), { state: "logged_out" }],
    [JSON.stringify({ BackendState: "Stopped" }), { state: "stopped" }],
    ["not json", { state: "absent" }],
  ])("tailscale %s", (json, want) => {
    expect(parseTailscaleStatus(json)).toEqual(want);
  });

  it("finds reverse proxies among the programs", () => {
    expect(proxiesRunning(["node\n", "nginx\n", "caddy", "nginx", "bash"])).toEqual([
      "caddy",
      "nginx",
    ]);
  });

  it.each([
    [{ "cf-connecting-ip": "1.2.3.4" }, "cloudflare"],
    [{ via: "1.1 Caddy" }, "caddy"],
    [{ "x-forwarded-for": "10.0.0.2" }, "proxy"],
    [{}, null],
  ])("a proxy in front: %j", (headers, want) => {
    const h = headers as Record<string, string>;
    expect(proxyInFront((n) => h[n])).toBe(want);
  });

  it.each([
    ["nameserver 192.168.1.2\n", "192.168.1.2"],
    ["# x\nnameserver 127.0.0.53\noptions edns0\n", null],
    ["nameserver 1.1.1.1\nnameserver 10.0.0.53\n", "10.0.0.53"],
    ["", null],
  ])("local DNS from %j", (text, want) => {
    expect(localDnsServer(text)).toBe(want);
  });

  it.each([
    ["redgiant.local:7600", "redgiant.local"],
    ["192.168.1.40:7600", null],
    ["[fe80::1]:7600", null],
    ["localhost:7600", null],
    [undefined, null],
  ])("host %s", (host, want) => {
    expect(hostName(host)).toBe(want);
  });
});

describe("the OS helper's requests (G39.3)", () => {
  it.each([
    [{ op: "list" as const }, "list"],
    [{ op: "mount" as const, uuid: "5E3A-91F0", label: "Eternatus" }, "mount 5E3A-91F0 Eternatus"],
    [{ op: "unmount" as const, label: "Eternatus" }, "unmount Eternatus"],
  ])("%j", (o, line) => {
    expect(helperRequest(o)).toBe(line);
  });

  it.each([
    { op: "mount" as const, uuid: "x; rm -rf /", label: "a" },
    { op: "mount" as const, uuid: "5E3A-91F0", label: "../etc" },
    { op: "mount" as const, uuid: "5E3A-91F0", label: ".hidden" },
    { op: "unmount" as const, label: "a b" },
    { op: "ssh-on" as const, key: "hunter2" },
    { op: "ssh-on" as const, key: "ssh-ed25519 AAAA\nssh-rsa BBBB" },
  ])("refuses %j", (o) => {
    expect(() => helperRequest(o)).toThrow();
  });

  it("accepts a public key and sends it as base64", () => {
    const k =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@rig";
    expect(sshPublicKey(`  ${k}\n`)).toBe(k);
    expect(helperRequest({ op: "ssh-on", key: k })).toBe(
      `ssh-on ${Buffer.from(k).toString("base64")}`,
    );
  });

  it("reads the replies, and a refusal as an error with its code", () => {
    expect(parseHelperReply('{"ok":true,"path":"/x"}\n')).toMatchObject({ path: "/x" });
    expect(() => parseHelperReply('{"ok":false,"error":"system_disk"}')).toThrow("system_disk");
    expect(() => parseHelperReply("sudo: a password is required")).toThrow();
  });
});

describe("the privileged helper refuses before doing anything", () => {
  const helper = fileURLToPath(new URL("../helpers/redgiant-helper", import.meta.url));
  const ask = (line: string) =>
    new Promise<string>((resolve) => {
      const p = execFile("sh", [helper, "--stdin"], (_err, out) => resolve(String(out).trim()));
      p.stdin?.end(`${line}\n`);
    });
  it.each([
    ["mount 5E3A-91F0 ../etc", "bad_request"],
    ["mount x;id y", "bad_request"],
    ["mount $(id) y", "bad_request"],
    ["mount 5E3A-91F0", "bad_request"],
    ["unmount .ssh", "bad_request"],
    ["rm -rf /", "unknown_op"],
    ["ssh-on not*base64", "bad_request"],
  ])("%s", { skip: process.platform === "win32" }, async (line, code) => {
    expect(await ask(line)).toBe(`{"ok":false,"error":"${code}"}`);
  });
});

// RedGiant OS on Proxmox (G39.2): the host's helper script (redgiant-proxmox.sh) against stand-ins
// for Proxmox's commands. It must check the signature and the checksum before changing anything,
// never use an id that is taken, and create the machine it says it creates.
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { RELEASE_PUBLIC_KEY } from "../../../packages/server/src/release-key.js";

const script = fileURLToPath(new URL("../proxmox/redgiant-proxmox.sh", import.meta.url));
const linux = process.platform === "linux" && spawnSync("openssl", ["version"]).status === 0;
const VERSION = "9.9.9";
const QCOW2 = `redgiant-os-${VERSION}-x86_64.qcow2`;
const LXC = `redgiant-os-${VERSION}-x86_64-lxc.tar.zst`;

// Proxmox's commands: each writes its arguments to calls.log; ids 100 and 101 are taken.
const STUBS: Record<string, string> = {
  pvesh: `case "$*" in
  "get /cluster/nextid") echo 102 ;;
  "get /cluster/nextid --vmid 100"|"get /cluster/nextid --vmid 101") echo "VM $4 already exists" >&2; exit 2 ;;
  "get /cluster/nextid --vmid "*) echo "$4" ;;
  *) exit 1 ;;
esac`,
  pvesm: `case "$*" in
  "status --content images"|"status --content rootdir") printf 'Name Type Status Total Used Available %%\\nlocal-zfs zfspool active 1 1 1 1%%\\nlocal-lvm lvmthin active 1 1 1 1%%\\nslow dir disabled 0 0 0 0%%\\n' ;;
  "status --content vztmpl") printf 'Name Type Status Total Used Available %%\\nlocal dir active 1 1 1 1%%\\n' ;;
  "path local:vztmpl/"*) echo "$STUB_DIR/templates/\${2#local:vztmpl/}" ;;
  *) exit 1 ;;
esac`,
  ip: `[ "$4" = vmbr0 ] || [ "$4" = vmbr1 ]`,
  qm: `case "$1 $2" in
  "guest cmd") echo '[{"name":"lo","ip-addresses":[{"ip-address-type":"ipv4","ip-address":"127.0.0.1"}]},{"name":"eth0","ip-addresses":[{"ip-address-type":"ipv4","ip-address":"192.0.2.7"}]}]' ;;
  "guest exec") echo '{"exitcode":0,"exited":1,"out-data":"ABCD-1234\\n"}' ;;
esac`,
  pct: `case "$1" in
  exec) case "$*" in *setup-code*) echo "WXYZ-9876" ;; *) echo "2: eth0    inet 192.0.2.8/24 brd 192.0.2.255 scope global eth0" ;; esac ;;
esac`,
  curl: `case "$*" in *api/health*) echo '{"ok":true}' ;; *) echo "no network in tests" >&2; exit 7 ;; esac`,
};

describe.skipIf(!linux)("redgiant-proxmox.sh", () => {
  let dir: string;
  let from: string;
  let key: string;
  let priv: string;

  const sums = (files: Record<string, string>) =>
    Object.entries(files)
      .map(([name, body]) => `${createHash("sha256").update(body).digest("hex")}  ${name}\n`)
      .join("");
  const release = (files: Record<string, string>, signWith = priv) => {
    const list = sums(files);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(from, name), body);
    writeFileSync(join(from, "SHA256SUMS-os"), list);
    writeFileSync(
      join(from, "SHA256SUMS-os.sig"),
      sign("sha256", Buffer.from(list), signWith).toString("base64"),
    );
  };
  const proxmox = (...args: string[]) => {
    const r = spawnSync("bash", [script, "--from", from, "--key", key, "--yes", ...args], {
      encoding: "utf8",
      env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, STUB_DIR: dir, TMPDIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let calls = "";
    try {
      calls = readFileSync(join(dir, "calls.log"), "utf8");
    } catch {}
    return { status: r.status, out: r.stdout + r.stderr, calls };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rg-proxmox-"));
    from = join(dir, "from");
    mkdirSync(from);
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "templates"));
    for (const [name, body] of Object.entries(STUBS)) {
      const f = join(dir, "bin", name);
      writeFileSync(f, `#!/bin/bash\necho "${name} $*" >> "$STUB_DIR/calls.log"\n${body}\n`);
      chmodSync(f, 0o755);
    }
    // id -u: root, as on the Proxmox host.
    writeFileSync(join(dir, "bin", "id"), "#!/bin/sh\necho 0\n");
    chmodSync(join(dir, "bin", "id"), 0o755);
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    priv = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    key = join(dir, "key.pem");
    writeFileSync(key, pair.publicKey.export({ type: "spki", format: "pem" }).toString());
    release({ [QCOW2]: "a qcow2", [LXC]: "a template" });
  });

  it("carries RedGiant's update key", () => {
    const body = readFileSync(script, "utf8");
    expect(body).toContain(RELEASE_PUBLIC_KEY);
  });

  it("creates a UEFI virtual machine from the checked qcow2, on the next free id", () => {
    const r = proxmox("--vm", "--disk", "64");
    expect(r.status, r.out).toBe(0);
    const create = r.calls.split("\n").find((l) => l.startsWith("qm create")) ?? "";
    expect(create).toMatch(/^qm create 102 /);
    for (const part of [
      "--machine q35",
      "--bios ovmf",
      "pre-enrolled-keys=1",
      "--scsihw virtio-scsi-single",
      "--net0 virtio,bridge=vmbr0",
      "--agent enabled=1",
    ])
      expect(create).toContain(part);
    // The default storage is local-lvm, the disk imported from the qcow2 that was checked.
    expect(create).toMatch(new RegExp(`--scsi0 local-lvm:0,import-from=\\S+/${QCOW2}`));
    expect(r.calls).toContain("qm resize 102 scsi0 64G");
    expect(r.calls).toContain("qm start 102");
    expect(r.out).toContain("http://192.0.2.7:7600");
    expect(r.out).toContain("ABCD-1234");
  });

  it("creates an unprivileged container with nesting and keyctl from the checked template", () => {
    const r = proxmox("--lxc", "--storage", "local-zfs", "--bridge", "vmbr1", "--vlan", "20");
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(dir, "templates", LXC), "utf8")).toBe("a template");
    const create = r.calls.split("\n").find((l) => l.startsWith("pct create")) ?? "";
    expect(create).toMatch(
      new RegExp(`^pct create 102 local:vztmpl/${LXC.replace(/\./g, "\\.")} `),
    );
    for (const part of [
      "--unprivileged 1",
      "--features nesting=1,keyctl=1",
      "--ostype unmanaged",
      "--rootfs local-zfs:32",
      "--net0 name=eth0,bridge=vmbr1,tag=20,ip=dhcp",
    ])
      expect(create).toContain(part);
    expect(r.out).toContain("http://192.0.2.8:7600");
    expect(r.out).toContain("WXYZ-9876");
  });

  it("only shows what it would do with --dry-run", () => {
    const r = proxmox("--lxc", "--dry-run");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/\+ pct create 102 /);
    expect(r.calls).not.toMatch(/^pct /m);
    expect(() => readFileSync(join(dir, "templates", LXC))).toThrow();
  });

  it.each([
    ["an id that is taken", ["--id", "101"], /id 101 is taken/],
    ["a storage that does not exist", ["--storage", "nowhere"], /storage 'nowhere'/],
    ["a disabled storage", ["--storage", "slow"], /storage 'slow'/],
    ["a bridge that does not exist", ["--bridge", "vmbr9"], /no bridge vmbr9/],
    ["a disk smaller than the image", ["--disk", "20"], /32 or more/],
    ["a strange name", ["--name", "a;b"], /--name/],
  ])("refuses %s and changes nothing", (_what, args, error) => {
    const r = proxmox("--vm", ...args);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(error);
    expect(r.calls).not.toMatch(/^(qm|pct) (create|start|resize)/m);
  });

  it("refuses a SHA256SUMS-os signed by another key", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    release(
      { [QCOW2]: "a qcow2" },
      other.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    const r = proxmox("--vm");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("not signed by RedGiant's update key");
    expect(r.calls).not.toMatch(/^qm create/m);
  });

  it("refuses an image that does not match SHA256SUMS-os", () => {
    writeFileSync(join(from, QCOW2), "something else");
    const r = proxmox("--vm");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("does not match SHA256SUMS-os");
    expect(r.calls).not.toMatch(/^qm create/m);
  });
});

// RedGiant OS (G39.2): the OVA that VirtualBox and VMware import (formats/vm.py): the descriptor,
// the manifest and the disk in that order, and a check that refuses what they would refuse.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const vm = fileURLToPath(new URL("../formats/vm.py", import.meta.url));
const python = ["python3", "python"].find((p) => spawnSync(p, ["--version"]).status === 0);

describe.skipIf(!python)("formats/vm.py", () => {
  const run = (...args: string[]) => {
    const r = spawnSync(python as string, [vm, ...args], {
      encoding: "utf8",
      env: { ...process.env, SOURCE_DATE_EPOCH: "1763000000" },
    });
    return { status: r.status, out: r.stdout + r.stderr };
  };
  const ova = (disk: Buffer) => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ova-"));
    writeFileSync(join(dir, "d.vmdk"), disk);
    const out = join(dir, "x.ova");
    const r = run(
      "ova",
      "--vmdk",
      join(dir, "d.vmdk"),
      "--name",
      "redgiant-os-9.9.9-x86_64",
      "--capacity",
      String(32 * 2 ** 30),
      "--out",
      out,
    );
    expect(r.status, r.out).toBe(0);
    return out;
  };
  const vmdk = Buffer.concat([Buffer.from("KDMV"), Buffer.alloc(4096, 1)]);

  it("makes an OVA its own check accepts, the same bytes every time", () => {
    const a = ova(vmdk);
    const r = run("check-ova", a);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("capacity 32 GiB");
    expect(readFileSync(ova(vmdk)).equals(readFileSync(a))).toBe(true);
    const text = readFileSync(a, "latin1");
    for (const part of [
      "lsilogic",
      "E1000",
      'vmw:key="firmware" vmw:value="efi"',
      "streamOptimized",
    ])
      expect(text).toContain(part);
  });

  it("refuses an OVA whose disk is not the one in the manifest", () => {
    const a = ova(vmdk);
    const bytes = readFileSync(a);
    bytes[bytes.indexOf("KDMV") + 1000] ^= 0xff;
    writeFileSync(a, bytes);
    const r = run("check-ova", a);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("manifest");
  });

  it("refuses a disk that is not a VMDK", () => {
    const r = run("check-ova", ova(Buffer.alloc(4096, 2)));
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("not a VMDK");
  });

  it("zips one file that Windows opens", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-zip-"));
    writeFileSync(join(dir, "a.vhdx"), "vhdxfile".repeat(1000));
    expect(run("zip", join(dir, "a.vhdx"), join(dir, "a.zip")).status).toBe(0);
    const z = readFileSync(join(dir, "a.zip"));
    expect(z.subarray(0, 4).toString("latin1")).toBe("PK\u0003\u0004");
    expect(z.includes(Buffer.from("a.vhdx"))).toBe(true);
  });
});

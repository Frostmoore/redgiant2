import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackupSettings } from "@redgiant/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackupScheduler,
  backupDue,
  folderFor,
  lastSlot,
  MADE_FILE,
  nextSlot,
  toPrune,
} from "../src/backup-schedule.js";
import { FirstBoot, folderRefusal } from "../src/firstboot.js";
import type { OsHelper } from "../src/os-helper.js";
import { HelperError } from "../src/os-helper.js";
import { type SetupHooks, SetupService } from "../src/setup.js";
import { lanAddresses, newSetupCode, normalizeCode, SetupCode } from "../src/setup-code.js";
import { startServer, TOKEN } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
  vi.restoreAllMocks();
});

const hooks: SetupHooks = {
  key: async () => [],
  server: async () => [],
  telegram: async () => null,
  search: async () => {},
  engine: async () => {},
};

/** A USB disk «Eternatus» and the system's NVMe disk, as the helper lists them. */
const LSBLK = {
  blockdevices: [
    {
      name: "nvme0n1",
      type: "disk",
      size: 512e9,
      rm: false,
      tran: "nvme",
      children: [
        {
          name: "nvme0n1p2",
          type: "part",
          size: 511e9,
          fstype: "ext4",
          uuid: "1111-2222",
          mountpoint: "/",
        },
      ],
    },
    {
      name: "sda",
      type: "disk",
      size: 2e12,
      rm: false,
      hotplug: true,
      tran: "usb",
      children: [
        {
          name: "sda1",
          type: "part",
          size: 2e12,
          fstype: "exfat",
          label: "Eternatus",
          uuid: "5E3A-91F0",
        },
      ],
    },
  ],
};

function fakeHelper(mountedAt: string, calls: string[]): OsHelper {
  return {
    how: "socket",
    call: async (o) => {
      calls.push(o.op === "mount" ? `mount ${o.uuid} ${o.label}` : o.op);
      if (o.op === "list") return { ok: true, lsblk: LSBLK };
      if (o.op === "mount") return { ok: true, path: mountedAt };
      if (o.op === "ssh-status") return { ok: true, on: false, keys: 0 };
      if (o.op === "tailscale") throw new HelperError("not_installed");
      return { ok: true };
    },
  };
}

async function withSetup(firstBoot?: (dir: string) => FirstBoot) {
  let setup: SetupService | undefined;
  s = await startServer([], {}, {}, undefined, undefined, async (core, dir) => {
    setup = new SetupService({
      db: core.db,
      core,
      dataDir: join(dir, "data"),
      ownerId: "me",
      hooks,
      ...(firstBoot && { firstBoot: firstBoot(dir) }),
    });
    await setup.applyAtStartup();
    return { setup };
  });
  return setup as SetupService;
}

const anon = async (method: string, path: string, body?: unknown, from = "192.168.1.77") => {
  const r = await fetch(`${s?.url}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": from },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe("the one-time setup code (G39.3)", () => {
  it("makes readable codes and takes them typed loosely", () => {
    let i = 0;
    const code = newSetupCode(() => i++ % 31);
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/);
    expect(normalizeCode(" abcde fghjk ")).toBe("ABCDEFGHJK");
    expect(normalizeCode("abcde-fghjk")).toBe("ABCDEFGHJK");
  });

  it("lists the machine's network addresses, not loopback or container bridges", () => {
    const a = (address: string, internal = false) =>
      ({ address, family: "IPv4", internal }) as never;
    expect(
      lanAddresses({
        lo: [a("127.0.0.1", true)],
        eth0: [a("192.168.1.40")],
        docker0: [a("172.17.0.1")],
        "br-1a2b": [a("172.18.0.1")],
        wlan0: [a("169.254.3.3"), a("10.0.0.5")],
      }),
    ).toEqual(["192.168.1.40", "10.0.0.5"]);
  });

  it("counts wrong codes like wrong passwords and works once", async () => {
    let now = 0;
    const dir = await mkdtemp(join(tmpdir(), "rg-code-"));
    const c = new SetupCode({ dataDir: dir, now: () => now });
    expect(await c.use("x", "a")).toBe("none");
    const code = await c.issue();
    expect((await readFile(join(dir, "setup-code.txt"), "utf8")).trim()).toBe(code);
    expect(((await stat(join(dir, "setup-code.txt"))).mode & 0o777).toString(8)).toBe("600");
    for (let i = 0; i < 5; i++) expect(await c.use("WRONG-CODE0", "a")).toBe("wrong");
    expect(await c.use(code, "a")).toBe("too_many");
    now += 16 * 60_000;
    expect(await c.use(code.toLowerCase(), "a")).toBe("ok");
    expect(c.active).toBe(false);
    expect(await c.use(code, "a")).toBe("none");
    await expect(stat(join(dir, "setup-code.txt"))).rejects.toThrow();
  });

  it("over HTTP: no wizard on the network without the code; the code opens one session", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const setup = await withSetup();
    // Nothing issued yet (the installer opened the page with its token): no code to try.
    expect((await anon("POST", "/api/auth/setup-code", { code: "AAAAA-BBBBB" })).body.code).toBe(
      "none",
    );
    const code = (await setup.startSetupCode(7600, false)) as string;
    expect(code).toMatch(/^\w{5}-\w{5}$/);
    expect((await anon("GET", "/api/auth/methods")).body).toMatchObject({ setupCode: true });
    // The wizard itself stays closed to a page without a credential.
    expect((await anon("GET", "/api/setup")).status).toBe(401);
    expect((await anon("PUT", "/api/setup/role", { role: "node" })).status).toBe(401);
    expect((await anon("POST", "/api/auth/setup-code", { code: "AAAAA-BBBBB" })).body.code).toBe(
      "wrong",
    );
    const ok = await anon("POST", "/api/auth/setup-code", { code });
    expect(ok.status).toBe(200);
    const token = ok.body.token as string;
    const as = (method: string, path: string, body?: unknown) =>
      fetch(`${s?.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    expect((await as("GET", "/api/setup")).status).toBe(200);
    // Used once.
    expect((await anon("POST", "/api/auth/setup-code", { code })).body.code).toBe("none");
    // The wizard's password step keeps the page signed in, then signing in is the usual one.
    expect((await as("PUT", "/api/auth/password", { password: "una-password-lunga" })).status).toBe(
      200,
    );
    expect((await as("GET", "/api/setup")).status).toBe(200);
    expect((await anon("GET", "/api/auth/methods")).body).toMatchObject({
      password: true,
      setupCode: false,
    });
    // A start with a password, or after the wizard, has no code.
    expect(await setup.startSetupCode(7600, true)).toBeNull();
    await setup.startSetupCode(7600, false);
    await setup.complete();
    expect(setup.setupCode.active).toBe(false);
    expect(await setup.startSetupCode(7600, false)).toBeNull();
  });
});

describe("the role (G39.3)", () => {
  it("is chosen freely in the wizard, and changed afterwards only with a confirmation", async () => {
    const setup = await withSetup();
    expect((await s?.api("PUT", "/api/setup/role", { role: "node" }))?.status).toBe(200);
    expect(setup.backups).toBeUndefined();
    expect(
      (await s?.api<{ config: { role: string } }>("GET", "/api/setup"))?.body.config.role,
    ).toBe("node");
    await setup.complete();
    const refused = await s?.api<{ code: string }>("PUT", "/api/setup/role", { role: "full" });
    expect(refused?.body.code).toBe("confirm_needed");
    expect((await s?.api("PUT", "/api/setup/role", { role: "full", confirm: true }))?.status).toBe(
      200,
    );
    expect(
      (await s?.api<{ config: { role: string } }>("GET", "/api/setup"))?.body.config.role,
    ).toBe("full");
    expect((await s?.api("PUT", "/api/setup/role", { role: "god" }))?.status).toBe(400);
  });
});

describe("where backups go (G39.3)", () => {
  it.each([
    ["relative", "backups", "not_absolute"],
    ["the root", "/", "system"],
    ["a system folder", "/etc/redgiant", "system"],
    ["inside the data", "/data/redgiant/x", "data"],
    ["the data itself", "/data/redgiant/", "data"],
    ["a disk of the person's", "/mnt/nas/redgiant", null],
    ["a home folder", "/home/me/Backups", null],
  ])("a folder: %s", (_, path, want) => {
    expect(folderRefusal(path, "/data/redgiant")).toBe(want);
  });

  it("mounts only the removable disk picked, through the helper, and never a system disk", async () => {
    const calls: string[] = [];
    const mnt = await mkdtemp(join(tmpdir(), "rg-mnt-"));
    await withSetup(
      (dir) => new FirstBoot({ dataDir: join(dir, "data"), helper: fakeHelper(mnt, calls) }),
    );
    const storage = await s?.api<{
      method: string;
      candidates: { uuid: string; usable: boolean; target?: string }[];
      backups: unknown;
    }>("GET", "/api/setup/storage");
    expect(storage?.body.method).toBe("helper");
    expect(storage?.body.candidates.map((c) => [c.uuid, c.usable, c.target])).toEqual([
      ["5E3A-91F0", true, "/var/lib/redgiant/backups/Eternatus"],
    ]);
    const system = await s?.api<{ code: string }>("POST", "/api/setup/backups/disk", {
      uuid: "1111-2222",
    });
    expect(system?.body.code).toBe("not_removable");
    const absent = await s?.api<{ code: string }>("POST", "/api/setup/backups/disk", {
      uuid: "ABCD-0000",
    });
    expect(absent?.body.code).toBe("not_found");
    expect(calls.filter((c) => c.startsWith("mount"))).toEqual([]);
    const ok = await s?.api<BackupSettings>("POST", "/api/setup/backups/disk", {
      uuid: "5E3A-91F0",
    });
    expect(ok?.body.destination).toEqual({
      kind: "disk",
      uuid: "5E3A-91F0",
      label: "Eternatus",
      path: mnt,
    });
    expect(ok?.body.schedule).toEqual({ every: "daily", hour: 3, keep: 7 });
    expect(calls).toContain("mount 5E3A-91F0 Eternatus");
    const weekly = await s?.api<BackupSettings>("PUT", "/api/setup/backups", {
      schedule: { every: "weekly", weekday: 0, hour: 2, keep: 4 },
    });
    expect(weekly?.body.schedule).toEqual({ every: "weekly", weekday: 0, hour: 2, keep: 4 });
    expect(weekly?.body.destination).toMatchObject({ kind: "disk" });
  });

  it("says when disks cannot be mounted here, and takes a folder instead", async () => {
    const out = await mkdtemp(join(tmpdir(), "rg-out-"));
    await withSetup(
      (dir) =>
        new FirstBoot({
          dataDir: join(dir, "data"),
          platform: "linux",
          run: async (file) => (file === "lsblk" ? JSON.stringify(LSBLK) : null),
          exists: async () => false,
        }),
    );
    const storage = await s?.api<{ method: string }>("GET", "/api/setup/storage");
    expect(storage?.body.method).toBe("none");
    const disk = await s?.api<{ code: string }>("POST", "/api/setup/backups/disk", {
      uuid: "5E3A-91F0",
    });
    expect(disk?.body.code).toBe("cannot_mount");
    const sys = await s?.api<{ code: string }>("PUT", "/api/setup/backups/folder", {
      path: "/usr/x",
    });
    expect(sys?.body.code).toBe("folder_system");
    const ok = await s?.api<BackupSettings>("PUT", "/api/setup/backups/folder", { path: out });
    expect(ok?.body.destination).toEqual({ kind: "folder", path: out });
    const ssh = await s?.api<{ available: boolean }>("GET", "/api/setup/ssh");
    expect(ssh?.body).toEqual({ available: false });
    expect(
      (await s?.api<{ code: string }>("PUT", "/api/setup/ssh", { on: true, key: "x" }))?.body.code,
    ).toBe("cannot_ssh");
  });

  it("what reaches the machine: a proxy in front is seen in the request", async () => {
    const calls: string[] = [];
    await withSetup(
      (dir) =>
        new FirstBoot({
          dataDir: join(dir, "data"),
          helper: fakeHelper("/x", calls),
          platform: "win32",
        }),
    );
    const r = await fetch(`${s?.url}/api/setup/net`, {
      headers: { authorization: `Bearer ${TOKEN}`, "cf-ray": "abc", host: "redgiant.example.org" },
    });
    expect(await r.json()).toMatchObject({
      tailscale: { state: "absent" },
      proxyInFront: "cloudflare",
      proxiesRunning: [],
    });
  });
});

describe("scheduled backups (G39.3)", () => {
  const at = (s: string) => new Date(s);
  const daily = { every: "daily" as const, hour: 3, keep: 3 };
  const weekly = { every: "weekly" as const, hour: 3, weekday: 0, keep: 3 };

  it.each([
    ["daily, after 3:00", daily, "2026-11-12T10:00:00", "2026-11-12T03:00:00"],
    ["daily, before 3:00", daily, "2026-11-12T02:00:00", "2026-11-11T03:00:00"],
    ["weekly on Sunday, a Thursday", weekly, "2026-11-12T10:00:00", "2026-11-08T03:00:00"],
    ["weekly, Sunday before 3:00", weekly, "2026-11-15T01:00:00", "2026-11-08T03:00:00"],
  ])("the last slot: %s", (_, sch, now, want) => {
    expect(lastSlot(sch, at(now))?.getTime()).toBe(at(want).getTime());
  });

  it("is due once per slot, not the moment it is set, and never when off", () => {
    expect(backupDue(daily, at("2026-11-12T15:00:00"), at("2026-11-12T16:00:00"))).toBe(false);
    expect(backupDue(daily, at("2026-11-12T15:00:00"), at("2026-11-13T03:05:00"))).toBe(true);
    expect(backupDue(daily, at("2026-11-13T03:05:00"), at("2026-11-13T09:00:00"))).toBe(false);
    expect(backupDue({ ...daily, every: "off" }, at("2000-01-01"), at("2026-11-13"))).toBe(false);
    expect(nextSlot(daily, at("2026-11-12T10:00:00"))?.getTime()).toBe(
      at("2026-11-13T03:00:00").getTime(),
    );
  });

  it("removes only its own oldest folders", () => {
    expect(
      toPrune(
        [
          "RedGiant-backup-2026-11-10",
          "RedGiant-backup-2026-11-12",
          "RedGiant-backup-2026-11-12-2",
          "RedGiant-backup-2026-11-11",
          "something-else",
        ],
        2,
      ),
    ).toEqual(["RedGiant-backup-2026-11-10", "RedGiant-backup-2026-11-11"]);
    expect(toPrune(["RedGiant-backup-2026-11-10"], 0)).toEqual([]);
    expect(folderFor(at("2026-11-12T10:00:00"), (n) => n === "RedGiant-backup-2026-11-12")).toBe(
      "RedGiant-backup-2026-11-12-2",
    );
  });

  it("runs at the hour on the service's clock, keeps the chosen number, says when the disk is gone", async () => {
    const dest = await mkdtemp(join(tmpdir(), "rg-sched-"));
    // A folder of the person's own with the same kind of name is never touched.
    await writeFile(join(dest, "keep-me.txt"), "x");
    let now = at("2026-11-12T15:00:00").getTime();
    let settings: BackupSettings & { setAt?: string } = {
      destination: { kind: "folder", path: dest },
      schedule: { every: "daily", hour: 3, keep: 2 },
      setAt: new Date(now).toISOString(),
    };
    let present = true;
    const sch = new BackupScheduler({
      settings: () => settings,
      record: async (last) => {
        settings = { ...settings, last };
      },
      prepare: async (b) => {
        if (!present) throw new Error("The disk Eternatus is not connected");
        return b.destination?.path ?? "";
      },
      backup: async (file) => writeFile(file, "backup"),
      version: () => "3.7.0",
      now: () => now,
    });
    expect(await sch.tick()).toBe("idle");
    for (let day = 13; day <= 16; day++) {
      now = at(`2026-11-${day}T03:01:00`).getTime();
      expect(await sch.tick()).toBe("ran");
      expect(await sch.tick()).toBe("idle");
    }
    const folders = (await readdir(dest)).filter((f) => f.startsWith("RedGiant-backup-")).sort();
    expect(folders).toEqual(["RedGiant-backup-2026-11-15", "RedGiant-backup-2026-11-16"]);
    expect(await readdir(join(dest, "RedGiant-backup-2026-11-16"))).toEqual([
      "redgiant-3.7.0-0301.rgbackup",
    ]);
    expect(await readdir(dest)).toEqual(expect.arrayContaining(["keep-me.txt", MADE_FILE]));
    expect(settings.last).toMatchObject({
      ok: true,
      file: join("RedGiant-backup-2026-11-16", "redgiant-3.7.0-0301.rgbackup"),
    });
    present = false;
    now = at("2026-11-17T03:01:00").getTime();
    expect(await sch.tick()).toBe("failed");
    expect(settings.last).toMatchObject({
      ok: false,
      error: "The disk Eternatus is not connected",
    });
  });
});

// Backups anywhere (p3.7.2): the same destinations wherever RedGiant runs. The rules are pure
// functions tested as tables (the Proxmox host's commands, SMB addresses and smbclient's output);
// SFTP goes to an ssh2 server in this process, SMB to a fake smbclient on a temporary folder (no
// network), and «Fallo tu» runs on a fake Proxmox host whose programs only write what they were
// asked. No password reaches an argument, a log, an event or an answer.
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BackupEntry,
  BackupSettings,
  Job,
  MachineTest,
  MachineView,
  PermissionRequestInfo,
} from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BackupScheduler } from "../src/backup-schedule.js";
import { MADE_FILE, sftpFolder, smbTarget } from "../src/backup-targets.js";
import { FirstBoot } from "../src/firstboot.js";
import {
  FSTAB_SCRIPT,
  firstFreeMp,
  guessContainer,
  hostCandidates,
  lineOf,
  parsePctConfig,
  parsePctList,
  proxmoxPlan,
  proxmoxVersion,
} from "../src/proxmox-mount.js";
import { type SetupHooks, SetupService } from "../src/setup.js";
import {
  authFile,
  parseSmbAddress,
  parseSmbLs,
  type SmbRun,
  smbFailure,
  smbLoginRefusal,
} from "../src/smb.js";
import { type FakeSsh, fakeSsh } from "./fake-ssh.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
const fakes: FakeSsh[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await s?.close();
  s = undefined;
  for (const f of fakes.splice(0)) await f.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
}, 30_000);

const temp = async (p: string) => {
  const d = await mkdtemp(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

async function until<T>(
  f: () => Promise<T | undefined | false> | T | undefined | false,
  ms = 20_000,
) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const hooks: SetupHooks = {
  key: async () => [],
  server: async () => [],
  telegram: async () => null,
  search: async () => {},
  engine: async () => {},
};

// ---------------------------------------------------------------- the Proxmox host's commands

describe("the Proxmox host's commands (pure, p3.7.2)", () => {
  const base = {
    ctid: "105",
    device: "/dev/sdb1",
    name: "Tech",
    mp: 1,
    unprivileged: true,
    fstype: "ext4",
    mountedAt: "",
  };
  const lines = (p: ReturnType<typeof proxmoxPlan>) =>
    p.ok ? p.steps.map((x) => lineOf(x.argv)) : p.why;

  it.each([
    [
      "an ext4 disk, unprivileged container",
      base,
      [
        "'mkdir' '-p' '/mnt/redgiant-backups/Tech'",
        "'mount' '/dev/sdb1' '/mnt/redgiant-backups/Tech'",
        `'sh' '-c' '${FSTAB_SCRIPT.replace(/'/g, "'\\''")}' 'sh' '/dev/sdb1' '/mnt/redgiant-backups/Tech' 'defaults' '/etc/fstab'`,
        "'mkdir' '-p' '/mnt/redgiant-backups/Tech/RedGiant'",
        "'chown' '100000:100000' '/mnt/redgiant-backups/Tech/RedGiant'",
        "'pct' 'set' '105' '-mp1' '/mnt/redgiant-backups/Tech/RedGiant,mp=/var/lib/redgiant/backups/Tech'",
      ],
    ],
    [
      "a privileged container: no chown",
      { ...base, unprivileged: false, mp: 0 },
      [
        "'mkdir' '-p' '/mnt/redgiant-backups/Tech'",
        "'mount' '/dev/sdb1' '/mnt/redgiant-backups/Tech'",
        `'sh' '-c' '${FSTAB_SCRIPT.replace(/'/g, "'\\''")}' 'sh' '/dev/sdb1' '/mnt/redgiant-backups/Tech' 'defaults' '/etc/fstab'`,
        "'mkdir' '-p' '/mnt/redgiant-backups/Tech/RedGiant'",
        "'pct' 'set' '105' '-mp0' '/mnt/redgiant-backups/Tech/RedGiant,mp=/var/lib/redgiant/backups/Tech'",
      ],
    ],
    [
      "exFAT: the owner is a mount option",
      { ...base, fstype: "exfat" },
      [
        "'mkdir' '-p' '/mnt/redgiant-backups/Tech'",
        "'mount' '-o' 'uid=100000,gid=100000,umask=0022' '/dev/sdb1' '/mnt/redgiant-backups/Tech'",
        `'sh' '-c' '${FSTAB_SCRIPT.replace(/'/g, "'\\''")}' 'sh' '/dev/sdb1' '/mnt/redgiant-backups/Tech' 'uid=100000,gid=100000,umask=0022' '/etc/fstab'`,
        "'mkdir' '-p' '/mnt/redgiant-backups/Tech/RedGiant'",
        "'pct' 'set' '105' '-mp1' '/mnt/redgiant-backups/Tech/RedGiant,mp=/var/lib/redgiant/backups/Tech'",
      ],
    ],
    [
      "already mounted by the host: used where it is",
      { ...base, mountedAt: "/media/usb", unprivileged: false },
      [
        "'mkdir' '-p' '/media/usb/RedGiant'",
        "'pct' 'set' '105' '-mp1' '/media/usb/RedGiant,mp=/var/lib/redgiant/backups/Tech'",
      ],
    ],
    [
      "no filesystem, formatting asked",
      { ...base, fstype: "", format: true, unprivileged: false },
      [
        "'mkfs.ext4' '-F' '-L' 'Tech' '/dev/sdb1'",
        "'mkdir' '-p' '/mnt/redgiant-backups/Tech'",
        "'mount' '/dev/sdb1' '/mnt/redgiant-backups/Tech'",
        `'sh' '-c' '${FSTAB_SCRIPT.replace(/'/g, "'\\''")}' 'sh' '/dev/sdb1' '/mnt/redgiant-backups/Tech' 'defaults' '/etc/fstab'`,
        "'mkdir' '-p' '/mnt/redgiant-backups/Tech/RedGiant'",
        "'pct' 'set' '105' '-mp1' '/mnt/redgiant-backups/Tech/RedGiant,mp=/var/lib/redgiant/backups/Tech'",
      ],
    ],
    ["no filesystem, not asked to format", { ...base, fstype: "" }, "needs_format"],
    ["formatting a disk that has a filesystem", { ...base, format: true }, "has_filesystem"],
    ["ZFS's member disk", { ...base, fstype: "zfs_member" }, "unsupported_filesystem"],
    ["mounted as the host's system", { ...base, mountedAt: "/" }, "system_disk"],
    ["mounted under /var", { ...base, mountedAt: "/var/lib/vz" }, "system_disk"],
    ["a device with a command in it", { ...base, device: "/dev/sdb1;reboot" }, "bad_device"],
    ["a device outside /dev", { ...base, device: "/etc/passwd" }, "bad_device"],
    ["a device climbing out", { ...base, device: "/dev/../etc/shadow" }, "bad_device"],
    ["a name that climbs", { ...base, name: "../etc" }, "bad_name"],
    ["a name with a space and quote", { ...base, name: "a b'" }, "bad_name"],
    ["an id that is not one", { ...base, ctid: "105 && reboot" }, "bad_id"],
    ["a too small id", { ...base, ctid: "5" }, "bad_id"],
    ["a mount point out of range", { ...base, mp: 256 }, "bad_mp"],
  ])("%s", (_, input, want) => {
    expect(lines(proxmoxPlan(input))).toEqual(want);
  });

  it("reads Proxmox's answers: its version, the containers, the free mount point, which one is this", () => {
    expect(
      proxmoxVersion("pve-manager/8.2.4/faa83925c9641325 (running kernel: 6.8.12-1-pve)"),
    ).toBe("8.2.4");
    expect(proxmoxVersion("bash: pveversion: command not found")).toBeNull();
    const list = parsePctList(
      [
        "VMID       Status     Lock         Name",
        "104        running                 officina-docker",
        "105        running                 coder",
        "106        stopped    backup       old",
      ].join("\n"),
    );
    expect(list).toEqual([
      { id: "104", status: "running", name: "officina-docker" },
      { id: "105", status: "running", name: "coder" },
      { id: "106", status: "stopped", name: "old" },
    ]);
    expect(guessContainer(list, "coder")).toBe("105");
    expect(guessContainer(list, "Coder.home.lan")).toBe("105");
    expect(guessContainer(list, "nothing")).toBeNull();
    expect(guessContainer([...list, { id: "107", name: "coder" }], "coder")).toBeNull();
    const conf = parsePctConfig(
      [
        "arch: amd64",
        "hostname: coder",
        "mp0: /mnt/data,mp=/data",
        "mp2: local-lvm:vm-105-disk-1,mp=/var/lib/redgiant/backups/old,size=8G",
        "rootfs: local-lvm:vm-105-disk-0,size=32G",
        "unprivileged: 1",
      ].join("\n"),
    );
    expect(conf).toEqual({
      unprivileged: true,
      used: [0, 2],
      targets: ["/data", "/var/lib/redgiant/backups/old"],
      hostname: "coder",
    });
    expect(firstFreeMp(conf.used)).toBe(1);
    expect(firstFreeMp([])).toBe(0);
  });

  it("offers only the host's removable disks, never one of the system", () => {
    const disk = (x: Partial<Parameters<typeof hostCandidates>[0][number]>) => ({
      name: "sdb1",
      path: "/dev/sdb1",
      type: "part" as const,
      sizeBytes: 1e12,
      removable: false,
      hotplug: true,
      transport: "usb",
      model: "",
      label: "Tech",
      uuid: "1234-ABCD",
      fstype: "ext4",
      mountpoint: "",
      freeBytes: null,
      disk: "sdb",
      ...x,
    });
    const got = hostCandidates([
      disk({
        name: "nvme0n1p2",
        path: "/dev/nvme0n1p2",
        disk: "nvme0n1",
        hotplug: false,
        transport: "nvme",
        mountpoint: "/",
      }),
      disk({}),
      disk({
        name: "sdc",
        path: "/dev/sdc",
        type: "disk",
        disk: "sdc",
        label: "",
        model: "Blank",
        fstype: "",
      }),
      disk({ name: "sdd1", path: "/dev/sdd1", disk: "sdd", fstype: "zfs_member", label: "tank" }),
      disk({ name: "sde1", path: "/dev/sde1", disk: "sde", mountpoint: "/var/lib/vz" }),
    ]);
    expect(got.map((d) => [d.path, d.title, d.usable, d.why])).toEqual([
      ["/dev/sdb1", "Tech", true, undefined],
      ["/dev/sdc", "Blank", false, "no_filesystem"],
      ["/dev/sdd1", "tank", false, "unsupported_filesystem"],
    ]);
  });
});

// ---------------------------------------------------------------- SMB, pure

describe("shared folders over SMB (pure, p3.7.2)", () => {
  it.each([
    ["\\\\nas\\backup\\RedGiant", { host: "nas", share: "backup", folder: "RedGiant" }],
    ["//NAS.home.lan/backup", { host: "nas.home.lan", share: "backup", folder: "" }],
    [
      "smb://192.168.1.20/Public/a b/c/",
      { host: "192.168.1.20", share: "Public", folder: "a b/c" },
    ],
    ["\\\\pc\\backup$\\x", { host: "pc", share: "backup$", folder: "x" }],
    ["nas/backup", null],
    ["\\\\nas", null],
    ['\\\\nas\\share\\a"b', null],
    ["\\\\nas\\share\\a;rm", null],
    ["\\\\nas\\share\\..\\x", null],
    ["\\\\na s\\share", null],
  ])("the address %s", (raw, want) => {
    expect(parseSmbAddress(raw)).toEqual(want);
  });

  it("checks the sign-in and writes it only to the authentication file", () => {
    expect(smbLoginRefusal({ user: "severino", password: "p w=;\"'" })).toBeNull();
    expect(smbLoginRefusal({ user: "a\nb", password: "x" })).toBe("bad_user");
    expect(smbLoginRefusal({ user: "a", password: "x\ny" })).toBe("bad_password");
    expect(smbLoginRefusal({ user: "a", password: "x", domain: "WORK GROUP" })).toBe("bad_domain");
    expect(authFile({ user: "me", password: "s3cret", domain: "HOME" })).toBe(
      "username = me\npassword = s3cret\ndomain = HOME\n",
    );
  });

  it("reads smbclient's list and its errors (only the status, never its output)", () => {
    const out = [
      "  .                                   D        0  Sat Nov 14 10:00:00 2026",
      "  ..                                  D        0  Sat Nov 14 10:00:00 2026",
      "  RedGiant-backup-2026-11-14          D        0  Sat Nov  4 03:00:00 2026",
      "  redgiant-scheduled.json             A       52  Sat Nov 14 03:00:01 2026",
      "",
      "\t\t1000000 blocks of size 1024. 500000 blocks available",
    ].join("\n");
    expect(parseSmbLs(out).map((e) => [e.name, e.dir, e.size])).toEqual([
      ["RedGiant-backup-2026-11-14", true, 0],
      ["redgiant-scheduled.json", false, 52],
    ]);
    expect(smbFailure("session setup failed: NT_STATUS_LOGON_FAILURE", "\\\\nas\\b").code).toBe(
      "auth",
    );
    expect(smbFailure("tree connect failed: NT_STATUS_BAD_NETWORK_NAME", "x").code).toBe(
      "no_share",
    );
    expect(
      smbFailure("do_connect: Connection to nas failed (Error NT_STATUS_IO_TIMEOUT)", "x").code,
    ).toBe("unreachable");
    expect(smbFailure("NT_STATUS_ACCESS_DENIED making remote directory", "x").code).toBe("denied");
    expect(smbFailure("NT_STATUS_OBJECT_NAME_COLLISION making remote directory", "x").code).toBe(
      "exists",
    );
    expect(smbFailure("cd \\x\\: NT_STATUS_OBJECT_PATH_NOT_FOUND", "x").code).toBe("not_found");
  });
});

// ---------------------------------------------------------------- SMB, a fake smbclient

const PASSWORD = "smb-password-never-in-an-argument-0042";

/**
 * smbclient on a temporary folder that stands for the share: the commands RedGiant uses, with
 * the same messages. Records every call's arguments and whether the login file was private.
 */
function fakeSmbclient(root: string, o: { down?: () => boolean; cut?: () => boolean } = {}) {
  const calls: { args: string[]; authMode: number; authText: string }[] = [];
  const stamp = (d: Date) => {
    const [wd, mon, day, year] = d.toDateString().split(" ");
    return `${wd} ${mon} ${day} ${d.toTimeString().slice(0, 8)} ${year}`;
  };
  const run: SmbRun = async (args, x) => {
    const at = args.indexOf("-A");
    const auth = args[at + 1] as string;
    const st = await stat(auth).catch(() => undefined);
    calls.push({
      args,
      authMode: st ? st.mode & 0o777 : -1,
      authText: st ? await readFile(auth, "utf8") : "",
    });
    if (args[0] === "--version") return { code: 0, stdout: "Version 4.19", stderr: "" };
    if (o.down?.())
      return {
        code: 1,
        stdout: "",
        stderr: "do_connect: Connection to nas failed (Error NT_STATUS_HOST_UNREACHABLE)",
      };
    const d = args.indexOf("-D");
    const dir = join(root, ...(d >= 0 ? (args[d + 1] as string).split("\\") : []));
    if (!(await stat(dir).catch(() => undefined))?.isDirectory())
      return {
        code: 1,
        stdout: "",
        stderr: `cd \\${args[d + 1]}\\: NT_STATUS_OBJECT_PATH_NOT_FOUND`,
      };
    const cmd = args[args.indexOf("-c") + 1] as string;
    const q = [...cmd.matchAll(/"([^"]*)"/g)].map((m) => m[1] as string);
    const verb = cmd.split(" ")[0];
    const fail = (status: string) => ({ code: 1, stdout: "", stderr: status });
    try {
      switch (verb) {
        case "ls": {
          const lines = [];
          for (const n of await readdir(dir)) {
            const e = await stat(join(dir, n));
            lines.push(
              `  ${n.padEnd(35)} ${e.isDirectory() ? "D" : "A"} ${String(e.size).padStart(8)}  ${stamp(e.mtime)}`,
            );
          }
          return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
        }
        case "mkdir":
          if (await stat(join(dir, q[0] as string)).catch(() => undefined))
            return fail("NT_STATUS_OBJECT_NAME_COLLISION making remote directory");
          await mkdir(join(dir, q[0] as string));
          return { code: 0, stdout: "", stderr: "" };
        case "put": {
          const data = await readFile(join(x.cwd, q[0] as string));
          // A transfer cut short: only half arrives.
          await writeFile(
            join(dir, q[1] as string),
            o.cut?.() ? data.subarray(0, data.length >> 1) : data,
          );
          return { code: 0, stdout: "", stderr: "" };
        }
        case "get":
          await writeFile(join(x.cwd, q[1] as string), await readFile(join(dir, q[0] as string)));
          return { code: 0, stdout: "", stderr: "" };
        case "rename":
          await rename(join(dir, q[0] as string), join(dir, q[1] as string));
          return { code: 0, stdout: "", stderr: "" };
        case "del":
          await rm(join(dir, q[0] as string));
          return { code: 0, stdout: "", stderr: "" };
        case "deltree":
          await rm(join(dir, q[0] as string), { recursive: true });
          return { code: 0, stdout: "", stderr: "" };
        default:
          return fail("NT_STATUS_INVALID_PARAMETER");
      }
    } catch {
      return fail("NT_STATUS_OBJECT_NAME_NOT_FOUND");
    }
  };
  return { run, calls };
}

describe("backups to an SMB share (a fake smbclient, p3.7.2)", () => {
  it("writes under a temporary name, renames once whole, lists, fetches and prunes; the password stays in a private file", async () => {
    const share = await temp("rg-smb-share-");
    const priv = await temp("rg-smb-priv-");
    let down = false;
    let cut = false;
    const smb = fakeSmbclient(share, { down: () => down, cut: () => cut });
    const open = () =>
      smbTarget({
        host: "nas",
        share: "backup",
        folder: "RedGiant/casa",
        user: "severino",
        password: PASSWORD,
        privateDir: priv,
        run: smb.run,
      });
    let now = new Date("2026-11-12T15:00:00").getTime();
    let settings: BackupSettings & { setAt?: string } = {
      destination: {
        kind: "smb",
        host: "nas",
        share: "backup",
        folder: "RedGiant/casa",
        user: "severino",
      },
      schedule: { every: "daily", hour: 3, keep: 2 },
      setAt: new Date(now).toISOString(),
    };
    const seen: string[] = [];
    const sch = new BackupScheduler({
      settings: () => settings,
      record: async (last) => {
        settings = { ...settings, last };
      },
      prepare: () => open(),
      backup: async (file) => {
        seen.push(file);
        await writeFile(file, "backup-bytes");
      },
      version: () => "3.7.2",
      now: () => now,
    });
    for (let day = 13; day <= 15; day++) {
      now = new Date(`2026-11-${day}T03:01:00`).getTime();
      expect(await sch.tick()).toBe("ran");
    }
    const base = join(share, "RedGiant", "casa");
    expect((await readdir(base)).sort()).toEqual([
      "RedGiant-backup-2026-11-14",
      "RedGiant-backup-2026-11-15",
      MADE_FILE,
    ]);
    expect(await readdir(join(base, "RedGiant-backup-2026-11-15"))).toEqual([
      "redgiant-3.7.2-0301.rgbackup",
    ]);
    // The staging file was in RedGiant's private folder, and is gone; so is the login file.
    expect(seen.every((f) => f.startsWith(join(priv, "backup-staging")))).toBe(true);
    expect(await readdir(join(priv, "backup-staging"))).toEqual([]);
    expect(await readdir(join(priv, "smb"))).toEqual([]);
    // Every call: the password never in the arguments, the login file private while it lived.
    for (const c of smb.calls) {
      expect(c.args.join(" ")).not.toContain(PASSWORD);
      expect(c.authMode).toBe(0o600);
    }
    expect(smb.calls[0]?.authText).toContain(`password = ${PASSWORD}`);
    // A put with a temporary name, renamed afterwards.
    const cmds = smb.calls.map((c) => c.args[c.args.indexOf("-c") + 1]);
    expect(cmds).toContain(
      `put "${seen.at(-1)?.split("/").at(-1)}" ".redgiant-3.7.2-0301.rgbackup.part"`,
    );
    expect(cmds).toContain(
      'rename ".redgiant-3.7.2-0301.rgbackup.part" "redgiant-3.7.2-0301.rgbackup"',
    );

    // Listed and fetched back.
    const t = await open();
    const list = await t.list();
    expect(list.map((e: BackupEntry) => e.id)).toEqual([
      "RedGiant-backup-2026-11-15/redgiant-3.7.2-0301.rgbackup",
      "RedGiant-backup-2026-11-14/redgiant-3.7.2-0301.rgbackup",
    ]);
    const got = await t.fetch("RedGiant-backup-2026-11-15", "redgiant-3.7.2-0301.rgbackup");
    expect(await readFile(got.path, "utf8")).toBe("backup-bytes");
    await got.done();
    await t.close();

    // Cut short: not kept under the good name, and said.
    cut = true;
    now = new Date("2026-11-16T03:01:00").getTime();
    expect(await sch.tick()).toBe("failed");
    expect(settings.last).toMatchObject({ ok: false, code: "mismatch" });
    expect(await readdir(join(base, "RedGiant-backup-2026-11-16"))).toEqual([]);
    cut = false;

    // The NAS off: a clear failure, nothing written anywhere else.
    down = true;
    now = new Date("2026-11-17T03:01:00").getTime();
    expect(await sch.tick()).toBe("failed");
    expect(settings.last).toMatchObject({ ok: false, code: "unreachable" });
    expect(settings.last?.error).toMatch(/does not answer/);
    expect(settings.last?.error).not.toContain(PASSWORD);
    expect(await readdir(join(priv, "backup-staging"))).toEqual([]);
  });
});

// ---------------------------------------------------------------- SFTP and «Fallo tu» over HTTP

async function withServer(
  o: { smb?: SmbRun; base?: string; mountinfo?: () => Promise<string>; fstab?: string } = {},
) {
  const home = await temp("rg-sftp-home-");
  const target = { port: 0 };
  let setup: SetupService | undefined;
  s = await startServer(
    [{ text: "OK" }],
    {},
    {
      machines: { dial: () => ({ host: "127.0.0.1", port: target.port }), connectTimeoutMs: 5000 },
    },
    undefined,
    undefined,
    async (core, dir) => {
      setup = new SetupService({
        db: core.db,
        core,
        dataDir: join(dir, "data"),
        ownerId: "me",
        hooks,
        firstBoot: new FirstBoot({
          dataDir: join(dir, "data"),
          container: async () => "lxc",
          hostname: "coder",
          ...(o.smb && { smb: o.smb }),
          ...(o.base && { backupBase: o.base }),
          ...(o.mountinfo && { mountinfo: o.mountinfo }),
          ...(o.fstab && { hostFstab: o.fstab }),
        }),
      });
      await setup.applyAtStartup();
      return { setup };
    },
  );
  const server = s;
  (setup as SetupService).scheduler = (await import("../src/firstboot-routes.js")).backupScheduler(
    server.core,
    setup as SetupService,
    "me",
    () => "3.7.2",
  );
  return { server, home, target, setup: setup as SetupService };
}

/** A machine with RedGiant's own key, tested and trusted as the person does in the page. */
async function trustedMachine(
  server: Server,
  target: { port: number },
  home: string,
  binDir?: string,
) {
  const { body: m } = await server.api<MachineView>("POST", "/api/settings/machines", {
    name: "nas",
    host: "nas.example.test",
    user: "deploy",
    access: { everyone: true },
  });
  const fake = await fakeSsh({ home, keys: [m.publicKey as string], ...(binDir && { binDir }) });
  fakes.push(fake);
  target.port = fake.port;
  const first = await server.api<MachineTest>("POST", `/api/settings/machines/${m.id}/test`);
  await server.api("POST", `/api/settings/machines/${m.id}/trust`, {
    fingerprint: first.body.hostKey?.fingerprint,
  });
  return { m, fake };
}

const job = (server: Server, id: string) =>
  until(async () => {
    const j = (await server.api<Job>("GET", `/api/jobs/${id}`)).body;
    return j.state !== "running" && j;
  }, 60_000);

describe("backups to one of the person's machines over SFTP (p3.7.2)", () => {
  it("resolves the folder there: absolute, from the home, a Windows drive; never climbing", () => {
    expect(sftpFolder("/home/deploy", "~/backups/")).toBe("/home/deploy/backups");
    expect(sftpFolder("/home/deploy", "/volume1/RedGiant")).toBe("/volume1/RedGiant");
    expect(sftpFolder("/C:/Users/me", "E:\\Backup RedGiant")).toBe("/E:/Backup RedGiant");
    expect(sftpFolder("/home/deploy", "backups")).toBeNull();
    expect(sftpFolder("/home/deploy", "/volume1/../etc")).toBeNull();
  });

  it("picks a machine and a folder, backs up now, lists the backup and restores from it", async () => {
    const { server, home, target } = await withServer();
    const { m } = await trustedMachine(server, target, home);
    const targets = await server.api<{ machines: { id: string; trusted: boolean }[] }>(
      "GET",
      "/api/setup/backups/targets",
    );
    expect(targets.body.machines).toEqual([expect.objectContaining({ id: m.id, trusted: true })]);
    const bad = await server.api<{ code: string }>("PUT", "/api/setup/backups/sftp", {
      machineId: m.id,
      path: "relative/folder",
    });
    expect(bad.body.code).toBe("bad_path");
    const ok = await server.api<BackupSettings>("PUT", "/api/setup/backups/sftp", {
      machineId: m.id,
      path: "~/RedGiant",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.destination).toEqual({
      kind: "sftp",
      machineId: m.id,
      machineName: "nas",
      path: "~/RedGiant",
    });
    const run = await server.api<{ started: boolean }>("POST", "/api/setup/backups/run");
    expect(run.body.started).toBe(true);
    const last = await until(async () => {
      const st = await server.api<{ backups: BackupSettings }>("GET", "/api/setup/storage");
      return st.body.backups.last;
    }, 60_000);
    expect(last).toMatchObject({ ok: true });
    const folders = (await readdir(join(home, "RedGiant"))).sort();
    expect(folders).toEqual([
      expect.stringMatching(/^RedGiant-backup-\d{4}-\d{2}-\d{2}$/),
      MADE_FILE,
    ]);
    const inside = await readdir(join(home, "RedGiant", folders[0] as string));
    expect(inside).toEqual([expect.stringMatching(/^redgiant-3\.7\.2-\d{4}\.rgbackup$/)]);
    const list = await server.api<{ backups: BackupEntry[] }>("GET", "/api/setup/backups/list");
    expect(list.body.backups).toHaveLength(1);
    expect(list.body.backups[0]?.bytes).toBe(
      (await stat(join(home, "RedGiant", folders[0] as string, inside[0] as string))).size,
    );
    const r = await server.api<Job>("POST", "/api/setup/backups/restore", {
      id: list.body.backups[0]?.id,
    });
    expect(r.status).toBe(200);
    expect(await job(server, r.body.id)).toMatchObject({ state: "done" });
    const wrong = await server.api<{ code: string }>("POST", "/api/setup/backups/restore", {
      id: "../x/y",
    });
    expect(wrong.body.code).toBe("not_found");
  }, 90_000);

  it("a machine that is off: the backup fails with a clear message, nothing written here", async () => {
    const { server, home, target, setup } = await withServer();
    const { m, fake } = await trustedMachine(server, target, home);
    await server.api("PUT", "/api/setup/backups/sftp", { machineId: m.id, path: "~/RedGiant" });
    await fake.close();
    fakes.splice(fakes.indexOf(fake), 1);
    expect(await setup.scheduler?.runNow()).toBe("failed");
    expect(setup.backups?.last).toMatchObject({ ok: false, code: "unreachable" });
    expect(setup.backups?.last?.error).toMatch(/cannot be reached|did not answer/);
  }, 60_000);
});

describe("an SMB share chosen in the page (p3.7.2)", () => {
  it("keeps the password in the keychain only, never in the settings or an answer, and forgets it with the share", async () => {
    const share = await temp("rg-smb-share-");
    const smb = fakeSmbclient(share);
    const { server } = await withServer({ smb: smb.run });
    const targets = await server.api<{ smb: { available: boolean } }>(
      "GET",
      "/api/setup/backups/targets",
    );
    expect(targets.body.smb.available).toBe(true);
    const bad = await server.api<{ code: string }>("PUT", "/api/setup/backups/smb", {
      address: "nas/backup",
      user: "severino",
      password: PASSWORD,
    });
    expect(bad.body.code).toBe("smb_address");
    const ok = await server.api<BackupSettings>("PUT", "/api/setup/backups/smb", {
      address: "\\\\nas\\backup\\RedGiant",
      user: "severino",
      password: PASSWORD,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.destination).toEqual({
      kind: "smb",
      host: "nas",
      share: "backup",
      folder: "RedGiant",
      user: "severino",
    });
    expect(JSON.stringify(ok.body)).not.toContain(PASSWORD);
    expect(server.core.vault.systemValue("me", "backup:smb:password")).toBe(PASSWORD);
    const st = await server.api("GET", "/api/setup/storage");
    expect(JSON.stringify(st.body)).not.toContain(PASSWORD);
    const events = await server.core.store.list({});
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
    // Another destination: the share's password leaves the keychain.
    await server.api("PUT", "/api/setup/backups", { destination: null });
    expect(server.core.vault.systemValue("me", "backup:smb:password")).toBeUndefined();
  }, 60_000);
});

describe("«Fallo tu»: the Proxmox host passes a disk to this container (p3.7.2)", () => {
  /** A Proxmox host's programs that only write down what they were asked. */
  async function fakeProxmox() {
    const bin = await temp("rg-pve-bin-");
    const log = join(bin, "calls.log");
    const lsblk = JSON.stringify({
      blockdevices: [
        {
          name: "nvme0n1",
          path: "/dev/nvme0n1",
          type: "disk",
          size: 5e11,
          tran: "nvme",
          children: [
            {
              name: "nvme0n1p3",
              path: "/dev/nvme0n1p3",
              type: "part",
              size: 5e11,
              fstype: "LVM2_member",
              mountpoint: null,
            },
          ],
        },
        {
          name: "sdb",
          path: "/dev/sdb",
          type: "disk",
          size: 1e12,
          rm: false,
          hotplug: true,
          tran: "usb",
          model: "Tech",
          children: [
            {
              name: "sdb1",
              path: "/dev/sdb1",
              type: "part",
              size: 1e12,
              fstype: "ext4",
              label: "Tech",
              uuid: "0b1e-77aa",
            },
          ],
        },
      ],
    });
    const script = (name: string, body: string) =>
      writeFile(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\n${body}\n`).then(() =>
        chmod(join(bin, name), 0o755),
      );
    await script("pveversion", 'echo "pve-manager/8.2.4/faa83925 (running kernel: 6.8.12-1-pve)"');
    await script(
      "pct",
      `if [ "$1" = list ]; then printf 'VMID       Status     Lock         Name\\n105        running                 coder\\n'; fi
if [ "$1" = config ]; then [ "$2" = 105 ] || exit 2; printf 'hostname: coder\\nmp0: /mnt/data,mp=/data\\nunprivileged: 1\\n'; fi`,
    );
    await script("lsblk", `cat <<'EOF'\n${lsblk}\nEOF`);
    for (const n of ["mount", "mkdir", "chown", "mkfs.ext4"]) await script(n, "");
    await script("blkid", 'echo "0b1e-77aa"');
    return {
      bin,
      calls: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n"),
    };
  }

  async function godAgent(server: Server) {
    await server.api("POST", "/api/agents", { kind: "god", parentId: null, name: "God" });
  }

  it("finds the host among the machines, asks the person, then runs the checked commands there", async () => {
    const pve = await fakeProxmox();
    const fstab = join(pve.bin, "fstab");
    await writeFile(fstab, "UUID=1111 / ext4 defaults 0 1\n");
    const { server, home, target } = await withServer({ fstab });
    await godAgent(server);
    const { m } = await trustedMachine(server, target, home, pve.bin);
    const found = await server.api<{
      hosts: {
        machineId: string;
        proxmox: string;
        guess: string;
        disks: { path: string; usable: boolean }[];
      }[];
    }>("GET", "/api/setup/backups/proxmox");
    expect(found.body.hosts).toEqual([
      expect.objectContaining({ machineId: m.id, proxmox: "8.2.4", guess: "105" }),
    ]);
    expect(found.body.hosts[0]?.disks.map((d) => [d.path, d.usable])).toEqual([
      ["/dev/sdb1", true],
    ]);
    const inject = await server.api<{ error: string }>("POST", "/api/setup/backups/proxmox", {
      machineId: m.id,
      ctid: "105; reboot",
      device: "/dev/sdb1",
      name: "Tech",
    });
    expect(inject.status).toBe(400);
    const before = (await pve.calls()).length;
    const started = await server.api<Job>("POST", "/api/setup/backups/proxmox", {
      machineId: m.id,
      ctid: "105",
      device: "/dev/sdb1",
      name: "Tech",
    });
    expect(started.status).toBe(200);
    const asked = await until(() => server.core.approvals.list("me")[0]);
    expect((asked as PermissionRequestInfo).tool).toBe("backup_host_mount");
    const commands = (asked.input as { commands: string[] }).commands;
    expect(commands.at(-1)).toBe(
      "'pct' 'set' '105' '-mp1' '/mnt/redgiant-backups/Tech/RedGiant,mp=/var/lib/redgiant/backups/Tech'",
    );
    // Nothing ran on the host before the yes: only the look.
    expect(
      (await pve.calls()).slice(before).every((l) => /^(pveversion|pct config|lsblk)/.test(l)),
    ).toBe(true);
    server.core.approvals.decide("me", asked.requestId, "allow");
    const done = await job(server, started.body.id);
    expect(done.error?.message ?? "").toBe("");
    expect(done).toMatchObject({ state: "done" });
    const ran = (await pve.calls()).slice(before);
    expect(ran).toEqual(
      expect.arrayContaining([
        "mkdir -p /mnt/redgiant-backups/Tech",
        "mount /dev/sdb1 /mnt/redgiant-backups/Tech",
        "blkid -s UUID -o value /dev/sdb1",
        "mkdir -p /mnt/redgiant-backups/Tech/RedGiant",
        "chown 100000:100000 /mnt/redgiant-backups/Tech/RedGiant",
        "pct set 105 -mp1 /mnt/redgiant-backups/Tech/RedGiant,mp=/var/lib/redgiant/backups/Tech",
      ]),
    );
    expect(ran.some((l) => l.startsWith("mkfs"))).toBe(false);
    expect(await readFile(fstab, "utf8")).toBe(
      "UUID=1111 / ext4 defaults 0 1\nUUID=0b1e-77aa /mnt/redgiant-backups/Tech auto defaults,nofail 0 2\n",
    );
  }, 90_000);

  it("a no, and formatting without the disk's exact name, run nothing on the host", async () => {
    const pve = await fakeProxmox();
    const { server, home, target } = await withServer({ fstab: join(pve.bin, "fstab") });
    await godAgent(server);
    const { m } = await trustedMachine(server, target, home, pve.bin);
    const before = (await pve.calls()).length;
    const started = await server.api<Job>("POST", "/api/setup/backups/proxmox", {
      machineId: m.id,
      ctid: "105",
      device: "/dev/sdb1",
      name: "Tech",
    });
    const asked = await until(() => server.core.approvals.list("me")[0]);
    server.core.approvals.decide("me", asked.requestId, "deny");
    expect(await job(server, started.body.id)).toMatchObject({ state: "failed" });
    const fmt = await server.api<Job>("POST", "/api/setup/backups/proxmox", {
      machineId: m.id,
      ctid: "105",
      device: "/dev/sdb1",
      name: "Tech",
      format: "tech",
    });
    const j = await job(server, fmt.body.id);
    expect(j.state).toBe("failed");
    expect(j.error?.message).toMatch(/type its name exactly: Tech/);
    expect(server.core.approvals.list("me")).toEqual([]);
    const ran = (await pve.calls()).slice(before);
    expect(ran.every((l) => /^(pveversion|pct config|lsblk)/.test(l))).toBe(true);
  }, 90_000);
});

describe("a container's host disks (p3.7.2)", () => {
  it("in Docker without the OS helper: the host's disks named, its id, never offered to mount", async () => {
    const lsblk = JSON.stringify({
      blockdevices: [
        {
          name: "sdb",
          path: "/dev/sdb",
          type: "disk",
          size: 1e12,
          rm: false,
          hotplug: true,
          tran: "usb",
          model: "Tech",
        },
      ],
    });
    const fb = new FirstBoot({
      dataDir: await temp("rg-fb-"),
      platform: "linux",
      run: async (cmd) => (cmd === "lsblk" ? lsblk : null),
      container: async () => "docker",
      hostname: "3f2a9c1d7e4b",
      mountinfo: async () => "",
    });
    const st = await fb.storage();
    expect(st).toMatchObject({
      container: "docker",
      candidates: [],
      hostDisks: 1,
      hostDiskList: [{ path: "/dev/sdb", title: "Tech", transport: "usb", fstype: "" }],
      containerHint: { hostname: "3f2a9c1d7e4b", id: "3f2a9c1d7e4b" },
      backupBase: "/var/lib/redgiant/backups",
    });
  });
});

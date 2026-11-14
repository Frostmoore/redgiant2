// The first boot's routes (G39.3), for the wizard and Settings › System:
//   PUT  /api/setup/role             {role, confirm?}  a completed RedGiant needs `confirm`
//   GET  /api/setup/storage          the data folder, the removable disks, the backups' settings
//   POST /api/setup/backups/disk     {uuid}            mounts that disk for backups (checked twice)
//   POST /api/setup/backups/place    {path}            a folder the host mounted under …/backups
//   PUT  /api/setup/backups/folder   {path}            a folder instead (no disk can be mounted)
//   PUT  /api/setup/backups          {schedule?, destination?: null}
//   POST /api/setup/backups/run      a backup now, into the destination
// Destinations without mounting anything (p3.7.2), the backups there and the host's disks:
//   GET  /api/setup/backups/targets  the machines (SFTP), the nodes, whether SMB works here
//   PUT  /api/setup/backups/sftp     {machineId, path}       a folder on one of the person's machines
//   PUT  /api/setup/backups/smb      {address, user, password?, domain?}   a shared folder (keychain)
//   PUT  /api/setup/backups/node     {fingerprint}           a paired RedGiant's storage
//   GET  /api/setup/backups/list     the backups in the destination, newest first
//   POST /api/setup/backups/restore  {id}                    a Job: fetched, read back, imported
//   GET  /api/setup/backups/proxmox  the person's machines that are this container's Proxmox host
//   POST /api/setup/backups/proxmox  {machineId, ctid, device, name, format?}  «Fallo tu»: a Job
//                                    that asks the person (always, never a classifier) first
//   GET  /api/setup/net              what already reaches the machine (Tailscale, proxies, DNS)
//   GET  /api/setup/ssh, PUT /api/setup/ssh {on, key?}   SSH, keys only (RedGiant OS's helper)
// RedGiant OS (G39.1), through the OS helper:
//   GET  /api/setup/wifi             the Wi-Fi networks and the one in use; POST …/wifi/scan looks again
//   POST /api/setup/wifi/connect     {ssid, password, hidden?}  (the password is never logged or kept)
//   POST /api/setup/wifi/forget      {ssid}
//   GET  /api/setup/https, PUT /api/setup/https {local?, redirect?, trusted?}   HTTPS in the LAN
//   GET  /api/setup/os-updates, POST /api/setup/os-updates/check   RedGiant's stack, Debian's security
//   POST /api/setup/os/reboot        {confirm: true}   the person's yes in the page
//   GET  /redgiant-ca.crt            the machine's CA certificate (public, no sign-in)
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ApprovalRequest } from "@redgiant/hierarchy";
import {
  type BackupDestination,
  type BackupSchedule,
  HOST_DEVICE,
  HOST_FOLDER_NAME,
  PROXMOX_ID,
} from "@redgiant/protocol";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { exportBackup, SAFETY_FILE, SAFETY_FOLDER, verifyBackup } from "./backup.js";
import { BackupScheduler } from "./backup-schedule.js";
import {
  type BackupTarget,
  localTarget,
  nodeTarget,
  sftpTarget,
  smbTarget,
  TargetError,
} from "./backup-targets.js";
import type { RedGiantCore } from "./core.js";
import { isWindowsPath } from "./machines.js";
import { lineOf, planOnHost, probeHost, runPlan } from "./proxmox-mount.js";
import type { SetupService } from "./setup.js";
import { parseSmbAddress, runSmbclient, smbLoginRefusal } from "./smb.js";
import { importInto } from "./update-routes.js";

/** The SMB share's password in the keychain (G36.20), used by backups only. */
export const SMB_KEY = "backup:smb:password";

/**
 * The destination as a target to write to: a folder here (the disk mounted again when needed),
 * or one elsewhere reached without mounting anything. Throws when it is not there now.
 */
export async function openTarget(
  core: RedGiantCore,
  setup: SetupService,
  owner: string,
  d: BackupDestination,
): Promise<BackupTarget> {
  const tmp = join(setup.dataDir, "tmp");
  const stagingDir = join(tmp, "backup-staging");
  switch (d.kind) {
    case "disk":
    case "folder":
      return localTarget(setup.firstBoot ? await setup.firstBoot.prepare(d) : d.path);
    case "sftp":
      return sftpTarget({
        machines: core.machines,
        ownerId: owner,
        machineId: d.machineId,
        path: d.path,
        stagingDir,
      });
    case "smb": {
      if (!core.vault.ready)
        throw new TargetError(
          "auth",
          "The keychain is closed: the shared folder's password cannot be read",
        );
      return smbTarget({
        host: d.host,
        share: d.share,
        folder: d.folder,
        user: d.user,
        password: core.vault.systemValue(owner, SMB_KEY) ?? "",
        domain: d.domain,
        privateDir: tmp,
        run: setup.firstBoot?.smbRun ?? runSmbclient,
      });
    }
    case "node":
      return nodeTarget({
        nodes: core.nodes,
        ownerId: owner,
        fingerprint: d.fingerprint,
        name: d.name,
        stagingDir,
      });
  }
}

/** Scheduled backups through a job each (the page follows it like any backup). */
export function backupScheduler(
  core: RedGiantCore,
  setup: SetupService,
  owner: string,
  version: () => string | null,
): BackupScheduler {
  return new BackupScheduler({
    settings: () => setup.backups,
    record: (last) => setup.recordBackup(last),
    prepare: async (s) => {
      if (!s.destination) throw new Error("No destination chosen");
      return openTarget(core, setup, owner, s.destination);
    },
    version,
    backup: async (file) => {
      const job = core.jobs.start(
        owner,
        "backup_scheduled",
        ["data", "conversations", "files", "verify"],
        async (h) => {
          const vectors = (await core.knowledge?.settings(owner).catch(() => undefined))
            ?.backupVectors;
          const v = version();
          await exportBackup(core.backupDeps, owner, file, h, undefined, {
            full: true,
            ...(v && { version: v }),
            ...(vectors && { vectors }),
          });
          h.step("verify");
          await verifyBackup(file, h);
        },
        { file },
      );
      const done = await core.jobs.settled(job.id, 200);
      if (done?.state !== "done")
        throw new Error(done?.error?.message ?? "The backup did not finish");
    },
  });
}

export function firstBootRoutes<E extends { Variables: any }>(
  app: Hono<E>,
  setup: SetupService | undefined,
  scheduler: () => BackupScheduler | undefined,
  core: RedGiantCore,
  owner: (c: Context<E>) => string,
) {
  const answer = async (c: Context<E>, f: (s: SetupService) => Promise<unknown>) => {
    if (!setup) return c.json({ error: "Setup is not available" }, 400);
    try {
      return c.json(((await f(setup)) ?? { ok: true }) as object, 200);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      return c.json(
        { error: (err as Error).message, ...(typeof code === "string" && { code }) },
        400,
      );
    }
  };
  const body = async <T extends z.ZodType>(c: Context<E>, schema: T): Promise<z.infer<T>> => {
    const r = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!r.success)
      throw new Error(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return r.data;
  };
  const machine = (s: SetupService) => {
    if (!s.firstBoot) throw Object.assign(new Error("Not available here"), { code: "unsupported" });
    return s.firstBoot;
  };
  const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
  /** The share's password leaves the keychain with the share (another destination, or none). */
  const forgetSmb = async (c: Context<E>, s: SetupService, next: BackupDestination | undefined) => {
    if (s.backups?.destination?.kind === "smb" && next?.kind !== "smb" && core.vault.ready)
      await core.vault.setSystem(owner(c), SMB_KEY, null).catch(() => {});
  };
  const saveDest = async (c: Context<E>, s: SetupService, destination: BackupDestination) => {
    await forgetSmb(c, s, destination);
    return s.saveBackups({ destination });
  };
  /** Reached and written to once (the list of the schedule's folders, rewritten as it is). */
  const probe = async (t: BackupTarget) => {
    try {
      await t.writeMade(await t.readMade());
    } finally {
      await t.close();
    }
  };
  const destination = (s: SetupService) => {
    const d = s.backups?.destination;
    if (!d) throw fail("no_destination", "No destination chosen");
    return d;
  };

  app.put("/api/setup/role", (c) =>
    answer(c, async (s) => {
      const b = await body(
        c,
        z.object({ role: z.enum(["full", "node"]), confirm: z.boolean().optional() }),
      );
      await s.saveRole(b.role, b.confirm);
    }),
  );
  app.get("/api/setup/storage", (c) =>
    answer(c, async (s) => ({
      ...(await machine(s).storage()),
      backups: s.backups ?? null,
      running: scheduler()?.busy ?? false,
    })),
  );
  app.post("/api/setup/backups/disk", (c) =>
    answer(c, async (s) => {
      const b = await body(c, z.object({ uuid: z.string().regex(/^[A-Fa-f0-9-]{4,36}$/) }));
      const destination = await machine(s).mountDisk(b.uuid);
      return saveDest(c, s, destination);
    }),
  );
  // A folder the host mounted under /var/lib/redgiant/backups (RedGiant OS in a container).
  app.post("/api/setup/backups/place", (c) =>
    answer(c, async (s) => {
      const b = await body(c, z.object({ path: z.string().min(1).max(500) }));
      const destination = await machine(s).usePlace(b.path);
      return saveDest(c, s, destination);
    }),
  );
  app.put("/api/setup/backups/folder", (c) =>
    answer(c, async (s) => {
      const b = await body(c, z.object({ path: z.string().min(1).max(500) }));
      const destination = await machine(s).checkFolder(b.path);
      return saveDest(c, s, destination);
    }),
  );
  app.put("/api/setup/backups", (c) =>
    answer(c, async (s) => {
      const b = await body(
        c,
        z.object({
          destination: z.null().optional(),
          schedule: z
            .object({
              every: z.enum(["off", "daily", "weekly"]).optional(),
              hour: z.number().int().min(0).max(23).optional(),
              weekday: z.number().int().min(0).max(6).optional(),
              keep: z.number().int().min(1).max(60).optional(),
            })
            .optional(),
        }),
      );
      if (b.destination === null) await forgetSmb(c, s, undefined);
      return s.saveBackups({
        ...(b.destination === null && { destination: null }),
        ...(b.schedule && {
          schedule: Object.fromEntries(
            Object.entries(b.schedule).filter(([, v]) => v !== undefined),
          ) as Partial<BackupSchedule>,
        }),
      });
    }),
  );
  app.post("/api/setup/backups/run", (c) =>
    answer(c, async (s) => {
      const sch = scheduler();
      if (!sch || !s.backups?.destination)
        throw Object.assign(new Error("No destination chosen"), { code: "no_destination" });
      if (sch.busy) return { started: false };
      void sch.runNow();
      return { started: true };
    }),
  );
  // --- destinations reached without mounting anything (p3.7.2) -------------------------------
  let smbHere: Promise<boolean> | undefined;
  app.get("/api/setup/backups/targets", (c) =>
    answer(c, async (s) => {
      const o = owner(c);
      const run = s.firstBoot?.smbRun ?? runSmbclient;
      smbHere ??= run(["--version"], { cwd: s.dataDir, timeoutMs: 10_000, home: s.dataDir }).then(
        (r) => !r.missing && r.code === 0,
        () => false,
      );
      const d = s.backups?.destination;
      return {
        machines: (await core.machines.list(o)).map((m) => ({
          id: m.id,
          name: m.name,
          host: m.host,
          user: m.user,
          trusted: m.hostKey !== undefined,
          windows: isWindowsPath(m.folder),
        })),
        nodes: (await core.nodes.known(o).catch(() => [])).map((n) => ({
          fingerprint: n.fingerprint,
          name: n.name,
          online: n.online,
        })),
        smb: {
          available: await smbHere,
          password:
            d?.kind === "smb" &&
            core.vault.ready &&
            core.vault.systemValue(o, SMB_KEY) !== undefined,
        },
      };
    }),
  );
  app.put("/api/setup/backups/sftp", (c) =>
    answer(c, async (s) => {
      const b = await body(
        c,
        z.object({
          machineId: z.string().min(1).max(100),
          path: z.string().trim().min(1).max(500),
        }),
      );
      const o = owner(c);
      const m = await core.machines.get(o, b.machineId).catch(() => {
        throw fail("not_found", "No such machine");
      });
      if (!m.hostKey)
        throw fail(
          "not_trusted",
          `Test ${m.name} once in Settings › Machines and trust its key first`,
        );
      const dest: BackupDestination = {
        kind: "sftp",
        machineId: m.id,
        machineName: m.name,
        path: b.path,
      };
      await probe(await openTarget(core, s, o, dest));
      return saveDest(c, s, dest);
    }),
  );
  app.put("/api/setup/backups/smb", (c) =>
    answer(c, async (s) => {
      const b = await body(
        c,
        z.object({
          address: z.string().trim().min(3).max(500),
          user: z.string().trim().min(1).max(104),
          password: z.string().max(256).optional(),
          domain: z.string().trim().max(64).optional(),
        }),
      );
      const o = owner(c);
      const a = parseSmbAddress(b.address);
      if (!a) throw fail("smb_address", "Write the shared folder as \\\\host\\share\\folder");
      const domain = b.domain || undefined;
      const stored = core.vault.ready ? core.vault.systemValue(o, SMB_KEY) : undefined;
      const password = b.password ?? stored ?? "";
      const why = smbLoginRefusal({ user: b.user, password, domain });
      if (why) throw fail(`smb_${why}`, "That sign-in cannot be used");
      if (b.password && !core.vault.ready)
        throw fail("keychain_closed", "Open the keychain first: the password is kept there");
      const t = await smbTarget({
        ...a,
        user: b.user,
        password,
        domain,
        privateDir: join(s.dataDir, "tmp"),
        run: s.firstBoot?.smbRun ?? runSmbclient,
      });
      await probe(t);
      if (b.password !== undefined && core.vault.ready)
        await core.vault.setSystem(o, SMB_KEY, b.password || null, {
          name: `backup-smb-${a.host}`,
          service: `SMB ${a.host}`,
          category: "server",
          username: b.user,
          hosts: [a.host],
          section: "system",
          kind: "other",
          what: `password of ${b.user} for the backups on \\\\${a.host}\\${a.share}`,
        });
      return saveDest(c, s, {
        kind: "smb",
        ...a,
        user: b.user,
        ...(domain && { domain }),
      });
    }),
  );
  app.put("/api/setup/backups/node", (c) =>
    answer(c, async (s) => {
      const b = await body(c, z.object({ fingerprint: z.string().min(10).max(100) }));
      const o = owner(c);
      const n = await core.nodes.find(o, b.fingerprint);
      if (!n) throw fail("not_found", "No such node");
      const dest: BackupDestination = { kind: "node", fingerprint: n.fingerprint, name: n.name };
      await probe(await openTarget(core, s, o, dest));
      return saveDest(c, s, dest);
    }),
  );
  app.get("/api/setup/backups/list", (c) =>
    answer(c, async (s) => {
      const t = await openTarget(core, s, owner(c), destination(s));
      try {
        return { where: t.where, backups: await t.list() };
      } finally {
        await t.close();
      }
    }),
  );
  app.post("/api/setup/backups/restore", (c) =>
    answer(c, async (s) => {
      const b = await body(c, z.object({ id: z.string().min(1).max(200) }));
      const [folder = "", file = "", more] = b.id.split("/");
      if (more !== undefined || !SAFETY_FOLDER.test(folder) || !SAFETY_FILE.test(file))
        throw fail("not_found", "No such backup");
      const dest = destination(s);
      const o = owner(c);
      return core.jobs.start(
        o,
        "backup_restore",
        ["download", "verify", "data", "conversations", "files"],
        async (h) => {
          h.step("download");
          const t = await openTarget(core, s, o, dest);
          try {
            const got = await t.fetch(folder, file);
            try {
              h.step("verify");
              await verifyBackup(got.path, h);
              await importInto(core, s, o, got.path, {}, h);
            } finally {
              await got.done();
            }
          } finally {
            await t.close();
          }
        },
        { file: b.id },
      );
    }),
  );

  // --- «Fallo tu»: the Proxmox host passes a disk to this container (p3.7.2) -------------------
  app.get("/api/setup/backups/proxmox", (c) =>
    answer(c, async (s) => {
      const o = owner(c);
      const here = machine(s).hostName;
      const list = (await core.machines.list(o)).filter(
        (m) => m.hostKey && !isWindowsPath(m.folder),
      );
      const probes = await Promise.all(list.map((m) => probeHost(core.machines, o, m, here)));
      return {
        checked: list.length,
        hosts: probes.filter((p) => p.proxmox !== null),
        errors: probes.filter((p) => p.error).map((p) => ({ name: p.name, error: p.error })),
      };
    }),
  );
  app.post("/api/setup/backups/proxmox", (c) =>
    answer(c, async (s) => {
      const b = await body(
        c,
        z.object({
          machineId: z.string().min(1).max(100),
          ctid: z.string().regex(PROXMOX_ID),
          device: z.string().regex(HOST_DEVICE),
          name: z.string().regex(HOST_FOLDER_NAME),
          format: z.string().max(80).optional(),
        }),
      );
      const o = owner(c);
      const fb = machine(s);
      const m = await core.machines.get(o, b.machineId).catch(() => {
        throw fail("not_found", "No such machine");
      });
      const god = core.registry.list({ ownerId: o }).find((a) => a.kind === "god");
      if (!god) throw fail("unavailable", "RedGiant is not set up yet");
      return core.jobs.start(
        o,
        "backup_host_mount",
        ["look", "ask", "run", "arrive"],
        async (h) => {
          h.step("look");
          const client = await core.machines.connect(o, m);
          try {
            const { plan, disk } = await planOnHost(client, b, fb.backupBaseDir, fb.hostFstab);
            h.info({ disk, target: plan.target, host: m.name });
            h.step("ask");
            const id = `hostmount_${randomUUID().slice(0, 12)}`;
            const formatting = b.format !== undefined;
            const request: ApprovalRequest = {
              requestId: id,
              requester: god,
              call: {
                callId: id,
                name: "backup_host_mount",
                input: {
                  host: `${m.user}@${m.host} (${m.name})`,
                  container: b.ctid,
                  disk: `${disk} (${b.device})`,
                  ...(formatting && { format: `ERASES EVERYTHING on ${disk}` }),
                  commands: plan.steps.map((x) => lineOf(x.argv)),
                },
              },
              reasons: [
                `Runs these commands on the Proxmox host ${m.name} to pass the disk ${disk} to container ${b.ctid}`,
                ...(formatting ? [`FORMATS the disk ${disk}: everything on it is erased`] : []),
              ],
              danger: formatting ? ["host", "format"] : ["host"],
            };
            // Truly dangerous: it reaches the person everywhere, never a classifier, and their
            // time running out is a no.
            const answer = await core.person.approve(request, h.signal, {
              kind: "approval",
              critical: true,
              what: `Pass the disk ${disk} of ${m.name} to container ${b.ctid}${formatting ? " (formatting it)" : ""}`,
              defaultTimeoutMs: 30 * 60_000,
            });
            if (answer !== "allow") throw fail("denied", "Not done: the person did not say yes");
            h.step("run");
            await runPlan(client, plan.steps, (i) => h.progress(i, plan.steps.length));
            h.step("arrive");
            const places = await fb.places().catch(() => []);
            h.info({ arrived: places.some((p) => p.path === plan.target) ? "1" : "0" });
          } finally {
            client.end();
          }
        },
        { host: m.name },
      );
    }),
  );
  app.get("/api/setup/net", (c) =>
    answer(c, async (s) => {
      const socket = (
        c.env as { incoming?: { socket?: { remoteAddress?: string; localPort?: number } } }
      )?.incoming?.socket;
      return machine(s).net((n) => c.req.header(n), {
        remote: socket?.remoteAddress,
        localPort: socket?.localPort,
      });
    }),
  );
  // «Skip: I am reachable already» (G39.8): the person's own way in; RedGiant's own ways stop
  // inviting, and links (Telegram…) use the address given.
  app.put("/api/setup/reachable", (c) =>
    answer(c, async (s) => {
      const b = z
        .object({
          on: z.boolean(),
          url: z
            .string()
            .trim()
            .max(300)
            .regex(/^https?:\/\/[a-z0-9.-]+(:\d+)?\/?$/i)
            .optional(),
        })
        .parse(await c.req.json().catch(() => ({})));
      await s.setReachable(b.on, b.url);
      return { ok: true };
    }),
  );
  app.get("/api/setup/wifi", (c) => answer(c, async (s) => machine(s).wifi()));
  app.post("/api/setup/wifi/scan", (c) => answer(c, async (s) => machine(s).wifi(true)));
  app.post("/api/setup/wifi/connect", (c) =>
    answer(c, async (s) => {
      const b = await body(
        c,
        z.object({
          ssid: z.string().min(1).max(64),
          password: z.string().max(64),
          hidden: z.boolean().optional(),
        }),
      );
      return machine(s).wifiConnect(b.ssid, b.password, b.hidden === true);
    }),
  );
  app.post("/api/setup/wifi/forget", (c) =>
    answer(c, async (s) => {
      const b = await body(c, z.object({ ssid: z.string().min(1).max(64) }));
      return machine(s).wifiForget(b.ssid);
    }),
  );
  app.get("/api/setup/https", (c) =>
    answer(c, async (s) => machine(s).https((n) => c.req.header(n))),
  );
  app.put("/api/setup/https", (c) =>
    answer(c, async (s) => {
      const b = await body(
        c,
        z.object({
          local: z.boolean().optional(),
          redirect: z.boolean().optional(),
          trusted: z.boolean().optional(),
        }),
      );
      return machine(s).setHttps(b, (n) => c.req.header(n));
    }),
  );
  app.get("/api/setup/os-updates", (c) => answer(c, async (s) => machine(s).osUpdates()));
  app.post("/api/setup/os-updates/check", (c) =>
    answer(c, async (s) => machine(s).osUpdates(true)),
  );
  app.post("/api/setup/os/reboot", (c) =>
    answer(c, async (s) => {
      const b = await body(c, z.object({ confirm: z.literal(true) }));
      void b;
      return machine(s).reboot();
    }),
  );
  // Public: a certificate is meant to be shown; what is installed with it is the person's choice.
  app.get("/redgiant-ca.crt", async (c) => {
    const pem = await setup?.firstBoot?.caCertificate();
    if (!pem) return c.json({ error: "No local certificate on this installation" }, 404);
    return c.body(pem, 200, {
      "content-type": "application/x-x509-ca-cert",
      "content-disposition": 'attachment; filename="RedGiant-CA.crt"',
      "cache-control": "no-store",
    });
  });
  app.get("/api/setup/ssh", (c) => answer(c, async (s) => machine(s).ssh()));
  app.put("/api/setup/ssh", (c) =>
    answer(c, async (s) => {
      const b = await body(c, z.object({ on: z.boolean(), key: z.string().max(2000).optional() }));
      return machine(s).setSsh(b.on, b.key);
    }),
  );
}

// The first boot's routes (G39.3), for the wizard and Settings › System:
//   PUT  /api/setup/role             {role, confirm?}  a completed RedGiant needs `confirm`
//   GET  /api/setup/storage          the data folder, the removable disks, the backups' settings
//   POST /api/setup/backups/disk     {uuid}            mounts that disk for backups (checked twice)
//   PUT  /api/setup/backups/folder   {path}            a folder instead (no disk can be mounted)
//   PUT  /api/setup/backups          {schedule?, destination?: null}
//   POST /api/setup/backups/run      a backup now, into the destination
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
import type { BackupSchedule } from "@redgiant/protocol";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { exportBackup, verifyBackup } from "./backup.js";
import { BackupScheduler } from "./backup-schedule.js";
import type { RedGiantCore } from "./core.js";
import type { SetupService } from "./setup.js";

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
      const fb = setup.firstBoot;
      if (!fb) return s.destination.path;
      return fb.prepare(s.destination);
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
      return s.saveBackups({ destination });
    }),
  );
  app.put("/api/setup/backups/folder", (c) =>
    answer(c, async (s) => {
      const b = await body(c, z.object({ path: z.string().min(1).max(500) }));
      const destination = await machine(s).checkFolder(b.path);
      return s.saveBackups({ destination });
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

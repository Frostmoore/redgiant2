// Mandatory and breaking updates (G36.19), for the web page:
//   GET  /api/update/status          → UpdateStatus (the last look)
//   POST /api/update/look            → UpdateStatus (looks now)
//   POST /api/update/act             {action: update | quit | uninstall} → asks RedGiant.exe / the Mac app
//   POST /api/update/safety-backup   {keychainPassphrase?} → Job: a full backup into Documents, read back
//   GET  /api/backup/found           → FoundBackup[] (the wizard's «Restore from the backup»)
//   POST /api/backup/found/import    {id, keychainPassphrase?, godName?, demigodName?} → Job

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FoundBackup, UpdateStatus } from "@redgiant/protocol";
import type { Context, Hono } from "hono";
import {
  BackupError,
  exportBackup,
  findBackups,
  foundBackupPath,
  importBackup,
  verifyBackup,
} from "./backup.js";
import type { RedGiantCore } from "./core.js";
import type { JobHandle } from "./jobs.js";
import type { SetupService } from "./setup.js";

/** What a page sees when this server does not look for updates (tests, the source). */
const NOTHING: UpdateStatus = {
  install: "source",
  installed: null,
  latest: null,
  checkedAt: null,
  state: "unknown",
  gate: "none",
  signed: false,
  note: null,
  downloadUrl: null,
  command: null,
  backupDir: null,
  canUpdateHere: false,
  canUninstall: false,
};

/** The text left beside the backup, for whoever opens the folder. */
function readme(file: string, version: string | null): string {
  return [
    "RedGiant backup / Backup di RedGiant",
    "",
    `File: ${file}${version ? ` (RedGiant ${version})` : ""}`,
    "",
    "IT: questo file contiene progetti, conversazioni, agenti, memorie e impostazioni. Dopo aver",
    "installato la versione nuova, la prima schermata propone «Ripristina dal backup» e lo trova da",
    "sola in questa cartella. Le chiavi e gli accessi non ci sono (restano su questo computer); il",
    "portachiavi c'è solo se hai scelto una frase, e serve quella frase per riaprirlo.",
    "",
    "EN: this file holds projects, conversations, agents, memories and settings. After installing",
    "the new version, the first screen offers «Restore from the backup» and finds it in this",
    "folder by itself. Keys and sign-ins are not in it (they stay on this computer); the keychain",
    "is there only if you chose a passphrase, and that passphrase opens it again.",
    "",
  ].join("\r\n");
}

// biome-ignore lint/suspicious/noExplicitAny: the app's own Env, kept private in app.ts
export function updateRoutes<E extends { Variables: any }>(
  app: Hono<E>,
  core: RedGiantCore,
  owner: (c: Context<E>) => string,
  setup: SetupService | undefined,
): void {
  const base = () => core.updates?.status().backupDir ?? null;

  app.get("/api/update/status", (c) => c.json(core.updates?.status() ?? NOTHING, 200));
  app.post("/api/update/look", async (c) => c.json((await core.updates?.check()) ?? NOTHING, 200));
  app.post("/api/update/act", async (c) => {
    const b = await c.req.json<{ action?: string }>().catch(() => ({ action: "" }));
    const action = b.action;
    if (action !== "update" && action !== "quit" && action !== "uninstall")
      return c.json({ error: "action must be update, quit or uninstall" }, 400);
    const s = core.updates?.status();
    // A breaking update is never applied over the installed version.
    if (action === "update" && s?.gate === "breaking")
      return c.json({ error: "This version needs a clean install", code: "clean_install" }, 409);
    const ok = (await core.updates?.act(action)) ?? false;
    return ok
      ? c.json({ ok: true }, 200)
      : c.json({ error: "This installation cannot do that by itself", code: "manual" }, 400);
  });

  app.post("/api/update/safety-backup", async (c) => {
    const o = owner(c);
    const dir = base();
    if (!dir) return c.json({ error: "No folder for backups here" }, 400);
    const pass = (
      await c.req.json<{ keychainPassphrase?: string }>().catch(() => ({ keychainPassphrase: "" }))
    ).keychainPassphrase;
    let keychain: string | undefined;
    try {
      keychain = pass && core.vault.ready ? core.vault.exportSealed(o, pass) : undefined;
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const running = core.jobs
      .list(o)
      .find((j) => j.kind === "backup_safety" && j.state === "running");
    if (running) return c.json(running, 200);
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString();
    const folder = `RedGiant-backup-${local.slice(0, 10)}`;
    const version = core.updates?.status().installed ?? null;
    const file = `redgiant-${version ?? "dev"}-${local.slice(11, 16).replace(":", "")}.rgbackup`;
    const path = join(dir, folder, file);
    const job = core.jobs.start(
      o,
      "backup_safety",
      ["data", "conversations", "files", "verify"],
      async (h) => {
        await mkdir(join(dir, folder), { recursive: true });
        const vectors = (await core.knowledge?.settings(o).catch(() => undefined))?.backupVectors;
        await exportBackup(core.backupDeps, o, path, h, keychain, {
          full: true,
          ...(version && { version }),
          ...(vectors && { vectors }),
        });
        h.step("verify");
        const check = await verifyBackup(path, h);
        await writeFile(join(dir, folder, "LEGGIMI-README.txt"), readme(file, version));
        const size = (await stat(path)).size;
        h.info({
          path,
          folder: join(dir, folder),
          file,
          bytes: String(size),
          projects: String(check.projects),
          conversations: String(check.conversations),
          keychain: String(check.keychain),
        });
      },
      { path, folder: join(dir, folder), file },
    );
    return c.json(job, 200);
  });

  app.get("/api/backup/found", async (c) => {
    const dir = base();
    if (!dir) return c.json([] as FoundBackup[], 200);
    const found: FoundBackup[] = (await findBackups(dir)).map((b) => ({
      id: b.id,
      folder: b.folder,
      file: b.file,
      path: b.path,
      bytes: b.size,
      createdAt: b.createdAt,
      version: b.version,
      projects: b.projects,
      conversations: b.conversations,
      keychain: b.keychain,
    }));
    return c.json(found, 200);
  });

  app.post("/api/backup/found/import", async (c) => {
    const b = await c.req.json<{
      id?: string;
      godName?: string;
      demigodName?: string;
      keychainPassphrase?: string;
    }>();
    const dir = base();
    const file = dir && b.id ? foundBackupPath(dir, b.id) : null;
    if (!file || !(await stat(file).catch(() => undefined)))
      return c.json({ error: "No such backup" }, 404);
    const o = owner(c);
    const job = core.jobs.start(o, "backup_import", ["data", "conversations", "files"], (h) =>
      importInto(core, setup, o, file, b, h),
    );
    return c.json(job, 200);
  });
}

/**
 * Imports a backup file into this RedGiant (the found backups, and the scheduled ones of
 * Settings › System, p3.7.2): what is new is added, the person's portable choices come back.
 */
export async function importInto(
  core: RedGiantCore,
  setup: SetupService | undefined,
  o: string,
  file: string,
  b: { godName?: string; demigodName?: string; keychainPassphrase?: string },
  h: JobHandle,
): Promise<void> {
  try {
    const r = await importBackup(
      core.backupDeps,
      o,
      file,
      {
        ...(b.godName && { godName: b.godName }),
        ...(b.demigodName && { demigodName: b.demigodName }),
      },
      h,
    );
    h.info({
      projects: String(r.projects.length),
      agents: String(r.agents),
      conversations: String(r.conversations),
      files: String(r.files),
    });
    if (r.keychain && b.keychainPassphrase)
      h.info({
        keychain: await core.vault
          .importSealed(o, r.keychain, b.keychainPassphrase)
          .then(String)
          .catch(() => "wrong"),
      });
    // The person's own choices of the wizard (instructions, languages…), never this computer's.
    if (r.setup) await setup?.restorePortable(r.setup);
  } catch (err) {
    if (err instanceof BackupError) throw new Error(err.message);
    throw err;
  } finally {
    // The agents and the settings in memory follow what was added; the file stays where it is.
    await core.registry.load();
    await core.policies.load();
    await core.commandSettings.load();
    await core.requestSettings.load();
  }
}

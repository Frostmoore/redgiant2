// Mandatory and breaking updates (G36.19): the watcher reads the latest release and its signed
// release.json; a mandatory one holds the agents' work cleanly (nothing lost, automations
// skipped with the reason); a breaking one gets a full safety backup, read back, that the
// wizard of a new installation finds by itself.
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Automation, AutomationRun, FoundBackup, Job, UpdateStatus } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BackupError, findBackups, verifyBackup } from "../src/backup.js";
import { UpdateRequiredError, UpdateWatcher, type UpdateWatcherOptions } from "../src/updates.js";
import { startServer } from "./helpers.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUB = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** A GitHub that answers the latest release with these assets. */
function feed(version: string, info?: object, signer = keys.privateKey) {
  let up = true;
  const files: Record<string, Buffer> = {};
  if (info) {
    const bytes = Buffer.from(`${JSON.stringify(info)}\n`);
    files["release.json"] = bytes;
    files["release.json.sig"] = Buffer.from(sign("sha256", bytes, signer).toString("base64"));
  }
  const f = (async (url: string) => {
    if (!up) throw new Error("offline");
    if (url === "https://feed.test/latest")
      return Response.json({
        tag_name: `v${version}`,
        assets: Object.keys(files).map((name) => ({
          name,
          browser_download_url: `https://feed.test/download/${name}`,
        })),
      });
    const name = url.split("/").pop() ?? "";
    const b = files[name];
    return b ? new Response(b) : new Response("no", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, files, offline: () => (up = false) };
}

const dirs: string[] = [];
async function watcher(o: Partial<UpdateWatcherOptions> & Pick<UpdateWatcherOptions, "fetch">) {
  const dataDir = await mkdtemp(join(tmpdir(), "rg-upd-"));
  dirs.push(dataDir);
  return new UpdateWatcher({
    install: "windows",
    installed: "3.4.0",
    dataDir,
    backupBase: join(dataDir, "Documents"),
    feed: "https://feed.test/latest",
    publicKey: PUB,
    launcher: true,
    ...o,
  });
}

type Server = Awaited<ReturnType<typeof startServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
}, 60_000);

const finished = async (s: Server, job: Job) => {
  for (let i = 0; i < 400; i++) {
    const { body } = await s.api<Job>("GET", `/api/jobs/${job.id}`);
    if (body.state !== "running") return body;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error("The job did not end");
};

const note = { it: "Serve per la sicurezza.", en: "Needed for safety." };

describe("the update watcher", () => {
  it("counts a signed mandatory release, and tells the Mac app", async () => {
    const f = feed("3.5.0", { format: 1, version: "3.5.0", kind: "mandatory", note });
    const w = await watcher({ fetch: f.fetch });
    const s = await w.check();
    expect(s).toMatchObject({
      latest: "3.5.0",
      state: "available",
      gate: "mandatory",
      signed: true,
      note,
      canUpdateHere: true,
    });
    expect(s.downloadUrl).toMatch(/RedGiant-Setup\.exe$/);
    expect(w.held).toBe(true);
    const forApp = JSON.parse(
      await readFile(join(w.status().backupDir as string, "..", "update-required.json"), "utf8"),
    );
    expect(forApp).toMatchObject({ gate: "mandatory", version: "3.5.0" });
  });

  it("ignores metadata without a valid signature: forged, another key, another release", async () => {
    const forged = feed("3.5.0", { format: 1, version: "3.5.0", kind: "mandatory", note });
    forged.files["release.json"] = Buffer.from(
      (forged.files["release.json"] as Buffer).toString().replace("mandatory", "breaking"),
    );
    const otherKey = feed(
      "3.5.0",
      { format: 1, version: "3.5.0", kind: "breaking" },
      other.privateKey,
    );
    const oldFile = feed("3.5.1", { format: 1, version: "3.5.0", kind: "mandatory", note });
    const unsigned = feed("3.5.0");
    for (const f of [forged, otherKey, oldFile, unsigned]) {
      const s = await (await watcher({ fetch: f.fetch })).check();
      expect([s.gate, s.signed]).toEqual(["normal", false]);
    }
    // No public key: nothing counts.
    const ok = feed("3.5.0", { format: 1, version: "3.5.0", kind: "mandatory", note });
    expect((await (await watcher({ fetch: ok.fetch, publicKey: "" })).check()).gate).toBe("normal");
  });

  it("an unreachable GitHub does not lift a mandatory update", async () => {
    const f = feed("3.5.0", { format: 1, version: "3.5.0", kind: "mandatory", note });
    const w = await watcher({ fetch: f.fetch });
    await w.check();
    f.offline();
    expect((await w.check()).gate).toBe("mandatory");
    const fresh = await watcher({ fetch: f.fetch });
    expect((await fresh.check()).state).toBe("unreachable");
  });

  it("a breaking update is never applied in place; Docker gets the command", async () => {
    const f = feed("4.0.0", { format: 1, version: "4.0.0", kind: "breaking", note });
    const asked: string[] = [];
    const w = await watcher({
      fetch: f.fetch,
      act: async (a) => {
        asked.push(a);
        return true;
      },
    });
    expect((await w.check()).gate).toBe("breaking");
    expect(w.held).toBe(false);
    expect(await w.act("update")).toBe(false);
    expect(await w.act("uninstall")).toBe(true);
    expect(asked).toEqual(["uninstall"]);
    const d = await (
      await watcher({ fetch: f.fetch, install: "docker", composeDir: "/srv/rg" })
    ).check();
    expect(d.command).toBe("cd /srv/rg && docker compose pull && docker compose up -d");
    expect(d.backupDir).toMatch(/Documents$/);
  });

  it("forgets at start what a previous run left for the Mac app", async () => {
    const f = feed("3.5.0");
    const w = await watcher({ fetch: f.fetch });
    const file = join(w.status().backupDir as string, "..", "update-required.json");
    await writeFile(file, '{"gate":"mandatory","version":"3.5.0"}');
    w.start();
    w.stop();
    for (let i = 0; i < 50 && existsSync(file); i++) await new Promise((ok) => setTimeout(ok, 10));
    expect(existsSync(file)).toBe(false);
  });

  it("does nothing where the version is unknown (run from the source)", async () => {
    const f = feed("3.5.0", { format: 1, version: "3.5.0", kind: "mandatory", note });
    const s = await (await watcher({ fetch: f.fetch, installed: null })).check();
    expect([s.gate, s.state]).toEqual(["none", "unknown"]);
  });
});

async function god(s: Server) {
  return (
    await s.api<{ id: string }>("POST", "/api/agents", { kind: "god", parentId: null, name: "God" })
  ).body.id;
}

describe("a mandatory update on the server", () => {
  it("refuses new work cleanly, holds automations, and lets everything go once updated", async () => {
    const s = await startServer(() => ({ text: "done" }));
    servers.push(s);
    const g = await god(s);
    const sid = (await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: g })).body
      .sessionId;
    await (await s.core.send("me", sid, "before")).done;
    const calls = s.provider.requests.length;

    const f = feed("3.5.0", { format: 1, version: "3.5.0", kind: "mandatory", note });
    s.core.updates = await watcher({ fetch: f.fetch });
    await s.core.updates.check();
    expect((await s.api<UpdateStatus>("GET", "/api/update/status")).body.gate).toBe("mandatory");

    // HTTP: 423 with its code; the page shows the window. Nothing reaches the model or the log.
    const events = (await s.core.history("me", sid)).length;
    const r = await s.api<{ code: string }>("POST", `/api/sessions/${sid}/messages`, {
      text: "now",
    });
    expect([r.status, r.body.code]).toEqual([423, "update_required"]);
    await expect(s.core.send("me", sid, "now")).rejects.toBeInstanceOf(UpdateRequiredError);
    expect(s.provider.requests.length).toBe(calls);
    expect((await s.core.history("me", sid)).length).toBe(events);

    // Automations: the run is written as skipped, with the reason.
    const created = await s.api<{ automation: Automation }>("POST", "/api/automations", {
      yaml: ["name: digest", "on: {cron: '0 8 * * *'}", "instructions: Summarise."].join("\n"),
    });
    const id = created.body.automation.id;
    await s.api("POST", `/api/automations/${id}/run`);
    let runs: AutomationRun[] = [];
    for (let i = 0; i < 100 && !runs.length; i++) {
      runs = (await s.api<AutomationRun[]>("GET", `/api/automations/${id}/runs`)).body;
      if (!runs.length) await new Promise((ok) => setTimeout(ok, 25));
    }
    expect(runs[0]).toMatchObject({ status: "skipped" });
    expect(runs[0]?.summary).toMatch(/must be updated to 3\.5\.0/);
    expect(s.provider.requests.length).toBe(calls);

    // The person updated (here: the release is no longer newer): work goes on, the old messages are there.
    s.core.updates = await watcher({ fetch: f.fetch, installed: "3.5.0" });
    await s.core.updates.check();
    await (await s.core.send("me", sid, "after")).done;
    expect(s.provider.requests.length).toBe(calls + 1);
  });
});

describe("the safety backup of a breaking update", () => {
  it("is full, read back, found by a new installation's wizard and restored", async () => {
    const a = await startServer(() => ({ text: "ok" }));
    servers.push(a);
    const g = await god(a);
    const p = await a.api<{ id: string }>("POST", "/api/projects", { name: "Sito" });
    const path = (await a.core.projects.get("me", p.body.id))?.path as string;
    await mkdir(join(path, "src"), { recursive: true });
    await writeFile(join(path, "src", "index.html"), "<h1>mine</h1>");
    const sid = (await a.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: g })).body
      .sessionId;
    await (await a.core.send("me", sid, "remember this")).done;
    await a.core.backupDeps.db.query(
      "INSERT INTO rg_settings (owner_id, key, value) VALUES ('me', 'tools', $1)",
      [JSON.stringify({ off: ["fetch"] })],
    );
    const docs = await mkdtemp(join(tmpdir(), "rg-docs-"));
    dirs.push(docs);
    const f = feed("4.0.0", { format: 1, version: "4.0.0", kind: "breaking", note });
    a.core.updates = await watcher({ fetch: f.fetch, backupBase: docs });
    await a.core.updates.check();

    const job = await finished(a, (await a.api<Job>("POST", "/api/update/safety-backup", {})).body);
    expect(job.state).toBe("done");
    expect(job.steps.map((s) => s.id)).toEqual(["data", "conversations", "files", "verify"]);
    const file = job.vars.path as string;
    expect(file.startsWith(join(docs, "RedGiant-backup-"))).toBe(true);
    expect(file).toMatch(/redgiant-3\.4\.0-\d{4}\.rgbackup$/);
    expect(existsSync(join(job.vars.folder as string, "LEGGIMI-README.txt"))).toBe(true);
    const check = await verifyBackup(file);
    expect(check).toMatchObject({ version: "3.4.0", projects: 1, files: 1, conversations: 1 });

    // A new installation (the clean install): its wizard finds the backup and restores it.
    const b = await startServer(() => ({ text: "ok" }));
    servers.push(b);
    b.core.updates = await watcher({
      fetch: feed("4.0.0").fetch,
      installed: "4.0.0",
      backupBase: docs,
    });
    const found = (await b.api<FoundBackup[]>("GET", "/api/backup/found")).body;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      version: "3.4.0",
      projects: 1,
      conversations: 1,
      keychain: false,
    });
    expect(
      (await b.api("POST", "/api/backup/found/import", { id: "../../etc/passwd" })).status,
    ).toBe(404);
    const imported = await finished(
      b,
      (await b.api<Job>("POST", "/api/backup/found/import", { id: found[0]?.id })).body,
    );
    expect(imported.state).toBe("done");
    expect(imported.vars.projects).toBe("1");
    const [project] = await b.core.projects.list("me");
    expect(await readFile(join(project?.path as string, "src", "index.html"), "utf8")).toBe(
      "<h1>mine</h1>",
    );
    const [tools] = await b.core.backupDeps.db.query<{ value: unknown }>(
      "SELECT value FROM rg_settings WHERE owner_id = 'me' AND key = 'tools'",
    );
    expect(tools?.value).toEqual({ off: ["fetch"] });
    // The backup stays where it was (it is the person's).
    expect(existsSync(file)).toBe(true);

    // A damaged copy is refused and never offered.
    const cut = join(docs, "RedGiant-backup-2020-01-01", "redgiant-3.3.0-0000.rgbackup");
    await mkdir(join(docs, "RedGiant-backup-2020-01-01"));
    await writeFile(cut, await readFile(file));
    await truncate(cut, Math.floor((await readFile(file)).length / 2));
    await expect(verifyBackup(cut)).rejects.toBeInstanceOf(BackupError);
    expect((await findBackups(docs)).map((x) => x.file)).toEqual([found[0]?.file]);
  });
});

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BackupPreview, Job } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { remapIds } from "../src/index.js";
import { startServer, TOKEN } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
}, 60_000);

const start = async () => {
  const s = await startServer(() => ({ text: "ok" }));
  servers.push(s);
  return s;
};

const finished = async (s: Server, job: Job) => {
  for (let i = 0; i < 200; i++) {
    const { body } = await s.api<Job>("GET", `/api/jobs/${job.id}`);
    if (body.state !== "running") return body;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error("The job did not end");
};

/** A RedGiant with God, a project with a file, its orchestrator and one conversation. */
async function filled(s: Server, god: string, project: string, text: string) {
  const g = await s.api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: god,
  });
  const p = await s.api<{ id: string; path: string }>("POST", "/api/projects", { name: project });
  const o = await s.api<{ id: string }>("POST", "/api/agents", {
    kind: "orchestrator",
    parentId: g.body.id,
    projectId: p.body.id,
    name: "Lead",
  });
  const path = (await s.core.projects.get("me", p.body.id))?.path as string;
  await mkdir(join(path, "src"), { recursive: true });
  await writeFile(join(path, "src", "index.html"), text);
  await mkdir(join(path, "node_modules", "x"), { recursive: true });
  await writeFile(join(path, "node_modules", "x", "big.js"), "left out");
  const { db, store } = s.core.backupDeps;
  await db.query(
    "INSERT INTO rg_sessions (id, owner_id, agent_id, project_id) VALUES ($1, 'me', $2, $3)",
    [`s-${god}`, o.body.id, p.body.id],
  );
  await store.append({
    ownerId: "me",
    projectId: p.body.id,
    agentId: o.body.id,
    sessionId: `s-${god}`,
    body: { type: "message.user", payload: { text } },
  } as never);
  return { god: g.body.id, project: p.body.id, orchestrator: o.body.id };
}

const upload = async (s: Server, data: Buffer) => {
  const r = await fetch(`${s.url}/api/backup/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream" },
    body: data,
  });
  return { status: r.status, body: (await r.json()) as { id: string; preview: BackupPreview } };
};

describe("backup (2026-11-03)", () => {
  it("carries projects, files and conversations into a RedGiant already in use", async () => {
    const a = await start();
    const from = await filled(a, "Zeus", "Sito", "<h1>from A</h1>");
    const exported = await finished(a, (await a.api<Job>("POST", "/api/backup/export")).body);
    expect(exported.state).toBe("done");
    const r = await fetch(`${a.url}/api/backup/file/${exported.vars.file}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    const data = Buffer.from(await r.arrayBuffer());

    // Another RedGiant, with its own God and a project of the same name.
    const b = await start();
    const mine = await filled(b, "God", "Sito", "<h1>B's own</h1>");
    const up = await upload(b, data);
    expect(up.status).toBe(200);
    expect(up.body.preview.projects).toEqual([{ id: "sito", name: "Sito", exists: false }]);
    expect(up.body.preview.names).toEqual([{ kind: "god", backup: "Zeus", here: "God" }]);

    const job = await finished(
      b,
      (await b.api<Job>("POST", "/api/backup/import", { id: up.body.id, godName: "Zeus" })).body,
    );
    expect(job.state).toBe("done");
    // The name was taken: the backup's project comes in beside B's, with its files.
    const moved = await b.core.projects.get("me", "sito-2");
    expect(moved?.name).toBe("Sito (2)");
    expect(await readFile(join(moved?.path as string, "src", "index.html"), "utf8")).toBe(
      "<h1>from A</h1>",
    );
    await expect(
      readFile(join(moved?.path as string, "node_modules", "x", "big.js")),
    ).rejects.toThrow();
    const own = (await b.core.projects.get("me", "sito"))?.path as string;
    expect(await readFile(join(own, "src", "index.html"), "utf8")).toBe("<h1>B's own</h1>");
    // B's God stays, with the name chosen; A's orchestrator is under it and in the new project.
    const god = b.core.registry.get(mine.god);
    expect(god?.name).toBe("Zeus");
    expect(b.core.registry.get(from.god)).toBeUndefined();
    const lead = b.core.registry.get(from.orchestrator);
    expect(lead).toMatchObject({ parentId: mine.god, projectId: "sito-2" });
    // The conversation came too, with its time.
    const events = await b.core.store.list({ sessionId: "s-Zeus" });
    expect(events.map((e) => [e.type, e.projectId])).toEqual([["message.user", "sito-2"]]);
    expect(await b.core.store.verify()).toMatchObject({ ok: true });

    // The same backup again adds nothing.
    const again = await upload(b, data);
    expect(again.body.preview.projects[0]?.exists).toBe(true);
    const second = await finished(
      b,
      (await b.api<Job>("POST", "/api/backup/import", { id: again.body.id })).body,
    );
    expect(second.state).toBe("done");
    expect((await b.core.store.list({ sessionId: "s-Zeus" })).length).toBe(1);
    expect((await b.core.projects.list("me")).map((p) => p.id).sort()).toEqual(["sito", "sito-2"]);
  });

  it("refuses a file that is not a backup", async () => {
    const s = await start();
    const r = await upload(s, Buffer.from("hello"));
    expect(r.status).toBe(400);
  });

  it("moves only ids in an event's payload", () => {
    const ids = new Map([["sito", "sito-2"]]);
    expect(
      remapIds({ projectId: "sito", text: "sito", taskIds: ["sito"], nested: { id: "sito" } }, ids),
    ).toEqual({ projectId: "sito-2", text: "sito", taskIds: ["sito-2"], nested: { id: "sito-2" } });
  });
});

describe("the keychain in a backup (G33.4)", () => {
  it("goes in only sealed with the person's passphrase, and comes back with it", async () => {
    const value = "rk_live_Zq81mXv3PdQw7Tn2LbYc";
    const a = await start();
    await a.api("POST", "/api/vault", {
      name: "revolut_api",
      service: "Revolut",
      value,
      hosts: ["b2b.revolut.com"],
    });
    // Without a passphrase: no keychain in the file.
    const plain = await finished(a, (await a.api<Job>("POST", "/api/backup/export")).body);
    const get = async (job: Job) =>
      Buffer.from(
        await (
          await fetch(`${a.url}/api/backup/file/${job.vars.file}`, {
            headers: { authorization: `Bearer ${TOKEN}` },
          })
        ).arrayBuffer(),
      );
    const b = await start();
    expect((await upload(b, await get(plain))).body.preview.keychain).toBe(false);
    // With one: sealed inside, never in clear.
    const sealed = await finished(
      a,
      (await a.api<Job>("POST", "/api/backup/export", { keychainPassphrase: "a long passphrase" }))
        .body,
    );
    const data = await get(sealed);
    const { gunzipSync } = await import("node:zlib");
    expect(gunzipSync(data).toString("latin1")).not.toContain(value);
    const up = await upload(b, data);
    expect(up.body.preview.keychain).toBe(true);
    const job = await finished(
      b,
      (
        await b.api<Job>("POST", "/api/backup/import", {
          id: up.body.id,
          keychainPassphrase: "a long passphrase",
        })
      ).body,
    );
    expect(job.vars.keychain).toBe("1");
    expect(b.core.vault.reveal("me", "revolut_api")).toBe(value);
  });
});

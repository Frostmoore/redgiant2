// 3.5.3 (collaudo della 3.5.1, punti 7a e 7b; decision «Gli agenti possono creare tutto da sé"):
// agents make knowledge collections and give them sources with their own tools, with the page's
// scope rules; a project (inside RedGiant's data) is a source by its path, name or id; the errors
// say what to give; the search tells the agent why it went by words only, and the page knows too.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeCollection, KnowledgeSource, KnowledgeStatus } from "@redgiant/protocol";
import type { CompletionRequest, FakeTurn } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { type KeyedFetch, normalize } from "../src/knowledge/embedders.js";
import { LocalEmbedServers } from "../src/knowledge/local-embed.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { startServer } from "./helpers.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

const ROOM = { contextWindow: 65_536 };

/** Fake embeddings (never a real model): each word lights a few dimensions. */
const keyed: KeyedFetch = async (url, init) => {
  if (!url.endsWith("/embeddings")) return new Response("no", { status: 404 });
  const body = JSON.parse(init.body ?? "{}") as { input: string[] };
  const embed = (t: string) => {
    const v = new Array<number>(32).fill(0);
    for (const w of t.toLowerCase().match(/[a-zà-ú0-9]+/g) ?? []) {
      let h = 2166136261;
      for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
      v[Math.abs(h) % 32] = (v[Math.abs(h) % 32] ?? 0) + 1;
    }
    return normalize(v);
  };
  return Response.json({ data: body.input.map((t, index) => ({ index, embedding: embed(t) })) });
};
const fake = { provider: "compatible" as const, model: "fake", baseUrl: "http://fake.test/v1" };

/** The model runs `calls` in order, one per turn step, then says what it got. */
function plan(calls: { name: string; input: unknown }[], results: string[]) {
  let i = 0;
  return (req: CompletionRequest): FakeTurn => {
    const last = req.messages.at(-1)?.parts.find((p) => p.type === "tool_result");
    if (last && last.type === "tool_result")
      results.push(typeof last.content === "string" ? last.content : JSON.stringify(last.content));
    const next = calls[i++];
    return next ? { toolCalls: [next] } : { text: "done" };
  };
}

/**
 * A server with the knowledge on, as main.ts wires it, and the data folder holding the workspaces
 * (as in an installed RedGiant: a project is inside RedGiant's own data).
 */
async function kbServer(script: (req: CompletionRequest) => FakeTurn) {
  let k: KnowledgeService | undefined;
  const server = await startServer(script, ROOM, {}, undefined, undefined, async (core, sdir) => {
    k = new KnowledgeService({
      db: core.db,
      store: core.store,
      jobs: core.jobs,
      dataDir: sdir,
      forbidden: [join(sdir, "keychain")],
      local: new LocalEmbedServers({ dataDir: join(sdir, "models"), jobs: core.jobs }),
      keyedFetch: () => keyed,
      scopeRoot: (o, scope) => core.scopeFolder(o, scope),
      places: (o) => core.knowledgePlaces(o),
      agentProjects: async (_o, agentId) => {
        const a = core.registry.get(agentId);
        return a?.projectId ? [a.projectId] : [];
      },
      agentKind: (_o, agentId) => core.registry.get(agentId)?.kind,
      manual: true,
    });
    await k.start();
    core.knowledge = k;
    return {};
  });
  cleanup.push(async () => {
    await k?.stop();
    await server.close();
  });
  const god = (
    await server.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    })
  ).body.id;
  await server.api("POST", "/api/projects", { name: "Collaudo 3.5.1" });
  const project = await server.core.projects.get("me", "collaudo-3-5-1");
  if (!project) throw new Error("no project");
  await writeFile(
    join(project.path, "note.md"),
    "# Note\n\nIl magazzino MAG-4471 apre alle 7:30.\n",
  );
  await mkdir(join(project.path, "docs"), { recursive: true });
  await writeFile(
    join(project.path, "docs", "guida.md"),
    "# Guida\n\nIl faro si accende al tramonto.\n",
  );
  return { server, k: k as KnowledgeService, god, project };
}

const session = async (s: Awaited<ReturnType<typeof kbServer>>["server"], agentId: string) =>
  (await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId })).body.sessionId;

describe("the knowledge made by the agents (3.5.3)", () => {
  it("God makes a collection for a project by its name and gives it the project's folder by path", async () => {
    const results: string[] = [];
    let tools: string[] = [];
    const byPath = { collection: "collaudo 3.5.1", kind: "folder", path: "" };
    const steps = plan(
      [
        {
          name: "knowledge_create",
          input: { name: "Collaudo 3.5.1", for: "Collaudo 3.5.1", description: "Test files" },
        },
        { name: "knowledge_add_source", input: byPath },
        {
          name: "knowledge_add_source",
          input: { collection: "Collaudo 3.5.1", kind: "url", url: "nope" },
        },
        { name: "knowledge_status", input: { collection: "Collaudo 3.5.1" } },
        { name: "knowledge_create", input: { name: "COLLAUDO 3.5.1" } },
      ],
      results,
    );
    const { server, k, god, project } = await kbServer((req) => {
      tools = req.tools.map((t) => t.name);
      return steps(req);
    });
    byPath.path = project.path;
    // The person answers the guardian's question for the full path (outside God's own folder).
    server.core.approvals.on("request", (owner, info) =>
      server.core.approvals.decide(owner, info.requestId, "allow"),
    );
    await (await server.core.send("me", await session(server, god), "make the knowledge")).done;
    for (const t of ["knowledge_create", "knowledge_add_source", "knowledge_status"])
      expect(tools).toContain(t);
    expect(results[0]).toMatch(
      /^Made the collection «Collaudo 3\.5\.1» \(kc_\w+\) for the project collaudo-3-5-1/,
    );
    expect(results[1]).toMatch(/^Added the files of project:collaudo-3-5-1 to «Collaudo 3\.5\.1»/);
    expect(results[2]).toMatch(/url/);
    expect(results[3]).toContain("«Collaudo 3.5.1»");
    expect(results[3]).toContain("the files of project:collaudo-3-5-1");
    // The search goes by words only (no model chosen): the agent is told why, and what to do.
    expect(results[3]).toContain(
      "Search by meaning is off: no model for the meaning is chosen yet",
    );
    expect(results[4]).toMatch(/is there already/);
    const [c] = await k.collections("me");
    expect(c).toMatchObject({
      name: "Collaudo 3.5.1",
      scope: { kind: "project", projectId: "collaudo-3-5-1" },
    });
    const [src] = await k.sources("me", c?.id ?? "");
    expect(src?.spec).toMatchObject({
      kind: "workspace",
      scope: "project:collaudo-3-5-1",
      path: ".",
    });
    await k.indexer.drain();
    expect((await k.documents("me", c?.id ?? "")).map((d) => d.path).sort()).toEqual([
      "docs/guida.md",
      "note.md",
    ]);
  });

  // p3.5.4, the 3.5.3 test: God made the project's collection but could not search it («No
  // collection you can read is called that. Yours: …»). God acts with the person's authority.
  it("God searches a project's collection it made, by its name", async () => {
    const results: string[] = [];
    // Two turns: the collection made and given the project's files, then (once read) searched.
    const make = plan(
      [
        { name: "knowledge_create", input: { name: "Collaudo 3.5.1", for: "Collaudo 3.5.1" } },
        {
          name: "knowledge_add_source",
          input: { collection: "Collaudo 3.5.1", kind: "project", project: "Collaudo 3.5.1" },
        },
      ],
      results,
    );
    const search = plan(
      [
        {
          name: "search_knowledge",
          input: { query: "magazzino", collections: ["Collaudo 3.5.1"] },
        },
      ],
      results,
    );
    let searching = false;
    const { server, k, god } = await kbServer((req) => (searching ? search(req) : make(req)));
    await server.api("PUT", "/api/knowledge/settings", { embedding: fake });
    const sid = await session(server, god);
    await (await server.core.send("me", sid, "make it")).done;
    await k.indexer.drain();
    searching = true;
    await (await server.core.send("me", sid, "search it")).done;
    expect(results[1]).toMatch(/^Added the files of project:collaudo-3-5-1/);
    expect(results[2]).not.toMatch(/No collection you can read/);
    expect(results[2]).toContain("MAG-4471");
    // In the agent's window too: God reads it by its scope.
    const view = await k.agentCollections("me", god);
    expect(view.find((c) => c.name === "Collaudo 3.5.1")).toMatchObject({
      byScope: true,
      on: true,
    });
  });

  it("an agent of the project makes its own, never for everyone nor in another project", async () => {
    const results: string[] = [];
    const { server, god } = await kbServer(
      plan(
        [
          { name: "knowledge_create", input: { name: "Tutti", for: "everyone" } },
          { name: "knowledge_create", input: { name: "Nostra" } },
          {
            name: "knowledge_add_source",
            input: { collection: "Nostra", kind: "folder", path: "docs" },
          },
          {
            name: "knowledge_add_source",
            input: { collection: "Nostra", kind: "project", project: "altro" },
          },
          {
            name: "knowledge_add_source",
            input: { collection: "Di God", kind: "url", url: "https://example.com/" },
          },
          { name: "knowledge_status", input: {} },
        ],
        results,
      ),
    );
    await server.api("POST", "/api/projects", { name: "Altro" });
    const orch = (
      await server.api<{ id: string }>("POST", "/api/agents", {
        kind: "orchestrator",
        parentId: god,
        projectId: "collaudo-3-5-1",
        name: "Lead",
      })
    ).body.id;
    const coder = (
      await server.api<{ id: string }>("POST", "/api/agents", {
        kind: "agent",
        parentId: orch,
        name: "Coder",
      })
    ).body.id;
    await server.api("POST", "/api/knowledge/collections", {
      name: "Di God",
      scope: { kind: "agent", agentId: god },
    });
    await (await server.core.send("me", await session(server, coder), "go")).done;
    expect(results[0]).toMatch(/^You cannot make a collection for every agent/);
    expect(results[1]).toMatch(
      /^Made the collection «Nostra» \(kc_\w+\) for the project collaudo-3-5-1/,
    );
    expect(results[2]).toMatch(/^Added the files of project:collaudo-3-5-1\/docs to «Nostra»/);
    expect(results[3]).toMatch(/^You cannot read the project altro/);
    expect(results[4]).toMatch(/^«Di God» is for only God: you cannot add sources to it/);
    expect(results[5]).toContain("«Nostra»");
    expect(results[5]).not.toContain("Di God");
  });

  it("no agent makes a collection for an archived project nor reads its files (2026-11-09)", async () => {
    const results: string[] = [];
    const { server } = await kbServer(
      plan(
        [
          { name: "knowledge_create", input: { name: "Archivio", for: "collaudo-3-5-1" } },
          {
            name: "knowledge_add_source",
            input: { collection: "Di tutti", kind: "project", project: "collaudo-3-5-1" },
          },
          { name: "knowledge_status", input: {} },
        ],
        results,
      ),
    );
    await server.api("POST", "/api/knowledge/collections", {
      name: "Di tutti",
      scope: { kind: "all" },
    });
    await server.api("POST", "/api/projects/collaudo-3-5-1/archive");
    const god = server.core.registry.list({ ownerId: "me" }).find((a) => a.kind === "god");
    await (await server.core.send("me", await session(server, god?.id ?? ""), "go")).done;
    expect(results[0]).toMatch(/^You cannot make a collection for the project collaudo-3-5-1/);
    expect(results[1]).toMatch(/^You cannot read the project collaudo-3-5-1/);
    expect(results[2]).toContain("«Di tutti»");
  });

  it("the page's API takes a project's name or its path, and says clearly what is wrong", async () => {
    const { server, project } = await kbServer(() => ({ text: "ok" }));
    const made = await server.api<KnowledgeCollection>("POST", "/api/knowledge/collections", {
      name: "Per nome",
      scope: { kind: "project", projectId: "Collaudo 3.5.1" },
    });
    expect(made.status).toBe(201);
    expect(made.body.scope).toEqual({ kind: "project", projectId: "collaudo-3-5-1" });
    const add = (body: unknown) =>
      server.api<KnowledgeSource & { error?: string }>(
        "POST",
        `/api/knowledge/collections/${made.body.id}/sources`,
        body,
      );
    // As in the collaudo: the project's full path, and its id without «project:».
    const byPath = await add({ kind: "folder", path: project.path });
    expect(byPath.status).toBe(201);
    expect(byPath.body.spec).toMatchObject({ kind: "workspace", scope: "project:collaudo-3-5-1" });
    const byId = await add({ kind: "workspace", scope: "collaudo-3-5-1", path: "docs" });
    expect(byId.status).toBe(201);
    expect(byId.body.spec).toMatchObject({ scope: "project:collaudo-3-5-1", path: "docs" });
    const file = await add({ kind: "file", path: join(project.path, "note.md") });
    expect(file.body.spec).toEqual({
      kind: "file",
      scope: "project:collaudo-3-5-1",
      path: "note.md",
    });
    const unknown = await add({ kind: "workspace", scope: "nessuno" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain(
      'No project "nessuno". Give a project\'s name or id (Collaudo 3.5.1 (project:collaudo-3-5-1))',
    );
    // RedGiant's own data stays out, with a reason that says what can go in.
    const keychain = join(project.path, "..", "..", "keychain");
    await mkdir(keychain, { recursive: true });
    const own = await add({ kind: "folder", path: keychain });
    expect(own.status).toBe(400);
    expect(own.body.error).toContain("inside RedGiant's own data");
    const outside = await mkdtemp(join(tmpdir(), "rg-kb-out-"));
    cleanup.push(() => rm(outside, { recursive: true, force: true }));
    expect((await add({ kind: "folder", path: outside })).status).toBe(201);
    expect((await add({ kind: "folder", path: "relative/docs" })).body.error).toContain("relative");
  });

  it("tells the page whether the search goes by meaning, and why not", async () => {
    const { server } = await kbServer(() => ({ text: "ok" }));
    const before = (await server.api<KnowledgeStatus>("GET", "/api/knowledge")).body;
    expect(before.meaning).toEqual({
      on: false,
      off: "no_model",
      detail: "No embedding model chosen",
    });
    await server.api("PUT", "/api/knowledge/settings", { embedding: fake });
    const after = (await server.api<KnowledgeStatus>("GET", "/api/knowledge")).body;
    expect(after.meaning).toEqual({ on: true });
  });
});

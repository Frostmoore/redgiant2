// G36.5–G36.6: the agents' tool and their access, the counters the status page reads, OCR of
// pictures and scans (a fake engine: never Tesseract here), mail and conversations as sources,
// and the knowledge in a backup.
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { EventStore, migrate, type SqlClient } from "@redgiant/events";
import { type Job, KnowledgeSourceInput } from "@redgiant/protocol";
import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Jobs } from "../src/jobs.js";
import { fromHalf, packVector, toHalf, unpackVector } from "../src/knowledge/backup.js";
import { type KeyedFetch, normalize } from "../src/knowledge/embedders.js";
import { pngOf } from "../src/knowledge/extract.js";
import { LocalEmbedServers } from "../src/knowledge/local-embed.js";
import { migrateKnowledge } from "../src/knowledge/schema.js";
import {
  type ChatSource,
  joinPieces,
  KnowledgeService,
  type MailSource,
  type OcrEngine,
} from "../src/knowledge/service.js";
import {
  citationLabel,
  formatHits,
  knowledgeSection,
  searchKnowledgeTool,
} from "../src/knowledge/tool.js";
import { startServer, TOKEN } from "./helpers.js";
import { memoryDb } from "./pglite.js";

/** The same fake embedding API as knowledge.test.ts: words light dimensions by their hash. */
function fakeApi(dims: number) {
  const calls = { texts: 0 };
  const embed = (t: string) => {
    const v = new Array<number>(dims).fill(0);
    for (const w of t.toLowerCase().match(/[a-zà-ú0-9]+/g) ?? []) {
      let h = 2166136261;
      for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
      for (let j = 0; j < 3; j++) {
        const i = Math.abs(h + j * 7919) % dims;
        v[i] = (v[i] ?? 0) + ((h >> j) & 1 ? 1 : -1) * (j === 0 ? 2 : 1);
      }
    }
    return normalize(v);
  };
  const keyed: KeyedFetch = async (url, init) => {
    if (!url.endsWith("/embeddings")) return new Response("no", { status: 404 });
    const body = JSON.parse(init.body ?? "{}") as { input: string[] };
    calls.texts += body.input.length;
    return Response.json({ data: body.input.map((t, index) => ({ index, embedding: embed(t) })) });
  };
  return { keyed, calls };
}

const fake = { provider: "compatible" as const, model: "fake", baseUrl: "http://fake.test/v1" };

/** An OCR that reads what the test says (and keeps what it was given). */
function fakeOcr(text = "Fattura 4417 del fornitore Rossi") {
  const state = { here: false, seen: [] as Uint8Array[], ensured: 0 };
  const engine: OcrEngine = {
    ready: async () => state.here,
    ensure: async () => {
      state.ensured++;
      state.here = true;
    },
    recognize: async (img) => {
      state.seen.push(img);
      return text;
    },
    bytes: async () => 4321,
    stop: async () => {},
  };
  return { engine, state };
}

let dir: string;
let cleanup: (() => Promise<unknown>)[] = [];
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "rg-kb36-")));
});
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
  await rm(dir, { recursive: true, force: true });
});

async function setup(
  o: {
    db?: SqlClient;
    ocr?: OcrEngine;
    mail?: MailSource;
    chats?: ChatSource;
    projects?: Record<string, string[]>;
  } = {},
) {
  const db = o.db ?? (await memoryDb()).db;
  await migrate(db);
  const store = new EventStore(db);
  const jobs = new Jobs();
  const dataDir = join(dir, "data");
  await mkdir(dataDir, { recursive: true });
  const api = fakeApi(32);
  const k = new KnowledgeService({
    db,
    store,
    jobs,
    dataDir,
    local: new LocalEmbedServers({ dataDir, jobs }),
    keyedFetch: () => api.keyed,
    scopeRoot: async (_o, scope) => {
      throw new Error(`no scope ${scope}`);
    },
    agentLanguage: () => "it",
    ...(o.ocr && { ocr: o.ocr }),
    ...(o.mail && { mail: o.mail }),
    ...(o.chats && { chats: o.chats }),
    agentProjects: async (_o, id) => o.projects?.[id] ?? [],
    manual: true,
  });
  await k.start();
  cleanup.push(() => k.stop());
  return { k, db, store, api };
}

async function folder(name: string, files: Record<string, string | Uint8Array>) {
  const root = join(dir, name);
  for (const [p, body] of Object.entries(files)) {
    await mkdir(join(root, p, ".."), { recursive: true });
    await writeFile(join(root, p), body);
  }
  return root;
}

/** What the counters say against what the tables hold. */
async function counts(db: SqlClient) {
  const kept = await db.query<{ c: number; i: number; n: string }>(
    "SELECT collection_num AS c, index_id AS i, n::text AS n FROM rg_kb_counts WHERE n <> 0 ORDER BY 1, 2",
  );
  const real = await db.query<{ c: number; n: string }>(
    "SELECT collection_num AS c, count(*)::text AS n FROM rg_kb_chunks GROUP BY 1 ORDER BY 1",
  );
  const tables = await db.query<{ t: string }>(
    "SELECT tablename AS t FROM pg_tables WHERE tablename ~ '^rg_kb_vec_[0-9]+$' ORDER BY 1",
  );
  const want = real.map((r) => ({ c: r.c, i: 0, n: r.n }));
  for (const { t } of tables) {
    const rows = await db.query<{ c: number; n: string }>(
      `SELECT collection_num AS c, count(*)::text AS n FROM ${t} GROUP BY 1 ORDER BY 1`,
    );
    want.push(...rows.map((r) => ({ c: r.c, i: Number(t.slice(10)), n: r.n })));
  }
  want.sort((a, b) => a.c - b.c || a.i - b.i);
  return { kept, want };
}

/** A one-page PDF whose page is one RGB picture and no text (a scan). */
function scannedPdf(w: number, h: number): Uint8Array {
  const px = Buffer.alloc(w * h * 3, 255);
  for (let y = Math.floor(h / 3); y < Math.floor(h / 2); y++)
    px.fill(0, (y * w + 5) * 3, (y * w + w - 5) * 3);
  const img = deflateSync(px);
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im1 Do Q`;
  const objs: (string | Buffer)[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>`,
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.length} >>\nstream\n`,
      ),
      img,
      Buffer.from("\nendstream"),
    ]),
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = Buffer.from("%PDF-1.4\n");
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out = Buffer.concat([
      out,
      Buffer.from(`${i + 1} 0 obj\n`),
      Buffer.from(o),
      Buffer.from("\nendobj\n"),
    ]);
  });
  const xref = out.length;
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) x += `${String(o).padStart(10, "0")} 00000 n \n`;
  x += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.concat([out, Buffer.from(x)]));
}

describe("knowledge counters (G36.6)", () => {
  it("counts pieces and vectors in the database, through changes, removals and a new model", async () => {
    const { k, db } = await setup();
    await k.setSettings("me", { embedding: fake });
    const c = await k.createCollection("me", { name: "Docs" });
    const root = await folder("docs", {
      "a.md": "# Uno\n\nIl faro si accende al tramonto.\n\n# Due\n\nLa barca torna in porto.\n",
      "b.md": "# Tre\n\nLe reti si asciugano al sole.\n",
    });
    await k.addSource("me", c.id, { kind: "folder", path: root });
    await k.indexer.drain();
    let x = await counts(db);
    expect(x.kept).toEqual(x.want);
    expect((await k.status("me")).chunks).toBeGreaterThan(1);
    // A changed file, a removed one.
    await writeFile(join(root, "a.md"), "# Uno\n\nIl faro si accende al tramonto.\n");
    await rm(join(root, "b.md"));
    await k.indexer.scan((await k.sources("me", c.id))[0]?.id as string, true);
    await k.indexer.drain();
    x = await counts(db);
    expect(x.kept).toEqual(x.want);
    const st = await k.status("me");
    expect(st.chunks).toBe(1);
    expect(st.indexes[0]).toMatchObject({ embedded: 1, total: 1 });
    // Another model: a second table counted on its own; the old one's counters go with it.
    await k.setSettings("me", { embedding: { ...fake, model: "fake-2" } });
    await k.indexer.drain();
    x = await counts(db);
    expect(x.kept).toEqual(x.want);
    expect((await k.status("me")).indexes.map((i) => i.model)).toEqual(["fake-2"]);
    await k.removeCollection("me", c.id);
    x = await counts(db);
    expect(x.kept).toEqual([]);
    expect((await k.status("me")).chunks).toBe(0);
  });

  it("fills the counters once for a database made before them", async () => {
    const { k, db } = await setup();
    await k.setSettings("me", { embedding: fake });
    const c = await k.createCollection("me", { name: "Docs" });
    const root = await folder("docs", { "a.md": "# A\n\nuno due tre\n", "b.txt": "quattro\n" });
    await k.addSource("me", c.id, { kind: "folder", path: root });
    await k.indexer.drain();
    // As a database of G36.4 was: no counters, no triggers.
    for (const t of ["rg_kb_chunks", ...(await vecTables(db))]) {
      await db.query(`DROP TRIGGER IF EXISTS rg_kb_count_added ON ${t}`);
      await db.query(`DROP TRIGGER IF EXISTS rg_kb_count_removed ON ${t}`);
    }
    await db.query("DROP TABLE rg_kb_counts");
    await migrateKnowledge(db);
    const x = await counts(db);
    expect(x.kept).toEqual(x.want);
    expect(x.kept.length).toBe(2);
  });

  it("reads the status without counting a piece's or a vector's row", async () => {
    const { k, db } = await setup();
    await k.setSettings("me", { embedding: fake });
    const c = await k.createCollection("me", { name: "Docs" });
    await k.addSource("me", c.id, {
      kind: "folder",
      path: await folder("docs", { "a.md": "# A\n\nuno\n" }),
    });
    await k.indexer.drain();
    const asked: string[] = [];
    const query = db.query.bind(db);
    db.query = (async (sql: string, params?: unknown[]) => {
      asked.push(sql);
      return query(sql, params);
    }) as typeof db.query;
    await k.status("me");
    await k.collections("me");
    db.query = query;
    const counting = asked.filter((q) =>
      /count\(\*\)[\s\S]*FROM\s+(rg_kb_chunks|rg_kb_vec_)/i.test(q),
    );
    expect(counting).toEqual([]);
  });
});

const vecTables = async (db: SqlClient) =>
  (
    await db.query<{ t: string }>(
      "SELECT tablename AS t FROM pg_tables WHERE tablename ~ '^rg_kb_vec_[0-9]+$'",
    )
  ).map((r) => r.t);

/** A server with the knowledge on (fake embeddings), as main.ts wires it. */
async function kbServer(script: Parameters<typeof startServer>[0] = () => ({ text: "ok" })) {
  let k: KnowledgeService | undefined;
  const api = fakeApi(32);
  const server = await startServer(script, {}, {}, undefined, undefined, async (core, sdir) => {
    k = new KnowledgeService({
      db: core.db,
      store: core.store,
      jobs: core.jobs,
      dataDir: join(sdir, "data"),
      local: new LocalEmbedServers({ dataDir: join(sdir, "data"), jobs: core.jobs }),
      keyedFetch: () => api.keyed,
      scopeRoot: (o, scope) => core.scopeFolder(o, scope),
      chats: core.knowledgeChats(),
      agentProjects: async (_o, agentId) => {
        const a = core.registry.get(agentId);
        return a?.projectId ? [a.projectId] : [];
      },
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
  return { server, k: k as KnowledgeService, api };
}

const finished = async (s: { api: Awaited<ReturnType<typeof startServer>>["api"] }, job: Job) => {
  for (let i = 0; i < 400; i++) {
    const { body } = await s.api<Job>("GET", `/api/jobs/${job.id}`);
    if (body.state !== "running") return body;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error("The job did not end");
};

describe("agents and the knowledge (G36.5)", () => {
  it("gives each agent its scope, and the person's own choice on top", async () => {
    const { k } = await setup({ projects: { coder: ["alpha"] } });
    const all = await k.createCollection("me", { name: "Tutti" });
    const mine = await k.createCollection("me", {
      name: "Del coder",
      scope: { kind: "agent", agentId: "coder" },
    });
    const alpha = await k.createCollection("me", {
      name: "Alpha",
      scope: { kind: "project", projectId: "alpha" },
    });
    const other = await k.createCollection("me", {
      name: "Altro",
      scope: { kind: "agent", agentId: "writer" },
    });
    const names = async (agentId: string, projectIds: string[]) =>
      (await k.visible("me", { kind: "agent", agentId, projectIds })).map((c) => c.name).sort();
    expect(await names("coder", ["alpha"])).toEqual(["Alpha", "Del coder", "Tutti"]);
    // The person takes one away and gives another.
    await k.setAgentAccess("me", "coder", all.id, "off");
    const view = await k.setAgentAccess("me", "coder", other.id, "on");
    expect(await names("coder", ["alpha"])).toEqual(["Alpha", "Altro", "Del coder"]);
    expect(view.map((c) => [c.name, c.byScope, c.own, c.on])).toEqual([
      ["Alpha", true, null, true],
      ["Altro", false, "on", true],
      ["Del coder", true, null, true],
      ["Tutti", true, "off", false],
    ]);
    // Back to the scope: the choice goes, the settings stay small.
    await k.setAgentAccess("me", "coder", all.id, null);
    await k.setAgentAccess("me", "coder", other.id, null);
    expect((await k.settings("me")).agents).toEqual({});
    expect(await names("writer", [])).toEqual(["Altro", "Tutti"]);
    expect(mine.id).not.toBe(alpha.id);
    await expect(k.setAgentAccess("me", "coder", "kc_nope", "on")).rejects.toThrow(/No collection/);
  });

  it("answers the agent's search with numbered pieces and links to cite, only from its collections", async () => {
    const { k } = await setup();
    await k.setSettings("me", { embedding: fake });
    const c = await k.createCollection("me", { name: "Manuali", description: "Come si usa" });
    const hidden = await k.createCollection("me", {
      name: "Segreti",
      scope: { kind: "agent", agentId: "someone" },
    });
    await k.addSource("me", c.id, {
      kind: "folder",
      path: await folder("docs", {
        "faro.md": "# Il faro\n\nIl guardiano accende la lanterna del faro al tramonto.\n",
      }),
    });
    await k.addSource("me", hidden.id, {
      kind: "folder",
      path: await folder("secret", { "x.md": "# Faro segreto\n\nLa lanterna segreta del faro.\n" }),
    });
    await k.indexer.drain();
    const tool = searchKnowledgeTool(() => k, { kind: "agent", agentId: "coder", projectIds: [] });
    expect(tool.def.description.length).toBeLessThan(160);
    const ctx = { ownerId: "me", projectId: null, agentId: "coder", sessionId: "s1" };
    const out = String(await tool.run({ query: "lanterna del faro" }, ctx));
    expect(out).toMatch(/^1 pieces \(meaning and words\)\. Cite/);
    expect(out).toMatch(/\[1\] \[Il faro, lines 1-3\]\(#kb:\d+\) — Manuali · Il faro\n/);
    expect(out).not.toContain("segreta");
    const named = await tool.run({ query: "faro", collections: ["segreti"] }, ctx);
    expect(named).toMatchObject({ isError: true });
    expect(String((named as { content: string }).content)).toContain("Yours: Manuali");
    const none = searchKnowledgeTool(() => k, { kind: "agent", agentId: "x", projectIds: [] });
    await k.setAgentAccess("me", "x", c.id, "off");
    expect(String(await none.run({ query: "faro" }, { ...ctx, agentId: "x" }))).toContain(
      "You can read no knowledge collection",
    );
    // The prompt says what it can search, and how to cite.
    const section = knowledgeSection(
      await k.visible("me", { kind: "agent", agentId: "coder", projectIds: [] }),
    );
    expect(section).toContain("- Manuali: Come si usa");
    expect(section).toContain("(#kb:123)");
    expect(knowledgeSection([])).toBe("");
  });

  it("names citations by page, lines, mail and conversation", () => {
    const base = {
      collectionId: "c",
      documentId: "1",
      chunkId: "9",
      path: "p",
      title: "Guida [v2]",
    };
    expect(citationLabel({ ...base, source: "folder", page: 3 })).toBe("Guida v2, p. 3");
    expect(citationLabel({ ...base, source: "folder", lineStart: 4, lineEnd: 4 })).toBe(
      "Guida v2, line 4",
    );
    expect(citationLabel({ ...base, source: "mail" })).toBe("Mail: Guida v2");
    expect(citationLabel({ ...base, source: "chats" })).toBe("Conversation: Guida v2");
    expect(formatHits({ hits: [], strategy: "exact", indexId: 1, ms: 1 }, new Map())).toContain(
      "Nothing found",
    );
    expect(
      joinPieces(["one two three four five six seven", "six seven eight nine ten eleven"]),
    ).toBe("one two three four five six seven\n\nsix seven eight nine ten eleven");
    const long = "x".repeat(30);
    expect(joinPieces([`a ${long}`, `${long} b`])).toBe(`a ${long} b`);
  });

  it("gives an agent the tool, its collections in the prompt, and cites what it found", async () => {
    const systems: string[] = [];
    let result = "";
    const { server, k } = await kbServer((req: CompletionRequest) => {
      systems.push(req.system ?? "");
      const last = req.messages.at(-1)?.parts.find((p) => p.type === "tool_result");
      if (last && last.type === "tool_result") {
        result = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
        const link = /\[1\] (\[[^\]]+\]\(#kb:\d+\))/.exec(result)?.[1];
        return { text: `Si accende al tramonto [1].\n\nFonti:\n1. ${link}` };
      }
      expect(req.tools.map((t) => t.name)).toContain("search_knowledge");
      return {
        toolCalls: [{ name: "search_knowledge", input: { query: "quando si accende il faro" } }],
      };
    });
    await server.api("PUT", "/api/knowledge/settings", { embedding: fake });
    const made = await server.api<{ id: string }>("POST", "/api/knowledge/collections", {
      name: "Fari",
    });
    await server.api("POST", `/api/knowledge/collections/${made.body.id}/sources`, {
      kind: "folder",
      path: await folder("fari", { "faro.md": "# Faro\n\nIl faro si accende al tramonto.\n" }),
    });
    await k.indexer.drain();
    const god = await server.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const sid = (
      await server.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god.body.id })
    ).body.sessionId;
    await (await server.core.send("me", sid, "Quando si accende il faro?")).done;
    expect(systems[0]).toContain("## Knowledge");
    expect(systems[0]).toContain("- Fari");
    expect(result).toMatch(/\[1\] \[Faro, lines 1-3\]\(#kb:(\d+)\)/);
    const chunk = /#kb:(\d+)/.exec(result)?.[1];
    const opened = await server.api<{ target: { path: string; at: { line: number } } }>(
      "GET",
      `/api/knowledge/open/${chunk}`,
    );
    expect(opened.body.target.at).toEqual({ line: 1 });
    // The agent's window: its collections, then one taken away.
    const view = await server.api<{ collections: { name: string; on: boolean }[] }>(
      "GET",
      `/api/knowledge/agents/${god.body.id}`,
    );
    expect(view.body.collections).toMatchObject([{ name: "Fari", on: true }]);
    const off = await server.api<{ collections: { on: boolean; own: string }[] }>(
      "PUT",
      `/api/knowledge/agents/${god.body.id}`,
      { collection: made.body.id, pick: "off" },
    );
    expect(off.body.collections[0]).toMatchObject({ on: false, own: "off" });
    // A new conversation knows it can read nothing now (no section, the tool says so).
    const sid2 = (
      await server.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god.body.id })
    ).body.sessionId;
    await (await server.core.send("me", sid2, "E ora?")).done;
    expect(systems.at(-2)).not.toContain("## Knowledge");
    expect(result).toContain("You can read no knowledge collection");
    const disk = await server.api<{ texts: number; vectors: number; models: number; ocr: number }>(
      "GET",
      "/api/knowledge/disk",
    );
    expect(disk.body.texts).toBeGreaterThan(0);
    expect(disk.body.vectors).toBeGreaterThan(0);
    expect(disk.body).toMatchObject({ models: 0, ocr: 0 });
  });
});

describe("OCR (G36.6)", () => {
  it("leaves pictures and scans waiting while the OCR is off, then reads them", async () => {
    const ocr = fakeOcr();
    const { k } = await setup({ ocr: ocr.engine });
    await k.setSettings("me", { embedding: fake });
    const c = await k.createCollection("me", { name: "Scansioni" });
    const png = pngOf({ width: 4, height: 2, kind: 2, data: new Uint8Array(24).fill(200) });
    await k.addSource("me", c.id, {
      kind: "folder",
      path: await folder("scans", {
        "fattura.png": png,
        "scansione.pdf": scannedPdf(60, 40),
        "foto.heic": "not really",
      }),
    });
    await k.indexer.drain();
    const docs = async () =>
      Object.fromEntries(
        (await k.documents("me", c.id)).map((d) => [d.path, [d.state, d.reason ?? d.kind]]),
      );
    expect(await docs()).toEqual({
      "fattura.png": ["skipped", "needs_ocr"],
      "foto.heic": ["skipped", "unsupported"],
      "scansione.pdf": ["skipped", "needs_ocr"],
    });
    expect((await k.status("me")).ocr).toEqual({
      on: false,
      languages: ["eng"],
      ready: false,
      waiting: 2,
    });
    await expect(
      k.setSettings("me", { ocr: { on: true, languages: ["klingon"] } }),
    ).rejects.toThrow(/Unknown OCR language/);
    await k.setSettings("me", { ocr: { on: true, languages: ["ita", "eng"] } });
    // The download (here: at once) and then the waiting ones read again.
    await new Promise((r) => setTimeout(r, 20));
    await k.indexer.drain();
    expect(ocr.state.ensured).toBe(1);
    expect(await docs()).toEqual({
      "fattura.png": ["indexed", "image"],
      "foto.heic": ["skipped", "unsupported"],
      "scansione.pdf": ["indexed", "pdf"],
    });
    // The scan's page went to the OCR as a PNG of the page's picture.
    const scan = ocr.state.seen.find((b) => Buffer.from(b).equals(Buffer.from(png)) === false);
    expect(
      Buffer.from(scan as Uint8Array)
        .subarray(1, 4)
        .toString(),
    ).toBe("PNG");
    expect(Buffer.from(scan as Uint8Array).readUInt32BE(16)).toBe(60);
    const hits = (await k.search("me", { query: "fattura Rossi" })).hits;
    expect(hits.map((h) => [h.citation.title, h.citation.page ?? null]).sort()).toEqual([
      ["fattura.png", null],
      ["scansione.pdf", 1],
    ]);
    expect((await k.status("me")).ocr).toMatchObject({ on: true, ready: true, waiting: 0 });
    expect((await k.disk()).ocr).toBe(4321);
  });

  it("writes pixels as a PNG that reads back", () => {
    const rgb = new Uint8Array(3 * 3 * 2).map((_, i) => i * 7);
    const png = Buffer.from(pngOf({ width: 3, height: 2, kind: 2, data: rgb }));
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]]).toEqual([3, 2, 8, 2]);
    const idatLen = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect([...raw.subarray(1, 10)]).toEqual([...rgb.subarray(0, 9)]);
    // One bit per pixel, set = white.
    const bits = Buffer.from(
      pngOf({ width: 2, height: 1, kind: 1, data: new Uint8Array([0b10000000]) }),
    );
    const one = inflateSync(bits.subarray(41, 41 + bits.readUInt32BE(33)));
    expect([...one]).toEqual([0, 255, 0]);
  });
});

describe("mail and conversations as sources (G36.6)", () => {
  it("needs the person's yes, then indexes mail and opens a citation as its text", async () => {
    const box = new Map([
      [
        "11",
        {
          subject: "Preventivo cucina",
          from: "Rossi <r@x.it>",
          date: "2026-10-01T10:00:00Z",
          text: "Buongiorno,\n\nil preventivo per la cucina è di 4.200 euro.\n\n> testo citato\n\n-- \nfirma",
        },
      ],
      [
        "12",
        {
          subject: "Cena",
          from: "Anna",
          date: "2026-10-03T10:00:00Z",
          text: "Ci vediamo alle otto.",
        },
      ],
    ]);
    const mail: MailSource = {
      boxes: async () => [{ id: "mb1", name: "Lavoro" }],
      list: async () =>
        [...box].map(([id, m]) => ({
          id,
          title: m.subject,
          at: Date.parse(m.date),
          size: m.text.length,
        })),
      read: async (_o, _b, id) => box.get(id),
    };
    const { k, api } = await setup({ mail });
    await k.setSettings("me", { embedding: fake });
    const c = await k.createCollection("me", { name: "Posta" });
    expect(KnowledgeSourceInput.safeParse({ kind: "mail", mailbox: "mb1" }).success).toBe(false);
    await expect(k.addSource("me", c.id, { kind: "mail", mailbox: "mb1" })).rejects.toThrow();
    await expect(
      k.addSource("me", c.id, { kind: "mail", mailbox: "nope", consent: true }),
    ).rejects.toThrow(/No mailbox/);
    await k.addSource("me", c.id, { kind: "mail", mailbox: "mb1", days: 30, consent: true });
    await k.indexer.drain();
    const hit = (await k.search("me", { query: "preventivo cucina euro" })).hits[0];
    expect(hit?.citation).toMatchObject({
      source: "mail",
      path: "mb1/11",
      title: "Preventivo cucina",
    });
    expect(hit?.text).not.toContain("testo citato");
    const opened = await k.open("me", hit?.citation.chunkId as string);
    expect(opened).toMatchObject({ title: "Preventivo cucina" });
    expect((opened as { text: string }).text).toContain("From: Rossi <r@x.it>");
    // Looked at again: nothing changed, nothing embedded again; a mail gone goes.
    const before = api.calls.texts;
    const source = (await k.sources("me", c.id))[0]?.id as string;
    await k.indexer.scan(source, false);
    await k.indexer.drain();
    expect(api.calls.texts).toBe(before);
    box.delete("12");
    await k.indexer.scan(source, false);
    await k.indexer.drain();
    expect((await k.documents("me", c.id)).map((d) => d.title)).toEqual(["Preventivo cucina"]);
  });

  it("indexes the person's conversations and opens a citation in the conversation", async () => {
    const chats: ChatSource = {
      list: async (_o, agents) =>
        agents.length && !agents.includes("a1")
          ? []
          : [{ id: "ses_1", title: "Le ferie", at: 1_700_000_000_000, size: 0 }],
      read: async (_o, id) =>
        id === "ses_1"
          ? {
              title: "Le ferie",
              agentId: "a1",
              agentName: "Assistente",
              messages: [
                {
                  who: "person",
                  at: "2026-08-01T09:00:00Z",
                  text: "Prenota l'albergo a Lisbona per agosto.",
                },
                {
                  who: "agent",
                  at: "2026-08-01T09:01:00Z",
                  text: "Fatto: Hotel Alfama, dal 10 al 17.",
                },
              ],
            }
          : undefined,
    };
    const { k } = await setup({ chats });
    await k.setSettings("me", { embedding: fake });
    const c = await k.createCollection("me", { name: "Conversazioni" });
    await k.addSource("me", c.id, { kind: "chats", agents: ["a1"], consent: true });
    await k.indexer.drain();
    const hit = (await k.search("me", { query: "albergo Lisbona" })).hits[0];
    expect(hit?.citation).toMatchObject({ source: "chats", path: "ses_1", title: "Le ferie" });
    expect(hit?.citation.heading).toBe("2026-08-01");
    expect(hit?.text).toContain("Person: Prenota l'albergo");
    expect(await k.open("me", hit?.citation.chunkId as string)).toMatchObject({
      chat: { sessionId: "ses_1", agentId: "a1" },
    });
  });
});

describe("the knowledge in a backup (G36.6)", () => {
  it("carries pieces and vectors as float16 and puts them back without the model", async () => {
    const a = await kbServer();
    expect(
      (
        await a.server.api("PUT", "/api/knowledge/settings", {
          embedding: fake,
          backupVectors: true,
        })
      ).status,
    ).toBe(200);
    const made = await a.server.api<{ id: string }>("POST", "/api/knowledge/collections", {
      name: "Docs",
    });
    await a.server.api("POST", `/api/knowledge/collections/${made.body.id}/sources`, {
      kind: "folder",
      path: await folder("docs", {
        "a.md": "# Faro\n\nIl faro si accende al tramonto.\n\n# Porto\n\nLe barche tornano.\n",
      }),
    });
    await a.k.indexer.drain();
    const exported = await finished(
      a.server,
      (await a.server.api<Job>("POST", "/api/backup/export")).body,
    );
    expect(exported.state).toBe("done");
    const data = Buffer.from(
      await (
        await fetch(`${a.server.url}/api/backup/file/${exported.vars.file}`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).arrayBuffer(),
    );
    // Into a new RedGiant with no model chosen yet.
    const b = await kbServer();
    const up = await fetch(`${b.server.url}/api/backup/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream" },
      body: data,
    });
    const id = ((await up.json()) as { id: string }).id;
    const imported = await finished(
      b.server,
      (await b.server.api<Job>("POST", "/api/backup/import", { id })).body,
    );
    expect(imported.state).toBe("done");
    expect((await b.k.settings("me")).embedding).toMatchObject({ model: "fake" });
    await b.k.indexer.drain();
    // Same files: nothing embedded again, and the search answers by meaning.
    expect(b.api.calls.texts).toBe(0);
    const st = await b.k.status("me");
    expect(st.indexes[0]).toMatchObject({ embedded: 2, total: 2, state: "ready" });
    const hit = (await b.k.search("me", { query: "faro tramonto" })).hits[0];
    expect(hit?.citation).toMatchObject({ title: "Faro", lineStart: 1 });
    expect(hit?.ranks.meaning).toBe(1);
    // Without the choice, a backup carries no knowledge.
    await a.server.api("PUT", "/api/knowledge/settings", { backupVectors: false });
    const plain = await finished(
      a.server,
      (await a.server.api<Job>("POST", "/api/backup/export")).body,
    );
    const small = await fetch(`${a.server.url}/api/backup/file/${plain.vars.file}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect((await small.arrayBuffer()).byteLength).toBeLessThan(data.length);
  });

  it("packs vectors as float16 exactly", () => {
    for (const v of [0, 1, -1, 0.5, 0.33325, -0.0001, 65504, 6.1e-5, 1e-7])
      expect(fromHalf(toHalf(fromHalf(toHalf(v))))).toBe(fromHalf(toHalf(v)));
    expect(fromHalf(toHalf(0.33325))).toBeCloseTo(0.33325, 3);
    expect(unpackVector(packVector("[0.5,-0.25,1]"))).toBe("[0.5,-0.25,1]");
  });
});

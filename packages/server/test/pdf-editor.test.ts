// PDFs in the editor from end to end (G37.8), with a scripted model (FakeProvider) and a page on
// the WebSocket: canvas_edit's catalog and structure, the agent's highlight, note and fields seen
// by the page and written as an incremental update (the file's first bytes are the original's);
// a page taken out (the file written anew, the version before kept and downloadable); the person's
// own field and redaction (checked first; a form field under the area is refused).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PdfOutline, ServerMessage } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { pageLines } from "../src/editor/pdf-text.js";
import { samplePdf } from "./fixtures/pdf-samples.js";
import { startServer, TOKEN, wsClient } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

type Req = { messages: { role: string; parts: { type: string; content?: string }[] }[] };
const resultOf = (req: Req) =>
  (
    req.messages.at(-1)?.parts.find((p) => p.type === "tool_result") as
      | { content: string }
      | undefined
  )?.content;
function calls(list: { name: string; input: unknown }[], seen: string[]) {
  let i = 0;
  return (req: Req) => {
    const r = resultOf(req);
    if (r !== undefined) seen.push(r);
    const next = list[i++];
    return next ? { toolCalls: [next] } : { text: "Done." };
  };
}

const pdf = { scope: "platform", path: "docs/contratto.pdf" };
const enc = encodeURIComponent;

async function setup(script: (req: Req) => unknown) {
  s = await startServer(
    script as never,
    { contextWindow: 65_536 },
    { editor: { saveDelayMs: 0, watchMs: 0 } },
  );
  const g = await s.api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: "God",
  });
  const sessionId = (
    await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: g.body.id })
  ).body.sessionId;
  const root = await s.core.scopeFolder("me", "platform");
  const original = await samplePdf();
  await mkdir(dirname(join(root, pdf.path)), { recursive: true });
  await writeFile(join(root, pdf.path), original);
  return { sessionId, root, original };
}

const only = <T extends ServerMessage["type"]>(c: { messages: ServerMessage[] }, type: T) =>
  c.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
const get = (sv: Server, path: string) =>
  fetch(`${sv.url}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });

describe("PDFs in the editor (G37.8)", () => {
  it("the agent reads, highlights, notes and fills; the page sees it; the file keeps its original", async () => {
    const seen: string[] = [];
    const { sessionId, root, original } = await setup(
      calls(
        [
          { name: "canvas_edit", input: { path: pdf.path, help: true } },
          { name: "canvas_look", input: { path: pdf.path, view: "structure" } },
          {
            name: "canvas_edit",
            input: {
              path: pdf.path,
              ops: [
                { op: "annotate", page: 1, kind: "highlight", find: "Mario Rossi" },
                { op: "annotate", page: 2, kind: "note", at: [400, 700], text: "Da rileggere" },
                { op: "fill_field", name: "nome", value: "Mario Rossi" },
                { op: "fill_field", name: "consenso", value: true },
              ],
            },
          },
          {
            name: "canvas_edit",
            input: { path: pdf.path, ops: [{ op: "fill_field", name: "citta", value: "Parigi" }] },
          },
        ],
        seen,
      ),
    );
    const sv = s as Server;
    const page = await wsClient(sv.url);
    await page.waitFor("welcome");
    page.send({ type: "doc.open", file: pdf });
    const opened = await page.waitFor("doc.opened");
    expect(opened).toMatchObject({
      family: "pdf",
      revision: 0,
      snapshot: { family: "pdf", pending: 0 },
    });
    await (await sv.core.send("me", sessionId, "Prepara il contratto")).done;
    expect(seen[0]).toMatch(/^PDF operations/);
    expect(seen[1]).toContain("PDF, 3 pages.");
    expect(seen[1]).toContain('«nome» text, page 1 = ""');
    expect(seen[1]).toContain("Il cliente Mario Rossi abita a Roma in via Garibaldi 12.");
    expect(seen[2]).toMatch(/^Applied as revision 1: 4 changes/);
    expect(seen[3]).toMatch(/Nothing applied: operation 1: «Parigi» is not a choice of «citta»/);
    const changed = only(page, "doc.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.change.summary).toMatchObject({
      kind: "edit",
      count: 4,
      pdf: { action: "other", n: 4 },
    });
    // The head's bytes for the page (the actions written in memory) and its outline.
    const head = await get(sv, `/api/editor/pdf/outline?scope=platform&path=${enc(pdf.path)}`);
    const o = (await head.json()) as { revision: number; outline: PdfOutline };
    expect(o.revision).toBe(1);
    expect(o.outline.pages[0]?.annots.map((a) => a.kind)).toEqual(["highlight"]);
    expect(o.outline.fields.find((f) => f.name === "nome")?.value).toBe("Mario Rossi");
    // Written by the host: an incremental update, the original intact at the head.
    await sv.core.editor.flush();
    const disk = new Uint8Array(await readFile(join(root, pdf.path)));
    expect(Buffer.from(disk.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true);
    expect(disk.length).toBeGreaterThan(original.length);
    const bytes = await get(sv, `/api/editor/pdf/file?scope=platform&path=${enc(pdf.path)}`);
    expect(bytes.headers.get("x-revision")).toBe("1");
    expect(Buffer.from(await bytes.arrayBuffer()).equals(Buffer.from(disk))).toBe(true);
    page.close();
  });

  it("a page taken out: written anew, the version before kept and downloadable, undone from the panel", async () => {
    const seen: string[] = [];
    const { sessionId, root, original } = await setup(
      calls(
        [{ name: "canvas_edit", input: { path: pdf.path, ops: [{ op: "delete_page", page: 2 }] } }],
        seen,
      ),
    );
    const sv = s as Server;
    const page = await wsClient(sv.url);
    await page.waitFor("welcome");
    page.send({ type: "doc.open", file: pdf });
    await page.waitFor("doc.opened");
    await (await sv.core.send("me", sessionId, "Togli la seconda pagina")).done;
    expect(seen[0]).toMatch(
      /Took out page 2 \(the file is written anew, the version before is kept\)/,
    );
    await sv.core.editor.flush();
    const disk = new Uint8Array(await readFile(join(root, pdf.path)));
    expect(Buffer.from(disk).toString("latin1").split("%%EOF").length - 1).toBe(1);
    const list = (await (
      await get(sv, `/api/editor/pdf/versions?scope=platform&path=${enc(pdf.path)}`)
    ).json()) as {
      versions: { name: string }[];
    };
    expect(list.versions).toHaveLength(1);
    const v = await get(
      sv,
      `/api/editor/pdf/version?scope=platform&path=${enc(pdf.path)}&name=${enc(list.versions[0]?.name ?? "")}`,
    );
    expect(Buffer.from(await v.arrayBuffer()).equals(Buffer.from(original))).toBe(true);
    // A name that is not a version of this file.
    expect(
      (
        await get(
          sv,
          `/api/editor/pdf/version?scope=platform&path=${enc(pdf.path)}&name=..%2Fstate.json`,
        )
      ).status,
    ).toBe(400);
    // «Annulla questa modifica»: the page comes back with its text.
    page.send({ type: "doc.undo", file: pdf, clientId: "u1", revision: 1 });
    await page.waitFor("doc.ack");
    await sv.core.editor.flush();
    const back = new Uint8Array(await readFile(join(root, pdf.path)));
    expect(((await pageLines(back, [1])).get(1) ?? []).map((l) => l.text)).toContain(
      "Qui il testo continua con altre parole.",
    );
    page.close();
  });

  it("the person fills a field and redacts: checked first, a form field under the area refused", async () => {
    const { root, original } = await setup(calls([], []));
    const sv = s as Server;
    const page = await wsClient(sv.url);
    await page.waitFor("welcome");
    page.send({ type: "doc.open", file: pdf });
    await page.waitFor("doc.opened");
    page.send({
      type: "doc.ops",
      file: pdf,
      clientId: "c1",
      baseRevision: 0,
      groupId: "g1",
      ops: [
        {
          family: "pdf",
          engine: "redgiant-pdf",
          engineVersion: "1",
          op: { t: "fill_field", name: "nome", value: "Anna", before: "" },
        },
      ],
    });
    expect((await page.waitFor("doc.ack")).revision).toBe(1);
    const post = (body: unknown) =>
      fetch(`${sv.url}/api/editor/pdf/redact`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const bad = await post({ ...pdf, page: 0, rects: [[60, 460, 300, 500]] });
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { error: string }).error).toMatch(/form field is under the area/);
    const ok = await post({ ...pdf, page: 0, rects: [[120, 714, 190, 733]] });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { revision: number }).revision).toBe(2);
    await sv.core.editor.flush();
    const disk = new Uint8Array(await readFile(join(root, pdf.path)));
    // Written anew: the original's bytes (with the name) are not inside anymore.
    expect(Buffer.from(disk.subarray(0, original.length)).equals(Buffer.from(original))).toBe(
      false,
    );
    const text = ((await pageLines(disk, [0])).get(0) ?? []).map((l) => l.text).join(" ");
    expect(text).not.toMatch(/Mario|Rossi/);
    expect(text).toContain("Il cliente");
    page.close();
  });
});

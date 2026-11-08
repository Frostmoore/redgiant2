// Documents and presentations in the editor from end to end (G37.4), with a scripted model
// (FakeProvider) and a fake engine that writes the outline back as ODF (LibreOffice itself is
// in office-engine.test.ts): canvas_edit's catalog, structure, an edit the page sees and the host
// writes, a picture of the workspace, a DOCX edited on its open copy and written back when the
// person asked (the previous original kept); the page's own saved file with the agent's later
// edit made again after it; the person's find and replace without the full editor; «Esporta come».
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  docKey,
  type OfficeDocOp,
  type OfficePlainAction,
  type ServerMessage,
} from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { OfficeEngine } from "../src/editor/office-engine.js";
import { applyAction } from "../src/editor/office-ops.js";
import { readOutline } from "../src/editor/office-outline.js";
import { odfOfOutline, PNG, sampleOdt } from "./fixtures/office-samples.js";
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

/** LibreOffice in a few lines: the actions on the outline, written back as ODF. */
const applied: OfficePlainAction[][] = [];
const engine: OfficeEngine = {
  async apply(_owner, bytes, ops) {
    applied.push([...ops]);
    let o = readOutline(bytes);
    const skipped: { index: number; error: string }[] = [];
    for (const [index, a] of ops.entries())
      try {
        o = applyAction(o, a, () => undefined);
      } catch (err) {
        skipped.push({ index, error: (err as Error).message });
      }
    return { bytes: odfOfOutline(o), skipped };
  },
  async convert(_owner, _bytes, from, to) {
    return new TextEncoder().encode(`converted ${from} to ${to}`);
  },
};

const odt = { scope: "platform", path: "docs/verbale.odt" };
const docx = { scope: "platform", path: "docs/relazione.docx" };
const copy = { scope: "platform", path: "docs/relazione.docx.open/relazione.odt" };

async function setup(script: (req: Req) => unknown) {
  applied.length = 0;
  s = await startServer(
    script as never,
    { contextWindow: 65_536 },
    {
      editor: { saveDelayMs: 0, watchMs: 0 },
      officeEngine: engine,
    },
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
  const put = async (p: string, b: Uint8Array) => {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), b);
  };
  await put(odt.path, sampleOdt());
  await put(docx.path, new TextEncoder().encode("the person's docx"));
  await put(copy.path, sampleOdt());
  await put(
    `${dirname(copy.path)}/conversion.json`,
    new TextEncoder().encode(
      '{"source":"docs/relazione.docx","sourceSize":1,"sourceModifiedAt":"x","format":"docx","outputs":[],"losses":[],"via":["libreoffice"],"convertedAt":"x"}',
    ),
  );
  await put("img/logo.png", PNG);
  return { sessionId, root };
}

const only = <T extends ServerMessage["type"]>(c: { messages: ServerMessage[] }, type: T) =>
  c.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);

describe("documents in the editor (G37.4)", () => {
  it("the agent reads, edits and puts a picture; the page sees it; the host writes it", async () => {
    const seen: string[] = [];
    const { sessionId, root } = await setup(
      calls(
        [
          { name: "canvas_edit", input: { path: odt.path, help: true } },
          { name: "canvas_look", input: { path: odt.path, view: "structure" } },
          {
            name: "canvas_edit",
            input: {
              path: odt.path,
              ops: [
                { op: "replace_text", find: "fessure", text: "crepe" },
                {
                  op: "insert_paragraph",
                  after: 2,
                  text: "Sopralluogo del 4 novembre",
                  style: "Heading 2",
                },
                { op: "insert_image", after: 9, path: "img/logo.png", width_mm: 30 },
              ],
            },
          },
          {
            name: "canvas_edit",
            input: { path: odt.path, ops: [{ op: "set_style", paragraph: 99, style: "Title" }] },
          },
        ],
        seen,
      ),
    );
    const page = await wsClient((s as Server).url);
    await page.waitFor("welcome");
    page.send({ type: "doc.open", file: odt });
    const opened = await page.waitFor("doc.opened");
    expect(opened).toMatchObject({
      family: "document",
      revision: 0,
      snapshot: { family: "document", app: "writer", pending: [], count: 9 },
    });
    await (await (s as Server).core.send("me", sessionId, "Sistema il verbale")).done;
    expect(seen[0]).toMatch(/^Documents and presentations/);
    expect(seen[0]).toContain("insert_paragraph {after");
    expect(seen[1]).toContain("revision 0. A text document (LibreOffice Writer): 9 items");
    expect(seen[1]).toContain("T6 table «Misure» 2×2:");
    expect(seen[2]).toMatch(
      /^Applied as revision 1: 3 changes: replaced «fessure» with «crepe» in paragraph 3/,
    );
    expect(seen[3]).toMatch(/Nothing applied: operation 1: there are 11 items: no 99/);
    const changed = only(page, "doc.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.change.summary).toMatchObject({
      unit: "paragraph",
      line: 3,
      kind: "edit",
      count: 3,
    });
    const ops = changed[0]?.ops as OfficeDocOp[];
    expect(ops.map((o) => o.op.t)).toEqual(["text", "insert_item", "insert_item"]);
    // The picture went to the blobs, cited by its hash, with its size from the file (30 mm wide).
    const pic =
      (ops[2] as OfficeDocOp).op.t === "insert_item"
        ? ((ops[2] as OfficeDocOp).op as Extract<OfficePlainAction, { t: "insert_item" }>).picture
        : undefined;
    expect(pic).toMatchObject({ mime: "image/png", w: 3000, h: 3000 });
    const blob = await fetch(`${(s as Server).url}/api/editor/blobs/${pic?.blob}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PNG);
    // Written by the engine (no page with the full editor would have).
    await (s as Server).core.editor.flush();
    const disk = readOutline(await readFile(join(root, odt.path)));
    expect(disk.app === "writer" && disk.items.map((i) => (i.k === "p" ? i.text : i.name))).toEqual(
      [
        "Verbale di sopralluogo",
        "1. Stato dei luoghi",
        "Sopralluogo del 4 novembre",
        "Il prospetto  nord ha crepe.\nDa monitorare.",
        "Punto A1",
        "Punto B2",
        "Misure",
        "Nota nella sezione.",
        "",
        "",
        "Firmato: ing. Rossi.",
      ],
    );
    expect(applied).toHaveLength(1);
    page.close();
  });

  it("the page's saved file: kept as a blob, its items found, the agent's later edit made again after it", async () => {
    const seen: string[] = [];
    const { sessionId, root } = await setup(
      calls(
        [
          {
            name: "canvas_edit",
            input: {
              path: odt.path,
              ops: [{ op: "replace_text", find: "Firmato", text: "Visto" }],
            },
          },
        ],
        seen,
      ),
    );
    const sv = s as Server;
    const page = await wsClient(sv.url);
    await page.waitFor("welcome");
    page.send({ type: "doc.open", file: odt });
    const opened = await page.waitFor("doc.opened");
    const base = opened.snapshot.family === "document" ? opened.snapshot.base : "";
    // The page loads the bytes the snapshot names.
    const got = await fetch(
      `${sv.url}/api/editor/office/file?scope=platform&path=${encodeURIComponent(odt.path)}&hash=${base}`,
      {
        headers: { authorization: `Bearer ${TOKEN}` },
      },
    );
    expect(got.status).toBe(200);
    // The agent edits the last paragraph (revision 1) while the person types at the top.
    await (await sv.core.send("me", sessionId, "Firma")).done;
    expect(seen[0]).toMatch(/^Applied as revision 1/);
    const mine = readOutline(sampleOdt());
    if (mine.app !== "writer") throw new Error("writer");
    mine.items[0] = { ...mine.items[0], text: "Verbale n. 47" } as (typeof mine.items)[number];
    const up = await fetch(
      `${sv.url}/api/editor/office/upload?scope=platform&path=${encodeURIComponent(odt.path)}&base=0`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: odfOfOutline(mine),
      },
    );
    const r = (await up.json()) as {
      blob: string;
      size: number;
      hunks: { at: number; del: number; ins: number }[];
    };
    expect(r.hunks).toEqual([{ at: 0, del: 1, ins: 1 }]);
    page.send({
      type: "doc.ops",
      file: odt,
      clientId: "save-1",
      baseRevision: 0,
      groupId: "g1",
      ops: [
        {
          family: "document",
          engine: "libreoffice-uno",
          engineVersion: "1",
          op: { t: "file", blob: r.blob, size: r.size, hunks: r.hunks },
        },
      ],
    });
    const ack = await page.waitFor("doc.ack", (m) => m.clientId === "save-1");
    expect(ack).toMatchObject({
      revision: 2,
      change: { author: "person", summary: { text: "edited paragraphs 1 in the document" } },
    });
    await sv.core.editor.flush();
    const disk = readOutline(await readFile(join(root, odt.path)));
    // The person's title and the agent's signature, both.
    expect(
      disk.app === "writer" &&
        [disk.items[0], disk.items.at(-1)].map((i) => (i?.k === "p" ? i.text : "")),
    ).toEqual(["Verbale n. 47", "Visto: ing. Rossi."]);
    // The engine made only the agent's edit again, on the person's file.
    expect(applied.at(-1)?.map((a) => a.t)).toEqual(["text"]);
    page.close();
  });

  it("a DOCX is edited on its open copy and written back when the person asked; the previous kept", async () => {
    const seen: string[] = [];
    const { sessionId, root } = await setup(
      calls(
        [
          { name: "canvas_look", input: { path: docx.path, view: "structure" } },
          {
            name: "canvas_edit",
            input: { path: docx.path, ops: [{ op: "replace_text", find: "Rossi", text: "Verdi" }] },
          },
        ],
        seen,
      ),
    );
    const sv = s as Server;
    const cur = await sv.api<{ settings: Record<string, unknown> }>("GET", "/api/settings/editor");
    await sv.api("PUT", "/api/settings/editor", {
      ...cur.body.settings,
      reexport: { [docKey(copy)]: true },
    });
    await (await sv.core.send("me", sessionId, "Correggi il nome")).done;
    expect(seen[0]).toContain("A text document (LibreOffice Writer)");
    expect(seen[1]).toMatch(/^Applied as revision 1: replaced «Rossi» with «Verdi»/);
    expect(seen[1]).toContain("you edited its open copy docs/relazione.docx.open/relazione.odt");
    await sv.core.editor.flush();
    await new Promise((r) => setTimeout(r, 200));
    expect(await readFile(join(root, docx.path), "utf8")).toBe("converted odt to docx");
    const kept = await readdir(join(root, "docs/relazione.docx.open/versions"));
    expect(kept).toHaveLength(1);
    expect(
      await readFile(join(root, "docs/relazione.docx.open/versions", kept[0] as string), "utf8"),
    ).toBe("the person's docx");
    const m = JSON.parse(
      await readFile(join(root, "docs/relazione.docx.open/conversion.json"), "utf8"),
    );
    expect(m.sourceSize).toBe("converted odt to docx".length);
    expect(m.writtenBackAt).toBeTruthy();
  });

  it("without the full editor: the person's find and replace; «Esporta come»; the engine's state", async () => {
    await setup(() => ({ text: "ok" }));
    const sv = s as Server;
    const r = await sv.api<{ revision: number }>("POST", "/api/editor/office/replace", {
      ...odt,
      find: "Punto",
      text: "Punto di misura",
      all: true,
    });
    expect(r.body.revision).toBe(1);
    const bad = await sv.api<{ error: string }>("POST", "/api/editor/office/replace", {
      ...odt,
      find: "nessuno",
    });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toMatch(/is not in the document/);
    const ex = await fetch(`${sv.url}/api/editor/office/export`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ...odt, to: "docx" }),
    });
    expect(ex.headers.get("content-disposition")).toContain("verbale.docx");
    expect(await ex.text()).toBe("converted odt to docx");
    const no = await sv.api("POST", "/api/editor/office/export", { ...odt, to: "pptx" });
    expect(no.status).toBe(400);
    const st = await sv.api<{ ready: boolean; size: number; version: string }>(
      "GET",
      "/api/editor/office",
    );
    expect(st.body).toMatchObject({ ready: false, size: 53_243_567 });
    // The frame's files are only what RedGiant knows, with the isolation headers.
    const lic = await fetch(`${sv.url}/zeta/LICENSES.txt`);
    expect(lic.headers.get("document-isolation-policy")).toBe("isolate-and-require-corp");
    expect(await lic.text()).toContain("Mozilla Public License 2.0");
    expect((await fetch(`${sv.url}/zeta/lowa/secrets.json`)).status).toBe(404);
  });
});

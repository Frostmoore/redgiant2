// The editor from end to end (G37.1): a scripted model (FakeProvider) edits a file with
// canvas_edit while a page has it open over the WebSocket. help gives the catalog, dry_run
// changes nothing, canvas_look view "structure" gives the content and the revision; the page sees
// each revision in order and its own batches acknowledged in order; the person's change on the same
// place refuses the agent's; the person's change reaches the agent's next message as a note; with
// the rule «come proposte» the agent's edit waits for the person.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ChangeSet } from "@codemirror/state";
import type { DocOp, ServerMessage } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, wsClient } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

type Req = {
  messages: { role: string; parts: { type: string; content?: string; text?: string }[] }[];
};
const resultOf = (req: Req) =>
  (
    req.messages.at(-1)?.parts.find((p) => p.type === "tool_result") as
      | { content: string }
      | undefined
  )?.content;

/** These tool calls one after the other, each result kept, then a short answer. */
function calls(list: { name: string; input: unknown }[], seen: string[]) {
  let i = 0;
  return (req: Req) => {
    const r = resultOf(req);
    if (r !== undefined) seen.push(r);
    const next = list[i++];
    return next ? { toolCalls: [next] } : { text: "Done." };
  };
}

const file = { scope: "platform", path: "notes/todo.txt" };
const TEXT = "buy milk\ncall Ann\nwrite the report\n";

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
  const abs = join(await s.core.scopeFolder("me", "platform"), file.path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, TEXT);
  return { sessionId, abs, godId: g.body.id };
}

function personOp(text: string, spec: { from: number; to?: number; insert?: string }): DocOp {
  return {
    family: "text",
    engine: "codemirror-state",
    engineVersion: "6",
    op: { changes: ChangeSet.of(spec, text.length).toJSON() as never },
  };
}

const only = <T extends ServerMessage["type"]>(c: { messages: ServerMessage[] }, type: T) =>
  c.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);

describe("canvas_edit and the editor over the WebSocket (G37.1)", () => {
  it("help, a dry run, structure, an edit the page sees, saved on disk", async () => {
    const seen: string[] = [];
    const { sessionId, abs } = await setup(
      calls(
        [
          { name: "canvas_edit", input: { path: file.path, help: true } },
          { name: "canvas_look", input: { path: file.path, view: "structure" } },
          {
            name: "canvas_edit",
            input: {
              path: file.path,
              dry_run: true,
              ops: [{ op: "insert", line: 2, text: "pay rent\n" }],
            },
          },
          {
            name: "canvas_edit",
            input: {
              path: file.path,
              ops: [
                { op: "insert", line: 2, text: "pay rent\n" },
                { op: "replace", find: "Ann", text: "Anna" },
              ],
            },
          },
          {
            name: "canvas_edit",
            input: { path: file.path, ops: [{ op: "delete", find: "nowhere" }] },
          },
        ],
        seen,
      ),
    );
    const page = await wsClient((s as Server).url);
    await page.waitFor("welcome");
    page.send({ type: "doc.open", file });
    const opened = await page.waitFor("doc.opened");
    expect(opened).toMatchObject({
      revision: 0,
      family: "text",
      snapshot: { text: TEXT },
      mode: "now",
    });
    await (await (s as Server).core.send("me", sessionId, "Add the rent")).done;
    expect(seen[0]).toMatch(/^Plain text: operations for canvas_edit/);
    expect(seen[0]).toContain('{"op": "insert"');
    expect(seen[1]).toMatch(/todo\.txt: revision 0\. Plain text, 4 lines/);
    expect(seen[1]).toContain("2| call Ann");
    expect(seen[2]).toMatch(
      /^Dry run on revision 0 \(nothing changed\): it would have added 1 line at line 2/,
    );
    expect(seen[2]).toContain("2| pay rent");
    expect(seen[3]).toMatch(/^Applied as revision 1: .*undo_id 1/);
    expect(seen[4]).toMatch(/Nothing applied: operation 1: "find" text not found/);
    // The page saw one revision, the agent's, with what it wrote to highlight.
    const changed = only(page, "doc.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.change).toMatchObject({
      revision: 1,
      author: expect.any(String),
      authorName: "God",
    });
    expect(changed[0]?.change.wrote?.length).toBeGreaterThan(0);
    await (s as Server).core.editor.flush();
    expect(await readFile(abs, "utf8")).toBe("buy milk\npay rent\ncall Anna\nwrite the report\n");
    page.close();
  });

  it("the page's batches are acknowledged in order; a second page sees them as changes", async () => {
    await setup(() => ({ text: "ok" }));
    const a = await wsClient((s as Server).url);
    const b = await wsClient((s as Server).url);
    for (const c of [a, b]) {
      await c.waitFor("welcome");
      c.send({ type: "doc.open", file });
      await c.waitFor("doc.opened");
    }
    // Three batches back to back, each on the revision the page had when it typed.
    let text = TEXT;
    for (const [i, ch] of ["A", "B", "C"].entries()) {
      a.send({
        type: "doc.ops",
        file,
        clientId: `c${i}`,
        baseRevision: i,
        ops: [personOp(text, { from: 0, insert: ch })],
        groupId: "typing",
      });
      text = ch + text;
    }
    await a.waitFor("doc.ack", (m) => m.clientId === "c2");
    expect(only(a, "doc.ack").map((m) => [m.clientId, m.revision])).toEqual([
      ["c0", 1],
      ["c1", 2],
      ["c2", 3],
    ]);
    await b.waitFor("doc.changed", (m) => m.revision === 3);
    expect(only(b, "doc.changed").map((m) => m.revision)).toEqual([1, 2, 3]);
    const read = await (s as Server).core.editor.read("me", file);
    expect(read.model?.toString()).toBe(`CBA${TEXT}`);
    // An undo from the page, then a proposal answered: each acknowledged by its id.
    // Undoing B: C was written at the very same point after it, so it is refused (never a guess).
    a.send({ type: "doc.undo", file, clientId: "u0", revision: 2 });
    expect(await a.waitFor("doc.rejected", (m) => m.clientId === "u0")).toMatchObject({
      code: "conflict",
      conflict: 3,
    });
    a.send({ type: "doc.undo", file, clientId: "u1", revision: 3 });
    expect(await a.waitFor("doc.ack", (m) => m.clientId === "u1")).toMatchObject({ revision: 4 });
    expect((await (s as Server).core.editor.read("me", file)).model?.toString()).toBe(`BA${TEXT}`);
    a.send({ type: "doc.undo", file, clientId: "u2", revision: 99 });
    expect(await a.waitFor("doc.rejected", (m) => m.clientId === "u2")).toMatchObject({
      code: "nothing",
    });
    // The difference view (G37.2): a revision before and after, over HTTP; a bad ask says why.
    const diff = await (s as Server).api<{ before: { text: string }; after: { text: string } }>(
      "POST",
      "/api/editor/diff",
      { file, revision: 1 },
    );
    expect(diff.status).toBe(200);
    expect([diff.body.before.text, diff.body.after.text]).toEqual([TEXT, `A${TEXT}`]);
    const bad = await (s as Server).api<{ error: string }>("POST", "/api/editor/diff", {
      file: { scope: "outside", path: "/etc/hosts" },
      revision: 1,
    });
    expect(bad.status).toBe(400);
    // A file outside every workspace is not opened.
    a.send({ type: "doc.open", file: { scope: "outside", path: "/etc/hosts" } });
    expect(
      await a.waitFor("doc.rejected", (m) => m.clientId === "open" && m.file.scope === "outside"),
    ).toMatchObject({ code: "invalid" });
    a.close();
    b.close();
  });

  it("the person's change on the same place refuses the agent's edit, and reaches its next message", async () => {
    const seen: string[] = [];
    const { sessionId } = await setup(
      calls(
        [
          { name: "canvas_look", input: { path: file.path, view: "structure" } },
          {
            name: "canvas_edit",
            input: {
              path: file.path,
              ops: [{ op: "replace", find: "call Ann", text: "call Ann at 5" }],
            },
          },
        ],
        seen,
      ),
    );
    const page = await wsClient((s as Server).url);
    await page.waitFor("welcome");
    page.send({ type: "doc.open", file });
    await page.waitFor("doc.opened");
    // The agent reads revision 0; then the person rewrites line 2 before the agent edits it.
    const editing = (s as Server).core.editor;
    const original = editing.read.bind(editing);
    let once = false;
    editing.read = async (...args) => {
      const r = await original(...args);
      if (!once && seen.length === 1) {
        once = true;
        page.send({
          type: "doc.ops",
          file,
          clientId: "p1",
          baseRevision: 0,
          ops: [personOp(TEXT, { from: 9, to: 17, insert: "call Bea" })],
          groupId: "g",
        });
        await page.waitFor("doc.ack", (m) => m.clientId === "p1");
        return original(...args);
      }
      return r;
    };
    await (await (s as Server).core.send("me", sessionId, "Move the call")).done;
    expect(seen[1]).toMatch(
      /^Refused \(nothing applied\): the person changed the same place at revision 1/,
    );
    expect((await editing.read("me", file)).model?.toString()).toBe(
      "buy milk\ncall Bea\nwrite the report\n",
    );
    // The next message carries the line, after the person's words.
    page.send({
      type: "doc.ops",
      file,
      clientId: "p2",
      baseRevision: 1,
      ops: [personOp("buy milk\ncall Bea\nwrite the report\n", { from: 0, insert: "- " })],
      groupId: "g2",
    });
    await page.waitFor("doc.ack", (m) => m.clientId === "p2");
    await (await (s as Server).core.send("me", sessionId, "Go on")).done;
    const users = await (s as Server).core.store.list({ sessionId, types: ["message.user"] });
    const last = users.at(-1)?.payload as { text: string; notes?: string[] };
    expect(last.text).toBe("Go on");
    expect(last.notes?.[0]).toMatch(/The person changed notes\/todo\.txt since you last saw it/);
    page.close();
  });

  it("with the rule «come proposte» the agent's edit waits; accepted from the page it applies", async () => {
    const seen: string[] = [];
    const { sessionId } = await setup(
      calls(
        [
          {
            name: "canvas_edit",
            input: { path: file.path, ops: [{ op: "insert", text: "sleep\n" }] },
          },
        ],
        seen,
      ),
    );
    const put = await (s as Server).api("PUT", "/api/settings/editor", {
      agents: {},
      files: { [`file:${file.scope}:${file.path}`]: "propose" },
    });
    expect(put.status).toBe(200);
    const page = await wsClient((s as Server).url);
    await page.waitFor("welcome");
    page.send({ type: "doc.open", file });
    expect(await page.waitFor("doc.opened")).toMatchObject({ mode: "propose", modeOwn: true });
    await (await (s as Server).core.send("me", sessionId, "Add sleep")).done;
    expect(seen[0]).toMatch(/^Proposed to the person \(proposal [a-z0-9-]+, on revision 0\)/);
    const proposals = await page.waitFor("doc.proposals");
    expect(proposals.proposals).toHaveLength(1);
    const id = proposals.proposals[0]?.proposalId as string;
    expect((await (s as Server).core.editor.read("me", file)).model?.toString()).toBe(TEXT);
    page.send({ type: "doc.decide", file, clientId: "d1", proposalId: id, accept: true });
    await page.waitFor("doc.ack", (m) => m.clientId === "d1");
    expect(only(page, "doc.changed").at(-1)?.change).toMatchObject({ revision: 1 });
    expect((await (s as Server).core.editor.read("me", file)).model?.toString()).toBe(
      `${TEXT}sleep\n`,
    );
    // The setting is a change of the platform: undoable, with its history.
    const get = await (s as Server).api<{ settings: { files: Record<string, string> } }>(
      "GET",
      "/api/settings/editor",
    );
    expect(Object.values(get.body.settings.files)).toEqual(["propose"]);
    page.close();
  });
});

describe("Ctrl+S and text with no extension (p3.5.1)", () => {
  it("doc.save writes the file now, not after the pause; bare names are text, binaries are not", async () => {
    s = await startServer(
      (() => ({ text: "ok" })) as never,
      { contextWindow: 65_536 },
      // A pause no test waits for: only Ctrl+S can write the file in time.
      { editor: { saveDelayMs: 600_000, watchMs: 0 } },
    );
    const root = await s.core.scopeFolder("me", "platform");
    await mkdir(root, { recursive: true });
    const env = { scope: "platform", path: ".env" };
    await writeFile(join(root, ".env"), "A=1\n");
    await writeFile(join(root, "hosts"), "127.0.0.1 here\n");
    await writeFile(join(root, "tool"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0xff, 0xfe, 0]));
    const a = await wsClient(s.url);
    await a.waitFor("welcome");
    // Saving a file the page has not opened is refused.
    a.send({ type: "doc.save", file: env });
    expect(await a.waitFor("error")).toMatchObject({ code: "doc_closed" });
    a.send({ type: "doc.open", file: env });
    await a.waitFor("doc.opened", (m) => m.file.path === ".env");
    a.send({
      type: "doc.ops",
      file: env,
      clientId: "c0",
      baseRevision: 0,
      ops: [personOp("A=1\n", { from: 4, insert: "B=2\n" })],
      groupId: "typing",
    });
    a.send({ type: "doc.save", file: env });
    expect(await a.waitFor("doc.saved", (m) => m.file.path === ".env")).toEqual({
      type: "doc.saved",
      file: env,
      revision: 1,
    });
    expect(await readFile(join(root, ".env"), "utf8")).toBe("A=1\nB=2\n");
    // Saved again with nothing new: the page is still told, so «Salvato» shows.
    a.send({ type: "doc.save", file: env });
    await a.waitFor("doc.saved", (m) => m.revision === 1 && only(a, "doc.saved").length === 2);
    // A name with no extension opens as text; one whose bytes are not text is refused.
    a.send({ type: "doc.open", file: { scope: "platform", path: "hosts" } });
    expect(await a.waitFor("doc.opened", (m) => m.file.path === "hosts")).toMatchObject({
      family: "text",
      snapshot: { family: "text", text: "127.0.0.1 here\n" },
    });
    a.send({ type: "doc.open", file: { scope: "platform", path: "tool" } });
    expect(
      await a.waitFor("doc.rejected", (m) => m.clientId === "open" && m.file.path === "tool"),
    ).toMatchObject({ code: "invalid" });
    a.close();
  });
});

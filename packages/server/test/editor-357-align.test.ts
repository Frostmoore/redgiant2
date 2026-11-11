// The person's test of 3.5.6 (p3.5.7): the page and the host never drift apart silently (every
// batch of the page gets an answer, every text revision carries a check of the content), and the
// copies of Office files say plainly when an edit reaches the original.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ChangeSet } from "@codemirror/state";
import { type DocOp, type ServerMessage, textDigest } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, wsClient } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const file = { scope: "platform", path: "notes/righe.txt" };
const TEXT = "uno\ndue\n";

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

describe("every batch of the page gets an answer it can act on (p3.5.7)", () => {
  it("acks carry the text's check; a batch for a file not open here, or one the host cannot apply, is refused", async () => {
    s = await startServer(
      (() => ({ text: "ok" })) as never,
      { contextWindow: 65_536 },
      { editor: { saveDelayMs: 0, watchMs: 0 } },
    );
    const abs = join(await s.core.scopeFolder("me", "platform"), file.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, TEXT);
    const a = await wsClient(s.url);
    const b = await wsClient(s.url);
    await a.waitFor("welcome");
    await b.waitFor("welcome");
    a.send({ type: "doc.open", file });
    await a.waitFor("doc.opened");
    b.send({ type: "doc.open", file });
    await b.waitFor("doc.opened");
    // Three lines typed: the ack says what the host holds now, the other page's change too.
    const typed = `${TEXT}tre\nquattro\nciao`;
    a.send({
      type: "doc.ops",
      file,
      clientId: "c0",
      baseRevision: 0,
      ops: [personOp(TEXT, { from: TEXT.length, insert: "tre\nquattro\nciao" })],
      groupId: "g",
    });
    const ack = await a.waitFor("doc.ack", (m) => m.clientId === "c0");
    expect(ack.digest).toBe(textDigest(typed));
    expect((await b.waitFor("doc.changed", (m) => m.revision === 1)).digest).toBe(
      textDigest(typed),
    );
    // A batch whose two operations do not fit together, moved over revision 1: the host throws.
    // Before p3.5.7 the page got only an error in the header and waited for an ack for ever.
    a.send({
      type: "doc.ops",
      file,
      clientId: "c1",
      baseRevision: 0,
      ops: [personOp(TEXT, { from: 0, insert: "x" }), personOp("short", { from: 0, insert: "y" })],
      groupId: "g",
    });
    expect(await a.waitFor("doc.rejected", (m) => m.clientId === "c1")).toMatchObject({
      code: "failed",
    });
    // A page whose file is not open on its connection (closed by another part of the page).
    b.send({ type: "doc.close", file });
    b.send({
      type: "doc.ops",
      file,
      clientId: "c2",
      baseRevision: 1,
      ops: [personOp(typed, { from: typed.length - 4, to: typed.length })],
      groupId: "g",
    });
    expect(await b.waitFor("doc.rejected", (m) => m.clientId === "c2")).toMatchObject({
      code: "closed",
    });
    expect(only(b, "error")).toEqual([]);
    expect((await s.core.editor.read("me", file)).model?.toString()).toBe(typed);
    a.close();
    b.close();
  });
});

// A PDF's redaction always asks the person (p3.5.4, the 3.5.3 test: «Applied as revision 2:
// Redacted 1 area…» without a question). From end to end, with a scripted model: God and a
// project's agent, in automatic mode, with the person's "ask me" and "don't ask me anything"
// (the classifier would say yes: it is never asked); a no leaves the file as it was. And the tool
// itself refuses a redaction the person did not say yes to, whatever let the call through.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PermissionRequestInfo } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { pageLines } from "../src/editor/pdf-text.js";
import { trickyPdf } from "./fixtures/pdf-samples.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

type Req = { messages: { parts: { type: string; content?: string }[] }[] };
const PATH = "docs/riservato.pdf";

async function setup(who: "god" | "orchestrator", mode: "ask" | "classifier") {
  const seen: string[] = [];
  const classified: string[] = [];
  let i = 0;
  // God works on every project: it names the project's file by its full path (as in the test).
  let path = PATH;
  s = await startServer(
    ((req: Req) => {
      const r = req.messages.at(-1)?.parts.find((p) => p.type === "tool_result");
      if (r?.content !== undefined) seen.push(r.content);
      if (i++ === 0)
        return {
          toolCalls: [
            {
              name: "canvas_edit",
              input: { path, ops: [{ op: "redact", page: 1, find: "ZEBRA-77" }] },
            },
          ],
        };
      return { text: "Done." };
    }) as never,
    { contextWindow: 65_536 },
    {
      editor: { saveDelayMs: 0, watchMs: 0 },
      classify: async (r) => {
        classified.push(r.what);
        return { decision: "allow", reason: "Serve al lavoro.", model: "fake/light" };
      },
    },
  );
  const sv = s;
  const god = (
    await sv.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    })
  ).body.id;
  const project = (await sv.api<{ id: string }>("POST", "/api/projects", { name: "Archivio" })).body
    .id;
  const agentId =
    who === "god"
      ? god
      : (
          await sv.api<{ id: string }>("POST", "/api/agents", {
            kind: "orchestrator",
            parentId: god,
            projectId: project,
            name: "Lead",
            mode: "auto",
          })
        ).body.id;
  const sessionId = (await sv.api<{ sessionId: string }>("POST", "/api/sessions", { agentId })).body
    .sessionId;
  await sv.api("PUT", "/api/settings/requests", { mode });
  const root = await sv.core.scopeFolder("me", `project:${project}`);
  await mkdir(dirname(join(root, PATH)), { recursive: true });
  const original = await trickyPdf();
  await writeFile(join(root, PATH), original);
  if (who === "god") path = join(root, PATH);
  return { sv, sessionId, root, original, seen, classified };
}

const textOf = async (bytes: Uint8Array) =>
  ((await pageLines(bytes, [0])).get(0) ?? []).map((l) => l.text).join(" ");

describe("a redaction always asks the person", () => {
  it.each([
    ["god", "ask", "allow"],
    ["god", "classifier", "deny"],
    ["orchestrator", "ask", "deny"],
    ["orchestrator", "classifier", "allow"],
  ] as const)(
    "%s, automatic mode, requests «%s»: asked, the person says %s",
    async (who, mode, answer) => {
      const { sv, sessionId, root, original, seen, classified } = await setup(who, mode);
      const asked: PermissionRequestInfo[] = [];
      sv.core.approvals.on("request", (_o, info) => {
        asked.push(info);
        queueMicrotask(() => sv.core.approvals.decide("me", info.requestId, answer));
      });
      await (await sv.core.send("me", sessionId, "Oscura il codice")).done;
      expect(asked).toHaveLength(1);
      expect(asked[0]?.tool).toBe("canvas_edit");
      expect(asked[0]?.danger).toContain("critical-delete");
      // Never the classifier's, even when the person chose "don't ask me anything".
      expect(classified).toEqual([]);
      await sv.core.editor.flush();
      const disk = new Uint8Array(await readFile(join(root, PATH)));
      if (answer === "allow") {
        expect(seen[0]).toMatch(/^Applied as revision 1: Redacted/);
        expect(await textOf(disk)).not.toMatch(/ZEBRA|EBRA|Z /);
        expect(await textOf(disk)).toContain("Il codice riservato è e basta.");
      } else {
        expect(seen[0]).toMatch(/Permission denied/);
        expect(Buffer.from(disk).equals(Buffer.from(original))).toBe(true);
      }
    },
  );

  it("let through without the person's yes (any other path), the tool refuses it", async () => {
    const { sv, sessionId, root, original, seen } = await setup("god", "classifier");
    const asked: unknown[] = [];
    sv.core.approvals.on("request", (_o, info) => asked.push(info));
    // As if a rule, a mode or a bug had allowed the call: the person was never asked.
    sv.core.broker.check = async () => ({ allow: true });
    await (await sv.core.send("me", sessionId, "Oscura il codice")).done;
    expect(asked).toEqual([]);
    expect(seen[0]).toMatch(/^Nothing applied: a redaction removes text for good/);
    await sv.core.editor.flush();
    const disk = new Uint8Array(await readFile(join(root, PATH)));
    expect(Buffer.from(disk).equals(Buffer.from(original))).toBe(true);
  });
});

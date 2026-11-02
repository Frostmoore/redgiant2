import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const isSummary = (req: CompletionRequest) => {
  const p = req.messages.at(-1)?.parts[0];
  return p?.type === "text" && p.text.startsWith("Do not call any tool now.");
};

describe("compaction from the chat (G24.14)", () => {
  it("summarises on /compact with what to keep, and undoes it", async () => {
    const prompts: string[] = [];
    s = await startServer((req) => {
      if (isSummary(req)) {
        const p = req.messages.at(-1)?.parts[0];
        prompts.push(p?.type === "text" ? p.text : "");
        return { text: "<summary>Short version</summary>" };
      }
      return { text: "ok" };
    });
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const sid = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god.body.id })
    ).body.sessionId;
    for (const text of ["first", "second", "/compact keep the database decisions"])
      await (await s.core.send("me", sid, text)).done;
    expect(prompts[0]).toMatch(/keep the database decisions$/);
    const events = await s.core.history("me", sid);
    expect(events.filter((e) => e.type === "message.user")).toHaveLength(2);
    expect(events.find((e) => e.type === "compaction")?.payload).toMatchObject({
      summary: "Short version",
      reason: "manual",
    });
    const rows = await s.api<{ id: string; title: string }[]>(
      "GET",
      `/api/sessions?agentId=${god.body.id}`,
    );
    expect(rows.body.find((r) => r.id === sid)?.title).toBe("first");

    expect((await s.api("POST", `/api/sessions/${sid}/compaction/undo`)).status).toBe(200);
    expect((await s.api("POST", `/api/sessions/${sid}/compaction/undo`)).status).toBe(400);
    expect((await s.core.history("me", sid)).some((e) => e.type === "compaction.undone")).toBe(
      true,
    );
  });
});

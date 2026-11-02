import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { alertText, type SetupHooks, SetupService } from "../src/index.js";
import { startServer, wsClient } from "./helpers.js";

const until = async (check: () => boolean) => {
  // Up to 15 s: CI machines (macOS especially) can be slow to finish a turn.
  for (let i = 0; i < 750 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
};

const hooks = {
  anthropic: async () => {},
  openai: async () => [],
  telegram: async () => null,
  search: async () => {},
  engine: async () => {},
} satisfies SetupHooks;

let cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

describe("alerts", () => {
  it("fills the texts in the chosen language", () => {
    expect(alertText("it", "budget", { name: "Zeus", pct: 96 })).toBe("Budget Zeus: 96%");
    expect(alertText("en", "turn", { agent: "Zeus" })).toBe("Zeus finished");
  });

  it("tells Telegram about budgets, not again about approvals and questions", async () => {
    const s = await startServer(
      (req) => {
        const last = req.messages.at(-1);
        const answered = last?.parts.some((p) => p.type === "tool_result");
        const text = last?.parts.find((p) => p.type === "text");
        if (answered) return { text: "done" };
        if (text?.type === "text" && text.text === "write")
          return { toolCalls: [{ name: "write_file", input: { path: "a.txt", content: "x" } }] };
        if (text?.type === "text" && text.text === "ask")
          return {
            toolCalls: [
              {
                name: "ask_user",
                input: {
                  questions: [{ question: "A o B?", options: [{ label: "A" }, { label: "B" }] }],
                },
              },
            ],
          };
        return { text: "ok" };
      },
      {},
      {},
      undefined,
      undefined,
      async (core, dir) => {
        const setup = new SetupService({
          db: core.db,
          core,
          dataDir: join(dir, "data"),
          ownerId: "me",
          hooks,
        });
        await setup.applyAtStartup();
        return { setup };
      },
    );
    cleanup.push(s.close);
    // What the Telegram gateway would send.
    const told: string[] = [];
    s.core.notify = async (_owner, text) => void told.push(text);
    await s.api("PUT", "/api/setup/names", { god: "Zeus", demigod: "Hermes", language: "it" });

    const god = s.core.registry.list({ ownerId: "me" }).find((a) => a.kind === "god");
    await s.api("PATCH", `/api/agents/${god?.id}`, { mode: "manual" });
    const sid = (await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god?.id }))
      .body.sessionId;
    const c = await wsClient(s.url);
    cleanup.push(async () => c.close());
    c.send({ type: "session.follow", sessionId: sid });
    await c.waitFor("session.synced");
    // The follow also reports the session's current state: it must not pass for the end of a turn.
    await c.waitFor("session.state");
    const idleAfter = async (from: number) =>
      until(() =>
        c.messages.slice(from).some((m) => m.type === "session.state" && m.state === "idle"),
      );
    let mark = c.messages.length;
    c.send({ type: "session.send", sessionId: sid, text: "write" });
    const req = await c.waitFor("permission.request");
    c.send({
      type: "permission.resolve",
      requestId: req.request.requestId,
      decision: "allow",
      remember: false,
    });
    await idleAfter(mark);
    mark = c.messages.length;
    c.send({ type: "session.send", sessionId: sid, text: "ask" });
    const q = await c.waitFor("question.request");
    c.send({ type: "question.answer", requestId: q.request.requestId, answers: [["A"]] });
    await idleAfter(mark);
    // The gateway sends approvals and questions itself, with buttons: no second message.
    expect(told).toEqual([]);

    // A budget past 95 % after a turn: told once.
    const used = (
      await s.api<{ scope: string; id: string; used: { tokens: number } }[]>("GET", "/api/budgets")
    ).body.find((b) => b.scope === "agent" && b.id === god?.id)?.used.tokens;
    await s.api("PUT", "/api/budgets", {
      scope: "agent",
      id: god?.id,
      tokens: Math.ceil((used ?? 1) * 1.1),
    });
    await (await s.core.send("me", sid, "hello")).done;
    await (await s.core.send("me", sid, "hello")).done.catch(() => {});
    await until(() => told.some((t) => t.startsWith("**Budget")));
    const budget = told.filter((t) => t.startsWith("**Budget"));
    expect(budget).toHaveLength(1);
    expect(budget[0]).toMatch(/^\*\*Budget Zeus: \d+%\*\*\n\$/);
    // Turns sent by the code (delegations, automations) are not reported as finished turns.
    expect(told.some((t) => t.includes("ha finito"))).toBe(false);
  });
});

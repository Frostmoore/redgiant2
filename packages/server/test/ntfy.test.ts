import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishNtfy, type SetupHooks, SetupService } from "../src/index.js";
import { startServer, wsClient } from "./helpers.js";

type Pushed = { path: string; auth: string | undefined; body: Record<string, unknown> };

/** ntfy in miniature: records every publish. */
async function fakeNtfy() {
  const pushed: Pushed[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    pushed.push({
      path: req.url ?? "",
      auth: req.headers.authorization,
      body: JSON.parse(raw) as Record<string, unknown>,
    });
    res.end("{}");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, pushed, close: () => new Promise((ok) => server.close(ok)) };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
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

describe("ntfy", () => {
  it("publishes JSON to the server's root with the topic, priority and token", async () => {
    const ntfy = await fakeNtfy();
    cleanup.push(ntfy.close);
    await publishNtfy(
      { url: `${ntfy.url}/my-topic`, token: "tk_1" },
      { kind: "approval", title: "Serve un'approvazione", message: "God vuole usare bash" },
    );
    expect(ntfy.pushed).toEqual([
      {
        path: "/",
        auth: "Bearer tk_1",
        body: {
          topic: "my-topic",
          title: "Serve un'approvazione",
          message: "God vuole usare bash",
          priority: 4,
          tags: ["approval"],
        },
      },
    ]);
  });

  it("tells the phone about approvals, questions and budgets, in the chosen language", async () => {
    const ntfy = await fakeNtfy();
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
    cleanup.push(s.close, ntfy.close);
    expect((await s.api("POST", "/api/notifications/test")).status).toBe(400);
    await s.api("PUT", "/api/setup/names", { god: "Zeus", demigod: "Hermes", language: "it" });
    expect(
      (await s.api("PUT", "/api/setup/notifications", { ntfy: { url: `${ntfy.url}/rg` } })).status,
    ).toBe(200);
    expect((await s.api("POST", "/api/notifications/test")).body).toEqual({ ok: true });
    expect(ntfy.pushed.at(-1)?.body).toMatchObject({ topic: "rg", title: "RedGiant" });

    const god = s.core.registry.list({ ownerId: "me" }).find((a) => a.kind === "god");
    await s.api("PATCH", `/api/agents/${god?.id}`, { mode: "manual" });
    const sid = (await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god?.id }))
      .body.sessionId;
    const c = await wsClient(s.url);
    cleanup.push(async () => c.close());
    c.send({ type: "session.follow", sessionId: sid });
    await c.waitFor("session.synced");
    // The turn that starts now ends: an idle state after the message was sent.
    const idleAfter = async (from: number) =>
      until(() =>
        c.messages.slice(from).some((m) => m.type === "session.state" && m.state === "idle"),
      );
    let mark = c.messages.length;
    c.send({ type: "session.send", sessionId: sid, text: "write" });
    const req = await c.waitFor("permission.request");
    await until(() => ntfy.pushed.some((p) => p.body.tags?.toString() === "approval"));
    expect(ntfy.pushed.at(-1)?.body).toMatchObject({
      title: "Serve un'approvazione",
      message: "Zeus vuole usare write_file",
      priority: 4,
    });
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
    await until(() => ntfy.pushed.some((p) => p.body.tags?.toString() === "question"));
    expect(ntfy.pushed.at(-1)?.body).toMatchObject({ title: "Zeus chiede", message: "A o B?" });
    c.send({ type: "question.answer", requestId: q.request.requestId, answers: [["A"]] });
    await idleAfter(mark);
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
    await until(() => ntfy.pushed.some((p) => p.body.tags?.toString() === "budget"));
    const budget = ntfy.pushed.filter((p) => p.body.tags?.toString() === "budget");
    expect(budget).toHaveLength(1);
    expect(String(budget[0]?.body.title)).toMatch(/^Budget Zeus: \d+%$/);
    // Turns sent by the code (delegations, automations) are not notified as finished turns.
    expect(ntfy.pushed.some((p) => p.body.tags?.toString() === "done")).toBe(false);
  });
});

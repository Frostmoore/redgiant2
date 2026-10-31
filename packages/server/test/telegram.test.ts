import type { CompletionRequest } from "@redgiant/providers";
import { splitMessage } from "@redgiant/telegram";
import { afterEach, describe, expect, it } from "vitest";
import { fakeTelegram } from "./fake-telegram.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
let tg: Awaited<ReturnType<typeof fakeTelegram>> | undefined;
afterEach(async () => {
  await s?.close();
  await tg?.close();
  s = undefined;
});

const USER = 4242;
const lastText = (req: CompletionRequest) => {
  const m = [...req.messages]
    .reverse()
    .find((x) => x.role === "user" && x.parts.some((p) => p.type === "text"));
  const p = m?.parts.find((x) => x.type === "text");
  return p?.type === "text" ? p.text : "";
};
const toolResult = (req: CompletionRequest) => {
  const last = req.messages.at(-1);
  const p = last?.role === "user" ? last.parts.find((x) => x.type === "tool_result") : undefined;
  return p?.type === "tool_result" ? p.content : undefined;
};

async function setup(
  brain: (req: CompletionRequest) => {
    text?: string;
    toolCalls?: { name: string; input: unknown }[];
  },
  godMode?: string,
) {
  tg = await fakeTelegram();
  s = await startServer(brain, {}, {}, undefined, tg.apiRoot);
  const god = await s.api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: "God",
    ...(godMode && { mode: godMode }),
  });
  await s.api("POST", "/api/agents", { kind: "demigod", parentId: god.body.id, name: "Demi-God" });
  return { god: god.body.id };
}

async function pair() {
  const { body } = await (s as Server).api<{ code: string; bot: string; link: string }>(
    "POST",
    "/api/telegram/pair",
  );
  await s?.gateway?.handleUpdate(tg?.text(USER, `/start ${body.code}`) as never);
  return body;
}

describe("Demi-God on Telegram", () => {
  it("pairs with a one-time code and ignores strangers", async () => {
    await setup(() => ({ text: "x" }));
    await s?.gateway?.handleUpdate(tg?.text(999, "hello") as never);
    expect(tg?.sent(999).at(-1)?.text).toMatch(/not linked/);
    await s?.gateway?.handleUpdate(tg?.text(USER, "/start 000000") as never);
    expect(tg?.sent(USER).at(-1)?.text).toMatch(/Pair, then send \/start/);
    const p = await pair();
    expect(p).toMatchObject({ bot: "redgiant_test_bot", link: "https://t.me/redgiant_test_bot" });
    expect(tg?.sent(USER).at(-1)?.text).toMatch(/^Linked/);
    expect(
      (await s?.api<{ userId: number }[]>("GET", "/api/telegram/links"))?.body.map((l) => l.userId),
    ).toEqual([USER]);
    // A used code cannot link anyone else.
    await s?.gateway?.handleUpdate(tg?.text(777, `/start ${p.code}`) as never);
    expect((await s?.api<unknown[]>("GET", "/api/telegram/links"))?.body).toHaveLength(1);
  });

  it("relays to God through Demi-God, who can do nothing else", async () => {
    const demigodTools: string[][] = [];
    await setup((req) => {
      if (req.system.startsWith("You are Demi-God")) {
        demigodTools.push(req.tools.map((t) => t.name));
        const r = toolResult(req);
        return r === undefined
          ? { toolCalls: [{ name: "ask_god", input: { message: lastText(req) } }] }
          : { text: `Demi-God: ${r}` };
      }
      return {
        text: `God says the project is fine (you asked: ${lastText(req).split("\n").pop()})`,
      };
    });
    await pair();
    await s?.gateway?.handleUpdate(tg?.text(USER, "How is project X?") as never);
    await s?.gateway?.idle();
    expect(tg?.sent(USER).at(-1)?.text).toBe(
      "Demi-God: God says the project is fine (you asked: How is project X?)",
    );
    expect(demigodTools[0]).toEqual(["ask_god"]);
    expect(tg?.calls.some((c) => c.method === "sendChatAction")).toBe(true);
  });

  it("asks for approvals with buttons and closes them everywhere", async () => {
    const { god } = await setup((req) =>
      toolResult(req) === undefined
        ? { toolCalls: [{ name: "write_file", input: { path: "a.txt", content: "x" } }] }
        : { text: "done" },
    );
    await pair();
    await s?.api("POST", "/api/projects", { name: "P" });
    const orch = await s?.api<{ id: string }>("POST", "/api/agents", {
      kind: "orchestrator",
      parentId: god,
      projectId: "p",
      name: "O",
      mode: "manual",
    });
    const sid =
      (await s?.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: orch?.body.id }))
        ?.body.sessionId ?? "";
    const turn = (await s?.core.send("me", sid, "write"))?.done;
    let ask: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && !ask; i++) {
      await new Promise((r) => setTimeout(r, 30));
      ask = tg?.sent(USER).find((m) => String(m.text).startsWith("🔔"));
    }
    expect(ask?.text).toMatch(/O \(p\) wants write_file/);
    const keyboard = (
      ask?.reply_markup as { inline_keyboard: { callback_data: string }[][] } | undefined
    )?.inline_keyboard[0];
    expect(keyboard?.map((b) => b.callback_data.split(":")[2])).toEqual(["allow", "deny"]);
    await s?.gateway?.handleUpdate(tg?.button(9999, keyboard?.[0]?.callback_data ?? "") as never);
    expect(tg?.calls.filter((c) => c.method === "answerCallbackQuery").at(-1)?.body.text).toBe(
      "Not allowed.",
    );
    await s?.gateway?.handleUpdate(tg?.button(USER, keyboard?.[0]?.callback_data ?? "") as never);
    expect((await turn)?.stopReason).toBe("end_turn");
    await new Promise((r) => setTimeout(r, 50));
    expect(tg?.calls.find((c) => c.method === "editMessageText")?.body.text).toMatch(/✅ Allowed$/);
  });

  it("lets the approval buttons through while it is still answering the same message", async () => {
    await setup((req) => {
      if (req.system.startsWith("You are Demi-God")) {
        const r = toolResult(req);
        return r === undefined
          ? { toolCalls: [{ name: "ask_god", input: { message: lastText(req) } }] }
          : { text: `Demi-God: ${r}` };
      }
      return toolResult(req) === undefined
        ? { toolCalls: [{ name: "write_file", input: { path: "cpu.txt", content: "x" } }] }
        : { text: "written" };
    }, "manual");
    await pair();
    // Polling hands updates over one at a time: this must return before God has finished.
    await s?.gateway?.handleUpdate(tg?.text(USER, "Write cpu.txt") as never);
    let ask: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && !ask; i++) {
      await new Promise((r) => setTimeout(r, 30));
      ask = tg?.sent(USER).find((m) => String(m.text).startsWith("🔔"));
    }
    const allow = (
      ask?.reply_markup as { inline_keyboard: { callback_data: string }[][] } | undefined
    )?.inline_keyboard[0]?.[0]?.callback_data;
    await s?.gateway?.handleUpdate(tg?.button(USER, allow ?? "") as never);
    await s?.gateway?.idle();
    expect(tg?.sent(USER).at(-1)?.text).toBe("Demi-God: written");
  });

  it("accepts webhook updates only with Telegram's secret", async () => {
    await setup(() => ({ text: "x" }));
    const post = (secret?: string) =>
      fetch(`${s?.url}/api/telegram/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret && { "x-telegram-bot-api-secret-token": secret }),
        },
        body: JSON.stringify(tg?.text(555, "hi")),
      });
    expect((await post()).status).toBe(403);
    expect((await post("wrong-secret-for-tests!!")).status).toBe(403);
    expect((await post("webhook-secret-for-tests")).status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(tg?.sent(555).at(-1)?.text).toMatch(/not linked/);
  });
});

describe("splitMessage", () => {
  it("keeps messages under Telegram's limit, cutting at paragraphs", () => {
    const parts = splitMessage(`${"a".repeat(3000)}\n\n${"b".repeat(3000)}`);
    expect(parts.map((p) => p.length)).toEqual([3000, 3000]);
    expect(splitMessage("x".repeat(9000)).every((p) => p.length <= 4000)).toBe(true);
    expect(splitMessage("")).toEqual(["…"]);
  });
});

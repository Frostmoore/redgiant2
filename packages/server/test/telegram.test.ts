import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
  fake: Parameters<typeof startServer>[1] = {},
) {
  tg = await fakeTelegram();
  s = await startServer(brain, fake, {}, undefined, tg.apiRoot);
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

  it("says what to do when no model is chosen yet, not an error in English", async () => {
    await setup(() => ({ text: "x" }));
    await pair();
    s?.core.setDefaultModel(undefined);
    await s?.gateway?.handleUpdate(tg?.text(USER, "Hello") as never);
    await s?.gateway?.idle();
    expect(tg?.sent(USER).at(-1)?.text).toMatch(
      /^No model is chosen yet\. Open RedGiant, Settings/,
    );
  });

  it("takes a second message while it still answers the first, and says so (G24.14f)", async () => {
    // God's first answer streams slowly: the second message arrives meanwhile.
    let firstStarted = false;
    await setup(
      (req) => {
        if (req.system.startsWith("You are Demi-God")) {
          const r = toolResult(req);
          return r === undefined
            ? { toolCalls: [{ name: "ask_god", input: { message: lastText(req) } }] }
            : { text: `Demi-God: ${r.split(" ").slice(0, 2).join(" ")}` };
        }
        const said = lastText(req).split("\n").pop() ?? "";
        if (said === "first") firstStarted = true;
        return { text: `God: ${said}${said === "first" ? " word".repeat(60) : ""}` };
      },
      undefined,
      { tick: () => new Promise((r) => setTimeout(r, 5)) },
    );
    await pair();
    await s?.gateway?.handleUpdate(tg?.text(USER, "first") as never);
    // The second message only once God is answering the first (a fixed wait was flaky in CI).
    for (let i = 0; i < 400 && !firstStarted; i++) await new Promise((r) => setTimeout(r, 10));
    await s?.gateway?.handleUpdate(tg?.text(USER, "second") as never);
    await s?.gateway?.idle();
    const texts = tg?.sent(USER).map((m) => String(m.text)) ?? [];
    expect(texts).toContain(
      "Got it. I am still answering your previous message: I will read this one right after.",
    );
    expect(texts.filter((t) => t.startsWith("Demi-God: God:"))).toEqual([
      "Demi-God: God: first",
      "Demi-God: God: second",
    ]);
    expect(texts.join("\n")).not.toMatch(/still working on your previous message/);
  });

  it("sends God's files to Telegram when the person talks from there (G25.2)", async () => {
    await setup((req) => {
      if (req.system.startsWith("You are Demi-God")) {
        const r = toolResult(req);
        return r === undefined
          ? { toolCalls: [{ name: "ask_god", input: { message: lastText(req) } }] }
          : { text: `Demi-God: ${r}` };
      }
      const r = toolResult(req);
      if (r === undefined)
        return {
          toolCalls: [{ name: "write_file", input: { path: "report.txt", content: "ok" } }],
        };
      if (r.startsWith("Wrote") || (r.includes("report.txt") && !r.startsWith("Sent")))
        return {
          toolCalls: [{ name: "send_file", input: { path: "report.txt", caption: "The report" } }],
        };
      return { text: "Here it is." };
    });
    await pair();
    await s?.gateway?.handleUpdate(tg?.text(USER, "Send me the report") as never);
    await s?.gateway?.idle();
    const doc = tg?.calls.find((c) => c.method === "sendDocument");
    expect(doc?.body).toMatchObject({ multipart: true });
    expect((doc?.body as { fields?: string[] } | undefined)?.fields).toEqual(
      expect.arrayContaining(["chat_id", "document", "caption"]),
    );
    const sent = (await s?.core.store.list({ types: ["file.sent"] })) ?? [];
    expect(sent.map((e) => e.payload)).toEqual([
      {
        scope: "platform",
        path: "report.txt",
        name: "report.txt",
        size: 2,
        mime: "text/plain",
        caption: "The report",
      },
    ]);
  });

  it("sends the link of a board to Telegram, as Officina does (G25.4)", async () => {
    await setup((req) => {
      if (req.system.startsWith("You are Demi-God")) {
        const r = toolResult(req);
        return r === undefined
          ? { toolCalls: [{ name: "ask_god", input: { message: lastText(req) } }] }
          : { text: `Demi-God: ${r.split("\n")[0]}` };
      }
      return toolResult(req) === undefined
        ? {
            toolCalls: [
              {
                name: "publish_board",
                input: {
                  title: "La home",
                  variants: [
                    { title: "A", html: "<h1>A</h1>" },
                    { title: "B", html: "<h1>B</h1>" },
                  ],
                },
              },
            ],
          }
        : { text: "Done." };
    });
    await pair();
    s?.core.setPublicUrl("https://rg.example.ts.net/");
    await s?.gateway?.handleUpdate(tg?.text(USER, "Two options for the home") as never);
    await s?.gateway?.idle();
    const notice = tg?.sent(USER).find((m) => String(m.text).includes("prepared 2 proposals"));
    expect(String(notice?.text)).toMatch(
      /^God prepared 2 proposals for you: «La home»\nhttps:\/\/rg\.example\.ts\.net\/#tavola=sess_[\w-]+\.[0-9a-f]{12}$/,
    );
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
      ask = tg?.sent(USER).find((m) => String(m.text).startsWith("Approval needed"));
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
    expect(tg?.calls.find((c) => c.method === "editMessageText")?.body.text).toMatch(/Allowed$/);
  });

  it("asks God's questions with buttons, in the wizard's language, and takes replies as answers", async () => {
    const { god } = await setup((req) =>
      toolResult(req) === undefined
        ? {
            toolCalls: [
              {
                name: "ask_user",
                input: {
                  questions: [
                    { question: "Colore?", options: [{ label: "Rosso" }, { label: "Blu" }] },
                    {
                      question: "Extra?",
                      options: [{ label: "A" }, { label: "B" }, { label: "C" }],
                      multi_select: true,
                    },
                    { question: "Nome?", options: [{ label: "X" }, { label: "Y" }] },
                  ],
                },
              },
            ],
          }
        : { text: `got: ${toolResult(req)}` },
    );
    await pair();
    (s as Server).core.setLanguage("it");
    const sid =
      (await s?.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god }))?.body
        .sessionId ?? "";
    const turn = (await s?.core.send("me", sid, "go"))?.done;
    const asks = () =>
      tg?.calls.filter((c) => c.method === "sendMessage" && /chiede/.test(String(c.body.text))) ??
      [];
    for (let i = 0; i < 100 && asks().length < 3; i++) await new Promise((r) => setTimeout(r, 30));
    const [first, second, third] = asks();
    expect(first?.body.text).toMatch(/^God chiede:\nColore\?/);
    const buttons = (c: typeof first) =>
      (
        c?.body.reply_markup as
          | { inline_keyboard: { text: string; callback_data: string }[][] }
          | undefined
      )?.inline_keyboard.flat() ?? [];
    // One choice.
    await s?.gateway?.handleUpdate(
      tg?.button(USER, buttons(first)[1]?.callback_data ?? "") as never,
    );
    // Several choices, then Send.
    await s?.gateway?.handleUpdate(
      tg?.button(USER, buttons(second)[0]?.callback_data ?? "") as never,
    );
    await s?.gateway?.handleUpdate(
      tg?.button(USER, buttons(second)[2]?.callback_data ?? "") as never,
    );
    const marks = tg?.calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1);
    expect(
      (
        marks?.body.reply_markup as { inline_keyboard: { text: string }[][] } | undefined
      )?.inline_keyboard
        .flat()
        .map((b) => b.text),
    ).toEqual(["[x] A", "[ ] B", "[x] C", "Invia"]);
    await s?.gateway?.handleUpdate(
      tg?.button(USER, buttons(second).at(-1)?.callback_data ?? "") as never,
    );
    // A reply to the message is a free answer, not a message for Demi-God.
    await s?.gateway?.handleUpdate(tg?.reply(USER, "Zeta", third?.messageId ?? 0) as never);
    expect((await turn)?.stopReason).toBe("end_turn");
    const results = (await s?.core.history("me", sid))?.flatMap((e) =>
      e.type === "tool.result" ? [e.payload.output] : [],
    );
    expect(results).toEqual(["Colore?\n-> Blu\n\nExtra?\n-> A; C\n\nNome?\n-> Zeta"]);
    expect(
      tg?.calls
        .filter((c) => c.method === "editMessageText")
        .map((c) => String(c.body.text).split("\n\n").at(-1)),
    ).toEqual(["Risposta: Blu", "Risposta: A; C", "Risposta: Zeta"]);
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
      ask = tg?.sent(USER).find((m) => String(m.text).startsWith("Approval needed"));
    }
    const allow = (
      ask?.reply_markup as { inline_keyboard: { callback_data: string }[][] } | undefined
    )?.inline_keyboard[0]?.[0]?.callback_data;
    await s?.gateway?.handleUpdate(tg?.button(USER, allow ?? "") as never);
    await s?.gateway?.idle();
    expect(tg?.sent(USER).at(-1)?.text).toBe("Demi-God: written");
  });

  it("sends notifications to every linked chat, split under Telegram's limit", async () => {
    await setup(() => ({ text: "x" }));
    await pair();
    await s?.gateway?.notify(
      "me",
      `Automation digest: done\n\n${"a".repeat(3000)}\n\n${"b".repeat(3000)}`,
    );
    const sent = tg
      ?.sent(USER)
      .slice(-2)
      .map((m) => String(m.text).length);
    expect(sent).toEqual([3000 + "Automation digest: done\n\n".length, 3000]);
    await s?.gateway?.notify("nobody", "lost");
    expect(tg?.sent(USER).at(-1)?.text).not.toBe("lost");
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

describe("toTelegramHtml", () => {
  it("turns the usual Markdown into Telegram's HTML and escapes the rest", async () => {
    const { toTelegramHtml } = await import("@redgiant/telegram");
    expect(
      toTelegramHtml(
        '**Fatto**: `cart.py` <ok> & *bene*\n- uno\n## Titolo\n[link](https://x.y/a)\n```py\nprint("**no**")\n```',
      ),
    ).toBe(
      '<b>Fatto</b>: <code>cart.py</code> &lt;ok&gt; &amp; <i>bene</i>\n• uno\n<b>Titolo</b>\n<a href="https://x.y/a">link</a>\n<pre>print("**no**")</pre>',
    );
  });

  it("takes photos, documents and voice notes to God, and answers /status, /stop and /new", async () => {
    const seenByGod: CompletionRequest[] = [];
    await setup(
      (req) => {
        if (req.system.startsWith("You are Demi-God")) {
          const r = toolResult(req);
          return r === undefined
            ? { toolCalls: [{ name: "ask_god", input: { message: lastText(req) } }] }
            : { text: r };
        }
        seenByGod.push(req);
        return { text: "seen" };
        // A real window: God's tools alone fill most of the fake's 8192 tokens.
      },
      undefined,
      { contextWindow: 64_000 },
    );
    await pair();
    (s as Server).core.setLanguage("it");
    const last = () => String(tg?.sent(USER).at(-1)?.text ?? "");
    const settle = async (n: number) => {
      for (let i = 0; i < 200 && (tg?.sent(USER).length ?? 0) < n; i++)
        await new Promise((r) => setTimeout(r, 20));
      await s?.gateway?.idle();
    };

    // A photo: Demi-God sees it, and God gets it with the message, labelled as from Telegram.
    tg?.files.set("ph1", Buffer.from("fake-jpeg"));
    let before = tg?.sent(USER).length ?? 0;
    await s?.gateway?.handleUpdate(tg?.media(USER, "photo", "ph1", { caption: "Cos'è?" }) as never);
    await settle(before + 1);
    const godMsg = seenByGod.at(-1)?.messages.at(-1);
    expect(godMsg?.parts).toEqual([
      { type: "text", text: "Cos'è?" },
      { type: "image", mediaType: "image/jpeg", data: Buffer.from("fake-jpeg").toString("base64") },
    ]);
    const godSession = (await s?.core.listSessions("me"))?.find(
      (r) => s?.core.registry.get(r.agent_id)?.kind === "god",
    );
    const fromLabel = (await (s as Server).core.history("me", godSession?.id ?? "")).find(
      (e) => e.type === "message.user",
    );
    expect(fromLabel?.payload).toMatchObject({ from: "Telegram" });

    // A document: saved where God works, its path in the message.
    tg?.files.set("doc1", Buffer.from("%PDF-1.4 fake"));
    before = tg?.sent(USER).length ?? 0;
    await s?.gateway?.handleUpdate(
      tg?.media(USER, "document", "doc1", {
        file_name: "fattura.pdf",
        mime_type: "application/pdf",
      }) as never,
    );
    await settle(before + 1);
    const text = seenByGod
      .at(-1)
      ?.messages.at(-1)
      ?.parts.find((p) => p.type === "text");
    const path = (text?.type === "text" ? text.text : "").match(/path="([^"]+)"/)?.[1] ?? "";
    expect(path).toMatch(/^\.attachments\/\d{4}-\d{2}-\d{2}\/[a-z0-9]+-fattura\.pdf$/);
    expect((await readFile(join((s as Server).core.platformPath("me"), path))).toString()).toBe(
      "%PDF-1.4 fake",
    );

    // A voice note without a transcription service: said plainly.
    tg?.files.set("v1", Buffer.from("ogg"));
    await s?.gateway?.handleUpdate(tg?.media(USER, "voice", "v1") as never);
    expect(last()).toMatch(/servizio di trascrizione/);

    // Commands.
    await s?.gateway?.handleUpdate(tg?.text(USER, "/status") as never);
    expect(last()).toBe(
      "Nessuno sta lavorando adesso.\nTi aspettano: 0 approvazioni, 0 domande.\nSpeso: $0.00.",
    );
    await s?.gateway?.handleUpdate(tg?.text(USER, "/stop") as never);
    expect(last()).toBe("Non c'era niente in corso.");
    const oldGod = godSession?.id;
    await s?.gateway?.handleUpdate(tg?.text(USER, "/new") as never);
    expect(last()).toMatch(/^Nuova conversazione/);
    before = tg?.sent(USER).length ?? 0;
    await s?.gateway?.handleUpdate(tg?.text(USER, "ciao") as never);
    await settle(before + 1);
    const godSessions = (await s?.core.listSessions("me"))?.filter(
      (r) => s?.core.registry.get(r.agent_id)?.kind === "god",
    );
    expect(godSessions?.length).toBe(2);
    expect(godSessions?.at(-1)?.id).not.toBe(oldGod);
  });
});

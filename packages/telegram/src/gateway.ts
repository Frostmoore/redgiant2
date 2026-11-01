import { randomInt } from "node:crypto";
import { autoRetry } from "@grammyjs/auto-retry";
import type { SqlClient } from "@redgiant/events";
import {
  type Answers,
  type PermissionRequestInfo,
  PLAN_APPROVE,
  PLAN_REVISE,
  type QuestionRequestInfo,
} from "@redgiant/protocol";
import { Bot, type Context, InlineKeyboard } from "grammy";
import type { Update } from "grammy/types";
import { type Language, say, type TextKey } from "./texts.js";

/** What the gateway needs from the RedGiant core. */
export interface TelegramHost {
  /** Hands a message to the owner's Demi-God (session per chat) and returns its reply. */
  askDemigod(ownerId: string, chatId: number, text: string): Promise<string>;
  approvals: {
    on(event: "request", l: (ownerId: string, info: PermissionRequestInfo) => void): unknown;
    on(
      event: "closed",
      l: (ownerId: string, requestId: string, decision: "allow" | "deny") => void,
    ): unknown;
    decide(ownerId: string, requestId: string, decision: "allow" | "deny"): boolean;
  };
  /** Questions and plans from the agents (ask_user, propose_plan), answered with buttons. */
  questions?: {
    on(event: "request", l: (ownerId: string, info: QuestionRequestInfo) => void): unknown;
    on(event: "closed", l: (ownerId: string, requestId: string) => void): unknown;
    answer(ownerId: string, requestId: string, answers: Answers): boolean;
  };
  /** The language chosen in the setup wizard. */
  language?(ownerId: string): Language;
}

/** A question being answered on Telegram: one message per question. */
interface Asking {
  ownerId: string;
  info: QuestionRequestInfo;
  answers: (string[] | null)[];
  picks: string[][];
  messages: { chatId: number; messageId: number; index: number; text: string }[];
}

export interface TelegramLink {
  ownerId: string;
  userId: number;
  chatId: number;
  username: string | null;
  linkedAt: string;
}

export async function migrateTelegram(db: SqlClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_telegram_links (
      user_id   bigint PRIMARY KEY,
      owner_id  text NOT NULL,
      chat_id   bigint NOT NULL,
      username  text,
      linked_at timestamptz NOT NULL DEFAULT now()
    )`);
}

/** Telegram's limit is 4096 characters per message; split on paragraph or line ends. */
export function splitMessage(text: string, max = 4000): string[] {
  const out: string[] = [];
  let rest = text.trim() || "…";
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

/**
 * Models write Markdown; Telegram shows it raw. The common parts (bold, italics, code, links,
 * headings) become Telegram's HTML; everything else is escaped and stays as text.
 */
export function toTelegramHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const blocks: string[] = [];
  // Code blocks first: nothing inside them is formatting.
  let text = md.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code: string) => {
    blocks.push(`<pre>${esc(code.replace(/\n$/, ""))}</pre>`);
    return `\uE000${blocks.length - 1}\uE000`;
  });
  text = esc(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/gm, "$1<i>$2</i>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^\s*[-*]\s+/gm, "• ");
  return text.replace(/\uE000(\d+)\uE000/g, (_, i: string) => blocks[Number(i)] ?? "");
}

export interface GatewayOptions {
  token: string;
  db: SqlClient;
  host: TelegramHost;
  /** For tests: a fake Bot API server. */
  apiRoot?: string;
  /** Pairing codes expire after this long (default 10 minutes). */
  pairingTtlMs?: number;
}

/**
 * Demi-God's Telegram side (RD8): only paired users reach it; messages go to Demi-God
 * (which talks to God only) and its reply comes back; approvals arrive with buttons.
 */
export class TelegramGateway {
  readonly bot: Bot;
  private readonly codes = new Map<string, { ownerId: string; expires: number }>();
  /** Approval messages already sent, to edit them when the request closes. */
  private readonly sent = new Map<string, { chatId: number; messageId: number; text: string }[]>();
  private readonly sentOwner = new Map<string, string>();
  private me: { username: string } | undefined;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly asking = new Map<string, Asking>();

  constructor(private readonly o: GatewayOptions) {
    this.bot = new Bot(o.token, o.apiRoot ? { client: { apiRoot: o.apiRoot } } : {});
    this.bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
    this.bot.command("start", (ctx) => this.onStart(ctx));
    this.bot.on("message:text", (ctx) => this.onText(ctx));
    this.bot.on("callback_query:data", (ctx) => this.onButton(ctx));
    this.bot.catch((err) => console.error("telegram:", err.message));
    o.host.approvals.on(
      "request",
      (ownerId, info) => void this.sendApproval(ownerId, info).catch(() => {}),
    );
    o.host.approvals.on(
      "closed",
      (_ownerId, requestId, decision) =>
        void this.closeApproval(requestId, decision).catch(() => {}),
    );
    o.host.questions?.on(
      "request",
      (ownerId, info) => void this.sendQuestion(ownerId, info).catch(() => {}),
    );
    o.host.questions?.on(
      "closed",
      (_ownerId, requestId) => void this.closeQuestion(requestId).catch(() => {}),
    );
  }

  private say(ownerId: string | undefined, key: TextKey, vars?: Record<string, string>) {
    return say((ownerId && this.o.host.language?.(ownerId)) || "en", key, vars);
  }

  /** Reads the bot's identity (also validates the token). */
  async init(): Promise<{ username: string }> {
    if (!this.me) {
      await this.bot.init();
      this.me = { username: this.bot.botInfo.username };
    }
    return this.me;
  }

  /** A one-time code the owner sends as `/start <code>` to link their Telegram account. */
  pairingCode(ownerId: string): { code: string; expiresAt: string } {
    const code = String(randomInt(100_000, 1_000_000));
    const expires = Date.now() + (this.o.pairingTtlMs ?? 600_000);
    this.codes.set(code, { ownerId, expires });
    return { code, expiresAt: new Date(expires).toISOString() };
  }

  async links(ownerId: string): Promise<TelegramLink[]> {
    const rows = await this.o.db.query<{
      owner_id: string;
      user_id: string | number;
      chat_id: string | number;
      username: string | null;
      linked_at: Date | string;
    }>("SELECT * FROM rg_telegram_links WHERE owner_id = $1 ORDER BY linked_at", [ownerId]);
    return rows.map((r) => ({
      ownerId: r.owner_id,
      userId: Number(r.user_id),
      chatId: Number(r.chat_id),
      username: r.username,
      linkedAt: new Date(r.linked_at).toISOString(),
    }));
  }

  async unlink(ownerId: string, userId: number): Promise<void> {
    await this.o.db.query("DELETE FROM rg_telegram_links WHERE owner_id = $1 AND user_id = $2", [
      ownerId,
      userId,
    ]);
  }

  private async ownerOf(userId: number | undefined): Promise<string | undefined> {
    if (userId === undefined) return undefined;
    const [r] = await this.o.db.query<{ owner_id: string }>(
      "SELECT owner_id FROM rg_telegram_links WHERE user_id = $1",
      [userId],
    );
    return r?.owner_id;
  }

  private async onStart(ctx: Context) {
    const code = (ctx.match as string | undefined)?.trim() ?? "";
    const entry = this.codes.get(code);
    if (!entry || entry.expires < Date.now() || !ctx.from || !ctx.chat) {
      await ctx.reply(this.say(entry?.ownerId, "linkHow"));
      return;
    }
    this.codes.delete(code);
    await this.o.db.query(
      `INSERT INTO rg_telegram_links (user_id, owner_id, chat_id, username) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, chat_id = EXCLUDED.chat_id, username = EXCLUDED.username, linked_at = now()`,
      [ctx.from.id, entry.ownerId, ctx.chat.id, ctx.from.username ?? null],
    );
    await ctx.reply(this.say(entry.ownerId, "linked"));
  }

  private async onText(ctx: Context) {
    const text = ctx.message?.text ?? "";
    if (text.startsWith("/")) return;
    const owner = await this.ownerOf(ctx.from?.id);
    if (!owner || !ctx.chat) {
      await ctx.reply(this.say(undefined, "notLinked"));
      return;
    }
    // A reply to a question's message is its answer, not a message for Demi-God.
    const replyTo = ctx.message?.reply_to_message?.message_id;
    if (replyTo !== undefined && (await this.answerByText(owner, ctx.chat.id, replyTo, text)))
      return;
    // Not awaited: polling hands updates over one at a time, and the approval buttons of this
    // very request must get through while God works (awaiting here would deadlock).
    const work = this.relay(owner, ctx.chat.id, text).finally(() => this.inFlight.delete(work));
    this.inFlight.add(work);
  }

  private async relay(owner: string, chatId: number, text: string) {
    const api = this.bot.api;
    // "typing…" while Demi-God and God work (Telegram shows it for about 5 seconds).
    const typing = setInterval(
      () => void api.sendChatAction(chatId, "typing").catch(() => {}),
      4500,
    );
    void api.sendChatAction(chatId, "typing").catch(() => {});
    try {
      const answer = await this.o.host.askDemigod(owner, chatId, text);
      for (const part of splitMessage(answer)) await this.sendFormatted(chatId, part);
    } catch (err) {
      await api
        .sendMessage(chatId, this.say(owner, "error", { error: (err as Error).message }))
        .catch(() => {});
    } finally {
      clearInterval(typing);
    }
  }

  /** Resolves when every message being relayed has been answered (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /** A message to every chat linked to the owner (automations' results…). */
  async notify(ownerId: string, text: string): Promise<void> {
    for (const link of await this.links(ownerId))
      for (const part of splitMessage(text))
        await this.sendFormatted(link.chatId, part).catch(() => {});
  }

  /** As HTML when Telegram accepts it, as plain text otherwise (it rejects broken markup). */
  private async sendFormatted(chatId: number, text: string) {
    try {
      await this.bot.api.sendMessage(chatId, toTelegramHtml(text), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch {
      await this.bot.api.sendMessage(chatId, text);
    }
  }

  private async sendApproval(ownerId: string, info: PermissionRequestInfo) {
    const input = JSON.stringify(info.input);
    const s = (key: TextKey, vars?: Record<string, string>) => this.say(ownerId, key, vars);
    const text = [
      s("approvalNeeded", {
        agent: info.agentName,
        project: info.projectId ? ` (${info.projectId})` : "",
        tool: info.tool,
      }),
      input.length > 600 ? `${input.slice(0, 600)}…` : input,
      s("why", { reasons: info.reasons.join("; ") }),
      ...(info.danger.length ? [s("danger", { danger: info.danger.join(", ") })] : []),
    ].join("\n");
    const keyboard = new InlineKeyboard()
      .text(s("allow"), `perm:${info.requestId}:allow`)
      .text(s("deny"), `perm:${info.requestId}:deny`);
    this.sentOwner.set(info.requestId, ownerId);
    for (const link of await this.links(ownerId)) {
      const m = await this.bot.api.sendMessage(link.chatId, text, { reply_markup: keyboard });
      this.sent.set(info.requestId, [
        ...(this.sent.get(info.requestId) ?? []),
        { chatId: link.chatId, messageId: m.message_id, text },
      ]);
    }
  }

  private async closeApproval(requestId: string, decision: "allow" | "deny") {
    const owner = this.sentOwner.get(requestId);
    for (const m of this.sent.get(requestId) ?? []) {
      await this.bot.api
        .editMessageText(
          m.chatId,
          m.messageId,
          `${m.text}\n\n${this.say(owner, decision === "allow" ? "allowed" : "denied")}`,
        )
        .catch(() => {});
    }
    this.sent.delete(requestId);
    this.sentOwner.delete(requestId);
  }

  // ---------- Questions (ask_user, propose_plan) ----------

  private optionLabel(owner: string, label: string) {
    return label === PLAN_APPROVE
      ? this.say(owner, "approvePlan")
      : label === PLAN_REVISE
        ? this.say(owner, "revisePlan")
        : label;
  }

  private keyboard(a: Asking, index: number) {
    const q = a.info.questions[index];
    const k = new InlineKeyboard();
    if (!q) return k;
    q.options.forEach((o, i) => {
      const on = a.picks[index]?.includes(o.label);
      const label = this.optionLabel(a.ownerId, o.label);
      k.text(
        q.multiSelect ? `${on ? "[x]" : "[ ]"} ${label}` : label,
        `q:${a.info.requestId}:${index}:${i}`,
      ).row();
    });
    if (q.multiSelect) k.text(this.say(a.ownerId, "send"), `q:${a.info.requestId}:${index}:send`);
    return k;
  }

  private async sendQuestion(ownerId: string, info: QuestionRequestInfo) {
    const a: Asking = {
      ownerId,
      info,
      answers: info.questions.map(() => null),
      picks: info.questions.map(() => []),
      messages: [],
    };
    this.asking.set(info.requestId, a);
    const s = (key: TextKey, vars?: Record<string, string>) => this.say(ownerId, key, vars);
    for (const link of await this.links(ownerId)) {
      for (const [index, q] of info.questions.entries()) {
        const head =
          info.plan !== undefined
            ? `${s("planFrom", { agent: info.agentName })}\n\n${info.plan.length > 3000 ? `${info.plan.slice(0, 3000)}…` : info.plan}`
            : `${s("questionFrom", { agent: info.agentName })}\n${q.header ? `[${q.header}] ` : ""}${q.question}`;
        const details = q.options
          .filter((o) => o.description)
          .map((o) => `- ${o.label}: ${o.description}`)
          .join("\n");
        const text = [
          head,
          ...(details ? [details] : []),
          ...(q.multiSelect ? [s("manyAnswers")] : []),
          s("replyToAnswer"),
        ].join("\n\n");
        const m = await this.bot.api.sendMessage(link.chatId, text, {
          reply_markup: this.keyboard(a, index),
        });
        a.messages.push({ chatId: link.chatId, messageId: m.message_id, index, text });
      }
    }
  }

  /** One question answered: its messages show the answer; all answered: it goes to the agent. */
  private async settle(a: Asking, index: number, answer: string[]) {
    a.answers[index] = answer;
    for (const m of a.messages.filter((x) => x.index === index))
      await this.bot.api
        .editMessageText(
          m.chatId,
          m.messageId,
          `${m.text}\n\n${this.say(a.ownerId, "answered", {
            answer: answer.map((x) => this.optionLabel(a.ownerId, x)).join("; "),
          })}`,
        )
        .catch(() => {});
    if (a.answers.every((x) => x !== null)) {
      this.asking.delete(a.info.requestId);
      this.o.host.questions?.answer(a.ownerId, a.info.requestId, a.answers as Answers);
    }
  }

  private async answerByText(owner: string, chatId: number, replyTo: number, text: string) {
    for (const a of this.asking.values()) {
      if (a.ownerId !== owner) continue;
      const m = a.messages.find((x) => x.chatId === chatId && x.messageId === replyTo);
      if (!m || a.answers[m.index] !== null) continue;
      await this.settle(a, m.index, [text.trim()]);
      return true;
    }
    return false;
  }

  private async closeQuestion(requestId: string) {
    const a = this.asking.get(requestId);
    if (!a) return;
    this.asking.delete(requestId);
    for (const m of a.messages.filter((x) => a.answers[x.index] === null))
      await this.bot.api
        .editMessageText(m.chatId, m.messageId, `${m.text}\n\n${this.say(a.ownerId, "noAnswer")}`)
        .catch(() => {});
  }

  private async onQuestionButton(ctx: Context, owner: string, data: string) {
    const [, requestId = "", indexText = "", pick = ""] = data.split(":");
    const a = this.asking.get(requestId);
    const index = Number(indexText);
    const q = a?.info.questions[index];
    if (!a || a.ownerId !== owner || !q || a.answers[index] !== null) {
      await ctx.answerCallbackQuery({ text: this.say(owner, "closedAlready") });
      return;
    }
    if (pick === "send") {
      const chosen = a.picks[index] ?? [];
      if (chosen.length === 0) {
        await ctx.answerCallbackQuery({ text: this.say(owner, "pickFirst") });
        return;
      }
      await ctx.answerCallbackQuery({ text: this.say(owner, "saved") });
      await this.settle(a, index, chosen);
      return;
    }
    const label = q.options[Number(pick)]?.label;
    if (label === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    if (!q.multiSelect) {
      await ctx.answerCallbackQuery({ text: this.say(owner, "saved") });
      await this.settle(a, index, [label]);
      return;
    }
    const now = a.picks[index] ?? [];
    a.picks[index] = now.includes(label) ? now.filter((x) => x !== label) : [...now, label];
    await ctx.answerCallbackQuery();
    for (const m of a.messages.filter((x) => x.index === index))
      await this.bot.api
        .editMessageReplyMarkup(m.chatId, m.messageId, { reply_markup: this.keyboard(a, index) })
        .catch(() => {});
  }

  private async onButton(ctx: Context) {
    const data = ctx.callbackQuery?.data ?? "";
    const owner = await this.ownerOf(ctx.from?.id);
    if (owner && data.startsWith("q:")) return this.onQuestionButton(ctx, owner, data);
    const m = data.match(/^perm:([\w-]+):(allow|deny)$/);
    if (!m || !owner) {
      await ctx.answerCallbackQuery({ text: this.say(owner, "notAllowed") });
      return;
    }
    const ok = this.o.host.approvals.decide(owner, m[1] as string, m[2] as "allow" | "deny");
    await ctx.answerCallbackQuery({
      text: this.say(owner, ok ? (m[2] === "allow" ? "allowed" : "denied") : "closedAlready"),
    });
  }

  /** Webhook mode: hand each update received over HTTPS to the bot. */
  async handleUpdate(update: Update): Promise<void> {
    await this.init();
    await this.bot.handleUpdate(update);
  }

  /** Polling mode: works behind NAT, no public URL needed. */
  async startPolling(): Promise<void> {
    await this.init();
    await this.bot.api.deleteWebhook().catch(() => {});
    void this.bot.start({
      drop_pending_updates: false,
      allowed_updates: ["message", "callback_query"],
    });
  }

  async stop(): Promise<void> {
    if (this.bot.isRunning()) await this.bot.stop();
  }
}

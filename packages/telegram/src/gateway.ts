import { randomInt } from "node:crypto";
import { autoRetry } from "@grammyjs/auto-retry";
import type { SqlClient } from "@redgiant/events";
import type { PermissionRequestInfo } from "@redgiant/protocol";
import { Bot, type Context, InlineKeyboard } from "grammy";
import type { Update } from "grammy/types";

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
  private me: { username: string } | undefined;
  private readonly inFlight = new Set<Promise<void>>();

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
      await ctx.reply(
        "To link this chat, open RedGiant → Telegram → Pair, then send /start <code> here.",
      );
      return;
    }
    this.codes.delete(code);
    await this.o.db.query(
      `INSERT INTO rg_telegram_links (user_id, owner_id, chat_id, username) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, chat_id = EXCLUDED.chat_id, username = EXCLUDED.username, linked_at = now()`,
      [ctx.from.id, entry.ownerId, ctx.chat.id, ctx.from.username ?? null],
    );
    await ctx.reply("Linked. Write to me and I will pass it on to God.");
  }

  private async onText(ctx: Context) {
    const text = ctx.message?.text ?? "";
    if (text.startsWith("/")) return;
    const owner = await this.ownerOf(ctx.from?.id);
    if (!owner || !ctx.chat) {
      await ctx.reply(
        "This chat is not linked to RedGiant. Open RedGiant → Telegram → Pair, then send /start <code>.",
      );
      return;
    }
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
      for (const part of splitMessage(answer)) await api.sendMessage(chatId, part);
    } catch (err) {
      await api.sendMessage(chatId, `⚠️ ${(err as Error).message}`).catch(() => {});
    } finally {
      clearInterval(typing);
    }
  }

  /** Resolves when every message being relayed has been answered (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private async sendApproval(ownerId: string, info: PermissionRequestInfo) {
    const input = JSON.stringify(info.input);
    const text =
      `🔔 ${info.agentName}${info.projectId ? ` (${info.projectId})` : ""} wants ${info.tool}\n` +
      `${input.length > 600 ? `${input.slice(0, 600)}…` : input}\n` +
      `Why: ${info.reasons.join("; ")}${info.danger.length ? `\nDanger: ${info.danger.join(", ")}` : ""}`;
    const keyboard = new InlineKeyboard()
      .text("✅ Allow", `perm:${info.requestId}:allow`)
      .text("⛔ Deny", `perm:${info.requestId}:deny`);
    for (const link of await this.links(ownerId)) {
      const m = await this.bot.api.sendMessage(link.chatId, text, { reply_markup: keyboard });
      this.sent.set(info.requestId, [
        ...(this.sent.get(info.requestId) ?? []),
        { chatId: link.chatId, messageId: m.message_id, text },
      ]);
    }
  }

  private async closeApproval(requestId: string, decision: "allow" | "deny") {
    for (const m of this.sent.get(requestId) ?? []) {
      await this.bot.api
        .editMessageText(
          m.chatId,
          m.messageId,
          `${m.text}\n\n${decision === "allow" ? "✅ Allowed" : "⛔ Denied"}`,
        )
        .catch(() => {});
    }
    this.sent.delete(requestId);
  }

  private async onButton(ctx: Context) {
    const data = ctx.callbackQuery?.data ?? "";
    const m = data.match(/^perm:([\w-]+):(allow|deny)$/);
    const owner = await this.ownerOf(ctx.from?.id);
    if (!m || !owner) {
      await ctx.answerCallbackQuery({ text: "Not allowed." });
      return;
    }
    const ok = this.o.host.approvals.decide(owner, m[1] as string, m[2] as "allow" | "deny");
    await ctx.answerCallbackQuery({
      text: ok ? (m[2] === "allow" ? "Allowed" : "Denied") : "This request is already closed.",
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

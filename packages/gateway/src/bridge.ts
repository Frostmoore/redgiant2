// Demi-God on every chat platform (G29.5, RedGiant 2.0). The bridge holds what is the same
// everywhere (pairing, relaying to Demi-God, voice notes, approvals, questions, /new /status
// /stop); a transport only receives and sends messages on its platform. Telegram keeps its own
// gateway (`@redgiant/telegram`); every other platform goes through here.
//
// The conversation is the owner's, not the chat's: Demi-God keeps one work session per person,
// so a talk started on Telegram goes on on Discord, Slack, Signal, WhatsApp or the web.

import { randomInt } from "node:crypto";
import type { SqlClient } from "@redgiant/events";
import {
  type Answers,
  dangerWords,
  type ImagePart,
  type PermissionRequestInfo,
  PLAN_APPROVE,
  PLAN_REVISE,
  type QuestionRequestInfo,
} from "@redgiant/protocol";
import { type Language, say, type TextKey } from "./texts.js";

export type Platform =
  | "discord"
  | "slack"
  | "signal"
  | "whatsapp"
  | "matrix"
  | "teams"
  | "imessage";

export const PLATFORM_NAMES: Record<Platform, string> = {
  discord: "Discord",
  slack: "Slack",
  signal: "Signal",
  whatsapp: "WhatsApp",
  matrix: "Matrix",
  teams: "Microsoft Teams",
  imessage: "iMessage",
};

export interface Button {
  id: string;
  label: string;
}

/** A message from the platform, already in plain terms. */
export interface Incoming {
  userId: string;
  chatId: string;
  username?: string | null;
  text?: string;
  /** The id of a button pressed under one of our messages. */
  button?: string;
  audio?: { data: Uint8Array; mime: string };
  files?: { name: string; data: Buffer; mime: string }[];
  /** Something arrived that cannot be read here (an encrypted Matrix message, G36.9). */
  unreadable?: "encrypted";
}

/** One platform: how messages arrive and how they leave. */
export interface Transport {
  readonly platform: Platform;
  /** Buttons under a message; without them the bridge numbers the choices. */
  readonly buttons: boolean;
  /** The longest text one message may carry. */
  readonly maxLength: number;
  start(on: (m: Incoming) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  /** Sends a message; returns its id when the platform can edit it later. */
  send(chatId: string, text: string, buttons?: Button[]): Promise<string | undefined>;
  /** Replaces a message's text and drops its buttons. */
  edit?(chatId: string, messageId: string, text: string): Promise<void>;
  sendFile?(
    chatId: string,
    data: Buffer,
    name: string,
    mime: string,
    caption?: string,
  ): Promise<void>;
  /** "Typing…" while Demi-God works, where the platform shows it. */
  typing?(chatId: string): Promise<void>;
}

/** What the bridge needs from the RedGiant core (the same as Telegram's). */
export interface GatewayHost {
  askDemigod(
    ownerId: string,
    chatId: string,
    text: string,
    extra?: {
      images?: ImagePart[];
      files?: { name: string; data: Buffer }[];
      onQueued?: () => void;
    },
  ): Promise<string>;
  /**
   * A message from a linked person, before Demi-God reads it (G33.3): automations waiting for
   * one like it start; `taken` when one keeps it, then Demi-God does not answer it and the chat
   * is told which automation took it.
   */
  chatMessage?(
    ownerId: string,
    m: { platform: string; userId: string; from: string; chatId: string; text: string },
  ): Promise<{ taken: boolean; names: string[] }>;
  transcribe?(audio: Uint8Array, mime: string, language?: string): Promise<string>;
  readonly transcription?: unknown;
  newConversation?(ownerId: string): void;
  stopWork?(ownerId: string): Promise<boolean>;
  statusSummary?(ownerId: string): Promise<{
    working: string[];
    approvals: number;
    questions: number;
    spentUsd: number;
    limitUsd: number | null;
  }>;
  approvals: {
    on(event: "request", l: (ownerId: string, info: PermissionRequestInfo) => void): unknown;
    on(
      event: "closed",
      l: (ownerId: string, requestId: string, decision: "allow" | "deny") => void,
    ): unknown;
    decide(ownerId: string, requestId: string, decision: "allow" | "deny"): boolean;
  };
  questions?: {
    on(event: "request", l: (ownerId: string, info: QuestionRequestInfo) => void): unknown;
    on(event: "closed", l: (ownerId: string, requestId: string) => void): unknown;
    answer(ownerId: string, requestId: string, answers: Answers): boolean;
  };
  language?(ownerId: string): Language;
  /** Whether the person wants requests in the chats now (G36.17, Settings > Requests). */
  requestsReach?(ownerId: string, channel: "chats"): boolean;
}

export interface ChatLink {
  platform: Platform;
  ownerId: string;
  userId: string;
  chatId: string;
  username: string | null;
  linkedAt: string;
}

export async function migrateGateway(db: SqlClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_chat_links (
      platform  text NOT NULL,
      user_id   text NOT NULL,
      owner_id  text NOT NULL,
      chat_id   text NOT NULL,
      username  text,
      linked_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (platform, user_id)
    )`);
}

/** Splits on paragraph or line ends, so no message passes the platform's limit. */
export function splitText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/** What a chat is being asked right now: its numbered choices answer it. */
type Prompt =
  | { kind: "perm"; requestId: string }
  | { kind: "question"; requestId: string; index: number };

/** A question being answered: one message per question, in order. */
interface Asking {
  ownerId: string;
  info: QuestionRequestInfo;
  answers: string[][];
  sent: { chatId: string; messageId?: string; text: string }[];
}

export interface BridgeOptions {
  db: SqlClient;
  host: GatewayHost;
  transport: Transport;
  /** Pairing codes expire after this long (default 10 minutes). */
  pairingTtlMs?: number;
}

export class ChatBridge {
  private readonly codes = new Map<string, { ownerId: string; expires: number }>();
  private readonly sent = new Map<string, { chatId: string; messageId?: string; text: string }[]>();
  private readonly sentOwner = new Map<string, string>();
  private readonly asking = new Map<string, Asking>();
  private readonly prompts = new Map<string, Prompt>();
  private readonly inFlight = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly o: BridgeOptions) {}

  get platform(): Platform {
    return this.o.transport.platform;
  }

  get transport(): Transport {
    return this.o.transport;
  }

  private get t(): Transport {
    return this.o.transport;
  }

  private say(ownerId: string | undefined, key: TextKey, vars: Record<string, string> = {}) {
    const lang = (ownerId && this.o.host.language?.(ownerId)) || "en";
    return say(lang, key, { platform: PLATFORM_NAMES[this.platform], ...vars });
  }

  private failure(ownerId: string | undefined, err: unknown) {
    if ((err as { code?: unknown }).code === "no_model") return this.say(ownerId, "noModel");
    return this.say(ownerId, "error", { error: (err as Error).message });
  }

  async start(): Promise<void> {
    await migrateGateway(this.o.db);
    const h = this.o.host;
    const guard =
      <A extends unknown[]>(fn: (...a: A) => Promise<void>) =>
      (...a: A) => {
        if (!this.stopped) void fn(...a).catch(() => {});
      };
    h.approvals.on(
      "request",
      guard(async (owner: string, info: PermissionRequestInfo) => {
        if (h.requestsReach?.(owner, "chats") !== false) await this.sendApproval(owner, info);
      }),
    );
    h.approvals.on(
      "closed",
      guard((_o: string, id: string, d: "allow" | "deny") => this.closeApproval(id, d)),
    );
    h.questions?.on(
      "request",
      guard(async (owner: string, info: QuestionRequestInfo) => {
        if (h.requestsReach?.(owner, "chats") !== false) await this.sendQuestion(owner, info);
      }),
    );
    h.questions?.on(
      "closed",
      guard((_o: string, id: string) => this.closeQuestion(id)),
    );
    await this.t.start((m) => this.onIncoming(m));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.t.stop();
  }

  /** Resolves when every message being relayed has been answered (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  // ---------- Pairing ----------

  /** A one-time code the owner sends as `/start <code>` to link a chat. */
  pairingCode(ownerId: string): { code: string; expiresAt: string } {
    const code = String(randomInt(100_000, 1_000_000));
    const expires = Date.now() + (this.o.pairingTtlMs ?? 600_000);
    this.codes.set(code, { ownerId, expires });
    return { code, expiresAt: new Date(expires).toISOString() };
  }

  async links(ownerId: string): Promise<ChatLink[]> {
    const rows = await this.o.db.query<{
      platform: Platform;
      owner_id: string;
      user_id: string;
      chat_id: string;
      username: string | null;
      linked_at: Date | string;
    }>("SELECT * FROM rg_chat_links WHERE owner_id = $1 AND platform = $2 ORDER BY linked_at", [
      ownerId,
      this.platform,
    ]);
    return rows.map((r) => ({
      platform: r.platform,
      ownerId: r.owner_id,
      userId: r.user_id,
      chatId: r.chat_id,
      username: r.username,
      linkedAt: new Date(r.linked_at).toISOString(),
    }));
  }

  async unlink(ownerId: string, userId: string): Promise<void> {
    await this.o.db.query(
      "DELETE FROM rg_chat_links WHERE owner_id = $1 AND platform = $2 AND user_id = $3",
      [ownerId, this.platform, userId],
    );
  }

  private async ownerOf(userId: string): Promise<string | undefined> {
    const [r] = await this.o.db.query<{ owner_id: string }>(
      "SELECT owner_id FROM rg_chat_links WHERE platform = $1 AND user_id = $2",
      [this.platform, userId],
    );
    return r?.owner_id;
  }

  // ---------- Incoming ----------

  private reply(chatId: string, text: string) {
    return this.t.send(chatId, text).catch(() => undefined);
  }

  /** Not awaited by the transport: approvals of this very request must get through meanwhile. */
  private background(job: Promise<void>) {
    const work = job.finally(() => this.inFlight.delete(work));
    this.inFlight.add(work);
  }

  async onIncoming(m: Incoming): Promise<void> {
    const text = m.text?.trim() ?? "";
    const start = text.match(/^\/?start\s+(\d{6})$/i);
    if (start) {
      await this.pair(m, start[1] as string);
      return;
    }
    const owner = await this.ownerOf(m.userId);
    // Even the pairing code may be inside: the person is told why nothing happens.
    if (m.unreadable) {
      await this.reply(m.chatId, this.say(owner, "encrypted"));
      return;
    }
    if (!owner) {
      await this.reply(
        m.chatId,
        this.say(undefined, text.startsWith("/start") ? "linkHow" : "notLinked"),
      );
      return;
    }
    if (m.button) {
      await this.onButton(owner, m.button);
      return;
    }
    const cmd = text.match(/^\/(new|status|stop)\b/i)?.[1]?.toLowerCase();
    if (cmd) {
      await this.onCommand(owner, m.chatId, cmd as "new" | "status" | "stop");
      return;
    }
    if (text && (await this.answerPrompt(owner, m.chatId, text))) return;
    if (m.audio) {
      this.background(this.onVoice(owner, m.chatId, m.audio));
      return;
    }
    if (m.files?.length) {
      const images: ImagePart[] = [];
      const files: { name: string; data: Buffer }[] = [];
      for (const f of m.files) {
        if (IMAGE_TYPES.includes(f.mime))
          images.push({
            type: "image",
            mediaType: f.mime as ImagePart["mediaType"],
            data: f.data.toString("base64"),
            name: f.name,
          });
        else files.push({ name: f.name, data: f.data });
      }
      this.background(
        this.relay(owner, m.chatId, text || "(see the attachment)", {
          ...(images.length && { images }),
          ...(files.length && { files }),
        }),
      );
      return;
    }
    if (text) {
      const auto = await this.o.host
        .chatMessage?.(owner, {
          platform: this.platform,
          userId: m.userId,
          from: m.username ?? "",
          chatId: m.chatId,
          text,
        })
        .catch(() => undefined);
      if (auto?.taken) {
        await this.reply(
          m.chatId,
          this.say(owner, "automationTook", { names: auto.names.join(", ") }),
        );
        return;
      }
      this.background(this.relay(owner, m.chatId, text));
    }
  }

  private async pair(m: Incoming, code: string) {
    const entry = this.codes.get(code);
    if (!entry || entry.expires < Date.now()) {
      await this.reply(m.chatId, this.say(entry?.ownerId, "linkHow"));
      return;
    }
    this.codes.delete(code);
    await this.o.db.query(
      `INSERT INTO rg_chat_links (platform, user_id, owner_id, chat_id, username) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (platform, user_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, chat_id = EXCLUDED.chat_id, username = EXCLUDED.username, linked_at = now()`,
      [this.platform, m.userId, entry.ownerId, m.chatId, m.username ?? null],
    );
    await this.reply(m.chatId, this.say(entry.ownerId, "linked"));
  }

  private async onVoice(owner: string, chatId: string, audio: { data: Uint8Array; mime: string }) {
    const host = this.o.host;
    if (!host.transcribe || host.transcription === undefined) {
      await this.reply(chatId, this.say(owner, "noTranscription"));
      return;
    }
    try {
      const text = await host.transcribe(audio.data, audio.mime, host.language?.(owner) ?? "en");
      if (!text) {
        await this.reply(chatId, this.say(owner, "heardNothing"));
        return;
      }
      await this.reply(chatId, this.say(owner, "heard", { text }));
      await this.relay(owner, chatId, text);
    } catch (err) {
      await this.reply(chatId, this.failure(owner, err));
    }
  }

  private async onCommand(owner: string, chatId: string, cmd: "new" | "status" | "stop") {
    const h = this.o.host;
    if (cmd === "new") {
      h.newConversation?.(owner);
      await this.reply(chatId, this.say(owner, "newConversation"));
    } else if (cmd === "stop") {
      const stopped = (await h.stopWork?.(owner)) ?? false;
      await this.reply(chatId, this.say(owner, stopped ? "stopped" : "nothingToStop"));
    } else {
      const s = await h.statusSummary?.(owner);
      if (!s) return;
      await this.reply(
        chatId,
        [
          s.working.length
            ? this.say(owner, "working", { names: s.working.join(", ") })
            : this.say(owner, "idle"),
          this.say(owner, "waiting", {
            approvals: String(s.approvals),
            questions: String(s.questions),
          }),
          this.say(owner, s.limitUsd === null ? "spent" : "spentOf", {
            spent: s.spentUsd.toFixed(2),
            limit: (s.limitUsd ?? 0).toFixed(2),
          }),
        ].join("\n"),
      );
    }
  }

  private async relay(
    owner: string,
    chatId: string,
    text: string,
    extra?: { images?: ImagePart[]; files?: { name: string; data: Buffer }[] },
  ) {
    const typing = this.t.typing
      ? setInterval(() => void this.t.typing?.(chatId).catch(() => {}), 4500)
      : undefined;
    void this.t.typing?.(chatId).catch(() => {});
    try {
      const answer = await this.o.host.askDemigod(owner, chatId, text, {
        ...extra,
        onQueued: () => void this.reply(chatId, this.say(owner, "queued")),
      });
      for (const part of splitText(answer, this.t.maxLength)) await this.t.send(chatId, part);
    } catch (err) {
      await this.reply(chatId, this.failure(owner, err));
    } finally {
      if (typing) clearInterval(typing);
    }
  }

  // ---------- Outgoing ----------

  async notify(ownerId: string, text: string): Promise<void> {
    for (const link of await this.links(ownerId))
      for (const part of splitText(text, this.t.maxLength)) await this.reply(link.chatId, part);
  }

  async sendFile(
    ownerId: string,
    data: Buffer,
    name: string,
    mime: string,
    caption?: string,
  ): Promise<void> {
    if (!this.t.sendFile) return;
    for (const link of await this.links(ownerId))
      await this.t.sendFile(link.chatId, data, name, mime, caption).catch(() => {});
  }

  /** Buttons where the platform has them; numbered lines (answered by number) where not. */
  private async ask(
    chatId: string,
    owner: string,
    text: string,
    choices: Button[],
    prompt: Prompt,
    many = false,
  ): Promise<{ messageId?: string; text: string }> {
    let body = text;
    let buttons: Button[] | undefined = choices;
    if (!this.t.buttons) {
      body = [
        text,
        "",
        ...choices.map((c, i) => `${i + 1}. ${c.label}`),
        "",
        this.say(owner, "pickByNumber", { many: many ? this.say(owner, "pickMany") : "" }),
      ].join("\n");
      buttons = undefined;
    }
    this.prompts.set(chatId, prompt);
    const messageId = await this.t.send(chatId, body, buttons).catch(() => undefined);
    return { ...(messageId && { messageId }), text: body };
  }

  private async sendApproval(ownerId: string, info: PermissionRequestInfo) {
    const input = JSON.stringify(info.input);
    const s = (key: TextKey, vars?: Record<string, string>) => this.say(ownerId, key, vars);
    const lang = this.o.host.language?.(ownerId) ?? "en";
    const text = [
      s("approvalNeeded", {
        agent: info.agentName,
        project: info.projectId ? ` (${info.projectId})` : "",
        tool: info.tool,
      }),
      input.length > 600 ? `${input.slice(0, 600)}...` : input,
      s("why", { reasons: info.reasons.join("; ") }),
      ...(info.danger.length
        ? [s("danger", { danger: info.danger.map((d) => dangerWords(lang, d).name).join(", ") })]
        : []),
    ].join("\n");
    const choices = [
      { id: `perm:${info.requestId}:allow`, label: s("allow") },
      { id: `perm:${info.requestId}:deny`, label: s("deny") },
    ];
    this.sentOwner.set(info.requestId, ownerId);
    for (const link of await this.links(ownerId)) {
      const m = await this.ask(link.chatId, ownerId, text, choices, {
        kind: "perm",
        requestId: info.requestId,
      });
      this.sent.set(info.requestId, [
        ...(this.sent.get(info.requestId) ?? []),
        { chatId: link.chatId, ...m },
      ]);
    }
  }

  private async closeApproval(requestId: string, decision: "allow" | "deny") {
    const owner = this.sentOwner.get(requestId);
    for (const m of this.sent.get(requestId) ?? []) {
      this.clearPrompt(m.chatId, requestId);
      if (m.messageId && this.t.edit)
        await this.t
          .edit(
            m.chatId,
            m.messageId,
            `${m.text}\n\n${this.say(owner, decision === "allow" ? "allowed" : "denied")}`,
          )
          .catch(() => {});
    }
    this.sent.delete(requestId);
    this.sentOwner.delete(requestId);
  }

  private optionLabel(owner: string, label: string) {
    return label === PLAN_APPROVE
      ? this.say(owner, "approvePlan")
      : label === PLAN_REVISE
        ? this.say(owner, "revisePlan")
        : label;
  }

  private async sendQuestion(ownerId: string, info: QuestionRequestInfo) {
    const a: Asking = { ownerId, info, answers: [], sent: [] };
    this.asking.set(info.requestId, a);
    await this.askNext(a);
  }

  /** Sends the next unanswered question to every linked chat. */
  private async askNext(a: Asking) {
    const index = a.answers.length;
    const q = a.info.questions[index];
    if (!q) return;
    const head = this.say(a.ownerId, a.info.plan ? "planFrom" : "questionFrom", {
      agent: a.info.agentName,
    });
    const text = [
      head,
      ...(a.info.plan && index === 0 ? [a.info.plan.slice(0, 3000)] : []),
      q.header ? `${q.header}: ${q.question}` : q.question,
      ...q.options.filter((o) => o.description).map((o) => `- ${o.label}: ${o.description}`),
    ].join("\n\n");
    const choices = q.options.map((o, i) => ({
      id: `q:${a.info.requestId}:${index}:${i}`,
      label: this.optionLabel(a.ownerId, o.label),
    }));
    for (const link of await this.links(a.ownerId)) {
      // Several at once read better as numbers, even where buttons exist.
      const m = await this.ask(
        link.chatId,
        a.ownerId,
        text,
        q.multiSelect && this.t.buttons ? [] : choices,
        { kind: "question", requestId: a.info.requestId, index },
        q.multiSelect,
      );
      if (q.multiSelect && this.t.buttons) {
        const listed = choices.map((c, i) => `${i + 1}. ${c.label}`).join("\n");
        await this.reply(
          link.chatId,
          `${listed}\n\n${this.say(a.ownerId, "pickByNumber", { many: this.say(a.ownerId, "pickMany") })}`,
        );
      }
      a.sent.push({ chatId: link.chatId, ...m });
    }
  }

  private async settle(a: Asking, answer: string[]) {
    a.answers.push(answer);
    for (const m of a.sent) {
      this.clearPrompt(m.chatId, a.info.requestId);
      if (m.messageId && this.t.edit)
        await this.t
          .edit(
            m.chatId,
            m.messageId,
            `${m.text}\n\n${this.say(a.ownerId, "answered", { answer: answer.join(", ") })}`,
          )
          .catch(() => {});
    }
    a.sent = [];
    if (a.answers.length < a.info.questions.length) {
      await this.askNext(a);
      return;
    }
    this.asking.delete(a.info.requestId);
    this.o.host.questions?.answer(a.ownerId, a.info.requestId, a.answers);
  }

  private async closeQuestion(requestId: string) {
    const a = this.asking.get(requestId);
    if (!a) return;
    this.asking.delete(requestId);
    for (const m of a.sent) {
      this.clearPrompt(m.chatId, requestId);
      if (m.messageId && this.t.edit)
        await this.t
          .edit(m.chatId, m.messageId, `${m.text}\n\n${this.say(a.ownerId, "noAnswer")}`)
          .catch(() => {});
    }
  }

  private clearPrompt(chatId: string, requestId: string) {
    if (this.prompts.get(chatId)?.requestId === requestId) this.prompts.delete(chatId);
  }

  /** A text that answers what this chat is being asked: numbers, or (for a question) words. */
  private async answerPrompt(owner: string, chatId: string, text: string): Promise<boolean> {
    const p = this.prompts.get(chatId);
    if (!p) return false;
    const numbers = /^\d+(\s*,\s*\d+)*$/.test(text)
      ? text.split(",").map((n) => Number(n.trim()) - 1)
      : undefined;
    if (p.kind === "perm") {
      if (numbers?.length !== 1 || (numbers[0] !== 0 && numbers[0] !== 1)) return false;
      this.o.host.approvals.decide(owner, p.requestId, numbers[0] === 0 ? "allow" : "deny");
      return true;
    }
    const a = this.asking.get(p.requestId);
    const q = a?.info.questions[p.index];
    if (!a || !q || a.answers.length !== p.index) return false;
    if (numbers?.every((n) => n >= 0 && n < q.options.length)) {
      const picked = (q.multiSelect ? numbers : numbers.slice(0, 1)).map(
        (n) => q.options[n]?.label as string,
      );
      await this.settle(a, [...new Set(picked)]);
    } else await this.settle(a, [text]);
    return true;
  }

  private async onButton(owner: string, id: string) {
    const perm = id.match(/^perm:(.+):(allow|deny)$/);
    if (perm) {
      this.o.host.approvals.decide(owner, perm[1] as string, perm[2] as "allow" | "deny");
      return;
    }
    const q = id.match(/^q:(.+):(\d+):(\d+)$/);
    if (!q) return;
    const a = this.asking.get(q[1] as string);
    const index = Number(q[2]);
    const label = a?.info.questions[index]?.options[Number(q[3])]?.label;
    if (!a || a.ownerId !== owner || a.answers.length !== index || !label) return;
    await this.settle(a, [label]);
  }
}

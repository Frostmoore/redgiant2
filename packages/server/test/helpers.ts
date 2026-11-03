import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ServerMessage } from "@redgiant/protocol";
import {
  FakeProvider,
  type FakeProviderOptions,
  type FakeScript,
  ProviderRegistry,
} from "@redgiant/providers";
import { migrateTelegram, TelegramGateway } from "@redgiant/telegram";
import {
  type AppOptions,
  type CoreOptions,
  RedGiantCore,
  type Running,
  serve,
  TokenAuth,
} from "../src/index.js";
import { memoryDb } from "./pglite.js";

export const TOKEN = "test-token-0123456789";
export const OTHER = "other-token-0123456789";

/**
 * `core.askAgent` defaults to "escalate" here so that parents' models do not consume the
 * script; pass `{ askAgent: undefined }` to test approvals decided by the parent's model.
 */
export async function startServer(
  script: FakeScript,
  fake: FakeProviderOptions = {},
  core: Partial<CoreOptions> = {},
  webDir?: string,
  /** A fake Telegram Bot API to connect Demi-God's gateway to. */
  telegramApiRoot?: string,
  /** Extra parts of the app built on the core (the setup wizard, Hugging Face). */
  extra?: (core: RedGiantCore, dir: string) => Promise<Pick<AppOptions, "setup" | "hf">>,
) {
  const dir = await mkdtemp(join(tmpdir(), "rg-server-"));
  const { db } = await memoryDb();
  const provider = new FakeProvider(script, fake);
  const redgiant = await RedGiantCore.create({
    db,
    providers: new ProviderRegistry().register(provider),
    workspacesDir: join(dir, "workspaces"),
    platformDir: join(dir, "platform"),
    defaultModel: { provider: "fake", model: "m" },
    askAgent: async () => "escalate",
    ...core,
  });
  let gateway: TelegramGateway | undefined;
  if (telegramApiRoot) {
    await migrateTelegram(db);
    gateway = new TelegramGateway({
      token: "123:TEST",
      db,
      host: redgiant,
      apiRoot: telegramApiRoot,
    });
    const g = gateway;
    redgiant.sendFile = (owner, data, name, mime, caption) =>
      g.sendFile(owner, data, name, mime, caption);
    redgiant.notify = (owner, text) => g.notify(owner, text);
  }
  const parts = extra ? await extra(redgiant, dir) : {};
  const running: Running = await serve(
    redgiant,
    new TokenAuth({ [TOKEN]: "me", [OTHER]: "someone-else" }),
    {
      port: 0,
      host: "127.0.0.1",
      loginOwner: "me",
      ...(webDir && { webDir }),
      ...(gateway && { telegram: { gateway, webhookSecret: "webhook-secret-for-tests" } }),
      ...parts,
    },
  );
  const api = async <T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    token = TOKEN,
  ): Promise<{ status: number; body: T }> => {
    const r = await fetch(`${running.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as T };
  };
  return {
    core: redgiant,
    gateway,
    provider,
    url: running.url,
    dir,
    api,
    close: async () => {
      await running.close();
      // Windows releases files a moment after their processes exit.
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/** A WebSocket client that records every message and can wait for one. */
export async function wsClient(url: string, token = TOKEN) {
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws`);
  const messages: ServerMessage[] = [];
  const waiters: { pred: (m: ServerMessage) => boolean; ok: (m: ServerMessage) => void }[] = [];
  let closed: { code: number } | undefined;
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data)) as ServerMessage;
    messages.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.ok(m);
      }
    }
  });
  ws.addEventListener("close", (e) => {
    closed = { code: e.code };
  });
  await new Promise<void>((ok, ko) => {
    ws.addEventListener("open", () => ok(), { once: true });
    ws.addEventListener("error", () => ko(new Error("ws error")), { once: true });
  });
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  const waitFor = <T extends ServerMessage["type"]>(
    type: T,
    pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    timeoutMs = 5000,
  ) =>
    new Promise<Extract<ServerMessage, { type: T }>>((ok, ko) => {
      const test = (m: ServerMessage) =>
        m.type === type && pred(m as Extract<ServerMessage, { type: T }>);
      const already = messages.find(test);
      if (already) return ok(already as Extract<ServerMessage, { type: T }>);
      const timer = setTimeout(() => ko(new Error(`timeout waiting for ${type}`)), timeoutMs);
      waiters.push({
        pred: test,
        ok: (m) => {
          clearTimeout(timer);
          ok(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  send({ type: "hello", protocolVersion: PROTOCOL_VERSION, token });
  return { ws, messages, send, waitFor, closed: () => closed, close: () => ws.close() };
}

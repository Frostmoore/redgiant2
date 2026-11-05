import { EventEmitter } from "node:events";
import type { Button, GatewayHost, Incoming, Transport } from "@redgiant/gateway";
import { describe, expect, it } from "vitest";
import { ChatHub, Outlets } from "../src/chats.js";
import type { RedGiantCore } from "../src/core.js";
import { memoryDb } from "./pglite.js";

class FakeTransport implements Transport {
  readonly buttons = true;
  readonly maxLength = 2000;
  on: ((m: Incoming) => Promise<void>) | undefined;
  sent: { chatId: string; text: string }[] = [];
  stopped = false;
  constructor(readonly platform: "discord" | "slack") {}
  async start(on: (m: Incoming) => Promise<void>) {
    this.on = on;
  }
  async stop() {
    this.stopped = true;
  }
  async send(chatId: string, text: string, _buttons?: Button[]) {
    this.sent.push({ chatId, text });
    return "1";
  }
}

const host: GatewayHost = {
  askDemigod: async (_o, _c, text) => `ok: ${text}`,
  approvals: { on: (e: string, l: () => void) => new EventEmitter().on(e, l), decide: () => true },
};

describe("chat platforms (G29.5)", () => {
  it("starts and stops platforms, and the core's messages reach every linked chat", async () => {
    const { db } = await memoryDb();
    const core = {} as RedGiantCore;
    const outlets = new Outlets(core);
    const told: string[] = [];
    outlets.set("telegram", { notify: async (_o, t) => void told.push(t) });
    const made = new Map<string, FakeTransport>();
    const hub = new ChatHub(db, host, outlets, (p) => {
      const t = new FakeTransport(p as "discord");
      made.set(p, t);
      return t;
    });
    await expect(hub.set("discord", { token: "short" } as never)).rejects.toThrow();
    await hub.set("discord", { token: "x".repeat(30) });
    const discord = made.get("discord") as FakeTransport;
    const bridge = hub.get("discord");
    const { code } = bridge?.pairingCode("me") ?? { code: "" };
    await discord.on?.({ userId: "u1", chatId: "c1", text: `/start ${code}` });
    await discord.on?.({ userId: "u1", chatId: "c1", text: "hello" });
    await bridge?.idle();
    expect(discord.sent.map((m) => m.text).at(-1)).toBe("ok: hello");

    await core.notify?.("me", "Backup done");
    expect(told).toEqual(["Backup done"]);
    expect(discord.sent.at(-1)).toEqual({ chatId: "c1", text: "Backup done" });
    // An automation that names its chats reaches only those (G29.6).
    await core.notify?.("me", "Only Discord", ["discord"]);
    expect(told).toEqual(["Backup done"]);
    expect(discord.sent.at(-1)?.text).toBe("Only Discord");

    // A new token that fails keeps the working connection; one that works replaces it.
    await expect(hub.set("discord", { token: "short" } as never)).rejects.toThrow();
    expect(discord.stopped).toBe(false);
    expect(hub.get("discord")).toBe(bridge);
    await hub.set("discord", { token: "y".repeat(30) });
    expect(discord.stopped).toBe(true);
    const fresh = made.get("discord") as FakeTransport;
    expect(fresh).not.toBe(discord);
    // Each linked chat says whether the message arrived.
    expect(await core.notify?.("me", "Report")).toEqual({
      delivered: ["telegram", "discord"],
      failed: [],
    });

    // Switched off: the platform stops and gets nothing more; Telegram still does.
    await hub.set("discord", null);
    expect(fresh.stopped).toBe(true);
    await core.notify?.("me", "Again");
    expect(told).toEqual(["Backup done", "Report", "Again"]);
    expect(fresh.sent.map((m) => m.text)).toEqual(["Report"]);
    outlets.set("telegram", undefined);
    expect(core.notify).toBeUndefined();
  });
});

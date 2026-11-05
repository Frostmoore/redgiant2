// The chat platforms besides Telegram (G29.5): Discord, Slack, Signal, WhatsApp. One bridge per
// platform the person set up; what the core sends to "the phone" (notifications, pictures,
// files) goes to every linked chat, Telegram included.

import type { SqlClient } from "@redgiant/events";
import {
  ChatBridge,
  DiscordTransport,
  type GatewayHost,
  type Platform,
  SignalTransport,
  SlackTransport,
  type Transport,
  WhatsAppTransport,
} from "@redgiant/gateway";
import { z } from "zod";
import type { RedGiantCore } from "./core.js";

export const PLATFORMS = ["discord", "slack", "signal", "whatsapp"] as const;

/** What each platform needs; the secrets are kept with the other secrets, never in the config. */
export const ChatSettings = {
  discord: z.object({ token: z.string().min(20) }),
  slack: z.object({
    botToken: z.string().startsWith("xoxb-"),
    appToken: z.string().startsWith("xapp-"),
  }),
  signal: z.object({ url: z.url(), number: z.string().regex(/^\+\d{6,15}$/) }),
  whatsapp: z.object({
    token: z.string().min(20),
    phoneNumberId: z.string().regex(/^\d+$/),
    appSecret: z.string().min(8),
    verifyToken: z.string().min(8),
  }),
} as const;
export type ChatSettings = { [P in Platform]?: z.infer<(typeof ChatSettings)[P]> };

export function transportFor<P extends Platform>(
  platform: P,
  s: z.infer<(typeof ChatSettings)[P]>,
): Transport {
  switch (platform) {
    case "discord":
      return new DiscordTransport(s as z.infer<typeof ChatSettings.discord>);
    case "slack":
      return new SlackTransport(s as z.infer<typeof ChatSettings.slack>);
    case "signal":
      return new SignalTransport(s as z.infer<typeof ChatSettings.signal>);
    default:
      return new WhatsAppTransport(s as z.infer<typeof ChatSettings.whatsapp>);
  }
}

/** Where the core's messages for the person go out. */
export interface Outlet {
  notify(ownerId: string, text: string): Promise<void>;
  sendPhoto?(ownerId: string, png: Buffer, caption: string): Promise<void>;
  sendFile?(
    ownerId: string,
    data: Buffer,
    name: string,
    mime: string,
    caption?: string,
  ): Promise<void>;
}

/** Every chat the person reads: the core's notify/sendPhoto/sendFile reach them all. */
export class Outlets {
  private readonly all = new Map<string, Outlet>();

  constructor(private readonly core: RedGiantCore) {}

  set(name: string, outlet: Outlet | undefined): void {
    if (outlet) this.all.set(name, outlet);
    else this.all.delete(name);
    const list = () => [...this.all.values()];
    if (this.all.size === 0) {
      this.core.notify = undefined;
      this.core.sendPhoto = undefined;
      this.core.sendFile = undefined;
      return;
    }
    // One platform failing does not keep the message from the others.
    this.core.notify = async (owner, text, to) => {
      const chosen = [...this.all].filter(([name]) => !to || to.includes(name));
      const results = await Promise.allSettled(chosen.map(([, o]) => o.notify(owner, text)));
      return {
        delivered: chosen.filter((_, i) => results[i]?.status === "fulfilled").map(([n]) => n),
        failed: chosen.flatMap(([n], i) => {
          const r = results[i];
          return r?.status === "rejected"
            ? [{ to: n, reason: r.reason instanceof Error ? r.reason.message : String(r.reason) }]
            : [];
        }),
      };
    };
    this.core.sendPhoto = async (owner, png, caption) => {
      await Promise.allSettled(
        list().map((o) =>
          o.sendPhoto
            ? o.sendPhoto(owner, png, caption)
            : o.sendFile?.(owner, png, "image.png", "image/png", caption),
        ),
      );
    };
    this.core.sendFile = async (owner, data, name, mime, caption) => {
      await Promise.allSettled(list().map((o) => o.sendFile?.(owner, data, name, mime, caption)));
    };
  }
}

/** The bridges running now, one per platform set up. */
export class ChatHub {
  readonly bridges = new Map<Platform, ChatBridge>();

  constructor(
    private readonly db: SqlClient,
    private readonly host: GatewayHost,
    private readonly outlets: Outlets,
    /** Tests give a fake platform here. */
    private readonly make: (platform: Platform, settings: never) => Transport = transportFor,
  ) {}

  /** Starts (or stops, with null) a platform; a wrong token fails here, before it is kept. */
  async set<P extends Platform>(
    platform: P,
    settings: z.infer<(typeof ChatSettings)[P]> | null,
  ): Promise<void> {
    const old = this.bridges.get(platform);
    if (old) {
      this.bridges.delete(platform);
      this.outlets.set(platform, undefined);
      await old.stop().catch(() => {});
    }
    if (!settings) return;
    const bridge = new ChatBridge({
      db: this.db,
      host: this.host,
      transport: this.make(platform, ChatSettings[platform].parse(settings) as never),
    });
    await bridge.start();
    this.bridges.set(platform, bridge);
    this.outlets.set(platform, {
      notify: (o, t) => bridge.notify(o, t),
      sendFile: (o, d, n, m, c) => bridge.sendFile(o, d, n, m, c),
    });
  }

  get(platform: Platform): ChatBridge | undefined {
    return this.bridges.get(platform);
  }

  /** WhatsApp's webhook: messages arrive here, not by a connection RedGiant opens. */
  whatsapp(): WhatsAppTransport | undefined {
    const b = this.bridges.get("whatsapp");
    return b ? (b.transport as WhatsAppTransport) : undefined;
  }

  async stop(): Promise<void> {
    for (const p of [...this.bridges.keys()]) await this.set(p, null);
  }
}

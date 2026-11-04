import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve as nodeServe } from "@hono/node-server";
import { type AppOptions, createApp } from "./app.js";
import { type AuthProvider, ChainAuth } from "./auth.js";
import type { RedGiantCore } from "./core.js";
import { attachWebSocket } from "./ws.js";

export interface Running {
  url: string;
  close(): Promise<void>;
}

/** Starts HTTP + WebSocket on one port. */
export function serve(
  core: RedGiantCore,
  auth: AuthProvider,
  listen: {
    port: number;
    host?: string;
    webDir?: string;
    telegram?: AppOptions["telegram"];
    chats?: AppOptions["chats"];
    setup?: AppOptions["setup"];
    hf?: AppOptions["hf"];
    winHf?: AppOptions["winHf"];
    loginOwner?: string;
  },
): Promise<Running> {
  // Password sessions sign in with their own tokens, next to the installation's.
  const full = new ChainAuth([auth, core.logins]);
  const app = createApp(core, full, {
    ...(listen.webDir && { webDir: listen.webDir }),
    ...(listen.telegram && { telegram: listen.telegram }),
    ...(listen.chats && { chats: listen.chats }),
    ...(listen.setup && { setup: listen.setup }),
    ...(listen.hf && { hf: listen.hf }),
    ...(listen.winHf && { winHf: listen.winHf }),
    ...(listen.loginOwner && { loginOwner: listen.loginOwner }),
  });
  return new Promise((ok) => {
    const server = nodeServe(
      { fetch: app.fetch, port: listen.port, hostname: listen.host ?? "0.0.0.0" },
      (info: AddressInfo) => {
        const wss = attachWebSocket(server as unknown as Server, core, full);
        const host = listen.host && listen.host !== "0.0.0.0" ? listen.host : "127.0.0.1";
        ok({
          url: `http://${host}:${info.port}`,
          close: async () => {
            await core.close();
            for (const c of wss.clients) c.terminate();
            wss.close();
            await new Promise<void>((done) => server.close(() => done()));
          },
        });
      },
    );
  });
}

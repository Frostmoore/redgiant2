import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve as nodeServe } from "@hono/node-server";
import { type AppOptions, createApp } from "./app.js";
import { type AuthProvider, ChainAuth } from "./auth.js";
import type { RedGiantCore } from "./core.js";
import { installedVersion } from "./updates.js";
import { attachWebSocket, OpenPages } from "./ws.js";

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
    firstAccessFrom?: AppOptions["firstAccessFrom"];
    /** The version pages are told (default the installed one, null from the source). */
    version?: string | null;
  },
): Promise<Running> {
  const pages = new OpenPages();
  const version = listen.version !== undefined ? listen.version : installedVersion();
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
    ...(listen.firstAccessFrom && { firstAccessFrom: listen.firstAccessFrom }),
    pages,
  });
  return new Promise((ok) => {
    const server = nodeServe(
      { fetch: app.fetch, port: listen.port, hostname: listen.host ?? "0.0.0.0" },
      (info: AddressInfo) => {
        const wss = attachWebSocket(server as unknown as Server, core, full, { pages, version });
        const host = listen.host && listen.host !== "0.0.0.0" ? listen.host : "127.0.0.1";
        ok({
          url: `http://${host}:${info.port}`,
          close: async () => {
            await core.close();
            for (const c of wss.clients) c.terminate();
            wss.close();
            // Every connection cut at once (2026-11-05): an open page kept one, the stop waited for
            // it past RedGiant.exe's 30 s, the server was killed and Postgres was left running.
            const http = server as unknown as Server;
            const closed = new Promise<void>((done) => http.close(() => done()));
            http.closeAllConnections();
            await closed;
          },
        });
      },
    );
  });
}

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve as nodeServe } from "@hono/node-server";
import { type AppOptions, createApp } from "./app.js";
import type { AuthProvider } from "./auth.js";
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
    setup?: AppOptions["setup"];
    hf?: AppOptions["hf"];
  },
): Promise<Running> {
  const app = createApp(core, auth, {
    ...(listen.webDir && { webDir: listen.webDir }),
    ...(listen.telegram && { telegram: listen.telegram }),
    ...(listen.setup && { setup: listen.setup }),
    ...(listen.hf && { hf: listen.hf }),
  });
  return new Promise((ok) => {
    const server = nodeServe(
      { fetch: app.fetch, port: listen.port, hostname: listen.host ?? "0.0.0.0" },
      (info: AddressInfo) => {
        const wss = attachWebSocket(server as unknown as Server, core, auth);
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

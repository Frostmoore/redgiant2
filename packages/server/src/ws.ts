import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { ClientMessage, PROTOCOL_VERSION, type ServerMessage } from "@redgiant/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import type { AuthProvider, Principal } from "./auth.js";
import type { RedGiantCore } from "./core.js";

/**
 * Live channel at `/ws`. The first message must be `hello` with a token; then the client
 * follows sessions (history, then live), sends messages, and answers permission requests.
 * Sessions never depend on a connection: closing it only stops the following.
 */
export function attachWebSocket(
  server: Server,
  core: RedGiantCore,
  auth: AuthProvider,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => connection(ws));
  });

  function connection(ws: WebSocket) {
    let principal: Principal | null = null;
    const follows = new Map<string, () => void>();
    const send = (m: ServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    const fail = (code: string, message: string) => send({ type: "error", code, message });

    const onRequest = (
      ownerId: string,
      info: Parameters<Parameters<typeof core.approvals.on<"request">>[1]>[1],
    ) => {
      if (principal?.ownerId === ownerId) send({ type: "permission.request", request: info });
    };
    const onClosed = (ownerId: string, requestId: string, decision: "allow" | "deny") => {
      if (principal?.ownerId === ownerId) send({ type: "permission.closed", requestId, decision });
    };
    const helloTimer = setTimeout(() => ws.close(4001, "hello expected"), 10_000);

    // Messages of one connection are handled strictly in order (a client may send `hello`
    // and `session.follow` back to back without waiting).
    let queue: Promise<void> = Promise.resolve();
    ws.on("message", (raw) => {
      queue = queue
        .then(async () => {
          await handle(raw);
        })
        .catch(() => {});
    });

    const handle = async (raw: import("ws").RawData) => {
      let msg: ClientMessage;
      try {
        msg = ClientMessage.parse(JSON.parse(raw.toString()));
      } catch {
        return fail("bad_message", "Invalid message");
      }
      try {
        if (!principal) {
          if (msg.type !== "hello") return ws.close(4001, "hello expected");
          if (msg.protocolVersion !== PROTOCOL_VERSION) {
            fail(
              "protocol",
              `Protocol ${msg.protocolVersion} not supported (server: ${PROTOCOL_VERSION})`,
            );
            return ws.close(4002, "protocol");
          }
          principal = await auth.authenticate(msg.token);
          if (!principal) return ws.close(4003, "unauthorized");
          clearTimeout(helloTimer);
          core.approvals.on("request", onRequest);
          core.approvals.on("closed", onClosed);
          send({ type: "welcome", protocolVersion: PROTOCOL_VERSION, ownerId: principal.ownerId });
          for (const r of core.approvals.list(principal.ownerId))
            send({ type: "permission.request", request: r });
          return;
        }
        const owner = principal.ownerId;
        switch (msg.type) {
          case "hello":
            return fail("bad_message", "Already authenticated");
          case "session.follow":
            if (!follows.has(msg.sessionId))
              follows.set(msg.sessionId, await core.follow(owner, msg.sessionId, send));
            return;
          case "session.unfollow":
            follows.get(msg.sessionId)?.();
            follows.delete(msg.sessionId);
            return;
          case "session.send": {
            const { done } = await core.send(owner, msg.sessionId, msg.text);
            done.catch((err) => fail("session_failed", String(err)));
            return;
          }
          case "session.interrupt":
            await core.interrupt(owner, msg.sessionId);
            return;
          case "permission.resolve":
            if (!core.approvals.decide(owner, msg.requestId, msg.decision))
              fail("not_found", "No such pending request");
            return;
        }
      } catch (err) {
        fail("error", (err as Error).message);
      }
    };

    ws.on("close", () => {
      clearTimeout(helloTimer);
      for (const off of follows.values()) off();
      core.approvals.off("request", onRequest);
      core.approvals.off("closed", onClosed);
    });
  }
  return wss;
}

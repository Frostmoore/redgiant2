import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  ClientMessage,
  PROTOCOL_VERSION,
  type QuestionRequestInfo,
  type ServerMessage,
} from "@redgiant/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import type { AuthProvider, Principal } from "./auth.js";
import type { RedGiantCore } from "./core.js";
import { handleTerminal } from "./terminal.js";

/**
 * Live channel at `/ws`. The first message must be `hello` with a token; then the client
 * follows sessions (history, then live), sends messages, and answers permission requests.
 * Sessions never depend on a connection: closing it only stops the following.
 */
/** The code an error carries for the UI (`no_model`…), when it has one. */
const codeOf = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && /^[a-z_]+$/.test(code) ? code : undefined;
};

export function attachWebSocket(
  server: Server,
  core: RedGiantCore,
  auth: AuthProvider,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/ws") return wss.handleUpgrade(req, socket, head, (ws) => connection(ws));
    if (path === "/term")
      return wss.handleUpgrade(req, socket, head, (ws) => handleTerminal(ws, core, auth));
    socket.destroy();
  });

  function connection(ws: WebSocket) {
    let principal: Principal | null = null;
    let offBoard: (() => void) | undefined;
    let offAutomations: (() => void) | undefined;
    let offPlatform: (() => void) | undefined;
    let offRooms: (() => void) | undefined;
    let offScreen: (() => void) | undefined;
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
    const onQuestion = (ownerId: string, request: QuestionRequestInfo) => {
      if (principal?.ownerId === ownerId) send({ type: "question.request", request });
    };
    const onQuestionClosed = (ownerId: string, requestId: string) => {
      if (principal?.ownerId === ownerId) send({ type: "question.closed", requestId });
    };
    const onBoard = (ownerId: string, projectId: string | null, threadId: string) => {
      if (principal?.ownerId === ownerId) send({ type: "board.changed", projectId, threadId });
    };
    const onAutomation = (ownerId: string, automationId: string) => {
      if (principal?.ownerId === ownerId) send({ type: "automations.changed", automationId });
    };
    const onRoom = (ownerId: string, roomId: string) => {
      if (principal?.ownerId === ownerId) send({ type: "room.changed", roomId });
    };
    const onPlatform = (ownerId: string, changeId: string) => {
      if (principal?.ownerId === ownerId) send({ type: "platform.changed", changeId });
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
          core.questions.on("request", onQuestion);
          core.questions.on("closed", onQuestionClosed);
          offBoard = core.board.onChange(onBoard);
          offAutomations = core.automations.onChange(onAutomation);
          offPlatform = core.changes.onChange(onPlatform);
          offRooms = core.rooms.onChange(onRoom);
          send({ type: "welcome", protocolVersion: PROTOCOL_VERSION, ownerId: principal.ownerId });
          for (const r of core.approvals.list(principal.ownerId))
            send({ type: "permission.request", request: r });
          for (const q of core.questions.list(principal.ownerId))
            send({ type: "question.request", request: q });
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
            const { done } = await core.send(owner, msg.sessionId, msg.text, {
              ...(msg.images?.length ? { images: msg.images } : {}),
              watch: true,
              // Written while it works: it joins the turn after its tools (2026-11-05), or right after.
              queue: true,
              steer: true,
              ...(msg.clientId && { clientId: msg.clientId }),
            });
            done.catch((err) => fail(codeOf(err) ?? "session_failed", String(err)));
            return;
          }
          case "session.unqueue":
            await core.unqueue(owner, msg.sessionId, msg.clientId);
            return;
          case "question.answer":
            if (!core.questions.answer(owner, msg.requestId, msg.answers))
              return fail("not_found", "No such open question");
            return;
          // The agents' browser (G24.14b): watching, control, the person's input (never logged).
          case "browser.watch": {
            if (!core.browsers) return fail("unavailable", "The agents' browser needs Docker");
            if (offScreen) return;
            const b = core.browsers.get(owner);
            offScreen = await b.watch((e) =>
              e.type === "frame"
                ? send({ type: "browser.frame", ...e.frame })
                : send({
                    type: "browser.state",
                    control: e.control,
                    url: e.url,
                    ...(e.teaching && { teaching: e.teaching }),
                  }),
            );
            return;
          }
          case "browser.unwatch":
            offScreen?.();
            offScreen = undefined;
            return;
          case "browser.control":
            core.browsers?.get(owner).setControl(msg.take ? "person" : "agents");
            return;
          case "browser.teach":
            if (msg.start) core.teachStart(owner, msg.agentId);
            else await core.teachStop(owner, msg.title);
            return;
          case "browser.goto":
            await core.browsers?.get(owner).goto(msg.url);
            return;
          case "browser.input":
            await core.browsers?.get(owner).input(msg.event);
            return;
          case "session.interrupt":
            await core.interrupt(owner, msg.sessionId);
            return;
          case "permission.resolve": {
            const pending = core.approvals.list(owner).find((r) => r.requestId === msg.requestId);
            if (!core.approvals.decide(owner, msg.requestId, msg.decision, msg.reason))
              return fail("not_found", "No such pending request");
            // For this conversation only (2026-11-05): never for a danger, which asks every time.
            if (
              msg.scope === "session" &&
              msg.decision === "allow" &&
              pending?.sessionId &&
              pending.danger.length === 0
            )
              core.broker.allowForSession(pending.sessionId, pending.tool);
            // "Always": an allow rule for that tool, recorded and undoable like any platform change.
            // Never for dangerous calls: those ask every time.
            if (
              (msg.remember || msg.scope === "always") &&
              msg.decision === "allow" &&
              pending &&
              pending.danger.length === 0
            ) {
              const policy = core.policies.get(owner);
              if (
                !policy.rules.some(
                  (r) => r.tool === pending.tool && !r.match && r.decision === "allow",
                )
              )
                await core.config.setPolicy(owner, "human", {
                  ...policy,
                  rules: [...policy.rules, { tool: pending.tool, decision: "allow" }],
                });
            }
            return;
          }
        }
      } catch (err) {
        fail(codeOf(err) ?? "error", (err as Error).message);
      }
    };

    ws.on("close", () => {
      clearTimeout(helloTimer);
      for (const off of follows.values()) off();
      core.approvals.off("request", onRequest);
      core.approvals.off("closed", onClosed);
      core.questions.off("request", onQuestion);
      core.questions.off("closed", onQuestionClosed);
      offBoard?.();
      offAutomations?.();
      offPlatform?.();
      offRooms?.();
      offScreen?.();
    });
  }
  return wss;
}

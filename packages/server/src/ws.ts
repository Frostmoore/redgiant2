import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  ARTIFACT_GRANT_TOOL,
  ClientMessage,
  DocFile,
  docKey,
  PERSON,
  PROTOCOL_VERSION,
  type QuestionRequestInfo,
  type ServerMessage,
} from "@redgiant/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { BridgeFailure } from "./artifact-bridge.js";
import type { AuthProvider, Principal } from "./auth.js";
import type { RedGiantCore } from "./core.js";
import type { Outcome } from "./editor/host.js";
import { handleTerminal } from "./terminal.js";

/**
 * Live channel at `/ws`. The first message must be `hello` with a token; then the client
 * follows sessions (history, then live), sends messages, and answers permission requests.
 * Sessions never depend on a connection: closing it only stops the following.
 */
/** The code an error carries for the UI (`no_model`…), when it has one. */
/** An error's values for the page's words (a stalled provider: minutes and tries). */
const paramsOf = (err: unknown): Record<string, string> | undefined => {
  const p = (err as { params?: unknown } | null)?.params;
  return p && typeof p === "object" ? (p as Record<string, string>) : undefined;
};
/** The page's heartbeat, exactly as `Live` sends it (p3.5.4). */
const PING = JSON.stringify({ type: "ping" });

const codeOf = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && /^[a-z_]+$/.test(code) ? code : undefined;
};

/**
 * The pages connected now that reload by themselves on a new version (3.5.3), per owner. After an
 * update the launcher asks for this (`GET /api/pages`): when a page came back it opens no other.
 */
export class OpenPages {
  private readonly byOwner = new Map<string, number>();

  /** One more page of `ownerId`; the function returned takes it away (once). */
  add(ownerId: string): () => void {
    this.byOwner.set(ownerId, this.count(ownerId) + 1);
    let gone = false;
    return () => {
      if (gone) return;
      gone = true;
      const n = this.count(ownerId) - 1;
      if (n > 0) this.byOwner.set(ownerId, n);
      else this.byOwner.delete(ownerId);
    };
  }

  count(ownerId: string): number {
    return this.byOwner.get(ownerId) ?? 0;
  }
}

export function attachWebSocket(
  server: Server,
  core: RedGiantCore,
  auth: AuthProvider,
  live: { pages?: OpenPages; version?: string | null } = {},
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/ws") return wss.handleUpgrade(req, socket, head, (ws) => connection(ws));
    // Another RedGiant (G39.4): its own handshake authenticates it (pinned keys), no token.
    if (path === "/nodes")
      return wss.handleUpgrade(req, socket, head, (ws) => void core.nodes.accept(ws));
    if (path === "/term")
      return wss.handleUpgrade(req, socket, head, (ws) => handleTerminal(ws, core, auth));
    socket.destroy();
  });

  function connection(ws: WebSocket) {
    let principal: Principal | null = null;
    let offBoard: (() => void) | undefined;
    let offAutomations: (() => void) | undefined;
    let offNotices: (() => void) | undefined;
    let offPlatform: (() => void) | undefined;
    let offRooms: (() => void) | undefined;
    let offCanvas: (() => void) | undefined;
    let offActivity: (() => void) | undefined;
    let offScreen: (() => void) | undefined;
    let offPage: (() => void) | undefined;
    const follows = new Map<string, () => void>();
    /** Conversations an editor on this connection shows with its files (G38.6). */
    const editorLinks = new Map<string, () => void>();
    // Files open in the editor (G37.1): this page's subscriber id for each.
    const docs = new Map<string, { file: DocFile; subId: string }>();
    const docSub = (file: DocFile) => docs.get(docKey(file));
    const send = (m: ServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    const fail = (code: string, message: string, params?: Record<string, string>) =>
      send({ type: "error", code, message, ...(params && { params }) });

    const onRequest = (
      ownerId: string,
      info: Parameters<Parameters<typeof core.approvals.on<"request">>[1]>[1],
    ) => {
      // A request asked of the person reaches every channel (G36.17), this page included.
      if (principal?.ownerId === ownerId) send({ type: "permission.request", request: info });
    };
    const onClosed = (
      ownerId: string,
      requestId: string,
      decision: "allow" | "deny",
      via: string | undefined,
    ) => {
      if (principal?.ownerId === ownerId)
        send({ type: "permission.closed", requestId, decision, ...(via && { via }) });
    };
    const onQuestion = (ownerId: string, request: QuestionRequestInfo) => {
      if (principal?.ownerId === ownerId) send({ type: "question.request", request });
    };
    const onQuestionClosed = (ownerId: string, requestId: string, via: string | undefined) => {
      if (principal?.ownerId === ownerId)
        send({ type: "question.closed", requestId, ...(via && { via }) });
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
    // An open file's messages (G37.1) keep their own order, one line per file (p3.5.4): the editor
    // may take seconds (a PDF read again, an agent's edit of the same file before them), and
    // behind them the page's follows and its canvas answers waited too. The chat stopped moving
    // and canvas_look found «no canvas» while the person looked at page 2 of a PDF.
    const docLines = new Map<string, Promise<void>>();
    ws.on("message", (raw) => {
      // The page's heartbeat (p3.5.4) is answered at once, never behind a slow message.
      if (principal && raw.toString() === PING) {
        send({ type: "pong" });
        return;
      }
      const lane = principal ? laneOf(raw) : undefined;
      // The canvas's answer to an agent waiting for it (G36.12): at once, it depends on nothing.
      if (lane === "now") {
        void handle(raw).catch(() => {});
        return;
      }
      if (lane) {
        const line = (docLines.get(lane) ?? Promise.resolve())
          .then(async () => {
            await handle(raw);
          })
          .catch(() => {});
        docLines.set(lane, line);
        void line.then(() => {
          if (docLines.get(lane) === line) docLines.delete(lane);
        });
        return;
      }
      queue = queue
        .then(async () => {
          await handle(raw);
        })
        .catch(() => {});
    });

    /** Where a message waits: an open file's own line, "now", or the connection's (undefined). */
    const laneOf = (raw: import("ws").RawData): string | undefined => {
      let m: { type?: unknown; file?: unknown };
      try {
        m = JSON.parse(raw.toString()) as typeof m;
      } catch {
        return undefined;
      }
      if (m?.type === "canvas.state") return "now";
      if (typeof m?.type !== "string" || !m.type.startsWith("doc.")) return undefined;
      const file = DocFile.safeParse(m.file);
      return file.success ? `doc\u0000${docKey(file.data)}` : undefined;
    };

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
          offNotices = core.onNotice((ownerId, text, info) => {
            if (principal?.ownerId !== ownerId || ws.readyState !== ws.OPEN) return false;
            send({ type: "automation.notice", ...info, text });
            return true;
          });
          offPlatform = core.changes.onChange(onPlatform);
          offRooms = core.rooms.onChange(onRoom);
          // The canvas is asked for only when an agent looks (G36.12). A page (not the CLI nor a
          // gateway) is named: a question waiting reaches it when it comes back (p3.5.6).
          offCanvas = core.canvasLive.onQuery(
            (ownerId, requestId) => {
              if (principal?.ownerId !== ownerId || ws.readyState !== ws.OPEN) return false;
              send({ type: "canvas.query", requestId });
              return true;
            },
            msg.reloads ? principal.ownerId : undefined,
          );
          if (msg.reloads && live.pages) offPage = live.pages.add(principal.ownerId);
          // All the owner's conversations, followed or not (p3.5.3): a followed one already
          // brings its canvas events, so only the others' are sent here.
          offActivity = core.onOwnerActivity((ownerId, m) => {
            if (principal?.ownerId !== ownerId) return;
            if (m.type === "canvas.open" && follows.has(m.sessionId)) return;
            send(m);
          });
          send({
            type: "welcome",
            protocolVersion: PROTOCOL_VERSION,
            ownerId: principal.ownerId,
            ...(live.version !== undefined && { version: live.version }),
          });
          for (const r of core.approvals.list(principal.ownerId))
            send({ type: "permission.request", request: r });
          for (const q of core.questions.list(principal.ownerId))
            send({ type: "question.request", request: q });
          return;
        }
        const owner = principal.ownerId;
        // An archived project's files are read only (2026-11-09): edits to them are refused.
        if (
          (msg.type === "doc.ops" ||
            msg.type === "doc.undo" ||
            msg.type === "doc.save" ||
            msg.type === "doc.decide") &&
          core.readOnlyScope(owner, msg.file.scope)
        ) {
          const reason = "The project is archived: restore it to change its files";
          if (msg.type === "doc.ops" || msg.type === "doc.undo")
            return send({
              type: "doc.rejected",
              file: msg.file,
              clientId: msg.clientId,
              code: "archived",
              reason,
              revision: (await core.editor.read(owner, msg.file)).revision,
            });
          return fail("project_archived", reason);
        }
        switch (msg.type) {
          case "hello":
            return fail("bad_message", "Already authenticated");
          case "session.follow":
            if (!follows.has(msg.sessionId))
              follows.set(
                msg.sessionId,
                await core.follow(owner, msg.sessionId, send, msg.afterSeq, {
                  history: msg.history === true,
                }),
              );
            return;
          case "ping":
            return send({ type: "pong" });
          case "session.unfollow":
            follows.get(msg.sessionId)?.();
            follows.delete(msg.sessionId);
            return;
          case "session.send": {
            const { done } = await core.send(owner, msg.sessionId, msg.text, {
              ...(msg.images?.length ? { images: msg.images } : {}),
              ...(msg.quotes?.length ? { quotes: msg.quotes } : {}),
              ...(msg.via && { via: msg.via }),
              watch: true,
              // Written while it works: it joins the turn after its tools (2026-11-05), or right after.
              queue: true,
              steer: true,
              ...(msg.clientId && { clientId: msg.clientId }),
            });
            done.catch((err) => fail(codeOf(err) ?? "session_failed", String(err), paramsOf(err)));
            return;
          }
          case "session.unqueue":
            await core.unqueue(owner, msg.sessionId, msg.clientId);
            return;
          case "question.answer":
            if (!core.questions.answer(owner, msg.requestId, msg.answers, "web"))
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
          case "artifact.errors":
            await core
              .reportArtifactErrors(owner, msg.ref, msg.errors, msg.sessionId)
              .catch(() => {});
            return;
          // The artifacts' bridge (3.6, G38.7): answered when done, never awaited here (a question
          // to the model must not hold this connection's other messages).
          case "artifact.bridge": {
            const { requestId } = msg;
            void core.artifactBridge.handle(owner, msg.ref, msg.call, msg.sessionId).then(
              (result) => send({ type: "artifact.bridge.result", requestId, result }),
              (err: unknown) =>
                send({
                  type: "artifact.bridge.result",
                  requestId,
                  error:
                    err instanceof BridgeFailure
                      ? { code: err.code, message: err.message.slice(0, 2000) }
                      : { code: "failed", message: "The bridge call failed" },
                }),
            );
            return;
          }
          case "canvas.state":
            core.canvasLive.answer(owner, msg.requestId, msg.state);
            return;
          // The editor (G37.1). The host orders each file's revisions; this connection's own
          // messages are handled in order, so an ack never passes the changes before it.
          case "doc.open": {
            const key = docKey(msg.file);
            const was = docs.get(key);
            if (was) await core.editor.unsubscribe(owner, msg.file, was.subId);
            const subId = randomUUID();
            docs.set(key, { file: msg.file, subId });
            try {
              await core.editor.subscribe(owner, msg.file, { id: subId, send });
            } catch (err) {
              docs.delete(key);
              // The page says it in the tab (too big, not UTF-8 text…), not only in the header.
              return send({
                type: "doc.rejected",
                file: msg.file,
                clientId: "open",
                code: "invalid",
                reason: (err as Error).message,
                revision: 0,
              });
            }
            return;
          }
          case "doc.close": {
            const d = docSub(msg.file);
            if (!d) return;
            docs.delete(docKey(msg.file));
            await core.editor.unsubscribe(owner, msg.file, d.subId);
            return;
          }
          case "doc.save": {
            // Only a file this page opened (the host checked the person may edit it then).
            if (!docSub(msg.file)) return fail("doc_closed", "Open the file first");
            await core.editor.save(owner, msg.file);
            return;
          }
          case "doc.ops": {
            // Never only an error in the header (p3.5.7, the person's test of 3.5.6): the page's
            // batch would wait for its answer for ever and nothing typed after it would leave.
            // Refused, the page reads the file again.
            const d = docSub(msg.file);
            if (!d)
              return send({
                type: "doc.rejected",
                file: msg.file,
                clientId: msg.clientId,
                code: "closed",
                reason: "The file is not open on this connection: open it again",
                revision: 0,
              });
            const out = await core.editor
              .apply(owner, msg.file, {
                author: { id: PERSON },
                baseRevision: msg.baseRevision,
                ops: msg.ops,
                groupId: msg.groupId,
                origin: { subId: d.subId, clientId: msg.clientId },
              })
              .catch(
                (err: unknown): Outcome => ({
                  ok: false,
                  code: "failed",
                  reason:
                    `The change could not be applied: ${(err as Error)?.message ?? err}`.slice(
                      0,
                      2000,
                    ),
                  revision: 0,
                }),
              );
            if (!out.ok)
              send({
                type: "doc.rejected",
                file: msg.file,
                clientId: msg.clientId,
                code: out.code,
                reason: out.reason,
                revision: out.revision,
                ...(out.conflict !== undefined && { conflict: out.conflict }),
              });
            return;
          }
          case "doc.undo": {
            const out = await core.editor
              .undo(
                owner,
                msg.file,
                {
                  ...(msg.revision !== undefined && { revision: msg.revision }),
                  ...(msg.toBefore && { toBefore: true }),
                  ...(msg.groupId && { groupId: msg.groupId }),
                },
                { id: PERSON },
              )
              .catch(
                (err: unknown): Outcome => ({
                  ok: false,
                  code: "failed",
                  reason: `The undo could not be applied: ${(err as Error)?.message ?? err}`.slice(
                    0,
                    2000,
                  ),
                  revision: 0,
                }),
              );
            send(
              out.ok
                ? {
                    type: "doc.ack",
                    file: msg.file,
                    clientId: msg.clientId,
                    revision: out.revision,
                  }
                : {
                    type: "doc.rejected",
                    file: msg.file,
                    clientId: msg.clientId,
                    code: out.code,
                    reason: out.reason,
                    revision: out.revision,
                    ...(out.conflict !== undefined && { conflict: out.conflict }),
                  },
            );
            return;
          }
          case "doc.presence": {
            const d = docSub(msg.file);
            if (d)
              await core.editor.presence(owner, msg.file, d.subId, {
                editing: msg.editing,
                from: msg.from,
                to: msg.to,
              });
            return;
          }
          case "doc.decide": {
            const out = await core.editor.decide(owner, msg.file, msg.proposalId, msg.accept);
            send(
              out.ok
                ? {
                    type: "doc.ack",
                    file: msg.file,
                    clientId: msg.clientId,
                    revision: out.revision,
                  }
                : {
                    type: "doc.rejected",
                    file: msg.file,
                    clientId: msg.clientId,
                    code: out.code,
                    reason: out.reason,
                    revision: out.revision,
                    ...(out.conflict !== undefined && { conflict: out.conflict }),
                  },
            );
            return;
          }
          case "session.interrupt":
            await core.interrupt(owner, msg.sessionId);
            return;
          case "editor.attach": {
            if (!(await core.ownsSession(owner, msg.sessionId)))
              return fail("not_found", "No such conversation");
            editorLinks.get(msg.sessionId)?.();
            editorLinks.set(
              msg.sessionId,
              await core.editorLinks.attach(owner, msg.sessionId, msg.root, send),
            );
            return;
          }
          case "editor.detach":
            editorLinks.get(msg.sessionId)?.();
            editorLinks.delete(msg.sessionId);
            return;
          case "editor.fs.reply":
            core.editorLinks.reply(msg);
            return;
          case "command.stop":
            await core.stopCommand(owner, msg.sessionId, msg.id);
            return;
          case "command.close":
            await core.closeCommand(owner, msg.sessionId, msg.id);
            return;
          case "subagent.close":
            await core.closeSubagent(owner, msg.sessionId, msg.childSessionId);
            return;
          case "permission.resolve": {
            const pending = core.approvals.list(owner).find((r) => r.requestId === msg.requestId);
            // A switched-off tool asked back (G36.15): "always" is for that agent, never a rule.
            // An artifact's capability (3.6, G38.7): the person's yes, with the cap they chose;
            // never a rule, never «this conversation».
            if (pending?.tool === ARTIFACT_GRANT_TOOL) {
              if (msg.decision === "allow")
                core.artifactBridge.chooseCap(msg.requestId, msg.capUsd);
              if (!core.approvals.decide(owner, msg.requestId, msg.decision, msg.reason, "web"))
                return fail("not_found", "No such pending request");
              return;
            }
            const toolRequest = pending?.tool === "request_tool";
            if (toolRequest)
              core.toolRequestScope(msg.requestId, msg.remember ? "always" : msg.scope);
            if (
              !core.approvals.decide(
                owner,
                msg.requestId,
                msg.decision,
                msg.reason,
                msg.via ?? "web",
              )
            )
              return fail("not_found", "No such pending request");
            if (toolRequest) return;
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
      for (const off of editorLinks.values()) off();
      const owner = principal?.ownerId;
      if (owner)
        for (const d of docs.values())
          void core.editor.unsubscribe(owner, d.file, d.subId).catch(() => {});
      core.approvals.off("request", onRequest);
      core.approvals.off("closed", onClosed);
      core.questions.off("request", onQuestion);
      core.questions.off("closed", onQuestionClosed);
      offBoard?.();
      offAutomations?.();
      offNotices?.();
      offPlatform?.();
      offRooms?.();
      offCanvas?.();
      offActivity?.();
      offScreen?.();
      offPage?.();
    });
  }
  return wss;
}

import { realpath as fsRealpath } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ClientMessage,
  Event,
  PermissionRequestInfo,
  ServerMessage,
} from "@redgiant/protocol";
import {
  acpStopReason,
  promptImages,
  promptText,
  toolKind,
  toolLocations,
  toolTitle,
} from "./map.js";

/** The running RedGiant, as the command line reaches it (`RedGiantClient`). */
export interface RedGiantLink {
  api<T>(method: string, path: string, body?: unknown): Promise<T>;
  live(
    onMessage: (m: ServerMessage) => void,
    onClose?: () => void,
  ): Promise<{ send: (m: ClientMessage) => void; close: () => void }>;
}

export interface BridgeOptions {
  link: RedGiantLink;
  /** The agent to talk to (`--agent`, `REDGIANT_ACP_AGENT`): otherwise chosen per session. */
  agentId?: string | undefined;
  version?: string | undefined;
  log?: ((line: string) => void) | undefined;
  /** How folders are compared (tests give their own). */
  realpath?: ((p: string) => Promise<string>) | undefined;
}

interface AgentRow {
  id: string;
  kind: string;
  name: string;
  projectId: string | null;
  status: string;
}

interface Turn {
  done: (r: acp.PromptResponse) => void;
  fail: (err: Error) => void;
  sawRunning: boolean;
  cancelled: boolean;
  /** Text came as deltas since the last assistant message (else the message's text is sent). */
  streamed: boolean;
}

interface Bridged {
  /** The id the editor knows. */
  acpId: string;
  /** The RedGiant conversation behind it (another one once «@name» chose another agent). */
  rgSession: string;
  agent: AgentRow;
  cwd: string;
  /** Its folder is the agent's project's: the agent's file tools go through the editor. */
  editorFiles: boolean;
  /** Sub-agents' conversations started from it: their permission requests come here too. */
  children: Set<string>;
  synced: boolean;
  /** The replay wanted by `session/load`, settled once the history came. */
  replay?: ((events: Event[]) => Promise<void>) | undefined;
  turn?: Turn | undefined;
  /** A permission request being asked in the editor, by request id. */
  asking: Map<string, AbortController>;
  /** Chosen with «@name» in the first prompt: nothing was said yet. */
  fresh: boolean;
}

/**
 * RedGiant as an ACP agent (G38.6): an editor (Zed, JetBrains, Neovim…) launches `redgiant-acp`;
 * each ACP session is a conversation of the person's running RedGiant with one of their agents.
 * What the agent says, thinks and does streams back as `session/update`; the permission requests
 * RedGiant asks the person are asked in the editor too (the editor's answer is the person's;
 * RedGiant's rules decide what is asked). When the editor offers its files and its folder is the
 * agent's project, the agent's file tools read and write through the editor.
 */
export function redgiantAgent(o: BridgeOptions): acp.AgentApp {
  const sessions = new Map<string, Bridged>();
  /** RedGiant conversation → the ACP session that shows it (or one of whose children it is). */
  const byRg = new Map<string, string>();
  let clientCaps: acp.ClientCapabilities = {};
  let channel: Promise<{ send: (m: ClientMessage) => void; close: () => void }> | undefined;
  let editor: acp.AgentContext | undefined;
  const realpath = o.realpath ?? ((p: string) => fsRealpath(p).catch(() => p));
  const log = (l: string) => o.log?.(l);

  let closing = false;
  /**
   * The channel to RedGiant, opened again after the server restarted: the conversations shown
   * are followed again (and their editors attached); a turn that was running is lost with it.
   */
  const live = () => {
    if (channel) return channel;
    const opened = o.link
      .live(onMessage, () => {
        if (channel !== opened || closing) return;
        channel = undefined;
        log("RedGiant closed the connection; it is opened again at the next message");
        for (const b of sessions.values()) {
          b.synced = false;
          const t = b.turn;
          b.turn = undefined;
          t?.fail(acp.RequestError.internalError(undefined, "RedGiant closed the connection"));
        }
      })
      .then((c) => {
        for (const b of sessions.values()) {
          c.send({ type: "session.follow", sessionId: b.rgSession, history: true });
          if (b.editorFiles) c.send({ type: "editor.attach", sessionId: b.rgSession, root: b.cwd });
        }
        return c;
      })
      .catch((err) => {
        if (channel === opened) channel = undefined;
        throw err;
      });
    channel = opened;
    return opened;
  };
  const send = async (m: ClientMessage) => (await live()).send(m);

  const update = (sessionId: string, u: acp.SessionUpdate) =>
    editor?.notify("session/update", { sessionId, update: u }).catch(() => {});

  const owning = (rgSession: string | undefined) => {
    const id = rgSession ? byRg.get(rgSession) : undefined;
    return id ? sessions.get(id) : undefined;
  };

  function onMessage(m: ServerMessage): void {
    switch (m.type) {
      case "session.history": {
        const b = owning(m.sessionId);
        if (!b || b.rgSession !== m.sessionId) return;
        b.synced = true;
        const replay = b.replay;
        b.replay = undefined;
        if (replay) void replay(m.events);
        return;
      }
      case "delta": {
        const b = owning(m.sessionId);
        if (!b?.turn || b.rgSession !== m.sessionId) return;
        if (m.kind === "text") b.turn.streamed = true;
        void update(b.acpId, {
          sessionUpdate: m.kind === "text" ? "agent_message_chunk" : "agent_thought_chunk",
          content: { type: "text", text: m.text },
        });
        return;
      }
      case "event": {
        const e = m.event as Event;
        const b = owning(e.sessionId ?? undefined);
        if (!b?.synced || e.sessionId !== b.rgSession) return;
        onEvent(b, e);
        return;
      }
      case "session.state": {
        const b = owning(m.sessionId);
        if (!b?.turn || b.rgSession !== m.sessionId) return;
        if (m.state === "running") b.turn.sawRunning = true;
        else if (b.turn.sawRunning) {
          const t = b.turn;
          b.turn = undefined;
          t.done({ stopReason: t.cancelled ? "cancelled" : acpStopReason(m.stopReason) });
        }
        return;
      }
      case "error": {
        const b = owning((m as { sessionId?: string }).sessionId);
        log(`RedGiant: ${m.code}: ${m.message}`);
        if (b?.turn && !b.turn.sawRunning) {
          const t = b.turn;
          b.turn = undefined;
          t.fail(acp.RequestError.internalError(undefined, m.message));
        }
        return;
      }
      case "permission.request":
        void askEditor(m.request);
        return;
      case "permission.closed":
        // Answered elsewhere (the page, a chat): the editor's question goes away.
        for (const b of sessions.values()) b.asking.get(m.requestId)?.abort();
        return;
      case "editor.fs":
        void editorFile(m);
        return;
      default:
        return;
    }
  }

  function onEvent(b: Bridged, e: Event): void {
    if (!e.payload) return;
    switch (e.type) {
      case "message.assistant": {
        if (!b.turn) return;
        if (!b.turn.streamed) {
          const text = e.payload.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
          if (text)
            void update(b.acpId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            });
        }
        b.turn.streamed = false;
        return;
      }
      case "tool.call":
        void update(b.acpId, {
          sessionUpdate: "tool_call",
          toolCallId: e.payload.callId,
          title: toolTitle(e.payload.tool, e.payload.input),
          kind: toolKind(e.payload.tool),
          status: "in_progress",
          rawInput: e.payload.input as Record<string, unknown>,
          locations: toolLocations(e.payload.input, b.cwd),
        });
        return;
      case "tool.result":
        void update(b.acpId, {
          sessionUpdate: "tool_call_update",
          toolCallId: e.payload.callId,
          status: e.payload.ok ? "completed" : "failed",
          content: [
            {
              type: "content",
              content: { type: "text", text: e.payload.output.slice(0, 20_000) },
            },
          ],
        });
        return;
      case "subagent.started":
        b.children.add(e.payload.childSessionId);
        byRg.set(e.payload.childSessionId, b.acpId);
        return;
      default:
        return;
    }
  }

  /** A request RedGiant asks the person, for a conversation shown here: the editor asks too. */
  async function askEditor(r: PermissionRequestInfo): Promise<void> {
    const b = owning(r.sessionId);
    if (!b || !editor) return;
    const stop = new AbortController();
    b.asking.set(r.requestId, stop);
    try {
      const answer = await editor.request(
        "session/request_permission",
        {
          sessionId: b.acpId,
          toolCall: {
            toolCallId: r.requestId,
            title: `${r.agentName}: ${toolTitle(r.tool, r.input)}`,
            kind: toolKind(r.tool),
            status: "pending",
            rawInput: { ...(r.input as Record<string, unknown>), reasons: r.reasons },
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "allow_session", name: "Allow in this conversation", kind: "allow_always" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
        { cancellationSignal: stop.signal },
      );
      // Cancelled (the turn stopped, or answered elsewhere): nothing is decided here.
      if (answer.outcome.outcome !== "selected" || stop.signal.aborted) return;
      const id = answer.outcome.optionId;
      await send({
        type: "permission.resolve",
        requestId: r.requestId,
        decision: id === "deny" ? "deny" : "allow",
        remember: false,
        via: "editor",
        ...(id === "allow_session" && { scope: "session" as const }),
      });
    } catch (err) {
      log(`permission ${r.requestId}: ${(err as Error).message}`);
    } finally {
      b.asking.delete(r.requestId);
    }
  }

  /** RedGiant reads or writes a file of the open project through the editor (its buffers). */
  async function editorFile(r: Extract<ServerMessage, { type: "editor.fs" }>): Promise<void> {
    const b = owning(r.sessionId);
    const reply = (x: { ok: boolean; content?: string; error?: string }) =>
      send({ type: "editor.fs.reply", requestId: r.requestId, ...x });
    if (!b?.editorFiles || !editor) return void reply({ ok: false, error: "no editor" });
    try {
      if (r.op === "read") {
        const x = await editor.request("fs/read_text_file", { sessionId: b.acpId, path: r.path });
        await reply({ ok: true, content: x.content });
      } else {
        await editor.request("fs/write_text_file", {
          sessionId: b.acpId,
          path: r.path,
          content: r.content ?? "",
        });
        await reply({ ok: true });
      }
    } catch (err) {
      await reply({ ok: false, error: (err as Error).message });
    }
  }

  const agents = () => o.link.api<AgentRow[]>("GET", "/api/agents");

  /** The agent for a folder: the configured one, the orchestrator of the project there, or God. */
  async function agentFor(cwd: string): Promise<{ agent: AgentRow; projectPath?: string }> {
    const list = (await agents()).filter((a) => a.status === "active");
    const projects = await o.link
      .api<{ id: string; path: string; archivedAt?: string | null }[]>("GET", "/api/projects")
      .catch(() => []);
    const here = await realpath(cwd);
    const pathOf = (id: string | null) => projects.find((p) => p.id === id)?.path;
    if (o.agentId) {
      const a = list.find((x) => x.id === o.agentId || x.name === o.agentId);
      if (!a)
        throw acp.RequestError.invalidParams(
          { agent: o.agentId },
          `No active agent "${o.agentId}" in RedGiant`,
        );
      const p = pathOf(a.projectId);
      return { agent: a, ...(p && { projectPath: p }) };
    }
    for (const p of projects) {
      if (p.archivedAt || (await realpath(p.path)) !== here) continue;
      const orch = list.find((a) => a.kind === "orchestrator" && a.projectId === p.id);
      if (orch) return { agent: orch, projectPath: p.path };
    }
    const god = list.find((a) => a.kind === "god");
    if (!god)
      throw acp.RequestError.internalError(
        undefined,
        "RedGiant has no God agent yet: open RedGiant once first",
      );
    return { agent: god };
  }

  async function open(
    rgSession: string,
    agent: AgentRow,
    cwd: string,
    projectPath: string | undefined,
    fresh: boolean,
    replay?: (events: Event[]) => Promise<void>,
  ): Promise<Bridged> {
    // The editor's files serve the agent only when the editor shows that very folder.
    const editorFiles =
      clientCaps.fs?.readTextFile === true &&
      clientCaps.fs?.writeTextFile === true &&
      projectPath !== undefined &&
      (await realpath(projectPath)) === (await realpath(cwd));
    const b: Bridged = {
      acpId: rgSession,
      rgSession,
      agent,
      cwd,
      editorFiles,
      children: new Set(),
      synced: false,
      asking: new Map(),
      fresh,
      ...(replay && { replay }),
    };
    const known = channel !== undefined;
    sessions.set(rgSession, b);
    byRg.set(rgSession, rgSession);
    // A channel opened now follows every known conversation by itself.
    const c = await live();
    if (known) {
      c.send({ type: "session.follow", sessionId: rgSession, history: true });
      if (editorFiles) c.send({ type: "editor.attach", sessionId: rgSession, root: cwd });
    }
    return b;
  }

  const session = (id: string) => {
    const b = sessions.get(id);
    if (!b) throw acp.RequestError.sessionNotFound(id);
    return b;
  };

  /** «@name» at the start of a first prompt chooses another agent for this session. */
  async function chosen(b: Bridged, text: string): Promise<string> {
    const m = text.match(/^@([^\s]+)\s*/);
    if (!b.fresh || !m || o.agentId) return text;
    const want = (m[1] ?? "").toLowerCase();
    const a = (await agents()).find(
      (x) =>
        x.status === "active" &&
        (x.id.toLowerCase() === want || x.name.toLowerCase().replaceAll(" ", "") === want),
    );
    if (!a || a.id === b.agent.id) return text;
    const { sessionId } = await o.link.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: a.id,
    });
    // The ACP session keeps its id; the conversation behind it is the chosen agent's.
    await send({ type: "session.unfollow", sessionId: b.rgSession });
    // Another agent may work elsewhere: its files never go through this editor.
    if (b.editorFiles) await send({ type: "editor.detach", sessionId: b.rgSession });
    b.editorFiles = false;
    byRg.delete(b.rgSession);
    b.rgSession = sessionId;
    b.agent = a;
    b.synced = false;
    byRg.set(sessionId, b.acpId);
    await send({ type: "session.follow", sessionId, history: true });
    return text.slice(m[0].length);
  }

  const replayer = (sessionId: string) => async (events: Event[]) => {
    for (const e of events) {
      if (!e.payload) continue;
      if (e.type === "message.user")
        await update(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: e.payload.text },
        });
      else if (e.type === "message.assistant") {
        for (const p of e.payload.parts)
          if (p.type === "text" && p.text)
            await update(sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: p.text },
            });
      } else if (e.type === "tool.call")
        await update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: e.payload.callId,
          title: toolTitle(e.payload.tool, e.payload.input),
          kind: toolKind(e.payload.tool),
          status: "completed",
        });
    }
  };

  return acp
    .agent({ name: "redgiant" })
    .onConnect((c) => {
      editor = c.client;
      void c.closed.finally(() => {
        closing = true;
        void channel?.then(
          (x) => x.close(),
          () => {},
        );
      });
    })
    .onRequest("initialize", (ctx) => {
      editor = ctx.client;
      clientCaps = ctx.params.clientCapabilities ?? {};
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
        },
        agentInfo: { name: "redgiant", title: "RedGiant", version: o.version ?? "3" },
        authMethods: [],
      };
    })
    .onRequest("authenticate", () => ({}))
    .onRequest("session/new", async (ctx) => {
      editor = ctx.client;
      const { agent, projectPath } = await agentFor(ctx.params.cwd);
      const { sessionId } = await o.link.api<{ sessionId: string }>("POST", "/api/sessions", {
        agentId: agent.id,
      });
      await open(sessionId, agent, ctx.params.cwd, projectPath, true);
      log(`session ${sessionId} with ${agent.name} (${agent.id})`);
      return { sessionId };
    })
    .onRequest("session/load", async (ctx) => {
      editor = ctx.client;
      const id = ctx.params.sessionId;
      const rows = await o.link.api<{ id: string; agentId: string }[]>("GET", "/api/sessions");
      const row = rows.find((r) => r.id === id);
      if (!row) throw acp.RequestError.sessionNotFound(id);
      const agent = (await agents()).find((a) => a.id === row.agentId);
      if (!agent) throw acp.RequestError.sessionNotFound(id);
      const projectPath = await o.link
        .api<{ id: string; path: string }[]>("GET", "/api/projects")
        .then((ps) => ps.find((p) => p.id === agent.projectId)?.path)
        .catch(() => undefined);
      let replayed!: () => void;
      const done = new Promise<void>((ok) => {
        replayed = ok;
      });
      const replay = replayer(id);
      await open(id, agent, ctx.params.cwd, projectPath, false, async (events) => {
        await replay(events);
        replayed();
      });
      await done;
      return {};
    })
    .onRequest("session/prompt", async (ctx) => {
      editor = ctx.client;
      const b = session(ctx.params.sessionId);
      if (b.turn)
        throw acp.RequestError.invalidRequest(
          undefined,
          "A turn is already running in this session",
        );
      const text = await chosen(b, promptText(ctx.params.prompt));
      b.fresh = false;
      const images = promptImages(ctx.params.prompt);
      if (!text && images.length === 0) return { stopReason: "end_turn" as const };
      return new Promise<acp.PromptResponse>((done, fail) => {
        b.turn = { done, fail, sawRunning: false, cancelled: false, streamed: false };
        send({
          type: "session.send",
          sessionId: b.rgSession,
          text: text || "(image)",
          ...(images.length > 0 && { images: images.slice(0, 10) }),
        }).catch((err: Error) => {
          b.turn = undefined;
          fail(acp.RequestError.internalError(undefined, err.message));
        });
      });
    })
    .onNotification("session/cancel", async (ctx) => {
      const b = sessions.get(ctx.params.sessionId);
      if (!b) return;
      if (b.turn) b.turn.cancelled = true;
      for (const a of b.asking.values()) a.abort();
      await send({ type: "session.interrupt", sessionId: b.rgSession }).catch(() => {});
    });
}

/** Runs the bridge on this process's stdin and stdout (the editor launched it). */
export function serveStdio(o: BridgeOptions): acp.AgentConnection {
  const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
  return redgiantAgent(o).connect(acp.ndJsonStream(output, input));
}

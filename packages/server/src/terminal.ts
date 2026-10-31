import { randomUUID } from "node:crypto";
import { TerminalUnavailableError } from "@redgiant/tools";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { AuthProvider } from "./auth.js";
import type { RedGiantCore } from "./core.js";

const Hello = z.object({
  type: z.literal("hello"),
  token: z.string(),
  scope: z.string(),
  cols: z.number().int().min(10).max(500),
  rows: z.number().int().min(4).max(300),
});
const Message = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(65_536) }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(4).max(300),
  }),
]);

export type TerminalServerMessage =
  | { type: "ready"; terminalId: string }
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

/** Open terminals per owner; a runaway client cannot spawn shells without end. */
const MAX_PER_OWNER = 8;
const openPerOwner = new Map<string, number>();

/**
 * One WebSocket = one shell, in the sandbox of a project or of the platform. The first
 * message is `hello` (token, scope, size); then `input`/`resize` in, `output`/`exit` out.
 * Opening and closing are logged; what is typed is not.
 */
export function handleTerminal(ws: WebSocket, core: RedGiantCore, auth: AuthProvider): void {
  const send = (m: TerminalServerMessage) =>
    ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  let started = false;

  ws.once("message", async (raw) => {
    let hello: z.infer<typeof Hello>;
    try {
      hello = Hello.parse(JSON.parse(raw.toString()));
    } catch {
      return ws.close(4000, "hello expected");
    }
    const principal = await auth.authenticate(hello.token);
    if (!principal) return ws.close(4003, "unauthorized");
    const owner = principal.ownerId;
    if ((openPerOwner.get(owner) ?? 0) >= MAX_PER_OWNER) {
      send({ type: "error", message: `At most ${MAX_PER_OWNER} terminals at a time.` });
      return ws.close(4008, "too many terminals");
    }
    let term: Awaited<
      ReturnType<Awaited<ReturnType<RedGiantCore["scopeWorkspace"]>>["openTerminal"]>
    >;
    try {
      const workspace = await core.scopeWorkspace(owner, hello.scope);
      term = await workspace.openTerminal({ cols: hello.cols, rows: hello.rows });
    } catch (err) {
      send({
        type: "error",
        message:
          err instanceof TerminalUnavailableError
            ? err.message
            : `Cannot open a terminal: ${(err as Error).message}`,
      });
      return ws.close(4004, "unavailable");
    }
    started = true;
    openPerOwner.set(owner, (openPerOwner.get(owner) ?? 0) + 1);
    const terminalId = `term_${randomUUID().slice(0, 8)}`;
    const projectId = hello.scope.startsWith("project:") ? hello.scope.slice(8) : null;
    await core.store.append({
      ownerId: owner,
      projectId,
      body: { type: "terminal.opened", payload: { terminalId, scope: hello.scope, by: "human" } },
    });
    send({ type: "ready", terminalId });

    term.onData((data) => send({ type: "output", data }));
    let closed = false;
    const finish = async (code: number | null) => {
      if (closed) return;
      closed = true;
      openPerOwner.set(owner, Math.max(0, (openPerOwner.get(owner) ?? 1) - 1));
      await core.store.append({
        ownerId: owner,
        projectId,
        body: { type: "terminal.closed", payload: { terminalId, exitCode: code } },
      });
      send({ type: "exit", code });
      ws.close(1000, "shell exited");
    };
    term.onExit((code) => void finish(code));
    ws.on("message", (msg) => {
      try {
        const m = Message.parse(JSON.parse(msg.toString()));
        if (m.type === "input") term.write(m.data);
        else term.resize(m.cols, m.rows);
      } catch {
        // ignore malformed frames
      }
    });
    ws.on("close", () => {
      term.kill();
      void finish(null);
    });
  });

  setTimeout(() => {
    if (!started && ws.readyState === ws.OPEN) ws.close(4001, "hello expected");
  }, 10_000);
}

// Editors that show a conversation through `redgiant-acp` (G38.6). When the editor has the agent's
// project open and offers its files, the agent's file tools read and write through it: it sees
// the buffers the person has not saved, and the editor shows the changes as they happen. Every
// check stays RedGiant's: the tools ask the broker first, and the workspace resolves the path (a
// path outside it, or through a link that leaves it, is refused before the editor is asked).

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { ServerMessage } from "@redgiant/protocol";
import type { Workspace } from "@redgiant/tools";

interface Link {
  ownerId: string;
  /** The editor's folder, as the system names it. */
  root: string;
  send: (m: ServerMessage) => void;
}

const inside = (root: string, p: string) => {
  const r = relative(root, p);
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep) && !/^[a-zA-Z]:/.test(r));
};

export class EditorLinks {
  private readonly links = new Map<string, Link>();
  private readonly pending = new Map<
    string,
    { ok: (content: string | undefined) => void; ko: (err: Error) => void; send: Link["send"] }
  >();

  constructor(readonly timeoutMs = 15_000) {}

  /** An editor shows this conversation with `root` open; returns how to let go. */
  async attach(
    ownerId: string,
    sessionId: string,
    root: string,
    send: (m: ServerMessage) => void,
  ): Promise<() => void> {
    const link: Link = { ownerId, root: await realpath(root).catch(() => resolve(root)), send };
    this.links.set(sessionId, link);
    return () => {
      if (this.links.get(sessionId) === link) this.links.delete(sessionId);
      // Requests still waiting on that editor fall back to the disk.
      for (const [id, p] of this.pending)
        if (p.send === send) {
          this.pending.delete(id);
          p.ko(new Error("the editor went away"));
        }
    };
  }

  detach(sessionId: string, send: (m: ServerMessage) => void): void {
    if (this.links.get(sessionId)?.send === send) this.links.delete(sessionId);
  }

  /** The editor's answer to one request. */
  reply(m: {
    requestId: string;
    ok: boolean;
    content?: string | undefined;
    error?: string | undefined;
  }): void {
    const p = this.pending.get(m.requestId);
    if (!p) return;
    this.pending.delete(m.requestId);
    if (m.ok) p.ok(m.content);
    else p.ko(new Error(m.error ?? "the editor refused"));
  }

  private ask(
    sessionId: string,
    link: Link,
    op: "read" | "write",
    path: string,
    content?: string,
  ): Promise<string | undefined> {
    const requestId = randomUUID();
    return new Promise((ok, ko) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        ko(new Error("the editor did not answer"));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, {
        ok: (v) => {
          clearTimeout(timer);
          ok(v);
        },
        ko: (e) => {
          clearTimeout(timer);
          ko(e);
        },
        send: link.send,
      });
      link.send({
        type: "editor.fs",
        requestId,
        sessionId,
        op,
        path,
        ...(content !== undefined && { content }),
      });
    });
  }

  /** Where a workspace path goes through the editor, if it does now. */
  private async through(ws: Workspace, sessionId: string, path: string) {
    const link = this.links.get(sessionId);
    const resolvePath = (ws as { resolve?: (p: string) => Promise<string> }).resolve;
    if (!link || typeof resolvePath !== "function") return undefined;
    // The workspace's own checks first: outside it, or through a link that leaves it, throws.
    const abs = await resolvePath.call(ws, path);
    const real = await realpath(abs).catch(() => abs);
    return inside(link.root, real) || inside(link.root, abs) ? { link, abs } : undefined;
  }

  /**
   * The workspace of one conversation: its text files go through the editor while one shows it
   * (and has that folder open), the disk otherwise. Everything else is the workspace's own.
   */
  wrap(ws: Workspace, sessionId: string): Workspace {
    const w = Object.create(ws) as Workspace;
    w.readText = async (path: string) => {
      const via = await this.through(ws, sessionId, path);
      if (via) {
        const got = await this.ask(sessionId, via.link, "read", via.abs).catch(() => undefined);
        if (got !== undefined) return got;
      }
      return ws.readText(path);
    };
    w.writeText = async (path: string, content: string) => {
      if (ws.readOnly) return ws.writeText(path, content);
      const via = await this.through(ws, sessionId, path);
      if (via) {
        const done = await this.ask(sessionId, via.link, "write", via.abs, content).then(
          () => true,
          () => false,
        );
        if (done) return;
      }
      return ws.writeText(path, content);
    };
    return w;
  }
}

// Persistent memory for every agent (G29.3, RedGiant 2.0). Three kinds of notes, each a short
// Markdown file: about the user (shared by every agent of an owner), the agent's own, and the
// project's (shared by the agents that work on it). The `memory` tool changes them; a conversation
// reads them once when it starts, so the instructions stay the same for the whole session.
// The files are the assistants' memory of G24.11 (memory/shared.md, memory/<agentId>.md), now
// for everyone, plus memory/projects/<projectId>.md.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Tool } from "@redgiant/agent";
import { z } from "zod";

export type NoteScope = "user" | "self" | "project";

/** A file stays short: past this the agent must consolidate (replace or remove) first. */
export const NOTE_LIMIT = 6000;

export interface NoteOwner {
  ownerId: string;
  agentId: string;
  /** The project the agent works for, if any. */
  projectId?: string | undefined;
}

export class Notes {
  /** One change at a time per file: two agents adding together must not lose a line. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly dirOf: (ownerId: string) => string) {}

  path(who: NoteOwner, scope: NoteScope): string | undefined {
    const dir = this.dirOf(who.ownerId);
    if (scope === "user") return join(dir, "shared.md");
    if (scope === "self") return join(dir, `${who.agentId}.md`);
    return who.projectId ? join(dir, "projects", `${who.projectId}.md`) : undefined;
  }

  async read(who: NoteOwner, scope: NoteScope): Promise<string> {
    const p = this.path(who, scope);
    if (!p) return "";
    return readFile(p, "utf8")
      .then((t) => t.trim())
      .catch(() => "");
  }

  /** What an agent knows when a conversation starts. */
  async prompt(who: NoteOwner): Promise<string> {
    const [user, self, project] = await Promise.all(
      (["user", "self", "project"] as const).map((s) => this.read(who, s)),
    );
    const parts = [
      "## Memory",
      "Notes kept between conversations with the `memory` tool. Save what will matter next time " +
        "(the user's preferences, how this environment works, decisions, lessons from a hard " +
        "problem), not what happened in this conversation. Changes show in the next conversation. " +
        "When you solved a hard problem with steps worth repeating, save the steps as a skill " +
        "instead (propose_extension, kind skill), so every agent can follow them.",
      `About the user (scope "user", every agent reads them):\n${user || "(empty)"}`,
      `Your own (scope "self"):\n${self || "(empty)"}`,
    ];
    if (who.projectId) parts.push(`About this project (scope "project"):\n${project || "(empty)"}`);
    return parts.join("\n\n");
  }

  /** Adds, replaces or removes one entry; returns what to tell the agent. */
  change(
    who: NoteOwner,
    scope: NoteScope,
    action: "add" | "replace" | "remove",
    text: string,
    oldText?: string,
  ): Promise<string> {
    const p = this.path(who, scope);
    if (!p)
      return Promise.reject(new NoteError("You work for no project: use scope user or self."));
    const run = async () => {
      const now = await readFile(p, "utf8").catch(() => "");
      let next: string;
      if (action === "add") {
        next = `${now.trimEnd()}${now.trim() ? "\n" : ""}- ${text.trim().replace(/^- /, "")}\n`;
      } else {
        const old = (oldText ?? (action === "remove" ? text : "")).trim();
        if (!old) throw new NoteError("Give old_text: the part of the notes to change.");
        const at = now.indexOf(old);
        if (at < 0) throw new NoteError(`"${old.slice(0, 80)}" is not in the notes.`);
        if (now.indexOf(old, at + 1) >= 0)
          throw new NoteError(`"${old.slice(0, 80)}" appears more than once: give more of it.`);
        const by = action === "remove" ? "" : text.trim();
        next = now.slice(0, at) + by + now.slice(at + old.length);
        // A removed line leaves no empty bullet behind.
        next = `${next
          .split("\n")
          .filter((l) => l.trim() !== "-")
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim()}\n`;
      }
      if (next.length > NOTE_LIMIT)
        throw new NoteError(
          `The notes would pass ${NOTE_LIMIT} characters (${next.length}): merge or remove old entries first.`,
        );
      await mkdir(dirname(p), { recursive: true });
      // Written whole and renamed: a reader never sees half a file.
      await writeFile(`${p}.tmp`, next.trim() ? next : "");
      await rename(`${p}.tmp`, p);
      return `Saved (${next.length}/${NOTE_LIMIT} characters). It shows in your next conversation.`;
    };
    const prev = this.queues.get(p) ?? Promise.resolve();
    const out = prev.then(run, run);
    this.queues.set(
      p,
      out.catch(() => {}),
    );
    return out;
  }
}

export class NoteError extends Error {}

/** The `memory` tool, given to every agent that works (not the Demi-God, not the inspector). */
export function memoryTool(notes: Notes, who: NoteOwner): Tool {
  const Input = z.object({
    action: z.enum(["add", "replace", "remove"]),
    scope: z.enum(["user", "self", "project"]),
    text: z.string().min(1),
    old_text: z.string().optional(),
  });
  return {
    def: {
      name: "memory",
      description:
        "Keep notes between conversations. scope: user (about the person, shared by every agent), " +
        "self (yours), project (shared by the agents of your project). add a short line; replace " +
        "old_text with text; remove text (or old_text). Keep them short and current: merge, fix, " +
        "remove what is no longer true.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "replace", "remove"] },
          scope: { type: "string", enum: ["user", "self", "project"] },
          text: { type: "string" },
          old_text: { type: "string" },
        },
        required: ["action", "scope", "text"],
      },
    },
    schema: Input,
    async run(i: z.infer<typeof Input>) {
      try {
        return await notes.change(who, i.scope, i.action, i.text, i.old_text);
      } catch (err) {
        if (err instanceof NoteError) return { content: err.message, isError: true };
        throw err;
      }
    },
  } as Tool;
}

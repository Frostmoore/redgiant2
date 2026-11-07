// Import from other agents (G36.7): what RedGiant found in another agent's files (Claude Code,
// Codex, Cursor, Gemini/Antigravity, opencode, Hermes) or in a chat export (ChatGPT, Claude), shown
// to the person before anything changes, and what they chose. Shapes shared by page and server.

import { z } from "zod";

export const IMPORT_SOURCES = [
  "claude-code",
  "codex",
  "cursor",
  "gemini",
  "opencode",
  "hermes",
  "chatgpt",
  "claude",
] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const IMPORT_KINDS = ["instructions", "skill", "mcp", "memory", "conversation"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/**
 * Something worth saying about one item, as a code the page puts in words (`arg` fills it):
 * what the other agent had and RedGiant does not keep, or why an item is off.
 */
export const IMPORT_NOTES = [
  /** Limited to some files (`paths`, `globs`): in RedGiant instructions are for everything. */
  "only-paths",
  /** Named tools it may use (`allowed-tools`, `tools`): RedGiant agents keep their own. */
  "tools-dropped",
  /** Its own model (`model`): RedGiant agents use theirs. */
  "model-dropped",
  /** Hooks or shell lines (`!cmd`): not carried over. */
  "hooks-dropped",
  /** `$ARGUMENTS`, `{{args}}`: the request takes their place. */
  "arguments",
  /** A command or subagent made into a skill. */
  "as-skill",
  /** Files of a skill that are not text (pictures, programs): left out. */
  "binary-left",
  /** A server over SSE: RedGiant speaks Streamable HTTP, most servers do both. */
  "sse",
  /** Switched off in the other agent. */
  "disabled",
  /** Keys it needs (`arg`: their names), asked here or later in Extensions. */
  "needs-keys",
  /** Shortened to fit (`arg`: the limit). */
  "shortened",
  /** Looks like a password or a key: never kept in memory. */
  "secret",
  /** Its text was too short to be a skill. */
  "too-short",
  /** Pictures and files of the conversation are not in the export. */
  "no-attachments",
  /** Only the branch the person last saw (ChatGPT keeps every edit as a branch). */
  "branch",
] as const;
export type ImportNoteCode = (typeof IMPORT_NOTES)[number];
export interface ImportNote {
  code: ImportNoteCode;
  arg?: string;
}

export interface ImportItem {
  /** Stable inside its preview. */
  id: string;
  kind: ImportKind;
  source: ImportSource;
  /** Where it was found, as the person reads it (`~/.claude/CLAUDE.md`, `conversations.json`). */
  from: string;
  /** Its name (a skill's, a server's, a conversation's title, a file's). */
  name: string;
  /** The first lines, to recognise it. */
  preview: string;
  /** Instructions and memories: the text that would be added (a memory may be edited). */
  text?: string;
  skill?: { description: string; files: string[]; scripts: string[] };
  mcp?: {
    transport: "stdio" | "http";
    /** The program or the address (never a key). */
    target: string;
    /** Keys it needs and the file did not hold (asked in the window, kept with the server). */
    missing: string[];
    /** Keys the file held: they go with the server's private credentials, never in the clear. */
    held: string[];
  };
  conversation?: { messages: number; createdAt?: string; updatedAt?: string; model?: string };
  /** What RedGiant already has: `same` = nothing to add; `taken` = the name is in use. */
  exists?: "same" | "taken";
  /** Chosen at first: off for what is already there or what needs a look. */
  on: boolean;
  /** Instructions: for whom, at first (`everyone`). */
  target?: "everyone";
  notes: ImportNote[];
}

export interface ImportPreview {
  id: string;
  items: ImportItem[];
  /** What was found and is not carried over (hooks, permissions, settings…), in plain words. */
  left: { from: string; what: string }[];
  /** Files read and files that could not be read. */
  read: number;
  unreadable: { from: string; why: string }[];
}

export const ImportChoice = z.object({
  id: z.string().min(1),
  on: z.boolean(),
  /** Instructions: "everyone" or an agent's id. */
  target: z.string().min(1).optional(),
  /** A skill or server whose name is taken: skip it, replace the old one, keep both. */
  conflict: z.enum(["skip", "replace", "rename"]).optional(),
  /** A memory, as the person corrected it. */
  text: z.string().max(400).optional(),
  /** A conversation: the agent it goes to (default the everyday Chat). */
  agentId: z.string().min(1).optional(),
  /** An MCP server's missing keys, typed in the window (kept with the server, never shown). */
  secrets: z.record(z.string(), z.string().max(4000)).optional(),
});
export type ImportChoice = z.infer<typeof ImportChoice>;

export const ImportApply = z.object({
  id: z.string().min(1),
  choices: z.array(ImportChoice).max(20_000),
});
export type ImportApply = z.infer<typeof ImportApply>;

export interface ImportDone {
  itemId: string;
  kind: ImportKind;
  name: string;
  ok: boolean;
  /** Why it did not go (in English, from the server). */
  error?: string;
  /** A conversation's new id, a skill's or server's final name. */
  ref?: string;
  /** Something to know though it went (keys still to add, already remembered…), in English. */
  note?: string;
}

/** One import, kept so it can be taken back. */
export interface ImportRecord {
  id: string;
  createdAt: string;
  sources: ImportSource[];
  done: ImportDone[];
  undoneAt: string | null;
  /** What could not be taken back when it was undone (changed since, gone…). */
  undoProblems?: string[];
}

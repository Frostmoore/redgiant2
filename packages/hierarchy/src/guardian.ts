// The guardian (2026-11-04, RedGiant 2.0: the person's decision). Agents no longer run in
// containers: they work in their project's folder, and the guardian asks before they write
// anywhere else, like Officina's own guardian. This file only says *where* a tool call would
// write outside the agent's folders; the policy decides whether to ask or let it be.
//
// Bash is read as a shell would, roughly: commands split on ; && || | and new lines, `cd`
// followed, redirections and the commands that write (rm, mv, cp, mkdir, touch, tee, ln, chmod,
// chown, truncate, dd of=, sed -i, perl -i, tar -C/-x, unzip -d, git -C) checked against the
// folders. It errs on the side of asking: an unknown variable in a path counts as outside.

import { posix, win32 } from "node:path";
import type { ToolCallInfo } from "@redgiant/agent";

/** Where writing never needs asking: scratch space and the null device. */
const ALWAYS_OK = ["/tmp", "/var/tmp", "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"];

/** Commands that write to every path they are given. */
const WRITES_ALL = new Set([
  "rm",
  "rmdir",
  "mkdir",
  "touch",
  "tee",
  "chmod",
  "chown",
  "chgrp",
  "truncate",
  "shred",
  "unlink",
]);
/** Commands that write to their last path only (the others are read). */
const WRITES_LAST = new Set(["cp", "mv", "ln", "install", "rsync", "scp"]);

export interface GuardianContext {
  /** The folders the agent may write in freely (its project, its worktree). */
  roots: string[];
  /** The home folder, for `~`. */
  home?: string;
}

/** Windows paths (C:\…, \\server\…) are compared as Windows does: either slash, any case. */
const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
const flavor = (ctx: GuardianContext) => (ctx.roots.some(isWindowsPath) ? win32 : posix);

function inside(path: string, roots: string[]): boolean {
  if (roots.some(isWindowsPath)) {
    const key = (x: string) =>
      win32
        .normalize(x)
        .replace(/[\\/]+$/, "")
        .toLowerCase();
    const p = key(path);
    return roots.some((r) => {
      const root = key(r);
      return p === root || p.startsWith(`${root}\\`);
    });
  }
  const p = posix.normalize(path);
  return [...roots, ...ALWAYS_OK].some((r) => {
    const root = posix.normalize(r).replace(/\/+$/, "") || "/";
    return p === root || p.startsWith(`${root}/`) || root === "/";
  });
}

/** A path as the shell would see it from `cwd`; undefined when it cannot be known. */
function resolvePath(token: string, cwd: string, ctx: GuardianContext): string | undefined {
  let t = token.replace(/^["']|["']$/g, "");
  if (t === "") return undefined;
  if (t === "~" || t.startsWith("~/")) t = (ctx.home ?? "/root") + t.slice(1);
  t = t.replace(/^\$\{?PWD\}?/, cwd).replace(/^\$\{?HOME\}?/, ctx.home ?? "/root");
  // Another variable: where it points cannot be known here.
  if (t.includes("$")) return "$unknown";
  return flavor(ctx).resolve(cwd, t);
}

/** Splits a command line into words, keeping quoted parts together (roughly, as a shell). */
function words(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      cur += command[++i];
      continue;
    }
    // Separators and redirections become words of their own.
    const two = command.slice(i, i + 2);
    if (["&&", "||", ">>", "&>", "2>", ">|"].includes(two)) {
      if (cur) out.push(cur);
      cur = "";
      out.push(two);
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "\n" || c === ">") {
      if (cur) out.push(cur);
      cur = "";
      out.push(c === "\n" ? ";" : c);
      continue;
    }
    if (c === " " || c === "\t") {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const SEPARATORS = new Set([";", "&&", "||", "|"]);
const REDIRECTS = new Set([">", ">>", "&>", "2>", ">|"]);

/** The places a shell command would write to outside the agent's folders. */
export function bashOutsideWrites(command: string, ctx: GuardianContext, start?: string): string[] {
  const root = start ?? ctx.roots[0] ?? "/";
  let cwd = root;
  const found: string[] = [];
  const flag = (token: string) => {
    const p = resolvePath(token, cwd, ctx);
    if (p && (p === "$unknown" || !inside(p, ctx.roots))) found.push(p === "$unknown" ? token : p);
  };
  const ws = words(command);
  let cmd: string[] = [];
  const run = () => {
    if (cmd.length === 0) return;
    let [name = "", ...args] = cmd;
    // Words in front that do not change where it writes: sudo, env assignments, time, nice.
    while (
      ["sudo", "time", "nice", "nohup", "command", "exec"].includes(name) ||
      /^\w+=/.test(name)
    ) {
      [name = "", ...args] = args;
    }
    const base = posix.basename(name.replace(/\\/g, "/")).replace(/\.exe$/i, "");
    const paths = args.filter((a) => !a.startsWith("-"));
    if (base === "cd") {
      const p = resolvePath(paths[0] ?? ctx.home ?? "/root", cwd, ctx);
      if (p && p !== "$unknown") cwd = p;
    } else if (WRITES_ALL.has(base)) {
      for (const p of paths) flag(p);
    } else if (WRITES_LAST.has(base)) {
      const last = paths.at(-1);
      if (last) flag(last);
    } else if (base === "dd") {
      for (const a of args) if (a.startsWith("of=")) flag(a.slice(3));
    } else if ((base === "sed" || base === "perl") && args.some((a) => /^-[a-zA-Z]*i/.test(a))) {
      // The first word is the script, the files follow.
      for (const p of paths.slice(1)) flag(p);
    } else if (base === "tar" && args.some((a) => /^-?[a-zA-Z]*x/.test(a))) {
      const i = args.findIndex((a) => a === "-C" || a === "--directory");
      flag(i >= 0 ? (args[i + 1] ?? ".") : ".");
    } else if (base === "unzip") {
      const i = args.indexOf("-d");
      flag(i >= 0 ? (args[i + 1] ?? ".") : ".");
    } else if (base === "git") {
      const i = args.indexOf("-C");
      if (i >= 0) {
        const p = resolvePath(args[i + 1] ?? ".", cwd, ctx);
        if (p && (p === "$unknown" || !inside(p, ctx.roots)))
          found.push(p === "$unknown" ? (args[i + 1] ?? "") : p);
      } else if (!inside(cwd, ctx.roots)) found.push(cwd);
    }
    cmd = [];
  };
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i] as string;
    if (SEPARATORS.has(w)) {
      run();
      continue;
    }
    if (REDIRECTS.has(w)) {
      const target = ws[i + 1];
      // 2>&1 and the like are not files.
      if (target && !target.startsWith("&")) flag(target);
      i++;
      continue;
    }
    cmd.push(w);
  }
  run();
  return [...new Set(found)];
}

/**
 * Where a tool call would write outside the agent's folders: nothing for the tools that only
 * read, the path for write_file/edit_file, the shell's targets for bash.
 */
export function outsideWrites(call: ToolCallInfo, ctx: GuardianContext): string[] {
  if (ctx.roots.length === 0) return [];
  const input = (call.input ?? {}) as Record<string, unknown>;
  if (call.name === "write_file" || call.name === "edit_file") {
    const p =
      typeof input.path === "string"
        ? resolvePath(input.path, ctx.roots[0] as string, ctx)
        : undefined;
    return p && (p === "$unknown" || !inside(p, ctx.roots))
      ? [p === "$unknown" ? String(input.path) : p]
      : [];
  }
  if (call.name === "bash" && typeof input.command === "string")
    return bashOutsideWrites(input.command, ctx);
  // The editor (G37.1): where its path says, unless it only reads (help, a dry run).
  if (call.name === "canvas_edit" && !editReadsOnly(input) && typeof input.path === "string") {
    const p = resolvePath(input.path, ctx.roots[0] as string, ctx);
    if (!p) return [];
    return p === "$unknown" || !inside(p, ctx.roots) ? [p === "$unknown" ? input.path : p] : [];
  }
  return [];
}

/** A canvas_edit call that changes nothing (G37.1): its catalog, or a dry run. */
export function editReadsOnly(input: unknown): boolean {
  const i = (input ?? {}) as Record<string, unknown>;
  return i.help === true || i.dry_run === true;
}

/**
 * What a call would show the person from outside the agent's folders (G34.1): the path of a
 * show_file call, nothing for any other tool. Showing only reads, but it puts a file of the
 * computer in front of the person, so the guardian asks first.
 */
/**
 * A knowledge source by its path (3.5.3, knowledge_add_source with a folder or a file): its files
 * are read into a collection other agents may search, so a path outside the folders asks, as
 * showing one does. A project's files (`kind: "project"`) are checked by the knowledge's table.
 */
export function readsIntoKnowledge(call: ToolCallInfo): boolean {
  if (call.name !== "knowledge_add_source") return false;
  const kind = (call.input as { kind?: unknown } | undefined)?.kind;
  return kind === "folder" || kind === "file";
}

/** Tools that show or look at a file by its path (G34.1, G36.12): outside the folders, the person decides. */
export const SHOWING_TOOLS = new Set(["show_file", "canvas_look", "canvas_act"]);

export function outsideShows(call: ToolCallInfo, ctx: GuardianContext): string[] {
  if (ctx.roots.length === 0) return [];
  if (!SHOWING_TOOLS.has(call.name) && !readsIntoKnowledge(call)) return [];
  const input = (call.input ?? {}) as Record<string, unknown>;
  const p =
    typeof input.path === "string"
      ? resolvePath(input.path, ctx.roots[0] as string, ctx)
      : undefined;
  return p && (p === "$unknown" || !inside(p, ctx.roots))
    ? [p === "$unknown" ? String(input.path) : p]
    : [];
}

import { posix, win32 } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { ImagePart } from "@redgiant/protocol";

/** One of an external agent's actions, as RedGiant's permission rules read it. */
export interface MappedCall {
  callId: string;
  name: string;
  input: Record<string, unknown>;
}

/** The text of a prompt's content blocks, as RedGiant's chat takes it (G38.6). */
export function promptText(blocks: readonly acp.ContentBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") out.push(b.text);
    else if (b.type === "resource_link") out.push(`[${b.name}](${b.uri})`);
    else if (b.type === "resource") {
      const r = b.resource;
      if ("text" in r) out.push(`\n\`\`\`${fenceLang(r.uri)}\n// ${r.uri}\n${r.text}\n\`\`\`\n`);
      else out.push(`[${r.uri}]`);
    }
  }
  return out.join("").trim();
}

const fenceLang = (uri: string) => uri.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? "";

/** The pictures of a prompt (`image` blocks), as RedGiant's messages carry them. */
export function promptImages(blocks: readonly acp.ContentBlock[]): ImagePart[] {
  return blocks.flatMap((b) =>
    b.type === "image" && IMAGE_TYPES.includes(b.mimeType as ImagePart["mediaType"])
      ? [{ type: "image" as const, mediaType: b.mimeType as ImagePart["mediaType"], data: b.data }]
      : [],
  );
}

const IMAGE_TYPES: string[] = ["image/gif", "image/jpeg", "image/png", "image/webp"];

/** The ACP kind of one of RedGiant's tools, for the editor's icons. */
export function toolKind(tool: string): acp.ToolKind {
  if (/^(read_file|list_files|glob|read_agent|canvas_look|history)$/.test(tool)) return "read";
  if (/^(write_file|edit_file|canvas_edit|multi_edit)$/.test(tool)) return "edit";
  if (/^(grep|find_files|search|search_knowledge|web_search|skill_search)$/.test(tool))
    return "search";
  if (/^(bash|run_script|complete_task)$/.test(tool)) return "execute";
  if (/^(web_fetch|browser_)/.test(tool)) return "fetch";
  return "other";
}

/** A short title for one of RedGiant's tool calls: the tool and its main argument. */
export function toolTitle(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const main = ["command", "path", "file_path", "pattern", "query", "url", "title", "agent_id"]
    .map((k) => i[k])
    .find((v): v is string => typeof v === "string" && v.length > 0);
  const short = main && main.length > 120 ? `${main.slice(0, 120)}…` : main;
  return short ? `${tool}: ${short}` : tool;
}

/** The absolute paths a RedGiant tool call touches, for the editor's «follow along». */
export function toolLocations(input: unknown, root: string | undefined): acp.ToolCallLocation[] {
  const i = (input ?? {}) as Record<string, unknown>;
  const p = [i.path, i.file_path].find((v): v is string => typeof v === "string");
  if (!p) return [];
  const abs = isAbsoluteAny(p) ? p : root ? pathOf(root).join(root, p) : undefined;
  return abs ? [{ path: abs }] : [];
}

/** Path rules for a folder as its process sees it (a container's is POSIX). */
function pathOf(root: string) {
  return /^[a-zA-Z]:[\\/]|^\\\\/.test(root) ? win32 : posix;
}

const isAbsoluteAny = (p: string) => posix.isAbsolute(p) || win32.isAbsolute(p);

/**
 * A path an external agent gave, relative to its folder (`cwd`, as the process sees it), or
 * undefined when it lies outside: then RedGiant refuses it (the guardian, G38.6).
 */
export function insideFolder(cwd: string, path: string): string | undefined {
  const p = pathOf(cwd);
  const abs = p.isAbsolute(path) ? p.normalize(path) : p.resolve(cwd, path);
  const rel = p.relative(p.normalize(cwd), abs);
  if (rel === "") return ".";
  if (rel.startsWith("..") || p.isAbsolute(rel)) return undefined;
  return p === win32 ? rel.replaceAll("\\", "/") : rel;
}

/** Quotes a program and its arguments as a shell would read them (for the rules, never run). */
export function shellLine(command: string, args: readonly string[] = []): string {
  return [command, ...args]
    .map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`))
    .join(" ");
}

/**
 * An external agent's permission request as one of RedGiant's tool calls (G38.6): commands are
 * `bash`, file changes `write_file`, deletions an `rm`, so the person's danger rules, the guardian
 * and the truly dangerous list read them as they read RedGiant's own. Anything else keeps its kind.
 */
export function permissionCall(
  toolCall: acp.ToolCallUpdate,
  cwd: string,
  pending?: { kind?: acp.ToolKind | null; title?: string | null; rawInput?: unknown },
): MappedCall {
  const kind = toolCall.kind ?? pending?.kind ?? "other";
  const title = toolCall.title ?? pending?.title ?? "";
  const raw = (toolCall.rawInput ?? pending?.rawInput ?? {}) as Record<string, unknown>;
  const callId = toolCall.toolCallId;
  const located =
    toolCall.locations?.[0]?.path ??
    [raw.path, raw.file_path, raw.filePath, raw.abs_path].find(
      (v): v is string => typeof v === "string",
    );
  const rel = located ? (insideFolder(cwd, located) ?? located) : undefined;
  const command = commandOf(raw);
  if (kind === "execute" && command) return { callId, name: "bash", input: { command, title } };
  if ((kind === "edit" || kind === "move") && rel)
    return {
      callId,
      name: "write_file",
      input: {
        path: rel,
        title,
        ...(typeof raw.content === "string" && { content: raw.content }),
        ...(typeof raw.new_string === "string" && { content: raw.new_string }),
      },
    };
  if (kind === "delete" && rel)
    return { callId, name: "bash", input: { command: shellLine("rm", [rel]), title } };
  if (kind === "fetch" && typeof raw.url === "string")
    return { callId, name: "web_fetch", input: { url: raw.url, title } };
  return { callId, name: `acp_${kind}`, input: { title, ...raw } };
}

function commandOf(raw: Record<string, unknown>): string | undefined {
  const c = raw.command ?? raw.cmd;
  if (typeof c === "string") return c;
  if (Array.isArray(c) && c.every((x) => typeof x === "string"))
    return shellLine(c[0] as string, c.slice(1) as string[]);
  return undefined;
}

/** The option of a permission request that matches RedGiant's answer, preferring "once". */
export function chooseOption(
  options: readonly acp.PermissionOption[],
  allow: boolean,
): string | undefined {
  const order: acp.PermissionOptionKind[] = allow
    ? ["allow_once", "allow_always"]
    : ["reject_once", "reject_always"];
  for (const k of order) {
    const o = options.find((x) => x.kind === k);
    if (o) return o.optionId;
  }
  return undefined;
}

/** What an external agent's tool call shows in RedGiant's chat (G38.6): its kind and title. */
export function externalTool(
  update: Pick<acp.ToolCall, "kind" | "title" | "rawInput" | "locations">,
): { name: string; input: Record<string, unknown> } {
  const raw =
    update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput)
      ? (update.rawInput as Record<string, unknown>)
      : update.rawInput === undefined
        ? {}
        : { input: update.rawInput };
  return {
    name: `acp_${update.kind ?? "other"}`,
    input: {
      title: update.title,
      ...(update.locations?.length && { paths: update.locations.map((l) => l.path) }),
      ...raw,
    },
  };
}

/** A tool call's content as text for RedGiant's log: text blocks, diffs, terminal ids. */
export function contentText(content: readonly acp.ToolCallContent[] | null | undefined): string {
  if (!content) return "";
  const out: string[] = [];
  for (const c of content) {
    if (c.type === "content") {
      if (c.content.type === "text") out.push(c.content.text);
      else if (c.content.type === "resource" && "text" in c.content.resource)
        out.push(c.content.resource.text);
    } else if (c.type === "diff") {
      out.push(`--- ${c.path}\n${miniDiff(c.oldText ?? "", c.newText)}`);
    } else if (c.type === "terminal") out.push(`[terminal ${c.terminalId}]`);
  }
  return out.join("\n");
}

/** Lines removed and added, without context: the chat shows it as a diff block. */
function miniDiff(before: string, after: string): string {
  const a = before ? before.split("\n") : [];
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const lines = [
    ...a.slice(start, endA).map((l) => `-${l}`),
    ...b.slice(start, endB).map((l) => `+${l}`),
  ];
  const shown = lines.slice(0, 80);
  return `\`\`\`diff\n${shown.join("\n")}${lines.length > shown.length ? `\n… ${lines.length - shown.length} more lines` : ""}\n\`\`\``;
}

/**
 * The line an external agent ends its answer with to close its task (G38.6, RD17):
 * `RG_COMPLETE_TASK {"verify_command": "…"}` or `RG_COMPLETE_TASK {"not_testable_reason": "…"}`.
 * The last such line counts; undefined when there is none or it does not parse.
 */
export const COMPLETE_MARK = "RG_COMPLETE_TASK";

export function completionOf(
  text: string,
): { verify_command?: string; not_testable_reason?: string } | undefined {
  const lines = text.split("\n").filter((l) => l.trim().startsWith(COMPLETE_MARK));
  const last = lines.at(-1);
  if (!last) return undefined;
  const raw = last
    .trim()
    .slice(COMPLETE_MARK.length)
    .trim()
    .replace(/^`+|`+$/g, "");
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const out: { verify_command?: string; not_testable_reason?: string } = {};
    if (typeof v.verify_command === "string" && v.verify_command.trim())
      out.verify_command = v.verify_command;
    if (typeof v.not_testable_reason === "string" && v.not_testable_reason.trim())
      out.not_testable_reason = v.not_testable_reason;
    return out.verify_command || out.not_testable_reason ? out : undefined;
  } catch {
    return undefined;
  }
}

/** What an external agent reads before its first task (it keeps its own instructions). */
export function workerPrelude(name: string, closesTasks: boolean): string {
  return [
    `You work for RedGiant as "${name}", an agent of the project in this folder. ` +
      "RedGiant's person and agents see what you do; your file and command requests are checked by RedGiant.",
    closesTasks
      ? "When a task is done, verify the result yourself, then end your answer with one line, exactly:\n" +
        `${COMPLETE_MARK} {"verify_command": "<a shell command that exits 0 only if the result is right>"}\n` +
        "or, only if the result truly cannot be tested:\n" +
        `${COMPLETE_MARK} {"not_testable_reason": "<why, at least 20 characters>"}\n` +
        "RedGiant runs the command in this folder and closes the task when it exits 0."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** RedGiant's stop reason for an ACP one. */
export function stopReasonOf(
  r: acp.StopReason,
): "end_turn" | "max_tokens" | "refusal" | "aborted" | "other" {
  switch (r) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "cancelled":
      return "aborted";
    default:
      return "other";
  }
}

/** The ACP stop reason for how a RedGiant turn ended (`session.state`'s stopReason). */
export function acpStopReason(r: string | undefined): acp.StopReason {
  switch (r) {
    case "aborted":
      return "cancelled";
    case "max_turns":
      return "max_turn_requests";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}

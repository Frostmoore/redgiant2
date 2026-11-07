// Readers of other agents' files (G36.7), pure: given the files found (a scan of the known folders
// or what the person picked), what could come into RedGiant. Formats checked against each
// project's documentation on 2026-11-07:
//   Claude Code  CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md, .claude/rules/**/*.md (paths),
//                .claude/skills/<n>/SKILL.md, .claude/commands/**/*.md, .claude/agents/**/*.md,
//                .mcp.json and ~/.claude.json (mcpServers, projects[path].mcpServers),
//                ~/.claude/projects/<slug>/memory/*.md (auto memory), settings.json (left out)
//   Codex        AGENTS.md / AGENTS.override.md, ~/.codex/config.toml ([mcp_servers.<n>]),
//                ~/.codex/prompts/*.md, .agents/skills and ~/.codex/skills, memories(_v2)/
//   Cursor       .cursor/rules/**/*.mdc (description, globs, alwaysApply), .cursorrules,
//                .cursor/mcp.json, .cursor/commands/*.md, .cursor/skills
//   Gemini CLI / Antigravity  GEMINI.md («## Gemini Added Memories»), .gemini/settings.json and
//                .gemini/config/mcp_config.json (command, url, httpUrl, serverUrl),
//                .gemini/commands/**/*.toml, .gemini/skills, .gemini/tmp/<id>/memory/MEMORY.md
//   opencode     opencode.json(c) (mcp V1 {name: …} and V2 {servers: {…}}, local/remote),
//                ~/.config/opencode/AGENTS.md, .opencode|opencode/{agent(s),command(s)}/*.md
//   Hermes       ~/.hermes/config.yaml (mcp_servers), SOUL.md, memories/{MEMORY,USER}.md (§),
//                skills/**/SKILL.md
// Chat exports (ChatGPT, Claude) are read by `import-chats.ts`.

import { NAME_RE } from "@redgiant/extensions";
import type { ImportItem, ImportNote, ImportSource } from "@redgiant/protocol";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

/** One file found: its path as the person reads it (always with `/`), read on demand. */
export interface FoundFile {
  path: string;
  size: number;
  read(): Promise<Buffer>;
}

/** An MCP server as RedGiant keeps it: the transport in the clear, its keys apart. */
export interface McpDraft {
  name: string;
  transport:
    | { type: "stdio"; command: string; args?: string[]; cwd?: string }
    | { type: "http"; url: string };
  /** Values the file held (private credentials of the server). */
  secrets: { env: Record<string, string>; headers: Record<string, string> };
  /** Values made of a variable the person must give: `${VAR}` inside `template`. */
  templates: { env: Record<string, string>; headers: Record<string, string> };
  /** The variables the person gives. */
  missing: string[];
}

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  files: Record<string, string>;
  license?: string;
  compatibility?: string;
}

/** What could come in: the item the page shows and what the server keeps to do it. */
export type Candidate = Omit<ImportItem, "id" | "on" | "exists"> &
  (
    | { kind: "instructions"; data: { text: string } }
    | { kind: "memory"; data: { text: string } }
    | { kind: "skill"; data: SkillDraft }
    | { kind: "mcp"; data: McpDraft }
    | { kind: "conversation"; data: ImportedConversation }
  );

export interface ImportedConversation {
  title: string;
  originalId?: string;
  createdAt?: string;
  updatedAt?: string;
  model?: string;
  messages: { role: "user" | "assistant"; text: string; at?: string }[];
}

export interface ReadResult {
  candidates: Candidate[];
  left: { from: string; what: string }[];
  unreadable: { from: string; why: string }[];
}

// ---- small parsers -----------------------------------------------------------------------------

/** YAML front matter and body; a file without it is all body. */
export function frontMatter(md: string): { meta: Record<string, unknown>; body: string } {
  const m = md.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  if (!m) return { meta: {}, body: md.replace(/^﻿/, "") };
  let meta: unknown;
  try {
    meta = parseYaml(m[1] ?? "");
  } catch {
    meta = undefined;
  }
  return {
    meta:
      meta && typeof meta === "object" && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)
        : {},
    body: (m[2] ?? "").replace(/^(\s*\r?\n)+/, ""),
  };
}

/** JSON with comments and trailing commas (opencode.jsonc, VS Code style). */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  const s = text.replace(/^﻿/, "");
  while (i < s.length) {
    const c = s[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
    } else if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const str = (v: unknown): string | undefined =>
  typeof v === "string"
    ? v
    : typeof v === "number" || typeof v === "boolean"
      ? String(v)
      : undefined;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap((x) => (typeof x === "string" ? [x] : [])) : [];
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** A valid RedGiant skill name from any name (agentskills.io rules). */
export function skillName(raw: string): string {
  const n = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return NAME_RE.test(n) ? n : "imported-skill";
}

/** The first lines of a text, to recognise it. */
export const previewOf = (text: string, max = 600) => {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
};

const firstLine = (body: string) =>
  body
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0) ?? "";

const PLACEHOLDER =
  /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$|^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const INNER =
  /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The variables a value is made of, written as `${VAR}`; none ⇒ a literal value. */
function variablesIn(value: string): { template: string; names: string[] } | undefined {
  const whole = value.match(PLACEHOLDER);
  if (whole) {
    const name = (whole[1] ?? whole[2] ?? whole[3]) as string;
    return { template: `\${${name}}`, names: [name] };
  }
  const names: string[] = [];
  const template = value.replace(INNER, (_m, a?: string, b?: string) => {
    const name = (a ?? b) as string;
    names.push(name);
    return `\${${name}}`;
  });
  return names.length ? { template, names } : undefined;
}

// ---- MCP -----------------------------------------------------------------------------------------

interface McpRaw {
  name: string;
  command?: string | string[] | undefined;
  args?: string[] | undefined;
  cwd?: string | undefined;
  env?: Record<string, unknown> | undefined;
  url?: string | undefined;
  headers?: Record<string, unknown> | undefined;
  sse?: boolean;
  disabled?: boolean;
  /** Codex: variables that hold keys. */
  envVars?: string[];
  bearerVar?: string | undefined;
  envHeaders?: Record<string, unknown> | undefined;
}

/** One server in RedGiant's shape, with what it needs said in notes. */
export function mcpDraft(raw: McpRaw): { draft: McpDraft; notes: ImportNote[] } | undefined {
  const notes: ImportNote[] = [];
  const secrets: McpDraft["secrets"] = { env: {}, headers: {} };
  const templates: McpDraft["templates"] = { env: {}, headers: {} };
  const missing = new Set<string>();
  const take = (where: "env" | "headers", key: string, value: unknown) => {
    const v = str(value);
    if (v === undefined) return;
    const vars = variablesIn(v);
    if (vars) {
      templates[where][key] = vars.template;
      for (const n of vars.names) missing.add(n);
    } else secrets[where][key] = v;
  };
  let transport: McpDraft["transport"];
  const cmd = Array.isArray(raw.command) ? raw.command : raw.command ? [raw.command] : [];
  if (cmd.length > 0 && cmd[0]) {
    const args = [...cmd.slice(1), ...(raw.args ?? [])];
    transport = {
      type: "stdio",
      command: cmd[0],
      ...(args.length > 0 && { args }),
      ...(raw.cwd && { cwd: raw.cwd }),
    };
    for (const [k, v] of Object.entries(raw.env ?? {})) take("env", k, v);
    for (const n of raw.envVars ?? []) {
      templates.env[n] = `\${${n}}`;
      missing.add(n);
    }
  } else if (raw.url) {
    transport = { type: "http", url: raw.url };
    if (raw.sse) notes.push({ code: "sse" });
    for (const [k, v] of Object.entries(raw.headers ?? {})) take("headers", k, v);
    if (raw.bearerVar) {
      templates.headers.Authorization = `Bearer \${${raw.bearerVar}}`;
      missing.add(raw.bearerVar);
    }
    for (const [k, v] of Object.entries(raw.envHeaders ?? {})) {
      const n = str(v);
      if (!n) continue;
      templates.headers[k] = `\${${n}}`;
      missing.add(n);
    }
  } else return undefined;
  if (raw.disabled) notes.push({ code: "disabled" });
  if (missing.size > 0) notes.push({ code: "needs-keys", arg: [...missing].join(", ") });
  return {
    draft: { name: skillName(raw.name), transport, secrets, templates, missing: [...missing] },
    notes,
  };
}

/** `mcpServers` of Claude Code, Cursor, Gemini/Antigravity (one shape, a few names). */
function mcpServersOf(map: unknown): McpRaw[] {
  return Object.entries(record(map)).map(([name, v]) => {
    const s = record(v);
    const type = str(s.type);
    return {
      name,
      command: str(s.command),
      args: strings(s.args),
      cwd: str(s.cwd),
      env: record(s.env),
      url: str(s.url) ?? str(s.httpUrl) ?? str(s.serverUrl),
      headers: record(s.headers),
      // Gemini: `url` alone is SSE, `httpUrl` streamable HTTP.
      sse: type === "sse",
      disabled: s.disabled === true || s.enabled === false,
    };
  });
}

// ---- the readers -------------------------------------------------------------------------------

type Ctx = {
  files: Map<string, FoundFile>;
  text: (path: string) => Promise<string>;
  out: ReadResult;
};

const SOURCE_NAMES: Record<ImportSource, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  opencode: "opencode",
  hermes: "Hermes",
  chatgpt: "ChatGPT",
  claude: "Claude",
};
export const sourceName = (s: ImportSource) => SOURCE_NAMES[s];

function instructions(
  ctx: Ctx,
  source: ImportSource,
  from: string,
  text: string,
  notes: ImportNote[] = [],
  name?: string,
) {
  const t = text.trim();
  if (!t) return;
  ctx.out.candidates.push({
    kind: "instructions",
    source,
    from,
    name: name ?? from.split("/").pop() ?? from,
    preview: previewOf(t),
    text: t,
    target: "everyone",
    notes,
    data: { text: t },
  });
}

function memories(ctx: Ctx, source: ImportSource, from: string, texts: string[]) {
  for (const raw of texts) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (t.length < 3) continue;
    const notes: ImportNote[] = [];
    let text = t;
    if (text.length > 400) {
      text = `${text.slice(0, 399).trimEnd()}…`;
      notes.push({ code: "shortened", arg: "400" });
    }
    ctx.out.candidates.push({
      kind: "memory",
      source,
      from,
      name: previewOf(text, 80),
      preview: text,
      text,
      notes,
      data: { text },
    });
  }
}

const bullets = (md: string) =>
  md
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) =>
      l
        .replace(/^[-*]\s+/, "")
        // Claude Code's index: «- [Title](file.md) — hook»
        .replace(/^\[([^\]]+)\]\([^)]*\)\s*[—–-]?\s*/, "$1: "),
    )
    .map((l) => l.replace(/:\s*$/, ""));

const textual = (b: Buffer) => !b.subarray(0, 8000).includes(0);

async function skill(
  ctx: Ctx,
  source: ImportSource,
  from: string,
  draft: Omit<SkillDraft, "files"> & { files?: Record<string, string> },
  notes: ImportNote[],
  dir?: string,
) {
  const files: Record<string, string> = { ...(draft.files ?? {}) };
  let binary = false;
  if (dir) {
    let total = 0;
    for (const [path, f] of ctx.files) {
      if (!path.startsWith(`${dir}/`) || path === `${dir}/SKILL.md`) continue;
      const rel = path.slice(dir.length + 1);
      if (Object.keys(files).length >= 100 || total + f.size > 2_000_000 || f.size > 1_000_000) {
        binary = true;
        continue;
      }
      const b = await f.read().catch(() => undefined);
      if (!b || !textual(b)) {
        binary = true;
        continue;
      }
      files[rel] = b.toString("utf8");
      total += f.size;
    }
  }
  if (binary) notes.push({ code: "binary-left" });
  const body = draft.body.trim();
  if (body.length < 20) {
    ctx.out.unreadable.push({ from, why: "too short to be a skill" });
    return;
  }
  let description = (draft.description || firstLine(body)).replace(/\s+/g, " ").trim();
  if (description.length < 10)
    description = `${description || draft.name}: ${firstLine(body)}`.slice(0, 200);
  if (description.length < 10) description = `Imported from ${sourceName(source)}: ${draft.name}`;
  if (description.length > 1024) description = `${description.slice(0, 1020)}…`;
  const scripts = Object.entries(files)
    .filter(
      ([p, c]) =>
        /\.(sh|bash|ps1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php)$/i.test(p) || c.startsWith("#!"),
    )
    .map(([p]) => p);
  ctx.out.candidates.push({
    kind: "skill",
    source,
    from,
    name: draft.name,
    preview: previewOf(body),
    skill: { description, files: Object.keys(files).sort(), scripts },
    notes,
    data: { ...draft, description, body, files },
  });
}

/** A Claude Code / Cursor / Codex / opencode command or subagent, made a skill. */
function commandNotes(meta: Record<string, unknown>, body: string): ImportNote[] {
  const notes: ImportNote[] = [{ code: "as-skill" }];
  if (meta["allowed-tools"] || meta.tools || meta.disallowedTools || meta.permissions)
    notes.push({ code: "tools-dropped" });
  if (meta.model) notes.push({ code: "model-dropped" });
  if (meta.hooks || /!`[^`]+`|!\{[^}]+\}/.test(body)) notes.push({ code: "hooks-dropped" });
  if (/\$ARGUMENTS|\$\d|\{\{args\}\}/.test(body)) notes.push({ code: "arguments" });
  return notes;
}

/** `$ARGUMENTS` and friends become words the agent reads. */
const argumentsInWords = (body: string) =>
  body
    .replace(/\$ARGUMENTS(\[\d+\])?|\{\{args\}\}/g, "(the person's request)")
    .replace(/\$(\d)\b/g, "(argument $1)");

async function skillFromMd(
  ctx: Ctx,
  source: ImportSource,
  path: string,
  how: "skill" | "command" | "agent",
) {
  const md = await ctx.text(path);
  const { meta, body } = frontMatter(md);
  const parts = path.split("/");
  const file = parts.at(-1) ?? "";
  const base = how === "skill" ? (parts.at(-2) ?? "skill") : file.replace(/\.(md|mdc|toml)$/i, "");
  // A command in a subfolder is «/folder:name»: the skill is «folder-name».
  const folder = how === "command" ? parts.at(-2) : undefined;
  const rawName =
    how === "agent"
      ? (str(meta.name) ?? base)
      : how === "skill"
        ? (str(meta.name) ?? base)
        : folder && !/^(commands?|prompts)$/.test(folder)
          ? `${folder}-${base}`
          : base;
  const name = skillName(rawName);
  const notes: ImportNote[] = how === "skill" ? [] : commandNotes(meta, body);
  if (how === "skill") {
    if (meta["allowed-tools"]) notes.push({ code: "tools-dropped" });
    if (meta.model) notes.push({ code: "model-dropped" });
    if (meta.hooks) notes.push({ code: "hooks-dropped" });
  }
  const description =
    str(meta.description) ?? (how === "agent" ? `Work as the "${rawName}" helper` : "");
  const text =
    how === "agent"
      ? `When this skill fits, work as this specialist would:\n\n${body}`
      : argumentsInWords(body);
  await skill(
    ctx,
    source,
    path,
    {
      name,
      description: [description, str(meta.when_to_use)].filter(Boolean).join(" "),
      body: text,
      ...(str(meta.license) && { license: str(meta.license) as string }),
      ...(str(meta.compatibility) && { compatibility: str(meta.compatibility) as string }),
    },
    notes,
    how === "skill" ? parts.slice(0, -1).join("/") : undefined,
  );
}

/** Gemini CLI's TOML commands: `prompt` and `description`. */
async function geminiCommand(ctx: Ctx, path: string) {
  const doc = record(parseToml(await ctx.text(path)));
  const prompt = str(doc.prompt);
  if (!prompt) return;
  const rel = path.split("/commands/").pop() ?? path;
  const name = skillName(rel.replace(/\.toml$/i, "").replace(/\//g, "-"));
  await skill(
    ctx,
    "gemini",
    path,
    { name, description: str(doc.description) ?? "", body: argumentsInWords(prompt) },
    commandNotes({}, prompt),
  );
}

/** GEMINI.md: instructions, and the facts `save_memory` wrote under its own heading. */
async function geminiMd(ctx: Ctx, path: string) {
  const md = await ctx.text(path);
  const at = md.search(/^## Gemini Added Memories\s*$/m);
  if (at < 0) return instructions(ctx, "gemini", path, md);
  const rest = md.slice(at).split("\n").slice(1).join("\n");
  const next = rest.search(/^## /m);
  const section = next < 0 ? rest : rest.slice(0, next);
  instructions(ctx, "gemini", path, md.slice(0, at) + (next < 0 ? "" : rest.slice(next)));
  memories(ctx, "gemini", path, bullets(section));
}

async function claudeJson(ctx: Ctx, path: string, from: ImportSource) {
  const doc = record(JSON.parse(await ctx.text(path)));
  const servers = [
    ...mcpServersOf(doc.mcpServers),
    ...Object.values(record(doc.projects)).flatMap((p) => mcpServersOf(record(p).mcpServers)),
  ];
  for (const raw of servers) mcp(ctx, from, path, raw);
}

function mcp(ctx: Ctx, source: ImportSource, from: string, raw: McpRaw) {
  const r = mcpDraft(raw);
  if (!r) {
    ctx.out.unreadable.push({
      from,
      why: `the server "${raw.name}" has neither a command nor an address`,
    });
    return;
  }
  const { draft, notes } = r;
  ctx.out.candidates.push({
    kind: "mcp",
    source,
    from,
    name: draft.name,
    preview:
      draft.transport.type === "stdio"
        ? [draft.transport.command, ...(draft.transport.args ?? [])].join(" ")
        : draft.transport.url,
    mcp: {
      transport: draft.transport.type,
      target: draft.transport.type === "stdio" ? draft.transport.command : draft.transport.url,
      missing: draft.missing,
      held: [...Object.keys(draft.secrets.env), ...Object.keys(draft.secrets.headers)].sort(),
    },
    notes,
    data: draft,
  });
}

async function codexToml(ctx: Ctx, path: string) {
  const doc = record(parseToml(await ctx.text(path)));
  for (const [name, v] of Object.entries(record(doc.mcp_servers))) {
    const s = record(v);
    mcp(ctx, "codex", path, {
      name,
      command: str(s.command),
      args: strings(s.args),
      cwd: str(s.cwd),
      env: record(s.env),
      envVars: strings(s.env_vars),
      url: str(s.url),
      headers: record(s.http_headers),
      bearerVar: str(s.bearer_token_env_var),
      envHeaders: record(s.env_http_headers),
      disabled: s.enabled === false,
    });
  }
  const kept = [
    "model",
    "model_provider",
    "model_reasoning_effort",
    "approval_policy",
    "sandbox_mode",
    "profiles",
  ].filter((k) => doc[k] !== undefined);
  if (kept.length > 0)
    ctx.out.left.push({
      from: path,
      what: `settings ${kept.join(", ")} (chosen in RedGiant's own Settings)`,
    });
}

async function opencodeJson(ctx: Ctx, path: string) {
  const doc = record(parseJsonc(await ctx.text(path)));
  const m = record(doc.mcp);
  // V2 keeps the servers under `servers`; V1 right under `mcp`.
  const servers = m.servers && typeof m.servers === "object" ? record(m.servers) : m;
  for (const [name, v] of Object.entries(servers)) {
    const s = record(v);
    if (s.type !== "local" && s.type !== "remote" && !s.command && !s.url) continue;
    mcp(ctx, "opencode", path, {
      name,
      command: Array.isArray(s.command) ? strings(s.command) : str(s.command),
      cwd: str(s.cwd),
      env: record(s.environment ?? s.env),
      url: str(s.url),
      headers: record(s.headers),
      disabled: s.enabled === false || s.disabled === true,
    });
  }
  const kept = ["model", "agent", "permission", "provider"].filter((k) => doc[k] !== undefined);
  if (kept.length > 0) ctx.out.left.push({ from: path, what: `settings ${kept.join(", ")}` });
}

async function hermesYaml(ctx: Ctx, path: string) {
  const doc = record(parseYaml(await ctx.text(path)));
  for (const [name, v] of Object.entries(record(doc.mcp_servers))) {
    const s = record(v);
    mcp(ctx, "hermes", path, {
      name,
      command: str(s.command),
      args: strings(s.args),
      env: record(s.env),
      url: str(s.url),
      headers: record(s.headers),
      disabled: s.enabled === false,
    });
  }
}

/** Cursor's rules: always on ⇒ instructions; chosen by the model from their description ⇒ skills. */
async function cursorRule(ctx: Ctx, path: string) {
  const { meta, body } = frontMatter(await ctx.text(path));
  const description = str(meta.description);
  const globs = meta.globs;
  const notes: ImportNote[] = [];
  if (globs && (typeof globs === "string" ? globs.trim() : strings(globs).length))
    notes.push({ code: "only-paths" });
  if (meta.alwaysApply === true || !description)
    return instructions(ctx, "cursor", path, body, notes);
  const name = skillName((path.split("/").pop() ?? "rule").replace(/\.mdc$/i, ""));
  await skill(ctx, "cursor", path, { name, description, body }, notes);
}

/** Claude Code's rules: a `paths` list limits them to some files, here they are for everything. */
async function claudeRule(ctx: Ctx, path: string) {
  const { meta, body } = frontMatter(await ctx.text(path));
  instructions(ctx, "claude-code", path, body, meta.paths ? [{ code: "only-paths" }] : []);
}

/** Claude Code's auto memory: one file per memory (front matter + text), or the index's lines. */
async function claudeMemory(ctx: Ctx, paths: string[]) {
  const topics = paths.filter((p) => !p.endsWith("/MEMORY.md"));
  if (topics.length === 0) {
    const index = paths.find((p) => p.endsWith("/MEMORY.md"));
    if (index) memories(ctx, "claude-code", index, bullets(await ctx.text(index)));
    return;
  }
  for (const p of topics) {
    const { meta, body } = frontMatter(await ctx.text(p));
    const clean = body
      .split("\n")
      .filter((l) => !/^#/.test(l.trim()))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const text = clean.length > 0 && clean.length <= 400 ? clean : (str(meta.description) ?? clean);
    memories(ctx, "claude-code", p, [text]);
  }
}

/** Hermes keeps memories separated by «§», on one or more lines. */
async function hermesMemory(ctx: Ctx, path: string) {
  const md = await ctx.text(path);
  memories(
    ctx,
    "hermes",
    path,
    md.split("§").map((x) => x.replace(/^#.*$/gm, "").trim()),
  );
}

/** Codex's memories: the summary's and index's lines. */
async function codexMemory(ctx: Ctx, path: string) {
  const md = await ctx.text(path);
  const lines = bullets(md);
  memories(
    ctx,
    "codex",
    path,
    lines.length > 0 ? lines : md.split(/\n\s*\n/).filter((p) => !p.trim().startsWith("#")),
  );
}

const SETTINGS_LEFT = (doc: Record<string, unknown>) =>
  [
    "permissions",
    "hooks",
    "model",
    "env",
    "effortLevel",
    "statusLine",
    "outputStyle",
    "enabledPlugins",
  ].filter((k) => doc[k] !== undefined);

/**
 * Everything worth bringing in among `files`. Paths are matched by their ending, so a scan of the
 * home folder, a project folder or a picked `.claude` folder read the same way.
 */
export async function readAgentFiles(found: FoundFile[]): Promise<ReadResult> {
  const out: ReadResult = { candidates: [], left: [], unreadable: [] };
  const files = new Map(found.map((f) => [f.path, f]));
  const ctx: Ctx = {
    files,
    out,
    text: async (p) => {
      const f = files.get(p);
      if (!f) throw new Error("missing");
      return (await f.read()).toString("utf8");
    },
  };
  const paths = [...files.keys()].sort();
  const claudeMemoryDirs = new Map<string, string[]>();
  for (const path of paths) {
    const at = (re: RegExp) => re.test(path);
    try {
      // ---- Claude Code
      if (at(/(^|\/)\.claude\/projects\/[^/]+\/memory\/[^/]+\.md$/)) {
        const dir = path.slice(0, path.lastIndexOf("/"));
        claudeMemoryDirs.set(dir, [...(claudeMemoryDirs.get(dir) ?? []), path]);
      } else if (at(/(^|\/)\.claude\/skills\/(?:synced\/)?[^/]+\/SKILL\.md$/))
        await skillFromMd(ctx, "claude-code", path, "skill");
      else if (at(/(^|\/)\.claude\/commands\/.+\.md$/))
        await skillFromMd(ctx, "claude-code", path, "command");
      else if (at(/(^|\/)\.claude\/agents\/.+\.md$/))
        await skillFromMd(ctx, "claude-code", path, "agent");
      else if (at(/(^|\/)\.claude\/rules\/.+\.md$/)) await claudeRule(ctx, path);
      else if (at(/(^|\/)(\.claude\/)?CLAUDE(\.local)?\.md$/))
        instructions(ctx, "claude-code", path, await ctx.text(path));
      else if (at(/(^|\/)\.mcp\.json$/)) await claudeJson(ctx, path, "claude-code");
      else if (at(/(^|\/)\.claude\.json$/)) await claudeJson(ctx, path, "claude-code");
      else if (at(/(^|\/)\.claude\/settings(\.local)?\.json$/)) {
        const left = SETTINGS_LEFT(record(JSON.parse(await ctx.text(path))));
        if (left.length) out.left.push({ from: path, what: `settings ${left.join(", ")}` });
      }
      // ---- Codex
      else if (at(/(^|\/)\.codex\/config\.toml$/)) await codexToml(ctx, path);
      else if (at(/(^|\/)\.codex\/prompts\/[^/]+\.md$/))
        await skillFromMd(ctx, "codex", path, "command");
      else if (at(/(^|\/)\.(codex|agents)\/skills\/(?:.+\/)?[^/]+\/SKILL\.md$/))
        await skillFromMd(ctx, "codex", path, "skill");
      else if (at(/(^|\/)\.codex\/memories(_v2)?\/(MEMORY|memory_summary)\.md$/))
        await codexMemory(ctx, path);
      // ---- Cursor
      else if (at(/(^|\/)\.cursor\/rules\/.+\.mdc$/)) await cursorRule(ctx, path);
      else if (at(/(^|\/)\.cursorrules$/)) instructions(ctx, "cursor", path, await ctx.text(path));
      else if (at(/(^|\/)\.cursor\/mcp\.json$/)) {
        for (const raw of mcpServersOf(record(JSON.parse(await ctx.text(path))).mcpServers))
          mcp(ctx, "cursor", path, raw);
      } else if (at(/(^|\/)\.cursor\/commands\/[^/]+\.md$/))
        await skillFromMd(ctx, "cursor", path, "command");
      else if (at(/(^|\/)\.cursor\/skills\/[^/]+\/SKILL\.md$/))
        await skillFromMd(ctx, "cursor", path, "skill");
      // ---- Gemini CLI and Antigravity
      else if (at(/(^|\/)\.gemini\/tmp\/[^/]+\/memory\/MEMORY\.md$/))
        memories(ctx, "gemini", path, bullets(await ctx.text(path)));
      else if (at(/(^|\/)GEMINI\.md$/)) await geminiMd(ctx, path);
      else if (
        at(/(^|\/)\.gemini\/settings\.json$/) ||
        at(/(^|\/)(\.gemini\/config|\.agents)\/mcp_config\.json$/)
      ) {
        const doc = record(parseJsonc(await ctx.text(path)));
        for (const raw of mcpServersOf(doc.mcpServers)) {
          // Gemini CLI: `url` alone is SSE, `httpUrl` streamable HTTP.
          const s = record(record(doc.mcpServers)[raw.name]);
          if (s.url && !s.httpUrl && !s.serverUrl && s.type === undefined) raw.sse = true;
          mcp(ctx, "gemini", path, raw);
        }
      } else if (at(/(^|\/)\.gemini\/commands\/.+\.toml$/)) await geminiCommand(ctx, path);
      else if (at(/(^|\/)\.gemini\/(antigravity-cli\/)?skills\/[^/]+\/SKILL\.md$/))
        await skillFromMd(ctx, "gemini", path, "skill");
      // ---- opencode
      else if (at(/(^|\/)opencode\.jsonc?$/)) await opencodeJson(ctx, path);
      else if (at(/(^|\/)(\.opencode|\.config\/opencode)\/agents?\/.+\.md$/))
        await skillFromMd(ctx, "opencode", path, "agent");
      else if (at(/(^|\/)(\.opencode|\.config\/opencode)\/commands?\/.+\.md$/))
        await skillFromMd(ctx, "opencode", path, "command");
      else if (at(/(^|\/)\.config\/opencode\/AGENTS\.md$/))
        instructions(ctx, "opencode", path, await ctx.text(path));
      // ---- Hermes
      else if (at(/(^|\/)\.hermes\/(profiles\/[^/]+\/)?config\.yaml$/)) await hermesYaml(ctx, path);
      else if (at(/(^|\/)\.hermes\/(profiles\/[^/]+\/)?SOUL\.md$/))
        instructions(ctx, "hermes", path, await ctx.text(path));
      else if (at(/(^|\/)\.hermes\/(profiles\/[^/]+\/)?memories\/(MEMORY|USER)\.md$/))
        await hermesMemory(ctx, path);
      else if (at(/(^|\/)\.hermes\/(profiles\/[^/]+\/)?skills\/(?:.+\/)?[^/]+\/SKILL\.md$/))
        await skillFromMd(ctx, "hermes", path, "skill");
      // ---- shared names
      else if (at(/(^|\/)AGENTS(\.override)?\.md$/))
        instructions(ctx, "codex", path, await ctx.text(path));
      else if (at(/(^|\/)skills\/[^/]+\/SKILL\.md$/))
        await skillFromMd(ctx, "claude-code", path, "skill");
    } catch (err) {
      out.unreadable.push({
        from: path,
        why: (err as Error).message.split("\n")[0]?.slice(0, 200) ?? "unreadable",
      });
    }
  }
  for (const [dir, list] of claudeMemoryDirs) {
    try {
      await claudeMemory(ctx, list);
    } catch (err) {
      out.unreadable.push({ from: dir, why: (err as Error).message.slice(0, 200) });
    }
  }
  // The same file found twice (a project also under the home): one is enough.
  const seen = new Set<string>();
  out.candidates = out.candidates.filter((c) => {
    const key = `${c.kind}\u0000${c.name}\u0000${c.kind === "mcp" || c.kind === "conversation" ? "" : (c.text ?? c.preview)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return out;
}

/**
 * Whether a path is one the readers look at (what a scan or a picked folder keeps). Chat exports
 * (`conversations*.json`, `memories.json`, `projects.json`) count too.
 */
export function wanted(path: string): boolean {
  return (
    /(^|\/)(CLAUDE(\.local)?|AGENTS(\.override)?|GEMINI|SOUL)\.md$/.test(path) ||
    /(^|\/)(\.mcp\.json|\.claude\.json|\.cursorrules|opencode\.jsonc?)$/.test(path) ||
    /(^|\/)\.claude\/(skills|commands|agents|rules)\//.test(path) ||
    /(^|\/)\.claude\/settings(\.local)?\.json$/.test(path) ||
    /(^|\/)\.claude\/projects\/[^/]+\/memory\/[^/]+\.md$/.test(path) ||
    /(^|\/)\.codex\/(config\.toml|prompts\/|skills\/|memories(_v2)?\/(MEMORY|memory_summary)\.md)/.test(
      path,
    ) ||
    /(^|\/)\.agents\/(skills\/|mcp_config\.json)/.test(path) ||
    /(^|\/)\.cursor\/(rules|commands|skills)\//.test(path) ||
    /(^|\/)\.cursor\/mcp\.json$/.test(path) ||
    /(^|\/)\.gemini\/(settings\.json|config\/mcp_config\.json|commands\/|skills\/|antigravity-cli\/skills\/)/.test(
      path,
    ) ||
    /(^|\/)\.gemini\/tmp\/[^/]+\/memory\/MEMORY\.md$/.test(path) ||
    /(^|\/)(\.opencode|\.config\/opencode)\/(agents?|commands?)\//.test(path) ||
    /(^|\/)\.hermes\/(profiles\/[^/]+\/)?(config\.yaml|memories\/|skills\/)/.test(path) ||
    /(^|\/)skills\/[^/]+\/.+/.test(path) ||
    /(^|\/)(conversations(-\d+)?|memories|projects|users)\.json$/.test(path)
  );
}

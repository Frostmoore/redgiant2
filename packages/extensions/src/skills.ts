import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tool } from "@redgiant/agent";
import { LocalWorkspace } from "@redgiant/tools";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

export interface Skill {
  name: string;
  description: string;
  body: string;
  dir: string;
  scope: "platform" | "project";
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  /** The spec's `allowed-tools` (space-separated, experimental): kept, not enforced. */
  allowedTools?: string;
}

/**
 * A skill's name (agentskills.io): 1-64 lowercase letters, digits and hyphens, no hyphen at
 * either end and no "--". It is also the name of the skill's folder.
 */
export const NAME_RE = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const DESCRIPTION_MAX = 1024;
export const COMPATIBILITY_MAX = 500;

/** The front matter fields of the agentskills.io standard (the optional ones only when present). */
export interface SkillMeta {
  name?: string | undefined;
  description?: string | undefined;
  license?: string | undefined;
  compatibility?: string | undefined;
  metadata?: Record<string, string> | undefined;
  allowedTools?: string | undefined;
}

/**
 * `---\n<YAML front matter>\n---\nbody` (the SKILL.md format). Invalid YAML yields `error`
 * and no fields; a file without front matter is all body.
 */
export function parseSkillMd(md: string): SkillMeta & { body: string; error?: string } {
  const m = md.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  if (!m) return { body: md };
  // The blank line after the front matter is formatting, not content.
  const body = (m[2] ?? "").replace(/^(\s*\r?\n)+/, "");
  let doc: unknown;
  try {
    doc = parseYaml(m[1] ?? "");
  } catch (err) {
    return { body, error: `Invalid YAML front matter: ${(err as Error).message.split("\n")[0]}` };
  }
  if (doc == null) return { body };
  if (typeof doc !== "object" || Array.isArray(doc))
    return { body, error: "The front matter must be a mapping" };
  const meta = doc as Record<string, unknown>;
  const str = (v: unknown) =>
    typeof v === "string"
      ? v
      : typeof v === "number" || typeof v === "boolean"
        ? String(v)
        : undefined;
  const out: SkillMeta & { body: string } = { body };
  const name = str(meta.name);
  const description = str(meta.description);
  const license = str(meta.license);
  const compatibility = str(meta.compatibility);
  const allowed = meta["allowed-tools"];
  if (name !== undefined) out.name = name;
  if (description !== undefined) out.description = description;
  if (license !== undefined) out.license = license;
  if (compatibility !== undefined) out.compatibility = compatibility;
  if (typeof allowed === "string") out.allowedTools = allowed;
  else if (Array.isArray(allowed)) out.allowedTools = allowed.map(String).join(" ");
  if (meta.metadata && typeof meta.metadata === "object" && !Array.isArray(meta.metadata)) {
    out.metadata = Object.fromEntries(
      Object.entries(meta.metadata as Record<string, unknown>)
        .filter(([, v]) => v != null && typeof v !== "object")
        .map(([k, v]) => [k, String(v)]),
    );
  }
  return out;
}

/** What is wrong with a parsed SKILL.md (the standard's rules), or undefined. */
export function skillProblem(
  p: SkillMeta & { error?: string },
  folder?: string,
): string | undefined {
  if (p.error) return p.error;
  if (!p.name) return "The front matter has no name";
  if (!NAME_RE.test(p.name))
    return `"${p.name}" is not a valid skill name (1-64 lowercase letters, digits and single hyphens)`;
  if (folder !== undefined && p.name !== folder)
    return `The name "${p.name}" does not match the folder "${folder}"`;
  if (!p.description?.trim()) return "The front matter has no description";
  if (p.description.length > DESCRIPTION_MAX)
    return `The description is longer than ${DESCRIPTION_MAX} characters`;
  if (p.compatibility !== undefined && p.compatibility.length > COMPATIBILITY_MAX)
    return `The compatibility field is longer than ${COMPATIBILITY_MAX} characters`;
  return undefined;
}

/** SKILL.md with YAML front matter: the library quotes whatever needs quoting. */
export const renderSkillMd = (
  s: SkillMeta & { name: string; description: string; body: string },
) => {
  const meta: Record<string, unknown> = {
    name: s.name,
    // One line: the index the model sees lists one skill per line.
    description: s.description.replace(/\s*\r?\n\s*/g, " ").trim(),
  };
  if (s.license !== undefined) meta.license = s.license;
  if (s.compatibility !== undefined) meta.compatibility = s.compatibility;
  if (s.metadata && Object.keys(s.metadata).length) meta.metadata = s.metadata;
  if (s.allowedTools !== undefined) meta["allowed-tools"] = s.allowedTools;
  return `---\n${stringifyYaml(meta, { lineWidth: 0 })}---\n\n${s.body.trim()}\n`;
};

/**
 * Skills under `<root>/skills/<name>/SKILL.md`; a project's override the platform's of the same
 * name. A skill whose front matter names another folder, or breaks the standard, is skipped.
 */
export async function loadSkills(
  roots: { dir: string; scope: Skill["scope"] }[],
  warn: (message: string) => void = (m) => console.warn(`[skills] ${m}`),
): Promise<Skill[]> {
  const byName = new Map<string, Skill>();
  for (const root of roots) {
    const base = join(root.dir, "skills");
    for (const name of await readdir(base).catch(() => [] as string[])) {
      if (!NAME_RE.test(name)) continue;
      const md = await readFile(join(base, name, "SKILL.md"), "utf8").catch(() => undefined);
      if (!md) continue;
      const p = parseSkillMd(md);
      // Older skills may lack the name: the folder gives it.
      const problem = skillProblem({ ...p, name: p.name ?? name }, name);
      if (problem) {
        warn(`${join(base, name)} skipped: ${problem}`);
        continue;
      }
      byName.set(name, {
        name,
        description: p.description ?? "",
        body: p.body,
        dir: join(base, name),
        scope: root.scope,
        ...(p.license !== undefined && { license: p.license }),
        ...(p.compatibility !== undefined && { compatibility: p.compatibility }),
        ...(p.metadata && { metadata: p.metadata }),
        ...(p.allowedTools !== undefined && { allowedTools: p.allowedTools }),
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Case-insensitive term scoring over names, descriptions and bodies: a term in the name weighs
 * most, then the description, then each mention in the body (capped). Ties go by name.
 */
export function searchSkills(
  skills: Skill[],
  query: string,
  limit = 5,
): { skill: Skill; score: number }[] {
  const words = (s: string) =>
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
  const terms = [...new Set(words(query))];
  if (terms.length === 0) return [];
  // A term matches the words it begins ("pdf" finds "PDFs", "voice" does not find "invoices").
  const hits = (ws: string[], t: string) => ws.filter((w) => w.startsWith(t)).length;
  return skills
    .map((skill) => {
      const name = words(skill.name);
      const desc = words(skill.description);
      const body = words(skill.body);
      let score = 0;
      for (const t of terms) {
        if (hits(name, t)) score += 10;
        if (hits(desc, t)) score += 4;
        score += Math.min(hits(body, t), 5);
      }
      return { skill, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, limit);
}

/**
 * The index the model sees at session start (names and descriptions only: progressive
 * disclosure). Sorted and fixed for the session, so the cached prefix holds.
 */
export function skillsIndex(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return [
    "## Skills",
    "Load a skill with skill_load before doing what it covers; read its other files with skill_file.",
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join("\n");
}

export function skillTools(skills: Skill[]): Tool[] {
  if (skills.length === 0) return [];
  const find = (name: string) => {
    const s = skills.find((x) => x.name === name);
    if (!s)
      throw new Error(`No skill "${name}". Available: ${skills.map((x) => x.name).join(", ")}`);
    return s;
  };
  return [
    {
      def: {
        name: "skill_load",
        description: "Load the full instructions of a skill listed in your system prompt.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      schema: z.object({ name: z.string() }),
      async run({ name }: { name: string }) {
        const s = find(name);
        const files = (await new LocalWorkspace(s.dir, true).glob("**/*")).filter(
          (f) => f !== "SKILL.md",
        );
        return `${s.body}${files.length ? `\n\nFiles of this skill (read them with skill_file): ${files.join(", ")}` : ""}`;
      },
    } as Tool,
    {
      def: {
        name: "skill_file",
        description: "Read a file that belongs to a skill.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, path: { type: "string" } },
          required: ["name", "path"],
        },
      },
      schema: z.object({ name: z.string(), path: z.string() }),
      async run({ name, path }: { name: string; path: string }) {
        return new LocalWorkspace(find(name).dir, true).readText(path);
      },
    } as Tool,
    {
      def: {
        name: "skill_search",
        description:
          "Search your skills by words (names, descriptions and instructions); returns the best matches with their descriptions.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 20 },
          },
          required: ["query"],
        },
      },
      schema: z.object({ query: z.string(), limit: z.number().int().min(1).max(20).optional() }),
      async run({ query, limit }: { query: string; limit?: number }) {
        const hits = searchSkills(skills, query, limit ?? 5);
        if (hits.length === 0)
          return `No skill matches "${query}". Available: ${skills.map((x) => x.name).join(", ")}`;
        return hits.map((h) => `- ${h.skill.name}: ${h.skill.description}`).join("\n");
      },
    } as Tool,
  ];
}

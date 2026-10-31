import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tool } from "@redgiant/agent";
import { LocalWorkspace } from "@redgiant/tools";
import { z } from "zod";

export interface Skill {
  name: string;
  description: string;
  body: string;
  dir: string;
  scope: "platform" | "project";
}

export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

/** `---\nname: x\ndescription: y\n---\nbody` (Anthropic's SKILL.md format). */
export function parseSkillMd(md: string): { name?: string; description?: string; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { body: md };
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kv?.[1]) meta[kv[1]] = (kv[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return {
    ...(meta.name && { name: meta.name }),
    ...(meta.description && { description: meta.description }),
    // The blank line after the front matter is formatting, not content.
    body: (m[2] ?? "").replace(/^(\s*\r?\n)+/, ""),
  };
}

export const renderSkillMd = (s: { name: string; description: string; body: string }) =>
  `---\nname: ${s.name}\ndescription: ${s.description.replace(/\n/g, " ")}\n---\n\n${s.body.trim()}\n`;

/** Skills under `<root>/skills/<name>/SKILL.md`; a project's override the platform's of the same name. */
export async function loadSkills(
  roots: { dir: string; scope: Skill["scope"] }[],
): Promise<Skill[]> {
  const byName = new Map<string, Skill>();
  for (const root of roots) {
    const base = join(root.dir, "skills");
    for (const name of await readdir(base).catch(() => [] as string[])) {
      if (!NAME_RE.test(name)) continue;
      const md = await readFile(join(base, name, "SKILL.md"), "utf8").catch(() => undefined);
      if (!md) continue;
      const p = parseSkillMd(md);
      byName.set(name, {
        name,
        description: p.description ?? "",
        body: p.body,
        dir: join(base, name),
        scope: root.scope,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
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
  ];
}

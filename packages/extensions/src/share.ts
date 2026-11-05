import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { parseSkillMd, skillProblem } from "./skills.js";

/** Limits for a shared skill: the archive, its unpacked files and how many there are. */
export const SKILL_ARCHIVE_LIMITS = {
  archiveBytes: 10 * 1024 * 1024,
  unpackedBytes: 50 * 1024 * 1024,
  files: 1000,
};

export class SkillArchiveError extends Error {}
/** A skill of the same name is already installed and `replace` was not asked. */
export class SkillExistsError extends SkillArchiveError {}

/**
 * A skill's folder as a .zip with the folder at the top (`<name>/SKILL.md`, `<name>/...`), the
 * layout the agentskills.io tools share. Symbolic links are left out.
 */
export async function exportSkill(dir: string): Promise<Buffer> {
  const name = basename(dir);
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  const walk = async (rel: string) => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path);
      else if (e.isFile()) {
        const data = await readFile(join(dir, path));
        total += data.length;
        if (total > SKILL_ARCHIVE_LIMITS.unpackedBytes)
          throw new SkillArchiveError("The skill is too large to share");
        files[`${name}/${path}`] = data;
      }
    }
  };
  await walk("");
  if (!files[`${name}/SKILL.md`]) throw new SkillArchiveError("The folder has no SKILL.md");
  return Buffer.from(zipSync(files, { level: 6, mtime: new Date("2000-01-01T00:00:00Z") }));
}

/** A path inside the archive that is safe to write under the skill's folder, or an error. */
function safePath(raw: string): string {
  if (raw.includes("\0") || raw.includes("\\")) throw new SkillArchiveError(`Bad path "${raw}"`);
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw))
    throw new SkillArchiveError(`Absolute path "${raw}"`);
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === ".."))
    throw new SkillArchiveError(`Path "${raw}" leaves the skill's folder`);
  return parts.join("/");
}

/**
 * Unpacks a shared skill into `<targetRoot>/skills/<name>`, after checking it: a valid
 * SKILL.md (the standard's rules, name equal to the folder's), no path outside the folder,
 * within the size limits. An existing skill of the same name stays unless `replace`.
 */
export async function importSkill(
  archive: Uint8Array,
  targetRoot: string,
  o: { replace?: boolean } = {},
): Promise<{ name: string; description: string; dir: string; replaced: boolean }> {
  if (archive.length > SKILL_ARCHIVE_LIMITS.archiveBytes)
    throw new SkillArchiveError("The archive is too large");
  let declared = 0;
  let count = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archive, {
      filter: (f) => {
        if (f.name.endsWith("/")) return false;
        count++;
        declared += f.originalSize;
        if (count > SKILL_ARCHIVE_LIMITS.files) throw new SkillArchiveError("Too many files");
        if (declared > SKILL_ARCHIVE_LIMITS.unpackedBytes)
          throw new SkillArchiveError("The unpacked skill is too large");
        return true;
      },
    });
  } catch (err) {
    if (err instanceof SkillArchiveError) throw err;
    throw new SkillArchiveError(`Not a valid .zip archive: ${(err as Error).message}`);
  }
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const [raw, data] of Object.entries(entries)) {
    total += data.length;
    if (total > SKILL_ARCHIVE_LIMITS.unpackedBytes)
      throw new SkillArchiveError("The unpacked skill is too large");
    const path = safePath(raw);
    if (path && !path.split("/").some((p) => p === "__MACOSX" || p === ".DS_Store"))
      files.set(path, data);
  }
  // Either SKILL.md at the top, or one folder holding it (the usual layout).
  let folder: string | undefined;
  if (!files.has("SKILL.md")) {
    const tops = new Set([...files.keys()].map((p) => p.split("/")[0] ?? ""));
    const [top] = tops;
    if (tops.size !== 1 || top === undefined || !files.has(`${top}/SKILL.md`))
      throw new SkillArchiveError("The archive has no SKILL.md");
    folder = top;
  }
  const inside = new Map<string, Uint8Array>();
  for (const [p, data] of files) inside.set(folder ? p.slice(folder.length + 1) : p, data);
  const md = new TextDecoder("utf-8", { fatal: false }).decode(inside.get("SKILL.md"));
  const meta = parseSkillMd(md);
  const problem = skillProblem(meta, folder);
  if (problem) throw new SkillArchiveError(`SKILL.md: ${problem}`);
  const name = meta.name as string;

  const skillsDir = join(targetRoot, "skills");
  const dir = join(skillsDir, name);
  const exists = await lstat(dir).then(
    () => true,
    () => false,
  );
  if (exists && !o.replace) throw new SkillExistsError(`A skill named "${name}" already exists`);
  // Written aside first (a dot folder, which loadSkills ignores), then moved in place.
  const tmp = join(skillsDir, `.import-${randomUUID().slice(0, 8)}`);
  try {
    for (const [p, data] of inside) {
      const target = join(tmp, p);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }
    if (exists) await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
  return { name, description: meta.description ?? "", dir, replaced: exists };
}

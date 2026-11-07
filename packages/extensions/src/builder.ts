import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventStore, SqlClient } from "@redgiant/events";
import { LocalWorkspace, type Workspace } from "@redgiant/tools";
import { z } from "zod";
import { CustomToolSpec, RESERVED, runCustomTool, ToolTest } from "./customtools.js";
import {
  COMPATIBILITY_MAX,
  DESCRIPTION_MAX,
  loadSkills,
  NAME_RE,
  renderSkillMd,
  type Skill,
} from "./skills.js";

export const ProposalInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool"),
    spec: CustomToolSpec,
    files: z.record(z.string(), z.string()).default({}),
    tests: z.array(ToolTest).min(1, "A tool needs at least one test"),
  }),
  z.object({
    kind: z.literal("skill"),
    name: z
      .string()
      .regex(NAME_RE, "1-64 lowercase letters, digits and single hyphens, no hyphen at either end"),
    description: z.string().min(10).max(DESCRIPTION_MAX),
    body: z.string().min(20),
    /** Optional agentskills.io fields, written to SKILL.md when present. */
    license: z.string().min(1).max(200).optional(),
    compatibility: z.string().min(1).max(COMPATIBILITY_MAX).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    allowedTools: z.string().min(1).max(1000).optional(),
    files: z.record(z.string(), z.string()).default({}),
    /** Commands that must exit 0 in a folder holding the skill's files. */
    tests: z.array(z.object({ command: z.string().min(1) })).default([]),
    /** Required when there are no tests (RD17): why the skill cannot be tested. */
    untestableReason: z.string().min(20).optional(),
    /**
     * G36.8: a short account of where the skill comes from (the problem and what worked), shown
     * to the person beside the proposal.
     */
    summary: z.string().min(1).max(2000).optional(),
    /** G36.8: this changes the installed skill of the same name instead of adding one. */
    updates: z.boolean().optional(),
  }),
]);
export type ProposalInput = z.input<typeof ProposalInput>;

export interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

export type ProposalStatus = "failed" | "pending" | "installed" | "rejected";

export interface Proposal {
  id: string;
  ownerId: string;
  projectId: string | null;
  kind: "tool" | "skill";
  name: string;
  author: string;
  input: z.output<typeof ProposalInput>;
  status: ProposalStatus;
  report: TestResult[];
  createdAt: string;
  decidedBy: string | null;
  /** G36.8: the installed skill an update would replace, as it is now (for the comparison). */
  previous: { skillMd: string; files: string[] } | null;
}

export async function migrateExtensions(db: SqlClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_proposals (
      id         text PRIMARY KEY,
      owner_id   text NOT NULL,
      project_id text,
      kind       text NOT NULL,
      name       text NOT NULL,
      author     text NOT NULL,
      input      jsonb NOT NULL,
      status     text NOT NULL,
      report     jsonb NOT NULL DEFAULT '[]',
      created_at timestamptz NOT NULL DEFAULT now(),
      decided_by text
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_mcp_servers (
      owner_id   text NOT NULL,
      name       text NOT NULL,
      project_id text,
      transport  jsonb NOT NULL,
      PRIMARY KEY (owner_id, name)
    )`);
  // G36.8: the installed skill an update replaces, kept for the person's comparison.
  await db.query("ALTER TABLE rg_proposals ADD COLUMN IF NOT EXISTS previous jsonb");
}

interface Row {
  id: string;
  owner_id: string;
  project_id: string | null;
  kind: "tool" | "skill";
  name: string;
  author: string;
  input: unknown;
  status: ProposalStatus;
  report: unknown;
  created_at: Date | string;
  decided_by: string | null;
  previous?: unknown;
}
const parse = <T>(v: unknown) => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));
const fromRow = (r: Row): Proposal => ({
  id: r.id,
  ownerId: r.owner_id,
  projectId: r.project_id,
  kind: r.kind,
  name: r.name,
  author: r.author,
  input: parse(r.input),
  status: r.status,
  report: parse(r.report),
  createdAt: new Date(r.created_at).toISOString(),
  decidedBy: r.decided_by,
  previous: r.previous ? parse(r.previous) : null,
});

export interface BuilderOptions {
  db: SqlClient;
  store: EventStore;
  /** A fresh, isolated workspace to test a proposal in (a sandbox); removed afterwards. */
  testWorkspace: (
    proposalId: string,
  ) => Promise<{ workspace: Workspace; dispose: () => Promise<void> }>;
  /** Where approved extensions go: the platform's directory or the project's `.redgiant`. */
  installRoot: (ownerId: string, projectId: string | null) => Promise<string>;
  /**
   * G36.8: every folder whose skills an agent of that project sees (the platform's and the
   * project's), to find a proposal that repeats one. Default: the install root only.
   */
  skillRoots?: (
    ownerId: string,
    projectId: string | null,
  ) => Promise<{ dir: string; scope: Skill["scope"] }[]>;
}

/**
 * Agents propose tools and skills; the builder tests them in a sandbox; the human approves
 * (RD20). A proposal never becomes available by itself: a *permission* lives with a
 * session, a *proposal* waits, on disk, for as long as it takes.
 */
export class ExtensionBuilder {
  constructor(private readonly o: BuilderOptions) {}

  async propose(o: {
    ownerId: string;
    projectId: string | null;
    author: string;
    input: ProposalInput;
    autoInstall?: boolean;
  }): Promise<Proposal> {
    const input = ProposalInput.parse(o.input);
    const name = input.kind === "tool" ? input.spec.name : input.name;
    if (input.kind === "tool" && RESERVED.has(name)) throw new Error(`"${name}" is reserved`);
    if (input.kind === "skill" && input.tests.length === 0 && !input.untestableReason) {
      throw new Error("A skill without tests needs untestableReason (why it cannot be tested)");
    }
    // G36.8: an agent's skill that repeats an installed one becomes an update to it, never a twin.
    let previous: Proposal["previous"] = null;
    if (input.kind === "skill" && o.author !== "human") {
      const skills = await this.visibleSkills(o.ownerId, o.projectId);
      const same = skills.find((s) => s.name === input.name);
      if (same) previous = await readSkill(same.dir);
      else if (input.updates)
        throw new Error(
          `There is no skill "${input.name}" to update: use the name of an installed skill (skill_search finds it), or leave updates out for a new one.`,
        );
      else {
        const like = similarSkill(input, skills);
        if (like)
          throw new Error(
            `A skill like this is already installed: "${like.name}" (${like.description}). Load it with skill_load and propose an update to it (name "${like.name}", updates true) instead of a new skill; if yours is truly different, give it a name and description that say how.`,
          );
      }
    }
    const id = `prop_${randomUUID().slice(0, 8)}`;
    const report = await this.test(id, input);
    const passed = report.every((r) => r.passed);
    // Code never installs by itself (G29.4, G36.8): an agent's skill with scripts waits too.
    const scripts = input.kind === "skill" && o.author !== "human" ? scriptFiles(input.files) : [];
    let status: ProposalStatus = !passed
      ? "failed"
      : o.autoInstall && scripts.length === 0
        ? "installed"
        : "pending";
    if (passed && o.autoInstall && scripts.length > 0)
      report.push({
        name: "scripts",
        passed: true,
        detail: `It has scripts (${scripts.join(", ")}): code never installs by itself, it waits for the user's approval.`,
      });
    // An agent's skill installed by itself (G29.4) never replaces one that exists: that waits.
    if (status === "installed" && o.author !== "human" && (await this.exists(o, input))) {
      status = "pending";
      report.push({
        name: "existing skill",
        passed: true,
        detail: `A skill named "${name}" is already installed: replacing it waits for the user's approval.`,
      });
    }
    // "installed" is recorded only once the files are in place.
    if (status === "installed") {
      try {
        await this.install(o.ownerId, o.projectId, input);
      } catch (err) {
        status = "failed";
        report.push({ name: "install", passed: false, detail: (err as Error).message });
      }
    }
    await this.o.db.query(
      "INSERT INTO rg_proposals (id, owner_id, project_id, kind, name, author, input, status, report, previous) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [
        id,
        o.ownerId,
        o.projectId,
        input.kind,
        name,
        o.author,
        JSON.stringify(input),
        status,
        JSON.stringify(report),
        previous ? JSON.stringify(previous) : null,
      ],
    );
    // A newer proposal of the same skill takes the place of the one still waiting (G36.8).
    if (input.kind === "skill" && status !== "failed")
      await this.o.db.query(
        "UPDATE rg_proposals SET status = 'rejected', decided_by = $4 WHERE owner_id = $1 AND kind = 'skill' AND name = $2 AND status = 'pending' AND id <> $3 AND author <> 'human'",
        [o.ownerId, name, id, `superseded:${id}`],
      );
    await this.o.store.append({
      ownerId: o.ownerId,
      projectId: o.projectId,
      agentId: o.author === "human" ? null : o.author,
      body: {
        type: "extension.proposed",
        payload: {
          proposalId: id,
          kind: input.kind,
          name,
          author: o.author,
          status: status === "installed" ? "installed" : status === "failed" ? "failed" : "pending",
        },
      },
    });
    return (await this.get(o.ownerId, id)) as Proposal;
  }

  private async test(id: string, input: z.output<typeof ProposalInput>): Promise<TestResult[]> {
    const { workspace, dispose } = await this.o.testWorkspace(id);
    try {
      if (input.kind === "tool") {
        const results: TestResult[] = [];
        for (const [i, t] of input.tests.entries()) {
          const r = await runCustomTool(
            { spec: input.spec, files: input.files },
            workspace,
            t.input,
          );
          const okExit = r.exitCode === t.expectExitCode && !r.timedOut;
          const okOut =
            t.expectStdoutContains === undefined || r.stdout.includes(t.expectStdoutContains);
          results.push({
            name: `test ${i + 1}`,
            passed: okExit && okOut,
            detail: `exit ${r.timedOut ? "timeout" : r.exitCode}${okOut ? "" : `; stdout lacks ${JSON.stringify(t.expectStdoutContains)}`}\n${`${r.stdout}${r.stderr}`.slice(0, 2000)}`,
          });
        }
        return results;
      }
      for (const [path, content] of Object.entries(input.files))
        await workspace.writeText(path, content);
      if (input.tests.length === 0)
        return [
          { name: "no tests", passed: true, detail: `Not testable: ${input.untestableReason}` },
        ];
      const results: TestResult[] = [];
      for (const t of input.tests) {
        const r = await workspace.exec(t.command, { timeoutMs: 120_000 });
        results.push({
          name: t.command,
          passed: r.exitCode === 0 && !r.timedOut,
          detail: `exit ${r.exitCode}\n${`${r.stdout}${r.stderr}`.slice(0, 2000)}`,
        });
      }
      return results;
    } finally {
      await dispose();
    }
  }

  /** The skills an agent of that project sees (G36.8). */
  private async visibleSkills(ownerId: string, projectId: string | null): Promise<Skill[]> {
    const roots = this.o.skillRoots
      ? await this.o.skillRoots(ownerId, projectId)
      : [{ dir: await this.o.installRoot(ownerId, projectId), scope: "platform" as const }];
    return loadSkills(roots, () => {});
  }

  private async exists(
    o: { ownerId: string; projectId: string | null },
    input: z.output<typeof ProposalInput>,
  ): Promise<boolean> {
    const root = await this.o.installRoot(o.ownerId, o.projectId);
    const name = input.kind === "tool" ? input.spec.name : input.name;
    return lstat(join(root, input.kind === "tool" ? "tools" : "skills", name)).then(
      () => true,
      () => false,
    );
  }

  private async install(
    ownerId: string,
    projectId: string | null,
    input: z.output<typeof ProposalInput>,
  ) {
    const root = await this.o.installRoot(ownerId, projectId);
    const name = input.kind === "tool" ? input.spec.name : input.name;
    const dir = join(root, input.kind === "tool" ? "tools" : "skills", name);
    // An update (G36.8) keeps the files it does not rewrite (its scripts, its references).
    if (!(input.kind === "skill" && input.updates)) await rm(dir, { recursive: true, force: true });
    const ws = new LocalWorkspace(await mkdir(dir, { recursive: true }).then(() => dir));
    for (const [path, content] of Object.entries(input.files)) await ws.writeText(path, content);
    if (input.kind === "tool")
      await writeFile(join(dir, "tool.json"), JSON.stringify(input.spec, null, 2));
    else await writeFile(join(dir, "SKILL.md"), renderSkillMd(input));
  }

  async get(ownerId: string, id: string): Promise<Proposal | undefined> {
    const [r] = await this.o.db.query<Row>(
      "SELECT * FROM rg_proposals WHERE id = $1 AND owner_id = $2",
      [id, ownerId],
    );
    return r ? fromRow(r) : undefined;
  }

  async list(ownerId: string, status?: ProposalStatus): Promise<Proposal[]> {
    const rows = await this.o.db.query<Row>(
      `SELECT * FROM rg_proposals WHERE owner_id = $1${status ? " AND status = $2" : ""} ORDER BY created_at DESC`,
      status ? [ownerId, status] : [ownerId],
    );
    return rows.map(fromRow);
  }

  /** Only the human decides (the API refuses anything else). */
  async decide(
    ownerId: string,
    id: string,
    decision: "approve" | "reject",
    by: string,
  ): Promise<Proposal> {
    const p = await this.get(ownerId, id);
    if (!p) throw new Error(`No proposal "${id}"`);
    if (p.status !== "pending") throw new Error(`Proposal ${id} is ${p.status}, not pending`);
    if (decision === "approve") await this.install(ownerId, p.projectId, p.input);
    await this.o.db.query(
      "UPDATE rg_proposals SET status = $3, decided_by = $4 WHERE id = $1 AND owner_id = $2",
      [id, ownerId, decision === "approve" ? "installed" : "rejected", by],
    );
    await this.o.store.append({
      ownerId,
      projectId: p.projectId,
      body: { type: "extension.decided", payload: { proposalId: id, decision, by } },
    });
    return (await this.get(ownerId, id)) as Proposal;
  }
}

/** Files that run as code: by their extension or a `#!` line (G36.8). */
const SCRIPT_EXT =
  /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|mts|rb|pl|php|lua|exe|dll|so|dylib)$/i;
export function scriptFiles(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([path, content]) => SCRIPT_EXT.test(path) || content.startsWith("#!"))
    .map(([path]) => path)
    .sort();
}

const STOP = new Set(
  "the and for with that this when what from into your you are use using how not but all any can its one per via about after before over under then than them they their there these those which while where who will would should could may might must does doing done have has had was were been being skill skills".split(
    " ",
  ),
);
const keyWords = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => (w.length > 4 ? w.replace(/(ing|es|s)$/, "") : w)),
  );

/**
 * How alike two skills are, from 0 to 1 (G36.8): the shared words of their names and
 * descriptions over all their words.
 */
export function skillLikeness(
  a: { name: string; description: string },
  b: { name: string; description: string },
): number {
  const wa = keyWords(`${a.name.replace(/-/g, " ")} ${a.description}`);
  const wb = keyWords(`${b.name.replace(/-/g, " ")} ${b.description}`);
  if (wa.size === 0 || wb.size === 0) return 0;
  let both = 0;
  for (const w of wa) if (wb.has(w)) both++;
  const jaccard = both / (wa.size + wb.size - both);
  const na = keyWords(a.name.replace(/-/g, " "));
  const nb = keyWords(b.name.replace(/-/g, " "));
  const sameName = na.size > 0 && [...na].every((w) => nb.has(w)) && na.size === nb.size;
  return sameName ? Math.max(jaccard, 0.9) : jaccard;
}

/** The installed skill a new one would repeat, if any (G36.8). */
export function similarSkill(
  input: { name: string; description: string },
  skills: Skill[],
  threshold = 0.5,
): Skill | undefined {
  let best: { skill: Skill; score: number } | undefined;
  for (const skill of skills) {
    const score = skillLikeness(input, skill);
    if (score >= threshold && (!best || score > best.score)) best = { skill, score };
  }
  return best?.skill;
}

/** An installed skill as it is now: its SKILL.md and the names of its other files. */
async function readSkill(dir: string): Promise<{ skillMd: string; files: string[] }> {
  const skillMd = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => "");
  const files: string[] = [];
  const walk = async (rel: string) => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path);
      else if (path !== "SKILL.md") files.push(path);
    }
  };
  await walk("");
  return { skillMd, files: files.sort() };
}

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EventStore, SqlClient } from "@redgiant/events";
import { LocalWorkspace, type Workspace } from "@redgiant/tools";
import { z } from "zod";
import { CustomToolSpec, RESERVED, runCustomTool, ToolTest } from "./customtools.js";
import { NAME_RE, renderSkillMd } from "./skills.js";

export const ProposalInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool"),
    spec: CustomToolSpec,
    files: z.record(z.string(), z.string()).default({}),
    tests: z.array(ToolTest).min(1, "A tool needs at least one test"),
  }),
  z.object({
    kind: z.literal("skill"),
    name: z.string().regex(NAME_RE),
    description: z.string().min(10),
    body: z.string().min(20),
    files: z.record(z.string(), z.string()).default({}),
    /** Commands that must exit 0 in a folder holding the skill's files. */
    tests: z.array(z.object({ command: z.string().min(1) })).default([]),
    /** Required when there are no tests (RD17): why the skill cannot be tested. */
    untestableReason: z.string().min(20).optional(),
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
    const id = `prop_${randomUUID().slice(0, 8)}`;
    const report = await this.test(id, input);
    const passed = report.every((r) => r.passed);
    const status: ProposalStatus = !passed ? "failed" : o.autoInstall ? "installed" : "pending";
    await this.o.db.query(
      "INSERT INTO rg_proposals (id, owner_id, project_id, kind, name, author, input, status, report) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
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
      ],
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
    if (status === "installed") await this.install(o.ownerId, o.projectId, input);
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

  private async install(
    ownerId: string,
    projectId: string | null,
    input: z.output<typeof ProposalInput>,
  ) {
    const root = await this.o.installRoot(ownerId, projectId);
    const name = input.kind === "tool" ? input.spec.name : input.name;
    const dir = join(root, input.kind === "tool" ? "tools" : "skills", name);
    await rm(dir, { recursive: true, force: true });
    const ws = new LocalWorkspace(await mkdir(dir, { recursive: true }).then(() => dir));
    for (const [path, content] of Object.entries(input.files)) await ws.writeText(path, content);
    if (input.kind === "tool")
      await writeFile(join(dir, "tool.json"), JSON.stringify(input.spec, null, 2));
    else await writeFile(join(dir, "SKILL.md"), renderSkillMd(input));
    void dirname;
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

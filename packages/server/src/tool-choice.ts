// The tools page (G34.5): which common tools the person switched off, for every agent or agent by
// agent, kept in rg_settings; and what each one weighs on every request (its name, description
// and schema, as the model receives them, with the profile of the agent's model).
import type { Tool } from "@redgiant/agent";
import type { SqlClient } from "@redgiant/events";
import {
  TOOL_CATALOG,
  ToolChoice,
  type ToolsView,
  type ToolView,
  toolEntryOf,
  toolEntryOn,
  toolTokens,
} from "@redgiant/protocol";
import type { Workspace } from "@redgiant/tools";

const KEY = "tools";

/** The person's choice of tools, one row per owner. */
export class ToolChoiceStore {
  constructor(private readonly db: SqlClient) {}

  async get(ownerId: string): Promise<ToolChoice> {
    const [row] = await this.db.query<{ value: unknown }>(
      "SELECT value FROM rg_settings WHERE owner_id = $1 AND key = $2",
      [ownerId, KEY],
    );
    if (!row) return { off: [], agents: {} };
    const v = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
    const parsed = ToolChoice.safeParse(v);
    return parsed.success ? parsed.data : { off: [], agents: {} };
  }

  async set(ownerId: string, choice: ToolChoice): Promise<void> {
    await this.db.query(
      `INSERT INTO rg_settings (owner_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [ownerId, KEY, JSON.stringify(ToolChoice.parse(choice))],
    );
  }
}

/** Characters a tool adds to every request: its definition as it is sent. */
export function toolChars(t: Pick<Tool, "def">): number {
  return JSON.stringify({
    name: t.def.name,
    description: t.def.description,
    input_schema: t.def.inputSchema,
  }).length;
}

/**
 * The page's entries from the tools measured (name → characters): only the entries some agent has,
 * in the catalog's order. With `agentId`, each one says what that agent gets.
 */
export function toolsView(
  choice: ToolChoice,
  measured: ReadonlyMap<string, number>,
  agentId: string | null,
): ToolsView {
  const byEntry = new Map<string, string[]>();
  for (const name of [...measured.keys()].sort()) {
    const e = toolEntryOf(name);
    if (!e) continue;
    byEntry.set(e.id, [...(byEntry.get(e.id) ?? []), name]);
  }
  const entries: ToolView[] = [];
  for (const e of TOOL_CATALOG) {
    const tools = byEntry.get(e.id);
    if (!tools) continue;
    const chars = tools.reduce((n, t) => n + (measured.get(t) ?? 0), 0);
    const essential = e.essential === true;
    entries.push({
      id: e.id,
      group: e.group,
      essential,
      tools,
      chars,
      tokens: toolTokens(chars),
      global: essential || !choice.off.includes(e.id),
      ...(agentId !== null && {
        own: essential ? null : (choice.agents[agentId]?.[e.id] ?? null),
        on: toolEntryOn(choice, agentId, e.id),
      }),
    });
  }
  const on = (v: ToolView) => (agentId === null ? v.global : v.on === true);
  return {
    agentId,
    entries,
    total: entries.filter(on).reduce((n, v) => n + v.tokens, 0),
    saved: entries.filter((v) => !on(v)).reduce((n, v) => n + v.tokens, 0),
  };
}

/**
 * A workspace that does nothing, for weighing an agent's tools without its sandbox (a dry build):
 * the tools are only described, never run.
 */
export function dryWorkspace(): Workspace {
  const no = () => Promise.reject(new Error("A dry workspace only describes tools"));
  return {
    root: "/workspace",
    readOnly: true,
    readText: no,
    writeText: no,
    exists: no,
    isFile: no,
    glob: no,
    exec: no,
    execFile: no,
    openTerminal: no,
  };
}

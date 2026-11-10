// The tools page (G34.5, decision of 2026-11-07): the person switches the common tools off, for
// every agent or agent by agent. The catalog names what can be chosen (one tool, or a family that
// only makes sense together, like the browser's); the tools a mechanism needs are essential and
// never switch off. What is off is computed when a conversation starts and stays fixed in it.
import { z } from "zod";

export const TOOL_GROUPS = [
  "files",
  "web",
  "memory",
  "credentials",
  "canvas",
  "talk",
  "agents",
  "platform",
] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

export interface ToolCatalogEntry {
  /** What the person switches: a tool's name, or a family's id. */
  id: string;
  group: ToolGroup;
  /** The tools it stands for (a family: every name starting with `prefix`). */
  tools?: readonly string[];
  prefix?: string;
  /** Never switched off: the mechanism that needs it (an i18n key's suffix). */
  essential?: boolean;
}

const one = (id: string, group: ToolGroup, essential = false): ToolCatalogEntry => ({
  id,
  group,
  ...(essential && { essential }),
});

/** Every built-in tool an agent can get, in the page's order. MCP, custom and skill tools are not here. */
export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  // The base of working on files: an agent that works in a project cannot do without them.
  one("read_file", "files", true),
  one("write_file", "files", true),
  one("edit_file", "files", true),
  one("bash", "files", true),
  // Background commands (p3.3.1) are part of bash: reading and stopping them goes with it.
  one("bash_output", "files", true),
  one("glob", "files"),
  one("grep", "files"),
  // Finding files and programs on the computer (p3.4.0): not essential, like glob and grep.
  one("find_files", "files"),
  one("update_todos", "files"),
  one("run_script", "files"),
  one("convert_file", "files"),
  one("edit_package", "files"),
  one("blender", "files"),
  { id: "repo", group: "files", prefix: "repo_" },
  one("fetch", "web"),
  one("web_search", "web"),
  { id: "browser", group: "web", prefix: "browser_" },
  one("memory", "memory"),
  // The person's documents (G36.5): only the collections the agent may read.
  one("search_knowledge", "memory"),
  // Making collections and adding their sources, and their state (3.5.3, decision «Gli agenti
  // possono creare tutto da sé»): what the person does on the Knowledge page.
  one("knowledge_create", "memory"),
  one("knowledge_add_source", "memory"),
  one("knowledge_status", "memory"),
  // After a summary the details of the conversation are only reachable through it.
  one("conversation_history", "memory", true),
  one("use_credential", "credentials"),
  one("request_connection", "credentials"),
  one("show_file", "canvas"),
  // Looking at the person's canvas and leafing through it (G36.12).
  one("canvas_look", "canvas"),
  one("canvas_act", "canvas"),
  // Editing an open file with the person (G37.1). Not essential: write_file and edit_file stay the
  // way to change files; this one is the shared editor's (visible, undoable, the person's lead).
  one("canvas_edit", "canvas"),
  one("show", "canvas"),
  one("view_image", "canvas"),
  one("send_file", "canvas"),
  one("publish_board", "canvas"),
  one("image_generation", "canvas"),
  one("video_generation", "canvas"),
  one("audio_generation", "canvas"),
  // Questions and plans: plan mode ends only through propose_plan.
  one("ask_user", "talk", true),
  // A switched-off tool comes back only through the person (G36.15): the way to ask must stay.
  one("request_tool", "talk", true),
  one("propose_plan", "talk", true),
  // Demi-God's one tool.
  one("ask_god", "talk", true),
  { id: "board", group: "talk", prefix: "board_" },
  one("ask_assistant", "talk"),
  one("ask_group", "talk"),
  one("propose_extension", "talk"),
  // Tasks (RD17): opened by delegate, closed only by complete_task; merge_work brings the work in.
  one("delegate", "agents", true),
  one("complete_task", "agents", true),
  one("merge_work", "agents", true),
  one("create_agent", "agents"),
  one("create_project", "agents"),
  one("list_agents", "agents"),
  one("read_agent", "agents"),
  one("stop_agent", "agents"),
  { id: "subagents", group: "agents", tools: ["run_subagent", "run_subagents"] },
  one("ask_inspector", "agents"),
  // A magic automation's conversation exists to propose one.
  one("propose_automation", "platform", true),
  one("platform_status", "platform"),
  one("platform_changes", "platform"),
  one("platform_configure_agent", "platform"),
  one("platform_set_budget", "platform"),
  one("platform_policy", "platform"),
  one("platform_automation", "platform"),
  one("platform_mcp", "platform"),
  one("platform_undo", "platform"),
  // Archiving and restoring a whole project (3.5.3), with the person's yes.
  one("platform_project", "platform"),
  { id: "platform_code", group: "platform", prefix: "platform_code_" },
];

const BY_ID = new Map(TOOL_CATALOG.map((e) => [e.id, e]));

/** The catalog entry a tool belongs to; none for MCP, custom and skill tools. */
export function toolEntryOf(name: string): ToolCatalogEntry | undefined {
  const own = BY_ID.get(name);
  if (own && !own.prefix && !own.tools) return own;
  return TOOL_CATALOG.find(
    (e) => e.tools?.includes(name) || (e.prefix !== undefined && name.startsWith(e.prefix)),
  );
}

export const toolCatalogEntry = (id: string) => BY_ID.get(id);

/** An agent's own choice for one entry: on even if off for everyone, or off. */
export const AgentToolState = z.enum(["on", "off"]);
export type AgentToolState = z.infer<typeof AgentToolState>;

/** What the person chose: entries off for every agent, and each agent's exceptions. */
export const ToolChoice = z.object({
  off: z.array(z.string()).default([]),
  agents: z.record(z.string(), z.record(z.string(), AgentToolState)).default({}),
});
export type ToolChoice = z.infer<typeof ToolChoice>;

export const EMPTY_TOOL_CHOICE: ToolChoice = { off: [], agents: {} };

/** Ids the choice cannot hold: unknown, or essential (never off). */
export function invalidToolIds(ids: readonly string[]): { unknown: string[]; essential: string[] } {
  const unknown = ids.filter((id) => !BY_ID.has(id));
  const essential = ids.filter((id) => BY_ID.get(id)?.essential === true);
  return { unknown, essential };
}

/**
 * Whether an entry is on for an agent: its own choice first, then the choice of the agent it works
 * for (`parentId`: a sub-agent is made per run and has no choice of its own, 3.5.3), then the rule
 * for everyone.
 */
export function toolEntryOn(
  choice: ToolChoice,
  agentId: string,
  id: string,
  parentId?: string | null,
): boolean {
  if (BY_ID.get(id)?.essential) return true;
  const own =
    choice.agents[agentId]?.[id] ?? (parentId ? choice.agents[parentId]?.[id] : undefined);
  if (own) return own === "on";
  return !choice.off.includes(id);
}

/**
 * The tools of `names` an agent does not get: those whose entry is off for it. Essential tools
 * and tools outside the catalog (MCP, custom, skills) are never in it.
 */
export function toolsSwitchedOff(
  choice: ToolChoice,
  agentId: string,
  names: readonly string[],
  parentId?: string | null,
): string[] {
  return names.filter((n) => {
    const e = toolEntryOf(n);
    return e !== undefined && !toolEntryOn(choice, agentId, e.id, parentId);
  });
}

/** One entry on the page: what it weighs on every request, and how it is set. */
export interface ToolView {
  id: string;
  group: ToolGroup;
  essential: boolean;
  /** The tools it stands for, as the model sees them. */
  tools: string[];
  /** Characters of names, descriptions and schemas, and the tokens they make (about 3.5 a token). */
  chars: number;
  tokens: number;
  /** On for every agent. */
  global: boolean;
  /** The agent's own choice (only in an agent's view). */
  own?: AgentToolState | null;
  /** What the agent gets (only in an agent's view). */
  on?: boolean;
  /**
   * In the view for every agent: the agents whose own choice differs from the rule for everyone
   * (3.5.3: an agent kept a switched-off tool on through its own choice, and the page did not say).
   */
  exceptions?: { agentId: string; name: string; state: AgentToolState }[];
}

export interface ToolsView {
  /** The agent this view is about; none for the page of every agent. */
  agentId: string | null;
  entries: ToolView[];
  /** Tokens on every request with what is on now, and what the switched off ones save. */
  total: number;
  saved: number;
}

/** Tokens from characters, as the summaries count them. */
export const toolTokens = (chars: number) => Math.ceil(chars / 3.5);

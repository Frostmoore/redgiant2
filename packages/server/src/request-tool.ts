// Asking for a switched-off tool (G36.15, the person: «se non ha strumenti per un determinato task,
// deve poterseli attivare chiedendo all'utente ... non gli diamo gli strumenti che non gli servono
// ma il nome dello strumento sì»). The agent sees the switched-off tools by name with one short
// line each; request_tool asks the person, as an approval (on Telegram too). Only a yes switches
// it on: a no, an error or the time running out is a no. "This conversation" adds it to the
// running session (the prefix is rebuilt once, recorded as session.tools_added); "always for this
// agent" is also a configuration change in the history, undoable.
import type { Tool, ToolContext } from "@redgiant/agent";
import { toolCatalogEntry, toolEntryOf } from "@redgiant/protocol";
import { z } from "zod";

/** How long the person has to answer before it counts as a no. */
export const REQUEST_TOOL_TIMEOUT_MS = 15 * 60_000;

/** The first sentence of a description, short. */
function firstLine(description: string): string {
  const s = description.split(/(?<=[.!?])\s/)[0] ?? description;
  return s.length > 90 ? `${s.slice(0, 87).trimEnd()}...` : s;
}

/** The catalog entries of some tools, each with the tools it stands for. */
function entries(tools: readonly Tool[]): Map<string, Tool[]> {
  const out = new Map<string, Tool[]>();
  for (const t of tools) {
    const id = toolEntryOf(t.def.name)?.id ?? t.def.name;
    out.set(id, [...(out.get(id) ?? []), t]);
  }
  return out;
}

/**
 * The system prompt's part on switched-off tools: each by name with what it does in a few words,
 * and how to ask for one. Fixed when the conversation starts, like the rest of the system prompt.
 */
export function switchedOffSection(names: readonly string[], aside: readonly Tool[]): string {
  const byEntry = entries(aside.filter((t) => names.includes(t.def.name)));
  const lines = [...byEntry]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, ts]) => `- ${id}: ${firstLine(ts[0]?.def.description ?? "")}`);
  return `## Tools switched off\nThese tools exist, but the person switched these tools off for you to keep requests small:\n${lines.join("\n")}\nIf the work really needs one, ask for it with request_tool (its name and why); do not work around it with other tools. Without the person's yes it stays off.`;
}

export type ToolRequestAnswer =
  | { allow: false; reason?: string }
  | { allow: true; scope: "session" | "agent" };

export interface RequestToolHost {
  /** Asks the person; resolves to a no on error, timeout or abort. */
  ask(
    input: { entry: string; tools: string[]; why: string },
    ctx: ToolContext,
  ): Promise<ToolRequestAnswer>;
  /** "Always for this agent": the configuration change (history, undoable). */
  keepOn(entry: string): Promise<void>;
  /** Adds the tools to this conversation (recorded first). */
  add(
    tools: Tool[],
    payload: { entry: string; why: string; scope: "session" | "agent" },
  ): Promise<void>;
}

const Input = z.object({ tool: z.string().min(1).max(100), why: z.string().min(1).max(1000) });

/** A host that is never asked: for weighing the tool's definition (the tools page). */
export const REQUEST_TOOL_DRY: RequestToolHost = {
  ask: async () => ({ allow: false }),
  keepOn: async () => {},
  add: async () => {},
};

/** request_tool for one conversation: `aside` are its switched-off tools, removed as they come back. */
export function requestTool(aside: Tool[], host: RequestToolHost): Tool {
  return {
    def: {
      name: "request_tool",
      description:
        "Ask the person to switch on one of your switched-off tools (listed in your instructions), saying why the work needs it. It waits for their answer.",
      inputSchema: {
        type: "object",
        properties: {
          tool: { type: "string", description: "its name, as listed" },
          why: { type: "string" },
        },
        required: ["tool", "why"],
      },
    },
    schema: Input,
    async run(i: z.infer<typeof Input>, ctx: ToolContext) {
      const wanted = toolCatalogEntry(i.tool)?.id ?? toolEntryOf(i.tool)?.id ?? i.tool;
      const group = entries(aside).get(wanted);
      if (!group?.length) {
        const off = [...entries(aside).keys()].sort();
        return {
          content: off.length
            ? `"${i.tool}" is not one of your switched-off tools. Switched off: ${off.join(", ")}.`
            : "None of your tools is switched off any more.",
          isError: true,
        };
      }
      let answer: ToolRequestAnswer;
      try {
        answer = await host.ask(
          { entry: wanted, tools: group.map((t) => t.def.name), why: i.why },
          ctx,
        );
      } catch {
        answer = { allow: false };
      }
      if (!answer.allow)
        return `The person did not switch ${wanted} on${answer.reason ? `: ${answer.reason}` : ""}. Carry on without it, or say plainly what you cannot do without it.`;
      if (answer.scope === "agent") await host.keepOn(wanted);
      for (const t of group) aside.splice(aside.indexOf(t), 1);
      await host.add(group, { entry: wanted, why: i.why, scope: answer.scope });
      return `${wanted} is on (${group.map((t) => t.def.name).join(", ")})${answer.scope === "agent" ? ", for this agent from now on" : ", for this conversation"}. You can use it from your next step.`;
    },
  } as Tool;
}

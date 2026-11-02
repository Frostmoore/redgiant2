import type { ImagePart } from "@redgiant/protocol";
import type { ToolDef } from "@redgiant/providers";
import type { z } from "zod";

export interface ToolContext {
  ownerId: string;
  projectId: string | null;
  agentId: string | null;
  sessionId: string;
  signal?: AbortSignal | undefined;
}

export type ToolOutput =
  | string
  | {
      content: string;
      isError?: boolean;
      /** Pictures for the model (a screenshot): they follow the results in the same message. */
      images?: ImagePart[];
    };

export interface Tool<I = unknown> {
  def: ToolDef;
  /** Validates the model's arguments before `run`; invalid input never reaches the tool. */
  schema?: z.ZodType<I>;
  run(input: I, ctx: ToolContext): Promise<ToolOutput>;
}

/** Tools sorted by name: the tool list is part of the cached prompt prefix and must not move. */
export function canonicalTools(tools: Tool[]): Tool[] {
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.def.name)) throw new Error(`Duplicate tool name "${t.def.name}"`);
    seen.add(t.def.name);
  }
  return [...tools].sort((a, b) =>
    a.def.name < b.def.name ? -1 : a.def.name > b.def.name ? 1 : 0,
  );
}

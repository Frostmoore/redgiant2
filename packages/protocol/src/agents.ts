import { z } from "zod";

/** Position of an agent in the hierarchy (see plan §5.2). */
export const AgentKind = z.enum(["god", "demigod", "orchestrator", "agent", "subagent"]);
export type AgentKind = z.infer<typeof AgentKind>;

/** Provider-independent reasoning effort; each provider adapter maps it to its own knobs. */
export const Effort = z.enum(["low", "medium", "high", "max"]);
export type Effort = z.infer<typeof Effort>;

export interface ModelSpec {
  provider: string;
  model: string;
  version?: string | undefined;
  effort?: Effort | undefined;
  fallback?: ModelSpec | undefined;
}

/** Model selection for an agent. Missing fields are inherited from the parent agent. */
export const ModelSpec: z.ZodType<ModelSpec> = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  version: z.string().min(1).optional(),
  effort: Effort.optional(),
  get fallback() {
    return ModelSpec.optional();
  },
});

/** Permission mode of an agent; decides who must approve an action, never which tools exist. */
export const PermissionMode = z.enum(["manual", "auto", "plan", "readonly"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const AgentSpec = z.object({
  id: z.string().min(1),
  kind: AgentKind,
  parentId: z.string().min(1).nullable(),
  projectId: z.string().min(1).nullable(),
  persistent: z.boolean(),
  name: z.string().min(1),
  role: z.string().optional(),
  systemPrompt: z.string().optional(),
  model: ModelSpec.optional(),
  mode: PermissionMode.optional(),
});
export type AgentSpec = z.infer<typeof AgentSpec>;

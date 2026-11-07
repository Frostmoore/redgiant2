// The instructions' refiner (G36.13, the person: «mettiamo anche un refiner del system prompt degli
// agenti con il modello che sceglie l'utente») and the instructions God writes for an agent made
// by hand (G36.14). One request shape for both: what is revised (`target`), how (`goal`), with
// which model. Nothing is ever saved by these requests: the person reads, then saves as always.
import { z } from "zod";
import { AgentKind, Effort, PermissionMode } from "./agents.js";

/** Whose instructions: an agent's, the everyday Chat's, the ones for every agent, or a new agent's. */
export const RefineTarget = z.union([
  z.object({ agentId: z.string().min(1) }),
  z.object({ chat: z.literal(true) }),
  z.object({ general: z.literal(true) }),
  /** An agent not made yet (the creation forms, the setup wizard's God). */
  z.object({
    draft: z.object({
      kind: AgentKind,
      name: z.string().max(80),
      /** What it does, in the person's words. */
      role: z.string().max(2000).optional(),
      projectId: z.string().optional(),
      mode: PermissionMode.optional(),
      /** Its own model, if the person chose one (a setting God may mention, never the writer). */
      model: z.string().max(200).optional(),
      /** The names typed in the setup wizard, before they are saved. */
      god: z.string().max(40).optional(),
      demigod: z.string().max(40).optional(),
    }),
  }),
]);
export type RefineTarget = z.infer<typeof RefineTarget>;

export const RefineRequest = z.object({
  target: RefineTarget,
  /**
   * `refine`: a better version of `text`, following `request` if given. `draft`: God writes the
   * instructions of an agent from the built-in ones, its job and its settings (`text` ignored).
   */
  goal: z.enum(["refine", "draft"]).default("refine"),
  /** The text as it is in the editor now (names, not placeholders). */
  text: z.string().max(100_000).default(""),
  /** What the person wants changed; empty: a general improvement. */
  request: z.string().max(4000).default(""),
  /** The model that writes; absent: God's (or the default one). */
  model: z
    .object({ provider: z.string().min(1), model: z.string().min(1), effort: Effort.optional() })
    .optional(),
  /** The language of the short explanation (the interface's). */
  lang: z.enum(["it", "en"]).default("en"),
});
export type RefineRequest = z.input<typeof RefineRequest>;

/** Before asking: about how much it takes. `usd` null when the model has no price (local, plans). */
export interface RefineEstimate {
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
  model: { provider: string; model: string };
  /** The text the model starts from, with the current names (a new agent: the built-in one). */
  base: string;
}

/** The revised text (with the names, as the editor shows it) and what changed, in short. */
export interface RefineResult {
  text: string;
  changes: string;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
  model: { provider: string; model: string };
  /**
   * A new agent's tools as God proposes them (G36.14): every entry the rule for everyone gives it,
   * on or off with why, and what each weighs on every request. Essential tools are not here.
   */
  tools?: { id: string; on: boolean; why: string; tokens: number }[];
}

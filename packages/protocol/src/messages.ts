import { z } from "zod";

export const UserPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_result"),
    callId: z.string(),
    content: z.string(),
    isError: z.boolean().optional(),
  }),
]);
export type UserPart = z.infer<typeof UserPart>;

export const AssistantPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), text: z.string() }),
  z.object({
    type: z.literal("tool_call"),
    callId: z.string(),
    name: z.string(),
    /** Parsed arguments, or `undefined` when the model produced invalid JSON. */
    input: z.unknown(),
    /** The raw argument string as produced by the model. */
    rawInput: z.string(),
  }),
]);
export type AssistantPart = z.infer<typeof AssistantPart>;

/**
 * Provider-native content of an assistant turn. Replayed verbatim to the same provider
 * (some providers bind thinking blocks to the model that produced them); other providers
 * rebuild the turn from the neutral parts.
 */
export const NativeContent = z.object({
  provider: z.string(),
  model: z.string(),
  content: z.unknown(),
});
export type NativeContent = z.infer<typeof NativeContent>;

export const StopReason = z.enum([
  "end_turn",
  "tool_use",
  "max_tokens",
  "refusal",
  "pause",
  "aborted",
  "other",
]);
export type StopReason = z.infer<typeof StopReason>;

export const ChatMessage = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), parts: z.array(UserPart) }),
  z.object({
    role: z.literal("assistant"),
    parts: z.array(AssistantPart),
    native: NativeContent.optional(),
  }),
]);
export type ChatMessage = z.infer<typeof ChatMessage>;

import { z } from "zod";

const count = z.number().int().nonnegative();
const ms = z.number().nonnegative();

/**
 * Per-message metrics shown in the message bar. Token counts come from the provider; timings
 * come from the server when it reports them (llama.cpp, Ollama) or are measured client-side
 * from the stream (`source: "client"`).
 */
export const MessageMetrics = z.object({
  startedAt: z.iso.datetime(),
  firstTokenAt: z.iso.datetime().optional(),
  endedAt: z.iso.datetime().optional(),
  inputTokens: count,
  cachedReadTokens: count.default(0),
  cacheWriteTokens: count.default(0),
  outputTokens: count,
  contextUsed: count,
  contextWindow: count.positive(),
  prefillMs: ms.optional(),
  decodeMs: ms.optional(),
  tokPerSec: z.number().nonnegative().optional(),
  source: z.enum(["server", "client"]),
});
export type MessageMetrics = z.infer<typeof MessageMetrics>;

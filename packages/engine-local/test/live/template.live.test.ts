import type { ChatMessage } from "@redgiant/protocol";
import { complete } from "@redgiant/providers";
import { describe, expect, it } from "vitest";
import { LocalEngineProvider } from "../../src/index.js";

/**
 * G24.14c: does a model's chat template keep old turns byte for byte? A reasoning model whose
 * template drops old reasoning makes every turn diverge from the cache at the last answer.
 *   REDGIANT_LIVE_LLAMACPP_URL=http://host:8080/v1 (llama.cpp started with --jinja)
 * Measures, at the third turn, how many prompt tokens had to be computed again.
 */
const env = process.env;

describe.skipIf(!env.REDGIANT_LIVE_LLAMACPP_URL)("live: chat template and the KV cache", () => {
  it("recomputes only the new turn", { timeout: 300_000 }, async () => {
    const run = async (replayReasoning: boolean) => {
      const p = new LocalEngineProvider({
        baseURL: env.REDGIANT_LIVE_LLAMACPP_URL ?? "",
        replayReasoning,
      });
      const key = `tpl-${replayReasoning}-${Date.now()}`;
      let history: ChatMessage[] = [];
      const computed: number[] = [];
      for (const q of ["Name a colour.", "Name a fruit of that colour.", "And a vegetable?"]) {
        history = [...history, { role: "user", parts: [{ type: "text", text: q }] }];
        const c = await complete(
          p.stream({
            model: "default",
            system: "Answer in five words.",
            tools: [],
            messages: history,
            cacheKey: key,
            maxTokens: 300,
          }),
        );
        computed.push(c.usage.inputTokens - c.usage.cachedReadTokens);
        history = [...history, { role: "assistant", parts: c.message.parts }];
      }
      return computed;
    };
    const withReasoning = await run(true);
    const without = await run(false);
    console.info(
      "computed per turn, reasoning sent back:",
      withReasoning,
      "\nnot sent back:",
      without,
    );
    // The third turn computes its own message and little more, never the whole history.
    expect(Math.min(withReasoning[2] ?? 0, without[2] ?? 0)).toBeLessThan(60);
  });
});

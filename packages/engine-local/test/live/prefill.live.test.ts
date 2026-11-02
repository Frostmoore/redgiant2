import type { ChatMessage } from "@redgiant/protocol";
import { complete } from "@redgiant/providers";
import { describe, expect, it } from "vitest";
import { KvStore, LocalEngineProvider } from "../../src/index.js";

/**
 * G24.14 against a real llama.cpp (started with --slot-save-path):
 *   REDGIANT_LIVE_LLAMACPP_URL=http://host:8080/v1  REDGIANT_LIVE_KV_DIR=<its slot dir from here>
 * After a summary the new history is computed ahead of time (`prefill`): the next message must
 * then find all of it in the slot and compute only itself.
 */
const env = process.env;

describe.skipIf(!env.REDGIANT_LIVE_LLAMACPP_URL || !env.REDGIANT_LIVE_KV_DIR)(
  "live: the new history is computed before the next message",
  () => {
    it("leaves only the new message to compute", { timeout: 240_000 }, async () => {
      const p = new LocalEngineProvider({
        baseURL: env.REDGIANT_LIVE_LLAMACPP_URL ?? "",
        kv: new KvStore(env.REDGIANT_LIVE_KV_DIR ?? ""),
      });
      const base = {
        model: "default",
        system: "You are terse.",
        tools: [],
        cacheScope: "live",
        maxTokens: 8,
      };
      const doc = Array.from({ length: 80 }, (_, i) => `Fact ${i}: the sky is ${i}% blue.`).join(
        " ",
      );
      const text = (t: string, role: "user" | "assistant" = "user"): ChatMessage => ({
        role,
        parts: [{ type: "text", text: t }],
      });
      const summary = text(`Summary of the conversation so far:\n\n${doc.slice(0, 1500)}`);
      const kept = [text("And the sea?"), text("Green, mostly.", "assistant")];

      const run = async (id: string, warm: boolean) => {
        const key = `${id}-${Date.now()}`;
        // The conversation before the summary.
        await complete(p.stream({ ...base, cacheKey: key, messages: [text(`${doc}\nOne word?`)] }));
        const history = [summary, ...kept];
        if (warm) await p.prefill({ ...base, cacheKey: key, messages: history });
        const t0 = Date.now();
        const c = await complete(
          p.stream({ ...base, cacheKey: key, messages: [...history, text("Thanks. And now?")] }),
        );
        return { ...c.usage, ms: Date.now() - t0 };
      };
      const cold = await run("cold", false);
      const warm = await run("warm", true);
      await p.shutdown();
      console.info("without prefill", cold, "\nwith prefill", warm);
      const computed = (u: { inputTokens: number; cachedReadTokens: number }) =>
        u.inputTokens - u.cachedReadTokens;
      // Without it the whole new history is computed; with it only the new message (and the
      // template's tail around it).
      expect(computed(cold)).toBeGreaterThan(200);
      expect(computed(warm)).toBeLessThan(40);
    });
  },
);

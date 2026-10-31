import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChatMessage } from "@redgiant/protocol";
import { complete } from "@redgiant/providers";
import { describe, expect, it } from "vitest";
import { KvStore, LocalEngineProvider } from "../../src/index.js";

/**
 * G9 verification against a real llama.cpp (started with --slot-save-path and --swa-full):
 *   REDGIANT_LIVE_LLAMACPP_URL=http://host:8080/v1
 *   REDGIANT_LIVE_KV_DIR=<the engine's /kv as seen from here>
 *   REDGIANT_LIVE_ENGINE_CONTAINER=<container to restart between the two turns>
 */
const env = process.env;
const run = promisify(execFile);

describe.skipIf(!env.REDGIANT_LIVE_LLAMACPP_URL || !env.REDGIANT_LIVE_KV_DIR)(
  "live: KV cache on SSD across an engine restart",
  () => {
    it("resumes a session after the engine restarts without recomputing the prefix", async () => {
      const url = env.REDGIANT_LIVE_LLAMACPP_URL ?? "";
      const make = () =>
        new LocalEngineProvider({ baseURL: url, kv: new KvStore(env.REDGIANT_LIVE_KV_DIR ?? "") });
      const doc = Array.from(
        { length: 110 },
        (_, i) => `Line ${i}: RedGiant saves the KV cache on the SSD.`,
      ).join(" ");
      const base = {
        model: "default",
        system: "You are terse.",
        tools: [],
        cacheKey: `live-${Date.now()}`,
        cacheScope: "live",
        maxTokens: 16,
      };
      const first: ChatMessage[] = [
        { role: "user", parts: [{ type: "text", text: `${doc}\n\nSummarise in five words.` }] },
      ];

      const p1 = make();
      const c1 = await complete(p1.stream({ ...base, messages: first }));
      await p1.shutdown();
      console.info("turn 1", c1.usage, `prefill ${c1.metrics.prefillMs} ms`);

      if (env.REDGIANT_LIVE_ENGINE_CONTAINER) {
        await run("docker", ["restart", env.REDGIANT_LIVE_ENGINE_CONTAINER]);
        for (let i = 0; i < 120; i++) {
          if (
            await fetch(url.replace(/\/v1$/, "/health"))
              .then((r) => r.ok)
              .catch(() => false)
          )
            break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      const p2 = make();
      const second: ChatMessage[] = [
        ...first,
        { role: "assistant", parts: c1.message.parts },
        { role: "user", parts: [{ type: "text", text: "Now in three words." }] },
      ];
      const c2 = await complete(p2.stream({ ...base, messages: second }));
      console.info(
        "turn 2",
        c2.usage,
        `prefill ${c2.metrics.prefillMs} ms`,
        `restored ${c2.metrics.kvRestoredTokens} in ${c2.metrics.kvRestoreMs} ms`,
      );
      expect(c2.metrics.kvRestoredTokens).toBeGreaterThan(0);
      expect(c2.usage.cachedReadTokens).toBeGreaterThan(0.9 * c2.usage.inputTokens);
      expect(c2.metrics.prefillMs ?? Infinity).toBeLessThan((c1.metrics.prefillMs ?? 0) / 10);
    }, 900_000);
  },
);

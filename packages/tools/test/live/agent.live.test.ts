import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@redgiant/agent";
import { EventStore, migrate } from "@redgiant/events";
import { OpenAICompatProvider, ProviderRegistry } from "@redgiant/providers";
import { describe, expect, it } from "vitest";
import { baseTools, LocalWorkspace } from "../../src/index.js";
import { memoryDb } from "../pglite.js";

/**
 * A small local model completes a trivial task with the real tools (G3 verification).
 *   REDGIANT_LIVE_OPENAI_BASE_URL=http://host:8080/v1 [REDGIANT_LIVE_OPENAI_MODEL=...] pnpm test:live
 */
const env = process.env;

describe.skipIf(!env.REDGIANT_LIVE_OPENAI_BASE_URL)(
  "live: small local model with base tools",
  () => {
    it("reads a file and writes its uppercase copy", async () => {
      const dir = await mkdtemp(join(tmpdir(), "rg-live-"));
      try {
        await writeFile(join(dir, "greeting.txt"), "hello world\n");
        const provider = new OpenAICompatProvider({
          id: "local",
          baseURL: env.REDGIANT_LIVE_OPENAI_BASE_URL ?? "",
        });
        await provider.discover();
        const { db } = await memoryDb();
        await migrate(db);
        const store = new EventStore(db);
        const session = await AgentSession.start({
          store,
          providers: new ProviderRegistry().register(provider),
          model: { provider: "local", model: env.REDGIANT_LIVE_OPENAI_MODEL ?? "default" },
          system:
            "You are a coding agent working in a project folder. Use the tools to act; do not just describe.",
          tools: baseTools({ workspace: new LocalWorkspace(dir), profile: "compact" }),
          sessionId: "live",
          maxTurns: 8,
          maxTokens: 1024,
        });
        const r = await session.send(
          "Read greeting.txt, then create shout.txt containing the same text in UPPERCASE. Reply 'done' when finished.",
        );
        const events = await store.list();
        for (const e of events) {
          if (e.type === "message.assistant" && e.payload) {
            const m = e.payload.metrics;
            console.info(
              `turn: in=${m.inputTokens} cached=${m.cachedReadTokens} out=${m.outputTokens} prefill=${m.prefillMs}ms decode=${m.decodeMs}ms ctx=${m.contextUsed}/${m.contextWindow}`,
              JSON.stringify(e.payload.parts).slice(0, 300),
            );
          }
          if (e.type === "tool.result" && e.payload)
            console.info("  tool:", e.payload.output.slice(0, 120));
        }
        console.info("result", r.stopReason, r.turns);
        // Verifier: the file exists with the expected content.
        expect((await readFile(join(dir, "shout.txt"), "utf8")).trim()).toBe("HELLO WORLD");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 600_000);
  },
);

import { describe, expect, it } from "vitest";
import { AnthropicProvider, complete, costUsd, OpenAICompatProvider } from "../../src/index.js";

/**
 * Live checks against real models. They spend real tokens and are never run in CI.
 *
 *   ANTHROPIC_API_KEY=...                         Anthropic (model: REDGIANT_LIVE_ANTHROPIC_MODEL)
 *   REDGIANT_LIVE_OPENAI_BASE_URL=http://host/v1  any OpenAI-compatible server
 *   REDGIANT_LIVE_OPENAI_MODEL=...                model name on that server
 */
const env = process.env;
const ask = (text: string) => [{ role: "user" as const, parts: [{ type: "text" as const, text }] }];

describe.skipIf(!env.ANTHROPIC_API_KEY)("live: Anthropic", () => {
  const model = env.REDGIANT_LIVE_ANTHROPIC_MODEL ?? "claude-opus-5-5";
  const p = new AnthropicProvider();

  it("answers, reports usage and timings", async () => {
    const c = await complete(
      p.stream({
        model,
        system: "Answer with one word.",
        tools: [],
        messages: ask("Capital of Italy?"),
        effort: "low",
        maxTokens: 2000,
      }),
    );
    expect(c.stopReason).toBe("end_turn");
    expect(c.usage.inputTokens).toBeGreaterThan(0);
    expect(c.metrics.prefillMs).toBeGreaterThan(0);
    console.info(
      "anthropic",
      c.usage,
      c.metrics,
      `$${costUsd(c.usage, p.modelInfo(model).pricing).toFixed(6)}`,
    );
  });

  it("calls a tool", async () => {
    const c = await complete(
      p.stream({
        model,
        system: "Use the tool to answer.",
        tools: [
          {
            name: "get_time",
            description: "Current time in a city",
            inputSchema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
        messages: ask("What time is it in Rome?"),
        effort: "low",
        maxTokens: 4000,
      }),
    );
    expect(c.stopReason).toBe("tool_use");
    expect(c.message.parts.find((x) => x.type === "tool_call")).toMatchObject({ name: "get_time" });
  });
});

describe.skipIf(!env.REDGIANT_LIVE_OPENAI_BASE_URL)("live: OpenAI-compatible", () => {
  const baseURL = env.REDGIANT_LIVE_OPENAI_BASE_URL ?? "";
  const model = env.REDGIANT_LIVE_OPENAI_MODEL ?? "default";
  const p = new OpenAICompatProvider({
    id: "local",
    baseURL,
    ...(env.OPENAI_API_KEY && { apiKey: env.OPENAI_API_KEY }),
  });

  it("discovers the context window and streams an answer with usage and metrics", async () => {
    await p.discover();
    expect(p.modelInfo(model).contextWindow).toBeGreaterThan(0);
    const c = await complete(
      p.stream({ model, system: "", tools: [], messages: ask("Hello"), maxTokens: 32 }),
    );
    expect(["end_turn", "max_tokens"]).toContain(c.stopReason);
    expect(c.usage.outputTokens).toBeGreaterThan(0);
    expect(c.metrics.decodeMs).toBeGreaterThanOrEqual(0);
    console.info("openai-compat", c.usage, c.metrics);
  });
});

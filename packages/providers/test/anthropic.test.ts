import { describe, expect, it } from "vitest";
import { AnthropicProvider, type ChatMessage, complete, costUsd } from "../src/index.js";
import { anthropicEvents, fakeFetch, sseResponse } from "./helpers.js";

const tools = [
  { name: "a_tool", description: "A", inputSchema: { type: "object", properties: {} } },
  { name: "b_tool", description: "B", inputSchema: { type: "object", properties: {} } },
];
const user = (text: string): ChatMessage => ({ role: "user", parts: [{ type: "text", text }] });

describe("AnthropicProvider request", () => {
  const p = new AnthropicProvider({ apiKey: "test" });

  it("places cache breakpoints on the last tool, the system prompt and the conversation", () => {
    const params = p.buildParams({
      model: "claude-opus-5-5",
      system: "S",
      tools,
      messages: [user("hi")],
    });
    expect(params.tools?.[0]).not.toHaveProperty("cache_control");
    expect(params.tools?.[1]).toMatchObject({
      cache_control: { type: "ephemeral" },
      eager_input_streaming: true,
    });
    expect(params.system).toEqual([
      { type: "text", text: "S", cache_control: { type: "ephemeral" } },
    ]);
    expect(params.cache_control).toEqual({ type: "ephemeral" });
  });

  it("uses a 1h TTL for tools and system when longCache is on", () => {
    const params = new AnthropicProvider({ apiKey: "t", longCache: true }).buildParams({
      model: "claude-opus-5-5",
      system: "S",
      tools,
      messages: [user("hi")],
    });
    expect(params.system).toEqual([
      { type: "text", text: "S", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
  });

  it("sends effort and adaptive thinking only to models that support them", () => {
    const opus = p.buildParams({
      model: "claude-opus-5-5",
      system: "",
      tools: [],
      messages: [user("x")],
      effort: "max",
    });
    expect(opus.output_config).toEqual({ effort: "max" });
    expect(opus.thinking).toEqual({ type: "adaptive", display: "summarized" });
    const haiku = p.buildParams({
      model: "claude-haiku-4-5",
      system: "",
      tools: [],
      messages: [user("x")],
      effort: "max",
    });
    expect(haiku.output_config).toBeUndefined();
    expect(haiku.thinking).toBeUndefined();
  });

  it("replays native assistant content verbatim and rebuilds foreign turns without thinking", () => {
    const native = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "ok" },
    ];
    const params = p.buildParams({
      model: "claude-opus-5-5",
      system: "",
      tools: [],
      messages: [
        user("a"),
        {
          role: "assistant",
          parts: [{ type: "text", text: "ok" }],
          native: { provider: "anthropic", model: "claude-opus-5-5", content: native },
        },
        user("b"),
        {
          role: "assistant",
          parts: [
            { type: "thinking", text: "local reasoning" },
            {
              type: "tool_call",
              callId: "c1",
              name: "a_tool",
              input: { x: 1 },
              rawInput: '{"x":1}',
            },
          ],
          native: { provider: "local", model: "gemma", content: {} },
        },
        {
          role: "user",
          parts: [{ type: "tool_result", callId: "c1", content: "boom", isError: true }],
        },
      ],
    });
    expect(params.messages[1]?.content).toBe(native);
    expect(params.messages[3]?.content).toEqual([
      { type: "tool_use", id: "c1", name: "a_tool", input: { x: 1 } },
    ]);
    expect(params.messages[4]?.content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: "boom", is_error: true },
    ]);
  });
});

describe("AnthropicProvider response", () => {
  it("counts cached tokens into the total input and prices them separately", async () => {
    const { fetch } = fakeFetch(() =>
      sseResponse(
        anthropicEvents({
          text: "ok",
          stop: "end_turn",
          usage: { input: 100, output: 50, cacheRead: 9000, cacheWrite: 900 },
        }),
      ),
    );
    const p = new AnthropicProvider({ apiKey: "t", fetch, maxRetries: 0 });
    const c = await complete(
      p.stream({ model: "claude-opus-5-5", system: "", tools: [], messages: [user("x")] }),
    );
    expect(c.usage).toEqual({
      inputTokens: 10_000,
      cachedReadTokens: 9000,
      cacheWriteTokens: 900,
      outputTokens: 50,
    });
    expect(c.metrics.contextUsed).toBe(10_050);
    expect(c.metrics.contextWindow).toBe(1_000_000);
    expect(c.message.native?.provider).toBe("anthropic");
    // 100 * 4 + 9000 * 0.2 + 900 * 5 + 50 * 20 = 7700 µ$ per million
    expect(costUsd(c.usage, p.modelInfo("claude-opus-5-5").pricing)).toBeCloseTo(0.0077, 10);
  });

  it("does not retry a 400 as a retriable error", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "bad" },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const p = new AnthropicProvider({ apiKey: "t", fetch, maxRetries: 0 });
    await expect(
      complete(
        p.stream({ model: "claude-opus-5-5", system: "", tools: [], messages: [user("x")] }),
      ),
    ).rejects.toMatchObject({
      retriable: false,
    });
  });
});

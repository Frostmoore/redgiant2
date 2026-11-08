import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AnthropicProvider, type ChatMessage, complete, costUsd } from "../src/index.js";
import { anthropicEvents, fakeFetch, sseResponse } from "./helpers.js";

const tools = [
  { name: "a_tool", description: "A", inputSchema: { type: "object", properties: {} } },
  { name: "b_tool", description: "B", inputSchema: { type: "object", properties: {} } },
];
const here = dirname(fileURLToPath(import.meta.url));
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

  it("sends images as base64 image blocks after the text", () => {
    const params = p.buildParams({
      model: "claude-opus-5-5",
      system: "S",
      tools: [],
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "what is this?" },
            { type: "image", mediaType: "image/png", data: "iVBOR", name: "a.png" },
          ],
        },
      ],
    });
    expect(params.messages[0]?.content).toEqual([
      { type: "text", text: "what is this?" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBOR" },
      },
    ]);
  });

  it("sets tool_choice none only when asked", () => {
    const base = { model: "claude-opus-5-5", system: "S", tools, messages: [user("hi")] };
    expect(p.buildParams(base).tool_choice).toBeUndefined();
    expect(p.buildParams({ ...base, toolChoice: "none" }).tool_choice).toEqual({ type: "none" });
  });

  it("asks for server-side fallback on models that support it", () => {
    const msg = { system: "", tools: [], messages: [user("x")] };
    expect(p.buildParams({ model: "claude-opus-5-5", ...msg })).toMatchObject({
      fallbacks: "default",
    });
    expect(p.buildParams({ model: "claude-haiku-5-5", ...msg })).not.toHaveProperty("fallbacks");
    expect(
      new AnthropicProvider({ apiKey: "t", serverFallbacks: false }).buildParams({
        model: "claude-opus-5-5",
        ...msg,
      }),
    ).not.toHaveProperty("fallbacks");
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

  it("bills one-hour cache writes at 2x input and Haiku 5.5 prompts over 100K at the higher prices", async () => {
    const { fetch } = fakeFetch(() =>
      sseResponse(
        anthropicEvents({
          text: "ok",
          stop: "end_turn",
          usage: { input: 100, output: 50, cacheRead: 9000, cacheWrite: 900, cacheWrite1h: 600 },
        }),
      ),
    );
    const p = new AnthropicProvider({ apiKey: "t", fetch, maxRetries: 0, longCache: true });
    const c = await complete(
      p.stream({ model: "claude-opus-5-5", system: "s", tools: [], messages: [user("x")] }),
    );
    expect(c.usage.cacheWrite1hTokens).toBe(600);
    // 100 * 4 + 9000 * 0.2 + 300 * 5 + 600 * 8 + 50 * 20
    expect(costUsd(c.usage, p.modelInfo("claude-opus-5-5").pricing)).toBeCloseTo(0.0095, 10);

    const haiku = p.modelInfo("claude-haiku-5-5").pricing;
    const at = (inputTokens: number) => ({
      inputTokens,
      cachedReadTokens: inputTokens - 1000,
      cacheWriteTokens: 1000,
      cacheWrite1hTokens: 0,
      outputTokens: 1000,
    });
    // Up to 100K: 0.10 / 0.125 / 0.01 / 0.50 per million.
    expect(costUsd(at(100_000), haiku)).toBeCloseTo(
      (99_000 * 0.01 + 1000 * 0.125 + 1000 * 0.5) / 1e6,
      12,
    );
    // Over 100K, every token of the request (cache reads included): 0.50 / 0.625 / 0.05 / 2.50.
    expect(costUsd(at(100_001), haiku)).toBeCloseTo(
      (99_001 * 0.05 + 1000 * 0.625 + 1000 * 2.5) / 1e6,
      12,
    );
    expect(haiku?.longPrompt?.prices.cacheWrite1h).toBe(1);
    expect(haiku?.cacheWrite1h).toBeCloseTo(0.2, 12);
  });

  it("matches Anthropic's price list (checked 2026-11-08)", () => {
    const p = new AnthropicProvider({ apiKey: "t" });
    const row = (m: string) => {
      const x = p.modelInfo(m).pricing;
      return x && [x.input, x.cacheWrite, x.cacheWrite1h, x.cacheRead, x.output];
    };
    expect(row("claude-fable-5-1")).toEqual([10, 12.5, 20, 0.25, 50]);
    expect(row("claude-fable-5")).toEqual([10, 12.5, 20, 1, 50]);
    expect(row("claude-opus-5-5")).toEqual([4, 5, 8, 0.2, 20]);
    expect(row("claude-opus-5")).toEqual([5, 6.25, 10, 0.5, 25]);
    expect(row("claude-opus-4-8")).toEqual([5, 6.25, 10, 0.5, 25]);
    expect(row("claude-sonnet-5-5")).toEqual([2, 2.5, 4, 0.1, 10]);
    expect(row("claude-sonnet-5")).toEqual([2, 2.5, 4, 0.2, 10]);
    expect(row("claude-sonnet-4-6")).toEqual([3, 3.75, 6, 0.3, 15]);
    expect(row("claude-haiku-5-5")?.map((n) => Number(n?.toFixed(4)))).toEqual([
      0.1, 0.125, 0.2, 0.01, 0.5,
    ]);
    expect(row("claude-haiku-4-5")).toEqual([1, 1.25, 2, 0.1, 5]);
  });

  it("starts timing generation at the first content block, not the first text", async () => {
    const events = anthropicEvents({
      tool: { id: "t1", name: "a_tool", json: '{"x":1}' },
      text: "after",
      stop: "tool_use",
    });
    const { fetch } = fakeFetch(() => sseResponse(events));
    const p = new AnthropicProvider({ apiKey: "t", fetch, maxRetries: 0 });
    const c = await complete(
      p.stream({ model: "claude-opus-5-5", system: "", tools: [], messages: [user("x")] }),
    );
    expect(c.metrics.firstTokenAt).toBeDefined();
    expect(c.metrics.decodeMs).toBeGreaterThanOrEqual(0);
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

describe("Anthropic's own web search (2026-11-03)", () => {
  const search = {
    name: "web_search",
    description: "Search the web.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  };
  const req = (model: string) => ({
    model,
    system: "S",
    tools: [tools[0] as (typeof tools)[number], search],
    messages: [user("who?")],
  });

  it("turns RedGiant's web_search into Anthropic's, filtered with code on newer models", () => {
    const p = new AnthropicProvider({ apiKey: "t" });
    expect(p.buildParams(req("claude-sonnet-5-5")).tools?.[1]).toEqual({
      type: "web_search_20260318",
      response_inclusion: "excluded",
      name: "web_search",
      max_uses: 8,
      cache_control: { type: "ephemeral" },
    });
    expect(p.buildParams(req("claude-haiku-5-5")).tools?.[1]).toMatchObject({
      type: "web_search_20250305",
      name: "web_search",
    });
    // Off: RedGiant's own tool (SearXNG) as for every other provider.
    const off = new AnthropicProvider({ apiKey: "t", nativeWebSearch: false });
    expect(off.buildParams(req("claude-sonnet-5-5")).tools?.[1]).toMatchObject({
      name: "web_search",
      input_schema: search.inputSchema,
    });
  });

  it("reads a real answer that searched: the text, the blocks to send back, the search's cost", async () => {
    const recorded = readFileSync(join(here, "fixtures", "anthropic-web-search.sse"), "utf8");
    const { fetch } = fakeFetch(
      () => new Response(recorded, { headers: { "content-type": "text/event-stream" } }),
    );
    const p = new AnthropicProvider({ apiKey: "t", fetch, maxRetries: 0 });
    const c = await complete(p.stream(req("claude-sonnet-5-5")));
    const text = c.message.parts.flatMap((x) => (x.type === "text" ? [x.text] : [])).join("");
    expect(text).toContain("Marengo");
    // No tool for RedGiant to run: the search happened on Anthropic's side.
    expect(c.message.parts.some((x) => x.type === "tool_call")).toBe(false);
    const blocks = ((c.message.native?.content ?? []) as { type: string }[]).map((b) => b.type);
    expect(blocks).toContain("server_tool_use");
    expect(c.usage.extraUsd).toBe(0.01);
    expect(costUsd(c.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(
      0.01,
    );
    // The next request sends those blocks back exactly as they came.
    const next = p.buildParams({
      ...req("claude-sonnet-5-5"),
      messages: [user("who?"), c.message, user("and then?")],
    });
    expect(next.messages[1]?.content).toEqual(c.message.native?.content);
  });
});

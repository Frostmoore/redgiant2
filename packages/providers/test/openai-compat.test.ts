import { describe, expect, it } from "vitest";
import { type ChatMessage, complete, OpenAICompatProvider } from "../src/index.js";
import { fakeFetch, openAiTextEvents, sseResponse } from "./helpers.js";

const user = (text: string): ChatMessage => ({ role: "user", parts: [{ type: "text", text }] });

describe("OpenAICompatProvider request", () => {
  it("maps tool calls, tool results and system prompt to chat-completions messages", () => {
    const p = new OpenAICompatProvider({ baseURL: "http://x/v1" });
    const body = p.buildBody({
      model: "gemma-4",
      system: "S",
      tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
      messages: [
        user("go"),
        {
          role: "assistant",
          parts: [
            { type: "thinking", text: "hmm" },
            { type: "text", text: "calling" },
            { type: "tool_call", callId: "c1", name: "t", input: {}, rawInput: "{}" },
          ],
        },
        {
          role: "user",
          parts: [
            { type: "tool_result", callId: "c1", content: "done" },
            { type: "text", text: "and now?" },
          ],
        },
      ],
    });
    expect(body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "calling",
        reasoning_content: "hmm",
        tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "done" },
      { role: "user", content: "and now?" },
    ]);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: { name: "t", description: "d", parameters: { type: "object" } },
      },
    ]);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("sends images as data URLs, plain text when there are none", () => {
    const p = new OpenAICompatProvider({ baseURL: "x" });
    const body = p.buildBody({
      model: "m",
      system: "",
      tools: [],
      messages: [
        { role: "user", parts: [{ type: "text", text: "plain" }] },
        {
          role: "user",
          parts: [
            { type: "text", text: "look" },
            { type: "image", mediaType: "image/jpeg", data: "/9j/" },
          ],
        },
      ],
    });
    expect(body.messages).toEqual([
      { role: "user", content: "plain" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } },
        ],
      },
    ]);
  });

  it("can stop replaying reasoning, and sends tool_choice none only when asked", () => {
    const req = {
      model: "m",
      system: "",
      tools: [{ name: "t", description: "d", inputSchema: {} }],
      messages: [
        user("x"),
        {
          role: "assistant" as const,
          parts: [
            { type: "thinking" as const, text: "r" },
            { type: "text" as const, text: "a" },
          ],
        },
      ],
    };
    const off = new OpenAICompatProvider({ baseURL: "x", replayReasoning: false }).buildBody(req);
    expect((off.messages as unknown[])[1]).toEqual({ role: "assistant", content: "a" });
    expect(off).not.toHaveProperty("tool_choice");
    expect(
      new OpenAICompatProvider({ baseURL: "x" }).buildBody({ ...req, toolChoice: "none" }),
    ).toMatchObject({ tool_choice: "none" });
  });

  it("translates effort per server style", () => {
    const req = {
      model: "m",
      system: "",
      tools: [],
      messages: [user("x")],
      effort: "max" as const,
    };
    expect(
      new OpenAICompatProvider({ baseURL: "x", effortStyle: "reasoning_effort" }).buildBody(req),
    ).toMatchObject({ reasoning_effort: "high" });
    expect(
      new OpenAICompatProvider({ baseURL: "x", effortStyle: "template_thinking" }).buildBody({
        ...req,
        effort: "low",
      }),
    ).toMatchObject({
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(new OpenAICompatProvider({ baseURL: "x" }).buildBody(req)).not.toHaveProperty(
      "reasoning_effort",
    );
  });

  it("sends prompt_cache_key only when enabled", () => {
    const req = { model: "m", system: "", tools: [], messages: [user("x")], cacheKey: "sess_1" };
    expect(new OpenAICompatProvider({ baseURL: "x" }).buildBody(req)).not.toHaveProperty(
      "prompt_cache_key",
    );
    expect(
      new OpenAICompatProvider({ baseURL: "x", sendCacheKey: true }).buildBody(req),
    ).toMatchObject({ prompt_cache_key: "sess_1" });
  });
});

describe("OpenAICompatProvider.discover", () => {
  it("reads context windows from llama.cpp, vLLM and OpenRouter model lists", async () => {
    const { fetch } = fakeFetch(() =>
      Response.json({
        data: [
          { id: "llama", meta: { n_ctx: 512 } },
          { id: "vllm", max_model_len: 32768 },
          { id: "router", context_length: 200000 },
          { id: "plain" },
        ],
      }),
    );
    const p = new OpenAICompatProvider({ baseURL: "http://x/v1", fetch });
    expect(await p.discover()).toHaveLength(4);
    expect(p.modelInfo("llama").contextWindow).toBe(512);
    expect(p.modelInfo("vllm").contextWindow).toBe(32768);
    expect(p.modelInfo("plain").contextWindow).toBe(8192);
  });

  it("applies the only served model's window to any requested name", async () => {
    const { fetch } = fakeFetch(() =>
      Response.json({ data: [{ id: "/models/x.gguf", meta: { n_ctx: 512 } }] }),
    );
    const p = new OpenAICompatProvider({ baseURL: "http://x/v1", fetch });
    await p.discover();
    expect(p.modelInfo("default").contextWindow).toBe(512);
  });
});

describe("OpenAICompatProvider response", () => {
  it("uses llama.cpp timings for cache counts and server-side prefill/decode", async () => {
    const timings = {
      cache_n: 300,
      prompt_n: 20,
      prompt_ms: 40,
      predicted_n: 8,
      predicted_ms: 160,
    };
    const { fetch, calls } = fakeFetch(() =>
      sseResponse(openAiTextEvents("ciao a tutti", { timings })),
    );
    const p = new OpenAICompatProvider({
      id: "local",
      baseURL: "http://llama:8080/v1/",
      fetch,
      defaultContextWindow: 4096,
    });
    const c = await complete(
      p.stream({ model: "m", system: "", tools: [], messages: [user("x")] }),
    );
    expect(calls[0]?.url).toBe("http://llama:8080/v1/chat/completions");
    expect(c.usage).toEqual({
      inputTokens: 320,
      cachedReadTokens: 300,
      cacheWriteTokens: 0,
      outputTokens: 8,
    });
    expect(c.metrics).toMatchObject({
      source: "server",
      prefillMs: 40,
      decodeMs: 160,
      tokPerSec: 50,
      contextWindow: 4096,
    });
  });

  it("reads OpenAI usage with cached tokens when there are no timings", async () => {
    const { fetch } = fakeFetch(() =>
      sseResponse([
        ...openAiTextEvents("ok").slice(0, -1),
        {
          data: {
            choices: [],
            usage: {
              prompt_tokens: 2000,
              completion_tokens: 3,
              prompt_tokens_details: { cached_tokens: 1024 },
            },
          },
        },
        { data: "[DONE]" },
      ]),
    );
    const c = await complete(
      new OpenAICompatProvider({ baseURL: "x", fetch }).stream({
        model: "m",
        system: "",
        tools: [],
        messages: [user("x")],
      }),
    );
    expect(c.usage).toEqual({
      inputTokens: 2000,
      cachedReadTokens: 1024,
      cacheWriteTokens: 0,
      outputTokens: 3,
    });
    expect(c.metrics.source).toBe("client");
  });

  it("keeps invalid tool arguments as raw text with undefined input", async () => {
    const { fetch } = fakeFetch(() =>
      sseResponse([
        {
          data: {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: "c", function: { name: "t", arguments: "{path: oops" } },
                  ],
                },
              },
            ],
          },
        },
        { data: { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] } },
        { data: "[DONE]" },
      ]),
    );
    const c = await complete(
      new OpenAICompatProvider({ baseURL: "x", fetch }).stream({
        model: "m",
        system: "",
        tools: [],
        messages: [user("x")],
      }),
    );
    expect(c.message.parts).toEqual([
      { type: "tool_call", callId: "c", name: "t", input: undefined, rawInput: "{path: oops" },
    ]);
  });

  it("streams reasoning_content as thinking", async () => {
    const { fetch } = fakeFetch(() =>
      sseResponse([
        { data: { choices: [{ index: 0, delta: { reasoning_content: "let me think" } }] } },
        ...openAiTextEvents("answer"),
      ]),
    );
    const c = await complete(
      new OpenAICompatProvider({ baseURL: "x", fetch }).stream({
        model: "m",
        system: "",
        tools: [],
        messages: [user("x")],
      }),
    );
    expect(c.message.parts[0]).toEqual({ type: "thinking", text: "let me think" });
  });

  it("treats 4xx as non-retriable", async () => {
    const { fetch } = fakeFetch(() => new Response("no such model", { status: 404 }));
    await expect(
      complete(
        new OpenAICompatProvider({ baseURL: "x", fetch }).stream({
          model: "m",
          system: "",
          tools: [],
          messages: [user("x")],
        }),
      ),
    ).rejects.toMatchObject({ retriable: false });
  });
});

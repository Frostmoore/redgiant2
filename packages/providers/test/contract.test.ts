import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  FakeProvider,
  OpenAICompatProvider,
  type Provider,
  ProviderError,
  type StreamEvent,
} from "../src/index.js";
import { anthropicEvents, fakeFetch, openAiTextEvents, sseResponse } from "./helpers.js";

/**
 * The same behaviour is required of every provider. Each setup builds a provider that
 * answers the given scenario, via a script (fake) or recorded HTTP (adapters).
 */
type Scenario = "text" | "tool" | "overloaded" | "slow";
const TEXT = "Hello from RedGiant, all good.";
const TOOL = { name: "read_file", input: { path: "src/a.ts" } };

const setups: Record<string, (s: Scenario) => Provider> = {
  fake: (s) =>
    new FakeProvider(
      s === "text"
        ? [{ text: TEXT }]
        : s === "tool"
          ? [{ toolCalls: [{ ...TOOL, callId: "call_1" }] }]
          : s === "overloaded"
            ? [{ error: new ProviderError("overloaded", true) }]
            : [{ text: `${TEXT} `.repeat(50) }],
      { tick: () => new Promise((r) => setTimeout(r, s === "slow" ? 5 : 0)) },
    ),
  anthropic: (s) =>
    new AnthropicProvider({
      apiKey: "test",
      maxRetries: 0,
      fetch: fakeFetch((_call, signal) => {
        if (s === "overloaded") {
          return new Response(
            JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "x" } }),
            {
              status: 529,
              headers: { "content-type": "application/json" },
            },
          );
        }
        const events =
          s === "tool"
            ? anthropicEvents({
                tool: { id: "call_1", ...{ name: TOOL.name }, json: JSON.stringify(TOOL.input) },
                stop: "tool_use",
              })
            : anthropicEvents({
                text: s === "slow" ? `${TEXT} `.repeat(50) : TEXT,
                stop: "end_turn",
              });
        return sseResponse(events, { delayMs: s === "slow" ? 5 : 0, ...(signal && { signal }) });
      }).fetch,
    }),
  openai: (s) =>
    new OpenAICompatProvider({
      baseURL: "http://local.test/v1",
      fetch: fakeFetch((_call, signal) => {
        if (s === "overloaded") return new Response("busy", { status: 503 });
        if (s === "tool") {
          const args = JSON.stringify(TOOL.input);
          return sseResponse([
            {
              data: {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_1",
                          function: { name: TOOL.name, arguments: args.slice(0, 5) },
                        },
                      ],
                    },
                  },
                ],
              },
            },
            {
              data: {
                choices: [
                  {
                    index: 0,
                    delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] },
                  },
                ],
              },
            },
            { data: { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] } },
            { data: "[DONE]" },
          ]);
        }
        return sseResponse(openAiTextEvents(s === "slow" ? `${TEXT} `.repeat(50) : TEXT), {
          delayMs: s === "slow" ? 5 : 0,
          ...(signal && { signal }),
        });
      }).fetch,
    }),
};

const request = {
  model: "claude-opus-5-5",
  system: "You are terse.",
  tools: [],
  messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] }],
};

async function collect(events: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

for (const [name, setup] of Object.entries(setups)) {
  describe(`provider contract: ${name}`, () => {
    it("streams text whose deltas add up to the final message", async () => {
      const events = await collect(setup("text").stream(request));
      const deltas = events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");
      const done = events.at(-1);
      expect(done?.type).toBe("done");
      if (done?.type !== "done") return;
      expect(deltas).toBe(TEXT);
      expect(done.completion.message.parts).toContainEqual({ type: "text", text: TEXT });
      expect(done.completion.stopReason).toBe("end_turn");
      expect(done.completion.metrics.startedAt).toMatch(/Z$/);
      expect(done.completion.metrics.contextWindow).toBeGreaterThan(0);
      expect(deltas.length).toBeGreaterThan(0);
    });

    it("reports tool calls with parsed input", async () => {
      const events = await collect(setup("tool").stream(request));
      const call = events.find((e) => e.type === "tool_call");
      expect(call).toMatchObject({ callId: "call_1", name: TOOL.name, input: TOOL.input });
      const done = events.at(-1);
      expect(done?.type === "done" && done.completion.stopReason).toBe("tool_use");
    });

    it("raises a retriable ProviderError when the server is overloaded", async () => {
      await expect(collect(setup("overloaded").stream(request))).rejects.toMatchObject({
        name: "ProviderError",
        retriable: true,
      });
    });

    it("stops with 'aborted' and keeps the partial text when aborted mid-stream", async () => {
      const controller = new AbortController();
      const events: StreamEvent[] = [];
      for await (const e of setup("slow").stream(request, controller.signal)) {
        events.push(e);
        if (events.length === 3) controller.abort();
      }
      const done = events.at(-1);
      expect(done?.type === "done" && done.completion.stopReason).toBe("aborted");
      if (done?.type === "done") {
        const text = done.completion.message.parts.find((p) => p.type === "text");
        expect(text && text.type === "text" && text.text.length).toBeGreaterThan(0);
      }
    });
  });
}

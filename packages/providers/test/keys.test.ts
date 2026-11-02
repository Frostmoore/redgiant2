import { describe, expect, it } from "vitest";
import { AnthropicProvider, OpenAICompatProvider, ProviderError } from "../src/index.js";

const answer = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("checking a key", () => {
  it("Anthropic: a refused key throws with its status, a good one passes", async () => {
    const bad = new AnthropicProvider({
      apiKey: "sk-ant-wrong",
      maxRetries: 0,
      fetch: answer(401, {
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      }),
    });
    const err = await bad.checkKey().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(401);
    expect((err as ProviderError).rejectedKey).toBe(true);
    const good = new AnthropicProvider({
      apiKey: "sk-ant-good",
      maxRetries: 0,
      fetch: answer(200, { data: [], has_more: false, first_id: null, last_id: null }),
    });
    await expect(good.checkKey()).resolves.toBeUndefined();
  });

  it("OpenAI-compatible: the status of a refused /models comes with the error", async () => {
    const p = new OpenAICompatProvider({
      id: "gemini",
      baseURL: "https://example/v1",
      apiKey: "x",
      fetch: answer(400, { error: { message: "Please pass a valid API key" } }),
    });
    const err = await p.discover().catch((e: unknown) => e);
    expect((err as ProviderError).status).toBe(400);
  });
});

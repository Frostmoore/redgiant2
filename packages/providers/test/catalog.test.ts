import { readFileSync } from "node:fs";
import { ModelsCatalog } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  applyCatalog,
  catalogModel,
  costUsd,
  isNewModel,
  MODEL_LIST_TTL_MS,
  modelsCatalog,
  resetCatalog,
} from "../src/index.js";
import { fakeFetch } from "./helpers.js";

const published = JSON.parse(
  readFileSync(new URL("../../../packaging/models/catalog.json", import.meta.url), "utf8"),
);

afterEach(() => resetCatalog());

/** One `GET /v1/models` page as Anthropic answers it. */
const page = (ids: [string, string][], next?: string) =>
  Response.json({
    data: ids.map(([id, created]) => ({
      id,
      type: "model",
      display_name: id.replace("claude-", "Claude "),
      created_at: created,
      max_input_tokens: 500_000,
      max_tokens: 64_000,
      capabilities: {
        effort: { supported: true },
        thinking: { supported: true, types: { adaptive: { supported: true } } },
        image_input: { supported: true },
      },
    })),
    has_more: next !== undefined,
    first_id: ids[0]?.[0] ?? null,
    last_id: next ?? ids.at(-1)?.[0] ?? null,
  });

describe("models catalog", () => {
  it("built-in copy is the published catalog.json (run packaging/models/embed.mjs)", () => {
    const { $comment: _c, ...data } = published;
    expect(modelsCatalog()).toEqual(ModelsCatalog.parse(data));
  });

  it("has Claude Fable 5.2 with the data of Anthropic's pages", () => {
    expect(catalogModel("anthropic", "claude-fable-5-2")).toMatchObject({
      name: "Claude Fable 5.2",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      effort: true,
      adaptiveThinking: true,
      status: "current",
      released: "2026-11-09",
      pricing: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10, cacheWrite1h: 16 },
    });
  });

  it("a newer catalog replaces the data built in; an older one is refused", () => {
    const base = modelsCatalog();
    const anthropic = base.providers.anthropic;
    if (!anthropic) throw new Error("no anthropic");
    const newer = structuredClone(base);
    newer.version = base.version + 1;
    const opus = newer.providers.anthropic?.models["claude-opus-5-5"];
    if (!opus?.pricing) throw new Error("no opus");
    opus.pricing.input = 3;
    expect(applyCatalog(newer)).toBe(true);
    const p = new AnthropicProvider({ apiKey: "test" });
    expect(p.modelInfo("claude-opus-5-5").pricing?.input).toBe(3);
    const older = { ...structuredClone(base), version: base.version };
    older.version = newer.version - 1;
    expect(applyCatalog(older)).toBe(false);
    expect(p.modelInfo("claude-opus-5-5").pricing?.input).toBe(3);
  });
});

describe("Anthropic's models from the API", () => {
  it("reads every page, puts the current generation first and adds models the catalog lacks", async () => {
    const f = fakeFetch((call) =>
      call.url.includes("after_id")
        ? page([
            ["claude-opus-5-5", "2026-09-22T00:00:00Z"],
            ["claude-sonnet-5-5", "2026-09-28T00:00:00Z"],
            ["claude-opus-4-6", "2026-02-01T00:00:00Z"],
            ["claude-mystery-1", "2025-01-01T00:00:00Z"],
          ])
        : page(
            [
              ["claude-nova-6", "2026-11-12T00:00:00Z"],
              ["claude-fable-5-2", "2026-11-09T00:00:00Z"],
              ["claude-haiku-5-5", "2026-10-07T00:00:00Z"],
            ],
            "claude-haiku-5-5",
          ),
    );
    const p = new AnthropicProvider({ apiKey: "test", fetch: f.fetch, maxRetries: 0 });
    const ids = await p.models();
    expect(f.calls).toHaveLength(2);
    // Current per the catalog, in its order (those the key can use), then the new unknown one;
    // an old model the catalog does not know is not offered.
    expect(ids).toEqual([
      "claude-fable-5-2",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-nova-6",
    ]);
    // The unknown one: limits from the API, "to be confirmed", prices not known (never zero).
    const nova = p.modelInfo("claude-nova-6");
    expect(nova).toMatchObject({
      contextWindow: 500_000,
      maxOutputTokens: 64_000,
      supportsEffort: true,
      unconfirmed: true,
      name: "Claude nova-6",
    });
    expect(nova.pricing).toBeUndefined();
    // Fable 5.2 is "new" for a few weeks after its release, then not any more.
    const fable = catalogModel("anthropic", "claude-fable-5-2");
    expect(isNewModel(fable, Date.parse("2026-11-20T00:00:00Z"))).toBe(true);
    expect(isNewModel(fable, Date.parse("2027-01-20T00:00:00Z"))).toBe(false);
    // It asks for adaptive thinking and effort as the API says the model takes them.
    const params = p.buildParams({
      model: "claude-nova-6",
      system: "",
      tools: [],
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      effort: "high",
    });
    expect(params.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(params.output_config).toEqual({ effort: "high" });
    expect(params).not.toHaveProperty("fallbacks");
  });

  it("keeps the list for hours, then asks again", async () => {
    let now = 1_000_000;
    const f = fakeFetch(() => page([["claude-opus-5-5", "2026-09-22T00:00:00Z"]]));
    const p = new AnthropicProvider({
      apiKey: "test",
      fetch: f.fetch,
      maxRetries: 0,
      now: () => now,
    });
    await p.models();
    await p.models();
    expect(f.calls).toHaveLength(1);
    now += MODEL_LIST_TTL_MS + 1;
    await p.models();
    expect(f.calls).toHaveLength(2);
  });

  it("falls back on the catalog's current models when the API fails", async () => {
    const f = fakeFetch(() => new Response("down", { status: 500 }));
    const p = new AnthropicProvider({ apiKey: "test", fetch: f.fetch, maxRetries: 0 });
    expect(await p.models()).toEqual([
      "claude-fable-5-2",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
  });

  it("counts costs of a known model and knows none for an unknown one", () => {
    const p = new AnthropicProvider({ apiKey: "test" });
    const usage = {
      inputTokens: 1_000_000,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    };
    expect(costUsd(usage, p.modelInfo("claude-fable-5-2").pricing)).toBeCloseTo(8, 6);
    const unknown = p.modelInfo("claude-somewhere-9");
    expect(unknown.unconfirmed).toBe(true);
    expect(unknown.pricing).toBeUndefined();
  });
});

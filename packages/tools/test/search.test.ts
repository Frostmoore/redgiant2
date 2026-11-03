import { describe, expect, it } from "vitest";
import { searchProvider } from "../src/index.js";

/** A fetch that answers one JSON and keeps what was asked. */
function fake(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const opts = { maxResults: 2 };

describe("web search services (2026-11-03)", () => {
  it("Tavily: bearer key, query and count, results with their extracts", async () => {
    const { f, calls } = fake(200, {
      results: [{ title: "Marengo", url: "https://x/m", content: "Napoleon's horse" }],
    });
    const r = await searchProvider({ provider: "tavily", key: "tvly-1" }, f)?.search("horse", opts);
    expect(calls[0]?.url).toBe("https://api.tavily.com/search");
    const headers = calls[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe("Bearer tvly-1");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      query: "horse",
      max_results: 2,
    });
    expect(r).toEqual([{ title: "Marengo", url: "https://x/m", snippet: "Napoleon's horse" }]);
  });

  it("Exa: x-api-key, highlights as the snippet", async () => {
    const { f, calls } = fake(200, {
      results: [{ title: "Doc", url: "https://x/d", highlights: ["one", "two"] }],
    });
    const r = await searchProvider({ provider: "exa", key: "k" }, f)?.search("docs", opts);
    expect(calls[0]?.url).toBe("https://api.exa.ai/search");
    const headers = calls[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.["x-api-key"]).toBe("k");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ query: "docs", numResults: 2 });
    expect(r).toEqual([{ title: "Doc", url: "https://x/d", snippet: "one … two" }]);
  });

  it("Serper: Google's organic results", async () => {
    const { f, calls } = fake(200, {
      organic: [
        { title: "G", link: "https://x/g", snippet: "s" },
        { title: "H", link: "https://x/h" },
      ],
    });
    const r = await searchProvider({ provider: "serper", key: "k" }, f)?.search("q", opts);
    expect(calls[0]?.url).toBe("https://google.serper.dev/search");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ q: "q", num: 2 });
    expect(r?.map((x) => x.url)).toEqual(["https://x/g", "https://x/h"]);
  });

  it("says plainly when a key is refused or the credit is over", async () => {
    await expect(
      searchProvider({ provider: "tavily", key: "bad" }, fake(401, {}).f)?.search("q", opts),
    ).rejects.toThrow("the key was refused");
    await expect(
      searchProvider({ provider: "brave", key: "k" }, fake(429, {}).f)?.search("q", opts),
    ).rejects.toThrow("too many searches");
  });

  it("makes nothing without what a service needs", () => {
    expect(searchProvider({ provider: "searxng" })).toBeUndefined();
    expect(searchProvider({ provider: "exa" })).toBeUndefined();
    expect(searchProvider({ provider: "searxng", url: "http://s:8080" })?.name).toBe("searxng");
  });
});

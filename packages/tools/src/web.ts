import type { Tool } from "@redgiant/agent";
import { z } from "zod";
import { describe, type ModelProfile } from "./profiles.js";
import { truncateMiddle } from "./text.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchProvider {
  readonly name: string;
  search(
    query: string,
    options: { maxResults: number; signal?: AbortSignal | undefined },
  ): Promise<SearchResult[]>;
}

/** SearXNG (self-hosted, no key): `GET /search?format=json`. JSON output must be enabled. */
export class SearxngSearch implements WebSearchProvider {
  readonly name = "searxng";
  constructor(
    private readonly baseURL: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async search(
    query: string,
    { maxResults, signal }: { maxResults: number; signal?: AbortSignal | undefined },
  ) {
    const url = `${this.baseURL.replace(/\/$/, "")}/search?format=json&q=${encodeURIComponent(query)}`;
    const r = await this.fetchImpl(url, {
      headers: { accept: "application/json" },
      ...(signal && { signal }),
    });
    if (!r.ok) throw new Error(`SearXNG HTTP ${r.status}`);
    const body = (await r.json()) as {
      results?: { title?: string; url?: string; content?: string }[];
    };
    return (body.results ?? []).slice(0, maxResults).map((x) => ({
      title: x.title ?? "",
      url: x.url ?? "",
      snippet: x.content ?? "",
    }));
  }
}

/** Brave Search API (needs a key). */
export class BraveSearch implements WebSearchProvider {
  readonly name = "brave";
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async search(
    query: string,
    { maxResults, signal }: { maxResults: number; signal?: AbortSignal | undefined },
  ) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
    const r = await this.fetchImpl(url, {
      headers: { accept: "application/json", "x-subscription-token": this.apiKey },
      ...(signal && { signal }),
    });
    if (!r.ok) throw new Error(`Brave Search HTTP ${r.status}`);
    const body = (await r.json()) as {
      web?: { results?: { title?: string; url?: string; description?: string }[] };
    };
    return (body.web?.results ?? []).slice(0, maxResults).map((x) => ({
      title: x.title ?? "",
      url: x.url ?? "",
      snippet: x.description ?? "",
    }));
  }
}

const SearchInput = z.object({
  query: z.string().min(1),
  max_results: z.number().int().min(1).max(20).optional(),
});

/** Always present (RD29); without a provider it explains how to configure one. */
export function webSearchTool(
  provider: WebSearchProvider | undefined,
  profile: ModelProfile,
): Tool<z.infer<typeof SearchInput>> {
  return {
    def: {
      name: "web_search",
      description: describe(profile, {
        full: "Search the web. Returns title, URL and snippet for each result; use fetch to read a page.",
        compact: "Search the web.",
      }),
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, max_results: { type: "integer" } },
        required: ["query"],
      },
    },
    schema: SearchInput,
    async run({ query, max_results = 8 }, ctx) {
      if (!provider) {
        return {
          content:
            "Web search is not configured. Tell the user to choose a search provider in the RedGiant settings.",
          isError: true,
        };
      }
      const results = await provider.search(query, { maxResults: max_results, signal: ctx.signal });
      if (results.length === 0) return "No results.";
      return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n");
    },
  };
}

const FetchInput = z.object({
  url: z.url(),
  max_chars: z.number().int().min(100).max(200_000).optional(),
});

export function fetchTool(
  profile: ModelProfile,
  fetchImpl: typeof fetch = globalThis.fetch,
): Tool<z.infer<typeof FetchInput>> {
  return {
    def: {
      name: "fetch",
      description: describe(profile, {
        full: "Fetch a URL (http or https) and return its content; HTML is converted to plain text.",
        compact: "Read a web page.",
      }),
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" }, max_chars: { type: "integer" } },
        required: ["url"],
      },
    },
    schema: FetchInput,
    async run({ url, max_chars = 20_000 }, ctx) {
      if (!/^https?:\/\//i.test(url))
        return { content: "Only http and https URLs are supported.", isError: true };
      const r = await fetchImpl(url, {
        redirect: "follow",
        ...(ctx.signal && { signal: ctx.signal }),
      });
      const type = r.headers.get("content-type") ?? "";
      const raw = await r.text();
      const text =
        type.includes("html") || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw;
      return {
        content: `URL: ${r.url || url}\nStatus: ${r.status}\n\n${truncateMiddle(text, max_chars)}`,
        isError: !r.ok,
      };
    },
  };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<\/(p|div|h[1-6]|li|tr|section|article|header|footer|pre|blockquote)>|<br\s*\/?>/gi,
      "\n",
    )
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e.startsWith("#x") || e.startsWith("#X"))
        return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

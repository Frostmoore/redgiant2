/**
 * The web search services RedGiant can use (2026-11-03) for the models that cannot search by
 * themselves (local ones, and keys whose API offers no search beside tools). How to get each
 * one's key is in the UI's words (`searchHow_<id>`).
 */
export const SEARCH_PROVIDER_IDS = ["searxng", "brave", "tavily", "exa", "serper"] as const;
export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];

export interface SearchProviderInfo {
  id: SearchProviderId;
  /** The brand, the same in every language. */
  name: string;
  /** What it needs: the address of one's own server, or a key. */
  needs: "url" | "key";
  /** Where the key is made (or the docs, for a server of one's own). */
  keyUrl: string;
  /** How a key starts, shown as an example. */
  keyExample?: string;
}

export const SEARCH_PROVIDERS: readonly SearchProviderInfo[] = [
  {
    id: "searxng",
    name: "SearXNG",
    needs: "url",
    keyUrl: "https://docs.searxng.org/admin/installation.html",
  },
  {
    id: "brave",
    name: "Brave Search",
    needs: "key",
    keyUrl: "https://api-dashboard.search.brave.com/app/keys",
    keyExample: "BSA…",
  },
  {
    id: "tavily",
    name: "Tavily",
    needs: "key",
    keyUrl: "https://app.tavily.com/home",
    keyExample: "tvly-…",
  },
  { id: "exa", name: "Exa", needs: "key", keyUrl: "https://dashboard.exa.ai/api-keys" },
  { id: "serper", name: "Serper (Google)", needs: "key", keyUrl: "https://serper.dev/api-keys" },
];

import { describe, expect, it } from "vitest";
import { dictionaries } from "../src/i18n.js";

// The components' source, read by Vite.
const sources = Object.entries(
  import.meta.glob<string>("../src/components/*.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
).map(([path, text]) => ({ file: path.split("/").pop() ?? path, text }));

/** Names and technical words that are the same in every language. */
const NAMES = new Set([
  "RedGiant",
  // Editors that speak ACP (G38.6).
  "Zed",
  "JetBrains",
  "Claude",
  "ChatGPT",
  "GitHub",
  "Gitea",
  "Italiano",
  "English",
  "CPU",
  "NVIDIA (CUDA)",
  "http",
  "stdio",
  "whisper-asr-webservice",
]);

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("translations", () => {
  it("has every text in both languages, with the same placeholders", () => {
    for (const [key, en] of Object.entries(dictionaries.en)) {
      const it = dictionaries.it[key as keyof typeof dictionaries.it];
      expect(en.trim(), `en.${key}`).not.toBe("");
      expect(it.trim(), `it.${key}`).not.toBe("");
      expect(placeholders(it), `placeholders of ${key}`).toEqual(placeholders(en));
    }
  });

  it("writes no text in the components outside t(), except names", () => {
    expect(sources.length).toBeGreaterThan(20);
    const found: string[] = [];
    for (const { file, text } of sources) {
      // Text between tags: <h3>Hello</h3>
      for (const m of text.matchAll(/>\s*([^<>{}]*\p{L}[^<>{}]*?)\s*<\//gu))
        if (!NAMES.has(m[1] ?? "")) found.push(`${file}: ${m[1]}`);
      // Words people read in attributes. Placeholders may show a technical example (no spaces).
      for (const m of text.matchAll(/\b(placeholder|title|aria-label|alt)="([^"]*\p{L}[^"]*)"/gu)) {
        const value = m[2] ?? "";
        if (m[1] === "placeholder" && !/\s/.test(value)) continue;
        if (!NAMES.has(value)) found.push(`${file}: ${m[1]}="${value}"`);
      }
    }
    expect(found).toEqual([]);
  });
});

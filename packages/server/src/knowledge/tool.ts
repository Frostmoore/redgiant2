// The agents' way into the knowledge (G36.5): `search_knowledge`, in the tools' catalog (the
// person can switch it off), searching only the collections the agent may read (their scope and
// the person's choice in the agent's window). Each piece comes back with a link
// `#kb:<piece>`: in the answer's list of sources the page turns it into a citation that opens
// the Canvas at the page or line (renderAnswer / openCitation).

import type { Tool, ToolContext } from "@redgiant/agent";
import {
  KNOWLEDGE_DOC_KINDS,
  type KnowledgeCitation,
  type KnowledgeHit,
  type KnowledgeSearchResult,
} from "@redgiant/protocol";
import { z } from "zod";
import type { KnowledgeAsker, KnowledgeService } from "./service.js";

/** Characters of one piece given back (the rest is a click away). */
const PIECE_CHARS = 1600;

/** How a citation is named in the answer: the file and its page or lines, a mail, a conversation. */
export function citationLabel(c: KnowledgeCitation): string {
  const name = c.title.replace(/[[\]]/g, "");
  if (c.source === "mail") return `Mail: ${name}`;
  if (c.source === "chats") return `Conversation: ${name}`;
  if (c.page) return `${name}, p. ${c.page}`;
  if (c.lineStart)
    return c.lineEnd && c.lineEnd !== c.lineStart
      ? `${name}, lines ${c.lineStart}-${c.lineEnd}`
      : `${name}, line ${c.lineStart}`;
  return name;
}

export const citationLink = (c: KnowledgeCitation) => `[${citationLabel(c)}](#kb:${c.chunkId})`;

const HOW =
  "Cite what you use as [1], [2]… and end your answer with the sources you cited, " +
  "a numbered list of their links as given here.";

/** The tool's answer: the pieces, numbered, each with its link. */
export function formatHits(r: KnowledgeSearchResult, names: ReadonlyMap<string, string>): string {
  if (!r.hits.length) return "Nothing found in the knowledge for that. Try other words.";
  const how = r.wordsOnly ? "words only" : "meaning and words";
  const out = [`${r.hits.length} pieces (${how}). ${HOW}`];
  r.hits.forEach((h: KnowledgeHit, i) => {
    const c = h.citation;
    const where = [names.get(c.collectionId), c.heading].filter(Boolean).join(" · ");
    const text =
      h.text.length > PIECE_CHARS ? `${h.text.slice(0, PIECE_CHARS).trimEnd()} […]` : h.text;
    out.push(`[${i + 1}] ${citationLink(c)}${where ? ` — ${where}` : ""}\n${text}`);
  });
  return out.join("\n\n");
}

const Input = z.object({
  query: z.string().trim().min(1).max(2000),
  collections: z.array(z.string()).max(50).optional(),
  kinds: z.array(z.enum(KNOWLEDGE_DOC_KINDS)).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

export function searchKnowledgeTool(
  knowledge: () => KnowledgeService | undefined,
  asker: Extract<KnowledgeAsker, { kind: "agent" }>,
): Tool {
  return {
    def: {
      name: "search_knowledge",
      description:
        "Search the person's documents (the knowledge collections you may read) by meaning and " +
        "words. Gives pieces with their source and a link to cite.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you look for, in plain words" },
          collections: {
            type: "array",
            items: { type: "string" },
            description: "Only these collections (names or ids)",
          },
          kinds: { type: "array", items: { type: "string", enum: [...KNOWLEDGE_DOC_KINDS] } },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query"],
      },
    },
    schema: Input,
    async run(i: z.infer<typeof Input>, ctx: ToolContext) {
      const k = knowledge();
      if (!k) return { content: "The knowledge is not running on this server.", isError: true };
      const visible = await k.visible(ctx.ownerId, asker);
      if (!visible.length)
        return "You can read no knowledge collection. The person adds them in Settings > Knowledge.";
      let only: string[] | undefined;
      if (i.collections?.length) {
        const wanted = i.collections.map((x) => x.trim().toLowerCase());
        only = visible
          .filter(
            (c) => wanted.includes(c.id.toLowerCase()) || wanted.includes(c.name.toLowerCase()),
          )
          .map((c) => c.id);
        if (!only.length)
          return {
            content: `No collection you can read is called that. Yours: ${visible.map((c) => c.name).join(", ")}.`,
            isError: true,
          };
      }
      const r = await k.search(
        ctx.ownerId,
        {
          query: i.query,
          ...(only && { collections: only }),
          ...(i.kinds?.length && { kinds: i.kinds }),
          limit: i.limit ?? 8,
        },
        asker,
        ctx.signal,
      );
      return formatHits(r, new Map(visible.map((c) => [c.id, c.name])));
    },
  } as Tool;
}

/**
 * The system prompt's part about the knowledge, written when a conversation starts (and kept
 * with it): which collections the agent can search, when to search, how to cite. Nothing when it
 * can read none.
 */
export function knowledgeSection(collections: { name: string; description: string | null }[]) {
  if (!collections.length) return "";
  const list = collections
    .slice(0, 30)
    .map((c) => `- ${c.name}${c.description ? `: ${c.description.slice(0, 160)}` : ""}`)
    .join("\n");
  return [
    "## Knowledge",
    "The person keeps documents you can search with search_knowledge, in these collections:",
    list,
    "When a question may be answered by them (their files, notes, manuals, mail…), search " +
      "before answering instead of guessing, and answer from what you found. Cite every fact " +
      "taken from a piece as [1], [2]… in the order you cite them, and end with the numbered " +
      "list of the sources you cited, each with the link the tool gave " +
      "(`1. [Manual.pdf, p. 3](#kb:123)`). If nothing relevant comes back, say so.",
  ].join("\n");
}

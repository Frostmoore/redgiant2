import type { ModelSpec } from "@redgiant/protocol";
import { complete, type ProviderRegistry, streamWithFallback } from "@redgiant/providers";
import type { Board } from "./board.js";

/**
 * Summaries of long threads and digests of a board ("what happened today in project X"),
 * written by a model chosen for it (normally a cheap or local one).
 */
export class BoardSummarizer {
  constructor(
    private readonly board: Board,
    private readonly providers: ProviderRegistry,
    private readonly model: ModelSpec,
    /** Summarise once this many posts are not covered by the summary yet. */
    private readonly every = 8,
  ) {}

  private async ask(system: string, text: string): Promise<string> {
    const c = await complete(
      streamWithFallback(this.providers, this.model, {
        system,
        tools: [],
        messages: [{ role: "user", parts: [{ type: "text", text }] }],
        maxTokens: 1500,
      }),
    );
    return c.message.parts
      .flatMap((p) => (p.type === "text" ? [p.text] : []))
      .join("")
      .trim();
  }

  /** Summarises a thread when enough new posts accumulated; returns the summary in use. */
  async maybeSummarize(ownerId: string, threadId: string): Promise<string | null> {
    const t = await this.board.thread(ownerId, threadId);
    if (!t) return null;
    if (t.posts - t.summaryUpTo < this.every) return t.summary;
    const posts = await this.board.posts(ownerId, threadId);
    const fresh = posts.slice(t.summaryUpTo);
    const text = [
      `Thread: ${t.title} (status: ${t.status})`,
      t.summary ? `Summary so far:\n${t.summary}` : "",
      "New posts:",
      ...fresh.map((p) => `[${p.kind}] ${p.author}: ${p.body}`),
    ].join("\n\n");
    const summary = await this.ask(
      "You keep a forum thread readable. Write a short summary: what it is about, decisions taken, open questions, blockers, who is doing what. Plain text, at most 10 lines.",
      text,
    );
    await this.board.saveSummary(ownerId, threadId, summary, posts.length);
    return summary;
  }

  /** A digest of one board since a moment. */
  async digest(ownerId: string, projectId: string | null, since: string): Promise<string> {
    const threads = (await this.board.threads(ownerId, projectId)).filter(
      (t) => t.updatedAt >= since,
    );
    if (threads.length === 0) return "Nothing new.";
    const parts: string[] = [];
    for (const t of threads) {
      const posts = (await this.board.posts(ownerId, t.id)).filter((p) => p.createdAt >= since);
      parts.push(
        `## ${t.title} [${t.status}]\n${t.summary ?? ""}\n${posts.map((p) => `- [${p.kind}] ${p.author}: ${p.body.slice(0, 400)}`).join("\n")}`,
      );
    }
    return this.ask(
      "Write a digest of this project board for its owner: decisions, results, open questions and blockers first. Be brief and concrete; one bullet per item.",
      parts.join("\n\n"),
    );
  }
}

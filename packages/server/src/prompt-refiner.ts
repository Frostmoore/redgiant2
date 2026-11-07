// The instructions' refiner (G36.13) and God's instructions for an agent made by hand (G36.14).
// One request to a model the person chose (or God's), never saved by itself: the person sees the
// before and after and saves as always. The text goes to the model with placeholders in place of
// the names ({god}, {demigod}, {name}, {role}); every placeholder and every tool name it had must
// come back exactly, or the model is asked once more, then the request fails and nothing changes.
// The cost: an estimate first, then what was really spent, on the global budget.
import type {
  AgentKind,
  ChatMessage,
  ModelSpec,
  RefineEstimate,
  RefineResult,
} from "@redgiant/protocol";
import {
  type Completion,
  complete,
  costUsd,
  type ProviderRegistry,
  streamWithFallback,
} from "@redgiant/providers";

/** What one revision needs, already resolved (names, built-in text, settings). */
export interface RefineJob {
  goal: "refine" | "draft";
  /** The text to start from, with placeholders. */
  text: string;
  /** RedGiant's built-in instructions for this agent, with placeholders; none for the general ones. */
  builtIn?: string | undefined;
  /** What is revised, for the model ("the project orchestrator", "every agent"…). */
  what: string;
  /** The agent's job and settings (draft), as lines "key: value". */
  settings?: string[] | undefined;
  request: string;
  /** The explanation's language. */
  lang: "it" | "en";
  /** The instructions for every agent stay in the language they are written in. */
  keepLanguage?: boolean | undefined;
  /** A new agent's tools to choose from (G36.14): what the rule for everyone gives it, by entry. */
  tools?: { id: string; tools: string[]; tokens: number }[] | undefined;
}

export class RefineError extends Error {
  constructor(
    message: string,
    readonly code: "budget" | "no_model" | "no_answer" | "removed_parts",
  ) {
    super(message);
  }
}

/** Stable, so the request is cacheable; the variable parts go in the message. */
export const REFINER_SYSTEM = `You revise the instructions (system prompts) of AI agents in RedGiant, a platform where a person runs a hierarchy of agents. Follow the good practice of prompt writing:
- Clear, direct instructions in the second person ("You ..."), saying what to do rather than only what to avoid; give the reason when it helps the agent judge edge cases.
- No contradictions, no repetitions, no filler; keep one consistent tone and one language.
- Keep the agent's identity, job and limits; organise the text so the most important rules come first. Short paragraphs; lists only where they help.
- Do not invent facts, tools, services or rules the text and the settings do not give.
- Placeholders in braces ({god}, {demigod}, {name}, {role}) are names filled in later: keep every one exactly as written, never replace it with a name and never add new kinds.
- Tool names (words like ask_god, delegate, create_project, propose_extension) are functional: keep every one that is there, spelled exactly, with what it is for.
- When the text is based on RedGiant's built-in instructions, keep every functional part of them: the tools and when to use them, how work is handed over, and every safety rule (what waits for the person's approval, what must be verified, what the agent must not do). You may reword them, never remove or weaken them.
- If the person asks for something that would remove a functional part or a safety rule, keep that part and say so in the explanation.

Answer in exactly this form, nothing before or after:
<prompt>
the whole revised instructions
</prompt>
<changes>
a short explanation of what you changed and why, as a few lines starting with "- ", in the language asked for
</changes>`;

const LANG_NAME = { it: "Italian", en: "English" } as const;

/** The message with the job: what is revised, the built-in text, the current one, the wish. */
export function refineMessage(job: RefineJob): string {
  const out: string[] = [];
  if (job.goal === "draft")
    out.push(
      `Write the instructions for ${job.what}. Start from RedGiant's built-in instructions below and adapt them to the agent's job and settings: say what it is for, how it should work and what it should pay attention to, as the person described it. Keep it compact.`,
    );
  else
    out.push(
      `Revise the instructions for ${job.what}. ${job.request.trim() ? "Follow the person's request below." : "The person asked for a general improvement: make them clearer and tighter without changing what the agent does."}`,
    );
  out.push(
    job.keepLanguage
      ? "Keep the instructions in the language they are written in."
      : "Write the instructions in English, as all of RedGiant's agent instructions are, whatever language the person writes in.",
  );
  out.push(`Write the explanation in ${LANG_NAME[job.lang]}.`);
  if (job.builtIn) out.push(`<built_in>\n${job.builtIn}\n</built_in>`);
  if (job.settings?.length)
    out.push(`<agent_settings>\n${job.settings.join("\n")}\n</agent_settings>`);
  if (job.goal === "refine" || job.text.trim() !== (job.builtIn ?? "").trim())
    out.push(`<current>\n${job.text}\n</current>`);
  if (job.request.trim()) out.push(`<request>\n${job.request.trim()}\n</request>`);
  if (job.tools?.length)
    out.push(
      `Also choose its tools. For each tool below say on if its job may need it, off if not, with a few words why: fewer tools make every request cheaper, and it can ask for an off tool later. After </changes>, add one line per tool:\n<tools>\non fetch: reads web pages for its research\noff blender: no 3D work\n</tools>\n<tools_available>\n${job.tools.map((t) => `${t.id} (${t.tools.join(", ")}; ${t.tokens} tokens)`).join("\n")}\n</tools_available>`,
    );
  return out.join("\n\n");
}

const PLACEHOLDERS = /\{(?:name|god|demigod|role)\}/g;
const TOOL_NAME = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/** What must come back exactly: the placeholders, and the tool names of an agent's instructions. */
export function requiredParts(
  text: string,
  builtIn: string | undefined,
  isAgent: boolean,
): string[] {
  const from = `${text}\n${isAgent ? (builtIn ?? "") : ""}`;
  const found = new Set(text.match(PLACEHOLDERS) ?? []);
  if (isAgent) {
    // Tool names in the text itself, and those of the built-in text the text still uses.
    for (const m of from.match(TOOL_NAME) ?? []) if (text.includes(m)) found.add(m);
  }
  return [...found].sort();
}

/** The revised text and the explanation, or null when the answer is not in the agreed form. */
/** The tools proposal (G36.14): each listed entry on or off with why; one not mentioned stays on. */
export function parseTools(
  answer: string,
  tools: { id: string; tokens: number }[],
): { id: string; on: boolean; why: string; tokens: number }[] {
  const block = /<tools>\s*([\s\S]*?)\s*(?:<\/tools>|$)/.exec(answer)?.[1] ?? "";
  const said = new Map<string, { on: boolean; why: string }>();
  for (const line of block.split("\n")) {
    const m = /^\s*[-*]?\s*(on|off)\s+([a-z0-9_]+)\s*[:\u2014-]?\s*(.*)$/i.exec(line);
    if (m?.[1] && m[2])
      said.set(m[2], { on: m[1].toLowerCase() === "on", why: (m[3] ?? "").trim().slice(0, 200) });
  }
  return tools.map((t) => ({
    id: t.id,
    tokens: t.tokens,
    on: said.get(t.id)?.on ?? true,
    why: said.get(t.id)?.why ?? "",
  }));
}

export function parseRefined(answer: string): { text: string; changes: string } | null {
  const p = /<prompt>\s*([\s\S]*?)\s*<\/prompt>/.exec(answer);
  if (!p?.[1]?.trim()) return null;
  const c = /<changes>\s*([\s\S]*?)\s*(?:<\/changes>|$)/.exec(answer.slice(p.index + p[0].length));
  return { text: p[1].trim(), changes: c?.[1]?.trim() ?? "" };
}

const tokensOf = (chars: number) => Math.ceil(chars / 3.5);

export interface RefinerDeps {
  providers: ProviderRegistry;
  budget: {
    check(keys: { scope: "global"; id: string }[]): Promise<unknown[]>;
    record(
      keys: { scope: "global"; id: string }[],
      usage: Completion["usage"],
      usd: number,
      at: { ownerId: string; projectId: string | null; agentId: string | null },
    ): Promise<unknown>;
  };
}

/** Runs a revision: one request, at most one correction, the cost on the global budget. */
export class PromptRefiner {
  constructor(private readonly d: RefinerDeps) {}

  private request(job: RefineJob, model: ModelSpec) {
    const info = this.d.providers.get(model.provider).modelInfo(model.model);
    const room = tokensOf(Math.max(job.text.length, job.builtIn?.length ?? 0)) * 2 + 2000;
    return {
      info,
      req: {
        system: REFINER_SYSTEM,
        tools: [],
        messages: [
          { role: "user", parts: [{ type: "text", text: refineMessage(job) }] },
        ] as ChatMessage[],
        effort: model.effort,
        maxTokens: Math.min(info.maxOutputTokens, Math.max(room, 4000), 32_000),
      },
    };
  }

  /** About how many tokens, and dollars when the model has a price (no reasoning counted). */
  estimate(job: RefineJob, model: ModelSpec): Omit<RefineEstimate, "base"> {
    const { info, req } = this.request(job, model);
    const inputTokens = tokensOf(req.system.length + refineMessage(job).length) + 10;
    const outputTokens =
      tokensOf(
        Math.max(job.text.length, job.builtIn?.length ?? 0) * 1.1 +
          (job.goal === "draft" ? 600 : 0),
      ) +
      120 +
      (job.tools?.length ?? 0) * 15;
    const usd = info.pricing
      ? costUsd(
          { inputTokens, outputTokens, cachedReadTokens: 0, cacheWriteTokens: 0 },
          info.pricing,
        )
      : null;
    return {
      inputTokens,
      outputTokens,
      usd,
      model: { provider: model.provider, model: model.model },
    };
  }

  async run(
    ownerId: string,
    job: RefineJob,
    model: ModelSpec,
    isAgent: boolean,
    signal?: AbortSignal,
  ): Promise<Omit<RefineResult, "text"> & { text: string }> {
    const keys = [{ scope: "global" as const, id: ownerId }];
    if ((await this.d.budget.check(keys)).length > 0)
      throw new RefineError("The budget is exhausted", "budget");
    const { info, req } = this.request(job, model);
    const required = requiredParts(job.text, job.builtIn, isAgent);
    let input = 0;
    let output = 0;
    let usd: number | null = info.pricing ? 0 : null;
    const ask = async (messages: ChatMessage[]) => {
      const c = await complete(
        streamWithFallback(this.d.providers, model, { ...req, messages }, signal),
      );
      const spent = costUsd(c.usage, this.d.providers.get(c.provider).modelInfo(c.model).pricing);
      await this.d.budget.record(keys, c.usage, spent, { ownerId, projectId: null, agentId: null });
      input += c.usage.inputTokens;
      output += c.usage.outputTokens;
      if (usd !== null) usd += spent;
      return c;
    };
    const textOf = (c: Completion) =>
      c.message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
    const first = await ask(req.messages);
    let lastAnswer = textOf(first);
    let got = parseRefined(lastAnswer);
    let missing = got ? required.filter((r) => !got?.text.includes(r)) : required;
    if (!got || missing.length > 0) {
      // Once more, with the same request plus what went wrong (the reasoning goes back too).
      const fix = got
        ? `Your version left out parts that must stay exactly as written: ${missing.join(", ")}. Give the whole revised instructions again, in the same form, with every one of them.`
        : "Your answer was not in the agreed form. Give the whole revised instructions again, exactly in the form <prompt>...</prompt><changes>...</changes>.";
      const again = await ask([
        ...req.messages,
        { role: "assistant", parts: first.message.parts },
        { role: "user", parts: [{ type: "text", text: fix }] },
      ]);
      lastAnswer = textOf(again);
      got = parseRefined(lastAnswer);
      missing = got ? required.filter((r) => !got?.text.includes(r)) : required;
    }
    if (!got) throw new RefineError("The model did not give a revised text", "no_answer");
    if (missing.length > 0)
      throw new RefineError(
        `The model left out parts that must stay: ${missing.join(", ")}. Nothing was changed.`,
        "removed_parts",
      );
    return {
      text: got.text,
      changes: got.changes,
      ...(job.tools?.length && { tools: parseTools(lastAnswer, job.tools) }),
      inputTokens: input,
      outputTokens: output,
      usd,
      model: { provider: model.provider, model: model.model },
    };
  }
}

/** How a kind of agent is called in the request to the model. */
export function kindLabel(kind: AgentKind): string {
  switch (kind) {
    case "god":
      return "the main orchestrator (God) of a RedGiant installation";
    case "demigod":
      return "the person's spokesperson on Telegram";
    case "orchestrator":
      return "a project's orchestrator";
    case "agent":
      return "a coding agent of a project";
    case "subagent":
      return "a sub-agent with one task";
    case "inspector":
      return "a project's inspector (read only)";
    case "assistant":
      return "a personal assistant of the person";
  }
}

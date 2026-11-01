import type { Event } from "@redgiant/protocol";

const WORDS = {
  en: { you: "You", tool: "Tool", answer: "Answer", noAnswer: "no answer", plan: "Proposed plan" },
  it: {
    you: "Tu",
    tool: "Strumento",
    answer: "Risposta",
    noAnswer: "nessuna risposta",
    plan: "Piano proposto",
  },
} as const;

const time = (iso: string) => iso.slice(0, 16).replace("T", " ");
const short = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};

/**
 * A conversation as Markdown (G20.5): what was said, the tools used in one line each, the
 * questions with their answers. Reasoning, raw tool output and erased events are left out.
 */
export function sessionMarkdown(
  events: Event[],
  o: { title: string; agentName: string; language: "it" | "en" },
): string {
  const w = WORDS[o.language];
  const out: string[] = [`# ${o.title}`, "", `${o.agentName} · ${time(events[0]?.ts ?? "")}`];
  const asked = new Map<string, { questions: { question: string }[]; plan?: string }>();
  for (const e of events) {
    if (e.payload === null) continue;
    switch (e.type) {
      case "message.user":
        out.push("", `## ${e.payload.from ?? w.you} · ${time(e.ts)}`, "", e.payload.text);
        if (e.payload.images?.length)
          out.push("", ...e.payload.images.map((im) => `*[${im.name ?? "image"}]*`));
        break;
      case "message.assistant": {
        const text = e.payload.parts
          .flatMap((p) => (p.type === "text" ? [p.text] : []))
          .join("")
          .trim();
        if (text) out.push("", `## ${o.agentName} · ${time(e.ts)}`, "", text);
        break;
      }
      case "tool.call":
        if (e.payload.tool === "ask_user" || e.payload.tool === "propose_plan") break;
        out.push("", `> ${w.tool} \`${e.payload.tool}\`: ${short(e.payload.input)}`);
        break;
      case "question.asked":
        asked.set(e.payload.requestId, {
          questions: e.payload.questions,
          ...(e.payload.plan !== undefined && { plan: e.payload.plan }),
        });
        break;
      case "question.answered": {
        const q = asked.get(e.payload.requestId);
        if (!q) break;
        if (q.plan !== undefined) out.push("", `### ${w.plan}`, "", q.plan);
        q.questions.forEach((x, i) => {
          const a = e.payload.answers?.[i]?.join("; ") ?? w.noAnswer;
          out.push(
            "",
            `> **${q.plan !== undefined ? w.plan : x.question}**  `,
            `> ${w.answer}: ${a}`,
          );
        });
        break;
      }
    }
  }
  return `${out.join("\n")}\n`;
}

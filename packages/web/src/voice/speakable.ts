// Hands-free voice (G38.4): what the agent's answer sounds like. A message said by voice carries a
// note for the model at its end (append-only, it never changes what came before): the answer will
// be read aloud, so plain sentences, and a short spoken version in <spoken>…</spoken> before a long
// one. The page reads that version when there is one; otherwise the answer without its Markdown,
// code and tables, cut to a few sentences when it is long. Tool cards are never read.

const HINT_OPEN = "<voice-mode>";
const HINT_CLOSE = "</voice-mode>";

/** The note for the model, in English as every instruction RedGiant gives a model. */
export const VOICE_HINT =
  "The person is talking to you by voice, hands-free, and your answer will be read aloud. " +
  "Answer in plain spoken sentences: no tables, no Markdown, no lists unless needed. " +
  "If the full answer needs code, a list or many details, write first a short spoken version " +
  "(at most three sentences) inside <spoken></spoken>, then the full answer for the screen.";

/** The person's words with the note for the model at the end. */
export const withVoiceHint = (text: string): string =>
  `${text}\n\n${HINT_OPEN}${VOICE_HINT}${HINT_CLOSE}`;

/** The person's words without the note (what the chat shows). */
export function stripVoiceHint(text: string): string {
  const at = text.lastIndexOf(HINT_OPEN);
  if (at < 0 || !text.trimEnd().endsWith(HINT_CLOSE)) return text;
  return text.slice(0, at).trimEnd();
}

/** The answer's spoken version, if the agent wrote one. */
export function spokenPart(markdown: string): string | undefined {
  const m = markdown.match(/<spoken>([\s\S]*?)<\/spoken>/i);
  const said = m?.[1]?.trim();
  return said ? said : undefined;
}

/** Markdown as it sounds: no code, tables, marks, addresses or HTML. */
export function plainSpeech(markdown: string): string {
  return (
    markdown
      .replace(/<spoken>[\s\S]*?<\/spoken>/gi, " ")
      // Code blocks and widgets are for the screen.
      .replace(/```[\s\S]*?(```|$)/g, "\n")
      .replace(/~~~[\s\S]*?(~~~|$)/g, "\n")
      // Tables: their rows are for the screen too.
      .replace(/^\s*\|.*\|\s*$/gm, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
      .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "")
      .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
      // A line is a sentence: give it its full stop so the voice pauses.
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => (/[.!?:;…]$/.test(l) ? l : `${l}.`))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Sentences, kept whole. */
export function sentences(text: string): string[] {
  return (
    text
      .match(/[^.!?…]+(?:[.!?…]+|$)/g)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? []
  );
}

/**
 * What the voice says for an answer: its spoken version, or the answer made plain; a long one is
 * cut after the sentences that fit in `maxChars`, with `more` («the rest is on screen») after.
 */
export function speakable(markdown: string, more: string, maxChars = 450): string {
  const said = spokenPart(markdown);
  if (said) return plainSpeech(said);
  const plain = plainSpeech(markdown);
  if (plain.length <= maxChars) return plain;
  let out = "";
  for (const s of sentences(plain)) {
    if (out && out.length + s.length + 1 > maxChars) break;
    out = out ? `${out} ${s}` : s;
  }
  // One sentence longer than all the room: cut at a word.
  if (out.length > maxChars) out = `${out.slice(0, maxChars).replace(/\s+\S*$/, "")}…`;
  return `${out} ${more}`.trim();
}

/** Pieces short enough for the browser's voice (Chrome stops a long one after ~15 s). */
export function chunksForVoice(text: string, max = 220): string[] {
  const out: string[] = [];
  for (const s of sentences(text)) {
    const last = out.at(-1);
    if (last !== undefined && last.length + s.length + 1 <= max)
      out[out.length - 1] = `${last} ${s}`;
    else if (s.length <= max) out.push(s);
    else for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  }
  return out;
}

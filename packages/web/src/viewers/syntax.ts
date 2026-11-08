// A light check of JSON, YAML and XML while the person types (G37.2): where the text stops being
// valid, said and marked in the editor, never blocking anything (the file is saved as it is).
// Pure: no view; YAML's parser is loaded only when a YAML file is checked.

export interface Problem {
  from: number;
  to: number;
  /** 1-based. */
  line: number;
  message: string;
}

/** The formats checked here (by the viewer's format: the file's extension, mostly). */
export type SyntaxFormat = "json" | "yaml" | "xml";

export function syntaxOf(format: string): SyntaxFormat | undefined {
  const f = format.toLowerCase();
  if (f === "json" || f === "jsonc" || f === "geojson") return "json";
  if (f === "yaml" || f === "yml") return "yaml";
  if (f === "xml" || f === "plist" || f === "svg") return "xml";
  return undefined;
}

/** The language's name as people know it. */
export const SYNTAX_NAMES: Record<SyntaxFormat, string> = {
  json: "JSON",
  yaml: "YAML",
  xml: "XML",
};

function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) out.push(i + 1);
  return out;
}

/** A problem at an offset, to the end of its line at most. */
function at(text: string, starts: number[], pos: number, message: string): Problem {
  const from = Math.max(0, Math.min(pos, text.length));
  let line = 0;
  while (line + 1 < starts.length && (starts[line + 1] as number) <= from) line++;
  const eol = text.indexOf("\n", from);
  const to = Math.min(from + 1, eol < 0 ? text.length : eol);
  return { from, to: Math.max(to, from), line: line + 1, message };
}

/** An offset from a 1-based line and column. */
const offsetOf = (starts: number[], line: number, col: number) =>
  (starts[Math.max(0, Math.min(line, starts.length) - 1)] ?? 0) + Math.max(0, col - 1);

/** JSON with comments and trailing commas, blanked out at the same length (offsets stay true). */
export function looseJson(text: string): string {
  return text
    .replace(/("(?:\\.|[^"\\\n])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s: string | undefined) =>
      s !== undefined ? s : m.replace(/[^\n]/g, " "),
    )
    .replace(/,(\s*[}\]])/g, " $1");
}

function jsonProblem(text: string, starts: number[], err: unknown): Problem {
  const msg = (err as Error).message ?? String(err);
  const lc = msg.match(/line (\d+) column (\d+)/i);
  const pos = msg.match(/position (\d+)/i);
  const where = lc
    ? offsetOf(starts, Number(lc[1]), Number(lc[2]))
    : pos
      ? Number(pos[1])
      : /end of (JSON )?(input|data)/i.test(msg)
        ? text.length
        : 0;
  // «Unexpected token } in JSON at position 42 (line 3 column 5)» → «Unexpected token }».
  const message =
    msg
      .replace(/^JSON\.parse: /, "")
      .replace(/,? (in JSON )?at (position \d+|line \d+ column \d+).*$/i, "")
      .replace(/ in JSON$/, "")
      .trim() || "Not valid JSON";
  return at(text, starts, where, message);
}

function checkJson(text: string): Problem[] {
  if (!text.trim()) return [];
  try {
    JSON.parse(text);
    return [];
  } catch {
    // Comments and trailing commas are common in .json (tsconfig, settings): allowed.
    const loose = looseJson(text);
    try {
      JSON.parse(loose);
      return [];
    } catch (err) {
      // One value per line (JSON Lines) is fine too.
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length > 1 && lines.every((l) => isJson(l))) return [];
      return [jsonProblem(text, lineStarts(text), err)];
    }
  }
}

const isJson = (s: string) => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

async function checkYaml(text: string): Promise<Problem[]> {
  const YAML = await import("yaml");
  const starts = lineStarts(text);
  const out: Problem[] = [];
  for (const d of YAML.parseAllDocuments(text)) {
    for (const e of d.errors) {
      const [from, to] = e.pos;
      const p = at(text, starts, from, e.message.split("\n")[0] ?? e.message);
      out.push({ ...p, to: Math.max(p.from, Math.min(to, text.length, p.to + 200)) });
      if (out.length >= 50) return out;
    }
  }
  return out;
}

function checkXml(text: string): Problem[] {
  if (!text.trim() || typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const bad = doc.getElementsByTagName("parsererror")[0];
  if (!bad) return [];
  const msg = (bad.textContent ?? "").replace(/\s+/g, " ").trim();
  const starts = lineStarts(text);
  // Chrome: «error on line 3 at column 7: …»; Firefox: «Line Number 3, Column 7»; others: «3:7: …».
  const lc =
    msg.match(/line (\d+) at column (\d+):?\s*(.*)$/i) ??
    msg.match(/Line Number (\d+), Column (\d+)/i) ??
    msg.match(/(\d+):(\d+):\s*(.*)$/);
  const line = lc ? Number(lc[1]) : 1;
  const col = lc ? Number(lc[2]) : 1;
  const firefox = msg.match(/XML Parsing Error: ([^.]*(\.[^L]*)?)/i)?.[1];
  const message =
    (firefox ?? lc?.[3] ?? msg)
      .replace(/^This page contains the following errors:\s*/i, "")
      .replace(/Below is a rendering.*$/i, "")
      .trim()
      .slice(0, 300) || "Not valid XML";
  return [at(text, starts, offsetOf(starts, line, col), message)];
}

/** Where the text is not valid for its format (empty: valid, or a format not checked). */
export async function syntaxProblems(text: string, format: string): Promise<Problem[]> {
  const kind = syntaxOf(format);
  try {
    if (kind === "json") return checkJson(text);
    if (kind === "yaml") return await checkYaml(text);
    if (kind === "xml") return checkXml(text);
  } catch {
    // A checker that fails says nothing: it never stands in the way.
  }
  return [];
}

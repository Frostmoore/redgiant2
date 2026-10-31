export type EditResult =
  | {
      ok: true;
      content: string;
      replacements: number;
      strategy: "exact" | "trailing-whitespace" | "indentation";
    }
  | { ok: false; error: string };

/**
 * Search/replace tolerant of the mistakes models make most: different line endings,
 * trailing whitespace, and indentation shifted as a whole. Ambiguous matches are refused
 * unless `replaceAll` is set; nothing is ever replaced on a guess.
 */
export function applyEdit(
  original: string,
  oldText: string,
  newText: string,
  replaceAll = false,
): EditResult {
  if (oldText === newText) return { ok: false, error: "old_string and new_string are identical." };
  const crlf = original.includes("\r\n");
  const content = crlf ? original.replace(/\r\n/g, "\n") : original;
  const oldN = oldText.replace(/\r\n/g, "\n");
  const newN = newText.replace(/\r\n/g, "\n");
  const back = (s: string) => (crlf ? s.replace(/\n/g, "\r\n") : s);

  // 1. Exact.
  const count = oldN === "" ? 0 : content.split(oldN).length - 1;
  if (count > 0) {
    if (count > 1 && !replaceAll) {
      return {
        ok: false,
        error: `old_string occurs ${count} times. Include more surrounding lines to make it unique, or set replace_all.`,
      };
    }
    const updated = replaceAll ? content.split(oldN).join(newN) : content.replace(oldN, () => newN);
    return {
      ok: true,
      content: back(updated),
      replacements: replaceAll ? count : 1,
      strategy: "exact",
    };
  }

  // 2. and 3. Line-based matching.
  const lines = content.split("\n");
  const oldLines = trimTrailingEmpty(oldN.split("\n"));
  const newLines = newN.split("\n");
  for (const strategy of ["trailing-whitespace", "indentation"] as const) {
    const norm =
      strategy === "trailing-whitespace" ? (l: string) => l.trimEnd() : (l: string) => l.trim();
    const matches: number[] = [];
    for (let i = 0; i + oldLines.length <= lines.length; i++) {
      if (oldLines.every((ol, j) => norm(lines[i + j] ?? "") === norm(ol))) matches.push(i);
    }
    if (matches.length === 0) continue;
    if (matches.length > 1 && !replaceAll) {
      return {
        ok: false,
        error: `old_string matches ${matches.length} places (ignoring whitespace). Include more surrounding lines, or set replace_all.`,
      };
    }
    // Replace from the bottom so earlier indexes stay valid.
    for (const start of [...matches].reverse()) {
      const replacement =
        strategy === "indentation"
          ? reindent(
              newLines,
              indentOf(oldLines.find((l) => l.trim()) ?? ""),
              indentOf(lines[start + firstNonEmpty(oldLines)] ?? ""),
            )
          : newLines;
      lines.splice(start, oldLines.length, ...replacement);
    }
    return { ok: true, content: back(lines.join("\n")), replacements: matches.length, strategy };
  }

  return { ok: false, error: notFoundHint(lines, oldLines) };
}

const trimTrailingEmpty = (ls: string[]) => {
  const out = [...ls];
  while (out.length > 1 && out.at(-1)?.trim() === "") out.pop();
  return out;
};
const indentOf = (l: string) => l.match(/^\s*/)?.[0] ?? "";
const firstNonEmpty = (ls: string[]) =>
  Math.max(
    0,
    ls.findIndex((l) => l.trim() !== ""),
  );

/** Moves a block from one base indentation to another. */
function reindent(block: string[], from: string, to: string): string[] {
  return block.map((l) => {
    if (l.trim() === "") return l;
    return l.startsWith(from) ? to + l.slice(from.length) : to + l.trimStart();
  });
}

function notFoundHint(lines: string[], oldLines: string[]): string {
  const base =
    "old_string was not found in the file. Read the file again and copy the text exactly.";
  // The first line of old_string that does exist in the file shows where the model was looking.
  for (const ol of oldLines.map((l) => l.trim()).filter((l) => l.length > 3)) {
    const at = lines.findIndex((l) => l.trim() === ol);
    if (at !== -1) return `${base} Line ${at + 1} matches part of it: ${JSON.stringify(lines[at])}`;
  }
  return base;
}

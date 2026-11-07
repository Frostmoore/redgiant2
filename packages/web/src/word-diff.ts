// The before and after of a text, word by word (G36.13, the instructions' refiner): what stays,
// what goes, what comes. A longest common subsequence over words, punctuation and spaces; texts too long for that are compared line by line instead.

export interface DiffPart {
  kind: "same" | "del" | "add";
  text: string;
}

/** Words, punctuation and spaces apart, so «kind.» and «kind and» share «kind». */
const words = (s: string) => s.match(/\s+|[\p{L}\p{N}_{}']+|[^\p{L}\p{N}_{}'\s]/gu) ?? [];
const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
/** Above this many cells the table would be slow on a phone: lines instead of words. */
const MAX_CELLS = 3_000_000;

function lcs(a: string[], b: string[]): DiffPart[] {
  // Common start and end first: most revisions leave them alone.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);
  const n = x.length;
  const m = y.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[at(i, j)] =
        x[i] === y[j]
          ? (table[at(i + 1, j + 1)] as number) + 1
          : Math.max(table[at(i + 1, j)] as number, table[at(i, j + 1)] as number);
  const out: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = out.at(-1);
    if (last?.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  if (start) push("same", a.slice(0, start).join(""));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      push("same", x[i] as string);
      i++;
      j++;
    } else if (
      j < m &&
      (i === n || (table[at(i, j + 1)] as number) >= (table[at(i + 1, j)] as number))
    ) {
      push("add", y[j] as string);
      j++;
    } else {
      push("del", x[i] as string);
      i++;
    }
  }
  if (end) push("same", a.slice(a.length - end).join(""));
  return out;
}

/** The parts of `before` and `after`, in order; `del` only in the before, `add` only in the after. */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = words(before);
  const b = words(after);
  if (a.length * b.length <= MAX_CELLS) return lcs(a, b);
  return lcs(lines(before), lines(after));
}

/** How many words went and came. */
export function diffCounts(parts: DiffPart[]): { del: number; add: number } {
  const count = (k: DiffPart["kind"]) =>
    parts.filter((p) => p.kind === k).reduce((n, p) => n + (p.text.match(/\S+/g)?.length ?? 0), 0);
  return { del: count("del"), add: count("add") };
}

const bag = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

/**
 * Whether what an agent does changed enough to offer rewriting its instructions (G36.14): fewer
 * than half of the meaningful words in common. A typo or one more detail is not enough.
 */
export function substantialChange(before: string, after: string): boolean {
  const a = bag(before);
  const b = bag(after);
  if (a.size === 0 && b.size === 0) return false;
  if (a.size === 0 || b.size === 0) return true;
  let common = 0;
  for (const w of a) if (b.has(w)) common++;
  return common / (a.size + b.size - common) < 0.5;
}

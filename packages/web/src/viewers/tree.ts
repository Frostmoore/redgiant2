// JSON, YAML and XML as one kind of tree (G34.2), for a view that opens and closes its branches.
// YAML is read by `yaml` (ISC), XML by the browser's own parser; nothing in them runs.

export interface TreeNode {
  /** The key, the index or the element's name. */
  label: string;
  /** For a leaf: its value in words; for a branch: undefined. */
  value?: string;
  /** What kind of value (for its colour): string, number, boolean, null, element, text. */
  type: "string" | "number" | "boolean" | "null" | "object" | "array" | "element" | "text";
  children?: TreeNode[];
}

/** Any JavaScript value (from JSON or YAML) as a tree. */
export function valueTree(label: string, v: unknown, depth = 0): TreeNode {
  if (depth > 200) return { label, type: "string", value: "…" };
  if (v === null || v === undefined) return { label, type: "null", value: "null" };
  if (Array.isArray(v))
    return { label, type: "array", children: v.map((x, i) => valueTree(String(i), x, depth + 1)) };
  if (v instanceof Date) return { label, type: "string", value: v.toISOString() };
  if (typeof v === "object")
    return {
      label,
      type: "object",
      children: Object.entries(v as Record<string, unknown>).map(([k, x]) =>
        valueTree(k, x, depth + 1),
      ),
    };
  if (typeof v === "number" || typeof v === "bigint")
    return { label, type: "number", value: String(v) };
  if (typeof v === "boolean") return { label, type: "boolean", value: String(v) };
  return { label, type: "string", value: String(v) };
}

/** An XML element as a tree: its attributes, then its children and its text. */
export function xmlTree(el: Element, depth = 0): TreeNode {
  const children: TreeNode[] = [];
  for (const a of el.attributes)
    children.push({ label: `@${a.name}`, type: "string", value: a.value });
  for (const c of el.childNodes) {
    if (c.nodeType === 1 && depth < 200) children.push(xmlTree(c as Element, depth + 1));
    else if ((c.nodeType === 3 || c.nodeType === 4) && c.nodeValue?.trim())
      children.push({ label: "#text", type: "text", value: c.nodeValue.trim() });
  }
  // An element holding only its text reads as a leaf.
  const only = children.length === 1 && children[0]?.type === "text" ? children[0] : undefined;
  return only
    ? { label: el.tagName, type: "element", value: only.value }
    : { label: el.tagName, type: "element", children };
}

/** A file's text as a tree, by its format; an error says why it could not be read. */
export async function parseTree(text: string, format: string): Promise<TreeNode> {
  if (format === "yaml" || format === "yml") {
    const YAML = await import("yaml");
    const docs = YAML.parseAllDocuments(text);
    const errors = docs.flatMap((d) => d.errors);
    if (errors[0]) throw new Error(errors[0].message);
    const values = docs.map((d) => d.toJS({ maxAliasCount: 100 }));
    return valueTree("", values.length === 1 ? values[0] : values);
  }
  if (format === "xml" || format === "plist" || format === "svg") {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const bad = doc.getElementsByTagName("parsererror")[0];
    if (bad) throw new Error(bad.textContent?.split("\n")[0] ?? "XML");
    return xmlTree(doc.documentElement);
  }
  // JSON, also with comments and trailing commas (jsonc).
  try {
    return valueTree("", JSON.parse(text));
  } catch (err) {
    const loose = text
      .replace(
        /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
        (_m, s: string | undefined) => s ?? "",
      )
      .replace(/,(\s*[}\]])/g, "$1");
    try {
      return valueTree("", JSON.parse(loose));
    } catch {
      // A file of one JSON value per line (JSON Lines).
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      try {
        return valueTree(
          "",
          lines.map((l) => JSON.parse(l)),
        );
      } catch {
        throw err;
      }
    }
  }
}

/** How many nodes a tree has (to open it all only when small). */
export function countNodes(n: TreeNode): number {
  return 1 + (n.children ?? []).reduce((s, c) => s + countNodes(c), 0);
}

/**
 * The labels from the root to the JSON value at an offset (p3.5.4: a broken config.json showed its
 * tree with nothing marked): the member or item the offset is in, or the last one before it (a
 * trailing comma belongs to the value it follows). Comments are skipped; [] at the top level.
 */
export function jsonPathAt(text: string, pos: number): string[] {
  type Frame = { arr: boolean; label: string | undefined; index: number; started: boolean };
  const stack: Frame[] = [];
  let pendingKey: string | undefined;
  const end = Math.min(pos, text.length);
  const path = () => stack.map((f) => f.label).filter((l): l is string => l !== undefined);
  /** A value starts in the frame on top: an array counts its items. */
  const valueStarts = () => {
    const top = stack.at(-1);
    if (!top) return;
    if (top.arr) {
      if (top.started) top.index++;
      top.started = true;
      top.label = String(top.index);
    } else if (pendingKey !== undefined) {
      top.label = pendingKey;
      pendingKey = undefined;
    }
  };
  let i = 0;
  while (i < end) {
    const c = text[i] as string;
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 2;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"' && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      const raw = text.slice(i, j + 1);
      let word: string;
      try {
        word = JSON.parse(raw) as string;
      } catch {
        word = raw.slice(1, -1);
      }
      // A key when a colon follows, a value otherwise.
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k] as string)) k++;
      const top = stack.at(-1);
      if (text[k] === ":" && top && !top.arr) pendingKey = word;
      else valueStarts();
      i = j + 1;
      continue;
    }
    if (c === "{" || c === "[") {
      valueStarts();
      stack.push({ arr: c === "[", label: undefined, index: 0, started: false });
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      stack.pop();
      i++;
      continue;
    }
    if (c === "," || c === ":" || /\s/.test(c)) {
      i++;
      continue;
    }
    // A number, true, false, null (or a stray word): one value.
    valueStarts();
    while (i < end && !/[\s,:{}[\]"/]/.test(text[i] as string)) i++;
  }
  return path();
}

/** The lines around a line (1-based), numbered, for a text whose tree cannot be built. */
export function linesAround(
  text: string,
  line: number,
  around = 3,
): { n: number; text: string; bad: boolean }[] {
  const all = text.split(/\r?\n/);
  const from = Math.max(1, line - around);
  const to = Math.min(all.length, line + around);
  const out: { n: number; text: string; bad: boolean }[] = [];
  for (let n = from; n <= to; n++)
    out.push({ n, text: (all[n - 1] ?? "").slice(0, 300), bad: n === line });
  return out;
}

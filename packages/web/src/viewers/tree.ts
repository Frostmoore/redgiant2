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

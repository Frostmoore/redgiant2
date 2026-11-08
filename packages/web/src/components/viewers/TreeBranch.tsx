// One branch of a tree of JSON, YAML or XML that opens and closes (G34.2): the viewer's tree and,
// since G37.2, the editor's (apart, so the editor does not pull in the whole viewer).
import { useState } from "preact/hooks";
import { t } from "../../i18n.js";
import { IconChevron } from "../../icons.js";
import type { TreeNode } from "../../viewers/tree.js";

const MAX_CHILDREN = 500;

export function Branch({
  node,
  depth,
  open: start,
}: {
  node: TreeNode;
  depth: number;
  open: number;
}) {
  const [open, setOpen] = useState(depth < start);
  const [more, setMore] = useState(false);
  const kids = node.children;
  if (!kids)
    return (
      <div class="vw-tree-leaf">
        {node.label && <span class="vw-tree-key">{node.label}</span>}
        <span class={`vw-tree-val ${node.type}`}>
          {node.type === "string" ? JSON.stringify(node.value) : node.value}
        </span>
      </div>
    );
  const shown = more ? kids : kids.slice(0, MAX_CHILDREN);
  const count =
    node.type === "array"
      ? t("vwItems", { n: kids.length.toLocaleString() })
      : node.type === "object"
        ? t("vwKeys", { n: kids.length.toLocaleString() })
        : "";
  return (
    <div class="vw-tree-branch">
      <button
        type="button"
        class="vw-tree-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <IconChevron open={open} size={12} />
        {node.label && <span class="vw-tree-key">{node.label}</span>}
        <span class="dim">{count}</span>
      </button>
      {open && (
        <div class="vw-tree-kids">
          {shown.map((c, i) => (
            <Branch key={i} node={c} depth={depth + 1} open={start} />
          ))}
          {!more && kids.length > MAX_CHILDREN && (
            <button type="button" class="vw-link" onClick={() => setMore(true)}>
              {t("vwShowMore", { n: (kids.length - MAX_CHILDREN).toLocaleString() })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

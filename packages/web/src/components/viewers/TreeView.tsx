// JSON, YAML and XML as a tree whose branches open and close (G34.2), with the file's text a press
// away. Big trees open only their first levels.
import { useEffect, useState } from "preact/hooks";
import { t } from "../../i18n.js";
import { IconChevron } from "../../icons.js";
import { countNodes, parseTree, type TreeNode } from "../../viewers/tree.js";
import { useText, type ViewerProps } from "../../viewers/source.js";

const MAX_CHILDREN = 500;

function Branch({ node, depth, open: start }: { node: TreeNode; depth: number; open: number }) {
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

export function TreeView({ src }: ViewerProps) {
  const { value, error } = useText(src.url);
  const [tree, setTree] = useState<TreeNode>();
  const [failed, setFailed] = useState<string>();
  const [raw, setRaw] = useState(false);
  // Remounted to open or close everything.
  const [all, setAll] = useState<{ open: number; n: number }>({ open: 2, n: 0 });
  useEffect(() => {
    if (value === undefined) return;
    void parseTree(value, src.format).then(
      (n) => {
        setTree(n);
        if (countNodes(n) < 300) setAll({ open: 99, n: 0 });
      },
      (e: unknown) => setFailed((e as Error).message),
    );
  }, [value]);
  if (error) return <div class="vw-empty">{error}</div>;
  if (value === undefined || (!tree && !failed))
    return <div class="vw-empty dim">{t("loading")}</div>;
  return (
    <div class="vw-tree">
      <div class="vw-bar">
        <div class="vw-seg">
          <button
            type="button"
            class={!raw ? "on" : ""}
            aria-pressed={!raw}
            onClick={() => setRaw(false)}
          >
            {t("vwTree")}
          </button>
          <button
            type="button"
            class={raw ? "on" : ""}
            aria-pressed={raw}
            onClick={() => setRaw(true)}
          >
            {t("vwSource")}
          </button>
        </div>
        {!raw && tree && (
          <>
            <button
              type="button"
              class="vw-toggle"
              onClick={() => setAll({ open: 99, n: all.n + 1 })}
            >
              {t("vwOpenAll")}
            </button>
            <button
              type="button"
              class="vw-toggle"
              onClick={() => setAll({ open: 1, n: all.n + 1 })}
            >
              {t("vwCloseAll")}
            </button>
          </>
        )}
      </div>
      {failed && !raw && <p class="vw-note">{t("vwTreeNo", { why: failed })}</p>}
      {raw || !tree ? (
        <pre class="vw-raw">{value}</pre>
      ) : (
        <div class="vw-tree-body" key={all.n}>
          <Branch node={tree} depth={0} open={all.open} />
        </div>
      )}
    </div>
  );
}

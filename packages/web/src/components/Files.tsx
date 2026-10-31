import { useEffect, useState } from "preact/hooks";
import type { FileEntry } from "../api.js";
import { bytes } from "../format.js";
import { t } from "../i18n.js";
import { attempt, getApi, openTab } from "../state.js";

function Folder({
  scope,
  path,
  depth,
  version,
  select,
  selected,
}: {
  scope: string;
  path: string;
  depth: number;
  version: number;
  select: (e: FileEntry) => void;
  selected: string | null;
}) {
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (path: string) => {
    const next = new Set(open);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setOpen(next);
  };
  const openFile = (e: FileEntry) =>
    openTab({ id: `edit:${scope}:${e.path}`, type: "editor", title: e.name, scope, path: e.path });
  useEffect(() => {
    void attempt(() => getApi().list(scope, path)).then((e) => setEntries(e ?? []));
  }, [scope, path, version]);
  if (!entries)
    return (
      <div class="dim" style={{ paddingLeft: `${depth * 14 + 8}px` }}>
        …
      </div>
    );
  return (
    <>
      {entries.map((e) => (
        <div key={e.path}>
          <div
            role="treeitem"
            tabIndex={0}
            aria-selected={selected === e.path}
            {...(e.type === "dir" && { "aria-expanded": open.has(e.path) })}
            class={`tree-row${selected === e.path ? " selected" : ""}`}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            onKeyDown={(k) => {
              if (k.key !== "Enter" && k.key !== " ") return;
              k.preventDefault();
              select(e);
              if (e.type === "dir") toggle(e.path);
              else openFile(e);
            }}
            onClick={() => {
              select(e);
              if (e.type === "dir") toggle(e.path);
            }}
            onDblClick={() =>
              e.type === "file" &&
              openTab({
                id: `edit:${scope}:${e.path}`,
                type: "editor",
                title: e.name,
                scope,
                path: e.path,
              })
            }
          >
            <span class="icon">
              {e.type === "dir" ? (open.has(e.path) ? "▾" : "▸") : e.type === "link" ? "↪" : "·"}
            </span>
            <span class="name">{e.name}</span>
            {e.type === "file" && <span class="dim size">{bytes(e.size)}</span>}
          </div>
          {e.type === "dir" && open.has(e.path) && (
            <Folder
              scope={scope}
              path={e.path}
              depth={depth + 1}
              version={version}
              select={select}
              selected={selected}
            />
          )}
        </div>
      ))}
    </>
  );
}

/** File explorer of a project ("project:<id>") or of God's platform ("platform"). */
export function Files({ scope }: { scope: string }) {
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const reload = () => setVersion((v) => v + 1);
  const base = selected
    ? selected.type === "dir"
      ? selected.path
      : selected.path.split("/").slice(0, -1).join("/")
    : "";
  const join = (name: string) => (base ? `${base}/${name}` : name);
  const api = getApi();

  const act = (f: () => Promise<unknown>) => void attempt(f).then(reload);
  const upload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => {
      for (const file of Array.from(input.files ?? [])) {
        void file.arrayBuffer().then((buf) => {
          let binary = "";
          for (const b of new Uint8Array(buf)) binary += String.fromCharCode(b);
          act(() => api.write(scope, join(file.name), btoa(binary), "base64"));
        });
      }
    };
    input.click();
  };
  const download = async (e: FileEntry) => {
    const blob = await attempt(() => api.download(scope, e.path));
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = e.name;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div class="files">
      <div class="toolbar">
        <button
          type="button"
          onClick={() => {
            const n = prompt(t("newFile"), join(""));
            if (n) act(() => api.write(scope, n, ""));
          }}
        >
          {t("newFile")}
        </button>
        <button
          type="button"
          onClick={() => {
            const n = prompt(t("newFolder"), join(""));
            if (n) act(() => api.fileOp({ op: "mkdir", scope, path: n }));
          }}
        >
          {t("newFolder")}
        </button>
        <button type="button" onClick={upload}>
          {t("upload")}
        </button>
        <button
          type="button"
          disabled={!selected}
          onClick={() => {
            if (!selected) return;
            const to = prompt(t("rename"), selected.path);
            if (to && to !== selected.path)
              act(() => api.fileOp({ op: "rename", scope, path: selected.path, to }));
          }}
        >
          {t("rename")}
        </button>
        <button
          type="button"
          disabled={selected?.type !== "file"}
          onClick={() => selected && void download(selected)}
        >
          {t("download")}
        </button>
        <button
          type="button"
          class="danger"
          disabled={!selected}
          onClick={() => {
            if (selected && confirm(t("confirmDelete", { path: selected.path }))) {
              act(() => api.fileOp({ op: "delete", scope, path: selected.path }));
              setSelected(null);
            }
          }}
        >
          {t("delete")}
        </button>
        <button type="button" onClick={reload} title="↻">
          ↻
        </button>
      </div>
      <div class="tree">
        <Folder
          scope={scope}
          path="."
          depth={0}
          version={version}
          select={setSelected}
          selected={selected?.path ?? null}
        />
      </div>
    </div>
  );
}

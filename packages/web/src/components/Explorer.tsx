import { useEffect, useState } from "preact/hooks";
import type { FileEntry } from "../api.js";
import { bytes } from "../format.js";
import { t } from "../i18n.js";
import {
  IconChevron,
  IconClose,
  IconDownload,
  IconFile,
  IconFilePlus,
  IconFolder,
  IconFolderPlus,
  IconPencil,
  IconRefresh,
  IconTerminal,
  IconTrash,
  IconUpload,
} from "../icons.js";
import { attempt, currentScope, getApi, openTab, toggleExplorer } from "../state.js";

const openFile = (scope: string, e: FileEntry) =>
  openTab({ id: `edit:${scope}:${e.path}`, type: "editor", title: e.name, scope, path: e.path });

function Folder({
  scope,
  path,
  depth,
  version,
  selected,
  select,
  act,
}: {
  scope: string;
  path: string;
  depth: number;
  version: number;
  selected: string | null;
  select: (e: FileEntry) => void;
  act: (f: () => Promise<unknown>) => void;
}) {
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const api = getApi();
  useEffect(() => {
    void attempt(() => api.list(scope, path)).then((e) => setEntries(e ?? []));
  }, [scope, path, version]);
  const toggle = (p: string) => {
    const next = new Set(open);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setOpen(next);
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
  if (!entries)
    return (
      <div class="tree-row dim" style={{ paddingLeft: `${depth * 14 + 10}px` }}>
        …
      </div>
    );
  if (entries.length === 0 && depth === 0) return <div class="empty">{t("emptyFolder")}</div>;
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
            onClick={() => {
              select(e);
              if (e.type === "dir") toggle(e.path);
              else openFile(scope, e);
            }}
            onKeyDown={(k) => {
              if (k.key !== "Enter" && k.key !== " ") return;
              k.preventDefault();
              select(e);
              if (e.type === "dir") toggle(e.path);
              else openFile(scope, e);
            }}
          >
            {e.type === "dir" ? (
              <IconChevron open={open.has(e.path)} size={12} />
            ) : (
              <span style={{ width: "12px" }} />
            )}
            {e.type === "dir" ? <IconFolder size={14} /> : <IconFile size={14} />}
            <span class="name">{e.name}</span>
            <span class="tree-actions">
              <button
                type="button"
                class="icon-button"
                title={t("rename")}
                onClick={(ev) => {
                  ev.stopPropagation();
                  const to = prompt(t("rename"), e.path);
                  if (to && to !== e.path)
                    act(() => api.fileOp({ op: "rename", scope, path: e.path, to }));
                }}
              >
                <IconPencil size={12} />
              </button>
              {e.type === "file" && (
                <button
                  type="button"
                  class="icon-button"
                  title={t("download")}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    void download(e);
                  }}
                >
                  <IconDownload size={12} />
                </button>
              )}
              <button
                type="button"
                class="icon-button"
                title={t("delete")}
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (confirm(t("confirmDelete", { path: e.path })))
                    act(() => api.fileOp({ op: "delete", scope, path: e.path }));
                }}
              >
                <IconTrash size={12} />
              </button>
            </span>
            {e.type === "file" && <span class="dim size">{bytes(e.size)}</span>}
          </div>
          {e.type === "dir" && open.has(e.path) && (
            <Folder
              scope={scope}
              path={e.path}
              depth={depth + 1}
              version={version}
              selected={selected}
              select={select}
              act={act}
            />
          )}
        </div>
      ))}
    </>
  );
}

/** The files of the active conversation's project (or God's platform), on the right. */
export function Explorer() {
  const { scope, title } = currentScope();
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const reload = () => setVersion((v) => v + 1);
  const api = getApi();
  const act = (f: () => Promise<unknown>) => void attempt(f).then(reload);
  const base = selected
    ? selected.type === "dir"
      ? selected.path
      : selected.path.split("/").slice(0, -1).join("/")
    : "";
  const join = (name: string) => (base ? `${base}/${name}` : name);
  useEffect(() => setSelected(null), [scope]);
  const upload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => {
      for (const file of Array.from(input.files ?? []))
        void file.arrayBuffer().then((buf) => {
          let binary = "";
          for (const b of new Uint8Array(buf)) binary += String.fromCharCode(b);
          act(() => api.write(scope, join(file.name), btoa(binary), "base64"));
        });
    };
    input.click();
  };
  return (
    <aside class="explorer">
      <div class="explorer-head">
        <strong title={title}>{title}</strong>
        <button
          type="button"
          class="icon-button"
          title={t("newFile")}
          onClick={() => {
            const n = prompt(t("newFile"), join(""));
            if (n) act(() => api.write(scope, n, ""));
          }}
        >
          <IconFilePlus />
        </button>
        <button
          type="button"
          class="icon-button"
          title={t("newFolder")}
          onClick={() => {
            const n = prompt(t("newFolder"), join(""));
            if (n) act(() => api.fileOp({ op: "mkdir", scope, path: n }));
          }}
        >
          <IconFolderPlus />
        </button>
        <button type="button" class="icon-button" title={t("upload")} onClick={upload}>
          <IconUpload />
        </button>
        <button type="button" class="icon-button" title={t("refresh")} onClick={reload}>
          <IconRefresh />
        </button>
        <button
          type="button"
          class="icon-button"
          title={t("terminal")}
          onClick={() =>
            openTab({
              id: `term:${scope}:${Date.now()}`,
              type: "terminal",
              title: `${t("terminal")} · ${title}`,
              scope,
            })
          }
        >
          <IconTerminal />
        </button>
        <button
          type="button"
          class="icon-button"
          title={t("close")}
          onClick={() => toggleExplorer(false)}
        >
          <IconClose />
        </button>
      </div>
      <div class="explorer-where">
        {t("folder")}: <code>/{base}</code>
      </div>
      <div class="tree">
        <Folder
          scope={scope}
          path="."
          depth={0}
          version={version}
          selected={selected?.path ?? null}
          select={setSelected}
          act={act}
        />
      </div>
    </aside>
  );
}

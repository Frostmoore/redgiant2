import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type FileEntry } from "../api.js";
import { bytes } from "../format.js";
import { t } from "../i18n.js";
import {
  IconChevron,
  IconClose,
  IconDownload,
  IconEye,
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
import { attempt, currentScope, getApi, openCanvas, openTab, toggleExplorer } from "../state.js";
import { useSwipeAway } from "../swipe.js";
import { askConfirm, askText } from "./dialogs.js";

/** A file's content as base64 (FileReader: fast even for large files). */
const asBase64 = (file: File) =>
  new Promise<string>((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] ?? "");
    r.onerror = () => ko(r.error);
    r.readAsDataURL(file);
  });

const HIDDEN_KEY = "rg.showHidden";

/**
 * A file opens in the Canvas (p3.5.1): the same tab an agent showing it would open. On a phone
 * the list covers the Canvas: it steps aside to show the file.
 */
const openFile = (scope: string, e: FileEntry) => {
  openCanvas(e.name, { kind: "file", scope, path: e.path });
  if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches)
    toggleExplorer(false);
};

function Folder({
  scope,
  path,
  depth,
  version,
  selected,
  select,
  act,
  hidden,
  dropInto,
  reveal,
}: {
  /** A folder to show open, with the ones above it (a subproject's). */
  reveal?: string | undefined;
  scope: string;
  path: string;
  depth: number;
  version: number;
  selected: string | null;
  select: (e: FileEntry) => void;
  act: (f: () => Promise<unknown>) => void;
  hidden: boolean;
  dropInto: (dir: string, files: FileList) => void;
}) {
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const api = getApi();
  useEffect(() => {
    void attempt(() => api.list(scope, path)).then((e) => setEntries(e ?? []));
  }, [scope, path, version]);
  useEffect(() => {
    if (!reveal) return;
    const up = (entries ?? []).filter(
      (e) => e.type === "dir" && (reveal === e.path || reveal.startsWith(`${e.path}/`)),
    );
    if (up.length > 0) setOpen((o) => new Set([...o, ...up.map((e) => e.path)]));
  }, [entries, reveal]);
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
  const shown = hidden ? entries : entries.filter((e) => !e.name.startsWith("."));
  if (shown.length === 0 && depth === 0) return <div class="empty">{t("emptyFolder")}</div>;
  return (
    <>
      {shown.map((e) => (
        <div key={e.path}>
          <div
            role="treeitem"
            tabIndex={0}
            aria-selected={selected === e.path}
            {...(e.type === "dir" && { "aria-expanded": open.has(e.path) })}
            class={`tree-row${selected === e.path ? " selected" : ""}`}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            {...(e.type === "dir" && {
              onDragOver: (ev: DragEvent) => {
                ev.preventDefault();
                ev.stopPropagation();
                (ev.currentTarget as HTMLElement).classList.add("drop");
              },
              onDragLeave: (ev: DragEvent) =>
                (ev.currentTarget as HTMLElement).classList.remove("drop"),
              onDrop: (ev: DragEvent) => {
                ev.preventDefault();
                ev.stopPropagation();
                (ev.currentTarget as HTMLElement).classList.remove("drop");
                if (ev.dataTransfer?.files.length) dropInto(e.path, ev.dataTransfer.files);
              },
            })}
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
                onClick={async (ev) => {
                  ev.stopPropagation();
                  const to = await askText(t("rename"), e.path, { label: t("dlgPath") });
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
                onClick={async (ev) => {
                  ev.stopPropagation();
                  const forGood = e.path === ".trash" || e.path.startsWith(".trash/");
                  if (
                    await askConfirm(
                      t(forGood ? "confirmDeleteForGood" : "confirmDelete", { path: e.path }),
                      { danger: true, yes: t("delete") },
                    )
                  )
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
              hidden={hidden}
              dropInto={dropInto}
              reveal={reveal}
            />
          )}
        </div>
      ))}
    </>
  );
}

/** The files of the active conversation's project (or God's platform), on the right. */
export function Explorer() {
  const { scope, title, focus } = currentScope();
  const panel = useRef<HTMLElement>(null);
  useSwipeAway(panel, "right", () => toggleExplorer(false));
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
  const [hidden, setHidden] = useState(localStorage.getItem(HIDDEN_KEY) === "1");
  const [dragging, setDragging] = useState(false);
  /** A name already taken: the human picks keep both, replace or skip. */
  const [taken, setTaken] = useState<{
    name: string;
    choose: (c: "keep-both" | "replace" | null) => void;
  } | null>(null);
  const ask = (name: string) =>
    new Promise<"keep-both" | "replace" | null>((resolve) =>
      setTaken({
        name,
        choose: (c) => {
          setTaken(null);
          resolve(c);
        },
      }),
    );
  /** Uploads one by one; a taken name asks before anything is overwritten. */
  const uploadInto = async (dir: string, files: File[]) => {
    for (const file of files) {
      const path = dir && dir !== "." ? `${dir}/${file.name}` : file.name;
      const data = await asBase64(file);
      try {
        await api.write(scope, path, data, "base64", { ifExists: "fail" });
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) {
          await attempt(() => Promise.reject(err));
          continue;
        }
        const choice = await ask(path);
        if (choice)
          await attempt(() => api.write(scope, path, data, "base64", { ifExists: choice }));
      }
    }
    reload();
  };
  const upload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => void uploadInto(base, Array.from(input.files ?? []));
    input.click();
  };
  return (
    <aside class="explorer" ref={panel}>
      <div class="explorer-head">
        <strong title={title}>{title}</strong>
        <button
          type="button"
          class="icon-button"
          title={t("newFile")}
          onClick={async () => {
            const n = await askText(t("newFile"), join(""), {
              yes: t("dlgMake"),
              label: t("dlgPath"),
            });
            if (n) act(() => api.write(scope, n, ""));
          }}
        >
          <IconFilePlus />
        </button>
        <button
          type="button"
          class="icon-button"
          title={t("newFolder")}
          onClick={async () => {
            const n = await askText(t("newFolder"), join(""), {
              yes: t("dlgMake"),
              label: t("dlgPath"),
            });
            if (n) act(() => api.fileOp({ op: "mkdir", scope, path: n }));
          }}
        >
          <IconFolderPlus />
        </button>
        <button type="button" class="icon-button" title={t("upload")} onClick={upload}>
          <IconUpload />
        </button>
        <button
          type="button"
          class={`icon-button ${hidden ? "on" : ""}`}
          title={hidden ? t("hideHidden") : t("showHidden")}
          aria-pressed={hidden}
          onClick={() => {
            localStorage.setItem(HIDDEN_KEY, hidden ? "0" : "1");
            setHidden(!hidden);
          }}
        >
          <IconEye />
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
      {taken && (
        <div class="taken">
          <div>{t("fileExists", { name: taken.name })}</div>
          <div class="row">
            <button type="button" class="primary" onClick={() => taken.choose("keep-both")}>
              {t("keepBoth")}
            </button>
            <button type="button" class="danger" onClick={() => taken.choose("replace")}>
              {t("replace")}
            </button>
            <button type="button" onClick={() => taken.choose(null)}>
              {t("cancel")}
            </button>
          </div>
        </div>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the upload button does the same by keyboard. */}
      <div
        class={`tree ${dragging ? "drop" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer?.files.length) void uploadInto(base, Array.from(e.dataTransfer.files));
        }}
      >
        {dragging && <div class="drop-hint">{t("dropHere")}</div>}
        <Folder
          scope={scope}
          path="."
          depth={0}
          version={version}
          selected={selected?.path ?? null}
          select={setSelected}
          act={act}
          hidden={hidden}
          dropInto={(dir, files) => void uploadInto(dir, Array.from(files))}
          reveal={focus}
        />
      </div>
    </aside>
  );
}

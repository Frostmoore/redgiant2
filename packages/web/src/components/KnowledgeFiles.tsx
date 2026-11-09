// Giving the knowledge its files without typing a path (3.5.3, collaudo della 3.5.1: «Aggiungi una
// fonte» had only a text field): a picker over RedGiant's own folders (each project, God's folder,
// the assistants' desk), an upload from the computer, and files dropped on the page. Uploaded files
// go to God's folder, `knowledge/<collection>/`, which becomes one source of the collection.
import type { KnowledgeCollection } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import type { FileEntry } from "../api.js";
import { t } from "../i18n.js";
import { IconBox, IconFile, IconFolder, IconUpload } from "../icons.js";
import { getApi, projects } from "../state.js";
import { Acts } from "./SettingsKit.js";
import { Modal } from "./ui.js";

/** A folder or a file of RedGiant's, as a source takes it. */
export interface Picked {
  scope: string;
  path: string;
  type: "dir" | "file";
}

/** The places the picker starts from: every project, God's folder, the assistants' desk. */
function places(): { scope: string; name: string }[] {
  return [
    ...projects.value.map((p) => ({ scope: `project:${p.id}`, name: p.name })),
    { scope: "platform", name: t("kbPlacePlatform") },
    { scope: "assistants", name: t("kbPlaceAssistants") },
  ];
}

/** What a picked place is called: the project's name, then the path inside it. */
export function pickedWords(p: Picked): string {
  const place = places().find((x) => x.scope === p.scope)?.name ?? p.scope;
  return p.path && p.path !== "." ? `${place} · ${p.path}` : place;
}

/** RedGiant's folders, one level at a time: a folder (or, for a file source, a file) is chosen. */
export function PlacePicker({
  want,
  onPick,
  onClose,
}: {
  want: "dir" | "file";
  onPick: (p: Picked) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<string>();
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!scope) return;
    setEntries(undefined);
    getApi()
      .list(scope, path)
      .then(
        (list) => {
          setEntries(
            [...list]
              .filter((e) => !e.name.startsWith("."))
              .sort((a, b) =>
                a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
              ),
          );
          setError(undefined);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
      );
  }, [scope, path]);
  const up = () => {
    if (path === "." || !path.includes("/")) {
      if (path === ".") setScope(undefined);
      setPath(".");
    } else setPath(path.slice(0, path.lastIndexOf("/")));
  };
  const name = places().find((p) => p.scope === scope)?.name ?? "";
  return (
    <Modal
      wide
      title={want === "dir" ? t("kbPickFolder") : t("kbPickFile")}
      sub={scope ? pickedWords({ scope, path, type: "dir" }) : t("kbPickWhere")}
      onClose={onClose}
      class="kb-picker"
    >
      {error && (
        <p class="kb-error" role="alert">
          {error}
        </p>
      )}
      {!scope ? (
        <ul class="kb-pick-list">
          {places().map((p) => (
            <li key={p.scope}>
              <button type="button" class="kb-pick-row" onClick={() => setScope(p.scope)}>
                {p.scope.startsWith("project:") ? <IconBox size={20} /> : <IconFolder size={20} />}
                <span>{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <button type="button" class="link kb-pick-up" onClick={up}>
            {path === "." ? t("kbPickPlaces") : t("kbPickUp")}
          </button>
          {!entries && !error && <p class="kb-dim">{t("kbLoading")}</p>}
          {entries?.length === 0 && <p class="kb-dim">{t("kbPickEmpty", { name })}</p>}
          <ul class="kb-pick-list">
            {entries?.map((e) =>
              e.type === "dir" ? (
                <li key={e.path}>
                  <button type="button" class="kb-pick-row" onClick={() => setPath(e.path)}>
                    <IconFolder size={20} />
                    <span>{e.name}</span>
                  </button>
                </li>
              ) : (
                <li key={e.path}>
                  <button
                    type="button"
                    class={`kb-pick-row${want === "file" ? "" : " off"}`}
                    disabled={want !== "file"}
                    onClick={() => onPick({ scope, path: e.path, type: "file" })}
                  >
                    <IconFile size={20} />
                    <span>{e.name}</span>
                  </button>
                </li>
              ),
            )}
          </ul>
        </>
      )}
      <Acts>
        <button type="button" class="wz-btn" onClick={onClose}>
          {t("cancel")}
        </button>
        {want === "dir" && scope && (
          <button
            type="button"
            class="wz-btn primary"
            onClick={() => onPick({ scope, path, type: "dir" })}
          >
            {t("kbPickThis")}
          </button>
        )}
      </Acts>
    </Modal>
  );
}

/** A file's content as base64 (FileReader: fast even for large files). */
const asBase64 = (file: File) =>
  new Promise<string>((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] ?? "");
    r.onerror = () => ko(r.error);
    r.readAsDataURL(file);
  });

/** Where a collection's uploads go: God's folder, one folder per collection. */
export const uploadFolder = (c: KnowledgeCollection) => `knowledge/${c.id}`;

/**
 * Files from the computer into a collection: written into its upload folder (a folder dropped or
 * chosen keeps its insides), then that folder is one of its sources (added once, read again after).
 */
export async function uploadToCollection(
  c: KnowledgeCollection,
  files: File[],
  progress?: (done: number, total: number) => void,
): Promise<number> {
  const api = getApi();
  const dir = uploadFolder(c);
  let done = 0;
  for (const f of files) {
    const inside = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const safe = inside
      .split(/[\\/]/)
      .filter((x) => x && x !== "." && x !== "..")
      .join("/");
    if (!safe) continue;
    await api.write("platform", `${dir}/${safe}`, await asBase64(f), "base64", {
      ifExists: "replace",
    });
    done++;
    progress?.(done, files.length);
  }
  const { sources } = await api.knowledgeSources(c.id);
  const kept = sources.find(
    (s) => s.spec.kind === "workspace" && s.spec.scope === "platform" && s.spec.path === dir,
  );
  if (kept) await api.rescanKnowledge(c.id, kept.id);
  else await api.addKnowledgeSource(c.id, { kind: "workspace", scope: "platform", path: dir });
  return done;
}

/** Opens the computer's own file chooser (files, or a whole folder). */
export function chooseFiles(folder: boolean, onFiles: (files: File[]) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  if (folder) input.setAttribute("webkitdirectory", "");
  input.onchange = () => onFiles(Array.from(input.files ?? []));
  input.click();
}

/** Files dropped on an element: its props, and whether something is being dragged over it now. */
export function useDropFiles(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  const has = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!has(e)) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (e.currentTarget === e.target) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        if (!has(e)) return;
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length) onFiles(files);
      },
    },
  };
}

/** The line shown over a place where files can be dropped. */
export const DropHint = ({ over }: { over: boolean }) =>
  over ? (
    <div class="kb-drop-hint" aria-hidden="true">
      <IconUpload size={28} />
      <span>{t("kbDropHere")}</span>
    </div>
  ) : null;

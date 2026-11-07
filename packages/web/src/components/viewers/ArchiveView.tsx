// Archives (G34.2): what a ZIP or a TAR holds, with sizes, a filter, and any file opened in its
// own viewer with a press (taken out in the page, never written anywhere).
import { useMemo, useState } from "preact/hooks";
import { t } from "../../i18n.js";
import { IconFile, IconFolder, IconSearch } from "../../icons.js";
import {
  type ArchiveEntry,
  gunzip,
  isTar,
  tarFile,
  tarList,
  zipFile,
  zipList,
} from "../../viewers/archive.js";
import { bytesText, download, useBytes, type ViewerProps } from "../../viewers/source.js";

/** Above this an archive is not read in the page: it is offered for download. */
const MAX_ARCHIVE = 300 * 1024 * 1024;

type Read =
  | { kind: "list"; entries: ArchiveEntry[]; take: (path: string) => Uint8Array | undefined }
  | { kind: "single"; name: string; bytes: Uint8Array }
  | { kind: "error"; message: string };

export function readArchive(name: string, format: string, bytes: Uint8Array): Read {
  try {
    if (format === "tar")
      return { kind: "list", entries: tarList(bytes), take: (p) => tarFile(bytes, p) };
    if (format === "tgz" || format === "gz") {
      const inner = gunzip(bytes);
      if (isTar(inner))
        return { kind: "list", entries: tarList(inner), take: (p) => tarFile(inner, p) };
      return { kind: "single", name: name.replace(/\.gz$/i, "") || "file", bytes: inner };
    }
    return { kind: "list", entries: zipList(bytes), take: (p) => zipFile(bytes, p) };
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }
}

function Listing({ src, open, bytes }: ViewerProps & { bytes: Uint8Array }) {
  const read = useMemo(() => readArchive(src.name, src.format, bytes), [bytes]);
  const [filter, setFilter] = useState("");
  if (read.kind === "error") return <div class="vw-empty">{t("vwArchiveNo")}</div>;
  if (read.kind === "single")
    return (
      <div class="vw-empty">
        <strong>{read.name}</strong>
        <span class="dim">{bytesText(read.bytes.length)}</span>
        <button type="button" class="vw-btn" onClick={() => open?.(read.name, read.bytes)}>
          {t("vwOpenInside")}
        </button>
      </div>
    );
  const files = read.entries.filter((e) => !e.folder);
  const total = files.reduce((n, e) => n + e.size, 0);
  const q = filter.trim().toLowerCase();
  const shown = read.entries
    .filter((e) => !q || e.path.toLowerCase().includes(q))
    .sort((a, b) => a.path.localeCompare(b.path));
  return (
    <div class="vw-archive">
      <div class="vw-bar">
        <label class="vw-search">
          <IconSearch size={14} />
          <input
            type="search"
            value={filter}
            placeholder={t("vwFilter")}
            aria-label={t("vwFilter")}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
        </label>
        <span class="dim">
          {t("vwArchiveCount", { n: files.length.toLocaleString(), size: bytesText(total) })}
        </span>
      </div>
      <ul class="vw-archive-list">
        {shown.slice(0, 5000).map((e) => {
          const parts = e.path.replace(/\/$/, "").split("/");
          const base = parts.pop() ?? e.path;
          const dir = parts.join("/");
          return (
            <li key={e.path}>
              {e.folder ? (
                <span class="vw-archive-row folder">
                  <IconFolder size={14} />
                  <span class="vw-archive-name">
                    {dir && <span class="dim">{dir}/</span>}
                    {base}/
                  </span>
                </span>
              ) : (
                <button
                  type="button"
                  class="vw-archive-row"
                  title={t("vwOpenInside")}
                  onClick={() => {
                    const b = read.take(e.path);
                    if (b) open?.(base, b);
                  }}
                >
                  <IconFile size={14} />
                  <span class="vw-archive-name">
                    {dir && <span class="dim">{dir}/</span>}
                    {base}
                  </span>
                  <span class="dim vw-archive-size">{bytesText(e.size)}</span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Load(props: ViewerProps) {
  const { value, error } = useBytes(props.src.url);
  if (error) return <div class="vw-empty">{error}</div>;
  if (!value) return <div class="vw-empty dim">{t("loading")}</div>;
  return <Listing {...props} bytes={value} />;
}

export function ArchiveView(props: ViewerProps) {
  const { src } = props;
  if (src.size !== undefined && src.size > MAX_ARCHIVE)
    return (
      <div class="vw-empty">
        <strong>{t("vwArchiveBig", { size: bytesText(src.size) })}</strong>
        <button type="button" class="vw-btn" onClick={() => download(src.url, src.name)}>
          {t("vwDownload")}
        </button>
      </div>
    );
  return <Load {...props} />;
}

// What every viewer of the canvas is given (G34.2): the file's name and a URL it reads from
// (a signed preview link, or a blob of a file taken out of an archive). Nothing leaves the
// computer: every viewer reads that URL and draws in the page.
import { useEffect, useState } from "preact/hooks";
import type { ViewerChoice } from "./kind.js";

export interface ViewerSource extends ViewerChoice {
  name: string;
  url: string;
  /** Bytes, when known (the server says it, or the archive). */
  size?: number;
}

export interface ViewerProps {
  src: ViewerSource;
  /** Opens another file in the same place (a file inside an archive). */
  open?: (name: string, bytes: Uint8Array) => void;
}

/** The first bytes of a URL and its size, read without downloading the rest. */
export async function peek(url: string, bytes = 512): Promise<{ head: Uint8Array; size?: number }> {
  const r = await fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`.trim());
  const range = r.headers.get("content-range")?.match(/\/(\d+)$/)?.[1];
  const length = r.headers.get("content-length");
  const size = range ? Number(range) : r.status === 200 && length ? Number(length) : undefined;
  const reader = r.body?.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  while (reader && got < bytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    parts.push(value);
    got += value.length;
  }
  void reader?.cancel().catch(() => {});
  const head = new Uint8Array(Math.min(got, bytes));
  let at = 0;
  for (const p of parts) {
    head.set(p.subarray(0, head.length - at), at);
    at += p.length;
    if (at >= head.length) break;
  }
  return { head, ...(size !== undefined && !Number.isNaN(size) && { size }) };
}

type Loaded<T> = { value?: T; error?: string };

/** Reads a URL once (bytes or text), with its error in words. */
function useFetched<T>(url: string, read: (r: Response) => Promise<T>): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({});
  useEffect(() => {
    let live = true;
    setState({});
    void fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`.trim());
        return read(r);
      })
      .then(
        (value) => live && setState({ value }),
        (err: unknown) => live && setState({ error: (err as Error).message }),
      );
    return () => {
      live = false;
    };
  }, [url]);
  return state;
}

export const useBytes = (url: string) =>
  useFetched(url, async (r) => new Uint8Array(await r.arrayBuffer()));
export const useText = (url: string) => useFetched(url, (r) => r.text());

/** A size people read: 312 KB, 4.2 MB. */
export function bytesText(n: number | undefined): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Saves a URL under a name (the browser's own download). */
export function download(url: string, name: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noreferrer";
  a.click();
}

/** The MIME type a blob of a file taken from an archive gets, so the browser shows it. */
export function blobType(format: string): string {
  const types: Record<string, string> = {
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
  };
  return types[format] ?? "application/octet-stream";
}

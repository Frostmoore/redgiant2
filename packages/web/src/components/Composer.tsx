import type { ImagePart } from "@redgiant/protocol";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { IconClose, IconFile, IconMic, IconPaperclip, IconSend, IconStop } from "../icons.js";

/**
 * What the composer holds: small text files go inside the message, photos go to the model as
 * images, anything else is saved in the workspace and the message names its path.
 */
export type Attachment =
  | { kind: "text"; name: string; content: string }
  | { kind: "image"; name: string; mediaType: ImagePart["mediaType"]; data: string; url: string }
  | { kind: "file"; name: string; file: File };

const MAX_TEXT = 200_000;
const MAX_FILES = 10;
const MAX_BYTES = 25 * 1024 * 1024;
const LONG_SIDE = 2000;
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh|toml))/;
const TEXT_NAMES =
  /\.(txt|md|csv|tsv|json|ya?ml|toml|ini|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|sql|log|env\.example)$/i;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

const toBase64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * A photo for the model: kept as it is when small enough, otherwise redrawn with its long side
 * at 2000 px as JPEG (what the providers accept and what is worth paying for).
 */
async function asImage(f: File): Promise<Attachment> {
  const bitmap = await createImageBitmap(f);
  const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
  const known = (IMAGE_TYPES as readonly string[]).includes(f.type);
  let blob: Blob = f;
  let mediaType = f.type as ImagePart["mediaType"];
  if (!known || scale < 1 || f.size > 1_500_000) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    blob = await new Promise<Blob>((ok, ko) =>
      canvas.toBlob((b) => (b ? ok(b) : ko(new Error("encode"))), "image/jpeg", 0.85),
    );
    mediaType = "image/jpeg";
  }
  bitmap.close();
  return {
    kind: "image",
    name: f.name || "image.jpg",
    mediaType,
    data: await toBase64(blob),
    url: URL.createObjectURL(blob),
  };
}

async function classify(f: File): Promise<Attachment> {
  if (f.type.startsWith("image/") && f.type !== "image/svg+xml") {
    try {
      return await asImage(f);
    } catch {
      // Not decodable here (HEIC on some browsers…): saved as a file instead.
    }
  }
  if ((TEXT_TYPES.test(f.type) || TEXT_NAMES.test(f.name)) && f.size <= MAX_TEXT)
    return { kind: "text", name: f.name, content: await f.text() };
  return { kind: "file", name: f.name, file: f };
}

/** A name that is safe as a file name inside the workspace. */
const safeName = (name: string) =>
  name.replace(/[^\p{L}\p{N}._\- ()]+/gu, "_").replace(/^\.+/, "") || "file";

/**
 * Turns the composer's content into a message: text files inline, images as parts, other
 * files written to `.attachments/YYYY-MM-DD/` in the scope's workspace (their path in the text).
 */
export async function packMessage(
  text: string,
  files: Attachment[],
  upload?: (path: string, base64: string) => Promise<unknown>,
): Promise<{ text: string; images: ImagePart[] }> {
  let out = text;
  const images: ImagePart[] = [];
  const day = new Date().toISOString().slice(0, 10);
  for (const f of files) {
    if (f.kind === "text") out += `\n\n<attachment name="${f.name}">\n${f.content}\n</attachment>`;
    else if (f.kind === "image")
      images.push({ type: "image", mediaType: f.mediaType, data: f.data, name: f.name });
    else if (upload) {
      const path = `.attachments/${day}/${Date.now().toString(36)}-${safeName(f.name)}`;
      await upload(path, await toBase64(f.file));
      out += `\n\n<attachment name="${f.name}" path="${path}" size="${f.file.size}" />`;
    } else
      out += `\n\n<attachment name="${f.name}" size="${f.file.size}">(${t("notSent")})</attachment>`;
  }
  return { text: out, images };
}

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: (e: {
    results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
  }) => void;
  onend: () => void;
  start(): void;
  stop(): void;
};

/** The browser's speech recognition, where there is one (Chrome, Edge, Safari). */
function speechRecognition(): (new () => Recognition) | undefined {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => Recognition) | undefined;
}

/**
 * The composer, as in Officina: everything in one box — attachments (picked or dropped),
 * the text with the microphone, then a bar with the chips (mode, model) and stop or send.
 */
export function Composer({
  placeholder,
  running,
  onSend,
  onStop,
  chips,
  lang,
}: {
  placeholder: string;
  running: boolean;
  onSend: (text: string, attachments: Attachment[]) => void | Promise<void>;
  onStop?: () => void;
  chips?: ComponentChildren;
  lang: string;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [drop, setDrop] = useState(false);
  const [recording, setRecording] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const recognition = useRef<Recognition | null>(null);

  // The box grows with the text, up to its maximum height.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const add = async (list: FileList | File[]) => {
    const all = [...list];
    const big = all.filter((f) => f.size > MAX_BYTES);
    setProblem(big.length ? t("tooBig", { names: big.map((f) => f.name).join(", ") }) : null);
    const picked = await Promise.all(all.filter((f) => f.size <= MAX_BYTES).map(classify));
    setFiles((now) => {
      const next = [...now, ...picked];
      if (next.length > MAX_FILES) setProblem(t("tooMany", { n: String(MAX_FILES) }));
      return next.slice(0, MAX_FILES);
    });
  };

  const send = async () => {
    if ((!text.trim() && files.length === 0) || running || busy) return;
    setBusy(true);
    try {
      await onSend(text.trim() ? text : t("seeAttachments"), files);
      for (const f of files) if (f.kind === "image") URL.revokeObjectURL(f.url);
      setText("");
      setFiles([]);
      setProblem(null);
    } catch (err) {
      setProblem(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const Speech = speechRecognition();
  const toggleMic = () => {
    if (recording) {
      recognition.current?.stop();
      return;
    }
    if (!Speech) return;
    const r = new Speech();
    r.lang = lang === "it" ? "it-IT" : "en-US";
    r.continuous = true;
    r.interimResults = false;
    const before = text;
    let heard = "";
    r.onresult = (e) => {
      heard = Array.from(e.results)
        .map((x) => x[0]?.transcript ?? "")
        .join(" ");
      setText(`${before}${before && !before.endsWith(" ") ? " " : ""}${heard}`);
    };
    r.onend = () => setRecording(false);
    recognition.current = r;
    r.start();
    setRecording(true);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for files; the paperclip does the same by keyboard.
    <div
      class={`composer ${drop ? "drop" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrop(true);
      }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrop(false);
        if (e.dataTransfer?.files.length) void add(e.dataTransfer.files);
      }}
    >
      <div class="box">
        {files.length > 0 && (
          <div class="attachments">
            {files.map((f) => (
              <span key={f.name} class={`attachment ${f.kind === "image" ? "image" : ""}`}>
                {f.kind === "image" ? <img src={f.url} alt="" /> : <IconFile size={13} />}
                <span>{f.name}</span>
                <button
                  type="button"
                  class="icon-button"
                  title={t("remove")}
                  onClick={() => setFiles(files.filter((x) => x !== f))}
                >
                  <IconClose size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        {problem && <div class="composer-problem">{problem}</div>}
        <div class="box-text">
          <textarea
            ref={area}
            rows={1}
            value={text}
            placeholder={placeholder}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            onPaste={(e) => {
              const pasted = e.clipboardData?.files;
              if (pasted?.length) {
                e.preventDefault();
                void add(pasted);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {Speech && (
            <button
              type="button"
              class={`icon-button ${recording ? "recording" : ""}`}
              title={recording ? t("stopDictation") : t("dictate")}
              onClick={toggleMic}
            >
              <IconMic />
            </button>
          )}
        </div>
        <div class="box-bar">
          <label class="icon-button" title={t("attach")}>
            <IconPaperclip />
            <input
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const input = e.target as HTMLInputElement;
                if (input.files) void add(input.files);
                input.value = "";
              }}
            />
          </label>
          {chips}
          <div class="spacer" />
          {running && onStop && (
            <button type="button" class="stop" title={t("interrupt")} onClick={onStop}>
              <IconStop />
            </button>
          )}
          <button
            type="button"
            class="send"
            title={t("send")}
            disabled={(!text.trim() && files.length === 0) || running || busy}
            onClick={() => void send()}
          >
            <IconSend size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

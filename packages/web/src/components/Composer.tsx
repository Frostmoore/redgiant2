import { findSecrets, hideSecrets, type ImagePart, type SecretSpan } from "@redgiant/protocol";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import {
  IconClose,
  IconFile,
  IconFileText,
  IconMic,
  IconMore,
  IconPaperclip,
  IconSend,
  IconSpinner,
  IconStop,
} from "../icons.js";
import { getApi, platformInfo } from "../state.js";
import { CredentialWindow } from "./Keychain.js";
import { Acts } from "./SettingsKit.js";
import { Modal } from "./ui.js";

/**
 * What the composer holds: small text files go inside the message, photos go to the model as
 * images, anything else is saved in the workspace and the message names its path.
 */
export type Attachment =
  | { kind: "text"; name: string; content: string }
  /** A long text pasted into the box (p3.3.1, as ChatGPT and Claude do): sent as a file. */
  | { kind: "pasted"; name: string; content: string }
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

/** A paste longer than this (characters or lines) becomes a file, not text in the box. */
export const PASTE_CHARS = 2000;
export const PASTE_LINES = 40;

/** The kind of text a paste is, for its file's extension: JSON, CSV, Markdown or plain text. */
export function pastedExt(text: string): "json" | "csv" | "md" | "txt" {
  const s = text.trim();
  if (/^[[{]/.test(s)) {
    try {
      JSON.parse(s);
      return "json";
    } catch {}
  }
  const lines = s
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 50);
  for (const sep of [",", ";", "\t"]) {
    const counts = lines.map((l) => l.split(sep).length - 1);
    if (lines.length >= 3 && (counts[0] ?? 0) >= 1 && counts.every((c) => c === counts[0]))
      return "csv";
  }
  const marks = lines.filter((l) => MARKDOWN_LINE.test(l)).length;
  if (marks >= 2) return "md";
  return "txt";
}
const MARKDOWN_LINE = /^(#{1,6} |```|[-*+] |\d+\. |> |\|.*\|)/;

/**
 * A pasted text as an attachment when it is long (over PASTE_CHARS characters or PASTE_LINES
 * lines), named after the moment: pasted-2026-11-07-183012.md. Undefined for a short paste.
 */
export function pastedAttachment(text: string, now = new Date()): Attachment | undefined {
  const lines = text.replace(/\n$/, "").split("\n").length;
  if (text.length <= PASTE_CHARS && lines <= PASTE_LINES) return undefined;
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return { kind: "pasted", name: `pasted-${stamp}.${pastedExt(text)}`, content: text };
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
    else if (f.kind === "pasted") {
      // Saved as a file the agent (and the canvas) can open; its text comes along too, unless
      // it is too long to carry inside the message.
      let where = "";
      if (upload) {
        const path = `.attachments/${day}/${Date.now().toString(36)}-${safeName(f.name)}`;
        const bytes = new TextEncoder().encode(f.content);
        await upload(path, await toBase64(new Blob([bytes])));
        where = ` path="${path}" size="${bytes.length}"`;
      }
      out +=
        f.content.length <= MAX_TEXT || !where
          ? `\n\n<attachment name="${f.name}"${where} pasted="true">\n${f.content.slice(0, MAX_TEXT)}\n</attachment>`
          : `\n\n<attachment name="${f.name}"${where} pasted="true" />`;
    } else if (f.kind === "image")
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
/** A recording as 16 kHz mono WAV, decoded by the browser itself (no Opus where it is read). */
async function toWav(blob: Blob): Promise<Blob> {
  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000;
    const off = new OfflineAudioContext(1, Math.ceil(audio.duration * rate), rate);
    const src = off.createBufferSource();
    src.buffer = audio;
    src.connect(off.destination);
    src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
    const text = (at: number, s: string) => {
      for (let i = 0; i < s.length; i++) out.setUint8(at + i, s.charCodeAt(i));
    };
    text(0, "RIFF");
    out.setUint32(4, 36 + pcm.length * 2, true);
    text(8, "WAVEfmt ");
    out.setUint32(16, 16, true);
    out.setUint16(20, 1, true);
    out.setUint16(22, 1, true);
    out.setUint32(24, rate, true);
    out.setUint32(28, rate * 2, true);
    out.setUint16(32, 2, true);
    out.setUint16(34, 16, true);
    text(36, "data");
    out.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++)
      out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i] ?? 0)) * 32767, true);
    return new Blob([out.buffer], { type: "audio/wav" });
  } finally {
    void ctx.close();
  }
}

export function Composer({
  placeholder,
  running,
  onSend,
  onStop,
  more,
  moreChanged,
  lang,
  mentions,
  queues,
  top,
  ready,
}: {
  /** Shown at the top of the box, above the attachments (the passages being answered, G36.22). */
  top?: ComponentChildren;
  /** Something else makes the message worth sending without text (quotes with their replies). */
  ready?: boolean;
  /** Messages written while it works wait in line and are read right after (G24.14f). */
  queues?: boolean;
  /** Names to suggest after "@" (group chats). */
  mentions?: string[];
  placeholder: string;
  running: boolean;
  onSend: (text: string, attachments: Attachment[]) => void | Promise<void>;
  onStop?: () => void;
  /**
   * The conversation's other commands (p3.5.4: mode, model, effort, Meanwhile, Summarise, Add an
   * agent), in the panel the «…» button next to Attach opens; `close` puts it away.
   */
  more?: (close: () => void) => ComponentChildren;
  /** Something in that panel is not as it starts (a mode other than Automatic…): a mark on «…». */
  moreChanged?: boolean;
  lang: string;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [viewing, setViewing] = useState<Extract<Attachment, { kind: "pasted" }> | null>(null);
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

  // A secret in the message (G33.4): held back before it leaves the page, with the way to the
  // keychain; the server blanks any that gets through (Telegram and the other chats).
  const [held, setHeld] = useState<SecretSpan[] | null>(null);
  const [vaulting, setVaulting] = useState(false);
  const send = async (clean?: string) => {
    if ((!text.trim() && files.length === 0 && !ready) || (running && !queues) || busy) return;
    if (clean === undefined) {
      const found = findSecrets(text);
      if (found.length > 0) {
        setHeld(found);
        return;
      }
    }
    setHeld(null);
    setBusy(true);
    try {
      const body = clean ?? text;
      await onSend(body.trim() || files.length === 0 ? body : t("seeAttachments"), files);
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
  const serverVoice = platformInfo.value?.voice === true && typeof MediaRecorder !== "undefined";
  const recorder = useRef<MediaRecorder | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const append = (heard: string) =>
    setText((now) => `${now}${now && !now.endsWith(" ") && heard ? " " : ""}${heard}`);

  // With a transcription service: record, then the server turns it into text in the box,
  // where it can be corrected before sending (as Officina does with its voice notes).
  const record = async () => {
    if (recorder.current) {
      recorder.current.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = async () => {
        for (const track of stream.getTracks()) track.stop();
        recorder.current = null;
        setRecording(false);
        const blob = new Blob(chunks, { type: (r.mimeType || "audio/webm").split(";")[0] });
        if (blob.size === 0) return;
        setTranscribing(true);
        try {
          // As WAV: every service reads it, whisper.cpp on this computer included (2026-11-05).
          append(await getApi().transcribe(await toWav(blob).catch(() => blob), lang));
          area.current?.focus();
        } catch (err) {
          setProblem(t("transcriptionFailed", { error: (err as Error).message }));
        } finally {
          setTranscribing(false);
        }
      };
      recorder.current = r;
      r.start();
      setRecording(true);
      setProblem(null);
    } catch (err) {
      setProblem(t("noMicrophone", { error: (err as Error).message }));
    }
  };

  const toggleMic = () => {
    if (serverVoice) {
      void record();
      return;
    }
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
        {top}
        {files.length > 0 && (
          <div class="attachments">
            {files.map((f) =>
              f.kind === "pasted" ? (
                <PastedCard
                  key={f.name}
                  file={f}
                  open={() => setViewing(f)}
                  asText={() => {
                    setFiles(files.filter((x) => x !== f));
                    setText((now) => `${now}${now && !now.endsWith("\n") ? "\n" : ""}${f.content}`);
                    area.current?.focus();
                  }}
                  remove={() => setFiles(files.filter((x) => x !== f))}
                />
              ) : (
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
              ),
            )}
          </div>
        )}
        {viewing && (
          <Modal title={viewing.name} onClose={() => setViewing(null)}>
            <pre class="pasted-full">{viewing.content}</pre>
            <Acts>
              <button type="button" class="wz-btn" onClick={() => setViewing(null)}>
                {t("close")}
              </button>
            </Acts>
          </Modal>
        )}
        {problem && <div class="composer-problem">{problem}</div>}
        {(() => {
          // "@" then the start of a name: the participants it may be.
          const partial = mentions && text.match(/(?:^|\s)@([^@\n]{0,30})$/)?.[1];
          if (partial === undefined || partial === null) return null;
          const options = (mentions ?? []).filter((n) =>
            n.toLowerCase().startsWith(partial.toLowerCase()),
          );
          if (options.length === 0) return null;
          return (
            <div class="mention-list" role="listbox">
              {options.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    setText(`${text.slice(0, text.length - partial.length)}${n} `);
                    area.current?.focus();
                  }}
                >
                  @{n}
                </button>
              ))}
            </div>
          );
        })()}
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
                return;
              }
              // A long text becomes a file beside the message (p3.3.1).
              const long = pastedAttachment(e.clipboardData?.getData("text/plain") ?? "");
              if (!long) return;
              e.preventDefault();
              if (files.length >= MAX_FILES) {
                setProblem(t("tooMany", { n: String(MAX_FILES) }));
                return;
              }
              setFiles((now) => [...now, long]);
            }}
            onKeyDown={(e) => {
              // On a phone Enter is a new line (as in Officina): the send button sends.
              const touch = matchMedia("(pointer: coarse)").matches;
              if (e.key === "Enter" && !e.shiftKey && !touch && !e.isComposing) {
                e.preventDefault();
                void send();
              }
              // Esc stops the agent, as in Claude Code and Zed (2026-11-05).
              if (e.key === "Escape" && running && onStop) {
                e.preventDefault();
                onStop();
              }
            }}
          />
          {(serverVoice || Speech) && (
            <button
              type="button"
              class={`icon-button ${recording ? "recording" : ""}`}
              title={
                transcribing ? t("transcribing") : recording ? t("stopDictation") : t("dictate")
              }
              disabled={transcribing}
              onClick={toggleMic}
            >
              {transcribing ? <IconSpinner /> : <IconMic />}
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
          {more && <MoreMenu changed={moreChanged}>{more}</MoreMenu>}
          <div class="spacer" />
          {running && onStop && (
            <button type="button" class="stop" title={t("interrupt")} onClick={onStop}>
              <IconStop />
            </button>
          )}
          <button
            type="button"
            class="send"
            title={running && queues ? t("sendQueued") : t("send")}
            disabled={
              (!text.trim() && files.length === 0 && !ready) || (running && !queues) || busy
            }
            onClick={() => void send()}
          >
            <IconSend size={16} />
          </button>
        </div>
      </div>
      {held && !vaulting && (
        <Modal title={t("chSecretTitle")} onClose={() => setHeld(null)}>
          <div class="wz-panel-in ch-secret">
            <p class="wz-lead2">{t("chSecretText")}</p>
            <p class="ch-secret-found">
              {t("chSecretFound", {
                list: [...new Set(held.map((h) => t(`chSecretKind_${h.kind}`)))].join(", "),
              })}
            </p>
          </div>
          <Acts>
            <button type="button" class="wz-btn quiet" onClick={() => setHeld(null)}>
              {t("chSecretBack")}
            </button>
            <button
              type="button"
              class="wz-btn"
              onClick={() => void send(hideSecrets(text, "[secret removed]").text)}
            >
              {t("chSecretSend")}
            </button>
            <button type="button" class="wz-btn primary" onClick={() => setVaulting(true)}>
              {t("chSecretVault")}
            </button>
          </Acts>
        </Modal>
      )}
      {held && vaulting && (
        <CredentialWindow
          draft={{ value: held[0]?.value ?? "" }}
          onClose={(saved) => {
            setVaulting(false);
            if (saved) void send(hideSecrets(text, "[secret removed: now in the keychain]").text);
          }}
        />
      )}
    </div>
  );
}

/** What the arrows move between in the «…» panel. */
const MENU_ITEMS = "button:not([disabled]), select:not([disabled])";

/**
 * The «…» next to Attach (p3.5.4, the person: «metti tutto in un tasto vicino all'allega»): a
 * panel above it with the conversation's commands, each with its state. Esc closes it and gives
 * the focus back to «…»; the arrows go from one command to the next (a menu keeps its own
 * arrows); a click elsewhere closes it.
 */
export function MoreMenu({
  changed,
  children,
}: {
  changed?: boolean;
  children: (close: () => void) => ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const items = () => [...(panel.current?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? [])];
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const away = (e: PointerEvent) => {
      const at = e.target as Node;
      if (!panel.current?.contains(at) && !button.current?.contains(at)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.target instanceof HTMLSelectElement) return;
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const to =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? (at + 1) % all.length
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? (at - 1 + all.length) % all.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? all.length - 1
              : -1;
    if (to < 0 || all.length === 0) return;
    e.preventDefault();
    all[to]?.focus();
  };
  return (
    <span class="more-wrap">
      <button
        ref={button}
        type="button"
        class={`icon-button more-button${open ? " on" : ""}`}
        title={changed ? t("moreChanged") : t("more")}
        aria-label={changed ? t("moreChanged") : t("more")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <IconMore />
        {changed && <span class="more-mark" />}
      </button>
      {open && (
        // biome-ignore lint/a11y/noStaticElementInteractions: the keys move between its commands.
        <div ref={panel} class="more-panel" role="dialog" aria-label={t("more")} onKeyDown={onKey}>
          {children(close)}
        </div>
      )}
    </span>
  );
}

/** A pasted text waiting to be sent: its name, size, first lines, and what can be done with it. */
function PastedCard({
  file,
  open,
  asText,
  remove,
}: {
  file: Extract<Attachment, { kind: "pasted" }>;
  open: () => void;
  asText: () => void;
  remove: () => void;
}) {
  const lines = file.content.split("\n");
  return (
    <div class="attachment pasted" data-testid="pasted">
      <button type="button" class="pasted-open" title={t("pastedOpen")} onClick={open}>
        <span class="pasted-head">
          <IconFileText size={13} />
          <span class="pasted-name">{file.name}</span>
        </span>
        <span class="pasted-size dim">
          {t("pastedSize", {
            lines: String(lines.length),
            chars: file.content.length.toLocaleString(),
          })}
        </span>
        <span class="pasted-preview">{lines.slice(0, 3).join("\n").slice(0, 240)}</span>
      </button>
      <div class="pasted-acts">
        <button type="button" class="link" onClick={asText}>
          {t("pastedAsText")}
        </button>
        <button type="button" class="icon-button" title={t("remove")} onClick={remove}>
          <IconClose size={12} />
        </button>
      </div>
    </div>
  );
}

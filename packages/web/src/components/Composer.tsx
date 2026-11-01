import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { IconClose, IconFile, IconMic, IconPaperclip, IconSend, IconStop } from "../icons.js";

export interface Attachment {
  name: string;
  content: string;
}

const MAX_FILE = 200_000;

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
  onSend: (text: string, attachments: Attachment[]) => void;
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

  const add = async (list: FileList | File[]) => {
    const picked = await Promise.all(
      [...list].map(async (f) => ({ name: f.name, content: (await f.text()).slice(0, MAX_FILE) })),
    );
    setFiles((now) => [...now, ...picked].slice(0, 10));
  };

  const send = () => {
    if (!text.trim() || running) return;
    onSend(text, files);
    setText("");
    setFiles([]);
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
              <span key={f.name} class="attachment">
                <IconFile size={13} />
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
        <div class="box-text">
          <textarea
            ref={area}
            rows={1}
            value={text}
            placeholder={placeholder}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                send();
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
            disabled={!text.trim() || running}
            onClick={send}
          >
            <IconSend size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Attachments travel inside the message, marked so the model knows what they are. */
export const withAttachments = (text: string, files: Attachment[]) =>
  text +
  files.map((f) => `\n\n<attachment name="${f.name}">\n${f.content}\n</attachment>`).join("");

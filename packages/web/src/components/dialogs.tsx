// Our own questions in place of the browser's (decision of 2026-11-09 «Mai finestre native del
// browser»): `askConfirm` and `askText` open a Modal of ours and answer with a promise, as confirm()
// and prompt() did, so a call site only adds `await`. One host (`<Dialogs />`) in the page shows
// them one at a time; Escape, the X or a click outside is a no (or no text).
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { Acts } from "./SettingsKit.js";
import { Field, Modal } from "./ui.js";

type Ask = { id: number } & (
  | {
      kind: "confirm";
      title: string;
      text?: string | undefined;
      yes: string;
      danger: boolean;
      done: (yes: boolean) => void;
    }
  | {
      kind: "text";
      title: string;
      label: string;
      value: string;
      yes: string;
      done: (text: string | null) => void;
    }
);

let seq = 0;

/** The questions waiting, the first one shown. */
export const asking = signal<Ask[]>([]);

const finish = (a: Ask) => {
  asking.value = asking.value.filter((x) => x !== a);
};

/**
 * A yes or no in our window. `title` is the question; `text` a line under it; `yes` the button's
 * word (default «OK»); `danger` paints it as a deletion.
 */
export function askConfirm(
  title: string,
  o: { text?: string; yes?: string; danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((done) => {
    asking.value = [
      ...asking.value,
      {
        id: ++seq,
        kind: "confirm",
        title,
        text: o.text,
        yes: o.yes ?? t("dlgOk"),
        danger: o.danger === true,
        done,
      },
    ];
  });
}

/** A line of text in our window: what was written, or null when the person gave up. */
export function askText(
  title: string,
  value = "",
  o: { label?: string; yes?: string } = {},
): Promise<string | null> {
  return new Promise((done) => {
    asking.value = [
      ...asking.value,
      {
        id: ++seq,
        kind: "text",
        title,
        label: o.label ?? title,
        value,
        yes: o.yes ?? t("dlgOk"),
        done,
      },
    ];
  });
}

function TextAsk({ a }: { a: Extract<Ask, { kind: "text" }> }) {
  const [value, setValue] = useState(a.value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    // The name selected without its extension, as a file manager does.
    const dot = a.value.lastIndexOf(".");
    const slash = a.value.lastIndexOf("/");
    el.setSelectionRange(slash + 1, dot > slash + 1 ? dot : a.value.length);
  }, []);
  const close = (v: string | null) => {
    finish(a);
    a.done(v);
  };
  return (
    <Modal title={a.title} onClose={() => close(null)} class="dlg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          close(value);
        }}
      >
        <Field label={a.label}>
          <input
            ref={input}
            class="wz-field"
            value={value}
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Acts>
          <button type="button" class="wz-btn" onClick={() => close(null)}>
            {t("cancel")}
          </button>
          <button type="submit" class="wz-btn primary">
            {a.yes}
          </button>
        </Acts>
      </form>
    </Modal>
  );
}

function ConfirmAsk({ a }: { a: Extract<Ask, { kind: "confirm" }> }) {
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => yes.current?.focus(), []);
  const close = (v: boolean) => {
    finish(a);
    a.done(v);
  };
  return (
    <Modal title={a.title} onClose={() => close(false)} class="dlg">
      {a.text && <p class="dlg-text">{a.text}</p>}
      <Acts>
        <button type="button" class="wz-btn" onClick={() => close(false)}>
          {t("cancel")}
        </button>
        <button
          ref={yes}
          type="button"
          class={`wz-btn primary${a.danger ? " danger" : ""}`}
          onClick={() => close(true)}
        >
          {a.yes}
        </button>
      </Acts>
    </Modal>
  );
}

/** The one place the questions show, mounted once in the page. */
export function Dialogs() {
  const a = asking.value[0];
  if (!a) return null;
  return (
    <div class="wz-look dlg-host">
      {a.kind === "text" ? <TextAsk key={a.id} a={a} /> : <ConfirmAsk key={a.id} a={a} />}
    </div>
  );
}

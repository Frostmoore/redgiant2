// Pieces for the Settings pages drawn as the wizard (2026-11-06): chats on other apps, budgets,
// backup and the platform's history. The page's frame, a card with its question, a row of choices
// and a box that opens a window. Others could use them too: to be merged with the other kits.
import type { ComponentChildren, JSX } from "preact";

/** A Settings page in the wizard's look: big centred heading, a lot of room. */
export function WzPage({ class: cls, children }: { class?: string; children: ComponentChildren }) {
  return (
    <div class={`settings-section wz-look sb-page${cls ? ` ${cls}` : ""}`}>
      <section class="wz-inner">{children}</section>
    </div>
  );
}

/** A card with its icon, title and question, as in the wizard's «Safety» step. */
export function SCard({
  icon,
  title,
  q,
  children,
  class: cls,
}: {
  icon: JSX.Element;
  title: string;
  q?: string | undefined;
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <div class={`wz-scard${cls ? ` ${cls}` : ""}`}>
      <div class="wz-scard-hd">
        <span class="wz-scard-av">{icon}</span>
        <div>
          <h3>{title}</h3>
          {q && <div class="wz-scard-q">{q}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

/** A row of choices, one lit (the wizard's segmented choice). */
export function Seg<T extends string>({
  options,
  value,
  onChange,
  vertical,
}: {
  options: [T, string][];
  value: T | null | undefined;
  onChange: (v: T) => void;
  vertical?: boolean;
}) {
  return (
    <div class={`wz-seg${vertical ? " v" : ""}`}>
      {options.map(([v, text]) => (
        <button
          type="button"
          key={v}
          class={value === v ? "on" : ""}
          aria-pressed={value === v}
          onClick={() => onChange(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/**
 * A big box that opens a window: a title with a pill on its right, lines under it and whatever
 * else (a bar…). Lit by border and background when `on`, red-edged when `warn`; never a check mark.
 */
export function BoxButton({
  on,
  warn,
  title,
  pill,
  children,
  onClick,
  label,
}: {
  on?: boolean;
  warn?: boolean;
  title: string;
  pill?: string | undefined;
  children?: ComponentChildren;
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      class={`sb-box${on ? " on" : ""}${warn ? " warn" : ""}`}
      aria-label={label}
      onClick={onClick}
    >
      <span class="sb-box-hd">
        <span class="sb-box-title">{title}</span>
        {pill && <span class="sb-pill">{pill}</span>}
      </span>
      {children}
    </button>
  );
}

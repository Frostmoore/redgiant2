// The pieces of the wizard's look (2026-11-06, the person: «tutte le pagine delle impostazioni con
// lo stesso stile del wizard»), one per idea, for the wizard's steps and every Settings page: the
// page's frame and heading, a part's heading, the big squares to pick, a framed box with rows, a
// card with its question, a switch, a choice in segments, chips, a small fact list, a big box that
// opens a window and the windows' buttons. What is chosen is lit by border and background, never
// by a check mark. The wizard's context (`useWz`, `PHONE`) stays in SetupKit.
import type { ComponentChildren, JSX } from "preact";
import { useId } from "preact/hooks";
import { t } from "../i18n.js";

/** A Settings page in the wizard's look: its content centred, its windows after it. */
export function WzPage({
  class: cls,
  children,
  after,
}: {
  class?: string;
  children: ComponentChildren;
  /** The page's windows, outside the centred column. */
  after?: ComponentChildren;
}) {
  return (
    <div class={`settings-section wz-look st-page${cls ? ` ${cls}` : ""}`}>
      <section class="wz-inner">{children}</section>
      {after}
    </div>
  );
}

/** A page's or a step's heading: an optional small line, the question, the line under it. */
export function Head({
  eyebrow,
  q,
  lead,
}: {
  eyebrow?: string | undefined;
  q: string;
  lead?: ComponentChildren;
}) {
  return (
    <>
      {eyebrow && <p class="wz-eyebrow">{eyebrow}</p>}
      <h1 class="wz-q">{q}</h1>
      {lead && <p class="wz-lead">{lead}</p>}
    </>
  );
}

/** A part of the page: its heading and the line under it. */
export function Sub({ title, lead }: { title: string; lead?: ComponentChildren }) {
  return (
    <>
      <h2 class="wz-sub">{title}</h2>
      {lead && <p class="wz-subl">{lead}</p>}
    </>
  );
}

/** A big square to pick: lit (border and background) when on, never a check mark. */
export function Tile({
  on,
  icon,
  title,
  badge,
  text,
  state,
  onClick,
  wide,
}: {
  on: boolean;
  icon: JSX.Element;
  title: string;
  badge?: string | undefined;
  text: string;
  state?: string | undefined;
  onClick: () => void;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      class={`wz-tile${on ? " on" : ""}${wide ? " wz-tile-v" : ""}`}
      aria-pressed={on}
      onClick={onClick}
    >
      <span class="wz-ico">{icon}</span>
      <span class="wz-tile-text">
        <span class="wz-tile-title">
          {title}
          {badge && <span class="wz-badge">{badge}</span>}
        </span>
        <span class="wz-tile-p">{text}</span>
        {state && <span class="wz-state">{state}</span>}
      </span>
    </button>
  );
}

/** Squares in a row that wraps, centred. */
export const Tiles = ({ children, class: c }: { children: ComponentChildren; class?: string }) => (
  <div class={`wz-brain st-tiles${c ? ` ${c}` : ""}`}>{children}</div>
);

/** A big framed box with rows or a panel inside, left-aligned. */
export const Box = ({ children, class: c }: { children: ComponentChildren; class?: string }) => (
  <div class={`wz-card wz-left st-box${c ? ` ${c}` : ""}`}>{children}</div>
);

/** A setting on one row: its name and a line of help, then its control (under it on a phone). */
export function Row({
  title,
  help,
  children,
}: {
  title: ComponentChildren;
  help?: ComponentChildren;
  children?: ComponentChildren;
}) {
  return (
    <div class="st-row">
      <div class="st-row-text">
        <b>{title}</b>
        {help && <small>{help}</small>}
      </div>
      {children !== undefined && <div class="st-row-ctl">{children}</div>}
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

/** The wizard's on/off switch; its name is read aloud, not shown. */
export function Switch({
  on,
  onChange,
  label,
  disabled = false,
  small = false,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean | undefined;
  small?: boolean | undefined;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      class={`wz-switch${small ? " small" : ""}${on ? " on" : ""}`}
      disabled={disabled}
      onClick={() => !disabled && onChange(!on)}
    />
  );
}

/** A big row: what it is, a line under it, and its switch on the right; lit when on. */
export function SwitchRow({
  title,
  help,
  on,
  onChange,
  disabled,
}: {
  title: string;
  help?: string | undefined;
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div class={`st-switch-row${on ? " on" : ""}`}>
      <div>
        <b>{title}</b>
        {help && <span>{help}</span>}
      </div>
      <Switch on={on} label={title} onChange={onChange} disabled={disabled} />
    </div>
  );
}

/** One choice among a few, in segments: the chosen one lit; `vertical` stacks them on a phone. */
export function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
  vertical,
}: {
  value: T | null | undefined;
  options: readonly (readonly [T, ComponentChildren])[];
  onChange: (v: T) => void;
  label?: string | undefined;
  vertical?: boolean | undefined;
}) {
  return (
    <fieldset class={`wz-seg${vertical ? " v" : ""}`} aria-label={label}>
      {options.map(([id, body]) => (
        <button
          type="button"
          key={id}
          class={value === id ? "on" : ""}
          aria-pressed={value === id}
          onClick={() => onChange(id)}
        >
          {body}
        </button>
      ))}
    </fieldset>
  );
}

/** Chips to pick one (or several, with `multiple`), left-aligned: lit by border and background. */
export function Chips<T extends string | number>({
  options,
  value,
  onChange,
  multiple,
}: {
  options: { id: T; label: string }[];
  value: T[];
  onChange: (value: T[]) => void;
  multiple?: boolean;
}) {
  return (
    <div class="wz-chips st-chips">
      {options.map((o) => {
        const on = value.includes(o.id);
        return (
          <button
            key={String(o.id)}
            type="button"
            class={`wz-chip${on ? " on" : ""}`}
            aria-pressed={on}
            onClick={() =>
              onChange(
                multiple ? (on ? value.filter((v) => v !== o.id) : [...value, o.id]) : [o.id],
              )
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A few facts as label and value, one per line (wraps on narrow windows). */
export function Facts({ rows }: { rows: [string, ComponentChildren][] }) {
  return (
    <dl class="st-facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
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

/** The window's buttons, at the bottom right (on a phone, stuck to the sheet's foot). */
export const Acts = ({ children }: { children: ComponentChildren }) => (
  <div class="wz-acts">{children}</div>
);

/** The window's Done button, bottom right (on a phone stuck to the sheet's foot). */
export const Done = ({ onClick }: { onClick: () => void }) => (
  <Acts>
    <button type="button" class="wz-btn primary" onClick={onClick}>
      {t("wzDoneBtn")}
    </button>
  </Acts>
);

/**
 * A slider that moves in steps (2026-11-07, the person: «un bel punto rosso che puoi effettivamente
 * trascinare, a step»): a big red dot on a track filled up to it, a notch for every step, the value
 * written beside the name. A native range underneath, so arrows, Home/End and the finger all work.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format = String,
  help,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  /** The value in words ("80%", "at 80%"), beside the name and under the notches' ends. */
  format?: (v: number) => string;
  help?: ComponentChildren;
}) {
  const id = useId();
  const count = Math.round((max - min) / step);
  const frac = (v: number) => (max === min ? 0 : (v - min) / (max - min));
  const notches = Array.from({ length: count + 1 }, (_, i) => min + i * step);
  return (
    <div class="kit-slider">
      <div class="kit-slider-hd">
        <label for={id}>{label}</label>
        <output for={id} class="kit-slider-val">
          {format(value)}
        </output>
      </div>
      <div class="kit-slider-track" style={{ "--pct": String(frac(value)) }}>
        <span class="kit-slider-rail" aria-hidden="true">
          {notches.map((n) => (
            <span
              key={n}
              class={`kit-slider-notch${n <= value ? " on" : ""}`}
              style={{ "--at": String(frac(n)) }}
            />
          ))}
        </span>
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-valuetext={format(value)}
          onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))}
        />
      </div>
      <div class="kit-slider-ends" aria-hidden="true">
        <span>{format(min)}</span>
        <span>{format(max)}</span>
      </div>
      {help && <p class="kit-slider-help">{help}</p>}
    </div>
  );
}

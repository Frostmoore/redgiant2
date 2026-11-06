// Pieces for the Settings pages drawn as the wizard (2026-11-06, the person: «tutte le pagine
// delle impostazioni con lo stesso stile del wizard»): a switch, a choice in segments, a row with
// its words on the left and its control on the right, a sub heading, the window's Done button.
// The big squares, the heading and the windows' buttons come from SetupKit.
import type { ComponentChildren } from "preact";
import { t } from "../i18n.js";
import { Acts } from "./SetupKit.js";

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

/** One choice among a few, in segments: the chosen one lit. */
export function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly (readonly [T, ComponentChildren])[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <fieldset class="wz-seg st-seg" aria-label={label}>
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

/** A part of the page: its heading and the line under it, centred as in the wizard. */
export function Sub({ title, lead }: { title: string; lead?: ComponentChildren }) {
  return (
    <>
      <h2 class="wz-sub">{title}</h2>
      {lead && <p class="wz-subl">{lead}</p>}
    </>
  );
}

/** A big framed box with rows or a panel inside, left-aligned. */
export const Box = ({ children, class: c }: { children: ComponentChildren; class?: string }) => (
  <div class={`wz-card wz-left st-box${c ? ` ${c}` : ""}`}>{children}</div>
);

/** The window's Done button, bottom right (on a phone stuck to the sheet's foot). */
export const Done = ({ onClick }: { onClick: () => void }) => (
  <Acts>
    <button type="button" class="wz-btn primary" onClick={onClick}>
      {t("wzDoneBtn")}
    </button>
  </Acts>
);

/** Squares in a row that wraps, centred. */
export const Tiles = ({ children, class: c }: { children: ComponentChildren; class?: string }) => (
  <div class={`wz-brain st-tiles${c ? ` ${c}` : ""}`}>{children}</div>
);

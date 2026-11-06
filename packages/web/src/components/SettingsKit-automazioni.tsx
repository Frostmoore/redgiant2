// Pieces for the settings pages drawn as the wizard (2026-11-06), made for Automations and
// Extensions and meant for any page under `.wz-look`: a section's heading, the wizard's switch
// with its words, chips to pick one or several (lit by border and background, never a check
// mark) and a small fact list.
import type { ComponentChildren } from "preact";

/** A section's heading inside a page drawn as the wizard: the title and the line under it. */
export function Sub({ title, lead }: { title: string; lead?: ComponentChildren }) {
  return (
    <>
      <h2 class="wz-sub">{title}</h2>
      {lead && <p class="wz-subl">{lead}</p>}
    </>
  );
}

/** The wizard's on/off switch. */
export function Switch({
  on,
  label,
  onChange,
  disabled = false,
}: {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      class={`wz-switch${on ? " on" : ""}`}
      disabled={disabled}
      onClick={() => !disabled && onChange(!on)}
    />
  );
}

/** A big row: what it is, a line under it, and its switch on the right. */
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
    <div class={`ska-switch-row${on ? " on" : ""}`}>
      <div>
        <b>{title}</b>
        {help && <span>{help}</span>}
      </div>
      <Switch on={on} label={title} onChange={onChange} disabled={disabled ?? false} />
    </div>
  );
}

/** Chips to pick one (or several, with `multiple`): lit by border and background. */
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
    <div class="ska-chips">
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
    <dl class="ska-facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// The open copy's bar (p3.5.3), the same for sheets, documents and drawings: which closed file
// it is a copy of, the switch that writes the original again at every save (its explanation as
// help), and what stays in the file without being editable here, folded away. Never a native
// checkbox (the person's decision of 2026-11-09): our switch.
import type { ComponentChildren } from "preact";
import { t } from "../../i18n.js";
import { IconCopy, IconInfo } from "../../icons.js";
import { SmallSwitch } from "../ui.js";

export interface CopyRewrite {
  on: boolean;
  onChange: (on: boolean) => void;
  /** What it does, with its costs: the tooltip. */
  help: string;
}

export function CopyBar({
  original,
  rewrite,
  children,
}: {
  /** The closed original's name ("vendite.xlsx"). */
  original: string;
  rewrite?: CopyRewrite | undefined;
  /** More, under the bar (what stays in the file). */
  children?: ComponentChildren;
}) {
  const name = original.split(/[\\/]/).pop() ?? original;
  return (
    <div class="copy-bar">
      <div class="copy-bar-row">
        <span class="copy-bar-what" title={original}>
          <IconCopy size={14} />
          <strong>{t("copyBarOf", { name })}</strong>
          <span class="copy-bar-safe">{t("copyBarSafe")}</span>
        </span>
        {rewrite && (
          <span class="copy-bar-rewrite">
            <SmallSwitch
              label={t("copyBarRewrite")}
              help={rewrite.help}
              on={rewrite.on}
              onChange={rewrite.onChange}
            />
            <span class="copy-bar-help" title={rewrite.help} aria-label={rewrite.help} role="img">
              <IconInfo size={13} />
            </span>
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * What stays in the file and is not edited here (charts, pivot tables, pictures… and the formats
 * kept as they are): one quiet line that opens to the list.
 */
export function KeptInFile({ items, how }: { items: string[]; how?: string | undefined }) {
  if (items.length === 0) return null;
  return (
    <details class="copy-bar-kept">
      <summary>{t("copyBarKept", { n: String(items.length) })}</summary>
      {how && <p class="copy-bar-how">{how}</p>}
      <ul>
        {items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </details>
  );
}

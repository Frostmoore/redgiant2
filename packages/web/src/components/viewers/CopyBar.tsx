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

/**
 * In plain words whether an edit reaches the original, and when (p3.5.7, the person's test of
 * 3.5.6: a slide added to the ODP copy, the PPTX still had three and nothing said why).
 */
export function copyPlainText(
  name: string,
  copy: string | undefined,
  rewrite: boolean | undefined,
) {
  const ext = copy?.match(/\.([a-z0-9]+)$/i)?.[1];
  const kind = ext ? ext.toUpperCase() : t("copyBarKindOpen");
  if (rewrite === true) return t("copyBarPlainOn", { kind, name });
  if (rewrite === false) return t("copyBarPlainOff", { kind, name });
  return t("copyBarPlainNone", { kind, name });
}

export function CopyBar({
  original,
  copy,
  rewrite,
  children,
}: {
  /** The closed original's name ("vendite.xlsx"). */
  original: string;
  /** The copy's path ("vendite.xlsx.open/vendite.ods"): its kind is named. */
  copy?: string | undefined;
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
      <p class="copy-bar-plain" role="note">
        {copyPlainText(name, copy, rewrite?.on)}
      </p>
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

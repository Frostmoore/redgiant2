// An artifact asks for a capability the first time it uses it (3.6, G38.7): said in words, with
// the place and the file; for `ask`, the spending cap the person chooses, then yes or no. Only the
// person's yes grants; it stays until they take it back in Settings › Artifacts.
import {
  ARTIFACT_ASK_CAP_DEFAULT,
  ARTIFACT_ASK_CAPS,
  type PermissionRequestInfo,
  requestSentence,
} from "@redgiant/protocol";
import { useState } from "preact/hooks";
import { lang, t } from "../i18n.js";
import { IconCanvas } from "../icons.js";
import { getLive } from "../state.js";
import { noEnter, useArmed } from "./armed.js";
import { Chips } from "./SettingsKit.js";

/** A cap in dollars, as the page writes money. */
export const usd = (n: number) => `${n < 1 ? n.toFixed(2) : String(n)} $`;

export function ArtifactGrantCard({ r }: { r: PermissionRequestInfo }) {
  const input = (r.input ?? {}) as { path?: string; capability?: string };
  const isAsk = input.capability === "ask";
  const [cap, setCap] = useState<number>(ARTIFACT_ASK_CAP_DEFAULT);
  // Off for a moment once in view (3.5.6), like every request's buttons.
  const { ref, armed } = useArmed<HTMLDivElement>(r.requestId);
  const resolve = (decision: "allow" | "deny") =>
    armed &&
    getLive().send({
      type: "permission.resolve",
      requestId: r.requestId,
      decision,
      remember: false,
      ...(decision === "allow" && isAsk && { capUsd: cap }),
    });
  return (
    <div class="permission artifact-grant">
      <div class="row permission-who">
        <IconCanvas />
        <strong>{t("agTitle")}</strong>
      </div>
      <p class="permission-what">{requestSentence(lang.value, r.tool, r.input)}</p>
      {input.path && (
        <p class="dim artifact-grant-where">
          <code>{input.path}</code>
        </p>
      )}
      {isAsk && (
        <div class="artifact-grant-cap">
          <span>{t("agCap")}</span>
          <Chips
            options={ARTIFACT_ASK_CAPS.map((c): { id: number; label: string } => ({
              id: c,
              label: usd(c),
            }))}
            value={[cap]}
            onChange={(v) => v[0] !== undefined && setCap(v[0])}
          />
          <span class="dim">{t("agCapHint")}</span>
        </div>
      )}
      <p class="dim">{t("agHint")}</p>
      <div ref={ref} class={armed ? "permission-actions" : "permission-actions arming"}>
        <button
          type="button"
          class="yes"
          disabled={!armed}
          onKeyDown={noEnter}
          onClick={() => resolve("allow")}
        >
          {isAsk ? t("agAllowCap", { cap: usd(cap) }) : t("agAllow")}
        </button>
        <button type="button" class="no" disabled={!armed} onClick={() => resolve("deny")}>
          {t("agDeny")}
        </button>
      </div>
    </div>
  );
}

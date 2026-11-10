// An agent asks for a switched-off tool (G36.15): said in words, with the two ways to say yes
// (this conversation, or always for this agent) and no. Without a yes the tool stays off.
import type { PermissionRequestInfo } from "@redgiant/protocol";
import { t } from "../i18n.js";
import { IconTool } from "../icons.js";
import { getLive } from "../state.js";
import { noEnter, useArmed } from "./armed.js";
import { toolName } from "./ToolsPage.js";

export function ToolRequestCard({ r }: { r: PermissionRequestInfo }) {
  const input = (r.input ?? {}) as { tool?: string; why?: string };
  const tool = input.tool ?? "";
  // Off for a moment once in view (3.5.6), like every request's buttons.
  const { ref, armed } = useArmed<HTMLDivElement>(r.requestId);
  const resolve = (decision: "allow" | "deny", scope: "session" | "always" = "session") =>
    armed &&
    getLive().send({
      type: "permission.resolve",
      requestId: r.requestId,
      decision,
      remember: false,
      scope,
    });
  return (
    <div class="permission tool-req">
      <div class="row">
        <IconTool />
        <strong>{t("toolReqTitle", { name: r.agentName, tool: toolName(tool) })}</strong>
      </div>
      {input.why && <p>{t("toolReqWhy", { why: input.why })}</p>}
      <p class="dim">{t("toolReqHint", { name: r.agentName })}</p>
      <div ref={ref} class={armed ? "permission-actions" : "permission-actions arming"}>
        <button
          type="button"
          class="yes"
          disabled={!armed}
          onKeyDown={noEnter}
          onClick={() => resolve("allow", "session")}
        >
          {t("toolReqSession")}
        </button>
        <button
          type="button"
          class="always"
          disabled={!armed}
          onKeyDown={noEnter}
          onClick={() => resolve("allow", "always")}
        >
          {t("toolReqAlways", { name: r.agentName })}
        </button>
        <button type="button" class="no" disabled={!armed} onClick={() => resolve("deny")}>
          {t("toolReqNo")}
        </button>
      </div>
    </div>
  );
}

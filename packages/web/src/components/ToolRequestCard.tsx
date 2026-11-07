// An agent asks for a switched-off tool (G36.15): said in words, with the two ways to say yes
// (this conversation, or always for this agent) and no. Without a yes the tool stays off.
import type { PermissionRequestInfo } from "@redgiant/protocol";
import { t } from "../i18n.js";
import { IconTool } from "../icons.js";
import { getLive } from "../state.js";
import { toolName } from "./ToolsPage.js";

export function ToolRequestCard({ r }: { r: PermissionRequestInfo }) {
  const input = (r.input ?? {}) as { tool?: string; why?: string };
  const tool = input.tool ?? "";
  const resolve = (decision: "allow" | "deny", scope: "session" | "always" = "session") =>
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
      <div class="permission-actions">
        <button type="button" class="yes" onClick={() => resolve("allow", "session")}>
          {t("toolReqSession")}
        </button>
        <button type="button" class="always" onClick={() => resolve("allow", "always")}>
          {t("toolReqAlways", { name: r.agentName })}
        </button>
        <button type="button" class="no" onClick={() => resolve("deny")}>
          {t("toolReqNo")}
        </button>
      </div>
    </div>
  );
}

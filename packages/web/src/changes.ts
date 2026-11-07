// The history of changes in sentences (G24.10): what each configuration change did, read from its
// `before` and `after`, so nobody has to read JSON. Pure, tested in `test/changes.test.ts`.
import { MCP_CATALOG } from "@redgiant/protocol";
import type { PlatformChange } from "./api.js";
import { kTokens, usd } from "./format.js";
import { danger, t, tOptional } from "./i18n.js";

export interface Names {
  agent(id: string): string;
  project(id: string): string;
}

type Limit = { usd?: number; tokens?: number };
type Rule = { tool: string; match?: string; decision: "allow" | "ask" | "deny" };
type Policy = { rules?: Rule[]; humanOnly?: string[]; disabledDanger?: string[] };
type AgentConfig = {
  model?: { provider: string; model: string; effort?: string } | null;
  mode?: string | null;
  systemPrompt?: string | null;
};
type Automation = { yaml: string; enabled: boolean } | null;
type Mcp = { projectId: string | null; transport: { type: string; url?: string } } | null;

const limitText = (l: Limit | undefined) =>
  l?.usd !== undefined
    ? usd(l.usd)
    : l?.tokens !== undefined
      ? `${kTokens(l.tokens)} token`
      : t("chgNoLimit");
/** For comparing limits: no limit is the highest. */
const limitSize = (l: Limit | undefined) => l?.usd ?? l?.tokens ?? Number.POSITIVE_INFINITY;

const automationName = (a: Automation) => a?.yaml.match(/^name:\s*["']?([^"'\n]+)/m)?.[1] ?? "";
const list = (ids: string[]) => ids.map((id) => danger(id).name).join(", ");
const modelText = (m: AgentConfig["model"]) =>
  m ? `${m.provider}/${m.model}${m.effort ? ` (${m.effort})` : ""}` : t("chgInherited");
const modeText = (m: string | null | undefined) =>
  m ? (tOptional(`agentMode_${m}`) ?? m) : t("chgInherited");

function budget(target: string, before: Limit | undefined, after: Limit | undefined, n: Names) {
  const [, scope = "", ...rest] = target.split(":");
  const id = rest.join(":");
  const what =
    scope === "global"
      ? t("chgBudgetTotal")
      : scope === "project"
        ? t("chgBudgetOf", { name: n.project(id) })
        : t("chgBudgetOf", { name: n.agent(id) });
  const vars = { what, before: limitText(before), after: limitText(after) };
  const b = limitSize(before);
  const a = limitSize(after);
  if (a === Number.POSITIVE_INFINITY && b !== a) return [t("chgBudgetRemoved", vars)];
  if (b === Number.POSITIVE_INFINITY && a !== b) return [t("chgBudgetSet", vars)];
  return [t(a > b ? "chgBudgetUp" : a < b ? "chgBudgetDown" : "chgBudgetSame", vars)];
}

function agent(id: string, before: AgentConfig, after: AgentConfig, n: Names) {
  const name = n.agent(id);
  const out: string[] = [];
  if ("model" in after && JSON.stringify(before.model ?? null) !== JSON.stringify(after.model))
    out.push(
      t("chgAgentModel", {
        name,
        before: modelText(before.model),
        after: modelText(after.model),
      }),
    );
  if ("mode" in after && (before.mode ?? null) !== after.mode)
    out.push(
      t("chgAgentMode", { name, before: modeText(before.mode), after: modeText(after.mode) }),
    );
  if ("systemPrompt" in after && (before.systemPrompt ?? null) !== after.systemPrompt)
    out.push(t(after.systemPrompt ? "chgAgentPrompt" : "chgAgentPromptReset", { name }));
  return out.length > 0 ? out : [t("chgAgentSame", { name })];
}

function policy(before: Policy, after: Policy) {
  const out: string[] = [];
  const diff = (a: string[] = [], b: string[] = []) => a.filter((x) => !b.includes(x));
  const humanAdded = diff(after.humanOnly, before.humanOnly);
  const humanRemoved = diff(before.humanOnly, after.humanOnly);
  const off = diff(after.disabledDanger, before.disabledDanger);
  const on = diff(before.disabledDanger, after.disabledDanger);
  if (humanAdded.length) out.push(t("chgHumanOnly", { list: list(humanAdded) }));
  if (humanRemoved.length) out.push(t("chgNotHumanOnly", { list: list(humanRemoved) }));
  if (off.length) out.push(t("chgDangerOff", { list: list(off) }));
  if (on.length) out.push(t("chgDangerOn", { list: list(on) }));
  const key = (r: Rule) => `${r.tool}|${r.match ?? ""}|${r.decision}`;
  const had = new Set((before.rules ?? []).map(key));
  const has = new Set((after.rules ?? []).map(key));
  const rule = (r: Rule) =>
    t(`chgRule_${r.decision}`, { tool: r.tool, match: r.match ? ` (${r.match})` : "" });
  for (const r of after.rules ?? [])
    if (!had.has(key(r))) out.push(t("chgRuleAdded", { rule: rule(r) }));
  for (const r of before.rules ?? [])
    if (!has.has(key(r))) out.push(t("chgRuleRemoved", { rule: rule(r) }));
  return out.length > 0 ? out : [t("chgPolicySame")];
}

function automation(before: Automation, after: Automation) {
  const name = automationName(after) || automationName(before);
  if (!before) return [t("chgAutoCreated", { name })];
  if (!after) return [t("chgAutoDeleted", { name })];
  if (before.yaml !== after.yaml) return [t("chgAutoEdited", { name })];
  return [t(after.enabled ? "chgAutoOn" : "chgAutoOff", { name })];
}

function mcp(id: string, before: Mcp, after: Mcp, n: Names) {
  const name = MCP_CATALOG.find((e) => e.id === id)?.name ?? id;
  const where = (m: Mcp) =>
    m?.projectId ? t("extOnlyProject", { name: n.project(m.projectId) }) : t("extEverywhere");
  if (!before && after) return [t("chgMcpAdded", { name, where: where(after) })];
  if (before && !after) return [t("chgMcpRemoved", { name })];
  return [t("chgMcpChanged", { name, where: where(after) })];
}

type Tools = { off?: string[]; agents?: Record<string, Record<string, "on" | "off">> };
const toolList = (ids: string[]) => ids.map((id) => tOptional(`tool_${id}`) ?? id).join(", ");

/** The tools page (G34.5): switched off or back on for everyone, or one agent's exceptions. */
function tools(agentId: string, before: Tools, after: Tools, n: Names) {
  const out: string[] = [];
  if (!agentId) {
    const b = before.off ?? [];
    const a = after.off ?? [];
    const off = a.filter((x) => !b.includes(x));
    const on = b.filter((x) => !a.includes(x));
    if (off.length) out.push(t("chgToolsOff", { list: toolList(off) }));
    if (on.length) out.push(t("chgToolsOn", { list: toolList(on) }));
    return out.length > 0 ? out : [t("chgToolsSame")];
  }
  const name = n.agent(agentId);
  const b = before.agents?.[agentId] ?? {};
  const a = after.agents?.[agentId] ?? {};
  const ids = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((id) => b[id] !== a[id]);
  const of = (v: "on" | "off" | undefined) => ids.filter((id) => a[id] === v);
  if (of("on").length) out.push(t("chgToolsAgentOn", { name, list: toolList(of("on")) }));
  if (of("off").length) out.push(t("chgToolsAgentOff", { name, list: toolList(of("off")) }));
  if (of(undefined).length)
    out.push(t("chgToolsAgentDefault", { name, list: toolList(of(undefined)) }));
  return out.length > 0 ? out : [t("chgToolsSame")];
}

/** What a change did, in one or more sentences. */
export function describeChange(c: PlatformChange, n: Names): string[] {
  if (c.kind === "code") return [t("chgCode", { what: c.change })];
  const target = c.target ?? "";
  const [type, ...rest] = target.split(":");
  const id = rest.join(":");
  if (type === "budget") return budget(target, c.before as Limit, c.after as Limit, n);
  if (type === "agent")
    return agent(id, (c.before ?? {}) as AgentConfig, (c.after ?? {}) as AgentConfig, n);
  if (type === "policy") return policy((c.before ?? {}) as Policy, (c.after ?? {}) as Policy);
  if (type === "automation")
    return automation((c.before ?? null) as Automation, (c.after ?? null) as Automation);
  if (type === "mcp") return mcp(id, (c.before ?? null) as Mcp, (c.after ?? null) as Mcp, n);
  if (type === "tools") return tools(id, (c.before ?? {}) as Tools, (c.after ?? {}) as Tools, n);
  return [c.change];
}

/** What a code change's stage means for the person. */
export const codeStageText = (stage: PlatformChange["stage"]) => t(`chgStage_${stage}`);

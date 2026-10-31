import type { ToolCallInfo } from "@redgiant/agent";
import type { AgentKind, PermissionMode } from "@redgiant/protocol";

export type Decision = "allow" | "ask" | "deny";

/** Explicit user rule. `tool` accepts `*`; `match` is a regex on the call's input as JSON. */
export interface PermissionRule {
  tool: string;
  match?: string;
  decision: Decision;
}

/** What makes a call "dangerous" (RD12): editable by the user, each rule can be disabled. */
export interface DangerRule {
  id: string;
  label: string;
  tool: string;
  /** Input field to test; the whole input as JSON when omitted. */
  field?: string;
  pattern: string;
  /** Tools the rule never applies to (when `tool` is a prefix pattern). */
  except?: string[];
  enabled?: boolean;
}

export const DEFAULT_DANGER_RULES: DangerRule[] = [
  {
    id: "rm-recursive",
    label: "Recursive delete",
    tool: "bash",
    field: "command",
    pattern: "\\brm\\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\\b",
  },
  {
    id: "git-push",
    label: "git push",
    tool: "bash",
    field: "command",
    pattern: "\\bgit\\s+push\\b",
  },
  {
    id: "git-history",
    label: "Rewrite git history",
    tool: "bash",
    field: "command",
    pattern:
      "\\bgit\\s+(reset\\s+--hard|push\\s+.*--force|rebase|filter-(branch|repo)|clean\\s+-[a-zA-Z]*f)",
  },
  {
    id: "pipe-to-shell",
    label: "Download and run",
    tool: "bash",
    field: "command",
    pattern: "(curl|wget)[^|]*\\|\\s*(sudo\\s+)?(ba|z)?sh\\b",
  },
  {
    id: "privilege",
    label: "Privilege escalation",
    tool: "bash",
    field: "command",
    pattern: "\\b(sudo|su|doas|chmod\\s+[0-7]*7[0-7]{2}|chown)\\b",
  },
  {
    id: "disk",
    label: "Disk and system",
    tool: "bash",
    field: "command",
    pattern: "\\b(dd|mkfs[.\\w]*|fdisk|parted|shutdown|reboot|systemctl)\\b",
  },
  {
    id: "containers",
    label: "Containers and clusters",
    tool: "bash",
    field: "command",
    pattern: "\\b(docker|podman|kubectl|helm)\\b",
  },
  {
    id: "database-drop",
    label: "Destructive SQL",
    tool: "*",
    pattern:
      "\\b(DROP\\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\\s+TABLE|DELETE\\s+FROM\\s+\\w+\\s*;?\\s*$)",
  },
  {
    id: "deploy",
    label: "Deploy and publish",
    tool: "bash",
    field: "command",
    pattern:
      "\\b(npm\\s+publish|pnpm\\s+publish|cargo\\s+publish|terraform\\s+apply|fly\\s+deploy|vercel\\s+--prod)\\b",
  },
  {
    // RD27: God changing the platform (configuration, policy, its own code) asks first.
    id: "platform",
    label: "Changes the platform",
    tool: "platform_*",
    pattern: ".*",
    // Opening or dropping a code change touches nothing live; testing and promoting it do.
    except: ["platform_code_start", "platform_code_discard"],
  },
  {
    id: "secrets-files",
    label: "Secret files",
    tool: "*",
    pattern: "(\\.env\\b|id_rsa|id_ed25519|\\.pem\\b|credentials\\.json|\\.netrc)",
  },
];

export interface PolicySettings {
  rules: PermissionRule[];
  danger: DangerRule[];
  /** Danger ids that only the human may approve, whatever the parents' modes. */
  humanOnly: string[];
  /** Which parent kinds may approve requests of the agents below them. */
  approverKinds: AgentKind[];
  /** A request nobody answers is denied after this long; undefined = wait forever. */
  askTimeoutMs?: number;
}

export const DEFAULT_POLICY: PolicySettings = {
  rules: [],
  danger: DEFAULT_DANGER_RULES,
  humanOnly: [
    "git-push",
    "git-history",
    "privilege",
    "disk",
    "deploy",
    "database-drop",
    "secrets-files",
    "platform",
  ],
  approverKinds: ["god", "orchestrator", "agent"],
};

/** Tools that cannot change anything; allowed in every mode. */
export const READ_ONLY_TOOLS = new Set([
  "read_file",
  "glob",
  "grep",
  "web_search",
  "fetch",
  "list_agents",
  "read_agent",
  "board_list",
  "board_read",
  "board_search",
  // Talking on the board changes no workspace.
  "board_post",
  // Closing a task changes nothing by itself; its verifier command is checked as a bash call.
  "complete_task",
  "platform_status",
  "platform_changes",
]);

const toolMatches = (pattern: string, tool: string) =>
  pattern === "*" ||
  pattern === tool ||
  (pattern.endsWith("*") && tool.startsWith(pattern.slice(0, -1)));

function subject(call: ToolCallInfo, field?: string): string {
  if (field && call.input && typeof call.input === "object") {
    const v = (call.input as Record<string, unknown>)[field];
    return typeof v === "string" ? v : JSON.stringify(v ?? "");
  }
  return JSON.stringify(call.input ?? "");
}

export function classify(call: ToolCallInfo, rules: DangerRule[]): DangerRule[] {
  return rules.filter(
    (r) =>
      r.enabled !== false &&
      toolMatches(r.tool, call.name) &&
      !r.except?.includes(call.name) &&
      new RegExp(r.pattern, "i").test(subject(call, r.field)),
  );
}

export interface Evaluation {
  decision: Decision;
  reasons: string[];
  /** Ids of the danger rules the call matched. */
  danger: string[];
}

/**
 * Decides one tool call: the mode first (plan/readonly never modify), then the user's
 * rules (deny > ask > allow), then the mode's default — manual asks for anything that can
 * modify, auto asks only for dangerous calls.
 */
export function evaluate(mode: PermissionMode, call: ToolCallInfo, s: PolicySettings): Evaluation {
  const matched = classify(call, s.danger);
  const danger = matched.map((r) => r.id);
  const readOnly = READ_ONLY_TOOLS.has(call.name);
  const out = (decision: Decision, ...reasons: string[]): Evaluation => ({
    decision,
    reasons,
    danger,
  });

  if ((mode === "plan" || mode === "readonly") && !readOnly) {
    return out("deny", `"${call.name}" can modify the workspace and the agent is in ${mode} mode`);
  }
  const rules = s.rules.filter(
    (r) =>
      toolMatches(r.tool, call.name) &&
      (!r.match || new RegExp(r.match, "i").test(JSON.stringify(call.input ?? ""))),
  );
  for (const d of ["deny", "ask", "allow"] as const) {
    if (rules.some((r) => r.decision === d)) return out(d, `rule: ${d} ${call.name}`);
  }
  if (readOnly) return out("allow");
  if (mode === "manual") return out("ask", "manual mode", ...matched.map((r) => r.label));
  return matched.length > 0 ? out("ask", ...matched.map((r) => r.label)) : out("allow");
}

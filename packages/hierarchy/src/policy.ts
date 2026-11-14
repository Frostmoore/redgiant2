import type { ToolCallInfo } from "@redgiant/agent";
import { criticalOf, type RemoteMachineInfo } from "./critical.js";
import {
  editReadsOnly,
  type LockedFolder,
  lockedWrites,
  outsideShows,
  outsideWrites,
  readsIntoKnowledge,
} from "./guardian.js";

/** The guardian's danger: writing outside the agent's folders (only the human approves it). */
export const OUTSIDE_PROJECT = "outside-project";

/**
 * An email leaving through `mail_send` (G38.1): a message, so an ordinary request that only the
 * person answers. Not a pattern the person can switch off: every send asks, whatever the rules.
 */
export const OUTGOING_MAIL = "outgoing-mail";

/**
 * Another agent's model changing (G38.9, decision «Il modello degli agenti lo sceglie la persona»):
 * an agent does it only when the person asked, and the person approves every change. Never a
 * parent agent, never a rule or a mode that lets it through.
 */
export const AGENT_MODEL = "agent-model";

/** Dangers only the person answers whatever their settings say (the broker reads this). */
export const ALWAYS_HUMAN: readonly string[] = [OUTGOING_MAIL, AGENT_MODEL];

import type { AgentKind, CriticalDetail, PermissionMode } from "@redgiant/protocol";

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
  /** A regex the tool's name must match too (for tools of connected services). */
  name?: string;
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
    // G24.11: what leaves through a connected service (an email, a post, a payment) asks first.
    id: "outgoing",
    label: "Sends, publishes, deletes or pays",
    tool: "mcp__*",
    // Whole words of the tool's own name: send_email and createPost ask, list_posts does not.
    name: "(^|_)(send|post|publish|reply|forward|share|invite|delete|remove|trash|archive|cancel|pay|purchase|buy|order|charge|refund|transfer)(_|$)",
    pattern: ".*",
  },
  {
    // G24.14b: the same in the agents' browser, by the name of the button clicked.
    id: "outgoing-browser",
    label: "Sends, publishes, pays or deletes in the browser",
    tool: "browser_click",
    field: "name",
    pattern:
      "\\b(send|invia|inviare|post|posta|pubblica|publish|pay|paga|pagare|buy|compra|acquista|purchase|order|ordina|checkout|delete|elimina|cancella|remove|rimuovi|transfer|bonifico|confirm|conferma)\\b",
  },
  {
    // G24.14c: a pull request or an issue on the project's repository is public to its readers.
    id: "git-publish",
    label: "Opens a pull request or an issue",
    tool: "repo_*",
    pattern: ".*",
    except: ["repo_list"],
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
  /**
   * The guardian (2026-11-04, RedGiant 2.0): "ask" (the default) asks the human before an agent
   * writes outside its folders; "auto" lets it. The folders are the agent's project and worktree.
   */
  guardian?: "ask" | "auto";
  roots?: string[];
  home?: string;
  /**
   * What the truly dangerous requests need besides the folders (G36.17b): the keychain's values
   * (read when a call is checked, never stored here) and RedGiant's own files.
   */
  critical?: {
    knownSecrets?: () => readonly string[];
    protectedPaths?: readonly string[];
    /** The person's machines (G38.2): their working folders and homes, read when a call is checked. */
    machines?: () => Readonly<Record<string, RemoteMachineInfo>>;
  };
  /**
   * Archived projects' folders (p3.5.3): no agent writes there or runs a command there, whatever
   * the rules, the mode or the person would answer. Refused at once, never asked.
   */
  locked?: LockedFolder[];
}

export const DEFAULT_POLICY: PolicySettings = {
  rules: [],
  danger: DEFAULT_DANGER_RULES,
  humanOnly: [
    OUTSIDE_PROJECT,
    "git-push",
    "git-history",
    "privilege",
    "disk",
    "deploy",
    "database-drop",
    "secrets-files",
    "platform",
    "outgoing",
    "outgoing-browser",
    "git-publish",
  ],
  approverKinds: ["god", "orchestrator", "agent"],
};

/** Tools that cannot change anything; allowed in every mode. */
export const READ_ONLY_TOOLS = new Set([
  "read_file",
  "glob",
  "grep",
  // Names and paths anywhere on the computer, never contents (p3.4.0): like ls or find in bash.
  "find_files",
  "web_search",
  "fetch",
  "view_image",
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
  // The inspector only reads.
  "ask_inspector",
  // Asking the human changes nothing; approving a plan is the human's own decision.
  "ask_user",
  "propose_plan",
  // The agent's own notes (G29.3): no workspace, no project file.
  "memory",
  // The person's canvas (G36.12): looking and leafing through change no file (a path outside the
  // folders is the guardian's, above).
  "canvas_look",
  "canvas_act",
  // Searching the person's documents (G36.5) only reads; so does their state (3.5.3).
  "search_knowledge",
  "knowledge_status",
  // The agent's list of steps (2026-11-05): shown to the person, changes nothing.
  "update_todos",
  // Reads or stops the conversation's own background command (p3.3.1): starting it was a bash
  // call, checked as such.
  "bash_output",
  // Opens a file in the person's canvas (G34.1); outside the folders the guardian asks.
  "show_file",
  // Magic automations (G33.3): a proposal the person approves (or the list of links).
  "propose_automation",
  // Magic integrations (G38.3): a package tested in a throwaway sandbox that the person installs.
  "propose_magic_extension",
  // Asking the person to switch a tool back on (G36.15): the person's yes is asked by the tool itself.
  "request_tool",
  // Another machine's folders and text files (G38.2): looked at, never changed.
  "ssh_list",
  "ssh_read",
  // The nodes one may use and how they are (G39.4): looked at, never changed.
  "node_list",
  // Searching the person's mailboxes (G38.1) changes nothing; reading uses PEEK (nothing marked
  // as read) and only writes when it saves the attachments (below).
  "mail_search",
]);

/** mail_read writes into the workspace only when it saves the attachments (G38.1). */
const mailReadOnly = (input: unknown) =>
  !(
    input &&
    typeof input === "object" &&
    (input as { save_attachments?: unknown }).save_attachments
  );

/**
 * The read-only tools that may run together within one answer (the session's batches). The
 * canvas's moves are read only but run in the model's order (p3.5.6): a show_file or a canvas_act
 * next to a canvas_look went at the same time, and the look saw the canvas from before the move.
 */
export const CONCURRENT_TOOLS: ReadonlySet<string> = new Set(
  [...READ_ONLY_TOOLS].filter((t) => t !== "show_file" && t !== "canvas_act"),
);

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

/** A tool's own name as snake_case words, without the `mcp__<server>__` prefix. */
const toolWords = (name: string) =>
  name
    .replace(/^mcp__[a-z0-9-]+__/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();

/**
 * A command on another machine (G38.2, `ssh_run`) or a node (G39.4, `node_run`) is classified with
 * the same rules as one here:
 * every rule for `bash` applies to it too.
 */
const ruleApplies = (pattern: string, tool: string) =>
  toolMatches(pattern, tool) || (pattern === "bash" && (tool === "ssh_run" || tool === "node_run"));

export function classify(call: ToolCallInfo, rules: DangerRule[]): DangerRule[] {
  return rules.filter(
    (r) =>
      r.enabled !== false &&
      ruleApplies(r.tool, call.name) &&
      !r.except?.includes(call.name) &&
      (!r.name || new RegExp(r.name, "i").test(toolWords(call.name))) &&
      new RegExp(r.pattern, "i").test(subject(call, r.field)),
  );
}

export interface Evaluation {
  decision: Decision;
  reasons: string[];
  /** Ids of the danger rules the call matched (and the critical ones, G36.17b). */
  danger: string[];
  /**
   * The truly dangerous kinds the call is (G36.17b, `criticalOf`): such a call always asks the
   * person, whatever the rules and the mode (a deny stays a deny), and only the person decides it.
   */
  critical: string[];
  /** What each of them does, for the person (p3.5.4: the red card's sentences). */
  criticalDetail?: CriticalDetail[];
}

/**
 * Decides one tool call: the mode first (plan/readonly never modify), then the user's
 * rules (deny > ask > allow), then the mode's default — manual asks for anything that can
 * modify, auto asks only for dangerous calls.
 */
export function evaluate(mode: PermissionMode, call: ToolCallInfo, s: PolicySettings): Evaluation {
  if (s.locked?.length) {
    const hit = lockedWrites(call, {
      roots: s.roots ?? [],
      ...(s.home && { home: s.home }),
      locked: s.locked,
      readOnly: (name) => READ_ONLY_TOOLS.has(name),
    });
    const first = hit[0];
    if (first) {
      const project = s.locked.find((l) => first === l.path || first.startsWith(l.path))?.project;
      return {
        decision: "deny",
        reasons: [
          `The project "${project ?? "?"}" is archived: restore it first (nothing may change or run in ${first} until then)`,
        ],
        danger: [],
        critical: [],
      };
    }
  }
  const e = evaluateRules(mode, call, s);
  if (e.decision === "deny") return e;
  const hits = criticalOf(call, {
    ...(s.roots && { roots: s.roots }),
    ...(s.home && { home: s.home }),
    ...(s.critical?.knownSecrets && { knownSecrets: s.critical.knownSecrets() }),
    ...(s.critical?.protectedPaths && { protectedPaths: s.critical.protectedPaths }),
    ...(s.critical?.machines && { machines: s.critical.machines() }),
  });
  if (hits.length === 0) return e;
  const critical = hits.map((h) => h.id);
  return {
    decision: "ask",
    reasons: [
      ...hits.map((h) => `truly dangerous: ${h.why}`),
      ...(e.decision === "ask" ? e.reasons : []),
    ],
    danger: [...e.danger, ...critical.filter((id) => !e.danger.includes(id))],
    critical,
    criticalDetail: hits.map(({ why: _why, ...d }) => d),
  };
}

function evaluateRules(mode: PermissionMode, call: ToolCallInfo, s: PolicySettings): Evaluation {
  const matched = classify(call, s.danger);
  const danger = matched.map((r) => r.id);
  // canvas_edit's catalog and dry runs only read (G37.1).
  const readOnly =
    READ_ONLY_TOOLS.has(call.name) ||
    (call.name === "canvas_edit" && editReadsOnly(call.input)) ||
    (call.name === "mail_read" && mailReadOnly(call.input));
  const out = (decision: Decision, ...reasons: string[]): Evaluation => ({
    decision,
    reasons,
    danger,
    critical: [],
  });

  if ((mode === "plan" || mode === "readonly") && !readOnly) {
    return out(
      "deny",
      `"${call.name}" can modify the workspace and the agent is in ${mode} mode${mode === "plan" ? " (explore, then present the plan with propose_plan if you have it)" : ""}`,
    );
  }
  const rules = s.rules.filter(
    (r) =>
      toolMatches(r.tool, call.name) &&
      (!r.match || new RegExp(r.match, "i").test(JSON.stringify(call.input ?? ""))),
  );
  // An email leaving (G38.1) always asks the person: no allow rule, no mode lets it through.
  if (call.name === "mail_send" && !rules.some((r) => r.decision === "deny"))
    return {
      decision: "ask",
      reasons: ["sends an email"],
      danger: [...danger, OUTGOING_MAIL],
      critical: [],
    };
  // Another agent's model (G38.9) is the person's choice: every change asks them.
  if (call.name === "set_agent_model" && !rules.some((r) => r.decision === "deny"))
    return {
      decision: "ask",
      reasons: ["changes another agent's model"],
      danger: [...danger, AGENT_MODEL],
      critical: [],
    };
  for (const d of ["deny", "ask", "allow"] as const) {
    if (rules.some((r) => r.decision === d)) return out(d, `rule: ${d} ${call.name}`);
  }
  // The guardian for what is shown (G34.1): a file outside the folders is the human's call.
  if (s.guardian !== "auto" && s.roots?.length) {
    const shown = outsideShows(call, { roots: s.roots, ...(s.home && { home: s.home }) });
    if (shown.length > 0)
      return {
        decision: "ask",
        reasons: [
          readsIntoKnowledge(call)
            ? `reads files outside the project into the knowledge: ${shown.slice(0, 3).join(", ")}`
            : `${call.name === "canvas_look" ? "looks at" : "shows"} a file outside the project: ${shown.slice(0, 3).join(", ")}`,
        ],
        danger: [...danger, OUTSIDE_PROJECT],
        critical: [],
      };
  }
  if (readOnly) return out("allow");
  // The guardian: writing outside the agent's folders is the human's call (unless "auto").
  if (s.guardian !== "auto" && s.roots?.length) {
    const outside = outsideWrites(call, { roots: s.roots, ...(s.home && { home: s.home }) });
    if (outside.length > 0)
      return {
        decision: "ask",
        reasons: [`writes outside the project: ${outside.slice(0, 3).join(", ")}`],
        danger: [...danger, OUTSIDE_PROJECT],
        critical: [],
      };
  }
  if (mode === "manual") return out("ask", "manual mode", ...matched.map((r) => r.label));
  return matched.length > 0 ? out("ask", ...matched.map((r) => r.label)) : out("allow");
}

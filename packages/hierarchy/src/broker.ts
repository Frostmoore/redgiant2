import { randomUUID } from "node:crypto";
import type { PermissionDecision, ToolCallInfo } from "@redgiant/agent";
import type { EventStore } from "@redgiant/events";
import type { PermissionMode } from "@redgiant/protocol";
import { evaluate, type PolicySettings } from "./policy.js";
import { type AgentNode, approvalChain, type Resolve } from "./scopes.js";

export interface ApprovalRequest {
  requestId: string;
  requester: AgentNode;
  call: ToolCallInfo;
  reasons: string[];
  danger: string[];
  /** The conversation that asked (2026-11-05: "allow for this conversation"). */
  sessionId?: string;
}

/**
 * A request decided without the person (G36.17): by the classifier they chose, or because their
 * time ran out. Only an explicit classifier's yes allows; a failure or a timeout is a no.
 */
export interface UnattendedAnswer {
  decision: "allow" | "deny";
  by: "classifier" | "timeout";
  reason: string;
}

/** The person's answer: yes, no, or no with words the agent reads (2026-11-05). */
export type HumanAnswer = "allow" | "deny" | { deny: string } | UnattendedAnswer;

/** Whether an answer is a yes (the person's, or their classifier's explicit one). */
export function allows(answer: HumanAnswer): boolean {
  if (answer === "allow") return true;
  return (
    typeof answer === "object" &&
    "by" in answer &&
    answer.by === "classifier" &&
    answer.decision === "allow"
  );
}

export type AgentAnswer = "allow" | "deny" | "escalate";

export interface PermissionBrokerOptions {
  store: EventStore;
  resolve: Resolve;
  /** Settings and mode of an agent (from the registry and the user's configuration). */
  settingsFor: (agent: AgentNode) => PolicySettings;
  modeFor: (agent: AgentNode) => PermissionMode;
  /** Asks a parent agent (normally by letting its model decide). */
  askAgent: (approver: AgentNode, request: ApprovalRequest) => Promise<AgentAnswer>;
  /** Asks the human (web UI, or Telegram via Demi-God); resolves when they answer. */
  askHuman: (request: ApprovalRequest, signal: AbortSignal) => Promise<HumanAnswer>;
}

/**
 * Turns policy decisions into answers. A request that needs approval goes to the parent;
 * each parent may allow, deny or pass it up, and the human is the last step. Dangers the
 * user reserved for themself skip the agents entirely. Everything is logged.
 */
export class PermissionBroker {
  constructor(private readonly o: PermissionBrokerOptions) {}

  /** `sessionId` ties the request events to the conversation that raised them. */
  async check(
    agent: AgentNode,
    call: ToolCallInfo,
    sessionId?: string,
  ): Promise<PermissionDecision> {
    const settings = this.o.settingsFor(agent);
    const ev = evaluate(this.o.modeFor(agent), call, settings);
    if (ev.decision === "allow") return { allow: true };
    // Allowed for this conversation by the person, unless it is a danger only they approve or a
    // truly dangerous one (G36.17b: asked every time).
    if (
      ev.decision === "ask" &&
      sessionId &&
      this.sessionAllows.get(sessionId)?.has(call.name) &&
      ev.critical.length === 0 &&
      !ev.danger.some((d) => settings.humanOnly.includes(d))
    )
      return { allow: true };
    if (ev.decision === "deny") return { allow: false, reason: ev.reasons.join("; ") };

    const request: ApprovalRequest = {
      requestId: randomUUID(),
      requester: agent,
      call,
      reasons: ev.reasons,
      danger: ev.danger,
      ...(sessionId && { sessionId }),
    };
    // Parent agents never decide a danger the person kept for themself, nor a truly dangerous one.
    const humanOnly =
      ev.critical.length > 0 || ev.danger.some((d) => settings.humanOnly.includes(d));
    for (const approver of approvalChain(agent, this.o.resolve)) {
      if (approver && (humanOnly || !settings.approverKinds.includes(approver.kind))) continue;
      await this.log(agent, sessionId, {
        type: "permission.requested",
        payload: {
          requestId: request.requestId,
          callId: call.callId,
          reason: ev.reasons.join("; "),
          askedTo: approver?.id ?? "human",
        },
      });
      const answer = approver
        ? await this.o.askAgent(approver, request).catch(() => "escalate" as const)
        : await this.human(request, settings);
      if (typeof answer === "object" && "by" in answer) {
        const yes = allows(answer);
        await this.log(agent, sessionId, {
          type: "permission.resolved",
          payload: {
            requestId: request.requestId,
            decision: yes ? "allow" : "deny",
            by: answer.by,
          },
        });
        if (yes) return { allow: true };
        return {
          allow: false,
          reason:
            answer.by === "classifier"
              ? `denied by the person's classifier (they are not taking requests now): ${answer.reason}`
              : `nobody answered in time: ${answer.reason}`,
        };
      }
      const said = typeof answer === "object" ? answer.deny : undefined;
      await this.log(agent, sessionId, {
        type: "permission.resolved",
        payload: {
          requestId: request.requestId,
          decision: typeof answer === "object" ? "deny" : answer,
          by: approver?.id ?? "human",
        },
      });
      if (said !== undefined)
        return { allow: false, reason: `denied by the person, who said: ${said}` };
      if (answer === "allow") return { allow: true };
      if (answer === "deny")
        return { allow: false, reason: `denied by ${approver?.name ?? "the user"}` };
    }
    return { allow: false, reason: "nobody approved the request" };
  }

  /** Tools the person allowed for one conversation (never past a human-only danger). */
  private readonly sessionAllows = new Map<string, Set<string>>();
  allowForSession(sessionId: string, tool: string): void {
    const set = this.sessionAllows.get(sessionId) ?? new Set<string>();
    set.add(tool);
    this.sessionAllows.set(sessionId, set);
  }

  private async human(request: ApprovalRequest, s: PolicySettings): Promise<HumanAnswer> {
    const controller = new AbortController();
    // A channel that fails or is cancelled counts as a refusal, never as an approval.
    const asked = this.o.askHuman(request, controller.signal).catch(() => "deny" as const);
    if (s.askTimeoutMs === undefined) return asked;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"deny">((ok) => {
      timer = setTimeout(() => {
        controller.abort();
        ok("deny");
      }, s.askTimeoutMs);
    });
    try {
      return await Promise.race([asked, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private log(
    agent: AgentNode,
    sessionId: string | undefined,
    body: Parameters<EventStore["append"]>[0]["body"],
  ) {
    return this.o.store.append({
      ownerId: agent.ownerId,
      projectId: agent.projectId,
      agentId: agent.id,
      sessionId: sessionId ?? null,
      body,
    });
  }
}

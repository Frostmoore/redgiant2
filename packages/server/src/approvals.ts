import { EventEmitter } from "node:events";
import type { ApprovalRequest, HumanAnswer } from "@redgiant/hierarchy";
import { type PermissionRequestInfo, requestNameIds } from "@redgiant/protocol";

interface Pending {
  info: PermissionRequestInfo;
  ownerId: string;
  resolve: (d: HumanAnswer) => void;
}

/**
 * Requests waiting for the human. Every channel gets them at once (the page and every linked
 * chat, G36.17); the first answer wins and every channel is told the request is closed, and where
 * it was decided (`via`: "web", a chat platform, "timeout").
 */
export class HumanApprovals extends EventEmitter<{
  request: [ownerId: string, info: PermissionRequestInfo];
  closed: [ownerId: string, requestId: string, decision: "allow" | "deny", via: string | undefined];
}> {
  private readonly pending = new Map<string, Pending>();
  /** Where each closed request was answered, until the broker records it (`takeVia`). */
  private readonly answered = new Map<string, string>();

  /**
   * The names of the projects and agents a request mentions (3.5.6): every channel says them
   * instead of ids. A lookup that fails only leaves the ids.
   */
  nameOf?: (ownerId: string, ids: string[]) => Promise<Record<string, string>>;

  ask(request: ApprovalRequest, signal: AbortSignal): Promise<HumanAnswer> {
    // The ids in the input, and the requester's project (the chats' first line names it).
    const ids = [
      ...new Set([
        ...requestNameIds(request.call.name, request.call.input),
        ...(request.requester.projectId ? [request.requester.projectId] : []),
      ]),
    ];
    const lookup = this.nameOf;
    if (!lookup || ids.length === 0) return this.open(request, signal);
    return lookup(request.requester.ownerId, ids)
      .catch(() => ({}))
      .then((names) =>
        // Stopped while the names were looked up: never asked, so it is a no.
        signal.aborted ? ("deny" as const) : this.open(request, signal, names),
      );
  }

  private open(
    request: ApprovalRequest,
    signal: AbortSignal,
    names: Record<string, string> = {},
  ): Promise<HumanAnswer> {
    const info: PermissionRequestInfo = {
      requestId: request.requestId,
      agentId: request.requester.id,
      agentName: request.requester.name,
      projectId: request.requester.projectId,
      tool: request.call.name,
      input: request.call.input,
      reasons: request.reasons,
      danger: request.danger,
      ...(request.critical?.length && { critical: request.critical }),
      ...(Object.keys(names).length > 0 && { names }),
      createdAt: new Date().toISOString(),
      ...(request.sessionId && { sessionId: request.sessionId }),
    };
    const ownerId = request.requester.ownerId;
    return new Promise((resolve) => {
      this.pending.set(info.requestId, { info, ownerId, resolve });
      // The person's time running out aborts with "timeout" (PersonRequests): the copies say so.
      signal.addEventListener(
        "abort",
        () =>
          this.decide(
            ownerId,
            info.requestId,
            "deny",
            undefined,
            signal.reason === "timeout" ? "timeout" : undefined,
          ),
        { once: true },
      );
      this.emit("request", ownerId, info);
    });
  }

  list(ownerId: string): PermissionRequestInfo[] {
    return [...this.pending.values()].filter((p) => p.ownerId === ownerId).map((p) => p.info);
  }

  /** Returns false when the request does not exist or belongs to someone else. */
  decide(
    ownerId: string,
    requestId: string,
    decision: "allow" | "deny",
    reason?: string,
    via?: string,
  ): boolean {
    const p = this.pending.get(requestId);
    if (!p || p.ownerId !== ownerId) return false;
    this.pending.delete(requestId);
    if (via) {
      this.answered.set(requestId, via);
      // Answers nobody came to take (a broker without `answeredVia`) are dropped, oldest first.
      for (const old of this.answered.keys()) {
        if (this.answered.size <= 1000) break;
        this.answered.delete(old);
      }
    }
    p.resolve(decision === "deny" && reason?.trim() ? { deny: reason.trim() } : decision);
    this.emit("closed", ownerId, requestId, decision, via);
    return true;
  }

  /** Where a closed request was answered ("web", a chat platform, "timeout"); taken once. */
  takeVia(requestId: string): string | undefined {
    const via = this.answered.get(requestId);
    this.answered.delete(requestId);
    return via;
  }

  /** Denies everything still open (shutdown). */
  denyAll(): void {
    for (const [id, p] of this.pending) this.decide(p.ownerId, id, "deny");
  }
}

import { EventEmitter } from "node:events";
import type { ApprovalRequest } from "@redgiant/hierarchy";
import type { PermissionRequestInfo } from "@redgiant/protocol";

interface Pending {
  info: PermissionRequestInfo;
  ownerId: string;
  resolve: (d: "allow" | "deny") => void;
}

/**
 * Requests waiting for the human. Any connected client of the owner may answer; the first
 * answer wins and every client is told the request is closed.
 */
export class HumanApprovals extends EventEmitter<{
  request: [ownerId: string, info: PermissionRequestInfo];
  closed: [ownerId: string, requestId: string, decision: "allow" | "deny"];
}> {
  private readonly pending = new Map<string, Pending>();

  ask(request: ApprovalRequest, signal: AbortSignal): Promise<"allow" | "deny"> {
    const info: PermissionRequestInfo = {
      requestId: request.requestId,
      agentId: request.requester.id,
      agentName: request.requester.name,
      projectId: request.requester.projectId,
      tool: request.call.name,
      input: request.call.input,
      reasons: request.reasons,
      danger: request.danger,
      createdAt: new Date().toISOString(),
    };
    const ownerId = request.requester.ownerId;
    return new Promise((resolve) => {
      this.pending.set(info.requestId, { info, ownerId, resolve });
      signal.addEventListener("abort", () => this.decide(ownerId, info.requestId, "deny"), {
        once: true,
      });
      this.emit("request", ownerId, info);
    });
  }

  list(ownerId: string): PermissionRequestInfo[] {
    return [...this.pending.values()].filter((p) => p.ownerId === ownerId).map((p) => p.info);
  }

  /** Returns false when the request does not exist or belongs to someone else. */
  decide(ownerId: string, requestId: string, decision: "allow" | "deny"): boolean {
    const p = this.pending.get(requestId);
    if (!p || p.ownerId !== ownerId) return false;
    this.pending.delete(requestId);
    p.resolve(decision);
    this.emit("closed", ownerId, requestId, decision);
    return true;
  }

  /** Denies everything still open (shutdown). */
  denyAll(): void {
    for (const [id, p] of this.pending) this.decide(p.ownerId, id, "deny");
  }
}

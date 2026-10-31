import type { AgentSessionOptions } from "@redgiant/agent";
import { costUsd } from "@redgiant/providers";
import type { PermissionBroker } from "./broker.js";
import { budgetKeys, type PersistentBudget } from "./budget.js";
import type { AgentNode, Resolve } from "./scopes.js";

/**
 * Wires an agent's session to the hierarchy: every tool call goes through the permission
 * broker, every model call is checked against the budgets first and counted after.
 */
export function hierarchyGuards(o: {
  agent: AgentNode;
  resolve: Resolve;
  broker: PermissionBroker;
  budget: PersistentBudget;
}): Pick<AgentSessionOptions, "permission" | "beforeModelCall" | "onCompletion"> {
  const keys = () => budgetKeys(o.agent, o.resolve);
  const at = { ownerId: o.agent.ownerId, projectId: o.agent.projectId, agentId: o.agent.id };
  return {
    permission: (call) => o.broker.check(o.agent, call),
    beforeModelCall: async () => {
      const breaches = await o.budget.check(keys());
      if (breaches.length === 0) return { allow: true };
      const b = breaches[0];
      return { allow: false, reason: `budget exceeded (${b?.key.scope} ${b?.key.id})` };
    },
    // Returned, not fired and forgotten: the session awaits it before the next budget check.
    onCompletion: async (completion, usd) => {
      await o.budget.record(keys(), completion.usage, usd, at);
    },
  };
}

export { costUsd };

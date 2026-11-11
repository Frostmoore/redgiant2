// An assistant's state for the left bar (3.5.11: apart from the assistant's page, which loads
// when it opens).
import type { Agent } from "./api.js";
import { approvals, questions, sessionRows } from "./state.js";

export type AssistantState = "working" | "waiting" | "free";

/** At work (a conversation running), waiting for you (an approval or a question), or free. */
export function assistantState(a: Agent): AssistantState {
  if (
    approvals.value.some((r) => r.agentId === a.id) ||
    questions.value.some((q) => q.agentId === a.id)
  )
    return "waiting";
  return sessionRows.value.some((r) => r.agentId === a.id && r.running) ? "working" : "free";
}

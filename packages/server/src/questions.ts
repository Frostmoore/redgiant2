import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Tool } from "@redgiant/agent";
import type { EventStore } from "@redgiant/events";
import type { AgentRecord } from "@redgiant/hierarchy";
import {
  type Answers,
  PLAN_APPROVE,
  PLAN_REVISE,
  Question,
  type QuestionRequestInfo,
} from "@redgiant/protocol";
import { z } from "zod";

interface Pending {
  info: QuestionRequestInfo;
  ownerId: string;
  resolve: (a: Answers | null) => void;
}

/**
 * Questions waiting for the human (G20.3), like the approvals: any client of the owner (or
 * Telegram) may answer, the first answer wins and everyone is told the question is closed.
 * Nobody answering is not an answer: an interrupted turn resolves to null.
 */
export class HumanQuestions extends EventEmitter<{
  request: [ownerId: string, info: QuestionRequestInfo];
  closed: [ownerId: string, requestId: string];
}> {
  private readonly pending = new Map<string, Pending>();

  ask(ownerId: string, info: QuestionRequestInfo, signal?: AbortSignal): Promise<Answers | null> {
    return new Promise((resolve) => {
      this.pending.set(info.requestId, { info, ownerId, resolve });
      signal?.addEventListener("abort", () => this.close(info.requestId, null), { once: true });
      this.emit("request", ownerId, info);
    });
  }

  list(ownerId: string): QuestionRequestInfo[] {
    return [...this.pending.values()].filter((p) => p.ownerId === ownerId).map((p) => p.info);
  }

  get(ownerId: string, requestId: string): QuestionRequestInfo | undefined {
    const p = this.pending.get(requestId);
    return p && p.ownerId === ownerId ? p.info : undefined;
  }

  /** Returns false when the question does not exist, belongs to someone else or is malformed. */
  answer(ownerId: string, requestId: string, answers: Answers): boolean {
    const p = this.pending.get(requestId);
    if (!p || p.ownerId !== ownerId) return false;
    if (answers.length !== p.info.questions.length || answers.some((a) => a.length === 0))
      return false;
    this.close(requestId, answers);
    return true;
  }

  private close(requestId: string, answers: Answers | null) {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    p.resolve(answers);
    this.emit("closed", p.ownerId, requestId);
  }

  /** Shutdown: every open question ends unanswered. */
  closeAll(): void {
    for (const id of [...this.pending.keys()]) this.close(id, null);
  }
}

export interface QuestionHost {
  store: EventStore;
  questions: HumanQuestions;
  /** The human approved the plan: the agent leaves plan mode (recorded, undoable). */
  leavePlanMode(ownerId: string, agentId: string): Promise<void>;
  modeOf(agentId: string): string;
}

/** Asks, records the question and its answer in the session, and waits. */
async function askHuman(
  host: QuestionHost,
  agent: AgentRecord,
  ctx: { ownerId: string; sessionId: string; signal?: AbortSignal | undefined },
  questions: Question[],
  plan?: string,
): Promise<Answers | null> {
  const info: QuestionRequestInfo = {
    requestId: randomUUID(),
    sessionId: ctx.sessionId,
    agentId: agent.id,
    agentName: agent.name,
    projectId: agent.projectId,
    questions,
    ...(plan !== undefined && { plan }),
    createdAt: new Date().toISOString(),
  };
  const where = {
    ownerId: ctx.ownerId,
    projectId: agent.projectId,
    agentId: agent.id,
    sessionId: ctx.sessionId,
  };
  await host.store.append({
    ...where,
    body: {
      type: "question.asked",
      payload: { requestId: info.requestId, questions, ...(plan !== undefined && { plan }) },
    },
  });
  const answers = await host.questions.ask(ctx.ownerId, info, ctx.signal);
  await host.store.append({
    ...where,
    body: {
      type: "question.answered",
      payload: { requestId: info.requestId, answers, by: answers ? "human" : "nobody" },
    },
  });
  return answers;
}

const AskInput = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        header: z.string().max(40).optional(),
        options: z
          .array(z.object({ label: z.string().min(1), description: z.string().optional() }))
          .min(2)
          .max(6),
        multi_select: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(4),
});

const PlanInput = z.object({ plan: z.string().min(1) });

/**
 * ask_user and propose_plan, for the agents the human talks with (God and the orchestrators).
 * Both wait for the human; the answer comes back as the tool's result.
 */
export function questionTools(agent: AgentRecord, host: QuestionHost): Tool[] {
  if (agent.kind !== "god" && agent.kind !== "orchestrator") return [];
  const ask: Tool<z.infer<typeof AskInput>> = {
    def: {
      name: "ask_user",
      description:
        "Ask the human one to four multiple-choice questions and wait for the answers. Use it when a decision is theirs (a preference, a trade-off, missing requirements), not for things you can find out yourself. Give 2-6 short, distinct options per question; the human can always write a different answer. Set multi_select when several options may apply.",
      inputSchema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                question: { type: "string", description: "The full question" },
                header: { type: "string", description: "A label of a few words" },
                options: {
                  type: "array",
                  minItems: 2,
                  maxItems: 6,
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      description: { type: "string", description: "What choosing it means" },
                    },
                    required: ["label"],
                  },
                },
                multi_select: { type: "boolean" },
              },
              required: ["question", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
    schema: AskInput,
    async run({ questions }, ctx) {
      const qs: Question[] = questions.map((q) =>
        Question.parse({
          question: q.question,
          ...(q.header && { header: q.header }),
          options: q.options,
          multiSelect: q.multi_select ?? false,
        }),
      );
      const answers = await askHuman(host, agent, ctx, qs);
      if (!answers)
        return { content: "The human did not answer (the turn was interrupted).", isError: true };
      return qs.map((q, i) => `${q.question}\n-> ${(answers[i] ?? []).join("; ")}`).join("\n\n");
    },
  };
  const propose: Tool<z.infer<typeof PlanInput>> = {
    def: {
      name: "propose_plan",
      description:
        "In plan mode: present your plan (Markdown) to the human and wait. If they approve it, you leave plan mode and may carry it out at once; otherwise you get their feedback and keep planning.",
      inputSchema: {
        type: "object",
        properties: { plan: { type: "string", description: "The plan, in Markdown" } },
        required: ["plan"],
      },
    },
    schema: PlanInput,
    async run({ plan }, ctx) {
      if (host.modeOf(agent.id) !== "plan")
        return { content: "You are not in plan mode: just carry on.", isError: true };
      const answers = await askHuman(
        host,
        agent,
        ctx,
        [
          {
            question: "Approve this plan?",
            options: [{ label: PLAN_APPROVE }, { label: PLAN_REVISE }],
            multiSelect: false,
          },
        ],
        plan,
      );
      const answer = answers?.[0]?.[0];
      if (!answer)
        return { content: "The human did not answer (the turn was interrupted).", isError: true };
      if (answer === PLAN_APPROVE) {
        await host.leavePlanMode(ctx.ownerId, agent.id);
        return "The human approved the plan. You are now in auto mode: carry it out.";
      }
      return answer === PLAN_REVISE
        ? "The human wants a different plan. Ask what to change if it is not clear."
        : `The human did not approve the plan yet. Their feedback: ${answer}`;
    },
  };
  return [ask, propose];
}

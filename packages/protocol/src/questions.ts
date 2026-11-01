import { z } from "zod";

/** A question an agent asks the human (G20.3): pick one or more options, or write another answer. */
export const Question = z.object({
  question: z.string().min(1).max(1000),
  /** A short label for the question (a chip in the card). */
  header: z.string().max(40).optional(),
  options: z
    .array(
      z.object({ label: z.string().min(1).max(120), description: z.string().max(400).optional() }),
    )
    .min(2)
    .max(6),
  multiSelect: z.boolean().default(false),
});
export type Question = z.infer<typeof Question>;

/** What clients show while a question waits; `plan` is set for a plan proposal. */
export const QuestionRequestInfo = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  projectId: z.string().nullable(),
  questions: z.array(Question).min(1).max(4),
  plan: z.string().optional(),
  createdAt: z.iso.datetime(),
});
export type QuestionRequestInfo = z.infer<typeof QuestionRequestInfo>;

/** One answer per question: the chosen labels, or the text the human wrote instead. */
export const Answers = z.array(z.array(z.string().max(4000)).max(6)).max(4);
export type Answers = z.infer<typeof Answers>;

/** The options of a plan proposal: the first approves it. */
export const PLAN_APPROVE = "Approve";
export const PLAN_REVISE = "Keep planning";

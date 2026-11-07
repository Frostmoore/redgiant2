// Skills that come by themselves (G36.8): after a problem solved, the agent proposes a skill
// (instructions and, when useful, scripts) with a short account of what worked. Two parts:
//   - `SKILL_PROMPT`, in the system prompt of every agent that can propose (fixed for the session);
//   - `SkillNudge`, a postToolUse hook that, once per conversation and only after real effort (a
//     task closed by a verifier after many steps, or a success after several failures), adds one
//     line to that tool's result. Never a message of its own, never a question to the person: the
//     prompt prefix stays the same and the person only sees the proposal, in Extensions.

import type { Hooks } from "@redgiant/agent";

export const SKILL_PROMPT = [
  "## Skills from solved problems",
  "When you solve a problem in a way that was not obvious (it took several attempts, a workaround, a fact you had to " +
    "find out) and it is likely to come up again, propose a skill once the work is done: propose_extension with kind " +
    '"skill", short instructions in body, helper scripts as files with tests, and summary (two or three lines: the ' +
    "problem and what worked). First look with skill_search: if a skill already covers it, propose an update to that " +
    "skill (its name, updates true) instead of a new one. Not for routine work, one-off details or facts about the " +
    "person (those belong in memory). Never ask the person about it: the proposal waits for them in Extensions.",
].join("\n");

/** How much effort makes a nudge worth it. */
export const NUDGE = {
  /** Failed tool results in one turn before a success counts as a struggle. */
  failures: 3,
  /** Steps in one turn before a verified task counts as non-trivial. */
  taskCalls: 8,
  /** Failures in one turn before a verified task counts as non-trivial. */
  taskFailures: 2,
} as const;

/** Tools whose success says nothing about a problem being solved. */
const QUIET = new Set([
  "ask_user",
  "propose_plan",
  "conversation_history",
  "memory",
  "skill_search",
  "skill_file",
  "skill_load",
]);

interface SessionState {
  calls: number;
  failures: number;
  nudged: boolean;
  proposed: boolean;
  loaded: Set<string>;
}

/** The text added to the result (exported for the tests). */
export function nudgeText(o: { failures: number; task: boolean; loaded: string[] }): string {
  const what = o.task
    ? "The task is verified."
    : `That worked after ${o.failures} failed attempts.`;
  const update =
    o.loaded.length > 0
      ? ` You used the skill ${o.loaded.map((n) => `"${n}"`).join(", ")}: if it lacked what you found out, propose an update to it (same name, updates true) instead of a new skill.`
      : " Check skill_search first: if a skill covers it, propose an update to it instead.";
  return `\n\n[RedGiant] ${what} If the way you solved it was not obvious and would help again, propose a skill when you are done (propose_extension, kind "skill", with summary).${update} If it was routine, ignore this; do not mention it to the person.`;
}

/**
 * Watches each conversation's tool results and nudges at most once per conversation (G36.8).
 * The counts start again with each turn of the person (`turnStarted`).
 */
export class SkillNudge {
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly limit = 2000) {}

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { calls: 0, failures: 0, nudged: false, proposed: false, loaded: new Set() };
      this.sessions.set(sessionId, s);
      // Old conversations are forgotten first: a nudge more after a long while does no harm.
      if (this.sessions.size > this.limit) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
    }
    return s;
  }

  /** A new turn: the effort is counted again from here. */
  turnStarted(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.calls = 0;
      s.failures = 0;
    }
  }

  /** The postToolUse hook for one agent's conversations. */
  hook(): NonNullable<Hooks["postToolUse"]>[number] {
    return (call, result, ctx) => {
      const s = this.state(ctx.sessionId);
      if (call.name === "propose_extension") {
        s.proposed = true;
        return undefined;
      }
      if (call.name === "skill_load" && !result.isError) {
        const name = (call.input as { name?: unknown } | undefined)?.name;
        if (typeof name === "string") s.loaded.add(name);
      }
      if (QUIET.has(call.name)) return undefined;
      s.calls++;
      if (result.isError) {
        s.failures++;
        return undefined;
      }
      if (s.nudged || s.proposed) return undefined;
      const verified =
        call.name === "complete_task" && /^Verified:/.test(result.content.trimStart());
      const task = verified && (s.calls >= NUDGE.taskCalls || s.failures >= NUDGE.taskFailures);
      const struggle = !verified && s.failures >= NUDGE.failures;
      if (!task && !struggle) return undefined;
      s.nudged = true;
      return {
        content:
          result.content + nudgeText({ failures: s.failures, task, loaded: [...s.loaded].sort() }),
        isError: false,
      };
    };
  }
}

// The agent's list of steps kept up to date (3.5.6, as Claude Code does): an agent writes the
// list once and then forgets it. While the latest list still has open steps, every
// TODO_REMINDER_EVERY tool calls without `update_todos` (and when a task it handed over reports
// back) RedGiant appends a short note with the list as it is. The note is part of what is
// logged (the tool result's output, or the report message's notes), so the history rebuilds
// byte for byte; the counter itself is rebuilt from the same events (`TodoWatch.fromEvents`).

import type { Event } from "@redgiant/protocol";

export const TODO_TOOL = "update_todos";
/** Tool calls without `update_todos` after which an open list is shown again. */
export const TODO_REMINDER_EVERY = 8;
/** How a reminder in a message's notes begins: how a resumed session recognises it. */
export const TODO_NOTE_START = "Your list of steps";

export interface TodoStep {
  content: string;
  status: string;
}

/** The steps of an `update_todos` call, or undefined when its input is not a list. */
function stepsOf(input: unknown): TodoStep[] | undefined {
  const todos = (input as { todos?: unknown } | null | undefined)?.todos;
  if (!Array.isArray(todos)) return undefined;
  return todos.flatMap((t) =>
    t && typeof t === "object" && typeof (t as TodoStep).content === "string"
      ? [{ content: (t as TodoStep).content, status: String((t as TodoStep).status) }]
      : [],
  );
}

const MAX_STEP = 140;
// Notes are at most 2000 characters each (protocol): the list is cut before that.
const MAX_LIST = 1500;

function listText(steps: TodoStep[]): string {
  const lines: string[] = [];
  let size = 0;
  for (const [i, s] of steps.entries()) {
    const content = s.content.length > MAX_STEP ? `${s.content.slice(0, MAX_STEP)}…` : s.content;
    const line = `${i + 1}. [${s.status}] ${content.replace(/\s+/g, " ")}`;
    if (size + line.length > MAX_LIST) {
      lines.push(`… ${steps.length - i} more`);
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * The state of one session's list: the latest steps the agent wrote and the tool calls since
 * then (or since the last reminder). Fed with every tool result in log order, live and on resume.
 */
export class TodoWatch {
  private steps: TodoStep[] | undefined;
  private since = 0;

  constructor(private readonly every = TODO_REMINDER_EVERY) {}

  /** One tool result: a good `update_todos` sets the list and counts from zero, others count. */
  result(tool: string | undefined, input: unknown, ok: boolean): void {
    const steps = tool === TODO_TOOL && ok ? stepsOf(input) : undefined;
    if (steps) {
      this.steps = steps;
      this.since = 0;
    } else this.since++;
  }

  /** Whether the latest list has steps still pending or in progress. */
  get open(): boolean {
    return this.steps?.some((s) => s.status !== "completed") === true;
  }

  /** A reminder is due on the result just counted. */
  get due(): boolean {
    return this.open && this.since >= this.every;
  }

  /** A reminder was given: count again from zero. */
  reminded(): void {
    this.since = 0;
  }

  /** The reminder's text (without RedGiant's brackets: `notedText` adds them). */
  text(why: "calls" | "report"): string {
    const head =
      why === "calls"
        ? `${TODO_NOTE_START} (update_todos) has not changed in your last ${this.since} tool calls; it still says:`
        : `${TODO_NOTE_START} (update_todos) still has open steps; it says:`;
    return (
      `${head}\n${listText(this.steps ?? [])}\n` +
      "Mark a step in_progress before you start it and completed as soon as it is done. If the list is out of date, " +
      "update it now with update_todos (the person sees it). Do not mention this note."
    );
  }

  /** The same state a live session had after these events. */
  static fromEvents(events: Iterable<Event>, every = TODO_REMINDER_EVERY): TodoWatch {
    const w = new TodoWatch(every);
    const calls = new Map<string, { tool: string; input: unknown }>();
    for (const e of events) {
      if (e.payload === null) continue;
      if (e.type === "tool.call")
        calls.set(e.payload.callId, { tool: e.payload.tool, input: e.payload.input });
      else if (e.type === "tool.result") {
        const c = calls.get(e.payload.callId);
        w.result(c?.tool, c?.input, e.payload.ok);
        if (e.payload.reminder === "todos") w.reminded();
      } else if (
        e.type === "message.user" &&
        e.payload.notes?.some((n) => n.startsWith(TODO_NOTE_START))
      )
        w.reminded();
    }
    return w;
  }
}

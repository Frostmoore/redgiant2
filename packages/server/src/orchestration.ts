import { randomUUID } from "node:crypto";
import type { Hooks, SendResult, Tool, ToolContext } from "@redgiant/agent";
import type { EventStore } from "@redgiant/events";
import {
  type AgentAnswer,
  type AgentRecord,
  type AgentRegistry,
  type ApprovalRequest,
  budgetKeys,
  CHILD_KINDS,
  can,
  type PermissionBroker,
  type PersistentBudget,
} from "@redgiant/hierarchy";
import type { Event, ImagePart, ModelSpec } from "@redgiant/protocol";
import { complete, costUsd, type ProviderRegistry, streamWithFallback } from "@redgiant/providers";
import {
  commitAll,
  mergeWorktree,
  removeWorktree,
  worktreeBranch,
  worktreeDir,
} from "@redgiant/sandbox";
import type { Workspace } from "@redgiant/tools";
import { z } from "zod";
import { type RepoState, repoSentence } from "./project-git.js";
import type { ProjectStore } from "./projects.js";
import type { Rooms } from "./rooms.js";

/** What the orchestration tools need from the core. */
export interface OrchestrationHost {
  registry: AgentRegistry;
  projects: ProjectStore;
  store: EventStore;
  broker: PermissionBroker;
  /** The session an agent receives delegated work in (created on first use). */
  workSession(agent: AgentRecord, projectId?: string): Promise<string>;
  /** Names a conversation in the list (tasks: who gave the latest, and what). */
  nameSession?(sessionId: string, title: string): Promise<void>;
  /** A brand-new session: isolated context. */
  startSession(ownerId: string, agentId: string): Promise<string>;
  send(
    ownerId: string,
    sessionId: string,
    text: string,
    extra?: {
      images?: ImagePart[];
      from?: string;
      /** Busy: wait in line instead of failing. Only for whoever does not wait on the answer in a circle. */
      queue?: boolean;
    },
  ): Promise<{ done: Promise<SendResult>; queued?: boolean }>;
  /** What came with the user's Telegram message (photos, saved files) for God, taken once. */
  takeRelay?(ownerId: string): { images: ImagePart[]; text: string } | undefined;
  projectWorkspaces(
    agent: AgentRecord,
  ): Promise<{ root: Workspace; worktree: (agentId: string) => Promise<Workspace> }>;
  /** Group chats (G24.12), for God's ask_group (G24.14c). */
  rooms?: Rooms;
  /** A project's inspector as an agent, made on first use. */
  inspectorAgent?(ownerId: string, projectId: string): Promise<AgentRecord>;
  /**
   * G29.7: this sub-agent gets a worktree of its own, branched from its parent's, instead of
   * working in the parent's (parallel sub-agents must not edit the same files at once).
   */
  isolate?(subagentId: string): void;
  /** G36.14: the tools a new agent starts without, chosen by its creator (history, undoable). */
  toolsAtCreation?(
    ownerId: string,
    by: string,
    agentId: string,
    off: { tool: string; why: string }[],
  ): Promise<{ change: { change: string } | null; ignored: string[] }>;
  /** Whether a conversation is working now. */
  isRunning?(sessionId: string): boolean;
  /** Stops a conversation's background commands (a sub-agent's work ended, p3.3.1). */
  stopCommands?(sessionId: string): Promise<void>;
}

/** How a sub-agent's work ended, as its tab shows it. */
type SubagentEnd = "done" | "failed" | "stopped";

type Outcome = "verified" | "not_testable" | "abandoned";

export interface Task {
  id: string;
  title: string;
  agentId: string;
  sessionId: string;
  ownerId: string;
  projectId: string | null;
  outcome?: Outcome;
  reminders: number;
  /** Who handed it over, and in which conversation: the report goes back there (G24.14f). */
  from?: { agentId: string; sessionId: string; name: string };
  /** Its report was sent to `from`. */
  reported?: boolean;
  /** What was asked (kept in memory: an escalation hands it to the next model). */
  brief?: string;
  /** The task this one takes over from, after another model gave up on it. */
  escalatedFrom?: string;
  /** Given up here and handed to the backup model: that task and its turn. */
  escalation?: { task: Task; done: Promise<unknown> };
  /** Its closing (and escalation), once started: closing twice waits for the first. */
  closing?: Promise<void>;
}

/**
 * A task given up on, handed once to the backup model (2026-11-05, the user's idea): a new
 * conversation of the same agent, with that model, the task and what the first attempt did.
 */
export type Escalate = (
  task: Task,
  reason: string,
) => Promise<{ task: Task; done: Promise<unknown> } | undefined>;

/**
 * Tasks handed from a parent to a child (RD17): a task closes only with a verifier that
 * passed, or an explicit, justified "not testable"; an agent that stops without closing
 * is reminded, and after three reminders the task is recorded as abandoned.
 */
export class TaskTracker {
  private readonly tasks = new Map<string, Task>();
  static readonly MAX_REMINDERS = 3;

  /** Set by the core: where a task given up on goes next (nowhere without a backup model). */
  escalate: Escalate | undefined;

  constructor(private readonly store: EventStore) {}

  async open(
    agent: AgentRecord,
    sessionId: string,
    title: string,
    from?: Task["from"],
    /** The project it is done for, when not the agent's own (an assignment). */
    projectId?: string,
    extra: { brief?: string; escalatedFrom?: string } = {},
  ): Promise<Task> {
    const task: Task = {
      id: `task_${randomUUID().slice(0, 8)}`,
      title,
      agentId: agent.id,
      sessionId,
      ownerId: agent.ownerId,
      projectId: projectId ?? agent.projectId,
      reminders: 0,
      ...(from && { from }),
      ...(extra.brief && { brief: extra.brief }),
      ...(extra.escalatedFrom && { escalatedFrom: extra.escalatedFrom }),
    };
    this.tasks.set(task.id, task);
    await this.log(task, {
      type: "task.opened",
      payload: {
        taskId: task.id,
        title,
        ...(from && { from }),
        ...(extra.escalatedFrom && { escalatedFrom: extra.escalatedFrom }),
      },
    });
    return task;
  }

  /**
   * After a restart: the tasks still open come back from the log (S27), so the stop hook keeps
   * reminding their agents and complete_task can close them.
   */
  async rebuild(): Promise<number> {
    const events = await this.store.list({ types: ["task.opened", "task.closed"] });
    for (const e of events) {
      const p = e.payload as { taskId: string; title?: string; from?: Task["from"] } | null;
      if (!p) continue;
      if (e.type === "task.opened" && e.agentId && e.sessionId)
        this.tasks.set(p.taskId, {
          id: p.taskId,
          title: p.title ?? "",
          agentId: e.agentId,
          sessionId: e.sessionId,
          ownerId: e.ownerId,
          projectId: e.projectId,
          reminders: 0,
          ...(p.from && { from: p.from }),
        });
      else if (e.type === "task.closed") this.tasks.delete(p.taskId);
    }
    return this.tasks.size;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /** The open task of an agent in a session, if any. */
  openFor(agentId: string, sessionId: string): Task | undefined {
    return [...this.tasks.values()]
      .reverse()
      .find((t) => t.agentId === agentId && t.sessionId === sessionId && !t.outcome);
  }

  /** Tasks this conversation handed over and still waits for. */
  waitingIn(sessionId: string): Task[] {
    return [...this.tasks.values()].filter((t) => t.from?.sessionId === sessionId && !t.outcome);
  }

  /** Tasks done in this conversation whose report has not gone back yet; marked as sent. */
  toReport(sessionId: string): Task[] {
    const out = [...this.tasks.values()].filter(
      (t) => t.sessionId === sessionId && t.outcome && t.from && !t.reported,
    );
    for (const t of out) t.reported = true;
    return out;
  }

  async verified(task: Task, verifier: string, passed: boolean): Promise<void> {
    await this.log(task, { type: "task.verified", payload: { taskId: task.id, verifier, passed } });
    if (passed) await this.close(task, { outcome: "verified" });
  }

  async close(
    task: Task,
    how:
      | { outcome: "verified" }
      | { outcome: "not_testable"; justification: string }
      | { outcome: "abandoned"; reason: string },
  ): Promise<void> {
    if (task.closing) return task.closing;
    task.outcome = how.outcome;
    task.closing = (async () => {
      await this.log(task, { type: "task.closed", payload: { taskId: task.id, ...how } });
      // Once only: a task the backup model gives up on too is reported as abandoned.
      if (how.outcome === "abandoned" && !task.escalatedFrom && this.escalate) {
        // Its report waits for the backup model's attempt.
        task.reported = true;
        const next = await this.escalate(task, how.reason).catch(() => undefined);
        if (next) task.escalation = next;
        else task.reported = false;
      }
    })();
    return task.closing;
  }

  private log(task: Task, body: Parameters<EventStore["append"]>[0]["body"]) {
    return this.store.append({
      ownerId: task.ownerId,
      projectId: task.projectId,
      agentId: task.agentId,
      sessionId: task.sessionId,
      body,
    });
  }

  /** Stop hook: keeps the agent working until its task is closed (or given up on). */
  stopHook(agentId: string): NonNullable<Hooks["stop"]>[number] {
    return async (_completion, ctx) => {
      const task = this.openFor(agentId, ctx.sessionId);
      if (!task) return undefined;
      // It handed parts over and waits for their reports: it goes on when they come.
      if (this.waitingIn(ctx.sessionId).length > 0) return undefined;
      if (task.reminders >= TaskTracker.MAX_REMINDERS) {
        await this.close(task, {
          outcome: "abandoned",
          reason: "the agent stopped without verifying the result",
        });
        return undefined;
      }
      task.reminders++;
      return (
        `Task ${task.id} ("${task.title}") is still open. Verify the result and call complete_task ` +
        "with a verify_command that checks it (it must exit 0), or, only if the result truly cannot be " +
        "tested, with not_testable_reason explaining why."
      );
    };
  }
}

const lastAssistantText = (events: Event[]) => {
  for (const e of [...events].reverse()) {
    if (e.type === "message.assistant" && e.payload) {
      const text = e.payload.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
      if (text) return text;
    }
  }
  return "";
};

const CreateAgentInput = z.object({
  kind: z.string(),
  name: z.string().min(1),
  role: z.string().min(1),
  system_prompt: z.string().optional(),
  project_id: z.string().optional(),
  subproject_id: z.string().optional(),
  connections: z.array(z.string().min(1)).optional(),
  tools_off: z
    .array(z.object({ tool: z.string().min(1), why: z.string().min(1) }))
    .max(80)
    .optional(),
  model: z
    .object({
      provider: z.string(),
      model: z.string(),
      effort: z.enum(["low", "medium", "high", "max"]).optional(),
    })
    .optional(),
});

/** How much of an agent's latest answer one read_agent call returns. */
const READ_AGENT_CHARS = 20_000;

const clip = (s: string, n = 4000) =>
  s.length > n ? `${s.slice(0, n)}\n[… ${s.length - n} more characters]` : s;

/**
 * Tools that make an agent manage others: list, create, delegate (with a task), read, stop;
 * God also creates projects; agents run ephemeral sub-agents. Every action is checked
 * against the scope rules — the tools cannot do what the hierarchy forbids.
 */
export function orchestrationTools(
  self: AgentRecord,
  host: OrchestrationHost,
  tasks: TaskTracker,
): Tool[] {
  const me = { type: "agent" as const, agent: self };
  const target = (id: string) => {
    const t = host.registry.get(id);
    if (!t || t.ownerId !== self.ownerId) throw new Error(`No agent "${id}"`);
    return t;
  };

  /**
   * Hands a task over and returns at once (G24.14f): the agent works on it in its own
   * conversation; the report comes back to this one as a message when the task closes.
   */
  const assign = async (to: AgentRecord, title: string, task: string, ctx: ToolContext) => {
    if (!can(me, "message", to, host.registry.resolve))
      throw new Error(
        to.archived
          ? `${to.name}'s project is archived: nobody works in it until the person restores it`
          : `You cannot assign work to ${to.name}`,
      );
    // An agent assigned to this project works on it in a conversation of its own for it.
    const here =
      self.kind === "orchestrator" && self.projectId && to.projects?.includes(self.projectId)
        ? self.projectId
        : undefined;
    const sid = await host.workSession(to, here);
    const close = await openTab(ctx, { sessionId: sid, agentId: to.id }, "delegate", title, task);
    const t = await tasks.open(
      to,
      sid,
      title,
      { agentId: self.id, sessionId: ctx.sessionId, name: self.name },
      here,
      { brief: task },
    );
    const text =
      `Task from ${self.name}: «${title}»\n\n${task}\n\n` +
      `When it is done, verify the result and call complete_task (taskId "${t.id}").`;
    // The conversation is named after who gives the work and the latest task, not an id.
    await host.nameSession?.(sid, `${self.name}: ${title}`);
    const { done, queued } = await host.send(self.ownerId, sid, text, { queue: true });
    // Its tab ends with the turn that works on the task.
    done.then(
      async (r) => close(endOf(r), lastAssistantText(await host.store.list({ sessionId: sid }))),
      (err: Error) => close("failed", err.message),
    );
    return (
      `Task ${t.id} handed to ${to.name}${queued ? " (it is finishing something else first)" : ""}. ` +
      "You do not need to wait: its report comes to you as a message when the task closes. " +
      "Meanwhile you can do other things, and read_agent shows how it is going."
    );
  };

  /**
   * A sub-agent at work, recorded in the conversation that started it (p3.3.1: its tab there,
   * as Officina shows them). Written before the sub-agent's first message: its own part of its
   * conversation is what comes after. Returns how to record its end.
   */
  const openTab = async (
    ctx: ToolContext | undefined,
    child: { sessionId: string; agentId: string },
    via: string,
    title: string,
    task: string,
  ) => {
    if (!ctx?.sessionId) return async (_status: SubagentEnd, _summary?: string) => {};
    const base = {
      ownerId: self.ownerId,
      projectId: self.projectId ?? null,
      agentId: self.id,
      sessionId: ctx.sessionId,
    };
    await host.store
      .append({
        ...base,
        body: {
          type: "subagent.started",
          payload: {
            childSessionId: child.sessionId,
            childAgentId: child.agentId,
            ...(ctx.callId && { callId: ctx.callId }),
            via,
            title: title.slice(0, 200),
            task: task.slice(0, 20_000),
          },
        },
      })
      .catch(() => {});
    let ended = false;
    return async (status: SubagentEnd, summary?: string) => {
      if (ended) return;
      ended = true;
      await host.store
        .append({
          ...base,
          body: {
            type: "subagent.ended",
            payload: {
              childSessionId: child.sessionId,
              status,
              ...(summary && { summary: summary.slice(0, 1000) }),
            },
          },
        })
        .catch(() => {});
    };
  };
  /** How a sub-agent's turn ended, for its tab. */
  const endOf = (r: SendResult, outcome?: string): SubagentEnd =>
    r.stopReason === "aborted"
      ? "stopped"
      : outcome === "abandoned" || r.stopReason === "other" || r.stopReason === "refusal"
        ? "failed"
        : "done";

  /** Hands a task over and waits for its end: for short-lived sub-agents. */
  const delegate = async (
    to: AgentRecord,
    title: string,
    task: string,
    sessionId?: string,
    ctx?: ToolContext,
    via = "run_subagent",
  ) => {
    if (!can(me, "message", to, host.registry.resolve))
      throw new Error(`You cannot assign work to ${to.name}`);
    const sid = sessionId ?? (await host.workSession(to));
    const close = await openTab(ctx, { sessionId: sid, agentId: to.id }, via, title, task);
    let t = await tasks.open(to, sid, title, undefined, undefined, { brief: task });
    const text =
      `Task from ${self.name}: «${title}»\n\n${task}\n\n` +
      `When it is done, verify the result and call complete_task (taskId "${t.id}").`;
    await host.nameSession?.(sid, `${self.name}: ${title}`);
    const { done } = await host.send(self.ownerId, sid, text).catch(async (err: Error) => {
      await close("failed", err.message);
      throw err;
    });
    /** A turn ended: a task it did not close is given up on (and maybe escalated) now. */
    const settle = async (task: typeof t, r: SendResult) => {
      if (!task.outcome)
        await tasks.close(task, {
          outcome: "abandoned",
          reason: `the agent stopped: ${r.stopReason}${r.reason ? `, ${r.reason}` : ""}`,
        });
      await task.closing;
    };
    const ended = (p: Promise<unknown>) =>
      (p as Promise<SendResult>).catch(
        (err): SendResult => ({ stopReason: "other", turns: 0, reason: (err as Error).message }),
      );
    let r = await ended(done);
    await settle(t, r);
    let at = sid;
    // Given up on and handed to the backup model: its attempt is the report.
    while (t.escalation) {
      const next = t.escalation;
      r = await ended(next.done);
      t = next.task;
      at = t.sessionId;
      await settle(t, r);
    }
    const answer = lastAssistantText(await host.store.list({ sessionId: at }));
    await close(endOf(r, t.outcome), clip(answer, 1000));
    const outcome = `${t.outcome ?? "still open"}${t.escalatedFrom ? " (by the backup model, after the first one gave up)" : ""}`;
    // The last line lets the chat open the sub-agent's conversation (and the model read it).
    return `Task ${t.id} — ${outcome}${r.stopReason !== "end_turn" ? ` (agent stopped: ${r.stopReason}${r.reason ? `, ${r.reason}` : ""})` : ""}.\nReport from ${to.name}:\n${clip(answer)}\nConversation: ${at} (${to.id})`;
  };

  const tools: Tool[] = [];
  const children = CHILD_KINDS[self.kind];

  // Demi-God is a spokesperson (RD8): its only tool talks to God.
  if (self.kind === "demigod") {
    const god = host.registry
      .list({ ownerId: self.ownerId, activeOnly: true })
      .find((a) => a.kind === "god");
    if (!god) return [];
    return [
      {
        def: {
          name: "ask_god",
          description:
            "Pass the user's request to God and wait for God's answer. You can do nothing else yourself.",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
        schema: z.object({ message: z.string().min(1) }),
        async run({ message }: { message: string }) {
          if (!can(me, "message", god, host.registry.resolve))
            throw new Error("You cannot reach God.");
          const sid = await host.workSession(god);
          // The message goes as it is: who relays it is stated in God's system prompt (the
          // operator channel). A "[forwarded by another agent]" prefix in the text looks like a
          // prompt injection to safety classifiers and got refused as "cyber".
          // Photos and files the user sent on Telegram go to God with the message, whatever
          // Demi-God wrote: it relays, it does not filter.
          const relay = host.takeRelay?.(self.ownerId);
          const { done } = await host.send(self.ownerId, sid, `${message}${relay?.text ?? ""}`, {
            from: "Telegram",
            // God may be answering something else: this waits its turn.
            queue: true,
            ...(relay?.images.length ? { images: relay.images } : {}),
          });
          const r = await done;
          const answer = lastAssistantText(await host.store.list({ sessionId: sid }));
          const d = r.lastCompletion?.stopDetails;
          const why = d ? ` — ${[d.category, d.explanation].filter(Boolean).join(": ")}` : "";
          return `${r.stopReason === "end_turn" ? "" : `(God stopped: ${r.stopReason}${why})\n`}${clip(answer, 6000) || "God gave no answer."}`;
        },
      } as Tool,
    ];
  }

  if (self.kind !== "subagent" && self.kind !== "inspector") {
    tools.push({
      def: {
        name: "list_agents",
        description: "List the agents you can see, with id, kind, name, role, project and status.",
        inputSchema: { type: "object", properties: { project_id: { type: "string" } } },
      },
      schema: z.object({ project_id: z.string().optional() }),
      async run({ project_id }) {
        const visible = host.registry
          .list({ ownerId: self.ownerId, ...(project_id && { projectId: project_id }) })
          .filter((a) => a.id !== self.id && can(me, "read", a, host.registry.resolve));
        if (visible.length === 0) return "No agents.";
        return visible
          .map(
            (a) =>
              `${a.id}\t${a.kind}\t${a.name}${a.role ? ` (${a.role})` : ""}\t${a.projectId ?? "-"}${a.subprojectId ? `/${a.subprojectId}` : ""}\t${a.status}${a.archived ? " (project archived: read only)" : ""}`,
          )
          .join("\n");
      },
    } as Tool);
  }

  // Personal assistants (G24.11): God hands work to the one whose job it is, and assistants hand
  // work to each other; the answer comes back into the same conversation.
  if (self.kind === "god" || self.kind === "assistant") {
    tools.push({
      def: {
        name: "ask_assistant",
        description:
          "Hand a request to one of the user's personal assistants and wait for its answer. list_agents shows them (kind assistant) with their role: pick the one whose role already covers the work; do it yourself only if none fits. Say what you need and what to give back.",
        inputSchema: {
          type: "object",
          properties: { assistant_id: { type: "string" }, request: { type: "string" } },
          required: ["assistant_id", "request"],
        },
      },
      schema: z.object({ assistant_id: z.string(), request: z.string().min(1) }),
      async run(
        { assistant_id, request }: { assistant_id: string; request: string },
        ctx: ToolContext,
      ) {
        const to = target(assistant_id);
        if (to.kind !== "assistant") throw new Error(`${to.name} is not an assistant`);
        if (to.status !== "active") throw new Error(`${to.name} is stopped`);
        if (to.id === self.id || !can(me, "message", to, host.registry.resolve))
          throw new Error(`You cannot ask ${to.name}`);
        const sid = await host.workSession(to);
        if (host.isRunning?.(sid))
          return { content: `${to.name} is busy right now; try again later.`, isError: true };
        const close = await openTab(
          ctx,
          { sessionId: sid, agentId: to.id },
          "ask_assistant",
          request.split("\n")[0]?.slice(0, 80) || to.name,
          request,
        );
        let done: Promise<SendResult>;
        try {
          ({ done } = await host.send(
            self.ownerId,
            sid,
            `[Request from ${self.name}]\n${request}`,
          ));
        } catch (err) {
          await close("failed", (err as Error).message);
          // Its conversation is busy (maybe waiting on this very request): never wait in a circle.
          if ((err as Error).name === "SessionBusyError")
            return { content: `${to.name} is busy right now; try again later.`, isError: true };
          throw err;
        }
        const r = await done.catch(async (err: Error) => {
          await close("failed", err.message);
          throw err;
        });
        const answer = lastAssistantText(await host.store.list({ sessionId: sid }));
        await close(endOf(r), clip(answer, 1000));
        return `${r.stopReason === "end_turn" ? "" : `(${to.name} stopped: ${r.stopReason})\n`}${clip(answer, 6000) || `${to.name} gave no answer.`}`;
      },
    } as Tool);
  }

  // A group chat on the user's behalf (G24.14c): from Telegram too, where there is no "Add".
  if (self.kind === "god" && host.rooms) {
    const rooms = host.rooms;
    tools.push({
      def: {
        name: "ask_group",
        description:
          "Bring several agents into one group chat (the user can open it in RedGiant) and get their answers, for questions that need more than one of them, like two projects' inspectors. members: agent ids, or inspector:<project_id> for a project's inspector. The first member answers first; they pass the word to each other with @name.",
        inputSchema: {
          type: "object",
          properties: {
            members: { type: "array", items: { type: "string" } },
            message: { type: "string" },
            title: { type: "string" },
          },
          required: ["members", "message"],
        },
      },
      schema: z.object({
        members: z.array(z.string().min(1)).min(1).max(6),
        message: z.string().min(1),
        title: z.string().optional(),
      }),
      async run({
        members,
        message,
        title,
      }: {
        members: string[];
        message: string;
        title?: string;
      }) {
        const ids = await Promise.all(
          members.map(async (m) => {
            const p = m.match(/^inspector:(.+)$/)?.[1];
            if (p && host.inspectorAgent) return (await host.inspectorAgent(self.ownerId, p)).id;
            const byName = host.registry
              .list({ ownerId: self.ownerId, activeOnly: true })
              .find((a) => a.id === m || a.name.toLowerCase() === m.toLowerCase());
            if (!byName) throw new Error(`No agent "${m}"`);
            return byName.id;
          }),
        );
        const room = await rooms.create(self.ownerId, {
          members: ids,
          ...(title && { title }),
        });
        const before = (await rooms.events(self.ownerId, room.id)).at(-1)?.seq ?? -1;
        const { done } = await rooms.post(
          self.ownerId,
          room.id,
          `${message}\n\n(Asked by ${self.name} for the user.)`,
        );
        await done;
        const answers = (await rooms.events(self.ownerId, room.id)).flatMap((e) =>
          e.seq > before && e.type === "room.message" && e.payload && e.payload.from !== "human"
            ? [`${e.payload.name || "RedGiant"}: ${e.payload.text}`]
            : [],
        );
        return `Group chat "${room.title}" (the user can open it among the groups).\n\n${clip(answers.join("\n\n"), 8000) || "No answer."}`;
      },
    } as Tool);
  }

  if (self.kind === "god") {
    tools.push({
      def: {
        name: "create_project",
        description:
          "Create a new project: its own folder, with a git repository (branch main) when git works on this computer; the result says if it does not.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      schema: z.object({ name: z.string().min(1) }),
      async run({ name }) {
        const p = await host.projects.create(self.ownerId, name);
        const repo: RepoState =
          p.git === false
            ? { git: "missing", error: p.gitError ?? "git did not work" }
            : { git: "created" };
        return `Created project ${p.id} (folder ${p.path}). ${repoSentence(repo)} Create its orchestrator with create_agent (kind "orchestrator", project_id "${p.id}").`;
      },
    } as Tool);
  }

  const creatable: AgentRecord["kind"][] = children.filter(
    (k) => k !== "subagent" && k !== "demigod",
  );
  if (creatable.length > 0) {
    tools.push({
      def: {
        name: "create_agent",
        description: `Create a persistent agent under you (kind: ${creatable.join(" or ")}). Give it a clear role.`,
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: creatable },
            name: { type: "string" },
            role: { type: "string" },
            system_prompt: { type: "string" },
            project_id: { type: "string" },
            subproject_id: {
              type: "string",
              description: "agent only: the subproject it works in (its folder)",
            },
            connections: {
              type: "array",
              items: { type: "string" },
              description: "assistant only: the MCP servers (by name) it may use",
            },
            tools_off: {
              type: "array",
              items: {
                type: "object",
                properties: { tool: { type: "string" }, why: { type: "string" } },
                required: ["tool", "why"],
              },
              description:
                "tools its job does not need, as named on the Tools page (e.g. browser, blender, convert_file, image_generation, repo), each with why: every request gets cheaper; it can ask for one later",
            },
            model: {
              type: "object",
              properties: {
                provider: { type: "string" },
                model: { type: "string" },
                effort: { type: "string" },
              },
            },
          },
          required: ["kind", "name", "role"],
        },
      },
      schema: CreateAgentInput,
      async run(i: z.infer<typeof CreateAgentInput>) {
        if (!creatable.includes(i.kind as AgentRecord["kind"])) {
          return { content: `You can create: ${creatable.join(", ")}.`, isError: true };
        }
        const a = await host.registry.create(me, {
          kind: i.kind as AgentRecord["kind"],
          parentId: self.id,
          name: i.name,
          role: i.role,
          ...(i.system_prompt && { systemPrompt: i.system_prompt }),
          ...(i.project_id && { projectId: i.project_id }),
          ...(i.connections && { connections: i.connections }),
          ...(i.subproject_id && { subprojectId: i.subproject_id }),
          ...(i.model && { model: i.model as ModelSpec }),
        });
        let tools = "";
        if (i.tools_off?.length && host.toolsAtCreation) {
          const r = await host.toolsAtCreation(self.ownerId, self.id, a.id, i.tools_off);
          tools = r.change
            ? ` Switched off for it: ${r.change.change.split(": off ")[1] ?? ""}.`
            : "";
          if (r.ignored.length)
            tools += ` Not switched off (unknown or essential): ${r.ignored.join(", ")}.`;
        }
        return `Created ${a.kind} ${a.name} (${a.id}) in project ${a.projectId ?? "-"}.${tools}`;
      },
    } as Tool);
  }

  if (self.kind === "god" || self.kind === "orchestrator") {
    tools.push(
      {
        def: {
          name: "delegate",
          description:
            "Give a task to an agent you manage. It returns at once: the agent works on it while you go on, and its report comes to you as a message when the task closes. The agent must verify its work before the task closes.",
          inputSchema: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
              title: { type: "string" },
              task: { type: "string" },
            },
            required: ["agent_id", "title", "task"],
          },
        },
        schema: z.object({
          agent_id: z.string(),
          title: z.string().min(1),
          task: z.string().min(1),
        }),
        run: ({ agent_id, title, task }, ctx) => assign(target(agent_id), title, task, ctx),
      } as Tool,
      {
        def: {
          name: "read_agent",
          description:
            "Read the latest messages of an agent you can see; its latest answer (a finished task's report) comes in full. " +
            "For a very long answer, offset says where to go on reading it.",
          inputSchema: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
              offset: {
                type: "integer",
                description: "Read only the latest answer, from this character on.",
              },
            },
            required: ["agent_id"],
          },
        },
        schema: z.object({ agent_id: z.string(), offset: z.number().int().min(0).optional() }),
        async run({ agent_id, offset }) {
          const a = target(agent_id);
          if (!can(me, "read", a, host.registry.resolve))
            throw new Error(`You cannot read ${a.name}`);
          const events = (
            await host.store.list(a.projectId ? { projectId: a.projectId } : {})
          ).filter((e) => e.agentId === a.id);
          const said = (e: Event) =>
            e.type === "message.assistant" && e.payload
              ? e.payload.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("")
              : "";
          // The latest answer is the one a parent reads a report in (3.5.7): never cut to a
          // line like the others; a very long one says how to read on.
          const latest = events.findLast((e) => said(e) !== "");
          const whole = (from: number) => {
            const text = latest ? said(latest) : "";
            const end = from + READ_AGENT_CHARS;
            return end < text.length
              ? `${text.slice(from, end)}\n[… ${text.length - end} more characters: read_agent with offset ${end} gives the rest]`
              : text.slice(from);
          };
          if (offset !== undefined)
            return latest
              ? offset < said(latest).length
                ? whole(offset)
                : `The latest answer has ${said(latest).length} characters.`
              : "Nothing yet.";
          const lines = events
            .filter(
              (e) =>
                e.type === "message.user" ||
                e.type === "message.assistant" ||
                e.type === "task.closed",
            )
            .slice(-12)
            .map((e) => {
              if (e.type === "message.user" && e.payload) return `→ ${clip(e.payload.text, 600)}`;
              if (e.type === "message.assistant" && e.payload)
                return `← ${e === latest ? whole(0) : clip(said(e), 600)}`;
              if (e.type === "task.closed" && e.payload)
                return `✓ ${e.payload.taskId}: ${e.payload.outcome}`;
              return "";
            });
          return lines.join("\n") || "Nothing yet.";
        },
      } as Tool,
      {
        def: {
          name: "merge_work",
          description:
            "Commit an agent's work in its worktree and merge it into the project. On conflicts nothing is changed and the conflicting files are listed. A subproject's agent that changed files outside its folder (the shared parts) is merged only with include_shared, after you checked those changes.",
          inputSchema: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
              message: { type: "string" },
              include_shared: { type: "boolean" },
            },
            required: ["agent_id", "message"],
          },
        },
        schema: z.object({
          agent_id: z.string(),
          message: z.string().min(1),
          include_shared: z.boolean().optional(),
        }),
        async run({ agent_id, message, include_shared }) {
          const a = target(agent_id);
          if (a.kind !== "agent" || !can(me, "message", a, host.registry.resolve)) {
            throw new Error(`${a.name} is not an agent you manage`);
          }
          const { root, worktree } = await host.projectWorkspaces(a);
          const committed = await commitAll(
            await worktree(a.id),
            message,
            `${a.name} <${a.id}@redgiant>`,
          );
          // G24.13: what a subproject's agent changed outside its folder waits for the orchestrator.
          if (a.subprojectId && !include_shared) {
            const sub = await host.projects.subproject(a.ownerId, a.subprojectId);
            const changed = (
              await root.execFile(
                "git",
                ["diff", "--name-only", `HEAD...${worktreeBranch(a.id)}`],
                {
                  timeoutMs: 30_000,
                },
              )
            ).stdout
              .split(/\r?\n/)
              .filter(Boolean);
            const outside = sub ? changed.filter((f) => !f.startsWith(`${sub.dir}/`)) : [];
            if (outside.length > 0)
              return {
                content: `${a.name} changed files outside its subproject (${sub?.dir}/): ${outside.join(", ")}. Nothing was merged. Check those changes; merge with include_shared if they are right for every subproject, or ask ${a.name} to undo them.`,
                isError: true,
              };
          }
          const r = await mergeWorktree(root, a.id);
          if (!r.ok)
            return {
              content: `Merge conflicts in: ${r.conflicts.join(", ")}. Nothing was changed; ask ${a.name} to rebase or resolve.`,
              isError: true,
            };
          return r.merged
            ? `Merged ${a.name}'s work into the project${committed ? "" : " (nothing new to commit)"}.`
            : "Nothing to merge.";
        },
      } as Tool,
      {
        def: {
          name: "stop_agent",
          description: "Stop an agent you manage (and everything below it).",
          inputSchema: {
            type: "object",
            properties: { agent_id: { type: "string" }, reason: { type: "string" } },
            required: ["agent_id", "reason"],
          },
        },
        schema: z.object({ agent_id: z.string(), reason: z.string().min(1) }),
        async run({ agent_id, reason }) {
          const stopped = await host.registry.stop(me, target(agent_id).id, reason);
          return `Stopped: ${stopped.join(", ")}`;
        },
      } as Tool,
    );
  }

  if (self.kind === "agent") {
    tools.push({
      def: {
        name: "run_subagent",
        description:
          "Run a short-lived sub-agent with a fresh, isolated context on one task, in your worktree. Returns its report; the sub-agent is then stopped.",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" }, task: { type: "string" } },
          required: ["title", "task"],
        },
      },
      schema: z.object({ title: z.string().min(1), task: z.string().min(1) }),
      async run({ title, task }, ctx: ToolContext) {
        const sub = await host.registry.create(me, {
          kind: "subagent",
          parentId: self.id,
          name: `${self.name} › ${title}`.slice(0, 80),
        });
        let sid: string | undefined;
        try {
          sid = await host.startSession(self.ownerId, sub.id);
          return await delegate(sub, title, task, sid, ctx);
        } finally {
          // Its background commands end with its work.
          if (sid) await host.stopCommands?.(sid).catch(() => {});
          await host.registry.stop(me, sub.id, "sub-agent task finished");
        }
      },
    } as Tool);

    // G29.7: several sub-agents at once, each with its own conversation and worktree; their
    // work comes back into this agent's worktree one by one, conflicts reported, not forced.
    if (host.isolate) {
      const Many = z.object({
        tasks: z
          .array(z.object({ title: z.string().min(1), task: z.string().min(1) }))
          .min(1)
          .max(6),
      });
      tools.push({
        def: {
          name: "run_subagents",
          description:
            "Run up to 6 sub-agents in parallel, each on one independent task, with a fresh context and its own copy of your worktree (they cannot step on each other). When all are done their changes are merged into your worktree one by one; conflicts are reported and left on the sub-agent's branch. Returns every report.",
          inputSchema: {
            type: "object",
            properties: {
              tasks: {
                type: "array",
                items: {
                  type: "object",
                  properties: { title: { type: "string" }, task: { type: "string" } },
                  required: ["title", "task"],
                },
              },
            },
            required: ["tasks"],
          },
        },
        schema: Many,
        async run({ tasks: list }: z.infer<typeof Many>, ctx: ToolContext) {
          const { root, worktree } = await host.projectWorkspaces(self);
          const mine = await worktree(self.id);
          // What this agent has so far is where every sub-agent starts from.
          await commitAll(
            mine,
            "Work in progress, before sub-agents",
            `${self.name} <${self.id}@redgiant>`,
          );
          const subs: AgentRecord[] = [];
          try {
            for (const t of list) {
              const sub = await host.registry.create(me, {
                kind: "subagent",
                parentId: self.id,
                name: `${self.name} › ${t.title}`.slice(0, 80),
              });
              host.isolate?.(sub.id);
              subs.push(sub);
            }
            const reports = await Promise.all(
              subs.map(async (sub, i) => {
                const t = list[i] as { title: string; task: string };
                let sid: string | undefined;
                try {
                  sid = await host.startSession(self.ownerId, sub.id);
                  return await delegate(sub, t.title, t.task, sid, ctx, "run_subagents");
                } catch (err) {
                  return `${sub.name} failed: ${(err as Error).message}`;
                } finally {
                  if (sid) await host.stopCommands?.(sid).catch(() => {});
                }
              }),
            );
            const merges: string[] = [];
            for (const sub of subs) {
              try {
                // A sub-agent that never got its worktree did no work: making one now would
                // branch from the main line and merge it into this agent's work unasked.
                if (!(await root.exists(`${worktreeDir(sub.id)}/.git`))) {
                  merges.push(`${sub.name}: no work to merge`);
                  continue;
                }
                const ws = await worktree(sub.id);
                await commitAll(ws, `${sub.name}`, `${sub.name} <${sub.id}@redgiant>`);
                const r = await mergeWorktree(mine, sub.id);
                if (r.ok) {
                  await removeWorktree(root, sub.id, true).catch(() => {});
                  merges.push(`${sub.name}: ${r.merged ? "merged" : "no changes"}`);
                } else
                  merges.push(
                    `${sub.name}: conflicts in ${r.conflicts.join(", ")}; its work is on branch ${worktreeBranch(sub.id)}`,
                  );
              } catch (err) {
                merges.push(`${sub.name}: not merged (${(err as Error).message})`);
              }
            }
            return [...reports, `Merged into your worktree:\n${merges.join("\n")}`].join(
              "\n\n---\n\n",
            );
          } finally {
            for (const sub of subs)
              await host.registry.stop(me, sub.id, "sub-agent task finished").catch(() => {});
          }
        },
      } as Tool);
    }
  }

  return tools;
}

/** `complete_task`, for agents that receive tasks; runs the verifier in their workspace. */
export function completeTaskTool(
  self: AgentRecord,
  ws: Workspace | undefined,
  broker: PermissionBroker,
  tasks: TaskTracker,
): Tool {
  const Input = z.object({
    task_id: z.string().optional(),
    verify_command: z.string().min(1).optional(),
    not_testable_reason: z.string().min(20).optional(),
  });
  return {
    def: {
      name: "complete_task",
      description:
        "Close your current task. Give verify_command: a shell command that exits 0 only if the result is right " +
        "(tests, build, a check of the output). Only if it truly cannot be tested, give not_testable_reason instead.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          verify_command: { type: "string" },
          not_testable_reason: { type: "string" },
        },
      },
    },
    schema: Input,
    async run(i: z.infer<typeof Input>, ctx: ToolContext) {
      const task = i.task_id ? tasks.get(i.task_id) : tasks.openFor(self.id, ctx.sessionId);
      if (!task || task.agentId !== self.id)
        return { content: "You have no open task with that id.", isError: true };
      if (task.outcome) return `Task ${task.id} is already closed (${task.outcome}).`;
      if (i.verify_command) {
        if (!ws) return { content: "You have no workspace to run a verifier in.", isError: true };
        const call = {
          callId: `verify-${task.id}`,
          name: "bash",
          input: { command: i.verify_command },
        };
        const permission = await broker.check(self, call, ctx.sessionId);
        if (!permission.allow)
          return {
            content: `The verifier was not allowed: ${permission.reason ?? "denied"}.`,
            isError: true,
          };
        const r = await ws.exec(i.verify_command, { timeoutMs: 600_000, signal: ctx.signal });
        const passed = r.exitCode === 0 && !r.timedOut;
        await tasks.verified(task, i.verify_command, passed);
        if (passed) return `Verified: \`${i.verify_command}\` exited 0. Task ${task.id} is closed.`;
        const output = `${r.stdout}\n${r.stderr}`.trim();
        return {
          content: `Verification failed (${r.timedOut ? "timed out" : `exit ${r.exitCode}`}). Fix the problem and try again.\n${clip(output, 3000)}`,
          isError: true,
        };
      }
      if (i.not_testable_reason) {
        await tasks.close(task, { outcome: "not_testable", justification: i.not_testable_reason });
        return `Task ${task.id} closed as not testable. Your reason is recorded in the log.`;
      }
      return {
        content: "Give verify_command, or not_testable_reason (at least 20 characters).",
        isError: true,
      };
    },
  } as Tool;
}

const APPROVER_INSTRUCTIONS =
  "An agent below you asks permission for an action. Decide as its supervisor: allow what serves the task " +
  "and is safe for the project, deny what is clearly wrong, escalate when you are unsure or it goes beyond " +
  "your responsibility. Answer with exactly one word: ALLOW, DENY or ESCALATE.";

/**
 * A parent decides with its own model, in a separate request (its conversation is not
 * touched). Anything but a clear ALLOW or DENY escalates.
 */
export function modelApprover(o: {
  registry: AgentRegistry;
  providers: ProviderRegistry;
  budget: PersistentBudget;
  defaultModel?: ModelSpec;
  systemFor: (a: AgentRecord) => string;
}): (approver: AgentRecord, request: ApprovalRequest) => Promise<AgentAnswer> {
  return async (approver, req) => {
    const model = o.registry.effectiveModel(approver.id) ?? o.defaultModel;
    if (!model) return "escalate";
    const input = JSON.stringify(req.call.input);
    const question =
      `${req.requester.name} (${req.requester.kind}) wants to run ${req.call.name} with:\n${input.length > 2000 ? `${input.slice(0, 2000)}…` : input}\n` +
      `Why it needs approval: ${req.reasons.join("; ") || "policy"}.${req.danger.length ? ` Danger: ${req.danger.join(", ")}.` : ""}`;
    const c = await complete(
      streamWithFallback(o.providers, model, {
        system: `${o.systemFor(approver)}\n\n${APPROVER_INSTRUCTIONS}`,
        tools: [],
        messages: [{ role: "user", parts: [{ type: "text", text: question }] }],
        maxTokens: 2000,
      }),
    );
    const usd = costUsd(c.usage, o.providers.get(c.provider).modelInfo(c.model).pricing);
    await o.budget.record(budgetKeys(approver, o.registry.resolve), c.usage, usd, {
      ownerId: approver.ownerId,
      projectId: approver.projectId,
      agentId: approver.id,
    });
    const text = c.message.parts
      .flatMap((p) => (p.type === "text" ? [p.text] : []))
      .join(" ")
      .toUpperCase();
    const word = text.match(/\b(ALLOW|DENY|ESCALATE)\b/)?.[1];
    return word === "ALLOW" ? "allow" : word === "DENY" ? "deny" : "escalate";
  };
}

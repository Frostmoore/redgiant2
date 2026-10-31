import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage, Event } from "@redgiant/protocol";
import type { CompletionRequest, FakeTurn } from "@redgiant/providers";
import { HostSandboxProvider, type SandboxProvider } from "@redgiant/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, wsClient } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

/** Cross-platform verifier: exits 0 only if the file exists. */
const exists = (path: string) => `node -e "require('fs').accessSync('${path}')"`;

const textOf = (m: ChatMessage | undefined) =>
  m?.parts
    .flatMap((p) => (p.type === "text" ? [p.text] : p.type === "tool_result" ? [p.content] : []))
    .join("\n") ?? "";

/** Tool results since the last plain user message: how far the agent got in this turn. */
function step(req: CompletionRequest): { n: number; results: string[] } {
  const results: string[] = [];
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role !== "user") continue;
    if (m.parts.every((p) => p.type === "tool_result")) results.unshift(textOf(m));
    else break;
  }
  return { n: results.length, results };
}
const idIn = (text: string, kind: string) =>
  text.match(new RegExp(`\\((${kind}_[0-9a-f]+)\\)`))?.[1] ?? "";
const call = (name: string, input: unknown): FakeTurn => ({ toolCalls: [{ name, input }] });
const role = (req: CompletionRequest) =>
  req.system.includes("Answer with exactly one word")
    ? "approver"
    : req.system.startsWith("You are God")
      ? "god"
      : req.system.startsWith("You are the orchestrator")
        ? "orchestrator"
        : req.system.startsWith("You are a coding agent")
          ? "agent"
          : "subagent";

describe("orchestration", () => {
  it("runs God → orchestrator → agent → sub-agent, every level closing its task with a verifier", async () => {
    s = await startServer((req) => {
      const { n, results } = step(req);
      const last = results.at(-1) ?? "";
      switch (role(req)) {
        case "god":
          if (n === 0) return call("create_project", { name: "Hello" });
          if (n === 1)
            return call("create_agent", {
              kind: "orchestrator",
              name: "Orch",
              role: "Runs Hello",
              project_id: "hello",
            });
          if (n === 2)
            return call("delegate", {
              agent_id: idIn(last, "orchestrator"),
              title: "Greeting",
              task: "Produce greeting.txt",
            });
          return { text: `Done. ${last.split("\n")[0]}` };
        case "orchestrator": {
          const coder = idIn(results[0] ?? "", "agent");
          if (n === 0)
            return call("create_agent", { kind: "agent", name: "Coder", role: "Writes files" });
          if (n === 1)
            return call("delegate", {
              agent_id: coder,
              title: "Write greeting",
              task: "Write greeting.txt",
            });
          if (n === 2)
            return call("complete_task", {
              verify_command: exists(`.worktrees/${coder}/greeting.txt`),
            });
          return { text: "The coder wrote greeting.txt; verified." };
        }
        case "agent":
          if (n === 0)
            return call("run_subagent", {
              title: "write file",
              task: "Create greeting.txt with Hello",
            });
          if (n === 1) return call("complete_task", { verify_command: exists("greeting.txt") });
          return { text: "greeting.txt is there." };
        default:
          if (n === 0) return call("write_file", { path: "greeting.txt", content: "Hello\n" });
          if (n === 1) return call("complete_task", { verify_command: exists("greeting.txt") });
          return { text: "Wrote greeting.txt." };
      }
    });
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const { body } = await s.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: god.body.id,
    });
    const c = await wsClient(s.url);
    c.send({ type: "session.follow", sessionId: body.sessionId });
    await c.waitFor("session.synced");
    c.send({ type: "session.send", sessionId: body.sessionId, text: "Build the Hello project" });
    const final = await c.waitFor(
      "event",
      (m) => m.event.type === "message.assistant" && m.event.payload?.stopReason === "end_turn",
      25_000,
    );
    c.close();

    expect(final.event.type === "message.assistant" && final.event.payload?.parts).toEqual([
      { type: "text", text: expect.stringMatching(/^Done\. Task task_[0-9a-f]+ — verified\.$/) },
    ]);
    const agents = (
      await s.api<{ id: string; kind: string; name: string; status: string }[]>(
        "GET",
        "/api/agents",
      )
    ).body;
    expect(agents.map((a) => `${a.kind}:${a.status}`)).toEqual([
      "god:active",
      "orchestrator:active",
      "agent:active",
      "subagent:stopped",
    ]);
    const coder = agents.find((a) => a.kind === "agent")?.id ?? "";
    expect(
      await readFile(
        join(s.dir, "workspaces", "me", "hello", ".worktrees", coder, "greeting.txt"),
        "utf8",
      ),
    ).toBe("Hello\n");

    const events = await s.core.store.list();
    const of = (t: Event["type"]) => events.filter((e) => e.type === t);
    expect(of("task.opened")).toHaveLength(3);
    expect(of("task.verified").map((e) => (e.payload as { passed: boolean }).passed)).toEqual([
      true,
      true,
      true,
    ]);
    expect(of("task.closed").map((e) => (e.payload as { outcome: string }).outcome)).toEqual([
      "verified",
      "verified",
      "verified",
    ]);
    expect((await s.core.store.verify()).ok).toBe(true);
  });

  it("reminds an agent that stops with an open task, and requires a passing verifier", async () => {
    s = await startServer((req) => {
      const { n } = step(req);
      const lastText = [...req.messages]
        .reverse()
        .find((m) => m.role === "user" && m.parts.some((p) => p.type === "text"));
      if (textOf(lastText).includes("is still open")) {
        // Reminded: first a failing verifier, then fix and pass.
        if (n === 0) return call("complete_task", { verify_command: exists("out.txt") });
        if (n === 1) return call("write_file", { path: "out.txt", content: "ok" });
        if (n === 2) return call("complete_task", { verify_command: exists("out.txt") });
        return { text: "Fixed and verified." };
      }
      return { text: "I think it is done." };
    });
    const { core } = s;
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    await s.api("POST", "/api/projects", { name: "P" });
    const orch = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "orchestrator",
      parentId: god.body.id,
      projectId: "p",
      name: "O",
    });
    const agent = core.registry.get(
      (
        await s.api<{ id: string }>("POST", "/api/agents", {
          kind: "agent",
          parentId: orch.body.id,
          name: "A",
        })
      ).body.id,
    );
    if (!agent) throw new Error("no agent");
    const sid = await core.workSession(agent);
    const task = await core.tasks.open(agent, sid, "Produce out.txt");
    const { done } = await core.send("me", sid, `[Task ${task.id}] produce out.txt`);
    await done;
    const events = await core.store.list({ sessionId: sid });
    expect(
      events
        .filter((e) => e.type === "message.user")
        .map((e) => (e.payload as { text: string }).text),
    ).toEqual([`[Task ${task.id}] produce out.txt`, expect.stringMatching(/is still open/)]);
    expect(
      events
        .filter((e) => e.type === "task.verified")
        .map((e) => (e.payload as { passed: boolean }).passed),
    ).toEqual([false, true]);
    expect(core.tasks.get(task.id)?.outcome).toBe("verified");
  });

  it("records a task as abandoned after three ignored reminders, and accepts justified 'not testable'", async () => {
    s = await startServer((req) => {
      const last = textOf(req.messages.at(-1));
      if (last.includes("design note")) {
        return step(req).n === 0
          ? call("complete_task", {
              not_testable_reason: "A design note is judged by reading it, not by a command.",
            })
          : { text: "Closed." };
      }
      return { text: "Done, trust me." };
    });
    const { core } = s;
    const god = core.registry.get(
      (
        await s.api<{ id: string }>("POST", "/api/agents", {
          kind: "god",
          parentId: null,
          name: "God",
        })
      ).body.id,
    );
    await s.api("POST", "/api/projects", { name: "P" });
    const orch = core.registry.get(
      (
        await s.api<{ id: string }>("POST", "/api/agents", {
          kind: "orchestrator",
          parentId: god?.id,
          projectId: "p",
          name: "O",
        })
      ).body.id,
    );
    if (!orch) throw new Error("no orchestrator");
    const sid = await core.workSession(orch);
    const lazy = await core.tasks.open(orch, sid, "Do something");
    await (await core.send("me", sid, "do something")).done;
    expect(core.tasks.get(lazy.id)?.outcome).toBe("abandoned");
    const reminders =
      (await core.store.list({ sessionId: sid })).filter((e) => e.type === "message.user").length -
      1;
    expect(reminders).toBe(3);

    const note = await core.tasks.open(orch, sid, "Write a design note");
    await (await core.send("me", sid, "write the design note")).done;
    expect(core.tasks.get(note.id)?.outcome).toBe("not_testable");
    const closed = (await core.store.list({ sessionId: sid }))
      .filter((e) => e.type === "task.closed")
      .at(-1);
    expect(closed?.payload).toMatchObject({
      outcome: "not_testable",
      justification: expect.stringMatching(/judged by reading/),
    });
  });

  it("lets parents decide with their model, escalating when unsure", async () => {
    const answers: Record<string, string> = {
      "hello.txt": "ALLOW",
      "secret.txt": "I would rather DENY this.",
      "maybe.txt": "Hmm, not sure.",
    };
    s = await startServer(
      (req) => {
        if (role(req) === "approver") {
          const q = textOf(req.messages.at(-1));
          if (req.system.startsWith("You are God")) return { text: "ESCALATE" };
          const file = Object.keys(answers).find((f) => q.includes(f)) ?? "";
          return { text: answers[file] ?? "ESCALATE" };
        }
        const file = textOf(req.messages.find((m) => m.role === "user")).trim();
        return step(req).n === 0
          ? call("write_file", { path: file, content: "x" })
          : { text: "ok" };
      },
      {},
      { askAgent: undefined },
    );
    const { core } = s;
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    await s.api("POST", "/api/projects", { name: "P" });
    const orch = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "orchestrator",
      parentId: god.body.id,
      projectId: "p",
      name: "O",
    });
    const agent = (
      await s.api<{ id: string }>("POST", "/api/agents", {
        kind: "agent",
        parentId: orch.body.id,
        name: "A",
        mode: "manual",
      })
    ).body.id;
    const human: string[] = [];
    core.approvals.on("request", (_o, info) => {
      human.push(String((info.input as { path: string }).path));
      core.approvals.decide("me", info.requestId, "deny");
    });
    const run = async (file: string) => {
      const sid = await core.startSession("me", agent);
      await (await core.send("me", sid, file)).done;
      return (await core.store.list({ sessionId: sid }))
        .filter((e) => e.type === "permission.resolved")
        .map((e) => {
          const p = e.payload as { by: string; decision: string };
          return `${p.by === "human" ? "human" : core.registry.get(p.by)?.kind}:${p.decision}`;
        });
    };
    expect(await run("hello.txt")).toEqual(["orchestrator:allow"]);
    expect(await run("secret.txt")).toEqual(["orchestrator:deny"]);
    expect(await run("maybe.txt")).toEqual(["orchestrator:escalate", "god:escalate", "human:deny"]);
    expect(human).toEqual(["maybe.txt"]);
    // The orchestrator's approvals are paid from its own budget.
    expect((await core.budget.used({ scope: "agent", id: orch.body.id })).tokens).toBeGreaterThan(
      0,
    );
  });

  it("merges an agent's worktree into the project, and shares one sandbox per project", async () => {
    let creates = 0;
    const host = new HostSandboxProvider();
    const counting: SandboxProvider = {
      kind: "host",
      create: (spec) => {
        creates++;
        return host.create(spec);
      },
    };
    s = await startServer(
      (req) => {
        const { n, results } = step(req);
        if (role(req) === "orchestrator") {
          const coder = idIn(results[0] ?? "", "agent");
          if (n === 0)
            return call("create_agent", { kind: "agent", name: "Coder", role: "Writes files" });
          if (n === 1)
            return call("delegate", { agent_id: coder, title: "notes", task: "write notes.md" });
          if (n === 2) return call("merge_work", { agent_id: coder, message: "Add notes" });
          if (n === 3) return call("complete_task", { verify_command: exists("notes.md") });
          return { text: "Merged and verified." };
        }
        if (n === 0) return call("write_file", { path: "notes.md", content: "# Notes\n" });
        if (n === 1) return call("complete_task", { verify_command: exists("notes.md") });
        return { text: "Written." };
      },
      {},
      { sandbox: counting },
    );
    const { core } = s;
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    await s.api("POST", "/api/projects", { name: "Merge" });
    const orch = core.registry.get(
      (
        await s.api<{ id: string }>("POST", "/api/agents", {
          kind: "orchestrator",
          parentId: god.body.id,
          projectId: "merge",
          name: "O",
        })
      ).body.id,
    );
    if (!orch) throw new Error("no orchestrator");
    const sid = await core.workSession(orch);
    const task = await core.tasks.open(orch, sid, "Notes in the project");
    await (await core.send("me", sid, "Get notes.md into the project")).done;
    expect(core.tasks.get(task.id)?.outcome).toBe("verified");
    expect(await readFile(join(s.dir, "workspaces", "me", "merge", "notes.md"), "utf8")).toBe(
      "# Notes\n",
    );
    const results = (await core.store.list({ sessionId: sid }))
      .filter((e) => e.type === "tool.result")
      .map((e) => (e.payload as { output: string }).output);
    expect(results).toContainEqual("Merged Coder's work into the project.");
    // Orchestrator and agent work in the same project: one sandbox, not one per session.
    expect(creates).toBe(1);
  });

  it("keeps delegation inside the hierarchy", async () => {
    s = await startServer((req) => {
      const { n, results } = step(req);
      if (n === 0)
        return call("delegate", {
          agent_id: textOf(req.messages.at(-1)).trim(),
          title: "x",
          task: "y",
        });
      return { text: results[0] ?? "" };
    });
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    await s.api("POST", "/api/projects", { name: "P1" });
    await s.api("POST", "/api/projects", { name: "P2" });
    const o1 = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "orchestrator",
      parentId: god.body.id,
      projectId: "p1",
      name: "O1",
    });
    const o2 = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "orchestrator",
      parentId: god.body.id,
      projectId: "p2",
      name: "O2",
    });
    const foreign = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "agent",
      parentId: o2.body.id,
      name: "Theirs",
    });
    const sid = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: o1.body.id })
    ).body.sessionId;
    await (await s.core.send("me", sid, foreign.body.id)).done;
    const result = (await s.core.store.list({ sessionId: sid })).find(
      (e) => e.type === "tool.result",
    );
    expect(result?.payload).toMatchObject({
      ok: false,
      output: "Tool failed: You cannot assign work to Theirs",
    });
  });
});

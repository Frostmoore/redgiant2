import type { ChatMessage } from "@redgiant/protocol";
import type { CompletionRequest, FakeTurn } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  const server = s;
  s = undefined;
  await server?.close();
}, 60_000);

const exists = (path: string) => `node -e "require('fs').accessSync('${path}')"`;
const textOf = (m: ChatMessage | undefined) =>
  m?.parts
    .flatMap((p) => (p.type === "text" ? [p.text] : p.type === "tool_result" ? [p.content] : []))
    .join("\n") ?? "";
const call = (name: string, input: unknown): FakeTurn => ({ toolCalls: [{ name, input }] });
/** Tool results since the last plain user message. */
const done = (req: CompletionRequest) => {
  let n = 0;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role === "user" && m.parts.every((p) => p.type === "tool_result")) n++;
    else if (m?.role === "user") break;
  }
  return n;
};

async function coder(server: Server) {
  await server.api("POST", "/api/projects", { name: "Backup" });
  const god = await server.api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: "God",
  });
  const orch = await server.api<{ id: string }>("POST", "/api/agents", {
    kind: "orchestrator",
    parentId: god.body.id,
    projectId: "backup",
    name: "O",
  });
  const agent = await server.api<{ id: string }>("POST", "/api/agents", {
    kind: "agent",
    parentId: orch.body.id,
    name: "Coder",
  });
  return agent.body.id;
}

describe("the backup model for tasks (2026-11-05)", () => {
  it("takes over a task the first model gave up on, in a new conversation, and its report counts", async () => {
    const backupSaw: string[] = [];
    let report = "";
    s = await startServer((req) => {
      const sub = !req.system.startsWith("You are a coding agent");
      if (!sub) {
        const last = textOf(req.messages.at(-1));
        if (done(req) === 0)
          return call("run_subagent", { title: "hello", task: "Create hello.txt with Hi" });
        report = last;
        return { text: "Done." };
      }
      // The first model never verifies its work: reminded three times, then given up on.
      if (req.model === "m") return { text: "I think it is fine." };
      backupSaw.push(textOf(req.messages[0]));
      const id = textOf(req.messages[0]).match(/taskId "(task_[0-9a-f]+)"/)?.[1];
      if (done(req) === 0) return call("write_file", { path: "hello.txt", content: "Hi\n" });
      if (done(req) === 1)
        return call("complete_task", { task_id: id, verify_command: exists("hello.txt") });
      return { text: "hello.txt written and checked." };
    });
    const agentId = await coder(s);
    s.core.setBackupModel({ provider: "fake", model: "m2" });
    const sid = (await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId })).body
      .sessionId;
    await (await s.core.send("me", sid, "go")).done;

    expect(report).toMatch(/— verified \(by the backup model, after the first one gave up\)/);
    expect(report).toContain("hello.txt written and checked.");
    // The backup model knew the task and what the first attempt said.
    expect(backupSaw[0]).toContain("Create hello.txt with Hi");
    expect(backupSaw[0]).toMatch(/<previous_attempt model="fake\/m">/);
    expect(backupSaw[0]).toContain("I think it is fine.");
    // In the log: the first task abandoned, the second opened from it and verified.
    const events = await s.core.store.list({ types: ["task.opened", "task.closed"] });
    const opened = events.filter((e) => e.type === "task.opened");
    const closed = events.flatMap((e) =>
      e.type === "task.closed" ? [(e.payload as { outcome: string }).outcome] : [],
    );
    expect(closed).toEqual(["abandoned", "verified"]);
    const [first, second] = opened.map(
      (e) => e.payload as { taskId: string; escalatedFrom?: string },
    );
    expect(second?.escalatedFrom).toBe(first?.taskId);
    // A new conversation, with the backup model: the first one's cache was never touched.
    expect(opened[1]?.sessionId).not.toBe(opened[0]?.sessionId);
  }, 60_000);

  it("leaves a task given up on as it is without a backup model, or when it is the same model", async () => {
    let report = "";
    s = await startServer((req) => {
      if (req.system.startsWith("You are a coding agent")) {
        if (done(req) === 0) return call("run_subagent", { title: "x", task: "Do x" });
        report = textOf(req.messages.at(-1));
        return { text: "Done." };
      }
      return { text: "Fine." };
    });
    const agentId = await coder(s);
    s.core.setBackupModel({ provider: "fake", model: "m" });
    const sid = (await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId })).body
      .sessionId;
    await (await s.core.send("me", sid, "go")).done;
    expect(report).toMatch(/— abandoned\./);
    const opened = await s.core.store.list({ types: ["task.opened"] });
    expect(opened).toHaveLength(1);
  }, 60_000);
});

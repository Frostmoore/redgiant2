import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompletionRequest } from "@redgiant/providers";
import { commitAll, ensureRepo } from "@redgiant/sandbox";
import { LocalWorkspace } from "@redgiant/tools";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatEntry } from "../src/index.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const results = (req: CompletionRequest) =>
  req.messages.flatMap((m) =>
    m.parts.flatMap((p) => (p.type === "tool_result" ? [p.content] : [])),
  );
const lastText = (req: CompletionRequest) => {
  const m = [...req.messages]
    .reverse()
    .find((x) => x.role === "user" && x.parts.some((p) => p.type === "text"));
  const p = m?.parts.find((x) => x.type === "text");
  return p?.type === "text" ? p.text : "";
};

/** The inspector reads git, the board, a file and the tasks; God asks it a question. */
const brain = (seen: CompletionRequest[]) => (req: CompletionRequest) => {
  seen.push(req);
  if (req.system.startsWith("You are the inspector")) {
    if (results(req).length === 0)
      return {
        toolCalls: [
          { name: "git_log", input: {} },
          { name: "project_board", input: {} },
          { name: "read_file", input: { path: "NOTES.md" } },
          { name: "project_tasks", input: {} },
        ],
      };
    return { text: `INSPECTOR: ${results(req).join(" | ").replace(/\s+/g, " ").slice(0, 2000)}` };
  }
  if (req.system.startsWith("You are God")) {
    const r = results(req);
    return r.length === 0
      ? {
          toolCalls: [
            { name: "ask_inspector", input: { project_id: "shop", question: "How is it going?" } },
          ],
        }
      : { text: `God heard: ${r[0]?.slice(0, 200)}` };
  }
  return { text: lastText(req) };
};

async function setup() {
  const seen: CompletionRequest[] = [];
  s = await startServer(brain(seen));
  const core = s.core;
  const project = await core.projects.create("me", "Shop");
  const ws = new LocalWorkspace(project.path);
  await ensureRepo(ws);
  await writeFile(join(project.path, "NOTES.md"), "Checkout is done; payments are next.");
  await commitAll(ws, "Add the checkout notes");
  await core.board.createThread({
    ownerId: "me",
    projectId: "shop",
    title: "Payments",
    first: {
      author: "human",
      kind: "blocker",
      body: "We need the API key of the payment provider.",
    },
  });
  await core.store.append({
    ownerId: "me",
    projectId: "shop",
    agentId: "agent_x",
    body: { type: "task.opened", payload: { taskId: "task_1", title: "Build the checkout" } },
  });
  await core.store.append({
    ownerId: "me",
    projectId: "shop",
    agentId: "agent_x",
    body: { type: "task.closed", payload: { taskId: "task_1", outcome: "verified" } },
  });
  return { seen, core };
}

describe("the project inspector", () => {
  it("reads files, git, the board and the tasks, and has nothing that writes", async () => {
    const { seen } = await setup();
    const api = (s as Server).api;
    const chat = (
      await api<{ id: string; kind: string }>("POST", "/api/projects/shop/inspector/chats")
    ).body;
    expect(chat.kind).toBe("inspector");
    const r = await fetch(`${s?.url}/api/chats/${chat.id}/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token-0123456789",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "Where are we?" }),
    });
    await r.text();
    const entries = (await api<ChatEntry[]>("GET", `/api/chats/${chat.id}`)).body;
    const answer = entries.at(-1)?.message.parts.find((p) => p.type === "text");
    const text = answer?.type === "text" ? answer.text : "";
    expect(text).toContain("Add the checkout notes"); // git
    expect(text).toMatch(/\[blocked\] "Payments"/); // board
    expect(text).toContain("Checkout is done; payments are next."); // the file
    expect(text).toMatch(/task_1: opened "Build the checkout".*closed: verified/); // tasks

    const req = seen.find((x) => x.system.startsWith("You are the inspector"));
    expect(req?.system).toContain('project "Shop"');
    expect(req?.tools.map((t) => t.name)).toEqual([
      "git_log",
      "git_show",
      "git_status",
      "glob",
      "grep",
      "project_activity",
      "project_board",
      "project_budget",
      "project_tasks",
      "read_file",
    ]);
    // Its chats are the project's: not in the daily chat, not in the event log.
    expect((await api<unknown[]>("GET", "/api/chats")).body).toEqual([]);
    expect(
      (await api<{ id: string }[]>("GET", "/api/projects/shop/inspector/chats")).body.map(
        (c) => c.id,
      ),
    ).toEqual([chat.id]);
    const logged = await (s as Server).core.store.list({});
    expect(JSON.stringify(logged)).not.toContain("Where are we?");
  });

  it("answers God without asking anyone, and God gets its answer", async () => {
    const { core } = await setup();
    const asked: string[] = [];
    core.approvals.on("request", (_o, info) => asked.push(info.tool));
    const god = await (s as Server).api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const sid = await core.startSession("me", god.body.id);
    await (await core.send("me", sid, "Check the shop project")).done;
    const result = (await core.history("me", sid)).find((e) => e.type === "tool.result")
      ?.payload as {
      ok: boolean;
      output: string;
    };
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/^INSPECTOR: .*Checkout is done/);
    expect(asked).toEqual([]);
  });

  it("tells the owner about trouble and sends a daily summary, only when asked", async () => {
    const { core } = await setup();
    const notes: string[] = [];
    core.notify = async (_o, text) => {
      notes.push(text);
    };
    core.inspector.start();
    const blocker = () =>
      core.board.createThread({
        ownerId: "me",
        projectId: "shop",
        title: "Server down",
        first: { author: "agent_x", kind: "blocker", body: "The staging server does not answer." },
      });
    await blocker();
    await new Promise((r) => setTimeout(r, 50));
    expect(notes).toEqual([]); // alerts are off by default
    const now = new Date();
    await (s as Server).api("PUT", "/api/projects/shop/inspector/settings", {
      alerts: true,
      summaryHour: now.getHours(),
    });
    await blocker();
    await new Promise((r) => setTimeout(r, 50));
    expect(notes[0]).toBe("⚠️ shop: blocker on the board: The staging server does not answer.");
    await core.inspector.summaries(now);
    await core.inspector.summaries(now); // once a day
    expect(notes.filter((n) => n.startsWith("📋 shop"))).toHaveLength(1);
    expect(notes.at(-1)).toMatch(/^📋 shop\n\nINSPECTOR: /);
  });
});

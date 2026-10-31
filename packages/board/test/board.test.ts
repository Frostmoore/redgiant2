import type { ToolContext } from "@redgiant/agent";
import { EventStore, migrate } from "@redgiant/events";
import { type AgentRecord, AgentRegistry, migrateHierarchy } from "@redgiant/hierarchy";
import { FakeProvider, ProviderRegistry } from "@redgiant/providers";
import { beforeEach, describe, expect, it } from "vitest";
import { Board, BoardSummarizer, boardTools, mentionsIn, migrateBoard } from "../src/index.js";
import { memoryDb } from "./pglite.js";

let store: EventStore;
let board: Board;
let registry: AgentRegistry;
const ctx: ToolContext = { ownerId: "me", projectId: "p1", agentId: "a", sessionId: "s" };
const human = { type: "human" as const, ownerId: "me" };

beforeEach(async () => {
  const { db } = await memoryDb();
  await migrate(db);
  await migrateHierarchy(db);
  await migrateBoard(db);
  store = new EventStore(db);
  board = new Board(db, store);
  registry = new AgentRegistry(db, store);
  await registry.load();
});

async function tree() {
  const god = await registry.create(human, { kind: "god", parentId: null, name: "God" });
  const orch = await registry.create(human, {
    kind: "orchestrator",
    parentId: god.id,
    projectId: "p1",
    name: "O",
  });
  const a = await registry.create(human, { kind: "agent", parentId: orch.id, name: "A" });
  const b = await registry.create(human, { kind: "agent", parentId: orch.id, name: "B" });
  const other = await registry.create(human, {
    kind: "orchestrator",
    parentId: god.id,
    projectId: "p2",
    name: "O2",
  });
  const insp = await registry.create(human, {
    kind: "inspector",
    parentId: god.id,
    projectId: "p1",
    name: "I",
  });
  return { god, orch, a, b, other, insp };
}
const tool = (agent: AgentRecord, name: string) => {
  const t = boardTools(agent, board).find((x) => x.def.name === name);
  if (!t) throw new Error(`${agent.kind} has no ${name}`);
  return (input: unknown) => t.run(input, ctx).then((o) => (typeof o === "string" ? o : o.content));
};

describe("Board", () => {
  it("keeps threads and posts, logs every post, finds mentions", async () => {
    const { thread } = await board.createThread({
      ownerId: "me",
      projectId: "p1",
      title: "API format",
      first: {
        author: "agent_aaaaaaaa",
        kind: "question",
        body: "JSON or YAML? cc @agent_bbbbbbbb",
      },
    });
    await board.reply("me", thread.id, {
      author: "agent_bbbbbbbb",
      kind: "decision",
      body: "JSON, with a schema.",
    });
    const posts = await board.posts("me", thread.id);
    expect(posts.map((p) => p.kind)).toEqual(["question", "decision"]);
    expect(posts[0]?.mentions).toEqual(["agent_bbbbbbbb"]);
    expect((await store.list()).filter((e) => e.type === "board.post")).toHaveLength(2);
    expect(mentionsIn("hi @god_12345678 and @agent_abcdef01.")).toEqual([
      "god_12345678",
      "agent_abcdef01",
    ]);
  });

  it("searches full text and spots likely duplicates", async () => {
    await board.createThread({
      ownerId: "me",
      projectId: "p1",
      title: "Database migrations",
      first: {
        author: "x",
        kind: "note",
        body: "We use Drizzle migrations on Postgres for the schema.",
      },
    });
    await board.createThread({
      ownerId: "me",
      projectId: "p1",
      title: "Logo colours",
      first: { author: "x", kind: "note", body: "Red accent on dark." },
    });
    expect((await board.search("me", "drizzle postgres", "all")).map((h) => h.title)).toEqual([
      "Database migrations",
    ]);
    expect((await board.search("me", "drizzle", ["p2"])).length).toBe(0);
    // Titles count too.
    expect((await board.search("me", "logo", "all")).map((h) => h.title)).toEqual(["Logo colours"]);
    const dup = await board.similar("me", "p1", "Postgres schema migrations with Drizzle");
    expect(dup.map((t) => t.title)).toEqual(["Database migrations"]);
    expect(await board.similar("me", "p1", "Weekly coffee schedule")).toEqual([]);
  });

  it("follows the tasks a thread refers to", async () => {
    const stop = board.followTasks();
    const { thread } = await board.createThread({
      ownerId: "me",
      projectId: "p1",
      title: "Ship it",
      first: { author: "o", kind: "task", body: "do it", refs: { taskId: "task_1" } },
    });
    await store.append({
      ownerId: "me",
      projectId: "p1",
      body: { type: "task.closed", payload: { taskId: "task_1", outcome: "verified" } },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect((await board.thread("me", thread.id))?.status).toBe("resolved");
    const t2 = await board.createThread({
      ownerId: "me",
      projectId: "p1",
      title: "Other",
      first: { author: "o", kind: "task", body: "x", refs: { taskId: "task_2" } },
    });
    await store.append({
      ownerId: "me",
      projectId: "p1",
      body: {
        type: "task.closed",
        payload: { taskId: "task_2", outcome: "abandoned", reason: "gave up" },
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect((await board.thread("me", t2.thread.id))?.status).toBe("blocked");
    stop();
  });

  it("summarises long threads and writes digests with the configured model", async () => {
    const fake = new FakeProvider(
      (req) => ({ text: req.system.includes("digest") ? "DIGEST" : "SUMMARY" }),
      { id: "cheap" },
    );
    const s = new BoardSummarizer(
      board,
      new ProviderRegistry().register(fake),
      { provider: "cheap", model: "m" },
      3,
    );
    const { thread } = await board.createThread({
      ownerId: "me",
      projectId: "p1",
      title: "Long",
      first: { author: "a", kind: "note", body: "one" },
    });
    expect(await s.maybeSummarize("me", thread.id)).toBeNull();
    await board.reply("me", thread.id, { author: "a", kind: "note", body: "two" });
    await board.reply("me", thread.id, { author: "a", kind: "note", body: "three" });
    expect(await s.maybeSummarize("me", thread.id)).toBe("SUMMARY");
    expect((await board.thread("me", thread.id))?.summaryUpTo).toBe(3);
    expect(await s.digest("me", "p1", "2000-01-01T00:00:00.000Z")).toBe("DIGEST");
    expect(await s.digest("me", "p2", "2000-01-01T00:00:00.000Z")).toBe("Nothing new.");
  });
});

describe("board tools", () => {
  it("give each agent its own project's board, God every board, the Inspector read-only", async () => {
    const t = await tree();
    expect(
      await tool(
        t.a,
        "board_post",
      )({ title: "Decision on the API", kind: "decision", body: "JSON over HTTP" }),
    ).toMatch(/^Opened thr_/);
    expect(await tool(t.b, "board_list")({})).toMatch(/Decision on the API/);
    expect(await tool(t.other, "board_list")({})).toBe("The board is empty.");
    expect(await tool(t.god, "board_list")({ project_id: "p1" })).toMatch(/Decision on the API/);
    await expect(tool(t.a, "board_list")({ project_id: "p2" })).rejects.toThrow(
      /only use your own project/,
    );
    expect(boardTools(t.insp, board).map((x) => x.def.name)).toEqual([
      "board_list",
      "board_read",
      "board_search",
    ]);
    expect(boardTools(t.a, board).map((x) => x.def.name)).not.toContain("board_status");
    expect(boardTools(t.orch, board).map((x) => x.def.name)).toContain("board_status");
  });

  it("refuses a duplicate thread unless forced, and keeps other projects' threads out of reach", async () => {
    const t = await tree();
    await tool(
      t.a,
      "board_post",
    )({ title: "Login page bug", kind: "blocker", body: "The login page crashes on submit" });
    const again = await tool(
      t.b,
      "board_post",
    )({ title: "Crash on login", kind: "note", body: "login page crashes when I submit" });
    expect(again).toMatch(/^Possible duplicates/);
    expect(
      await tool(
        t.b,
        "board_post",
      )({
        title: "Crash on login",
        kind: "note",
        body: "login page crashes when I submit",
        force: true,
      }),
    ).toMatch(/^Opened/);
    const id = (await board.threads("me", "p1"))[0]?.id ?? "";
    await expect(tool(t.other, "board_read")({ thread_id: id })).rejects.toThrow(/No thread/);
  });
});

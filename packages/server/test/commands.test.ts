// Background commands in the server (p3.3.1): their start and end in the conversation's log,
// the person's Stop and close (closed stays closed), their timed log for the page, a restart that
// marks the ones left running as interrupted, and the inspector reading them with the scope rules.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Event } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { reapOrphan } from "../src/background-reap.js";
import { startServer, wsClient } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
}, 30_000);

const resultOf = (req: { messages: { parts: { type: string }[] }[] }) =>
  (
    req.messages.at(-1)?.parts.find((p) => p.type === "tool_result") as
      | { content: string }
      | undefined
  )?.content;

async function god(server: Server) {
  const g = await server.api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: "God",
  });
  const { body } = await server.api<{ sessionId: string }>("POST", "/api/sessions", {
    agentId: g.body.id,
  });
  return { god: g.body.id, sessionId: body.sessionId };
}

describe.runIf(process.platform !== "win32")("background commands in the server", () => {
  it("records them, lets the person stop and close them, and serves their timed log", async () => {
    let id = "";
    const answers: string[] = [];
    s = await startServer((req) => {
      const r = resultOf(req);
      if (r === undefined)
        return {
          toolCalls: [
            {
              name: "bash",
              input: { command: "echo hello; echo oops >&2; sleep 30", background: true },
            },
          ],
        };
      answers.push(r);
      if (r.startsWith("Started")) {
        id = r.match(/as (cmd_[0-9a-f]+)/)?.[1] ?? "";
        return {
          toolCalls: [{ name: "bash_output", input: { id, wait_for: "hello", timeout_s: 10 } }],
        };
      }
      return { text: "It runs." };
    });
    const { sessionId } = await god(s);
    await (await s.core.send("me", sessionId, "Start the server")).done;
    expect(answers[1]).toMatch(/«hello» appeared/);
    expect(answers[1]).toMatch(/Started .* by God \(god /);
    const of = async (t: string) =>
      (await s?.core.store.list({ sessionId, types: [t] })) as Event[];
    const [started] = await of("command.started");
    expect(started?.payload).toMatchObject({ id, command: expect.stringContaining("echo hello") });
    // The page's view of its log.
    const out = await s.api<{
      lines: { stream: string; text: string; clock: string }[];
      running: boolean;
    }>("GET", `/api/sessions/${sessionId}/commands/${id}/output`);
    expect(out.body.running).toBe(true);
    expect(out.body.lines.map((l) => [l.stream, l.text])).toEqual([
      ["out", "hello"],
      ["err", "oops"],
    ]);
    expect(out.body.lines[0]?.clock).toMatch(/^\d\d:\d\d:\d\d\.\d{3}$/);
    // Running: it cannot be closed, only stopped (no confirmation).
    await expect(s.core.closeCommand("me", sessionId, id)).rejects.toThrow(/still running/);
    const c = await wsClient(s.url);
    c.send({ type: "command.stop", sessionId, id });
    await expect.poll(async () => (await of("command.ended")).length, { timeout: 8000 }).toBe(1);
    expect((await of("command.ended"))[0]?.payload).toMatchObject({ id, status: "stopped" });
    c.send({ type: "command.close", sessionId, id });
    await expect.poll(async () => (await of("command.closed")).length).toBe(1);
    await s.core.closeCommand("me", sessionId, id);
    c.close();
    expect(await of("command.closed")).toHaveLength(1);
  });

  it("marks the ones a previous run left running as interrupted, stopping what is still theirs", async () => {
    s = await startServer(() => ({ text: "ok" }));
    const { god: agentId, sessionId } = await god(s);
    await s.core.store.append({
      ownerId: "me",
      agentId,
      sessionId,
      body: {
        type: "command.started",
        payload: {
          id: "cmd_old",
          command: "npm run dev",
          file: "/nope.log",
          path: "x",
          cwd: "/",
          by: "God",
          pid: 999_999,
        },
      },
    });
    const looked: number[] = [];
    await s.core.reapCommands({
      platform: "darwin",
      startTime: async (pid) => {
        looked.push(pid);
        return undefined;
      },
    });
    expect(looked).toEqual([999_999]);
    const ended = await s.core.store.list({ sessionId, types: ["command.ended"] });
    expect(ended.map((e) => e.payload)).toEqual([
      { id: "cmd_old", status: "interrupted", exitCode: null },
    ]);
    // Once only.
    await s.core.reapCommands({ platform: "darwin", startTime: async () => undefined });
    expect(await s.core.store.list({ sessionId, types: ["command.ended"] })).toHaveLength(1);
  });

  it("stops an orphan only when it is still the same process", async () => {
    const killed: number[] = [];
    const at = "2026-11-07T10:00:00.000Z";
    const deps = (started: number | undefined) => ({
      platform: "win32" as const,
      startTime: async () => started,
      kill: (pid: number) => void killed.push(pid),
    });
    expect(await reapOrphan({ id: "a", pid: 10, startedAt: at }, deps(Date.parse(at) + 300))).toBe(
      true,
    );
    expect(
      await reapOrphan({ id: "b", pid: 11, startedAt: at }, deps(Date.parse(at) + 3_600_000)),
    ).toBe(false);
    expect(await reapOrphan({ id: "c", pid: 12, startedAt: at }, deps(undefined))).toBe(false);
    expect(killed).toEqual([10]);
  });

  it("lets a project's inspector read its agents' commands, and only theirs", async () => {
    s = await startServer(() => ({ text: "ok" }));
    await s.api("POST", "/api/projects", { name: "Alpha" });
    await s.api("POST", "/api/projects", { name: "Beta" });
    const { god: parentId } = await god(s);
    const mk = async (projectId: string, name: string) =>
      (
        await s?.core.registry.create(
          { type: "human", ownerId: "me" },
          { kind: "orchestrator", parentId, projectId, name },
        )
      )?.id as string;
    const alpha = await mk("alpha", "Orch A");
    const beta = await mk("beta", "Orch B");
    const log = join(s.dir, "cmd_a.log");
    await mkdir(s.dir, { recursive: true });
    await writeFile(
      log,
      "# command  cmd_a\n# started  2026-11-07 15:03:12.000 +01:00\n# run      npm test\n[15:03:13.000 +1.000s] out  ok 1\n[15:03:20.000 +8.000s] err  Error: boom\n",
    );
    for (const [agentId, id, projectId] of [
      [alpha, "cmd_a", "alpha"],
      [beta, "cmd_b", "beta"],
    ] as const)
      await s.core.store.append({
        ownerId: "me",
        projectId,
        agentId,
        sessionId: `sess_${id}`,
        body: {
          type: "command.started",
          payload: { id, command: "npm test", file: log, path: "x", cwd: "/p", by: "Orch" },
        },
      });
    const list = await s.core.inspector.commands("me", "alpha", {});
    expect(list).toContain("cmd_a");
    expect(list).not.toContain("cmd_b");
    const one = await s.core.inspector.commands("me", "alpha", {
      id: "cmd_a",
      stream: "err",
      summary: true,
    });
    expect(one).toMatch(/2 {2}\[15:03:20\.000 \+8\.000s\] err {2}Error: boom/);
    expect(one).toMatch(/1 look like errors/);
    expect(one).not.toMatch(/ok 1/);
    expect(await s.core.inspector.commands("me", "alpha", { id: "cmd_b" })).toMatch(
      /no background command/,
    );
    // The inspector's chat has the tool.
    const profile = await s.core.inspector.profile("me", "alpha");
    expect(profile.tools.map((t) => t.def.name)).toContain("project_commands");
  });
});

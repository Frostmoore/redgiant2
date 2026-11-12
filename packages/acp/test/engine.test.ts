import type { EngineTurn } from "@redgiant/agent";
import { describe, expect, it } from "vitest";
import { AcpEngine, type AcpWorkerHost, insideFolder, type MappedCall } from "../src/index.js";
import { type FakeAgent, fakeAgent } from "./fake-agent.js";

function harness(
  o: { loadSession?: boolean; allow?: (c: MappedCall, ask: boolean) => boolean } = {},
) {
  const agent = fakeAgent({ loadSession: o.loadSession ?? false });
  const files = new Map<string, string>([["src/a.ts", "one\ntwo\nthree\nfour"]]);
  const permits: { call: MappedCall; ask: boolean }[] = [];
  const runs: { file: string; args: string[]; cwd: string }[] = [];
  let launches = 0;
  const host: AcpWorkerHost = {
    launch: async () => {
      launches++;
      return agent.process;
    },
    readText: async (rel) => {
      const v = files.get(rel);
      if (v === undefined) throw new Error("no such file");
      return v;
    },
    writeText: async (rel, content) => {
      files.set(rel, content);
    },
    permit: async (call, { ask }) => {
      permits.push({ call, ask });
      const yes = o.allow ? o.allow(call, ask) : !ask;
      return yes ? { allow: true } : { allow: false, reason: "the person said no" };
    },
    run: async (file, args, { cwd, onOutput }) => {
      runs.push({ file, args, cwd });
      onOutput(`ran ${file} ${args.join(" ")}\n`);
      return { exitCode: 0 };
    },
  };
  const engine = new AcpEngine({ name: "Claude Code", host, idleMs: Number.POSITIVE_INFINITY });
  return { agent, files, permits, runs, host, engine, launches: () => launches };
}

/** One engine turn with collectors, as `AgentSession` would run it. */
function turnOf(
  text: string,
  o: {
    resume?: string;
    signal?: AbortSignal;
    tools?: string[];
    runTool?: EngineTurn["runTool"];
  } = {},
) {
  const log: string[] = [];
  const deltas: string[] = [];
  const t: EngineTurn = {
    text,
    images: [],
    system: "RedGiant's system prompt",
    tools: (o.tools ?? []).map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object" },
    })),
    model: { provider: "acp", model: "Claude Code" },
    resume: o.resume,
    signal: o.signal,
    runTool:
      o.runTool ??
      (async (c) => {
        log.push(`run ${c.name} ${JSON.stringify(c.input)}`);
        return { content: "done", isError: false };
      }),
    onMessage: async (m) => {
      log.push(
        `message ${m.parts.map((p) => `${p.type}:${"text" in p ? p.text : ""}`).join(" | ")}`,
      );
    },
    onExternalTool: async (c) => {
      log.push(`tool ${c.callId} ${c.name} ${JSON.stringify(c.input)}`);
    },
    onExternalResult: async (r) => {
      log.push(`result ${r.callId} ${r.ok} ${r.output}`);
    },
    live: (e) => {
      if (e.type === "text_delta" || e.type === "thinking_delta")
        deltas.push(`${e.type}:${e.text}`);
    },
  };
  return { t, log, deltas };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
async function until(f: () => boolean) {
  for (let i = 0; i < 200 && !f(); i++) await tick();
  expect(f()).toBe(true);
}

describe("AcpEngine: an external ACP agent as a RedGiant engine (G38.6)", () => {
  it("streams a turn: text, thinking, a tool call and its result, in order, then ends", async () => {
    const h = harness();
    h.agent.script = [
      { think: "Let me look." },
      { say: "Reading the file. " },
      { tool: "t1", kind: "read", title: "Read src/a.ts", path: "/work/project/src/a.ts" },
      { done: "t1", output: "one two" },
      { say: "Done." },
    ];
    const { t, log, deltas } = turnOf("Explain a.ts");
    const r = await h.engine.turn(t);
    expect(r).toEqual({ resume: "fake_1", stopReason: "end_turn" });
    expect(h.agent.seen.slice(0, 2)).toEqual([
      "initialize fs=true terminal=true",
      "new /work/project",
    ]);
    // The first prompt carries the short prelude, then the task.
    expect(h.agent.prompts[0]?.text).toMatch(
      /You work for RedGiant as "Claude Code"[\s\S]*---\n\nExplain a\.ts$/,
    );
    expect(log).toEqual([
      "message thinking:Let me look. | text:Reading the file. ",
      'tool t1 acp_read {"title":"Read src/a.ts","paths":["/work/project/src/a.ts"]}',
      "result t1 true one two",
      "message text:Done.",
    ]);
    expect(deltas).toEqual([
      "thinking_delta:Let me look.",
      "text_delta:Reading the file. ",
      "text_delta:Done.",
    ]);
    // The next turn continues the same ACP session, without the prelude.
    h.agent.script = [{ say: "Again." }];
    const second = turnOf("More");
    expect(await h.engine.turn(second.t)).toEqual({ resume: "fake_1", stopReason: "end_turn" });
    expect(h.agent.prompts[1]).toEqual({ sessionId: "fake_1", text: "More" });
    expect(h.launches()).toBe(1);
  });

  it("asks RedGiant's broker for every permission, never allowing by itself, and maps the answer", async () => {
    const h = harness({ allow: (c) => c.name === "bash" });
    h.agent.script = [
      { tool: "t1", kind: "execute", title: "npm test", rawInput: { command: "npm test" } },
      { ask: "t1" },
      {
        ask: "t2",
        kind: "edit",
        title: "Edit a.ts",
        path: "/work/project/src/a.ts",
        rawInput: { new_string: "x" },
      },
      { ask: "t3", kind: "delete", path: "/work/project/old.txt" },
      { ask: "t4", title: "Something" },
    ];
    await h.engine.turn(turnOf("go").t);
    expect(h.permits.map((p) => [p.call.name, p.call.input, p.ask])).toEqual([
      ["bash", { command: "npm test", title: "npm test" }, true],
      ["write_file", { path: "src/a.ts", title: "Edit a.ts", content: "x" }, true],
      ["bash", { command: "rm old.txt", title: "" }, true],
      ["acp_other", { title: "Something" }, true],
    ]);
    expect(h.agent.seen.filter((s) => s.startsWith("permission"))).toEqual([
      "permission t1 yes",
      "permission t2 no",
      "permission t3 yes",
      "permission t4 no",
    ]);
  });

  it("cancels: session/cancel goes to the agent, a pending permission is cancelled, the turn is aborted", async () => {
    let release!: () => void;
    const h = harness();
    h.host.permit = (_c, o) =>
      new Promise((ok) => {
        release = () => ok({ allow: true });
        o.signal?.addEventListener("abort", () => ok({ allow: false, reason: "stopped" }), {
          once: true,
        });
      });
    h.agent.script = [
      { say: "Working" },
      { ask: "t1", kind: "execute", rawInput: { command: "make" } },
      { hang: true },
    ];
    const stop = new AbortController();
    const { t, log } = turnOf("go", { signal: stop.signal });
    const r = h.engine.turn(t);
    await until(() => release !== undefined);
    stop.abort();
    expect(await r).toEqual({ resume: "fake_1", stopReason: "aborted" });
    expect(h.agent.seen).toContain("cancel fake_1");
    expect(h.agent.seen).toContain("permission t1 cancelled");
    expect(log).toEqual(["message text:Working"]);
  });

  it("serves files only inside its folder, through the broker: the guardian refuses the rest", async () => {
    const h = harness({
      allow: (c) => !(c.name === "write_file" && c.input.path === "locked.txt"),
    });
    h.agent.script = [
      { read: "/work/project/src/a.ts", line: 2, limit: 2 },
      { read: "/etc/passwd" },
      { read: "/work/project/../other/secret.txt" },
      { write: "/work/project/src/new.ts", content: "export {}" },
      { write: "/work/project/locked.txt", content: "no" },
      { write: "/home/me/.bashrc", content: "evil" },
    ];
    await h.engine.turn(turnOf("go").t);
    expect(h.agent.seen.slice(-6)).toEqual([
      "read /work/project/src/a.ts ok",
      "read /etc/passwd refused",
      "read /work/project/../other/secret.txt refused",
      "write /work/project/src/new.ts ok",
      "write /work/project/locked.txt refused",
      "write /home/me/.bashrc refused",
    ]);
    expect(h.agent.answers[0]).toBe("two\nthree");
    expect(String(h.agent.answers[1])).toMatch(/outside this agent's folder/);
    expect(String(h.agent.answers[3])).toMatch(/RedGiant refused: the person said no/);
    expect(h.files.get("src/new.ts")).toBe("export {}");
    expect(h.files.has("locked.txt")).toBe(false);
    // Outside paths never reach the broker nor the disk.
    expect(h.permits.map((p) => `${p.call.name} ${p.call.input.path}`)).toEqual([
      "read_file src/a.ts",
      "write_file src/new.ts",
      "write_file locked.txt",
    ]);
  });

  it("runs terminals without a shell, in its folder, after the broker", async () => {
    const h = harness({ allow: (c) => !String(c.input.command).startsWith("rm") });
    h.agent.script = [
      { terminal: "npm", args: ["test", "--", "a b"], cwd: "/work/project/pkg" },
      { terminal: "rm", args: ["-rf", "/"] },
      { terminal: "ls", cwd: "/tmp" },
    ];
    await h.engine.turn(turnOf("go").t);
    expect(h.runs).toEqual([{ file: "npm", args: ["test", "--", "a b"], cwd: "pkg" }]);
    expect(h.agent.seen.slice(-3)).toEqual([
      "terminal npm exit 0",
      "terminal rm refused",
      "terminal ls refused",
    ]);
    expect(h.permits[0]?.call.input).toEqual({ command: "npm test -- 'a b'", cwd: "pkg" });
    expect((h.agent.answers[0] as { output: string }).output).toBe("ran npm test -- a b\n");
  });

  it("resumes: a new engine loads the agent's session and does not record its replay", async () => {
    const h = harness({ loadSession: true });
    h.agent.script = [{ say: "Back." }];
    const { t, log } = turnOf("Where were we?", { resume: "fake_old" });
    expect(await h.engine.turn(t)).toEqual({ resume: "fake_old", stopReason: "end_turn" });
    expect(h.agent.loaded).toEqual(["fake_old"]);
    expect(h.agent.created).toEqual([]);
    expect(h.agent.prompts[0]).toEqual({ sessionId: "fake_old", text: "Where were we?" });
    expect(log).toEqual(["message text:Back."]);
  });

  it("an agent that cannot load starts anew and is told so", async () => {
    const h = harness({ loadSession: false });
    h.agent.script = [{ say: "ok" }];
    await h.engine.turn(turnOf("Go on", { resume: "fake_old" }).t);
    expect(h.agent.created).toEqual(["fake_1"]);
    expect(h.agent.prompts[0]?.text).toMatch(/earlier conversation could not be reopened/);
  });

  it("closes its task through complete_task (RD17): the line becomes RedGiant's tool, retried on failure", async () => {
    const h = harness();
    const calls: unknown[] = [];
    let first = true;
    h.agent.script = [{ say: 'Fixed.\nRG_COMPLETE_TASK {"verify_command": "npm test"}' }];
    const { t } = turnOf("Fix it", {
      tools: ["complete_task"],
      runTool: async (c) => {
        calls.push([c.name, c.input]);
        if (first) {
          first = false;
          // The agent's second answer, once told the verifier failed.
          h.agent.script = [
            { say: 'Now really.\nRG_COMPLETE_TASK {"verify_command": "npm test"}' },
          ];
          return { content: "Verification failed (exit 1).", isError: true };
        }
        return { content: "Verified", isError: false };
      },
    });
    expect((await h.engine.turn(t)).stopReason).toBe("end_turn");
    expect(calls).toEqual([
      ["complete_task", { verify_command: "npm test" }],
      ["complete_task", { verify_command: "npm test" }],
    ]);
    expect(h.agent.prompts[0]?.text).toMatch(/RG_COMPLETE_TASK \{"verify_command"/);
    expect(h.agent.prompts[1]?.text).toMatch(
      /complete_task did not close the task\.\nVerification failed/,
    );
  });

  it("a process that dies fails the turn; the next turn starts it again", async () => {
    let agent: FakeAgent = fakeAgent();
    const h = harness();
    h.host.launch = async () => agent.process;
    agent.script = [{ hang: true }];
    const r = h.engine.turn(turnOf("go").t);
    await until(() => agent.prompts.length === 1);
    agent.process.kill();
    await expect(r).rejects.toThrow();
    agent = fakeAgent();
    agent.script = [{ say: "fresh" }];
    expect((await h.engine.turn(turnOf("again").t)).stopReason).toBe("end_turn");
  });
});

describe("insideFolder: a folder with more than one name (macOS /private, symlinks)", () => {
  const names = ["/var/T/rg/work", "/private/var/T/rg/work"];
  it.each([
    ["notes.txt", "notes.txt"],
    ["/var/T/rg/work/a/b.txt", "a/b.txt"],
    ["/private/var/T/rg/work/notes.txt", "notes.txt"],
    ["/private/var/T/rg/work", "."],
    ["/private/var/T/rg/work/../escape.txt", undefined],
    ["/var/T/rg/other.txt", undefined],
    ["/etc/hostname", undefined],
    ["../escape.txt", undefined],
  ])("%s -> %s", (path, rel) => {
    expect(insideFolder(names, path)).toBe(rel);
  });
  it("one name alone still refuses the other", () => {
    expect(insideFolder(names[0] as string, "/private/var/T/rg/work/notes.txt")).toBeUndefined();
  });
  it("Windows names compare without case and with either separator", () => {
    expect(
      insideFolder(
        ["C:\\Users\\RUNNER~1\\w", "C:\\Users\\runneradmin\\w"],
        "c:/users/RunnerAdmin/w/x.txt",
      ),
    ).toBe("x.txt");
  });
});

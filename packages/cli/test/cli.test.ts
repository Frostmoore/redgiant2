import { afterEach, describe, expect, it } from "vitest";
import { startServer, TOKEN } from "../../server/test/helpers.js";
import { type CliIo, runCli } from "../src/index.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

function io(confirm?: boolean) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const x: CliIo = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    ...(confirm !== undefined && {
      confirm: async (q: string) => {
        asked.push(q);
        return confirm;
      },
    }),
  };
  return { io: x, out: () => out.join(""), err: () => err.join("\n"), asked };
}

const run = (args: string[], x = io()) =>
  runCli(args, { REDGIANT_URL: s?.url, REDGIANT_TOKEN: TOKEN }, x.io).then((code) => ({
    code,
    ...x,
  }));

async function setupAgents(mode = "auto") {
  await run(["projects", "create", "CLI", "Demo"]);
  const god = (
    await run([
      "agents",
      "create",
      "--kind",
      "god",
      "--name",
      "God",
      "--model",
      "fake/m",
      "--effort",
      "low",
    ])
  )
    .out()
    .trim();
  const orch = (
    await run([
      "agents",
      "create",
      "--kind",
      "orchestrator",
      "--name",
      "Orch",
      "--parent",
      god,
      "--project",
      "cli-demo",
    ])
  )
    .out()
    .trim();
  const agent = (
    await run([
      "agents",
      "create",
      "--kind",
      "agent",
      "--name",
      "Coder",
      "--parent",
      orch,
      "--mode",
      mode,
    ])
  )
    .out()
    .trim();
  const session =
    (await s?.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: agent }))?.body
      .sessionId ?? "";
  return { god, orch, agent, session };
}

describe("redgiant CLI", () => {
  it("manages projects and agents", async () => {
    s = await startServer([]);
    const created = await run(["projects", "create", "CLI", "Demo"]);
    expect(created.out()).toMatch(/^Created project cli-demo \(/);
    expect((await run(["projects"])).out()).toBe("cli-demo\tCLI Demo\n");
    const { god } = await setupAgents().catch(() => ({ god: "" }));
    expect(god).toMatch(/^god_/);
    const list = (await run(["agents", "--project", "cli-demo"])).out();
    expect(
      list
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("\t").slice(1, 3).join(" ")),
    ).toEqual(["orchestrator Orch", "agent Coder"]);
  });

  it("sends a message, streams the answer and prints the metrics bar", async () => {
    s = await startServer([{ text: "Hello from the CLI test" }]);
    const { session } = await setupAgents();
    const r = await run(["send", session, "hi"]);
    expect(r.code).toBe(0);
    expect(r.out()).toMatch(
      /^Hello from the CLI test\n {2}↳ in \d+ · out \d+ · ctx \d+% of 8\.2k · prefill .+ · gen .+/,
    );
  });

  it("asks for approval in the terminal", async () => {
    s = await startServer([
      { toolCalls: [{ name: "bash", input: { command: "git push" } }] },
      { text: "pushed" },
    ]);
    const { session } = await setupAgents();
    const r = await run(["send", session, "push it"], io(true));
    expect(r.asked).toEqual(["  Allow? [y/N] "]);
    expect(r.out()).toMatch(/Coder wants bash \{"command":"git push"\}\n {4}because: git push/);
    expect(r.out()).toMatch(/pushed\n/);
  });

  it("leaves requests pending without a terminal, to approve from another command", async () => {
    s = await startServer([
      { toolCalls: [{ name: "bash", input: { command: "rm -rf build" } }] },
      { text: "cleaned" },
    ]);
    const { session } = await setupAgents("manual");
    const sending = run(["send", session, "clean"]);
    let pending: string[] = [];
    for (let i = 0; i < 50 && pending.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      pending = (await run(["approvals"]))
        .out()
        .split("\n")
        .filter((l) => /^\S/.test(l));
    }
    expect(pending).toHaveLength(1);
    const id = pending[0]?.split(/\s+/)[0] ?? "";
    expect((await run(["approve", id])).out()).toBe(`Approved ${id}\n`);
    const r = await sending;
    expect(r.out()).toMatch(/no terminal: approve with `redgiant approve`/);
    expect(r.out()).toMatch(/cleaned/);
    expect((await run(["verify"])).out()).toMatch(/^Event log intact \(\d+ events\)/);
  });

  it("reports usage errors", async () => {
    s = await startServer([]);
    expect(await runCli(["projects"], {}, io().io)).toBe(2);
    const bad = await run(["frobnicate"]);
    expect(bad.code).toBe(2);
    expect(bad.err()).toMatch(/Unknown command/);
    const missing = await run(["agents", "create", "--kind", "god"]);
    expect(missing.code).toBe(1);
  });
});

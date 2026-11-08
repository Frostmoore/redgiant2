import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, TOKEN } from "../../server/test/helpers.js";
import { appDataDir, type CliIo, connection, runCli } from "../src/index.js";

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
    // The window fixed here: the bar below prints it.
    s = await startServer([{ text: "Hello from the CLI test" }], { contextWindow: 8192 });
    const { session } = await setupAgents();
    const r = await run(["send", session, "hi"]);
    expect(r.code).toBe(0);
    expect(r.out()).toMatch(
      /^Hello from the CLI test\n {2}↳ in [\d.]+k? · out \d+ · ctx \d+% of 8\.2k · prefill .+ · gen .+/,
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

describe("finding the installed RedGiant (G36.15)", () => {
  it("reads the app's data folder when the environment says nothing", async () => {
    const files: Record<string, string> = {
      [join("/data", "token.txt")]: "tok",
      [join("/data", "address.txt")]: "http://127.0.0.1:7601",
    };
    const read = (f: string) => files[f];
    expect(connection({}, read, "/data")).toEqual({ url: "http://127.0.0.1:7601", token: "tok" });
    expect(connection({ REDGIANT_URL: "http://h:1", REDGIANT_TOKEN: "t" }, read, "/data")).toEqual({
      url: "http://h:1",
      token: "t",
    });
    expect(connection({}, read, undefined)).toEqual({
      url: "http://127.0.0.1:7600",
      token: undefined,
    });
    expect(appDataDir({ LOCALAPPDATA: "C:\\Users\\Me\\AppData\\Local" }, "win32")).toBe(
      join("C:\\Users\\Me\\AppData\\Local", "RedGiant", "data"),
    );
    expect(appDataDir({}, "darwin", "/Users/me")).toBe(
      join("/Users/me", "Library", "Application Support", "RedGiant", "data"),
    );
    expect(appDataDir({ REDGIANT_DATA_DIR: "/x" }, "linux")).toBe("/x");
    expect(appDataDir({}, "linux")).toBeUndefined();

    // The whole command, against a server whose address and token sit in a data folder.
    s = await startServer([]);
    const dir = await mkdtemp(join(tmpdir(), "rg-cli-"));
    await writeFile(join(dir, "token.txt"), `${TOKEN}\n`);
    await writeFile(join(dir, "address.txt"), `${s.url}\n`);
    const code = join(dir, "code");
    await mkdir(code);
    const x = io();
    expect(
      await runCli(
        ["projects", "create", "Here", "--path", code],
        { REDGIANT_DATA_DIR: dir },
        x.io,
      ),
    ).toBe(0);
    expect(x.out()).toContain(`Created project here (${await realpath(code)})`);
    await rm(dir, { recursive: true, force: true });
  });
});

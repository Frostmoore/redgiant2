// Demo server for screenshots and UI development: the real server and UI, an in-process
// Postgres and a scripted model. Usage: node packages/web/scripts/demo-server.mjs [port]
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { FakeProvider, ProviderRegistry } from "@redgiant/providers";
import { RedGiantCore, serve, TokenAuth } from "@redgiant/server";

const port = Number(process.argv[2] ?? 7650);
// Set DEMO_TOKEN when the demo is reachable by others: the UI includes a terminal.
const token = process.env.DEMO_TOKEN ?? "demo-token-0123456789";
const dir = await mkdtemp(join(tmpdir(), "rg-demo-"));
const pg = await PGlite.create();
const wrap = (q) => ({
  query: async (text, params) => (await q.query(text, params)).rows,
  transaction: (fn) => (q instanceof PGlite ? q.transaction((tx) => fn(wrap(tx))) : fn(wrap(q))),
});

let turn = 0;
const brain = (req) => {
  const last = req.messages.at(-1);
  const results = last?.role === "user" && last.parts.every((p) => p.type === "tool_result");
  turn++;
  if (!results) {
    return {
      thinking:
        "The user wants a quick tour. I will look at the project files first, then explain.",
      text: "Let me look at the project first.",
      toolCalls: [{ name: "glob", input: { pattern: "**/*" } }],
      usage: {
        inputTokens: 4200 + turn * 300,
        cachedReadTokens: 3900 + turn * 250,
        outputTokens: 180,
      },
    };
  }
  return {
    text: 'Here is the state of **Demo**:\n\n- `README.md` describes the goal\n- `src/app.py` is the entry point\n\n```python\nprint("Hello RedGiant")\n```\n\nNext step: add tests, then I will verify them with `pytest`.',
    usage: {
      inputTokens: 4700 + turn * 300,
      cachedReadTokens: 4400 + turn * 250,
      outputTokens: 420,
    },
  };
};

const core = await RedGiantCore.create({
  db: wrap(pg),
  providers: new ProviderRegistry().register(
    new FakeProvider(brain, {
      contextWindow: 32_768,
      tick: () => new Promise((r) => setTimeout(r, 15)),
    }),
  ),
  workspacesDir: join(dir, "workspaces"),
  platformDir: join(dir, "platform"),
  defaultModel: { provider: "fake", model: "demo-model" },
  askAgent: async () => "escalate",
});
const me = { type: "human", ownerId: "local" };
const project = await core.projects.create("local", "Demo");
await mkdir(join(project.path, "src"), { recursive: true });
await writeFile(join(project.path, "README.md"), "# Demo\n\nA small project to show RedGiant.\n");
await writeFile(
  join(project.path, "src", "app.py"),
  'def main():\n    print("Hello RedGiant")\n\n\nif __name__ == "__main__":\n    main()\n',
);
const god = await core.registry.create(me, {
  kind: "god",
  parentId: null,
  name: "God",
  model: { provider: "fake", model: "demo-model", effort: "high" },
});
await core.registry.create(me, { kind: "demigod", parentId: god.id, name: "Demi-God" });
const orch = await core.registry.create(
  { type: "agent", agent: god },
  {
    kind: "orchestrator",
    parentId: god.id,
    projectId: "demo",
    name: "Demo orchestrator",
    role: "Plans and delegates",
  },
);
const coder = await core.registry.create(
  { type: "agent", agent: orch },
  {
    kind: "agent",
    parentId: orch.id,
    name: "Coder",
    role: "Writes and tests code",
    mode: "manual",
  },
);
const fmt = await core.board.createThread({
  ownerId: "local",
  projectId: "demo",
  title: "Output format",
  first: {
    author: orch.id,
    kind: "question",
    body: `Which format should \`src/app.py\` print? @${coder.id}`,
  },
});
await core.board.reply("local", fmt.thread.id, {
  author: coder.id,
  kind: "decision",
  body: "Plain text for humans, `--json` for scripts. I will add tests for both.",
});
await core.board.reply("local", fmt.thread.id, {
  author: "human",
  kind: "note",
  body: "Fine by me.",
});
await core.board.createThread({
  ownerId: "local",
  projectId: "demo",
  title: "Tests fail on Python 3.9",
  first: {
    author: coder.id,
    kind: "blocker",
    body: "`match` statements need Python 3.10+. Drop 3.9 or rewrite?",
  },
});
await core.board.createThread({
  ownerId: "local",
  projectId: "demo",
  title: "README rewritten",
  first: {
    author: coder.id,
    kind: "result",
    body: "README now explains install and usage. Verified with `python -m doctest README.md`.",
  },
});
await core.registry.create(
  { type: "agent", agent: god },
  {
    kind: "inspector",
    parentId: god.id,
    projectId: "demo",
    name: "Inspector",
    role: "Answers questions about Demo",
  },
);
await core.extensions.propose({
  ownerId: "local",
  projectId: "demo",
  author: coder.id,
  input: {
    kind: "tool",
    spec: {
      name: "word-count",
      description: "Counts the words of a text",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      command: "node count.mjs",
    },
    files: {
      "count.mjs":
        "import { readFileSync } from 'node:fs';\nconsole.log(JSON.parse(readFileSync(process.argv[2], 'utf8')).text.split(/\\s+/).length);\n",
    },
    tests: [{ input: { text: "a b c" }, expectStdoutContains: "3" }],
  },
});
await core.extensions.propose({
  ownerId: "local",
  projectId: null,
  author: "human",
  autoInstall: true,
  input: {
    kind: "skill",
    name: "release-notes",
    description: "How we write release notes",
    body: "Group changes by user impact; one line each.",
    untestableReason: "Style is judged by reading.",
  },
});
await core.setMcp("local", {
  name: "docs",
  projectId: null,
  transport: { type: "http", url: "https://mcp.example.com/mcp" },
});
const sid = await core.startSession("local", orch.id);
await (await core.send("local", sid, "Give me a quick tour of the project.")).done;
await core.budget.setLimit({ scope: "global", id: "local" }, { usd: 20 });

const web = fileURLToPath(new URL("../dist", import.meta.url));
const running = await serve(core, new TokenAuth({ [token]: "local" }), {
  port,
  host: "0.0.0.0",
  webDir: web,
});
console.log(
  JSON.stringify({
    url: running.url.replace("127.0.0.1", "0.0.0.0"),
    token,
    session: sid,
    orchestrator: orch.id,
  }),
);

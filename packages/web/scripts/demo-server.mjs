// Demo server for screenshots and UI development: the real server and UI, an in-process
// Postgres and a scripted model. Usage: node packages/web/scripts/demo-server.mjs [port]
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { FakeProvider, ProviderRegistry } from "@redgiant/providers";
import { RedGiantCore, SetupService, serve, TokenAuth } from "@redgiant/server";

const port = Number(process.argv[2] ?? 7650);
// Set DEMO_TOKEN when the demo is reachable by others: the UI includes a terminal.
const token = process.env.DEMO_TOKEN ?? "demo-token-0123456789";
const dir = await mkdtemp(join(tmpdir(), "rg-demo-"));
const pg = await PGlite.create();
const wrap = (q) => ({
  query: async (text, params) => (await q.query(text, params)).rows,
  transaction: (fn) => (q instanceof PGlite ? q.transaction((tx) => fn(wrap(tx))) : fn(wrap(q))),
});

/** A one-page PDF with a line of text (offsets computed, so readers accept it). */
function demoPdf(line) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 24 Tf 72 760 Td (${line}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

let turn = 0;
const brain = (req) => {
  const last = req.messages.at(-1);
  const results = last?.role === "user" && last.parts.every((p) => p.type === "tool_result");
  turn++;
  const said = last?.parts.find((p) => p.type === "text")?.text ?? "";
  // God asks before planning: a question card waits for the human.
  if (said.startsWith("Plan the export feature")) {
    return {
      text: "Before I plan it, two choices are yours.",
      toolCalls: [
        {
          name: "ask_user",
          input: {
            questions: [
              {
                question: "Which format should the export produce first?",
                header: "Format",
                options: [
                  { label: "CSV", description: "Opens in every spreadsheet" },
                  { label: "JSON", description: "For other programs" },
                  { label: "Both" },
                ],
              },
              {
                question: "Which extras do you want?",
                options: [
                  { label: "Filters by date" },
                  { label: "Scheduled export" },
                  { label: "Email the file" },
                ],
                multi_select: true,
              },
            ],
          },
        },
      ],
    };
  }
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
  providers: new ProviderRegistry()
    .register(
      new FakeProvider(brain, {
        contextWindow: 32_768,
        models: ["demo-model", "demo-large", "demo-small"],
        tick: () => new Promise((r) => setTimeout(r, 15)),
      }),
    )
    // A Claude subscription stand-in: God runs on it, so the header shows the plan's limits.
    .register(
      Object.assign(
        new FakeProvider(brain, {
          id: "claude-subscription",
          contextWindow: 200_000,
          models: ["claude-opus-5-5", "claude-sonnet-5-5"],
        }),
        {
          limits: async () => [
            { id: "7d", label: "7g", usedPct: 36, resetsAt: "2026-11-03T18:00:00.000Z" },
            { id: "model:Fable", label: "Fable", usedPct: 30 },
          ],
        },
      ),
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
// A picture and a PDF for the previews.
await mkdir(join(project.path, "docs"), { recursive: true });
await writeFile(
  join(project.path, "docs", "diagram.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" rx="16" fill="#1c1f26"/><circle cx="120" cy="120" r="70" fill="#ef4b3a"/><text x="220" y="130" font-family="sans-serif" font-size="32" fill="#e8e6e3">RedGiant</text></svg>',
);
await writeFile(join(project.path, "docs", "report.pdf"), demoPdf("Demo report: all tests pass."));
await writeFile(
  join(project.path, "src", "app.py"),
  'def main():\n    print("Hello RedGiant")\n\n\nif __name__ == "__main__":\n    main()\n',
);
const god = await core.registry.create(me, {
  kind: "god",
  parentId: null,
  name: "God",
  model: { provider: "claude-subscription", model: "claude-opus-5-5", effort: "high" },
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
    model: { provider: "fake", model: "demo-model", effort: "high" },
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
// Left waiting on purpose: the question card in God's conversation.
const godSid = await core.startSession("local", god.id);
void (await core.send("local", godSid, "Plan the export feature for the reports.")).done.catch(
  () => {},
);
const insp = await core.chat.create("local", "Stato", { kind: "inspector", projectId: "demo" });
await core.chat.send("local", insp.id, "A che punto è il progetto?", [], () => {});
const daily = await core.chat.create("local");
await core.chat.send("local", daily.id, "Come preparo un buon caffè con la moka?", [], () => {});
const digest = await core.automations.create(
  "local",
  `name: morning-digest
description: What happened yesterday, every weekday morning
on:
  cron: "0 8 * * 1-5"
  timezone: Europe/Rome
agent: god
effort: low
instructions: |
  Summarise what happened yesterday on every project. Keep it short.
notify:
  when: always
`,
);
await (await core.automations.runNow("local", digest.automation.id)).done;
await core.config.setBudget("local", god.id, { scope: "project", id: "demo" }, { usd: 5 });
await core.config.configureAgent("local", god.id, coder.id, {
  model: { provider: "fake", model: "demo-model-small", effort: "low" },
  mode: "auto",
});
await core.automations.create(
  "local",
  "name: review-on-push\non:\n  webhook: true\nagent: orchestrator\nproject: demo\ninstructions: Review the new commits.\n",
);

const web = fileURLToPath(new URL("../dist", import.meta.url));
// The setup wizard, already completed, with hooks that change nothing (no keys, no engine).
const setup = new SetupService({
  db: core.db,
  core,
  dataDir: join(dir, "data"),
  ownerId: "local",
  hooks: {
    key: async () => [],
    server: async () => [],
    telegram: async () => null,
    search: async () => {},
    engine: async () => {},
  },
});
await setup.applyAtStartup();
await setup.complete();
const running = await serve(core, new TokenAuth({ [token]: "local" }), {
  port,
  host: "0.0.0.0",
  webDir: web,
  setup,
});
console.log(
  JSON.stringify({
    url: running.url.replace("127.0.0.1", "0.0.0.0"),
    token,
    session: sid,
    orchestrator: orch.id,
  }),
);

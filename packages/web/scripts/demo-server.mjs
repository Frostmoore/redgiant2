// Demo server for screenshots and UI development: the real server and UI, an in-process
// Postgres and a scripted model. Usage: node packages/web/scripts/demo-server.mjs [port]
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { FakeProvider, ProviderError, ProviderRegistry } from "@redgiant/providers";
import {
  Browsers,
  DockerBrowserLauncher,
  debugLog,
  exportBackup,
  GitHosts,
  HuggingFace,
  JobFailure,
  RedGiantCore,
  SetupService,
  serve,
  TokenAuth,
  UpdateWatcher,
} from "@redgiant/server";

const port = Number(process.argv[2] ?? 7650);
// Set DEMO_TOKEN when the demo is reachable by others: the UI includes a terminal.
const token = process.env.DEMO_TOKEN ?? "demo-token-0123456789";
const dir = await mkdtemp(join(tmpdir(), "rg-demo-"));
// DEMO_KNOWLEDGE=1 (G36.5): pgvector in the demo's Postgres too, for the knowledge.
const pg = await PGlite.create(
  process.env.DEMO_KNOWLEDGE
    ? {
        extensions: {
          vector: (
            await import(
              createRequire(new URL("../../server/package.json", import.meta.url)).resolve(
                "@electric-sql/pglite-pgvector",
              )
            )
          ).vector,
        },
      }
    : {},
);
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
  // A tool's pictures (canvas_look, G36.12) come in the same message as the results.
  const results =
    last?.role === "user" &&
    last.parts.some((p) => p.type === "tool_result") &&
    last.parts.every((p) => p.type === "tool_result" || p.type === "image");
  turn++;
  const said = last?.parts.find((p) => p.type === "text")?.text ?? "";
  // G36.5: a question on the person's documents, searched and answered with its citations.
  const found = last?.parts.find(
    (p) => p.type === "tool_result" && String(p.content).includes("(#kb:"),
  )?.content;
  if (results && found) {
    const links = [...String(found).matchAll(/^\[(\d+)\] (\[[^\]]+\]\(#kb:\d+\))/gm)].map(
      (m) => m[2],
    );
    return {
      text: [
        "La garanzia della **Lumo 8** dura **24 mesi** dalla data dello scontrino e copre motore, scheda elettronica e pompa di scarico [1]. Non copre la guarnizione dell'oblò né i danni da calcare [1].",
        "",
        "Per l'assistenza chiami il numero verde con modello e numero di serie (sono sull'etichetta dietro lo sportello del filtro): il tecnico arriva entro cinque giorni lavorativi [1].",
        "",
        "**Fonti**",
        "",
        `1. ${links.find((l) => l.includes("lavatrice")) ?? links[0]}`,
      ].join("\n"),
    };
  }
  if (said.includes("garanzia della lavatrice") && !results)
    return {
      text: "Lo cerco nei tuoi documenti.",
      toolCalls: [
        { name: "search_knowledge", input: { query: "garanzia lavatrice durata assistenza" } },
      ],
    };
  // G36.17: the person's classifier (DEMO_REQUESTS): yes to installing, no to deleting, an answer.
  if (typeof req.system === "string" && req.system.startsWith("You decide for a person")) {
    if (said.includes("Answer each question"))
      return {
        text: '{"answers": [["SQLite"]], "reason": "Per una prova basta un file: niente server da installare."}',
      };
    return {
      text: said.includes("rm -rf")
        ? '{"decision": "deny", "reason": "Cancella cartelle intere e il compito era solo aggiornare i test."}'
        : '{"decision": "allow", "reason": "Installa le dipendenze del progetto: serve al compito ed è sicuro."}',
    };
  }
  // G36.22–24 (DEMO_CHAT_TOOLS): a plan to answer in parts, a reply to a passage, a side question.
  if (said.includes("Come organizzo il lancio"))
    return {
      text: "Ecco un piano in tre passi per il lancio:\n\n1. **Prima settimana**: una pagina d'attesa con l'iscrizione alla lista, e tre post che raccontano il perché del prodotto.\n2. **Seconda settimana**: una demo dal vivo di venti minuti, registrata e messa sul sito.\n3. **Il giorno del lancio**: email alla lista alle 9, post su LinkedIn alle 10, e un'ora per rispondere a tutti.\n\nIl budget più grosso va nella demo: è quella che convince.",
      usage: { inputTokens: 5200, cachedReadTokens: 4800, outputTokens: 210 },
    };
  if (said.includes("They received the whole message"))
    return {
      text: "Giusto: la demo dal vivo può diventare un video di cinque minuti, girato una volta sola. Costa un terzo e si guarda fino in fondo. Il resto del piano resta com'è.",
      usage: { inputTokens: 5600, cachedReadTokens: 5300, outputTokens: 90 },
    };
  if (said.includes("a side question from the person"))
    return {
      text: "Venti minuti dal vivo sono tanti per chi non ti conosce: **cinque o sei minuti** bastano, il resto va nelle domande.",
      usage: { inputTokens: 5500, cachedReadTokens: 5300, outputTokens: 60 },
    };
  if (said.includes("E se rimandassimo"))
    return {
      text: "Rimandare di due settimane va bene: sposto la pagina d'attesa a metà mese e la demo subito dopo.",
      usage: { inputTokens: 5400, cachedReadTokens: 5200, outputTokens: 50 },
    };
  // G36.15: an agent asks for a switched-off tool (the person answers from the bell).
  if (said.includes("Mi serve Blender") && !results)
    return {
      text: "Per il modello 3D mi serve Blender, che per me è spento: te lo chiedo.",
      toolCalls: [
        {
          name: "request_tool",
          input: { tool: "blender", why: "Per fare il modello 3D del logo che mi hai chiesto." },
        },
      ],
    };
  // p3.3.1: background commands (DEMO_SUBAGENTS): a server that keeps writing, tests, a build.
  if (said.startsWith("Start the test server"))
    return {
      text: "Starting the test server and, meanwhile, the tests and the build.",
      toolCalls: [
        {
          name: "bash",
          input: {
            command:
              'echo "> vite --port 5173"; for i in $(seq 1 900); do echo "[vite] GET /api/status 200 in $((i % 40 + 3)) ms"; sleep 1; done',
            background: true,
          },
        },
        {
          name: "bash",
          input: {
            command:
              "echo 'RUN v5.0.5'; sleep 1; echo 'warning: slow test (2.3 s)' >&2; echo 'Tests 42 passed (42)'",
            background: true,
          },
        },
        {
          name: "bash",
          input: {
            command:
              "echo 'tsc -b'; sleep 1; echo 'src/app.ts(12,5): error TS2322: Type string is not assignable to type number.' >&2; exit 2",
            background: true,
          },
        },
      ],
    };
  if (
    results &&
    last?.parts.some(
      (p) => p.type === "tool_result" && p.content.startsWith("Started in the background"),
    )
  )
    return {
      text: "The server is up; the tests passed, and the build has a type error in `src/app.ts`.",
    };
  // p3.3.1: the sub-agents of DEMO_SUBAGENTS, each with its own answer.
  if (said.startsWith("Task from God: «Publish"))
    return {
      text: "Writing the release notes, then publishing.",
      toolCalls: [
        { name: "write_file", input: { path: "release-3.3.1.md", content: "# 3.3.1\n" } },
      ],
    };
  if (said.startsWith("Task from God: «Write"))
    return {
      text: "I cannot: the integration tests need a database that is not here.",
    };
  if (said.startsWith("Task from "))
    return {
      text: "Ho trovato i file da cambiare:\n\n- `packages/server/src/convert-js.ts`\n- `packages/server/src/convert-blender.ts`\n- `packages/web/src/components/Composer.tsx`",
    };
  // G36.12 (DEMO_CANVAS): the agent looks at the person's canvas and leafs through it.
  const toolOut = last?.parts.find((p) => p.type === "tool_result")?.content;
  if (results && typeof toolOut === "string" && toolOut.startsWith("The person's canvas"))
    return {
      text: toolOut.includes("Looking at sedia.obj")
        ? "Vedo la sedia che hai aperto: quattro gambe, il sedile e lo schienale, dritta sul pavimento."
        : toolOut.includes("Looking at canvas/conti.csv")
          ? "Vedo la tabella dei conti: affitto, luce e internet, mese per mese."
          : "Ecco cosa vedo nel tuo Canvas.",
    };
  if (results && typeof toolOut === "string" && toolOut.startsWith("Done: the person's canvas"))
    return { text: "Fatto: guarda nel Canvas, qui accanto." };
  // G37.3 (DEMO_CANVAS): the agent edits the sheet open in the canvas.
  if (
    results &&
    typeof toolOut === "string" &&
    toolOut.startsWith("Applied as revision") &&
    /cell|row|sheet/.test(toolOut)
  )
    return {
      text: "Fatto: ho corretto la quantità di febbraio, aggiunto marzo e messo in grassetto i totali. Le celle cambiate sono evidenziate; dal pannello Modifiche puoi annullarle.",
    };
  // G37.1 (DEMO_CANVAS): the agent edits the note open in the canvas, with canvas_edit.
  if (results && typeof toolOut === "string" && toolOut.startsWith("Applied as revision"))
    return {
      text: said.startsWith("Migliora il totale")
        ? "Fatto: ho spiegato il carrello vuoto e corretto l'arrotondamento. Le righe sono evidenziate nel Canvas; da Modifiche vedi le differenze o le annulli."
        : said.startsWith("Aggiorna la guida")
          ? "Fatto: ho aggiunto la sezione sui resi, la vedi nell'anteprima accanto."
          : "Fatto: ho aggiunto le due voci e corretto l'orario. Le vedi evidenziate nel Canvas; dal pannello Modifiche puoi annullarle.",
    };
  if (results && typeof toolOut === "string" && toolOut.startsWith("Proposed to the person"))
    return { text: "Te l'ho proposta: la trovi in Modifiche, da accettare o rifiutare." };
  const canvasMoves = [
    ["Guarda il Canvas", "canvas_look", {}],
    ["Guarda la sedia di lato", "canvas_look", { path: "canvas/sedia.obj", view: "right" }],
    ["Guarda la tabella", "canvas_look", { path: "canvas/conti.csv", cells: "A1:D5" }],
    ["Segna le celle", "canvas_act", { path: "canvas/conti.csv", cells: "B2:C4" }],
    ["Vai alla riga", "canvas_act", { path: "canvas/app.py", line: 12, to_line: 18 }],
    [
      "Sistema la nota",
      "canvas_edit",
      {
        path: "canvas/spesa.txt",
        ops: [
          { op: "insert", line: 4, text: "- caffè in grani\n- limoni\n" },
          { op: "replace", find: "alle 18", text: "alle 18:30" },
        ],
      },
    ],
    // G37.2: the agent edits code and Markdown open in the canvas.
    [
      "Migliora il totale",
      "canvas_edit",
      {
        path: "canvas/app.py",
        ops: [
          {
            op: "replace",
            from_line: 15,
            to_line: 16,
            text: "    if net <= 0:\n        # An empty cart, or only free items.\n        return 0.0",
          },
          { op: "replace", find: "return round(gross, 2)", text: "return round(gross + 1e-9, 2)" },
        ],
      },
    ],
    [
      "Aggiorna la guida",
      "canvas_edit",
      {
        path: "canvas/guida.md",
        ops: [
          {
            op: "insert",
            line: 9,
            text: "## Resi\n\nUn reso si accetta entro **14 giorni**, con lo scontrino.\n\n",
          },
        ],
      },
    ],
    [
      "Aggiorna le vendite",
      "canvas_edit",
      {
        path: "canvas/vendite.ods",
        ops: [
          { op: "set", cell: "D6", value: 12 },
          { op: "insert_rows", before: 10 },
          {
            op: "set_range",
            range: "A10",
            values: [["mar", "Nord", "Gamma", 40, 24.5, "=D10*E10"]],
          },
          { op: "format", range: "A17:F17", bold: true, background: "#ddebf7" },
        ],
      },
    ],
    [
      "Aggiungi il pane",
      "canvas_edit",
      { path: "canvas/spesa.txt", ops: [{ op: "insert", line: 2, text: "- pane integrale\n" }] },
    ],
  ];
  for (const [words, name, input] of canvasMoves)
    if (said.startsWith(words) && !results)
      return {
        text:
          name === "canvas_look"
            ? "Guardo il tuo Canvas."
            : name === "canvas_edit"
              ? "Lo sistemo io nel Canvas."
              : "Lo sfoglio io, guarda.",
        toolCalls: [{ name, input }],
      };
  // G34: «Mostra il file <path>» → show_file; its result → a short answer.
  const shownResult = last?.parts.find((p) => p.type === "tool_result")?.content;
  if (results && typeof shownResult === "string" && shownResult.startsWith("Opened "))
    return { text: "Eccolo nel Canvas, qui accanto." };
  if (said.startsWith("Mostra il file "))
    return {
      text: "Te lo apro nel Canvas.",
      toolCalls: [
        { name: "show_file", input: { path: said.slice("Mostra il file ".length).trim() } },
      ],
    };
  // An answer with its sources (2026-11-06): the [n] become links named after their site.
  if (said.includes("Chi ha vinto le midterm")) {
    return {
      text: [
        "Le midterm del 3 novembre 2026 le hanno vinte **i Democratici**, che hanno preso il controllo sia della **Camera** sia del **Senato** [1][2][3].",
        "",
        "- **Camera:** più di una ventina di seggi strappati ai Repubblicani [1].",
        "- **Senato:** almeno 54 seggi, con vittorie a sorpresa in Texas e South Carolina [2]. In Mississippi lo spoglio era ancora in corso [4].",
        "",
        "**Fonti**",
        "",
        "1. CBS News: House election results 2026: https://www.cbsnews.com/live-updates/house-election-results-2026/",
        "2. CBS News: Senate election results 2026: https://www.cbsnews.com/live-updates/senate-election-results-2026/",
        "3. Il Sole 24 Ore: Midterm 2026, i risultati: https://lab24.ilsole24ore.com/midterm-usa-2026/",
        "4. Yahoo News: Midterms 2026 live updates: https://www.yahoo.com/news/politics/live/midterms-2026/",
      ].join("\n"),
    };
  }
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
      toolCalls: [
        { name: "glob", input: { pattern: "**/*" } },
        // A change to a file: the chat shows its diff (2026-11-05).
        {
          name: "edit_file",
          input: {
            path: "src/app.py",
            old_string: '    print("Hello RedGiant")',
            new_string: '    name = "RedGiant"\n    print(f"Hello {name}")',
          },
        },
      ],
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
        // As a local engine reports it: the reading of the context shows its progress.
        prefill: { total: 18_400, cached: 14_200, steps: 12, stepMs: 250 },
      }),
    )
    // A Claude subscription stand-in: God runs on it, so the header shows the plan's limits.
    .register(
      Object.assign(
        new FakeProvider(brain, {
          id: "claude-subscription",
          contextWindow: 200_000,
          models: ["claude-opus-5-5", "claude-sonnet-5-5"],
          // REDGIANT_DEMO_SLOW=1: God writes slowly, reading its context like a local engine
          // (to look at the progress line).
          ...(process.env.REDGIANT_DEMO_SLOW && {
            tick: () => new Promise((r) => setTimeout(r, 60)),
            prefill: { total: 42_000, cached: 31_500, steps: 16, stepMs: 300 },
          }),
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
  transport: { type: "http", url: "https://mcp.example.com/mcp", oauth: true },
});
const sid = await core.startSession("local", orch.id);
await (await core.send("local", sid, "Give me a quick tour of the project.")).done;
// A summary asked by hand (G24.14), with its mark in the chat.
await (await core.send("local", sid, "And the tests?")).done;
await (await core.send("local", sid, "/compact keep the file list")).done;
await core.budget.setLimit({ scope: "global", id: "local" }, { usd: 20 });
// Left waiting on purpose: the question card in God's conversation.
const godSid = await core.startSession("local", god.id);
void (await core.send("local", godSid, "Plan the export feature for the reports.")).done.catch(
  () => {},
);
// The canvas (G25.1): what God made and showed, a card for each in its conversation.
{
  const home = core.platformPath("local");
  await mkdir(join(home, "site"), { recursive: true });
  await writeFile(
    join(home, "site", "index.html"),
    `<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><main><h1>Good morning, Red Giant</h1><p>A site made by God, shown in the canvas.</p></main></body></html>`,
  );
  await writeFile(
    join(home, "site", "style.css"),
    "body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui;background:linear-gradient(135deg,#2b0f12,#7a1e22 55%,#e0482e);color:#fff}h1{font-size:44px;margin:0 0 8px}main{text-align:center}",
  );
  await writeFile(
    join(home, "expenses.csv"),
    'Month,Item,Amount\nJanuary,Rent,850\nJanuary,"Groceries, food",312.40\nFebruary,Rent,850\nFebruary,Bills,140.15\n',
  );
  await writeFile(
    join(home, "note.md"),
    "# Notes\n\n- The site is ready\n- The **canvas** updates by itself\n",
  );
  // A cube, as a 3D model.
  const v = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ];
  const faces = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [2, 3, 7],
    [2, 7, 6],
    [1, 2, 6],
    [1, 6, 5],
    [0, 4, 7],
    [0, 7, 3],
  ];
  const stl = `solid cube\n${faces.map((f) => `facet normal 0 0 0\nouter loop\n${f.map((i) => `vertex ${v[i].join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid cube\n`;
  await writeFile(join(home, "cube.stl"), stl);
  const shown = await core.startSession("local", god.id);
  await (await core.send("local", shown, "Show me what you made")).done;
  // Files sent in the chat (G25.2): a picture and a document.
  await writeFile(
    join(home, "preview.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b0f12"/><stop offset="1" stop-color="#e0482e"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><text x="320" y="190" font-family="sans-serif" font-size="36" fill="#fff" text-anchor="middle">Good morning, Red Giant</text></svg>`,
  );
  await writeFile(join(home, "report.txt"), "Project report\n".repeat(40));
  for (const [name, mime, caption] of [
    ["preview.svg", "image/svg+xml", "Here is how the site looks"],
    ["report.txt", "text/plain", undefined],
  ])
    await core.store.append({
      ownerId: "local",
      projectId: null,
      agentId: god.id,
      sessionId: shown,
      body: {
        type: "file.sent",
        payload: {
          scope: "platform",
          path: name,
          name,
          size: 4096,
          mime,
          ...(caption && { caption }),
        },
      },
    });
  // A board (G25.4): three pages to choose from, kept apart as Officina's.
  const boardId = "0a1b2c3d4e5f";
  // Where the server keeps boards: next to the platform folder, outside every workspace.
  const boardDir = join(dirname(dirname(core.platformPath("local"))), "boards", boardId);
  await mkdir(boardDir, { recursive: true });
  const page = (bg, fg, sub) =>
    `<!doctype html><html lang="en"><body style="margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui;background:${bg};color:${fg}"><main style="text-align:center"><h1 style="font-size:64px;margin:0">Good morning, Red Giant</h1><p style="font-size:22px">${sub}</p></main></body></html>`;
  const pages = [
    page(
      "linear-gradient(135deg,#2b0f12,#7a1e22 55%,#e0482e)",
      "#fff",
      "Red on black, like RedGiant",
    ),
    page("#f6f1ea", "#2b0f12", "Warm tones, lighter"),
    page("#0d1b2a", "#e0e1dd", "Night blue, plain"),
  ];
  for (const [n, html] of pages.entries()) await writeFile(join(boardDir, `${n + 1}.html`), html);
  await core.store.append({
    ownerId: "local",
    projectId: null,
    agentId: god.id,
    sessionId: shown,
    body: {
      type: "variants.proposed",
      payload: {
        proposalId: boardId,
        title: "The site's home page",
        description: "Three ways to the front page.",
        variants: [
          { title: "Dark", note: "Red on black, like RedGiant", bytes: pages[0].length },
          { title: "Light", note: "Warm tones, lighter", bytes: pages[1].length },
          { title: "Night", bytes: pages[2].length },
        ],
      },
    },
  });
  for (const [title, path] of [
    ["The site", "site"],
    ["Expenses", "expenses.csv"],
    ["Cube", "cube.stl"],
    ["Note", "note.md"],
  ])
    await core.store.append({
      ownerId: "local",
      projectId: null,
      agentId: god.id,
      sessionId: shown,
      body: {
        type: "canvas.show",
        payload: { title, target: { kind: "file", scope: "platform", path } },
      },
    });
}
const insp = await core.chat.create("local", "Stato", { kind: "inspector", projectId: "demo" });
await core.chat.send("local", insp.id, "A che punto è il progetto?", [], () => {});
const daily = await core.chat.create("local");
await core.chat.send("local", daily.id, "Come preparo un buon caffè con la moka?", [], () => {});
const news = await core.chat.create("local");
await core.chat.send("local", news.id, "Chi ha vinto le midterm?", [], () => {});
// The agents' computer downloading on its own (DEMO_DOWNLOAD=1): the card with the bar.
if (process.env.DEMO_DOWNLOAD === "1")
  core.jobs.start("local", "download_sandbox", ["image_download"], async (h) => {
    h.step("image_download");
    const total = 84_000_000;
    for (let done = 0; done < total; done += 1_400_000) {
      h.progress(done, total);
      await new Promise((r) => setTimeout(r, 1000));
    }
  });
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
await core.config.setBudget("local", "human", { scope: "global", id: "local" }, { usd: 40 });
await core.config.setPolicy("local", god.id, {
  rules: [{ tool: "bash", match: "\\bnpm publish\\b", decision: "deny" }],
  humanOnly: ["git-push"],
  disabledDanger: [],
});
await core.config.mcp("local", god.id, { action: "add", catalogId: "linear", projectId: "demo" });
// Personal assistants (G24.11).
const secretary = await core.registry.create(
  { type: "human", ownerId: "local" },
  {
    kind: "assistant",
    parentId: god.id,
    name: "Secretary",
    role: "Keep my tasks and appointments in order and give me a brief of the day.",
    connections: ["docs"],
  },
);
const researcher = await core.registry.create(
  { type: "human", ownerId: "local" },
  {
    kind: "assistant",
    parentId: god.id,
    name: "Researcher",
    role: "Search the web and bring back what you find, with the sources.",
  },
);
// Subprojects (G24.13): the site and the API, each in its folder, with an agent on the site.
{
  const site = await core.projects.createSubproject("local", "demo", "Site", "apps/site");
  await core.projects.createSubproject("local", "demo", "API", "apps/api");
  const webmaster = await core.registry.create(
    { type: "human", ownerId: "local" },
    {
      kind: "agent",
      parentId: orch.id,
      projectId: "demo",
      subprojectId: site.id,
      name: "Webmaster",
      role: "Keeps the site",
    },
  );
  const wsid = await core.startSession("local", webmaster.id);
  await (await core.send("local", wsid, "Give me a quick tour of the site.")).done;
}
// The agents' browser (G24.14b), real, when asked: DEMO_BROWSER=1 (Docker, this container's network).
if (process.env.DEMO_BROWSER === "1") {
  const { default: Docker } = await import(
    new URL("../../server/node_modules/dockerode/lib/docker.js", import.meta.url).href
  );
  core.browsers = new Browsers(
    new DockerBrowserLauncher({
      docker: new Docker(),
      network: `container:${hostname()}`,
      prefix: "rg-browser-demo",
      address: () => "127.0.0.1",
    }),
  );
}
// A group chat (G24.12): God, the demo's inspector and the secretary.
{
  const room = await core.rooms.create("local", {
    title: "December release",
    members: [god.id, (await core.inspectorAgent("local", "demo")).id, secretary.id],
  });
  await (await core.rooms.post("local", room.id, "What is left for the December release?")).done;
}
await core.automations.create(
  "local",
  `name: morning-brief\ndescription: Morning brief\non:\n  cron: "0 8 * * 1-5"\nagent: ${secretary.id}\ninstructions: Give me the brief of the day.\n`,
);
// A month of spending for the chart: a little every day, more on some.
{
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  for (let d = 1; d <= now.getDate(); d++) {
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(d)}`;
    const usd = Math.round((0.3 + ((d * 37) % 11) / 4) * 100) / 100;
    for (const [scope, key, part] of [
      ["global", "local", 1],
      ["project", "demo", 0.7],
      ["agent", orch.id, 0.4],
      ["agent", coder.id, 0.3],
    ]) {
      await core.db.query(
        `INSERT INTO rg_spend_daily (owner_id, day, scope, key, usd, tokens) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (owner_id, day, scope, key) DO UPDATE SET usd = rg_spend_daily.usd + EXCLUDED.usd`,
        ["local", day, scope, key, usd * part, Math.round(usd * part * 200_000)],
      );
      await core.db.query(
        `INSERT INTO rg_budgets (scope, key, spent_usd, spent_tok) VALUES ($1, $2, $3, $4)
         ON CONFLICT (scope, key) DO UPDATE SET spent_usd = rg_budgets.spent_usd + EXCLUDED.spent_usd,
                                                 spent_tok = rg_budgets.spent_tok + EXCLUDED.spent_tok`,
        [scope, key, usd * part, Math.round(usd * part * 200_000)],
      );
    }
  }
}
await core.automations.create(
  "local",
  "name: review-on-push\non:\n  webhook: true\nagent: orchestrator\nproject: demo\ninstructions: Review the new commits.\n",
);

const web = fileURLToPath(new URL("../dist", import.meta.url));
// G36.20, DEMO_KEYS=1: the files of a version before, moved into the keychain at this start (a
// secrets.json with keys of models, chats, GitHub and search; a mailbox's password file).
if (process.env.DEMO_KEYS) {
  await mkdir(join(dir, "data"), { recursive: true });
  await writeFile(
    join(dir, "data", "secrets.json"),
    JSON.stringify({
      keys: { anthropic: "sk-ant-api03-demo-moved", openai: "sk-proj-demo-moved" },
      telegramToken: "123456:AAH-demo-moved",
      chats: { matrix: { homeserver: "https://matrix.example.org", accessToken: "syt_demo" } },
      githubToken: "ghp_demo_good_moved",
      searchKeys: { brave: "BSA-demo-moved" },
    }),
    { mode: 0o600 },
  );
  await core.db.query(
    "INSERT INTO rg_settings (owner_id, key, value) VALUES ('local', 'email_boxes', $1) ON CONFLICT DO NOTHING",
    [
      JSON.stringify([
        {
          id: "box_demo1",
          name: "Work",
          category: "work",
          host: "imap.example.org",
          port: 993,
          secure: true,
          user: "mario@example.org",
          createdAt: new Date().toISOString(),
        },
      ]),
    ],
  );
  await mkdir(join(dir, "email", "local"), { recursive: true });
  await writeFile(
    join(dir, "email", "local", "box_demo1.json"),
    JSON.stringify({ password: "demo-mail-password" }),
  );
  await core.email.accountOf("local", "box_demo1");
}
// The setup wizard, already completed, with hooks that change nothing (no keys, no engine).
const setup = new SetupService({
  // DEMO_KEYS: the pictures key set by the administrator (an environment variable).
  ...(process.env.DEMO_KEYS && { locked: { images: true } }),
  db: core.db,
  core,
  dataDir: join(dir, "data"),
  ownerId: "local",
  // GitHub acted out: tokens with "good" in them work.
  git: new GitHosts({
    fetch: async (url, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (String(url).endsWith("/user"))
        return auth.includes("good")
          ? Response.json(
              { login: "mario" },
              { headers: { "github-authorization-token-expiration": "2027-11-03 10:00:00 UTC" } },
            )
          : new Response("{}", { status: 401 });
      return new Response("{}", { status: 201 });
    },
  }),
  hooks: {
    // DEMO_NVIDIA=1 (with REDGIANT_HOST_GPUS) shows a computer with an NVIDIA card.
    dockerRuntimes: async () => (process.env.DEMO_NVIDIA ? ["nvidia"] : []),
    // «Next layer ahead» (G32.2): DEMO_PREFETCH=available|missing shows its switch on Windows.
    ...(process.env.DEMO_PREFETCH && {
      moePrefetchBinaries: async () => process.env.DEMO_PREFETCH,
    }),
    // Keys "work" unless they contain "wrong", to show both answers.
    key: async (id, key) => {
      if (key?.includes("wrong"))
        throw new ProviderError(`${id}: HTTP 401`, false, { status: 401 });
      return key ? [`${id}-large`, `${id}-small`] : [];
    },
    server: async (cfg) => (cfg ? ["qwen3-8b"] : []),
    // Claude's sign-in with the stand-in of the tests: the code "good-code#abc" works.
    claudeSubscription: async () => {},
    claudeAuth: () => ({
      configDir: join(dir, "claude"),
      command: [
        process.execPath,
        fileURLToPath(new URL("../../subscriptions/test/fake-claude.mjs", import.meta.url)),
      ],
    }),
    telegram: async () => null,
    search: async () => {},
    // The local engine's steps, acted out: a file called "huge…" runs out of memory.
    engine: async (cfg, h) => {
      if (!cfg || !h) return;
      h.step("image");
      for (let i = 0; i <= 10; i++) {
        h.progress(i * 30_000_000, 300_000_000);
        await new Promise((r) => setTimeout(r, 300));
      }
      h.step("start");
      await new Promise((r) => setTimeout(r, 800));
      h.step("load");
      await new Promise((r) => setTimeout(r, 1500));
      if (cfg.model.startsWith("huge"))
        throw new JobFailure(
          "out_of_memory",
          "ggml_backend_cuda_buffer_type_alloc_buffer: allocating 21000 MiB on device 0: cudaMalloc failed: out of memory",
        );
      core.providers.register(new FakeProvider(() => ({ text: "OK" }), { id: "local" }));
    },
    // Tailscale acted out: a sign-in page, then a safe address.
    remote: async (req, h) => {
      if (!req) return null;
      h?.step("remote_image");
      await new Promise((r) => setTimeout(r, 800));
      h?.step("remote_start");
      await new Promise((r) => setTimeout(r, 800));
      h?.step("remote_login");
      h?.info({ url: "https://login.tailscale.com/a/demo" });
      await new Promise((r) => setTimeout(r, 4000));
      h?.step("remote_https");
      await new Promise((r) => setTimeout(r, 800));
      return { url: "https://redgiant.tail1234.ts.net" };
    },
    // Pi-hole acted out: a busy port at one address, otherwise its steps.
    pihole: async (o, h) => {
      if (!o) return null;
      for (const step of ["pihole_image", "pihole_start", "pihole_check"]) {
        h?.step(step);
        await new Promise((r) => setTimeout(r, 600));
        if (o.lanIp === "10.0.0.53" && step === "pihole_start")
          throw new JobFailure("port_busy", "Port 53 on 10.0.0.53 is already used by another DNS");
      }
      return { adminUrl: `http://${o.lanIp}:8053/admin/` };
    },
    // Gitea's steps, acted out.
    gitea: async (cfg, h) => {
      if (!cfg) return null;
      for (const step of ["gitea_image", "gitea_start", "account"]) {
        h?.step(step);
        await new Promise((r) => setTimeout(r, 1200));
      }
      return { token: "0123456789abcdef0123456789abcdef", publicUrl: "http://localhost:3000" };
    },
  },
});
await mkdir(join(dir, "claude"), { recursive: true });
// Two models already in the folder, to start (one too big for the GPU).
await mkdir(join(dir, "models"), { recursive: true });
await writeFile(join(dir, "models", "my-model-Q4_K_M.gguf"), "demo");
await writeFile(join(dir, "models", "huge-model-Q8_0.gguf"), "demo");
// A download paused halfway (2026-11-05): the «Downloaded models» card lists it too.
await writeFile(join(dir, "models", "Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf.part"), "demo-part");
// The shared memory (G33.2): some facts learned from a conversation, one written by hand, and the
// secretary's own memory.
{
  const from = { by: "auto", sessionId: sid, agentId: orch.id };
  await core.sharedMemory.add("local", "Si chiama Severino e scrive in italiano", from);
  await core.sharedMemory.add(
    "local",
    "Preferisce risposte brevi, con un elenco quando serve",
    from,
  );
  await core.sharedMemory.add("local", "Lavora su RedGiant, un monorepo TypeScript con pnpm", from);
  await core.sharedMemory.add("local", "Ha un PC fisso con Windows chiamato Rig", {
    by: secretary.id,
    agentId: secretary.id,
  });
  await core.sharedMemory.add("local", "Il lunedì mattina non fissare appuntamenti", {
    by: "human",
  });
  await core.notes.set(
    { ownerId: "local", agentId: secretary.id },
    "self",
    "- Il punto della giornata alle 8, in tre righe\n- Le riunioni del giovedì sono con lo studio Bianchi",
  );
}
// G34: DEMO_SAMPLES=<folder>: God shows every file of it in the canvas, one message each.
// p3.3.1, DEMO_SUBAGENTS=1: God's conversation with sub-agents at work (one finished, one failed,
// one waiting for the person's yes with a sub-agent of its own), and a local model's file as a
// model (its name, not its path, in the agent's card).
let subSession;
if (process.env.DEMO_SUBAGENTS) {
  await core.registry.configure(me, secretary.id, {
    model: {
      provider: "local",
      model:
        "C:\\Users\\Pixel\\AppData\\Local\\RedGiant\\engine\\models\\GLM-4.5-Air-Q4_K_S-00001-of-00002.gguf",
    },
  });
  // Asks before every command: the third sub-agent waits for the person's yes.
  await core.registry.configure(me, researcher.id, { mode: "manual" });
  subSession = await core.startSession("local", god.id);
  const at = (sessionId, agentId, body) =>
    core.store.append({ ownerId: "local", projectId: null, agentId, sessionId, body });
  await at(subSession, null, {
    type: "message.user",
    payload: { text: "Prepare release 3.3.1: find what to change, write the tests and publish." },
  });
  await at(subSession, god.id, {
    type: "message.assistant",
    payload: {
      parts: [{ type: "text", text: "Splitting the work among three sub-agents." }],
      metrics: {
        inputTokens: 9000,
        outputTokens: 300,
        cachedReadTokens: 8000,
        contextUsed: 9300,
        contextWindow: 200000,
        startedAt: new Date().toISOString(),
        source: "server",
      },
      costUsd: 0.01,
      model: "claude-opus-5-5",
      stopReason: "tool_use",
    },
  });
  const work = [
    ["Find the files to change", "Find the files in the project that 3.3.1 must change.", "done"],
    ["Write the tests", "Write the integration tests for the PSD conversion.", "failed"],
    ["Publish the package", "Publish the npm package of 3.3.1.", null],
  ];
  for (const [title, task, end] of work) {
    const child = await core.startSession("local", researcher.id);
    await at(subSession, god.id, {
      type: "subagent.started",
      payload: {
        childSessionId: child,
        childAgentId: researcher.id,
        via: "ask_assistant",
        title,
        task,
      },
    });
    const { done } = await core.send("local", child, `Task from God: «${title}»\n\n${task}`);
    if (end) {
      await done;
      await at(subSession, god.id, {
        type: "subagent.ended",
        payload: { childSessionId: child, status: end, summary: title },
      });
    } else {
      done.catch(() => {});
      // Its own sub-agent, finished.
      const grand = await core.startSession("local", researcher.id);
      await at(child, researcher.id, {
        type: "subagent.started",
        payload: {
          childSessionId: grand,
          childAgentId: researcher.id,
          via: "run_subagent",
          title: "Check the changelog",
          task: "Check that the 3.3.1 changelog is complete.",
        },
      });
      await (await core.send("local", grand, "Task from Researcher: «Check the changelog»")).done;
      await at(child, researcher.id, {
        type: "subagent.ended",
        payload: { childSessionId: grand, status: "done", summary: "ok" },
      });
    }
  }
}
if (subSession)
  await (await core.send("local", subSession, "Start the test server, the tests and the build."))
    .done;
// G36.16, G36.17, DEMO_REQUESTS=1: background commands without a time limit, and «Non chiedermi
// niente»: the classifier said yes to an install, no to a deletion, answered a question, and a
// push (only the person approves it) still reaches the person and waits for their answer.
if (process.env.DEMO_REQUESTS) {
  await core.config.setPersonSettings("local", "human", "commands", {
    maxPerSession: 8,
    maxMs: null,
    maxLogBytes: 64 * 1024 * 1024,
    bashMaxMs: 600_000,
  });
  await core.config.setPersonSettings("local", "human", "requests", { mode: "classifier" });
  const sid = await core.startSession("local", researcher.id);
  await core.store.append({
    ownerId: "local",
    projectId: null,
    agentId: researcher.id,
    sessionId: sid,
    body: { type: "message.user", payload: { text: "Aggiorna i test del modulo di login." } },
  });
  let n = 0;
  const ask = (command, danger, critical) =>
    core.person.approve(
      {
        requestId: `demo_${++n}`,
        requester: core.registry.get(researcher.id),
        call: { callId: `c${n}`, name: "bash", input: { command } },
        reasons: ["Runs a command"],
        danger,
        sessionId: sid,
      },
      new AbortController().signal,
      { kind: "approval", critical, what: `bash: ${command}` },
    );
  await ask("npm install", [], false);
  await core.person.ask(
    core.registry.get(god.id),
    {
      requestId: "demo_q",
      sessionId: sid,
      agentId: god.id,
      agentName: "God",
      projectId: null,
      questions: [
        {
          question: "Quale database per la prova?",
          options: [{ label: "Postgres" }, { label: "SQLite" }],
          multiSelect: false,
        },
      ],
      createdAt: new Date().toISOString(),
    },
    undefined,
    "question",
  );
  await ask("rm -rf build/ dist/ node_modules/", ["rm-recursive"], false);
  // An ordinary push: the classifier decides it like the rest (G36.17b).
  await ask("git push origin feature/login", ["git-push"], false);
  // A truly dangerous request: asked of the person even with «Non chiedermi niente» (not awaited).
  void ask("git push --force origin main", ["git-push", "git-history", "critical-delete"], true);
}
let viewerSession;
// G36.12, DEMO_CANVAS=1: files for an agent that looks at the canvas and leafs through it.
let canvasSession;
if (process.env.DEMO_CANVAS) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const into = join(core.platformPath("local"), "canvas");
  await mkdir(into, { recursive: true });
  await writeFile(
    join(into, "conti.csv"),
    "Mese,Affitto,Luce,Internet\nGennaio,650,82.40,29.90\nFebbraio,650,77.10,29.90\nMarzo,650,69.80,29.90\nAprile,650,58.30,29.90\nMaggio,650,51.00,29.90\n",
  );
  const code = [
    "# A small shop: prices, the cart and its total.",
    "from dataclasses import dataclass",
    "",
    "",
    "@dataclass",
    "class Item:",
    "    name: str",
    "    price: float",
    "    qty: int = 1",
    "",
    "",
    "def total(cart: list[Item], vat: float = 0.22) -> float:",
    '    """The cart\'s total with VAT, rounded to the cent."""',
    "    net = sum(i.price * i.qty for i in cart)",
    "    if net <= 0:",
    "        return 0.0",
    "    gross = net * (1 + vat)",
    "    return round(gross, 2)",
    "",
    "",
    ...Array.from({ length: 40 }, (_, i) => `PRICE_${i + 1} = ${(i + 1) * 1.5}`),
  ].join("\n");
  await writeFile(join(into, "app.py"), `${code}\n`);
  // A chair: four legs, the seat and the back, each a box.
  const boxes = [
    [0, 0, 0, 0.1, 1, 0.1],
    [0.9, 0, 0, 1, 1, 0.1],
    [0, 0, 0.9, 0.1, 1, 1],
    [0.9, 0, 0.9, 1, 1, 1],
    [0, 1, 0, 1, 1.12, 1],
    [0, 1.12, 0.9, 1, 2.1, 1],
  ];
  const v = [];
  const f = [];
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    const b = v.length;
    for (const [x, y, z] of [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y1, z0],
      [x0, y1, z0],
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ])
      v.push(`v ${x} ${y} ${z}`);
    for (const q of [
      [1, 2, 3, 4],
      [5, 8, 7, 6],
      [1, 5, 6, 2],
      [2, 6, 7, 3],
      [3, 7, 8, 4],
      [4, 8, 5, 1],
    ])
      f.push(`f ${q.map((n) => n + b).join(" ")}`);
  }
  await writeFile(join(into, "sedia.obj"), `${v.join("\n")}\n${f.join("\n")}\n`);
  // G37.1: a plain text note the person and the agent edit together.
  await writeFile(
    join(into, "spesa.txt"),
    "Spesa per sabato\n- latte\n- uova\n- farina\n\nRitiro in negozio alle 18, porta le borse.\n",
  );
  // G37.3: sheets: a CSV, an ODS with a chart and a pivot table, an XLSX edited on its ODS copy.
  await writeFile(
    join(into, "spese.csv"),
    "Voce,Gennaio,Febbraio,Marzo\nAffitto,650,650,650\nLuce,82.4,77.1,69.8\nInternet,29.9,29.9,29.9\nTotale,=SUM(B2:B4),=SUM(C2:C4),=SUM(D2:D4)\n",
  );
  const { copyFile } = await import("node:fs/promises");
  const sheets = new URL("../../server/test/fixtures/sheets/", import.meta.url);
  await copyFile(new URL("vendite.ods", sheets), join(into, "vendite.ods"));
  await copyFile(new URL("bilancio.xlsx", sheets), join(into, "bilancio.xlsx"));
  // G37.2: Markdown and JSON edited as text, beside the code (app.py).
  await writeFile(
    join(into, "guida.md"),
    [
      "# Guida del negozio",
      "",
      "Aperto dal **martedì al sabato**, dalle 9 alle 19. Il lunedì si fa l'inventario.",
      "",
      "- Le consegne arrivano il mercoledì",
      "- Il pane fresco il venerdì mattina",
      "- Le borse di carta stanno sotto il banco",
      "",
      "## Prezzi",
      "",
      "| Prodotto | Prezzo |",
      "| --- | ---: |",
      "| Pane | 3,20 € |",
      "| Latte | 1,40 € |",
      "",
      "I prezzi si aggiornano in `app.py` (vedi la funzione `total`).",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(into, "config.json"),
    `${JSON.stringify(
      {
        negozio: "Bottega di Ada",
        iva: 0.22,
        aperto: true,
        orari: { martedi: "9-19", sabato: "9-13" },
        consegne: ["mercoledi", "venerdi"],
      },
      null,
      2,
    )}\n`,
  );
  canvasSession = await core.startSession("local", god.id);
  await (await core.send("local", canvasSession, "Mostra il file canvas/spesa.txt")).done;
  await (await core.send("local", canvasSession, "Mostra il file canvas/vendite.ods")).done;
  await (await core.send("local", canvasSession, "Mostra il file canvas/spese.csv")).done;
  await (await core.send("local", canvasSession, "Mostra il file canvas/bilancio.xlsx")).done;
  const codeSession = await core.startSession("local", god.id);
  for (const f of ["config.json", "guida.md", "app.py"])
    await (await core.send("local", codeSession, `Mostra il file canvas/${f}`)).done;
}
if (process.env.DEMO_SAMPLES) {
  const { cp, readdir } = await import("node:fs/promises");
  const into = join(core.platformPath("local"), "campioni");
  await cp(process.env.DEMO_SAMPLES, into, { recursive: true });
  viewerSession = await core.startSession("local", god.id);
  for (const f of (await readdir(into)).sort())
    await (await core.send("local", viewerSession, `Mostra il file campioni/${f}`)).done;
}
// DEMO_UPDATE=mandatory|breaking (G36.19): a newer release with signed metadata, as GitHub would
// serve it; DEMO_INSTALL=windows|mac|docker says how this RedGiant is installed. DEMO_FOUND=1 puts
// a safety backup in the folder a breaking update uses (the wizard offers it with DEMO_FRESH=1).
if (process.env.DEMO_UPDATE || process.env.DEMO_FOUND) {
  const { generateKeyPairSync, sign } = await import("node:crypto");
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kind = process.env.DEMO_UPDATE ?? "normal";
  const info = Buffer.from(
    `${JSON.stringify({
      format: 1,
      version: "3.5.0",
      kind,
      note: {
        it: "Il database cambia forma per la memoria nuova: sopra la 3.4 non si aggiorna.",
        en: "The database changes shape for the new memory: it cannot update over 3.4.",
      },
    })}\n`,
  );
  const files = {
    "release.json": info,
    "release.json.sig": Buffer.from(sign("sha256", info, keys.privateKey).toString("base64")),
  };
  const docs = join(dir, "Documents");
  core.updates = new UpdateWatcher({
    install: process.env.DEMO_INSTALL ?? "windows",
    installed: "3.4.0",
    dataDir: dir,
    backupBase: process.env.DEMO_INSTALL === "docker" ? "/data/RedGiant-backups" : docs,
    feed: "https://demo.feed/latest",
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    launcher: true,
    composeDir: "~/redgiant",
    act: async () => true,
    fetch: async (url) => {
      if (url === "https://demo.feed/latest")
        return Response.json({
          tag_name: "v3.5.0",
          assets: Object.keys(files).map((name) => ({
            name,
            browser_download_url: `https://demo.feed/${name}`,
          })),
        });
      return new Response(files[url.split("/").pop()]);
    },
  });
  if (process.env.DEMO_UPDATE) await core.updates.check();
  if (process.env.DEMO_FOUND) {
    const jobs = core.jobs;
    const job = jobs.start("local", "x", ["data", "conversations", "files"], (h) =>
      exportBackup(
        core.backupDeps,
        "local",
        join(docs, "RedGiant-backup-2026-11-08", "redgiant-3.4.0-0930.rgbackup"),
        h,
        undefined,
        { full: true, version: "3.4.0" },
      ),
    );
    for (let i = 0; i < 200 && jobs.get("local", job.id)?.state === "running"; i++)
      await new Promise((r) => setTimeout(r, 50));
  }
}
// G36.22–24, DEMO_CHAT_TOOLS=1: a plan answered in parts (a quote with its reply), a side question
// «Intanto», and a branch that goes on from the plan.
let toolsSession;
let branchSession;
if (process.env.DEMO_CHAT_TOOLS) {
  toolsSession = await core.startSession("local", god.id);
  await (await core.send("local", toolsSession, "Come organizzo il lancio del nuovo prodotto?"))
    .done;
  const plan = (await core.history("local", toolsSession)).findLast(
    (e) => e.type === "message.assistant",
  );
  await (
    await core.send("local", toolsSession, "Per il resto va bene.", {
      watch: true,
      quotes: [
        {
          seq: plan.seq,
          at: plan.ts,
          text: "una demo dal vivo di venti minuti, registrata e messa sul sito",
          reply: "Venti minuti sono troppi, e dal vivo mi agita: si può fare diversamente?",
        },
      ],
    })
  ).done;
  await core.aside("local", toolsSession, "Quanto dovrebbe durare una demo, di solito?");
  branchSession = await core.forkSession("local", toolsSession, { fromSeq: plan.seq });
  await (await core.send("local", branchSession, "E se rimandassimo il lancio di due settimane?"))
    .done;
}
// DEMO_KNOWLEDGE=1 (G36.5-G36.6): the knowledge with three collections, one still being read
// (stopped a third of the way, so its bar and time left show), a picture waiting for the OCR, and a
// conversation whose answer cites the documents. Embeddings acted out (no model).
let knowledgeSession;
if (process.env.DEMO_KNOWLEDGE) {
  const { cp } = await import("node:fs/promises");
  const { KnowledgeService, LocalEmbedServers } = await import("@redgiant/server");
  const dims = 768;
  const embed = (t) => {
    const v = new Array(dims).fill(0);
    for (const w of t.toLowerCase().match(/[\p{L}0-9]+/gu) ?? []) {
      let h = 2166136261;
      for (const c of w.slice(0, 6)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
      v[Math.abs(h) % dims] += 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  };
  const kdir = join(dir, "data");
  const local = new LocalEmbedServers({ dataDir: kdir, jobs: core.jobs });
  // The local model counts as downloaded; its answers come from `embed`.
  local.ready = async () => true;
  const k = new KnowledgeService({
    db: core.db,
    store: core.store,
    jobs: core.jobs,
    dataDir: kdir,
    local,
    keyedFetch: () => {
      throw new Error("no keys in the demo");
    },
    scopeRoot: (o, scope) => core.scopeFolder(o, scope),
    chats: core.knowledgeChats(),
    // A mailbox acted out (no IMAP): two messages.
    mail: {
      boxes: async () => [{ id: "box_lavoro", name: "Lavoro" }],
      list: async () => [
        { id: "11", title: "Preventivo cucina", at: Date.now() - 86_400_000, size: 900 },
        { id: "12", title: "Riunione di lunedì", at: Date.now() - 3_600_000, size: 400 },
      ],
      read: async (_o, _b, id) => ({
        subject: id === "11" ? "Preventivo cucina" : "Riunione di lunedì",
        from: "Rossi Arredamenti <info@rossi.example>",
        date: new Date().toISOString(),
        text: id === "11" ? "Il preventivo per la cucina è di 4.200 euro." : "Lunedì alle 10.",
      }),
    },
    agentProjects: async (_o, id) => {
      const a = core.registry.get(id);
      return a?.projectId ? [a.projectId] : [];
    },
    ocr: {
      ready: async () => false,
      ensure: async () => {},
      recognize: async () => "",
      bytes: async () => 0,
      stop: async () => {},
    },
    manual: true,
  });
  await k.start();
  k.embedderFor = async () => ({
    batch: 16,
    maxChars: 8000,
    embed: async (texts) => texts.map(embed),
  });
  core.knowledge = k;
  await k.setSettings("local", {
    embedding: { provider: "local", model: "embeddinggemma-300m" },
    ocr: { on: false, languages: ["ita", "eng"] },
  });
  const bench = fileURLToPath(
    new URL("../../server/test/fixtures/knowledge/bench/docs", import.meta.url),
  );
  const home = join(dir, "Documenti");
  await cp(bench, join(home, "Home manuals"), { recursive: true });
  await writeFile(join(home, "Home manuals", "scontrino.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
  const manuals = await k.createCollection("local", {
    name: "Home manuals",
    description: "Warranties, instructions and recipes",
    language: "italian",
  });
  await k.addSource("local", manuals.id, { kind: "folder", path: join(home, "Home manuals") });
  const notes = await k.createCollection("local", {
    name: "Project notes",
    scope: { kind: "project", projectId: "demo" },
    language: "italian",
  });
  await k.addSource("local", notes.id, { kind: "workspace", scope: "project:demo" });
  await k
    .addSource("local", notes.id, { kind: "url", url: "https://example.org/" })
    .catch(() => {});
  await k.indexer.drain();
  // A big archive, read half-way and paused: the page shows its bar and the time left.
  const archive = join(home, "Client archive");
  await mkdir(archive, { recursive: true });
  for (let i = 1; i <= 600; i++)
    await writeFile(
      join(archive, `cliente-${String(i).padStart(3, "0")}.md`),
      `# Cliente ${i}\n\nContratto firmato il ${(i % 28) + 1} marzo. Rinnovo annuale, ${i % 3 ? "pagamento a 30 giorni" : "pagamento anticipato"}.\n\n## Note\n\nReferente: ufficio acquisti. Ultimo ordine: ${i * 7} pezzi.\n`,
    );
  const big = await k.createCollection("local", {
    name: "Client archive",
    scope: { kind: "agent", agentId: god.id },
    language: "italian",
  });
  await k.addSource("local", big.id, { kind: "folder", path: archive });
  // Everything read, about a third embedded (with a pace to tell the time left).
  await k.indexer.step();
  while ((await k.status("local")).queue.documents > 0) await k.indexer.step();
  for (let i = 0; i < 13; i++) {
    await k.indexer.step();
    await new Promise((r) => setTimeout(r, 250));
  }
  // Nothing more is read (the demo's queue does not run): the page shows the bar and the time
  // left at the pace measured above.
  knowledgeSession = await core.startSession("local", god.id);
  await (await core.send("local", knowledgeSession, "Quanto dura la garanzia della lavatrice?"))
    .done;
}
await debugLog.configure({ dir: join(dir, "logs") });
await setup.applyAtStartup();
core.vaultSystem = async () => setup.keysForVault();
// DEMO_FRESH=1: a fresh install, the setup wizard takes the whole page (2026-11-06).
if (!process.env.DEMO_FRESH) await setup.complete();
const running = await serve(core, new TokenAuth({ [token]: "local" }), {
  port,
  host: "0.0.0.0",
  webDir: web,
  setup,
  hf: new HuggingFace(join(dir, "models")),
});
console.log(
  JSON.stringify({
    url: running.url.replace("127.0.0.1", "0.0.0.0"),
    token,
    session: sid,
    orchestrator: orch.id,
    god: god.id,
    ...(viewerSession && { viewerSession }),
    ...(canvasSession && { canvasSession }),
    ...(knowledgeSession && { knowledgeSession }),
    ...(subSession && { subSession }),
    ...(toolsSession && { toolsSession, branchSession }),
  }),
);

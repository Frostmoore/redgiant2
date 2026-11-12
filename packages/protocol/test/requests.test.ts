// 3.5.6: an ordinary request says what happens, in the person's words and with the call's own
// arguments (the person, after approving an archive without knowing it: «forse non era stata
// abbastanza chiara la riga della spiegazione»).
import { describe, expect, it } from "vitest";
import {
  REQUEST_SENTENCE_TOOLS,
  reasonSentence,
  requestNameIds,
  requestReasons,
  requestSentence,
} from "../src/index.js";

const names = { p1: "Collaudo 3.5.3", a1: "Coder", a2: "Revisore" };

type Row = [tool: string, input: unknown, it: string, en: string];

const TABLE: Row[] = [
  // Every platform_* action.
  [
    "platform_project",
    { action: "restore", project_id: "p1" },
    "Ripristina il progetto «Collaudo 3.5.3»: i suoi agenti e le automazioni in pausa ripartono",
    "Restores the project “Collaudo 3.5.3”: its agents and paused automations start again",
  ],
  [
    "platform_project",
    { action: "archive", project_id: "p1" },
    "Archivia il progetto «Collaudo 3.5.3»: i suoi agenti si fermano e nessuno ne cambia i file finché non lo ripristini",
    "Archives the project “Collaudo 3.5.3”: its agents stop and nobody changes its files until you restore it",
  ],
  [
    "platform_project",
    { action: "archive", project_id: "p9" },
    "Archivia il progetto «p9»: i suoi agenti si fermano e nessuno ne cambia i file finché non lo ripristini",
    "Archives the project “p9”: its agents stop and nobody changes its files until you restore it",
  ],
  [
    "platform_configure_agent",
    { agent_id: "a1", model: "anthropic/claude", effort: "high", mode: "auto" },
    "Cambia le impostazioni dell'agente «Coder»: modello anthropic/claude, impegno high, modalità auto",
    "Changes the settings of the agent “Coder”: model anthropic/claude, effort high, mode auto",
  ],
  [
    "platform_configure_agent",
    { agent_id: "a1", model: null, system_prompt: "Be brief" },
    "Cambia le impostazioni dell'agente «Coder»: torna al modello ereditato, nuove istruzioni",
    "Changes the settings of the agent “Coder”: back to the inherited model, new instructions",
  ],
  [
    "platform_set_budget",
    { scope: "project", id: "p1", usd: 5 },
    "Mette un limite di spesa di 5 USD per il progetto «Collaudo 3.5.3»",
    "Sets a spending limit of 5 USD for the project “Collaudo 3.5.3”",
  ],
  [
    "platform_set_budget",
    { scope: "agent", id: "a2", usd: 2, tokens: 100000 },
    "Mette un limite di spesa di 2 USD e 100.000 token per l'agente «Revisore»",
    "Sets a spending limit of 2 USD and 100,000 tokens for the agent “Revisore”",
  ],
  [
    "platform_set_budget",
    { scope: "global" },
    "Toglie il limite di spesa per tutto",
    "Removes the spending limit for everything",
  ],
  [
    "platform_automation",
    { action: "create", yaml: "name: Rapporto del lunedì\non:\n  cron: 0 9 * * 1" },
    "Crea l'automazione «Rapporto del lunedì»",
    "Creates the automation “Rapporto del lunedì”",
  ],
  [
    "platform_automation",
    { action: "update", id: "au1", yaml: "on: {}" },
    "Cambia l'automazione «au1»",
    "Changes the automation “au1”",
  ],
  [
    "platform_automation",
    { action: "enable", id: "au1" },
    "Riattiva l'automazione «au1»",
    "Switches the automation “au1” back on",
  ],
  [
    "platform_automation",
    { action: "disable", id: "au1" },
    "Mette in pausa l'automazione «au1»",
    "Pauses the automation “au1”",
  ],
  [
    "platform_automation",
    { action: "delete", id: "au1" },
    "Cancella l'automazione «au1»",
    "Deletes the automation “au1”",
  ],
  [
    "platform_automation",
    { action: "run", id: "au1" },
    "Avvia adesso l'automazione «au1»",
    "Runs the automation “au1” now",
  ],
  [
    "platform_policy",
    {
      rules: [
        { tool: "bash", decision: "allow" },
        { tool: "fetch", decision: "ask" },
      ],
    },
    "Sostituisce le regole dei permessi di RedGiant (2 regole)",
    "Replaces RedGiant's permission rules (2 rules)",
  ],
  [
    "platform_mcp",
    { action: "add", catalog_id: "github" },
    "Aggiunge il servizio collegato «github» per tutti i progetti",
    "Adds the connected service “github” for every project",
  ],
  [
    "platform_mcp",
    { action: "add", catalog_id: "notion", project_id: "p1" },
    "Aggiunge il servizio collegato «notion» solo per il progetto «Collaudo 3.5.3»",
    "Adds the connected service “notion” only for the project “Collaudo 3.5.3”",
  ],
  [
    "platform_mcp",
    { action: "remove", name: "notion" },
    "Toglie il servizio collegato «notion»",
    "Removes the connected service “notion”",
  ],
  [
    "platform_undo",
    { change_id: "chg_7" },
    "Annulla la modifica a RedGiant chg_7",
    "Undoes the change to RedGiant chg_7",
  ],
  [
    "platform_code_start",
    { title: "Fix the bell" },
    "Inizia una modifica al codice di RedGiant: «Fix the bell»",
    "Starts a change to RedGiant's code: “Fix the bell”",
  ],
  [
    "platform_code_test",
    { change_id: "c1" },
    "Prova la modifica al codice di RedGiant c1 in una copia separata",
    "Tests the change to RedGiant's code c1 in a separate copy",
  ],
  [
    "platform_code_promote",
    { change_id: "c1" },
    "Mette in funzione la modifica al codice di RedGiant c1: RedGiant ripartirà con il codice nuovo",
    "Puts live the change to RedGiant's code c1: RedGiant restarts with the new code",
  ],
  [
    "platform_code_discard",
    { change_id: "c1" },
    "Scarta la modifica al codice di RedGiant c1",
    "Drops the change to RedGiant's code c1",
  ],
  ["platform_status", {}, "Legge lo stato di RedGiant", "Reads RedGiant's state"],
  [
    "platform_changes",
    { limit: 5 },
    "Legge le ultime modifiche a RedGiant",
    "Reads the latest changes to RedGiant",
  ],
  // Commands.
  [
    "bash",
    { command: "git push origin main" },
    "Esegue il comando: git push origin main",
    "Runs the command: git push origin main",
  ],
  [
    "bash",
    { command: "npm run dev", background: true },
    "Esegue in sottofondo: npm run dev",
    "Runs in the background: npm run dev",
  ],
  [
    "bash",
    { command: "rm -rf build" },
    "Cancella con il comando: rm -rf build",
    "Deletes with the command: rm -rf build",
  ],
  [
    "bash",
    { command: "rm -rf build && npm run build" },
    "Esegue il comando: rm -rf build && npm run build",
    "Runs the command: rm -rf build && npm run build",
  ],
  [
    "bash",
    { command: "cd app\nnpm test" },
    "Esegue il comando: cd app; npm test",
    "Runs the command: cd app; npm test",
  ],
  // Files: write, edit, delete.
  [
    "write_file",
    { path: "app.py", content: "x" },
    "Scrive il file app.py",
    "Writes the file app.py",
  ],
  [
    "edit_file",
    { path: "src/main.ts", old_string: "a", new_string: "b" },
    "Modifica il file src/main.ts",
    "Edits the file src/main.ts",
  ],
  ["delete_file", { path: "old.txt" }, "Cancella il file old.txt", "Deletes the file old.txt"],
  [
    "show_file",
    { path: "/etc/hosts" },
    "Ti mostra il file /etc/hosts",
    "Shows you the file /etc/hosts",
  ],
  // Agents, browser, repository, services, keys.
  [
    "delegate",
    { agent_id: "a2", title: "Review the PR", task: "..." },
    "Affida all'agente «Revisore» il compito «Review the PR»",
    "Gives the agent “Revisore” the task “Review the PR”",
  ],
  ["stop_agent", { agent_id: "a1" }, "Ferma l'agente «Coder»", "Stops the agent “Coder”"],
  [
    "create_agent",
    { name: "Tester", kind: "agent", project_id: "p1" },
    "Crea l'agente «Tester» nel progetto «Collaudo 3.5.3»",
    "Creates the agent “Tester” in the project “Collaudo 3.5.3”",
  ],
  [
    "set_agent_model",
    { agent_id: "a1", provider: "anthropic", model: "claude-x", effort: "high" },
    "Passa l'agente «Coder» al modello «anthropic/claude-x» (effort high)",
    "Moves the agent “Coder” to the model “anthropic/claude-x” (effort high)",
  ],
  [
    "browser_click",
    { name: "Invia" },
    "Preme «Invia» nel browser",
    "Presses “Invia” in the browser",
  ],
  [
    "repo_pull_request",
    { title: "Fix login", body: "", head: "fix" },
    "Apre una pull request sul repository: «Fix login»",
    "Opens a pull request on the repository: “Fix login”",
  ],
  [
    "mcp__gmail__send_email",
    { to: "anna@example.com" },
    "Usa «send email» del servizio collegato «gmail»",
    "Uses “send email” of the connected service “gmail”",
  ],
  [
    "use_credential",
    { credential: "gh", service: "GitHub", host: "api.github.com" },
    "Usa la chiave «GitHub» del tuo portachiavi per api.github.com (l'agente non la vede)",
    "Uses the key “GitHub” from your keychain for api.github.com (the agent never sees it)",
  ],
  [
    "automation_run",
    { automation: "Rapporto", started_by: "cron" },
    "Avvia l'automazione «Rapporto»",
    "Runs the automation “Rapporto”",
  ],
  // The fallback: never the raw input.
  ["weird_tool", { a: 1 }, "Usa lo strumento weird_tool", "Uses the tool weird_tool"],
  ["mcp__broken", null, "Usa lo strumento mcp__broken", "Uses the tool mcp__broken"],
];

describe("requestSentence (3.5.6): what a request does, in words", () => {
  it.each(TABLE)("%s %j", (tool, input, it_, en) => {
    expect(requestSentence("it", tool, input, names)).toBe(it_);
    expect(requestSentence("en", tool, input, names)).toBe(en);
  });

  it("covers every platform_* tool and the file tools", () => {
    const tested = new Set(TABLE.map((r) => r[0]));
    for (const t of REQUEST_SENTENCE_TOOLS.filter((x) => x.startsWith("platform_")))
      expect(tested.has(t), t).toBe(true);
    for (const t of ["bash", "write_file", "edit_file", "delete_file"])
      expect(tested.has(t), t).toBe(true);
  });

  it("takes names from a lookup too, and cuts a very long command", () => {
    const s = requestSentence(
      "it",
      "platform_project",
      { action: "restore", project_id: "x" },
      (id) => (id === "x" ? "Sito" : undefined),
    );
    expect(s).toMatch(/^Ripristina il progetto «Sito»/);
    const long = requestSentence("en", "bash", { command: `echo ${"a".repeat(400)}` });
    expect(long.length).toBeLessThan(200);
    expect(long.endsWith("…")).toBe(true);
  });

  it("finds the ids worth a name", () => {
    expect(requestNameIds("platform_project", { action: "archive", project_id: "p1" })).toEqual([
      "p1",
    ]);
    expect(requestNameIds("platform_set_budget", { scope: "agent", id: "a1" })).toEqual(["a1"]);
    expect(requestNameIds("platform_set_budget", { scope: "global", id: "me" })).toEqual([]);
    expect(requestNameIds("bash", { command: "ls" })).toEqual([]);
    expect(requestNameIds("bash", null)).toEqual([]);
  });
});

describe("the reasons the person reads (3.5.6)", () => {
  const REASONS: [string, string | undefined, string | undefined][] = [
    // The danger rules' labels are said by the danger chips; the critical lines by the red card.
    ["Changes the platform", undefined, undefined],
    ["git push", undefined, undefined],
    ["truly dangerous: force-pushes main", undefined, undefined],
    [
      "manual mode",
      "L'agente è in modalità manuale: chiede prima di ogni modifica",
      "The agent is in manual mode: it asks before every change",
    ],
    [
      "rule: ask bash",
      "Una tua regola chiede conferma per bash",
      "One of your rules asks before bash",
    ],
    [
      "writes outside the project: /home/me/x.txt",
      "Scrive fuori dalla cartella del progetto: /home/me/x.txt",
      "Writes outside the project's folder: /home/me/x.txt",
    ],
    [
      "shows a file outside the project: /etc/hosts",
      "Mostra un file fuori dalla cartella del progetto: /etc/hosts",
      "Shows a file outside the project's folder: /etc/hosts",
    ],
    [
      'Uses "GitHub" from your keychain (the agent never sees it)',
      "Usa «GitHub» dal tuo portachiavi (l'agente non la vede)",
      "Uses “GitHub” from your keychain (the agent never sees it)",
    ],
    // Unknown (a rule the person wrote): only in the details.
    ["My own rule", undefined, undefined],
  ];
  it.each(REASONS)("%s", (raw, it_, en) => {
    expect(reasonSentence("it", raw)).toBe(it_);
    expect(reasonSentence("en", raw)).toBe(en);
  });

  it("a request's reasons, translated and without repeats", () => {
    expect(
      requestReasons("it", { reasons: ["manual mode", "Changes the platform", "manual mode"] }),
    ).toEqual(["L'agente è in modalità manuale: chiede prima di ogni modifica"]);
    expect(requestReasons("it", { reasons: ["Changes the platform"] })).toEqual([]);
  });
});

/**
 * What an ordinary permission request does, in a sentence the person reads (3.5.6, after two
 * approvals given in seconds without knowing what they were: «non mi pare di aver cliccato
 * consenti… forse non era stata abbastanza chiara la riga della spiegazione»). The card on the
 * page, the bell and every linked chat start from this sentence, built from the call's own
 * arguments in the person's language; the raw input and the policy's English reasons stay folded
 * in the details. The truly dangerous requests keep their own words (`criticalSentence`).
 */

import { ARTIFACT_GRANT_TOOL, grantSentence } from "./artifact-bridge.js";
import { preparedMailOf } from "./mail.js";

type Lang = "it" | "en";
const lng = (lang: string): Lang => (lang === "it" ? "it" : "en");

/** Names of the projects and agents a request mentions by id: a map, or a lookup. */
export type RequestNames =
  | Readonly<Record<string, string>>
  | ((id: string) => string | undefined)
  | undefined;

type Input = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** A long argument cut to one readable line. */
const short = (s: string, max = 160) => {
  const line = s.replace(/\s*\n\s*/g, "; ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const quote = (l: Lang, s: string) => (l === "it" ? `«${s}»` : `“${s}”`);

/** The ids a request mentions (projects, agents), for whoever can turn them into names. */
export function requestNameIds(tool: string, input: unknown): string[] {
  const i = (input && typeof input === "object" ? input : {}) as Input;
  const ids = [i.project_id, i.agent_id, i.project];
  if (tool === "platform_set_budget" && i.scope !== "global") ids.push(i.id);
  return [...new Set(ids.map(str).filter((x): x is string => !!x))];
}

type Ctx = {
  l: Lang;
  i: Input;
  /** A project's or agent's name in quotes, its id when nobody knows it. */
  name: (id: unknown) => string;
  q: (s: string) => string;
};

/** The parts of an agent's settings a change touches. */
function configureParts({ l, i }: Ctx): string {
  const it = l === "it";
  const parts: string[] = [];
  if (i.model === null)
    parts.push(it ? "torna al modello ereditato" : "back to the inherited model");
  else if (str(i.model)) parts.push(it ? `modello ${str(i.model)}` : `model ${str(i.model)}`);
  if (str(i.effort)) parts.push(it ? `impegno ${str(i.effort)}` : `effort ${str(i.effort)}`);
  if (str(i.mode)) parts.push(it ? `modalità ${str(i.mode)}` : `mode ${str(i.mode)}`);
  if (i.system_prompt === null)
    parts.push(it ? "torna alle istruzioni di partenza" : "back to the default instructions");
  else if (str(i.system_prompt)) parts.push(it ? "nuove istruzioni" : "new instructions");
  return parts.length ? `: ${parts.join(", ")}` : "";
}

function budgetSentence({ l, i, name }: Ctx): string {
  const it = l === "it";
  const scope =
    i.scope === "global"
      ? it
        ? "per tutto"
        : "for everything"
      : i.scope === "project"
        ? it
          ? `per il progetto ${name(i.id)}`
          : `for the project ${name(i.id)}`
        : it
          ? `per l'agente ${name(i.id)}`
          : `for the agent ${name(i.id)}`;
  const usd = num(i.usd);
  const tokens = num(i.tokens);
  const limits = [
    ...(usd !== undefined ? [`${usd} USD`] : []),
    ...(tokens !== undefined
      ? [`${tokens.toLocaleString(it ? "it-IT" : "en-US")} ${it ? "token" : "tokens"}`]
      : []),
  ];
  if (limits.length === 0)
    return it ? `Toglie il limite di spesa ${scope}` : `Removes the spending limit ${scope}`;
  const what = limits.join(it ? " e " : " and ");
  return it
    ? `Mette un limite di spesa di ${what} ${scope}`
    : `Sets a spending limit of ${what} ${scope}`;
}

function automationSentence({ l, i, q }: Ctx): string {
  const it = l === "it";
  const yamlName = str(i.yaml)?.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1];
  const which = yamlName ?? str(i.id);
  const a = which ? ` ${q(which)}` : "";
  switch (i.action) {
    case "create":
      return it ? `Crea l'automazione${a}` : `Creates the automation${a}`;
    case "update":
      return it ? `Cambia l'automazione${a}` : `Changes the automation${a}`;
    case "enable":
      return it ? `Riattiva l'automazione${a}` : `Switches the automation${a} back on`;
    case "disable":
      return it ? `Mette in pausa l'automazione${a}` : `Pauses the automation${a}`;
    case "delete":
      return it ? `Cancella l'automazione${a}` : `Deletes the automation${a}`;
    case "run":
      return it ? `Avvia adesso l'automazione${a}` : `Runs the automation${a} now`;
    default:
      return it ? `Cambia un'automazione${a}` : `Changes an automation${a}`;
  }
}

function policySentence({ l, i }: Ctx): string {
  const it = l === "it";
  const n = Array.isArray(i.rules) ? i.rules.length : 0;
  const rules = it ? (n === 1 ? "1 regola" : `${n} regole`) : n === 1 ? "1 rule" : `${n} rules`;
  return it
    ? `Sostituisce le regole dei permessi di RedGiant (${rules})`
    : `Replaces RedGiant's permission rules (${rules})`;
}

function mcpSentence({ l, i, name, q }: Ctx): string {
  const it = l === "it";
  if (i.action === "remove")
    return it
      ? `Toglie il servizio collegato ${q(str(i.name) ?? "?")}`
      : `Removes the connected service ${q(str(i.name) ?? "?")}`;
  const where = str(i.project_id)
    ? it
      ? ` solo per il progetto ${name(i.project_id)}`
      : ` only for the project ${name(i.project_id)}`
    : it
      ? " per tutti i progetti"
      : " for every project";
  return it
    ? `Aggiunge il servizio collegato ${q(str(i.catalog_id) ?? "?")}${where}`
    : `Adds the connected service ${q(str(i.catalog_id) ?? "?")}${where}`;
}

/** A command that only deletes (rm, del, Remove-Item): said as a deletion. */
const DELETES = /^\s*(sudo\s+)?(rm|rmdir|del|erase|rd|Remove-Item)\b/i;

function bashSentence({ l, i }: Ctx): string {
  const it = l === "it";
  const cmd = str(i.command) ?? "";
  const bg = i.background === true;
  if (DELETES.test(cmd) && !/[;&|]/.test(cmd))
    return it
      ? `Cancella con il comando: ${short(cmd)}`
      : `Deletes with the command: ${short(cmd)}`;
  if (bg)
    return it ? `Esegue in sottofondo: ${short(cmd)}` : `Runs in the background: ${short(cmd)}`;
  return it ? `Esegue il comando: ${short(cmd)}` : `Runs the command: ${short(cmd)}`;
}

/** The services' own tools (`mcp__<server>__<tool>`): the action and the service. */
function mcpToolSentence(l: Lang, tool: string, q: (s: string) => string): string {
  const [, server = "", name = ""] = tool.split("__");
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return l === "it"
    ? `Usa ${q(words)} del servizio collegato ${q(server)}`
    : `Uses ${q(words)} of the connected service ${q(server)}`;
}

/** Addresses as a list the person reads: «anna@x.it, bob@y.it e altri 3». */
function people(l: Lang, list: string[]): string {
  if (list.length === 0) return "?";
  const shown = list.slice(0, 3).join(", ");
  const more = list.length - 3;
  if (more <= 0) return shown;
  return l === "it" ? `${shown} e altri ${more}` : `${shown} and ${more} more`;
}

const addresses = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : [])
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean);

/** An email leaving (G38.1): to whom, with which subject and from which mailbox. */
function mailSendSentence({ l, i, q }: Ctx): string {
  const it = l === "it";
  const m = preparedMailOf(i);
  const to = m ? [...m.to, ...m.cc, ...m.bcc] : addresses(i.to);
  const subject = m?.subject ?? str(i.subject);
  const box = m?.mailbox || str(i.mailbox);
  if (!m && to.length === 0 && num(i.draft_id) !== undefined)
    return it ? `Invia la bozza ${num(i.draft_id)}` : `Sends the draft ${num(i.draft_id)}`;
  const files = m?.attachments.length ?? (Array.isArray(i.attachments) ? i.attachments.length : 0);
  const parts = [
    it ? `Invia un'email a ${people(l, to)}` : `Sends an email to ${people(l, to)}`,
    subject
      ? it
        ? ` con oggetto ${q(short(subject, 100))}`
        : ` with the subject ${q(short(subject, 100))}`
      : "",
    files
      ? it
        ? `, ${files === 1 ? "1 allegato" : `${files} allegati`}`
        : `, ${files === 1 ? "1 attachment" : `${files} attachments`}`
      : "",
    box ? (it ? `, dalla casella ${q(box)}` : `, from the mailbox ${q(box)}`) : "",
  ];
  return parts.join("");
}

function mailDraftSentence({ l, i, q }: Ctx): string {
  const it = l === "it";
  const to = addresses(i.to);
  const subject = str(i.subject);
  const about = subject
    ? it
      ? ` con oggetto ${q(short(subject, 100))}`
      : ` with the subject ${q(short(subject, 100))}`
    : "";
  if (num(i.reply_to) !== undefined)
    return it
      ? `Prepara una bozza di risposta ${i.reply_all === true ? "a tutti " : ""}all'email ${num(i.reply_to)}`
      : `Drafts a reply${i.reply_all === true ? " to all" : ""} to the email ${num(i.reply_to)}`;
  if (num(i.forward) !== undefined)
    return it
      ? `Prepara una bozza per inoltrare l'email ${num(i.forward)}${to.length ? ` a ${people(l, to)}` : ""}`
      : `Drafts a forward of the email ${num(i.forward)}${to.length ? ` to ${people(l, to)}` : ""}`;
  return it
    ? `Prepara una bozza di email${to.length ? ` a ${people(l, to)}` : ""}${about}`
    : `Drafts an email${to.length ? ` to ${people(l, to)}` : ""}${about}`;
}

function mailMoveSentence({ l, i, q }: Ctx): string {
  const it = l === "it";
  const n = Array.isArray(i.ids) ? i.ids.length : 0;
  const what = it ? (n === 1 ? "1 email" : `${n} email`) : n === 1 ? "1 email" : `${n} emails`;
  switch (i.action) {
    case "delete":
      return it
        ? `Cancella per sempre ${what}: non passano dal cestino`
        : `Deletes ${what} for good: they do not go to the bin`;
    case "trash":
      return it ? `Sposta nel cestino ${what}` : `Moves ${what} to the bin`;
    case "archive":
      return it ? `Archivia ${what}` : `Archives ${what}`;
    case "read":
      return it ? `Segna come lette ${what}` : `Marks ${what} as read`;
    case "unread":
      return it ? `Segna come da leggere ${what}` : `Marks ${what} as unread`;
    case "flag":
      return it ? `Mette la stella a ${what}` : `Flags ${what}`;
    case "unflag":
      return it ? `Toglie la stella a ${what}` : `Unflags ${what}`;
    default:
      return it
        ? `Sposta ${what} nella cartella ${q(str(i.to) ?? "?")}`
        : `Moves ${what} to the folder ${q(str(i.to) ?? "?")}`;
  }
}

type Sentence = (c: Ctx) => string | undefined;

/** One sentence per tool, both languages: the table `requestSentence` reads. */
const SENTENCES: Record<string, Record<Lang, Sentence>> = {
  // An artifact's first use of a capability (3.6, G38.7): granted by the person only.
  [ARTIFACT_GRANT_TOOL]: {
    it: ({ i }) => grantSentence("it", i),
    en: ({ i }) => grantSentence("en", i),
  },
  platform_project: {
    it: ({ i, name }) =>
      i.action === "restore"
        ? `Ripristina il progetto ${name(i.project_id)}: i suoi agenti e le automazioni in pausa ripartono`
        : `Archivia il progetto ${name(i.project_id)}: i suoi agenti si fermano e nessuno ne cambia i file finché non lo ripristini`,
    en: ({ i, name }) =>
      i.action === "restore"
        ? `Restores the project ${name(i.project_id)}: its agents and paused automations start again`
        : `Archives the project ${name(i.project_id)}: its agents stop and nobody changes its files until you restore it`,
  },
  platform_configure_agent: {
    it: (c) => `Cambia le impostazioni dell'agente ${c.name(c.i.agent_id)}${configureParts(c)}`,
    en: (c) => `Changes the settings of the agent ${c.name(c.i.agent_id)}${configureParts(c)}`,
  },
  platform_set_budget: { it: budgetSentence, en: budgetSentence },
  platform_automation: { it: automationSentence, en: automationSentence },
  platform_policy: { it: policySentence, en: policySentence },
  platform_mcp: { it: mcpSentence, en: mcpSentence },
  platform_undo: {
    it: ({ i }) => `Annulla la modifica a RedGiant ${str(i.change_id) ?? ""}`.trim(),
    en: ({ i }) => `Undoes the change to RedGiant ${str(i.change_id) ?? ""}`.trim(),
  },
  platform_code_start: {
    it: ({ i, q }) => `Inizia una modifica al codice di RedGiant: ${q(str(i.title) ?? "?")}`,
    en: ({ i, q }) => `Starts a change to RedGiant's code: ${q(str(i.title) ?? "?")}`,
  },
  platform_code_test: {
    it: ({ i }) =>
      `Prova la modifica al codice di RedGiant ${str(i.change_id) ?? ""} in una copia separata`,
    en: ({ i }) =>
      `Tests the change to RedGiant's code ${str(i.change_id) ?? ""} in a separate copy`,
  },
  platform_code_promote: {
    it: ({ i }) =>
      `Mette in funzione la modifica al codice di RedGiant ${str(i.change_id) ?? ""}: RedGiant ripartirà con il codice nuovo`,
    en: ({ i }) =>
      `Puts live the change to RedGiant's code ${str(i.change_id) ?? ""}: RedGiant restarts with the new code`,
  },
  platform_code_discard: {
    it: ({ i }) => `Scarta la modifica al codice di RedGiant ${str(i.change_id) ?? ""}`.trim(),
    en: ({ i }) => `Drops the change to RedGiant's code ${str(i.change_id) ?? ""}`.trim(),
  },
  platform_status: {
    it: () => "Legge lo stato di RedGiant",
    en: () => "Reads RedGiant's state",
  },
  platform_changes: {
    it: () => "Legge le ultime modifiche a RedGiant",
    en: () => "Reads the latest changes to RedGiant",
  },
  bash: { it: bashSentence, en: bashSentence },
  write_file: {
    it: ({ i }) => `Scrive il file ${str(i.path) ?? "?"}`,
    en: ({ i }) => `Writes the file ${str(i.path) ?? "?"}`,
  },
  edit_file: {
    it: ({ i }) => `Modifica il file ${str(i.path) ?? "?"}`,
    en: ({ i }) => `Edits the file ${str(i.path) ?? "?"}`,
  },
  delete_file: {
    it: ({ i }) => `Cancella il file ${str(i.path) ?? "?"}`,
    en: ({ i }) => `Deletes the file ${str(i.path) ?? "?"}`,
  },
  edit_package: {
    it: ({ i }) => `Modifica il file ${str(i.path) ?? "?"}`,
    en: ({ i }) => `Edits the file ${str(i.path) ?? "?"}`,
  },
  canvas_edit: {
    it: ({ i }) => `Modifica il file aperto ${str(i.tab) ?? str(i.path) ?? ""}`.trim(),
    en: ({ i }) => `Edits the open file ${str(i.tab) ?? str(i.path) ?? ""}`.trim(),
  },
  convert_file: {
    it: ({ i }) =>
      str(i.to)
        ? `Converte ${str(i.path) ?? str(i.url) ?? "un file"} in ${str(i.to)}`
        : `Converte ${str(i.path) ?? str(i.url) ?? "un file"}`,
    en: ({ i }) =>
      str(i.to)
        ? `Converts ${str(i.path) ?? str(i.url) ?? "a file"} to ${str(i.to)}`
        : `Converts ${str(i.path) ?? str(i.url) ?? "a file"}`,
  },
  run_script: {
    it: ({ i }) => `Esegue uno script ${str(i.language) ?? ""}`.trim(),
    en: ({ i }) => (str(i.language) ? `Runs a ${str(i.language)} script` : "Runs a script"),
  },
  show_file: {
    it: ({ i }) => `Ti mostra il file ${str(i.path) ?? "?"}`,
    en: ({ i }) => `Shows you the file ${str(i.path) ?? "?"}`,
  },
  send_file: {
    it: ({ i }) => `Ti manda il file ${str(i.path) ?? "?"} nelle chat collegate`,
    en: ({ i }) => `Sends you the file ${str(i.path) ?? "?"} in the linked chats`,
  },
  publish_board: {
    it: ({ i, q }) => `Pubblica la tavola ${q(str(i.title) ?? "?")}`,
    en: ({ i, q }) => `Publishes the board ${q(str(i.title) ?? "?")}`,
  },
  delegate: {
    it: ({ i, name, q }) =>
      `Affida all'agente ${name(i.agent_id)} il compito ${q(str(i.title) ?? short(str(i.task) ?? "?", 80))}`,
    en: ({ i, name, q }) =>
      `Gives the agent ${name(i.agent_id)} the task ${q(str(i.title) ?? short(str(i.task) ?? "?", 80))}`,
  },
  create_agent: {
    it: ({ i, name, q }) =>
      `Crea l'agente ${q(str(i.name) ?? "?")}${str(i.project_id) ? ` nel progetto ${name(i.project_id)}` : ""}`,
    en: ({ i, name, q }) =>
      `Creates the agent ${q(str(i.name) ?? "?")}${str(i.project_id) ? ` in the project ${name(i.project_id)}` : ""}`,
  },
  create_project: {
    it: ({ i, q }) => `Crea il progetto ${q(str(i.name) ?? "?")}`,
    en: ({ i, q }) => `Creates the project ${q(str(i.name) ?? "?")}`,
  },
  stop_agent: {
    it: ({ i, name }) => `Ferma l'agente ${name(i.agent_id)}`,
    en: ({ i, name }) => `Stops the agent ${name(i.agent_id)}`,
  },
  merge_work: {
    it: ({ i, name }) => `Porta qui il lavoro dell'agente ${name(i.agent_id)}`,
    en: ({ i, name }) => `Brings in the work of the agent ${name(i.agent_id)}`,
  },
  browser_click: {
    it: ({ i, q }) => `Preme ${q(str(i.name) ?? "?")} nel browser`,
    en: ({ i, q }) => `Presses ${q(str(i.name) ?? "?")} in the browser`,
  },
  browser_type: {
    it: ({ i, q }) => `Scrive nel campo ${q(str(i.field) ?? "?")} del browser`,
    en: ({ i, q }) => `Types into the field ${q(str(i.field) ?? "?")} in the browser`,
  },
  repo_pull_request: {
    it: ({ i, q }) => `Apre una pull request sul repository: ${q(str(i.title) ?? "?")}`,
    en: ({ i, q }) => `Opens a pull request on the repository: ${q(str(i.title) ?? "?")}`,
  },
  repo_issue: {
    it: ({ i, q }) => `Apre una issue sul repository: ${q(str(i.title) ?? "?")}`,
    en: ({ i, q }) => `Opens an issue on the repository: ${q(str(i.title) ?? "?")}`,
  },
  knowledge_create: {
    it: ({ i, q }) => `Crea la raccolta di documenti ${q(str(i.name) ?? "?")}`,
    en: ({ i, q }) => `Creates the document collection ${q(str(i.name) ?? "?")}`,
  },
  knowledge_add_source: {
    it: ({ i, q }) =>
      `Aggiunge ${str(i.path) ?? str(i.url) ?? "una fonte"} alla raccolta ${q(str(i.collection) ?? "?")}`,
    en: ({ i, q }) =>
      `Adds ${str(i.path) ?? str(i.url) ?? "a source"} to the collection ${q(str(i.collection) ?? "?")}`,
  },
  use_credential: {
    it: ({ i, q }) =>
      `Usa la chiave ${q(str(i.service) ?? str(i.credential) ?? "?")} del tuo portachiavi${str(i.host) ? ` per ${str(i.host)}` : ""} (l'agente non la vede)`,
    en: ({ i, q }) =>
      `Uses the key ${q(str(i.service) ?? str(i.credential) ?? "?")} from your keychain${str(i.host) ? ` for ${str(i.host)}` : ""} (the agent never sees it)`,
  },
  automation_run: {
    it: ({ i, q }) => `Avvia l'automazione ${q(str(i.automation) ?? "?")}`,
    en: ({ i, q }) => `Runs the automation ${q(str(i.automation) ?? "?")}`,
  },
  mail_send: { it: mailSendSentence, en: mailSendSentence },
  mail_draft: { it: mailDraftSentence, en: mailDraftSentence },
  mail_move: { it: mailMoveSentence, en: mailMoveSentence },
  mail_read: {
    it: ({ i }) =>
      i.save_attachments
        ? `Legge l'email ${num(i.id) ?? "?"} e ne salva gli allegati nella sua cartella`
        : `Legge l'email ${num(i.id) ?? "?"}`,
    en: ({ i }) =>
      i.save_attachments
        ? `Reads the email ${num(i.id) ?? "?"} and saves its attachments in its folder`
        : `Reads the email ${num(i.id) ?? "?"}`,
  },
  image_generation: {
    it: () => "Crea un'immagine",
    en: () => "Makes a picture",
  },
  video_generation: {
    it: () => "Crea un video",
    en: () => "Makes a video",
  },
  audio_generation: {
    it: () => "Crea un audio",
    en: () => "Makes an audio clip",
  },
};

/** The tools `requestSentence` knows by name (the rest: services' tools, then the fallback). */
export const REQUEST_SENTENCE_TOOLS = Object.keys(SENTENCES);

/**
 * What a request does, in the person's language, with the call's own arguments: «Ripristina il
 * progetto «Collaudo 3.5.3»…», «Esegue il comando: git push origin main», «Scrive il file
 * app.py». A tool without words says «Usa lo strumento X»; never the raw input.
 */
export function requestSentence(
  lang: string,
  tool: string,
  input: unknown,
  names?: RequestNames,
): string {
  const l = lng(lang);
  const i = (input && typeof input === "object" ? input : {}) as Input;
  const lookup = (id: string) => (typeof names === "function" ? names(id) : names?.[id]);
  const q = (s: string) => quote(l, s);
  const name = (id: unknown) => {
    const s = str(id);
    return s ? q(lookup(s) ?? s) : "?";
  };
  const said = SENTENCES[tool]?.[l]({ l, i, name, q });
  if (said) return said;
  if (tool.startsWith("mcp__") && tool.split("__").length >= 3) return mcpToolSentence(l, tool, q);
  return l === "it" ? `Usa lo strumento ${tool}` : `Uses the tool ${tool}`;
}

/**
 * The policy's reasons (written in English for the model and the log) in the person's words.
 * Each known reason becomes a sentence; the dangers' own labels and the critical lines are
 * already said by the danger chips and the red card, so they give nothing; an unknown reason
 * (a rule the person wrote) gives nothing here and stays in the details, raw.
 */
const REASONS: [RegExp, Record<Lang, (m: RegExpMatchArray) => string>][] = [
  [
    /^manual mode$/i,
    {
      it: () => "L'agente è in modalità manuale: chiede prima di ogni modifica",
      en: () => "The agent is in manual mode: it asks before every change",
    },
  ],
  [
    /^rule: ask (.+)$/i,
    {
      it: (m) => `Una tua regola chiede conferma per ${m[1]}`,
      en: (m) => `One of your rules asks before ${m[1]}`,
    },
  ],
  [
    /^writes outside the project: (.+)$/i,
    {
      it: (m) => `Scrive fuori dalla cartella del progetto: ${m[1]}`,
      en: (m) => `Writes outside the project's folder: ${m[1]}`,
    },
  ],
  [
    /^shows a file outside the project: (.+)$/i,
    {
      it: (m) => `Mostra un file fuori dalla cartella del progetto: ${m[1]}`,
      en: (m) => `Shows a file outside the project's folder: ${m[1]}`,
    },
  ],
  [
    /^looks at a file outside the project: (.+)$/i,
    {
      it: (m) => `Guarda un file fuori dalla cartella del progetto: ${m[1]}`,
      en: (m) => `Looks at a file outside the project's folder: ${m[1]}`,
    },
  ],
  [
    /^reads files outside the project into the knowledge: (.+)$/i,
    {
      it: (m) => `Legge tra i documenti file fuori dalla cartella del progetto: ${m[1]}`,
      en: (m) => `Reads files outside the project's folder into the documents: ${m[1]}`,
    },
  ],
  [
    /^Uses "(.+)" from your keychain/,
    {
      it: (m) => `Usa «${m[1]}» dal tuo portachiavi (l'agente non la vede)`,
      en: (m) => `Uses “${m[1]}” from your keychain (the agent never sees it)`,
    },
  ],
  [
    /^The automation asks your yes before it acts$/,
    {
      it: () => "L'automazione chiede il tuo sì prima di agire",
      en: () => "The automation asks your yes before it acts",
    },
  ],
];

/** The default danger rules' labels (`DEFAULT_DANGER_RULES`): their chips say them. */
const DANGER_LABELS = new Set(
  [
    "Recursive delete",
    "git push",
    "Rewrite git history",
    "Download and run",
    "Privilege escalation",
    "Disk and system",
    "Containers and clusters",
    "Destructive SQL",
    "Deploy and publish",
    "Changes the platform",
    "Sends, publishes, deletes or pays",
    "Sends, publishes, pays or deletes in the browser",
    "Opens a pull request or an issue",
    "Secret files",
    // The email's danger (G38.1): its chip and the fields say it.
    "sends an email",
  ].map((s) => s.toLowerCase()),
);

/** One reason in the person's words; undefined when the chips already say it or it is unknown. */
export function reasonSentence(lang: string, reason: string): string | undefined {
  const l = lng(lang);
  const r = reason.trim();
  if (DANGER_LABELS.has(r.toLowerCase()) || /^truly dangerous:/i.test(r)) return undefined;
  for (const [re, say] of REASONS) {
    const m = r.match(re);
    if (m) return say[l](m);
  }
  return undefined;
}

/** The reasons of a request the person reads, translated, without repeats. */
export function requestReasons(lang: string, r: { reasons: readonly string[] }): string[] {
  return [
    ...new Set(r.reasons.map((x) => reasonSentence(lang, x)).filter((x): x is string => !!x)),
  ];
}

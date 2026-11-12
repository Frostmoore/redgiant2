/**
 * The truly dangerous requests (G36.17b, the person: «Solo le richieste VERAMENTE pericolose
 * devono arrivare a me sempre e ovunque. Roba come modificare file di sistema, cancellazioni
 * irrecuperabili di cose importanti, pubblicazione di segreti... Git push è attività ordinaria»).
 * These, and only these, reach the person everywhere in both modes ("ask me" and "don't ask me
 * anything"), and no classifier ever decides them. They are found by `criticalOf` in
 * @redgiant/hierarchy (a pure function tested as a table); they are not policy rules, so the
 * Safety page cannot switch them off. The policy's `humanOnly` dangers are a different thing:
 * ordinary approvals that skip the parent agents.
 */
import { z } from "zod";

export const CRITICAL_IDS = [
  "critical-system",
  "critical-delete",
  "critical-secret",
  "critical-payment",
  "critical-protections",
] as const;
export type CriticalId = (typeof CRITICAL_IDS)[number];

export const isCriticalId = (id: string): id is CriticalId =>
  (CRITICAL_IDS as readonly string[]).includes(id);

/** A name, a line that says what it is, and examples a person recognises. */
export interface CriticalWords {
  name: string;
  hint: string;
  examples: string[];
}

const en: Record<CriticalId, CriticalWords> = {
  "critical-system": {
    name: "Changing the computer's system files",
    hint: "Touching the folders of the operating system and of the installed programs, the Windows registry, drivers, services, users or the security settings.",
    examples: [
      "Deleting or changing files in C:\\Windows, C:\\Program Files, /etc, /usr, /System or /Library",
      "Changing the Windows registry",
      "Stopping or removing services and drivers",
      "Switching off the antivirus or the firewall, adding users",
    ],
  },
  "critical-delete": {
    name: "Deleting important things for good",
    hint: "Deletions that skip the recycle bin and the project's history, so nothing brings them back.",
    examples: [
      "Deleting your home, your documents or a whole disk, or folders outside the project",
      "Formatting a disk",
      "Deleting a database",
      "Deleting a repository or branches online, or forcing a push over main",
    ],
  },
  "critical-secret": {
    name: "Publishing passwords and keys",
    hint: "Sending, pasting, committing or putting online a password, an API key, a token, a private key or a value from your keychain.",
    examples: [
      "Writing a key into a file that goes into git",
      "Sending a key to a site that is not its own, or to a paste site",
      "A password in an email, a message or a post",
    ],
  },
  "critical-payment": {
    name: "Paying with real money",
    hint: "Payments, purchases, orders, transfers and refunds, in a connected service or in the browser.",
    examples: ["Pressing «Buy» or «Pay» on a site", "A payment through a connected service"],
  },
  "critical-protections": {
    name: "Switching off RedGiant's protections",
    hint: "Changing the permission rules, the guardian, the classifier or this list, or putting new RedGiant code live.",
    examples: [
      "Changing the permission policy",
      "Changing RedGiant's settings files or its keychain",
      "Putting a change to RedGiant's own code live",
    ],
  },
};

const it: Record<CriticalId, CriticalWords> = {
  "critical-system": {
    name: "Toccare i file di sistema del computer",
    hint: "Mettere le mani nelle cartelle del sistema operativo e dei programmi installati, nel registro di Windows, nei driver, nei servizi, negli utenti o nelle impostazioni di sicurezza.",
    examples: [
      "Cancellare o cambiare file in C:\\Windows, C:\\Programmi, /etc, /usr, /System o /Library",
      "Cambiare il registro di Windows",
      "Fermare o togliere servizi e driver",
      "Spegnere l'antivirus o il firewall, aggiungere utenti",
    ],
  },
  "critical-delete": {
    name: "Cancellare per sempre cose importanti",
    hint: "Cancellazioni che saltano il cestino e la storia del progetto: dopo, niente le riporta indietro.",
    examples: [
      "Cancellare la tua cartella personale, i documenti, un disco intero o cartelle fuori dal progetto",
      "Formattare un disco",
      "Cancellare un database",
      "Cancellare un repository o dei rami online, o forzare un invio sopra main",
    ],
  },
  "critical-secret": {
    name: "Rendere pubbliche password e chiavi",
    hint: "Inviare, incollare, salvare in git o mettere online una password, una chiave API, un token, una chiave privata o un valore del tuo portachiavi.",
    examples: [
      "Scrivere una chiave in un file che finisce in git",
      "Mandare una chiave a un sito che non è il suo, o a un sito di incolla-testo",
      "Una password in una email, in un messaggio o in un post",
    ],
  },
  "critical-payment": {
    name: "Pagare con soldi veri",
    hint: "Pagamenti, acquisti, ordini, bonifici e rimborsi, in un servizio collegato o nel browser.",
    examples: [
      "Premere «Compra» o «Paga» su un sito",
      "Un pagamento attraverso un servizio collegato",
    ],
  },
  "critical-protections": {
    name: "Spegnere le protezioni di RedGiant",
    hint: "Cambiare le regole dei permessi, il guardiano, il classificatore o questo elenco, o mettere in funzione codice nuovo di RedGiant.",
    examples: [
      "Cambiare la politica dei permessi",
      "Cambiare i file delle impostazioni di RedGiant o il suo portachiavi",
      "Mettere in funzione una modifica al codice di RedGiant",
    ],
  },
};

export function criticalWords(lang: "it" | "en", id: CriticalId): CriticalWords {
  return (lang === "it" ? it : en)[id];
}

/**
 * What a truly dangerous call does, for the person (p3.5.4, after an approval given in four
 * seconds without noticing it: «va bene rosse, ma non in due step»). `criticalOf` gives one per
 * kind with the call's own arguments (`target`: a path, a branch, a site, a tool, a button); the
 * page and every linked chat build their sentence from it (`criticalSentence`), never from the
 * English reason written for the model.
 */
export const CRITICAL_ACTIONS = [
  "system-delete",
  "system-write",
  "system-service",
  "system-drivers",
  "system-antivirus",
  "system-firewall",
  "system-protection",
  "system-users",
  "system-registry",
  "redact",
  "delete-your-home",
  "delete-home",
  "delete-disk",
  "delete-git",
  "delete-project",
  "delete-variable",
  "delete-important",
  "delete-outside",
  "disk-write",
  "disk-format",
  "disk-partition",
  "db-drop",
  "repo-delete",
  "service-delete",
  "branch-delete",
  "push-mirror",
  "push-force",
  "push-force-all",
  "secret-keychain",
  "secret-keychain-file",
  "secret-keychain-send",
  "secret-git-add",
  "secret-commit",
  "secret-publish",
  "secret-paste",
  "secret-send",
  "secret-file",
  "secret-attach",
  "mail-delete",
  "pay-tool",
  "pay-service",
  "pay-button",
  "protect-delete",
  "protect-files",
  "protect-db",
  "protect-policy",
  "protect-code",
] as const;
export type CriticalAction = (typeof CRITICAL_ACTIONS)[number];

export const CriticalDetail = z.object({
  id: z.enum(CRITICAL_IDS),
  action: z.enum(CRITICAL_ACTIONS),
  /** The call's own argument the action is about: a path, a branch, sites, a tool, a button. */
  target: z.string().optional(),
  /** Which secret leaves: "password", "token", "private-key" or the key's service. */
  secret: z.string().optional(),
  /** Deletes what is inside the folder (find -delete, rsync --delete), not the folder itself. */
  inside: z.boolean().optional(),
});
export type CriticalDetail = z.infer<typeof CriticalDetail>;

type Lang = "it" | "en";
type Sentence = (d: CriticalDetail, x: { t: string; s: string; del: string }) => string;

/** The services of the keys `leakableSecrets` finds, as people write them. */
const SERVICES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  github: "GitHub",
  huggingface: "Hugging Face",
  aws: "AWS",
  google: "Google",
  slack: "Slack",
  telegram: "Telegram",
};

const secretWords = (lang: Lang, secret: string | undefined) => {
  const it = lang === "it";
  if (secret === "password") return it ? "una password" : "a password";
  if (secret === "private-key") return it ? "una chiave privata" : "a private key";
  if (!secret || secret === "token" || secret === "bearer") return it ? "un token" : "a token";
  const token = /token$/.test(secret);
  const raw = secret.replace(/-(api-key|access-key|bot-token|key|token)$/, "");
  const service = SERVICES[raw] ?? raw;
  if (token) return it ? `un token di ${service}` : `a ${service} token`;
  return it ? `una chiave di ${service}` : `a ${service} key`;
};

const SENTENCES: Record<Lang, Record<CriticalAction, Sentence>> = {
  en: {
    "system-delete": (_, x) => `${x.del} files of the computer's system: ${x.t}`,
    "system-write": (_, x) => `Changes files of the computer's system: ${x.t}`,
    "system-service": () => "Changes, stops or removes a service of the computer",
    "system-drivers": () => "Changes the drivers or how the computer starts",
    "system-antivirus": () => "Switches off the antivirus or hides files from it",
    "system-firewall": () => "Switches off the firewall or removes its rules",
    "system-protection": () => "Switches off a protection of the operating system",
    "system-users": () => "Changes the computer's users or administrators",
    "system-registry": () => "Changes the Windows registry",
    redact: (_, x) =>
      `Removes for good the text and pictures under the chosen areas from ${x.t || "a PDF"}`,
    "delete-your-home": (_, x) => `${x.del} your home folder: ${x.t}`,
    "delete-home": (_, x) => `${x.del} a home folder or a whole disk: ${x.t}`,
    "delete-disk": (_, x) => `${x.del} a whole disk: ${x.t}`,
    "delete-git": (_, x) => `${x.del} the project's whole history (the .git folder): ${x.t}`,
    "delete-project": (_, x) => `${x.del} the whole project: ${x.t}`,
    "delete-variable": (_, x) =>
      `${x.del} ${x.t}: if the variable is empty, that is the whole disk`,
    "delete-important": (_, x) => `${x.del} ${x.t}`,
    "delete-outside": (_, x) => `${x.del} a folder outside the project: ${x.t}`,
    "disk-write": (_, x) => `Writes straight onto a disk, erasing what is on it: ${x.t}`,
    "disk-format": () => "Formats or erases a disk: everything on it is lost",
    "disk-partition": () => "Repartitions a disk: what is on it can be lost",
    "db-drop": (_, x) => `Deletes a whole database: ${x.t}`,
    "repo-delete": () => "Deletes a repository online, with all its history",
    "service-delete": (_, x) => `Deletes something for good through ${x.t}`,
    "branch-delete": () => "Deletes a branch of the online repository",
    "push-mirror": () =>
      "Makes the online repository equal to this copy, deleting what is only there",
    "push-force": (_, x) => `Overwrites for everyone the history of the shared branch ${x.t}`,
    "push-force-all": () => "Overwrites for everyone the history of every branch",
    "secret-keychain": () => "Puts a value of your keychain into a command",
    "secret-keychain-file": (_, x) => `Writes a value of your keychain into ${x.t}`,
    "secret-keychain-send": (_, x) => `Sends a value of your keychain out through ${x.t}`,
    "secret-git-add": (_, x) => `Puts a file of secrets into git: ${x.t}`,
    "secret-commit": (_, x) => `Saves ${x.s} into git, where it stays in the history`,
    "secret-publish": (_, x) => `Publishes ${x.s} on the repository's site`,
    "secret-paste": (_, x) => `Sends ${x.s} to a public paste site: ${x.t}`,
    "secret-send": (_, x) => `Sends ${x.s} out to ${x.t}`,
    "secret-file": (_, x) => `Writes ${x.s} into ${x.t}, a file that can end up in git and online`,
    "secret-attach": (_, x) => `Attaches a file of passwords or keys to an email: ${x.t}`,
    "mail-delete": (_, x) =>
      x.t
        ? `Deletes emails for good from ${x.t}: they do not go to the bin`
        : "Deletes emails for good: they do not go to the bin",
    "pay-tool": (_, x) => `Pays or buys with real money through ${x.t}`,
    "pay-service": (_, x) =>
      `Makes a payment with real money through ${x.t || "a payment service"}`,
    "pay-button": (_, x) => `Presses «${x.t}» in the browser: a payment with real money`,
    "protect-delete": (_, x) => `${x.del} RedGiant's own files: ${x.t}`,
    "protect-files": (_, x) => `Changes RedGiant's own files: ${x.t}`,
    "protect-db": () => "Changes RedGiant's own settings or history in its database",
    "protect-policy": () => "Changes RedGiant's permission rules",
    "protect-code": () => "Puts new RedGiant code live: it could switch off its protections",
  },
  it: {
    "system-delete": (_, x) => `${x.del} file del sistema del computer: ${x.t}`,
    "system-write": (_, x) => `Cambia file del sistema del computer: ${x.t}`,
    "system-service": () => "Cambia, ferma o toglie un servizio del computer",
    "system-drivers": () => "Cambia i driver o il modo in cui il computer si avvia",
    "system-antivirus": () => "Spegne l'antivirus o gli nasconde dei file",
    "system-firewall": () => "Spegne il firewall o ne toglie le regole",
    "system-protection": () => "Spegne una protezione del sistema operativo",
    "system-users": () => "Cambia gli utenti o gli amministratori del computer",
    "system-registry": () => "Cambia il registro di Windows",
    redact: (_, x) =>
      `Toglie per sempre il testo e le immagini sotto le aree scelte da ${x.t || "un PDF"}`,
    "delete-your-home": (_, x) => `${x.del} la tua cartella personale: ${x.t}`,
    "delete-home": (_, x) => `${x.del} una cartella personale o un disco intero: ${x.t}`,
    "delete-disk": (_, x) => `${x.del} un disco intero: ${x.t}`,
    "delete-git": (_, x) => `${x.del} tutta la storia del progetto (la cartella .git): ${x.t}`,
    "delete-project": (_, x) => `${x.del} l'intero progetto: ${x.t}`,
    "delete-variable": (_, x) => `${x.del} ${x.t}: se la variabile è vuota, è il disco intero`,
    "delete-important": (_, x) => `${x.del} ${x.t}`,
    "delete-outside": (_, x) => `${x.del} una cartella fuori dal progetto: ${x.t}`,
    "disk-write": (_, x) => `Scrive direttamente su un disco, cancellando quello che c'è: ${x.t}`,
    "disk-format": () => "Formatta o cancella un disco: tutto quello che c'è va perso",
    "disk-partition": () => "Ripartiziona un disco: quello che c'è può andare perso",
    "db-drop": (_, x) => `Cancella un intero database: ${x.t}`,
    "repo-delete": () => "Cancella un repository online, con tutta la sua storia",
    "service-delete": (_, x) => `Cancella per sempre qualcosa attraverso ${x.t}`,
    "branch-delete": () => "Cancella un ramo del repository online",
    "push-mirror": () =>
      "Rende il repository online uguale a questa copia, cancellando quello che c'è solo lì",
    "push-force": (_, x) => `Riscrive per tutti la storia del ramo condiviso ${x.t}`,
    "push-force-all": () => "Riscrive per tutti la storia di ogni ramo",
    "secret-keychain": () => "Mette in un comando un valore del tuo portachiavi",
    "secret-keychain-file": (_, x) => `Scrive un valore del tuo portachiavi in ${x.t}`,
    "secret-keychain-send": (_, x) => `Manda fuori un valore del tuo portachiavi attraverso ${x.t}`,
    "secret-git-add": (_, x) => `Mette in git un file di segreti: ${x.t}`,
    "secret-commit": (_, x) => `Salva ${x.s} in git, dove resta nella storia`,
    "secret-publish": (_, x) => `Pubblica ${x.s} sul sito del repository`,
    "secret-paste": (_, x) => `Manda ${x.s} a un sito pubblico di incolla-testo: ${x.t}`,
    "secret-send": (_, x) => `Manda fuori ${x.s} a ${x.t}`,
    "secret-file": (_, x) => `Scrive ${x.s} in ${x.t}, un file che può finire in git e online`,
    "secret-attach": (_, x) => `Allega a un'email un file di password o chiavi: ${x.t}`,
    "mail-delete": (_, x) =>
      x.t
        ? `Cancella per sempre delle email da ${x.t}: non passano dal cestino`
        : "Cancella per sempre delle email: non passano dal cestino",
    "pay-tool": (_, x) => `Paga o compra con soldi veri attraverso ${x.t}`,
    "pay-service": (_, x) =>
      `Fa un pagamento con soldi veri attraverso ${x.t || "un servizio di pagamento"}`,
    "pay-button": (_, x) => `Preme «${x.t}» nel browser: un pagamento con soldi veri`,
    "protect-delete": (_, x) => `${x.del} i file di RedGiant stesso: ${x.t}`,
    "protect-files": (_, x) => `Cambia i file di RedGiant stesso: ${x.t}`,
    "protect-db": () => "Cambia le impostazioni o la storia di RedGiant nel suo database",
    "protect-policy": () => "Cambia le regole dei permessi di RedGiant",
    "protect-code": () =>
      "Mette in funzione codice nuovo di RedGiant: potrebbe spegnere le sue protezioni",
  },
};

const lng = (lang: string): Lang => (lang === "it" ? "it" : "en");

/** What the call does, in a sentence the person reads (their language, the call's arguments). */
export function criticalSentence(lang: string, d: CriticalDetail): string {
  const l = lng(lang);
  const del =
    l === "it"
      ? d.inside
        ? "Cancella per sempre tutto quello che c'è in"
        : "Cancella per sempre"
      : d.inside
        ? "Deletes for good everything in"
        : "Deletes for good";
  return SENTENCES[l][d.action](d, { t: d.target ?? "", s: secretWords(l, d.secret), del });
}

/** The title of a truly dangerous request, on the page and in every chat. */
export function criticalTitle(lang: string): string {
  return lng(lang) === "it"
    ? "Pericolo: azione che non si può annullare"
    : "Danger: an action that cannot be undone";
}

/**
 * The sentences of a request: from its details, or (an older request without them) from the
 * kinds' own words.
 */
export function criticalSentences(
  lang: string,
  r: { critical?: readonly CriticalDetail[] | undefined; danger: readonly string[] },
): string[] {
  if (r.critical?.length) return r.critical.map((d) => criticalSentence(lang, d));
  return r.danger.filter(isCriticalId).map((id) => criticalWords(lng(lang), id).hint);
}

/**
 * The first lines of a truly dangerous request in a linked chat (p3.5.4): the danger in capitals
 * (no emoji, no symbols as icons), then what happens. Empty for any other request.
 */
export function criticalChatLines(
  lang: string,
  r: { critical?: readonly CriticalDetail[] | undefined; danger: readonly string[] },
): string[] {
  if (!isCriticalRequest(r)) return [];
  const [head, ...rest] = criticalTitle(lang).split(":");
  return [
    `${(head ?? "").toUpperCase()}:${rest.join(":")}`,
    ...criticalSentences(lang, r).map((x) => `${x}.`),
    "",
  ];
}

/** Whether a request is truly dangerous (G36.17b). */
export const isCriticalRequest = (r: {
  critical?: readonly unknown[] | undefined;
  danger: readonly string[];
}) => (r.critical?.length ?? 0) > 0 || r.danger.some(isCriticalId);

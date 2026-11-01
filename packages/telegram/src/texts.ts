// What the bot writes, in the language chosen in the setup wizard (English by default).
// No emoji and no symbol characters as icons (user's request, 2026-11-01).

const en = {
  linkHow:
    "To link this chat, open RedGiant, Settings, Telegram, Pair, then send /start <code> here.",
  linked: "Linked. Write to me and I will pass it on to God.",
  notLinked:
    "This chat is not linked to RedGiant. Open RedGiant, Settings, Telegram, Pair, then send /start <code>.",
  error: "Error: {error}",
  approvalNeeded: "Approval needed: {agent}{project} wants {tool}",
  why: "Why: {reasons}",
  danger: "Danger: {danger}",
  allow: "Allow",
  deny: "Deny",
  allowed: "Allowed",
  denied: "Denied",
  notAllowed: "Not allowed.",
  closedAlready: "This request is already closed.",
  questionFrom: "{agent} asks:",
  planFrom: "{agent} proposes a plan:",
  manyAnswers: "(one or more, then Send)",
  replyToAnswer: "Or reply to this message with your own answer.",
  send: "Send",
  approvePlan: "Approve and carry on",
  revisePlan: "Keep planning",
  answered: "Answered: {answer}",
  noAnswer: "Closed without an answer.",
  pickFirst: "Pick at least one option.",
  saved: "Saved",
} as const;

export type TextKey = keyof typeof en;

const it: Record<TextKey, string> = {
  linkHow:
    "Per collegare questa chat apri RedGiant, Impostazioni, Telegram, Abbina, poi manda qui /start <codice>.",
  linked: "Collegato. Scrivimi e lo passo a God.",
  notLinked:
    "Questa chat non è collegata a RedGiant. Apri RedGiant, Impostazioni, Telegram, Abbina, poi manda /start <codice>.",
  error: "Errore: {error}",
  approvalNeeded: "Serve un'approvazione: {agent}{project} vuole usare {tool}",
  why: "Perché: {reasons}",
  danger: "Pericolo: {danger}",
  allow: "Consenti",
  deny: "Nega",
  allowed: "Consentito",
  denied: "Negato",
  notAllowed: "Non consentito.",
  closedAlready: "Questa richiesta è già chiusa.",
  questionFrom: "{agent} chiede:",
  planFrom: "{agent} propone un piano:",
  manyAnswers: "(una o più, poi Invia)",
  replyToAnswer: "Oppure rispondi a questo messaggio con una risposta tua.",
  send: "Invia",
  approvePlan: "Approva e procedi",
  revisePlan: "Continua a pianificare",
  answered: "Risposta: {answer}",
  noAnswer: "Chiusa senza risposta.",
  pickFirst: "Scegli almeno un'opzione.",
  saved: "Salvato",
};

export type Language = "it" | "en";

export function say(lang: Language, key: TextKey, vars: Record<string, string> = {}): string {
  const text = (lang === "it" ? it : en)[key];
  return text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
}

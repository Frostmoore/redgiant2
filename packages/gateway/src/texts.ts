// What Demi-God writes on the chat platforms: in the agents' language when it is translated here,
// otherwise in the interface's (G33.5; `RedGiantCore.language`).
// No emoji and no symbol characters as icons (user's request, 2026-11-01).

const en = {
  linkHow:
    "To link this chat, open RedGiant, Settings, Chats, {platform}, Pair, then send /start <code> here.",
  linked: "Linked. Write to me and I will pass it on to God.",
  notLinked:
    "This chat is not linked to RedGiant. Open RedGiant, Settings, Chats, {platform}, Pair, then send /start <code>.",
  error: "Error: {error}",
  queued: "Got it. I am still answering your previous message: I will read this one right after.",
  automationTook: "Passed to the automation: {names}.",
  noModel:
    "No model is chosen yet. Open RedGiant, Settings, Models and subscriptions, connect one and write to me again.",
  approvalNeeded: "Approval needed: {agent}{project} wants {tool}",
  why: "Why: {reasons}",
  danger: "Danger: {danger}",
  allow: "Allow",
  deny: "Deny",
  allowed: "Allowed",
  denied: "Denied",
  questionFrom: "{agent} asks:",
  planFrom: "{agent} proposes a plan:",
  approvePlan: "Approve and carry on",
  revisePlan: "Keep planning",
  answered: "Answered: {answer}",
  noAnswer: "Closed without an answer.",
  pickByNumber: "Reply with the number of your choice{many}, or write your own answer.",
  pickMany: " (more than one: 1,3)",
  noTranscription:
    "Voice messages need a transcription service: set one in RedGiant's configuration.",
  heard: "I heard: {text}",
  heardNothing: "I could not make out any words.",
  newConversation: "New conversation: God and I start fresh.",
  stopped: "Stopped.",
  nothingToStop: "Nothing was running.",
  working: "Working now: {names}.",
  idle: "Nobody is working right now.",
  waiting: "Waiting for you: {approvals} approvals, {questions} questions.",
  spent: "Spent: ${spent}.",
  spentOf: "Spent: ${spent} of ${limit}.",
  encrypted:
    "This room is end-to-end encrypted and I cannot read it. Write to me in a room without encryption, or put a Pantalaimon proxy in front of the homeserver (RedGiant, Settings, Other chats, Matrix).",
} as const;

export type TextKey = keyof typeof en;

const it: Record<TextKey, string> = {
  linkHow:
    "Per collegare questa chat apri RedGiant, Impostazioni, Chat, {platform}, Abbina, poi manda qui /start <codice>.",
  linked: "Collegato. Scrivimi e lo passo a God.",
  notLinked:
    "Questa chat non è collegata a RedGiant. Apri RedGiant, Impostazioni, Chat, {platform}, Abbina, poi manda /start <codice>.",
  error: "Errore: {error}",
  queued: "Ricevuto. Sto ancora rispondendo al messaggio di prima: leggo questo subito dopo.",
  automationTook: "Lo passo all'automazione: {names}.",
  noModel:
    "Non hai ancora scelto un modello. Apri RedGiant, Impostazioni, Modelli e abbonamenti, collegane uno e poi scrivimi di nuovo.",
  approvalNeeded: "Serve un'approvazione: {agent}{project} vuole usare {tool}",
  why: "Perché: {reasons}",
  danger: "Pericolo: {danger}",
  allow: "Consenti",
  deny: "Nega",
  allowed: "Consentito",
  denied: "Negato",
  questionFrom: "{agent} chiede:",
  planFrom: "{agent} propone un piano:",
  approvePlan: "Approva e procedi",
  revisePlan: "Continua a pianificare",
  answered: "Risposta: {answer}",
  noAnswer: "Chiusa senza risposta.",
  pickByNumber: "Rispondi con il numero della scelta{many}, oppure scrivi una risposta tua.",
  pickMany: " (più di una: 1,3)",
  noTranscription:
    "Per i vocali serve un servizio di trascrizione: impostalo nella configurazione di RedGiant.",
  heard: "Ho capito: {text}",
  heardNothing: "Non sono riuscito a capire nessuna parola.",
  newConversation: "Nuova conversazione: io e God ripartiamo da capo.",
  stopped: "Fermato.",
  nothingToStop: "Non c'era niente in corso.",
  working: "Al lavoro adesso: {names}.",
  idle: "Nessuno sta lavorando adesso.",
  waiting: "Ti aspettano: {approvals} approvazioni, {questions} domande.",
  spent: "Speso: ${spent}.",
  spentOf: "Speso: ${spent} su ${limit}.",
  encrypted:
    "Questa stanza è cifrata end-to-end e non riesco a leggerla. Scrivimi in una stanza senza cifratura, oppure metti un proxy Pantalaimon davanti all'homeserver (RedGiant, Impostazioni, Altre chat, Matrix).",
};

export type Language = "it" | "en";

export function say(lang: Language, key: TextKey, vars: Record<string, string> = {}): string {
  const text = (lang === "it" ? it : en)[key];
  return text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
}

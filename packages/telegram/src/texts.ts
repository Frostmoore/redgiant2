// What the bot writes: in the agents' language when it is translated here, otherwise in the
// interface's (G33.5; `RedGiantCore.language`), English by default.
// No emoji and no symbol characters as icons (user's request, 2026-11-01).

const en = {
  linkHow:
    "To link this chat, open RedGiant, Settings, Telegram, Pair, then send /start <code> here.",
  linked: "Linked. Write to me and I will pass it on to God.",
  notLinked:
    "This chat is not linked to RedGiant. Open RedGiant, Settings, Telegram, Pair, then send /start <code>.",
  error: "Error: {error}",
  fileTooBig: "I could not send {name} here (Telegram takes up to 50 MB): open it in RedGiant.",
  queued: "Got it. I am still answering your previous message: I will read this one right after.",
  automationTook: "Passed to the automation: {names}.",
  noModel:
    "No model is chosen yet. Open RedGiant, Settings, Models and subscriptions, connect one (a subscription, a key or a local model) and write to me again.",
  approvalNeeded: "Approval needed: {agent}{project} asks for your yes",
  details: "Details: {tool} {input}",
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
  decidedVia: "Already decided by you {where}: {decision}.",
  answeredVia: "Already answered by you {where}.",
  timedOut: "Time ran out without your answer.",
  whereWeb: "on the web page",
  whereChat: "on {name}",
  pickFirst: "Pick at least one option.",
  saved: "Saved",
  seeAttached: "(see the attachment)",
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
  cmdNew: "Start a new conversation",
  cmdStatus: "What is running and what waits for you",
  cmdStop: "Stop what is running",
} as const;

export type TextKey = keyof typeof en;

const it: Record<TextKey, string> = {
  linkHow:
    "Per collegare questa chat apri RedGiant, Impostazioni, Telegram, Abbina, poi manda qui /start <codice>.",
  linked: "Collegato. Scrivimi e lo passo a God.",
  notLinked:
    "Questa chat non è collegata a RedGiant. Apri RedGiant, Impostazioni, Telegram, Abbina, poi manda /start <codice>.",
  error: "Errore: {error}",
  fileTooBig:
    "Non sono riuscito a mandarti {name} qui (Telegram accetta fino a 50 MB): aprilo in RedGiant.",
  queued: "Ricevuto. Sto ancora rispondendo al messaggio di prima: leggo questo subito dopo.",
  automationTook: "Lo passo all'automazione: {names}.",
  noModel:
    "Non hai ancora scelto un modello. Apri RedGiant, Impostazioni, Modelli e abbonamenti, collegane uno (un abbonamento, una chiave o un modello locale) e poi scrivimi di nuovo.",
  approvalNeeded: "Serve un'approvazione: {agent}{project} chiede il tuo sì",
  details: "Dettagli: {tool} {input}",
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
  decidedVia: "Già deciso da te {where}: {decision}.",
  answeredVia: "Già risposto da te {where}.",
  timedOut: "Tempo scaduto senza la tua risposta.",
  whereWeb: "nella pagina web",
  whereChat: "su {name}",
  pickFirst: "Scegli almeno un'opzione.",
  saved: "Salvato",
  seeAttached: "(vedi l'allegato)",
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
  cmdNew: "Inizia una nuova conversazione",
  cmdStatus: "Cosa è in corso e cosa ti aspetta",
  cmdStop: "Ferma quello che è in corso",
};

export type Language = "it" | "en";

export function say(lang: Language, key: TextKey, vars: Record<string, string> = {}): string {
  const text = (lang === "it" ? it : en)[key];
  return text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
}

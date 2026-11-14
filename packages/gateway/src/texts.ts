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
  approvalNeeded: "Approval needed: {agent}{project} asks for your yes",
  details: "Details: {tool} {input}",
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
  decidedVia: "Already decided by you {where}: {decision}.",
  answeredVia: "Already answered by you {where}.",
  timedOut: "Time ran out without your answer.",
  whereWeb: "on the web page",
  whereChat: "on {name}",
  pickByNumber: "Reply with the number of your choice{many}, or write your own answer.",
  pickMany: " (more than one: 1,3)",
  noTranscription:
    "Voice messages need a transcription service: choose one in RedGiant, Settings, Voice.",
  heard: "I heard: {text}",
  heardNothing: "I could not make out any words.",
  voice_no_key: "{name} has no key yet: add it in RedGiant, Settings, Voice.",
  voice_empty: "The voice message is empty.",
  voice_too_long: "The voice message is too long.",
  voice_convert: "The voice message could not be converted for whisper.",
  voice_timeout: "{name} took too long to write down the voice message.",
  voice_unreachable:
    "{name} cannot be reached: check that it is on and its address in RedGiant, Settings, Voice.",
  voice_key_refused: "{name} refused the key: check it in RedGiant, Settings, Voice.",
  voice_rate_limited: "{name} says too many requests or no credit left.",
  voice_service_error: "{name} answered with an error ({status}).",
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

/** The voice's failure codes the chats explain (the server's `TranscriptionCode`s). */
export const VOICE_FAILURES = {
  voice_no_key: true,
  voice_empty: true,
  voice_too_long: true,
  voice_convert: true,
  voice_timeout: true,
  voice_unreachable: true,
  voice_key_refused: true,
  voice_rate_limited: true,
  voice_service_error: true,
} as const satisfies Partial<Record<TextKey, true>>;
export type VoiceFailure = keyof typeof VOICE_FAILURES;

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
  approvalNeeded: "Serve un'approvazione: {agent}{project} chiede il tuo sì",
  details: "Dettagli: {tool} {input}",
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
  decidedVia: "Già deciso da te {where}: {decision}.",
  answeredVia: "Già risposto da te {where}.",
  timedOut: "Tempo scaduto senza la tua risposta.",
  whereWeb: "nella pagina web",
  whereChat: "su {name}",
  pickByNumber: "Rispondi con il numero della scelta{many}, oppure scrivi una risposta tua.",
  pickMany: " (più di una: 1,3)",
  noTranscription:
    "Per i vocali serve un servizio di trascrizione: sceglilo in RedGiant, Impostazioni, Voce.",
  heard: "Ho capito: {text}",
  heardNothing: "Non sono riuscito a capire nessuna parola.",
  voice_no_key: "{name} non ha ancora una chiave: aggiungila in RedGiant, Impostazioni, Voce.",
  voice_empty: "Il vocale è vuoto.",
  voice_too_long: "Il vocale è troppo lungo.",
  voice_convert: "Non sono riuscito a convertire il vocale per whisper.",
  voice_timeout: "{name} ci ha messo troppo a trascrivere il vocale.",
  voice_unreachable:
    "{name} non si raggiunge: controlla che sia acceso e il suo indirizzo in RedGiant, Impostazioni, Voce.",
  voice_key_refused: "{name} ha rifiutato la chiave: controllala in RedGiant, Impostazioni, Voce.",
  voice_rate_limited: "{name} dice troppe richieste o credito finito.",
  voice_service_error: "{name} ha risposto con un errore ({status}).",
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

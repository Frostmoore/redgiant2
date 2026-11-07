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

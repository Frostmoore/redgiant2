// Every word the extension shows, in English and Italian. The browser's language chooses; the
// build writes `_locales` from here for the store's name and description.

const en = {
  extName: "RedGiant Keychain",
  extDescription:
    "Your RedGiant keychain in the browser: fills sign-in forms on their own site only, saves new passwords, makes strong ones.",
  title: "Keychain",
  // Linking
  linkTitle: "Link this browser to RedGiant",
  linkLead:
    "In RedGiant open Settings › Keychain › «Link a browser»: it shows the address and a code.",
  server: "RedGiant's address",
  serverHelp: "As in the browser's bar, e.g. http://localhost:7650 or https://redgiant.example.com",
  code: "Code",
  deviceName: "Name of this browser",
  remember: "Stay linked when the browser closes (the link is kept encrypted)",
  link: "Link",
  linking: "Linking…",
  badServer: "Write RedGiant's address, starting with https:// (http:// only at home).",
  insecureServer:
    "Away from home RedGiant must be reached with https://: a code and passwords must not travel in the clear.",
  noServer: "RedGiant does not answer at this address.",
  badCode: "This code is wrong or expired: make a new one in RedGiant.",
  unlinked: "This browser is no longer linked: link it again with a new code.",
  // Status
  linkedTo: "Linked to {server} as «{name}»",
  unlink: "Unlink",
  closed: "The keychain is closed on the computer with RedGiant.",
  offline: "RedGiant does not answer right now.",
  // The page
  notWeb: "This page cannot hold passwords.",
  forSite: "For {host}",
  notSecure: "This page is not secure (http): passwords are not offered here.",
  noneHere: "No credential of the keychain belongs to this site.",
  search: "Search this site's credentials",
  fill: "Fill",
  copyUser: "Copy user name",
  copyPassword: "Copy password",
  copied: "Copied. The clipboard is emptied in 30 seconds.",
  copiedUser: "User name copied.",
  filled: "Filled.",
  noForm: "There is no sign-in form on this page to fill.",
  refused: "Not for this page: RedGiant gives a password only to its own site.",
  tooMany: "Too many requests: wait a minute.",
  failed: "Something went wrong: {why}",
  // Generator
  generator: "New password",
  genLength: "{n} characters",
  genSymbols: "Letters, digits, symbols",
  genLetters: "Letters and digits",
  genDigits: "Digits only",
  genAgain: "Another",
  genCopy: "Copy",
  genFill: "Put in the page",
  genFilled: "Put in the page's new password fields.",
  // On the page
  chipLabel: "RedGiant Keychain: choose a credential",
  menuTitle: "From your keychain",
  saveTitle: "Save in the keychain?",
  updateTitle: "Update the password in the keychain?",
  saveLead: "The password you just typed on {host}.",
  updateLead: "The password of {service} changed on {host}.",
  saveService: "Name",
  saveUser: "User name",
  saveSites: "Sites where it may be filled",
  saveSitesHelp: "Separated by commas; only this site's domain ({domain}).",
  save: "Save in the keychain",
  update: "Update",
  notNow: "Not now",
  saved: "Saved in the keychain.",
  updated: "Updated in the keychain.",
  close: "Close",
} as const;

export type Key = keyof typeof en;

const it: Record<Key, string> = {
  extName: "Portachiavi RedGiant",
  extDescription:
    "Il tuo portachiavi di RedGiant nel browser: compila gli accessi solo sul loro sito, salva le password nuove, ne crea di robuste.",
  title: "Portachiavi",
  linkTitle: "Collega questo browser a RedGiant",
  linkLead:
    "In RedGiant apri Impostazioni › Portachiavi › «Collega un browser»: trovi l'indirizzo e un codice.",
  server: "Indirizzo di RedGiant",
  serverHelp:
    "Come nella barra del browser, per esempio http://localhost:7650 o https://redgiant.esempio.it",
  code: "Codice",
  deviceName: "Nome di questo browser",
  remember: "Resta collegato quando chiudi il browser (il collegamento è conservato cifrato)",
  link: "Collega",
  linking: "Collegamento…",
  badServer: "Scrivi l'indirizzo di RedGiant, che inizia con https:// (http:// solo in casa).",
  insecureServer:
    "Fuori casa RedGiant va raggiunto con https://: un codice e le password non devono viaggiare in chiaro.",
  noServer: "RedGiant non risponde a questo indirizzo.",
  badCode: "Questo codice è sbagliato o scaduto: creane uno nuovo in RedGiant.",
  unlinked: "Questo browser non è più collegato: ricollegalo con un codice nuovo.",
  linkedTo: "Collegato a {server} come «{name}»",
  unlink: "Scollega",
  closed: "Il portachiavi è chiuso sul computer con RedGiant.",
  offline: "RedGiant ora non risponde.",
  notWeb: "Questa pagina non può contenere password.",
  forSite: "Per {host}",
  notSecure: "Questa pagina non è sicura (http): qui le password non vengono proposte.",
  noneHere: "Nessuna credenziale del portachiavi appartiene a questo sito.",
  search: "Cerca tra le credenziali di questo sito",
  fill: "Compila",
  copyUser: "Copia il nome utente",
  copyPassword: "Copia la password",
  copied: "Copiata. Gli appunti si svuotano fra 30 secondi.",
  copiedUser: "Nome utente copiato.",
  filled: "Compilato.",
  noForm: "In questa pagina non c'è un modulo di accesso da compilare.",
  refused: "Non per questa pagina: RedGiant dà una password solo al suo sito.",
  tooMany: "Troppe richieste: aspetta un minuto.",
  failed: "Qualcosa non ha funzionato: {why}",
  generator: "Password nuova",
  genLength: "{n} caratteri",
  genSymbols: "Lettere, cifre, simboli",
  genLetters: "Lettere e cifre",
  genDigits: "Solo cifre",
  genAgain: "Un'altra",
  genCopy: "Copia",
  genFill: "Metti nella pagina",
  genFilled: "Messa nei campi della password nuova della pagina.",
  chipLabel: "Portachiavi RedGiant: scegli una credenziale",
  menuTitle: "Dal tuo portachiavi",
  saveTitle: "Salvare nel portachiavi?",
  updateTitle: "Aggiornare la password nel portachiavi?",
  saveLead: "La password che hai appena scritto su {host}.",
  updateLead: "La password di {service} è cambiata su {host}.",
  saveService: "Nome",
  saveUser: "Nome utente",
  saveSites: "Siti dove si può compilare",
  saveSitesHelp: "Separati da virgole; solo il dominio di questo sito ({domain}).",
  save: "Salva nel portachiavi",
  update: "Aggiorna",
  notNow: "Non ora",
  saved: "Salvata nel portachiavi.",
  updated: "Aggiornata nel portachiavi.",
  close: "Chiudi",
};

export const dictionaries = { en, it } as const;
export type Lang = keyof typeof dictionaries;

let current: Lang | undefined;

/** The browser's language when it is Italian, English otherwise. */
export function lang(): Lang {
  if (current) return current;
  let ui = "en";
  try {
    ui = globalThis.chrome?.i18n?.getUILanguage?.() ?? globalThis.navigator?.language ?? "en";
  } catch {
    ui = globalThis.navigator?.language ?? "en";
  }
  current = ui.toLowerCase().startsWith("it") ? "it" : "en";
  return current;
}

export function setLang(l: Lang): void {
  current = l;
}

export function t(key: Key, vars: Record<string, string> = {}): string {
  return dictionaries[lang()][key].replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

import { criticalWords, isCriticalId } from "./critical.js";

/**
 * The dangers of the permission policy (`DEFAULT_DANGER_RULES` in @redgiant/hierarchy), in
 * plain words for people: a name, and a line that says what it is with an example. Shared by
 * the web UI and Telegram. A danger without words here shows its id.
 */
type Words = { name: string; hint: string };

const en: Record<string, Words> = {
  "outside-project": {
    name: "Writing outside the project",
    hint: "The guardian: creating, changing or deleting files outside the project's folder, for example in your home or the system's folders.",
  },
  "rm-recursive": {
    name: "Deleting whole folders",
    hint: "Removing a folder with everything inside, for example rm -rf.",
  },
  "git-push": {
    name: "Sending code online",
    hint: "Publishing commits to the shared repository with git push.",
  },
  "git-history": {
    name: "Rewriting code history",
    hint: "Commands that can lose work for good, like git reset --hard or a forced push.",
  },
  "pipe-to-shell": {
    name: "Running something from the internet",
    hint: "Downloading a script and running it straight away, for example curl … | sh.",
  },
  privilege: {
    name: "Administrator rights",
    hint: "Commands with sudo, or changing who owns files and who may run them.",
  },
  disk: {
    name: "Disks and the system",
    hint: "Formatting disks, restarting or switching off the computer, changing system services.",
  },
  containers: {
    name: "Containers",
    hint: "Starting, stopping or removing containers with Docker, Podman or Kubernetes.",
  },
  "database-drop": {
    name: "Deleting data in a database",
    hint: "Removing tables or emptying them, for example DROP TABLE or TRUNCATE.",
  },
  deploy: {
    name: "Publishing and deploying",
    hint: "Putting something online for everyone: npm publish, terraform apply and the like.",
  },
  platform: {
    name: "Changing RedGiant itself",
    hint: "God changing RedGiant's settings, permissions or its own code.",
  },
  "secrets-files": {
    name: "Files with passwords and keys",
    hint: "Reading or touching .env files, SSH keys, certificates and similar.",
  },
  outgoing: {
    name: "Sending, publishing, deleting or paying",
    hint: "Through a connected service: an email, a post, deleting a page, a payment.",
  },
  "git-publish": {
    name: "Opening a pull request or an issue",
    hint: "On the project's repository on GitHub or Gitea, where whoever reads it sees it.",
  },
  "outgoing-browser": {
    name: "Sending, publishing, paying or deleting in the browser",
    hint: "An agent clicks a button like Send, Publish, Pay, Buy or Delete on a web page.",
  },
};

const it: Record<string, Words> = {
  "outside-project": {
    name: "Scrivere fuori dal progetto",
    hint: "Il guardiano: creare, cambiare o cancellare file fuori dalla cartella del progetto, per esempio nella tua home o nelle cartelle di sistema.",
  },
  "rm-recursive": {
    name: "Cancellare cartelle intere",
    hint: "Togliere una cartella con tutto quello che c'è dentro, per esempio rm -rf.",
  },
  "git-push": {
    name: "Mandare il codice online",
    hint: "Pubblicare i commit nella repository condivisa con git push.",
  },
  "git-history": {
    name: "Riscrivere la storia del codice",
    hint: "Comandi che possono far perdere lavoro per sempre, come git reset --hard o un push forzato.",
  },
  "pipe-to-shell": {
    name: "Eseguire qualcosa preso da internet",
    hint: "Scaricare uno script e lanciarlo subito, per esempio curl … | sh.",
  },
  privilege: {
    name: "Permessi da amministratore",
    hint: "Comandi con sudo, oppure cambiare di chi sono i file e chi può eseguirli.",
  },
  disk: {
    name: "Dischi e sistema",
    hint: "Formattare dischi, riavviare o spegnere il computer, cambiare i servizi di sistema.",
  },
  containers: {
    name: "Container",
    hint: "Avviare, fermare o togliere container con Docker, Podman o Kubernetes.",
  },
  "database-drop": {
    name: "Cancellare dati in un database",
    hint: "Togliere tabelle o svuotarle, per esempio DROP TABLE o TRUNCATE.",
  },
  deploy: {
    name: "Pubblicare e mettere in produzione",
    hint: "Mettere qualcosa online per tutti: npm publish, terraform apply e simili.",
  },
  platform: {
    name: "Cambiare RedGiant stesso",
    hint: "God che cambia le impostazioni di RedGiant, i permessi o il suo stesso codice.",
  },
  "secrets-files": {
    name: "File con password e chiavi",
    hint: "Leggere o toccare file .env, chiavi SSH, certificati e simili.",
  },
  outgoing: {
    name: "Inviare, pubblicare, cancellare o pagare",
    hint: "Tramite un servizio collegato: una email, un post, cancellare una pagina, un pagamento.",
  },
  "git-publish": {
    name: "Aprire una pull request o una issue",
    hint: "Sul repository del progetto su GitHub o Gitea, dove la vede chi lo legge.",
  },
  "outgoing-browser": {
    name: "Inviare, pubblicare, pagare o cancellare nel browser",
    hint: "Un agente clicca un pulsante come Invia, Pubblica, Paga, Acquista o Elimina su una pagina web.",
  },
};

export const DANGER_IDS = Object.keys(en);

/**
 * Dangers that are not on the Safety page because nobody switches them (G38.1: every email an
 * agent sends asks the person). Their words only, for the request's chips.
 */
const FIXED: Record<"it" | "en", Record<string, Words>> = {
  en: {
    "outgoing-mail": {
      name: "Sending an email",
      hint: "An agent sends an email from one of your mailboxes: you see who it goes to and what it says before it leaves.",
    },
  },
  it: {
    "outgoing-mail": {
      name: "Inviare un'email",
      hint: "Un agente invia un'email da una delle tue caselle: vedi a chi va e cosa dice prima che parta.",
    },
  },
};

export function dangerWords(lang: "it" | "en", id: string): Words {
  // The truly dangerous requests (G36.17b) travel with the dangers of a request too.
  if (isCriticalId(id)) {
    const w = criticalWords(lang, id);
    return { name: w.name, hint: w.hint };
  }
  return (lang === "it" ? it : en)[id] ?? FIXED[lang][id] ?? { name: id, hint: "" };
}

# RedGiant — le funzionalità dell'harness

Panoramica breve di tutto quello che l'harness sa fare, ricavata da `memory/codebase_reference.md` (ramo 3.3, correzioni
p3.3.1–p3.3.2, punti G36 compresi). Per firme, file e dettagli tecnici fa fede la codebase reference.

---

## 1. Che cos'è e dove gira

- **Un harness per agenti AI personale**, organizzato come un albero di agenti (God, Demi-God, orchestratori, agenti,
  sotto-agenti, assistenti, ispettori) che lavorano su progetti veri, con un'interfaccia web, chat esterne, automazioni e
  modelli cloud o locali.
- **Windows nativo**: `RedGiant.exe` avvia il server sotto Node, un Postgres incorporato, llama.cpp nativo, Git portatile,
  whisper.cpp. Niente WSL, e Docker solo se c'è già.
- **macOS**: un'app nella barra dei menu che avvia server, Postgres e motore (Metal), firmata e notarizzata.
- **Linux/Docker**: `compose.yaml` con Postgres+pgvector, server, proxy di egress e profili facoltativi (motore CPU/CUDA/Vulkan,
  SearXNG, whisper).
- **CLI** (`redgiant`) per progetti, agenti, sessioni, chat, approvazioni e verifica del log.

## 2. La gerarchia degli agenti

- **Tipi**: `god` (uno per persona, gestisce la piattaforma), `demigod` (l'interlocutore sulle chat, parla solo con God),
  `orchestrator` (uno per progetto), `agent`, `subagent`, `inspector` (legge un progetto in sola lettura), `assistant`
  (assistenti personali sotto God, compresa la «Chat»).
- **Ambiti**: una sola funzione pura (`can`) decide chi può leggere, scrivere, creare, fermare, configurare, approvare o
  scegliere gli strumenti di chi; è testata come tabella.
- **Registro degli agenti**: creazione, arresto di un sottoalbero, configurazione (modello, modo, istruzioni, connessioni,
  compattazione), spostamento fra progetti e sottoprogetti, modello ereditato dal genitore.
- **Progetti e sottoprogetti**: ogni sottoprogetto vede le parti comuni, scrive solo nella sua cartella e può avere un
  container proprio.
- **Istruzioni con segnaposto** (`{name}`, `{god}`, `{demigod}`, `{role}`): predefinite per tipo, modificabili, con un
  **refiner** che le riscrive con un modello scelto (stima del costo, confronto parola per parola, mai salvate da sole) e
  che scrive le istruzioni di un agente appena creato.
- **Modi di permesso**: manuale, automatico, piano (solo lettura finché il piano non è approvato), sola lettura.
- **Lingua degli agenti** (76 lingue) distinta dalla lingua dell'interfaccia (it/en).

## 3. Conversazioni e ciclo dell'agente

- **Il log degli eventi è la fonte della verità**: ogni passo va prima in `EventStore` (Postgres, catena di hash, niente
  DELETE, cancellazioni solo come oscuramento del payload) e lo stato si ricostruisce con `rebuildHistory`, identico a
  quello vivo. Verifica dell'integrità ed esportazione JSONL.
- **Prefisso stabile per la cache**: strumenti in ordine per nome, system prompt fisso per la sessione, storia append-only,
  ragionamento sempre rimandato al modello, effort fisso (lo cambia solo la persona dal composer).
- **Ciclo degli strumenti**: riparazione del JSON malformato, hook prima e dopo, validazione zod, permesso, esecuzione;
  **letture in parallelo**, avviso sulle chiamate ripetute, chiamate troncate rifiutate con «fai un passo più piccolo»,
  riepilogo finale quando finiscono i passi.
- **Compattazione**: automatica in background oltre l'80 % del contesto, d'emergenza oltre il 90 %, manuale con
  `/compact`; riusa la stessa richiesta più un messaggio; si può annullare.
- **Messaggi durante il lavoro**: in coda o «steer» (entrano nel turno in corso dopo gli strumenti); un messaggio in coda si
  può ritirare.
- **Fork**: modificare un messaggio apre una conversazione nuova fino a quel punto.
- **Comandi in background**: `bash` con `background`, registro con l'orario di ogni riga, lettura filtrata con
  `bash_output` (grep, intervalli, attesa di un testo, riassunto di errori e avvisi), arresto dell'albero dei processi,
  recupero dei processi orfani al riavvio, limiti decisi dalla persona.
- **Lista dei passi** (`update_todos`) mostrata sopra il composer.
- **Esportazione in Markdown** di una conversazione; ricerca in tutte le conversazioni.

## 4. Modelli e fornitori

- **Anthropic** nativo (cache, thinking adattivo, effort, fallback lato server, ricerca web nativa).
- **OpenAI-compatibili**: OpenAI, Gemini, Mistral, DeepSeek, xAI, Groq, OpenRouter, Together, Fireworks, Cerebras e server
  propri; lettura del contesto da `/models`, `reasoning_content` rimandato.
- **Abbonamenti**: Claude (tramite Claude Code / Agent SDK) e ChatGPT (tramite Codex), scaricati solo quando servono, con
  login riusato se la persona l'ha già fatto, limiti di utilizzo mostrati.
- **Fallback**: ritenta gli errori temporanei, poi passa al modello di riserva indicato; anche un rifiuto passa al fallback.
- **Modello di riserva** per i compiti abbandonati: riprova con un altro modello e il primo tentativo come contesto.
- **Budget** per agente, progetto e totale, persistenti, con spesa giornaliera; la corsa si ferma al tetto.
- **Metriche per messaggio**: token, cache letta/scritta, tempi di prefill e decodifica, token/s, costo.

## 5. Motore locale (llama.cpp)

- Avvio con barra (download, precaricamento, caricamento), sempre con `--slot-save-path` e `--swa-full`.
- **KV cache su disco**: salva e ripristina gli slot per prefisso più lungo (anche fra conversazioni), con budget e
  priorità per tipo di agente; precalcolo delle ultime conversazioni all'avvio.
- **Rilevamento dell'hardware** (GPU, VRAM, RAM, dischi) e **catalogo dei modelli locali** con stima della velocità; ricerca
  e download da Hugging Face con ripresa.
- **SSD stream** per i modelli MoE più grandi della memoria: piano automatico fra scheda, RAM e SSD, prove di velocità sul
  turno tipico; opzioni sperimentali «passate grandi» e «il prossimo strato in anticipo» (build di llama.cpp patchata).
- Decodifica speculativa (modello bozza o n-gram), template di chat corretti (gpt-oss), spostamento dei modelli su un altro
  disco.

## 6. Strumenti

- **Strumenti di base** per chi ha un workspace: `bash`, `read_file`, `write_file`, `edit_file` (con diff), `glob`,
  `grep`, `fetch` (anti-SSRF), `web_search`, `view_image`, `show_file`, `update_todos`, più `convert_file`,
  `edit_package`, `blender`.
- **Per ruolo**: orchestrazione (`delegate`, `create_agent`, `run_subagent(s)`, `ask_god`, `ask_assistant`…), bacheca,
  domande e piani, memoria, skill, generazione di media, `send_file`, `publish_board`, `run_script` (Python/JS che chiama gli
  altri strumenti, ognuno controllato), strumenti personalizzati, MCP, browser, `use_credential`, `repo_*`.
- **Pagina degli strumenti**: la persona spegne strumenti per tutti o per un agente, vedendo quanti token pesano; gli
  indispensabili non si spengono. Il set è fissato all'inizio della conversazione.
- **`request_tool`**: un agente chiede uno strumento spento; col sì della persona entra nella sessione (una volta o per sempre).
- I creatori possono spegnere strumenti all'agente che hanno appena creato (`tools_off`).

## 7. Sandbox e workspace

- **Host** (predefinito): i percorsi restano chiusi nel workspace; le scritture fuori passano dal guardiano.
- **Docker** (facoltativo): container senza capability, rete interna, `/tmp` in RAM, gVisor possibile, cartelle montate dal
  volume dei dati; una sandbox per workspace, riusata.
- **Worktree git** per ogni agente e sotto-agente (merge uno per uno, conflitti segnalati).
- **Proxy di egress** con lista di host consentiti, rotte con credenziali iniettate (git, portachiavi), controllo di dove
  risolve ogni nome; i segreti non entrano mai nell'ambiente della sandbox.
- Ambiente dei comandi ripulito (`agentEnv`): solo variabili innocue, più i programmi di RedGiant nel PATH.
- Terminale interattivo (pty / ConPTY) nella pagina.

## 8. Sicurezza e permessi

- **Politica**: regole della persona (deny > ask > allow), 14 pericoli predefiniti (rm ricorsivo, push, riscrittura della
  storia, pipe nella shell, privilegi, dischi, container, drop di database, deploy, messaggi in uscita, file di segreti…).
- **Guardiano**: riconosce le scritture fuori dal progetto anche dentro i comandi shell.
- **Le cose davvero pericolose** (`criticalOf`, tabella di 107 casi): file di sistema, cancellazioni per sempre, segreti che
  escono, pagamenti veri, le protezioni di RedGiant. Chiedono sempre alla persona, in ogni modo e su ogni canale; il tempo
  scaduto è un no.
- **Catena di approvazione**: la richiesta sale lungo i genitori (che possono approvare, negare o passare oltre) fino alla
  persona; errore o timeout non valgono mai «sì».
- **Richieste a te**: «Chiedimelo» (arrivano ovunque, la prima risposta chiude le altre copie e dice dove) oppure «Non
  chiedermi niente» (decide un classificatore, con il motivo nel log; un classificatore che fallisce è un no). Tempo di
  attesa e comportamento allo scadere configurabili; elenco delle decisioni prese senza la persona.
- Approvazioni «una volta», «per questa chat», «sempre», e diniego con motivo letto dall'agente.
- Accesso con token, password e codice TOTP, sessioni revocabili.

## 9. Portachiavi

- Ogni chiave e password in un unico posto, cifrata (AES-256-GCM) con la chiave principale protetta da DPAPI su Windows,
  dal portachiavi su Mac, da file altrove; rifiuta di aprirsi dentro un repository git.
- Gli agenti usano una credenziale **per nome** (`use_credential`, `{{vault:nome}}`, o un indirizzo del proxy per gli
  strumenti) senza mai vederne il valore; host consentiti, chi può usarla, quando chiedere (sempre, una volta per
  conversazione, mai).
- Registro di ogni uso; i valori sono oscurati nel log e nelle risposte.
- Un segreto incollato in chat viene fermato prima dell'invio, con la proposta di metterlo nel portachiavi.
- Import CSV da Bitwarden, 1Password, Chrome, Firefox; export sigillato con una frase; elenco delle chiavi tenute altrove.

## 10. Memoria

- **Note per agente e per progetto** (`memory`), nel system prompt della conversazione.
- **Memoria condivisa** per persona: fatti brevi e duraturi, imparati da soli da un modello leggero che legge solo le
  parole della persona (segreti esclusi), modificabili, annullabili, «dimentica per sempre».

## 11. Compiti, squadre e coordinamento

- **Compiti (RD17)**: `delegate` apre un compito che si chiude solo con `complete_task` e un verificatore che esce con 0 (o
  un «non testabile» motivato); dopo tre promemoria il compito è abbandonato.
- **Sotto-agenti** in parallelo (fino a 6), ciascuno nel suo worktree, con schede nella chat a più livelli.
- **Bacheca** del progetto: thread di task, risultati, domande, decisioni, blocchi; ricerca, rilevamento dei doppioni,
  riassunti periodici.
- **Gruppi**: stanze con fino a 6 agenti e la persona, menzioni, turni limitati.
- **Domande e piani**: `ask_user` (scelte multiple) e `propose_plan` (approvazione che fa uscire dal modo piano).
- **Spinta alle skill**: dopo un problema risolto a fatica l'agente è invitato a proporre o aggiornare una skill.

## 12. Estensioni

- **Skill** nello standard agentskills.io (cercabili, caricabili, condivisibili in zip), di piattaforma o di progetto.
- **Server MCP**: catalogo di 37 voci, stdio o HTTP, OAuth gestito, credenziali in file privati.
- **Strumenti personalizzati** (comando + schema) eseguiti nella sandbox.
- **Proposte degli agenti**: provate in una sandbox usa e getta, poi aspettano la persona; le skill senza script possono
  installarsi da sole se la persona lo sceglie; aggiornamenti di una skill esistente invece dei doppioni.

## 13. Automazioni

- **Ricette YAML**: un agente (mai i suoi strumenti), istruzioni o semplice promemoria, sessione nuova o continua.
- **Inneschi**: cron, data, webhook (anche eventi GitHub/Gitea), email, messaggi dalle chat, cambi di file, fine di un'altra
  automazione, chiusura di un compito, avvio, ripetizione dopo un fallimento, manuale.
- **Condizioni**: ore, giorni, date, mittenti, parole, massimo al giorno, pausa minima.
- **Controlli**: approvazione prima della corsa, tetto di spesa, niente sovrapposizioni (salta o metti in coda), tentativi e
  ricetta di riserva, recupero delle corse perse.
- **Consegna** su chat, pagina web o email, con l'esito registrato per ogni corsa.
- I dati dei webhook, delle email e dei messaggi arrivano all'agente come **dati, non istruzioni**.
- **Automazioni magiche**: la persona descrive cosa vuole, God costruisce la ricetta conversando, elenca ciò che manca
  (chat, caselle, credenziali, estensioni) e nulla si crea prima del sì.
- **Caselle email multiple** per categoria (IMAP in ingresso, SMTP in uscita).
- Editor visuale con frase in parole e anteprima delle prossime esecuzioni; orologio finto per i test.

## 14. Canali

- **Pagina web** (WebSocket, messaggi in ordine per connessione).
- **Telegram** (grammY): abbinamento con codice, foto, documenti, vocali, pulsanti per approvazioni e domande, comandi
  `/new`, `/status`, `/stop`.
- **Gateway** per Discord, Slack, Signal, WhatsApp, Matrix, Microsoft Teams, iMessage (BlueBubbles): una sola conversazione
  per persona che continua da una chat all'altra; scelte numerate dove mancano i pulsanti.
- **Notifiche del browser** a pagina nascosta; campanella con permessi, domande, proposte e avvisi.

## 15. File, Canvas e conversioni

- **Esploratore e editor** (CodeMirror) dei file del progetto, cestino, conflitti di salvataggio.
- **Canvas**: `show_file` apre un file a lato; visualizzatori per video/audio, immagini, PDF, codice e Markdown, tabelle
  (CSV, XLSX, ODS), documenti (DOCX, ODT), presentazioni, modelli 3D (three.js), archivi, font, JSON/YAML/XML ad albero,
  OpenRaster a livelli; anteprima di siti in iframe isolato. Area ridimensionabile, ingrandibile e a schermo intero.
- **Anteprima impaginata** dei documenti Office tramite LibreOffice, scaricato la prima volta.
- **Solo formati aperti**: un file chiuso si converte accanto all'originale in `<file>.open/`, con un manifesto e le
  **perdite dichiarate**. PSD → ORA/PNG (livelli, fusioni, maschere), IDML → SLA (Scribus) o ODG con l'impaginazione,
  Sketch → SVG, 3D → GLB (Blender), video e audio → WebM/Opus (ffmpeg); per InDesign, Affinity, XD e Figma solo
  l'anteprima, con «Apri in…» se l'app è installata.
- **Strumento `blender`**: script Python, rendering (Cycles/EEVEE) e giro a 360° in video.
- Programmi esterni (LibreOffice, Scribus, Blender, ffmpeg, 7-Zip) scaricati con barra, mai installati né inclusi.

## 16. Browser degli agenti

- Chrome/Edge/Chromium del computer (o un container): aprire, leggere, cliccare, scrivere, schede, schermate (solo per i
  modelli che vedono).
- La persona guarda dal vivo, prende il controllo o insegna; password mai rilette; i clic che inviano, pagano o cancellano
  passano dai permessi.

## 17. Conoscenza (RAG)

- **pgvector** dentro il Postgres di RedGiant, ricerca ibrida (significato + parole, RRF) con reranker facoltativo.
- **Raccolte** per tutti, per agente o per progetto; fonti: cartelle (con `.gitignore`), workspace, file, pagine web.
- Indicizzazione incrementale con osservazione dei file, riuso dei vettori per i file spostati, cambio di modello senza
  fermare la ricerca.
- Estrazione di testo, codice, Markdown, PDF per pagina, Office, HTML; **citazioni** che aprono il Canvas alla pagina o
  alla riga giusta.
- Embedding locali (llama.cpp, modelli Qwen3/Gemma/BGE…) o cloud (OpenAI, Voyage, Cohere, Gemini, Mistral, Jina).

## 18. Media, voce e ricerca web

- **Generazione**: immagini, video, voce, musica, suoni da OpenAI, Google, xAI, BFL, Runway, ElevenLabs.
- **Trascrizione dei vocali**: whisper.cpp locale (scaricato da solo), whisper-asr o API OpenAI; decodifica Opus in WASM,
  ffmpeg per gli altri formati.
- **Ricerca web**: SearXNG gestito (anche senza Docker), Brave, Tavily, Exa, Serper, o la ricerca nativa di Anthropic.

## 19. Ispettore, Chat e assistenti

- **Inspector** per progetto: legge tutto in sola lettura, risponde a domande, riassunto giornaliero, comandi degli agenti
  consultabili.
- **Chat quotidiana**: un assistente con tutti gli strumenti, chat in cartelle, modello scelto in chat.
- **Assistenti** personali con scrivania condivisa e connessioni scelte.

## 20. La piattaforma che si modifica (G14)

- God cambia la configurazione (agenti, budget, automazioni, politica, MCP, strumenti) con l'autorità della persona, che
  approva; ogni cambio tiene il «prima» ed è annullabile.
- **Modifiche al codice** di RedGiant: worktree, test, copia di prova con ambiente pulito (senza segreti), promozione solo
  con un server supervisionato; il **supervisor** ricompila, controlla la salute e torna all'ultima versione buona se la
  nuova fallisce.

## 21. Import da altri agenti

- Da Claude Code, Codex, Cursor, Gemini/Antigravity, opencode, Hermes, export di ChatGPT e Claude: istruzioni, skill,
  server MCP (chiavi nelle credenziali), ricordi, conversazioni.
- Scansione del computer, cartella scelta o zip; anteprima con scelte per voce e conflitti; import annullabile; ricordi
  proposti dalle conversazioni importate.

## 22. Backup e aggiornamenti

- **Backup** (gzip): progetti, agenti, conversazioni, file, impostazioni; il portachiavi solo sigillato con una frase;
  verifica rileggendo tutto; ritrovamento dei backup al primo avvio.
- **Aggiornamenti**: controllo ogni 6 ore; su Windows **aggiornamenti differenziali** (solo i file cambiati, manifesto
  firmato, swap con giornale e ripristino automatico se la nuova versione non parte).
- **Tipi di rilascio** firmati (normale, obbligatorio, breaking): un obbligatorio ferma i messaggi finché non si aggiorna; un
  breaking non si applica mai sul posto, fa prima un backup di sicurezza e guida a una reinstallazione pulita.

## 23. Interfaccia web

- Preact + signals, disposizione come Officina: barra a sinistra (conversazioni e impostazioni), linguette al centro, file,
  editor, terminali e Canvas a destra.
- **Wizard «una cosa alla volta»**: lingua, modo d'installazione, modelli (chiavi, abbonamenti, locale), nomi, chi usa quale
  modello, Telegram, codice (GitHub/Gitea), accesso da fuori (Tailscale, Cloudflare, Caddy), sicurezza e spese.
- **Impostazioni** a gruppi: generale, agenti, memoria, automazioni, estensioni, strumenti, portachiavi, chat, abbonamenti,
  budget, codice, accesso remoto, backup, piattaforma, comandi, richieste, import.
- Tema chiaro/scuro/di sistema, italiano e inglese ovunque (`t()`), icone disegnate (niente emoji), Markdown sempre
  ripulito con DOMPurify, fonti come link nel testo, versione per il telefono, finestra delle novità.
- Servizi facoltativi: Gitea, Pi-hole, accesso remoto, registro di debug scaricabile.

## 24. Valutazioni (evals)

- **Compiti** (correggere bug, implementare una specifica, refactoring, test, CLI, debug…) con verificatore nascosto, che
  rifiuta i file iniziali e accetta una soluzione di riferimento.
- **Suite harness**: scenari (delega, squadre in parallelo, estensioni, automazioni, confini, memoria lunga, recupero,
  budget, concorrenza) con controlli comuni: nessun errore del programma, ogni chiamata col suo risultato, cache del
  prefisso almeno al 50 %.

/**
 * MCP servers people can add with a click (G24.9): the services' own servers first, then
 * community ones, marked as such. Each says how it signs in: nothing, the service's sign-in
 * page (OAuth), or a key pasted once (kept in a private file, never in the database).
 */
export type McpCategory = "code" | "docs" | "web" | "data" | "work" | "design" | "cloud" | "home";

/** Steps in plain words, for the person who sets something up on the service's site. */
export type Guide = { it: string[]; en: string[] };

export type McpCatalogAuth =
  | { type: "none" }
  /** The service's sign-in page; RedGiant registers itself (dynamic registration). */
  | { type: "oauth" }
  /**
   * The person's own OAuth app (G24.14c): the service does not let RedGiant register, so the
   * person creates an app on its site (the guide), with RedGiant's return address, and pastes
   * its client id (and secret). Nothing is registered or hosted by the project.
   */
  | {
      type: "app";
      consoleUrl: string;
      /** The service gives a client secret too. */
      secret: boolean;
      /** Asked at sign-in, space-separated. */
      scope?: string;
      /** Added to the sign-in address. */
      authParams?: Record<string, string>;
      guide: Guide;
    }
  /** A key sent in a header (`Authorization: Bearer <key>` when `prefix` is "Bearer "). */
  | {
      type: "header";
      header: string;
      prefix?: string;
      keyUrl: string;
      keyExample?: string;
      guide?: Guide;
    }
  /** A key given to a local server as an environment variable. */
  | { type: "env"; env: string; keyUrl: string; keyExample?: string; guide?: Guide }
  /** Several values for a local server's environment (address, user, password…). */
  | {
      type: "fields";
      fields: {
        env: string;
        label: { it: string; en: string };
        secret: boolean;
        example?: string;
        optional?: boolean;
      }[];
      guide: Guide;
    };

export interface McpCatalogEntry {
  /** Also the server's name once added. */
  id: string;
  /** The brand, the same in every language. */
  name: string;
  /** Made by the service itself; community servers are marked. */
  official: boolean;
  category: McpCategory;
  description: { it: string; en: string };
  transport: { type: "http"; url: string } | { type: "stdio"; command: string; args: string[] };
  auth: McpCatalogAuth;
  homepage: string;
  /**
   * The server is the person's own (Home Assistant): they give its address, and `path` is
   * added to it; `transport.url` is then only an example.
   */
  userUrl?: { example: string; path: string };
  /** Not confirmed on the vendor's own pages: shown as such. */
  unverified?: boolean;
  /** What to know before choosing it (a plan needed, a preview…). */
  note?: { it: string; en: string };
}

/** What the person typed for an entry: a key, the fields, their app, their server's address. */
export interface CatalogInput {
  key?: string;
  fields?: Record<string, string>;
  app?: { clientId: string; clientSecret?: string };
  url?: string;
}

/** The entry needs something from the person before it can be added. */
export const needsInput = (e: McpCatalogEntry): boolean =>
  e.auth.type === "header" ||
  e.auth.type === "env" ||
  e.auth.type === "fields" ||
  e.auth.type === "app" ||
  e.userUrl !== undefined;

/**
 * Checked on the services' own pages (2026-11-02/03). Services that do not let RedGiant register
 * itself come with a guide to the person's own app (G24.14c: nothing is registered or hosted by
 * the project). Left out, with their reason: Figma and Vercel (only clients they approved),
 * WhatsApp (Meta's server is for testing only), Spotify (its community server needs a browser on
 * the server), Discord (a Docker image), Microsoft Teams' own server (legacy: Work IQ covers it).
 */
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: "gitlab",
    name: "GitLab",
    official: true,
    category: "code",
    description: {
      it: "Progetti, issue e merge request su GitLab.",
      en: "Projects, issues and merge requests on GitLab.",
    },
    transport: { type: "http", url: "https://gitlab.com/api/v4/mcp" },
    auth: { type: "oauth" },
    homepage: "https://docs.gitlab.com/user/model_context_protocol/mcp_server/",
  },
  {
    id: "sentry",
    name: "Sentry",
    official: true,
    category: "code",
    description: {
      it: "Gli errori delle tue app: leggerli e trovarne la causa.",
      en: "The errors of your apps: read them, find their cause.",
    },
    transport: { type: "http", url: "https://mcp.sentry.dev/mcp" },
    auth: { type: "oauth" },
    homepage: "https://mcp.sentry.dev/",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    official: true,
    category: "cloud",
    description: {
      it: "Il tuo account Cloudflare: domini, DNS, Workers e altro.",
      en: "Your Cloudflare account: domains, DNS, Workers and more.",
    },
    transport: { type: "http", url: "https://mcp.cloudflare.com/mcp" },
    auth: { type: "oauth" },
    homepage:
      "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
  },
  {
    id: "notion",
    name: "Notion",
    official: true,
    category: "docs",
    description: {
      it: "Leggere e scrivere pagine e database del tuo Notion.",
      en: "Read and write the pages and databases of your Notion.",
    },
    transport: { type: "http", url: "https://mcp.notion.com/mcp" },
    auth: { type: "oauth" },
    homepage: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
  },
  {
    id: "atlassian",
    name: "Jira and Confluence (Atlassian Rovo)",
    official: true,
    category: "work",
    description: {
      it: "Ticket di Jira e pagine di Confluence (Atlassian Cloud).",
      en: "Jira tickets and Confluence pages (Atlassian Cloud).",
    },
    transport: { type: "http", url: "https://mcp.atlassian.com/v2/mcp" },
    auth: { type: "oauth" },
    homepage: "https://github.com/atlassian/atlassian-mcp-server",
  },
  {
    id: "linear",
    name: "Linear",
    official: true,
    category: "work",
    description: {
      it: "Issue, progetti e cicli su Linear.",
      en: "Issues, projects and cycles on Linear.",
    },
    transport: { type: "http", url: "https://mcp.linear.app/mcp" },
    auth: { type: "oauth" },
    homepage: "https://linear.app/docs/mcp",
  },
  {
    id: "trello",
    name: "Trello",
    official: true,
    category: "work",
    description: {
      it: "Bacheche, liste e schede su Trello.",
      en: "Boards, lists and cards on Trello.",
    },
    transport: { type: "http", url: "https://mcp.trello.com/v1" },
    auth: { type: "oauth" },
    homepage: "https://github.com/atlassian/trello-mcp-server",
  },
  {
    id: "todoist",
    name: "Todoist",
    official: true,
    category: "work",
    description: {
      it: "Le tue attività e i tuoi progetti su Todoist.",
      en: "Your tasks and projects on Todoist.",
    },
    transport: { type: "http", url: "https://ai.todoist.net/mcp" },
    auth: { type: "oauth" },
    homepage: "https://developer.todoist.com/",
  },
  {
    id: "monday",
    name: "monday.com",
    official: true,
    category: "work",
    description: {
      it: "Bacheche ed elementi su monday.com.",
      en: "Boards and items on monday.com.",
    },
    transport: { type: "http", url: "https://mcp.monday.com/mcp" },
    auth: { type: "oauth" },
    homepage: "https://github.com/mondaycom/mcp",
  },
  {
    id: "clickup",
    name: "ClickUp",
    official: true,
    category: "work",
    description: {
      it: "Attività, liste e documenti su ClickUp.",
      en: "Tasks, lists and documents on ClickUp.",
    },
    transport: { type: "http", url: "https://mcp.clickup.com/mcp" },
    auth: { type: "oauth" },
    homepage: "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server",
  },
  {
    id: "zapier",
    name: "Zapier",
    official: true,
    category: "work",
    description: {
      it: "Migliaia di app attraverso le tue azioni Zapier (consuma le attività Zapier).",
      en: "Thousands of apps through your Zapier actions (uses your Zapier tasks).",
    },
    transport: { type: "http", url: "https://mcp.zapier.com/api/v1/connect" },
    auth: { type: "oauth" },
    homepage: "https://docs.zapier.com/mcp/get-started/authentication",
  },
  {
    id: "intercom",
    name: "Intercom",
    official: true,
    category: "work",
    description: {
      it: "Conversazioni e contatti dell'assistenza clienti su Intercom.",
      en: "Conversations and contacts of your customer support on Intercom.",
    },
    transport: { type: "http", url: "https://mcp.intercom.com/mcp" },
    auth: { type: "oauth" },
    homepage: "https://developers.intercom.com/docs/guides/mcp",
  },
  {
    id: "stripe",
    name: "Stripe",
    official: true,
    category: "work",
    description: {
      it: "Pagamenti, clienti e fatture su Stripe.",
      en: "Payments, customers and invoices on Stripe.",
    },
    transport: { type: "http", url: "https://mcp.stripe.com" },
    auth: { type: "oauth" },
    homepage: "https://docs.stripe.com/mcp",
  },
  {
    id: "paypal",
    name: "PayPal",
    official: true,
    category: "work",
    description: {
      it: "Fatture, ordini e pagamenti su PayPal.",
      en: "Invoices, orders and payments on PayPal.",
    },
    transport: { type: "http", url: "https://mcp.paypal.com/http" },
    auth: { type: "oauth" },
    homepage: "https://developer.paypal.com/tools/mcp-server/",
  },
  {
    id: "square",
    name: "Square",
    official: true,
    category: "work",
    description: {
      it: "Pagamenti, ordini e catalogo su Square.",
      en: "Payments, orders and catalog on Square.",
    },
    transport: { type: "http", url: "https://mcp.squareup.com/mcp" },
    auth: { type: "oauth" },
    homepage: "https://developer.squareup.com/docs/mcp",
  },
  {
    id: "airtable",
    name: "Airtable",
    official: true,
    category: "data",
    description: {
      it: "Basi, tabelle e record su Airtable.",
      en: "Bases, tables and records on Airtable.",
    },
    transport: { type: "http", url: "https://mcp.airtable.com/mcp" },
    auth: { type: "oauth" },
    homepage: "https://airtable.com/developers/agents/mcp/getting-started",
  },
  {
    id: "supabase",
    name: "Supabase",
    official: true,
    category: "data",
    description: {
      it: "Database, tabelle e progetti su Supabase.",
      en: "Databases, tables and projects on Supabase.",
    },
    transport: { type: "http", url: "https://mcp.supabase.com/mcp" },
    auth: { type: "oauth" },
    homepage: "https://supabase.com/docs/guides/getting-started/mcp",
  },
  {
    id: "neon",
    name: "Neon",
    official: true,
    category: "data",
    description: {
      it: "Database Postgres su Neon: tabelle, query, branch.",
      en: "Postgres databases on Neon: tables, queries, branches.",
    },
    transport: { type: "http", url: "https://mcp.neon.tech/mcp" },
    auth: { type: "oauth" },
    homepage: "https://neon.com/docs/ai/neon-mcp-server",
  },
  {
    id: "hugging-face",
    name: "Hugging Face",
    official: true,
    category: "data",
    description: {
      it: "Modelli, dataset e spazi su Hugging Face.",
      en: "Models, datasets and spaces on Hugging Face.",
    },
    transport: { type: "http", url: "https://huggingface.co/mcp" },
    auth: { type: "oauth" },
    homepage: "https://huggingface.co/docs/hub/hf-mcp-server",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    official: true,
    category: "web",
    description: {
      it: "Ricerche sul web con le fonti, tramite Perplexity (a pagamento sul tuo account).",
      en: "Web search with sources, through Perplexity (billed to your account).",
    },
    transport: { type: "http", url: "https://api.perplexity.ai/mcp" },
    auth: { type: "oauth" },
    homepage: "https://docs.perplexity.ai/guides/mcp-server",
  },
  {
    id: "github",
    name: "GitHub",
    official: true,
    category: "code",
    description: {
      it: "Repository, issue e pull request su GitHub.",
      en: "Repositories, issues and pull requests on GitHub.",
    },
    transport: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
    auth: {
      type: "header",
      header: "Authorization",
      prefix: "Bearer ",
      keyUrl: "https://github.com/settings/personal-access-tokens",
      keyExample: "github_pat_…",
    },
    homepage: "https://github.com/github/github-mcp-server",
  },
  {
    id: "exa",
    name: "Exa",
    official: true,
    category: "web",
    description: {
      it: "Ricerca sul web e lettura delle pagine, tramite Exa.",
      en: "Web search and page reading, through Exa.",
    },
    transport: { type: "http", url: "https://mcp.exa.ai/mcp" },
    auth: { type: "header", header: "x-api-key", keyUrl: "https://dashboard.exa.ai/api-keys" },
    homepage: "https://docs.exa.ai/reference/exa-mcp",
  },
  {
    id: "google-maps",
    name: "Google Maps (Grounding Lite)",
    official: true,
    category: "web",
    description: {
      it: "Luoghi, percorsi e meteo da Google Maps (a pagamento su Google).",
      en: "Places, routes and weather from Google Maps (billed by Google).",
    },
    transport: { type: "http", url: "https://mapstools.googleapis.com/mcp" },
    auth: {
      type: "header",
      header: "X-Goog-Api-Key",
      keyUrl: "https://console.cloud.google.com/google/maps-apis/credentials",
      keyExample: "AIza…",
    },
    homepage: "https://developers.google.com/maps/ai/grounding-lite/reference/mcp",
  },
  {
    id: "gmail",
    name: "Gmail",
    official: true,
    category: "work",
    description: {
      it: "Leggere la posta e scrivere bozze in Gmail (l'invio resta tuo).",
      en: "Read your email and write drafts in Gmail (sending stays yours).",
    },
    transport: { type: "http", url: "https://gmailmcp.googleapis.com/mcp/v1" },
    auth: {
      type: "app",
      consoleUrl: "https://console.cloud.google.com/auth/clients",
      secret: true,
      scope:
        "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
      authParams: { access_type: "offline", prompt: "consent" },
      guide: {
        it: [
          "Verifica che il tuo progetto Google Cloud sia iscritto al Google Workspace Developer Preview Program (senza iscrizione l'API MCP non compare).",
          "Apri console.cloud.google.com, scegli o crea un progetto, vai in 'API e servizi > Libreria' e abilita 'Gmail API' e 'Gmail MCP API'.",
          "Apri 'Google Auth Platform' (schermata di consenso OAuth): compila 'Branding'; in 'Pubblico' scegli 'Interno' se hai Google Workspace, altrimenti 'Esterno' e aggiungi il tuo indirizzo Google come utente di test.",
          "In 'Accesso ai dati' aggiungi questi ambiti (scope): https://www.googleapis.com/auth/gmail.readonly, https://www.googleapis.com/auth/gmail.compose.",
          "Vai in 'Client' > 'Crea client', scegli 'Applicazione web' e spunta 'Use this client for an AI-powered agent' (usa questo client per un agente IA).",
          "In 'URI di reindirizzamento autorizzati' incolla {redirect} e premi Crea.",
          "Copia ID client e Client secret, incollali in RedGiant, poi premi Collega e accedi con Google.",
          "Se hai scelto 'Esterno' e lasci l'app 'In test', il collegamento scade ogni 7 giorni: ricollegati, oppure premi 'Pubblica app' (comparirà l'avviso 'app non verificata', accettabile per uso personale).",
        ],
        en: [
          "Make sure your Google Cloud project is enrolled in the Google Workspace Developer Preview Program (without it the MCP API does not appear).",
          "Open console.cloud.google.com, pick or create a project, go to 'APIs & Services > Library' and enable 'Gmail API' and 'Gmail MCP API'.",
          "Open 'Google Auth Platform' (OAuth consent screen): fill Branding; under Audience choose 'Internal' if you have Google Workspace, otherwise 'External' and add your own Google address as a test user.",
          "Under 'Data Access' add these scopes: https://www.googleapis.com/auth/gmail.readonly, https://www.googleapis.com/auth/gmail.compose.",
          "Go to 'Clients' > 'Create client', choose 'Web application' and tick 'Use this client for an AI-powered agent'.",
          "Under 'Authorized redirect URIs' paste {redirect} and click Create.",
          "Copy the Client ID and Client secret and paste them into RedGiant, then click Connect and sign in with Google.",
          "If you chose 'External' and leave the app in 'Testing', the connection expires every 7 days: reconnect, or click 'Publish app' (you will see an 'unverified app' warning, which is fine for personal use).",
        ],
      },
    },
    homepage: "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server",
    note: {
      it: "Anteprima per sviluppatori di Google Workspace: il tuo progetto Google Cloud deve essere iscritto. In modalità di test Google chiede di riaccedere ogni 7 giorni.",
      en: "Google Workspace Developer Preview: your Google Cloud project must be enrolled. In testing mode Google asks you to sign in again every 7 days.",
    },
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    official: true,
    category: "work",
    description: {
      it: "I tuoi calendari ed eventi, e quando sei libero.",
      en: "Your calendars and events, and when you are free.",
    },
    transport: { type: "http", url: "https://calendarmcp.googleapis.com/mcp/v1" },
    auth: {
      type: "app",
      consoleUrl: "https://console.cloud.google.com/auth/clients",
      secret: true,
      scope:
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.events.readonly",
      authParams: { access_type: "offline", prompt: "consent" },
      guide: {
        it: [
          "Verifica che il tuo progetto Google Cloud sia iscritto al Google Workspace Developer Preview Program (senza iscrizione l'API MCP non compare).",
          "Apri console.cloud.google.com, scegli o crea un progetto, vai in 'API e servizi > Libreria' e abilita 'Google Calendar API' e 'Google Calendar MCP API'.",
          "Apri 'Google Auth Platform' (schermata di consenso OAuth): compila 'Branding'; in 'Pubblico' scegli 'Interno' se hai Google Workspace, altrimenti 'Esterno' e aggiungi il tuo indirizzo Google come utente di test.",
          "In 'Accesso ai dati' aggiungi questi ambiti (scope): https://www.googleapis.com/auth/calendar.calendarlist.readonly, https://www.googleapis.com/auth/calendar.events.freebusy, https://www.googleapis.com/auth/calendar.events.readonly.",
          "Vai in 'Client' > 'Crea client', scegli 'Applicazione web' e spunta 'Use this client for an AI-powered agent' (usa questo client per un agente IA).",
          "In 'URI di reindirizzamento autorizzati' incolla {redirect} e premi Crea.",
          "Copia ID client e Client secret, incollali in RedGiant, poi premi Collega e accedi con Google.",
          "Se hai scelto 'Esterno' e lasci l'app 'In test', il collegamento scade ogni 7 giorni: ricollegati, oppure premi 'Pubblica app' (comparirà l'avviso 'app non verificata', accettabile per uso personale).",
        ],
        en: [
          "Make sure your Google Cloud project is enrolled in the Google Workspace Developer Preview Program (without it the MCP API does not appear).",
          "Open console.cloud.google.com, pick or create a project, go to 'APIs & Services > Library' and enable 'Google Calendar API' and 'Google Calendar MCP API'.",
          "Open 'Google Auth Platform' (OAuth consent screen): fill Branding; under Audience choose 'Internal' if you have Google Workspace, otherwise 'External' and add your own Google address as a test user.",
          "Under 'Data Access' add these scopes: https://www.googleapis.com/auth/calendar.calendarlist.readonly, https://www.googleapis.com/auth/calendar.events.freebusy, https://www.googleapis.com/auth/calendar.events.readonly.",
          "Go to 'Clients' > 'Create client', choose 'Web application' and tick 'Use this client for an AI-powered agent'.",
          "Under 'Authorized redirect URIs' paste {redirect} and click Create.",
          "Copy the Client ID and Client secret and paste them into RedGiant, then click Connect and sign in with Google.",
          "If you chose 'External' and leave the app in 'Testing', the connection expires every 7 days: reconnect, or click 'Publish app' (you will see an 'unverified app' warning, which is fine for personal use).",
        ],
      },
    },
    homepage: "https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server",
    note: {
      it: "Anteprima per sviluppatori di Google Workspace: il tuo progetto Google Cloud deve essere iscritto. In modalità di test Google chiede di riaccedere ogni 7 giorni.",
      en: "Google Workspace Developer Preview: your Google Cloud project must be enrolled. In testing mode Google asks you to sign in again every 7 days.",
    },
  },
  {
    id: "google-drive",
    name: "Google Drive",
    official: true,
    category: "docs",
    description: {
      it: "Cercare e leggere i tuoi file in Google Drive, e crearne di nuovi.",
      en: "Find and read your files in Google Drive, and create new ones.",
    },
    transport: { type: "http", url: "https://drivemcp.googleapis.com/mcp/v1" },
    auth: {
      type: "app",
      consoleUrl: "https://console.cloud.google.com/auth/clients",
      secret: true,
      scope:
        "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
      authParams: { access_type: "offline", prompt: "consent" },
      guide: {
        it: [
          "Verifica che il tuo progetto Google Cloud sia iscritto al Google Workspace Developer Preview Program (senza iscrizione l'API MCP non compare).",
          "Apri console.cloud.google.com, scegli o crea un progetto, vai in 'API e servizi > Libreria' e abilita 'Google Drive API' e 'Google Drive MCP API'.",
          "Apri 'Google Auth Platform' (schermata di consenso OAuth): compila 'Branding'; in 'Pubblico' scegli 'Interno' se hai Google Workspace, altrimenti 'Esterno' e aggiungi il tuo indirizzo Google come utente di test.",
          "In 'Accesso ai dati' aggiungi questi ambiti (scope): https://www.googleapis.com/auth/drive.readonly, https://www.googleapis.com/auth/drive.file.",
          "Vai in 'Client' > 'Crea client', scegli 'Applicazione web' e spunta 'Use this client for an AI-powered agent' (usa questo client per un agente IA).",
          "In 'URI di reindirizzamento autorizzati' incolla {redirect} e premi Crea.",
          "Copia ID client e Client secret, incollali in RedGiant, poi premi Collega e accedi con Google.",
          "Se hai scelto 'Esterno' e lasci l'app 'In test', il collegamento scade ogni 7 giorni: ricollegati, oppure premi 'Pubblica app' (comparirà l'avviso 'app non verificata', accettabile per uso personale).",
        ],
        en: [
          "Make sure your Google Cloud project is enrolled in the Google Workspace Developer Preview Program (without it the MCP API does not appear).",
          "Open console.cloud.google.com, pick or create a project, go to 'APIs & Services > Library' and enable 'Google Drive API' and 'Google Drive MCP API'.",
          "Open 'Google Auth Platform' (OAuth consent screen): fill Branding; under Audience choose 'Internal' if you have Google Workspace, otherwise 'External' and add your own Google address as a test user.",
          "Under 'Data Access' add these scopes: https://www.googleapis.com/auth/drive.readonly, https://www.googleapis.com/auth/drive.file.",
          "Go to 'Clients' > 'Create client', choose 'Web application' and tick 'Use this client for an AI-powered agent'.",
          "Under 'Authorized redirect URIs' paste {redirect} and click Create.",
          "Copy the Client ID and Client secret and paste them into RedGiant, then click Connect and sign in with Google.",
          "If you chose 'External' and leave the app in 'Testing', the connection expires every 7 days: reconnect, or click 'Publish app' (you will see an 'unverified app' warning, which is fine for personal use).",
        ],
      },
    },
    homepage: "https://developers.google.com/workspace/drive/api/guides/configure-mcp-server",
    note: {
      it: "Anteprima per sviluppatori di Google Workspace: il tuo progetto Google Cloud deve essere iscritto. In modalità di test Google chiede di riaccedere ogni 7 giorni.",
      en: "Google Workspace Developer Preview: your Google Cloud project must be enrolled. In testing mode Google asks you to sign in again every 7 days.",
    },
  },
  {
    id: "canva",
    name: "Canva",
    official: true,
    category: "design",
    description: {
      it: "I tuoi progetti su Canva: trovarli, crearli e modificarli, esportarli.",
      en: "Your designs on Canva: find them, create and edit them, export them.",
    },
    transport: { type: "http", url: "https://api.canva.com/connect/v1/mcp" },
    auth: {
      type: "app",
      consoleUrl: "https://www.canva.com/developers/integrations",
      secret: true,
      guide: {
        it: [
          "Accedi a canva.com/developers (Developer Portal) e crea una nuova integrazione/app.",
          "Apri 'Outside Canva' (fuori da Canva) e premi 'Start integrating'.",
          "In 'Integration methods' attiva 'Canva MCP'.",
          "In 'Credentials' copia il Client ID, premi 'Generate secret' e copia subito il secret (viene mostrato una sola volta).",
          "In 'Redirect URLs' aggiungi {redirect}.",
          "Incolla Client ID e secret in RedGiant, premi Collega e accedi con il tuo account Canva.",
        ],
        en: [
          "Sign in at canva.com/developers (Developer Portal) and create a new integration/app.",
          "Open 'Outside Canva' and click 'Start integrating'.",
          "Under 'Integration methods', switch on 'Canva MCP'.",
          "Under 'Credentials', copy the Client ID, click 'Generate secret' and copy the secret immediately (it is shown only once).",
          "Under 'Redirect URLs', add {redirect}.",
          "Paste Client ID and secret into RedGiant, click Connect and sign in with your Canva account.",
        ],
      },
    },
    homepage: "https://www.canva.dev/blog/developers/canva-mcp-ga/",
  },
  {
    id: "slack",
    name: "Slack",
    official: true,
    category: "work",
    description: {
      it: "Cercare e leggere canali e messaggi di Slack, e scriverci.",
      en: "Search and read your Slack channels and messages, and write in them.",
    },
    transport: { type: "http", url: "https://mcp.slack.com/mcp" },
    auth: {
      type: "app",
      consoleUrl: "https://api.slack.com/apps",
      secret: true,
      scope:
        "search:read.public search:read.private search:read.mpim search:read.im search:read.files search:read.users chat:write channels:history groups:history mpim:history im:history channels:read groups:read im:read mpim:read users:read users:read.email files:read canvases:read canvases:write reactions:read reactions:write",
      guide: {
        it: [
          "Vai su api.slack.com/apps, premi 'Create New App' > 'From scratch', dai un nome e scegli il tuo workspace.",
          "Apri 'OAuth & Permissions', premi 'Add New Redirect URL', incolla {redirect} e salva.",
          "Nella stessa pagina, in 'User Token Scopes' (non Bot), aggiungi gli scope elencati (search:read.*, chat:write, *:history, *:read, users:read, files:read, canvases:*, reactions:*). Metti solo ciò che vuoi far fare all'agente.",
          "NON attivare la distribuzione pubblica: lasciala app interna del tuo workspace (Slack ammette su MCP solo app interne o del Marketplace).",
          "Apri 'Basic Information' e copia Client ID e Client Secret in RedGiant.",
          "Premi Collega in RedGiant e approva; se il workspace richiede l'approvazione delle app, chiedi a un amministratore.",
        ],
        en: [
          "Go to api.slack.com/apps, click 'Create New App' > 'From scratch', name it and pick your workspace.",
          "Open 'OAuth & Permissions', click 'Add New Redirect URL', paste {redirect} and save.",
          "In the same page, under 'User Token Scopes' (not Bot), add the scopes listed (search:read.*, chat:write, *:history, *:read, users:read, files:read, canvases:*, reactions:*). Add only what you want the agent to do.",
          "Do NOT turn on public distribution: keep it as an internal app of your workspace (Slack only allows internal or Marketplace apps on MCP).",
          "Open 'Basic Information' and copy Client ID and Client Secret into RedGiant.",
          "Click Connect in RedGiant and approve; if your workspace requires admin approval for apps, ask an admin.",
        ],
      },
    },
    homepage: "https://docs.slack.dev/ai/mcp-server/",
    note: {
      it: "Tieni l'app interna al tuo workspace: Slack permette l'MCP solo alle app interne o del Marketplace.",
      en: "Keep the app internal to your workspace: Slack allows MCP only for internal or Marketplace apps.",
    },
  },
  {
    id: "asana",
    name: "Asana",
    official: true,
    category: "work",
    description: {
      it: "Attività, progetti e obiettivi su Asana.",
      en: "Tasks, projects and goals on Asana.",
    },
    transport: { type: "http", url: "https://mcp.asana.com/v2/mcp" },
    auth: {
      type: "app",
      consoleUrl: "https://app.asana.com/0/my-apps",
      secret: true,
      scope: "default",
      guide: {
        it: [
          "Apri app.asana.com/0/my-apps (console sviluppatori) e premi 'Create new app'.",
          "Dai un nome e scegli il tipo 'MCP app', poi crea.",
          "Copia Client ID e Client secret.",
          "Nella scheda 'OAuth' aggiungi il Redirect URL {redirect}.",
          "In 'Manage distribution' scegli 'Specific workspaces' (seleziona il tuo) o 'Any workspace', altrimenti compare 'This app is not available to your Asana workspace'.",
          "Incolla Client ID e secret in RedGiant e premi Collega.",
        ],
        en: [
          "Open app.asana.com/0/my-apps (developer console) and click 'Create new app'.",
          "Give it a name and choose the app type 'MCP app', then create it.",
          "Copy the Client ID and Client secret.",
          "In the 'OAuth' tab add the Redirect URL {redirect}.",
          "In 'Manage distribution' choose 'Specific workspaces' (select yours) or 'Any workspace' - otherwise you get 'This app is not available to your Asana workspace'.",
          "Paste Client ID and secret into RedGiant and click Connect.",
        ],
      },
    },
    homepage: "https://developers.asana.com/docs/connecting-mcp-clients-to-asanas-v2-server",
  },
  {
    id: "dropbox",
    name: "Dropbox",
    official: true,
    category: "docs",
    description: {
      it: "Cercare e leggere i tuoi contenuti tramite Dropbox Dash.",
      en: "Find and read your content through Dropbox Dash.",
    },
    transport: { type: "http", url: "https://mcp.dropbox.com/dash" },
    auth: {
      type: "app",
      consoleUrl: "https://www.dropbox.com/developers/apps",
      secret: true,
      scope: "account_info.read dash/content.read dash/content.write",
      guide: {
        it: [
          "Apri dropbox.com/developers/apps e premi 'Create app'.",
          "Scegli 'Scoped access' e 'Full Dropbox', dai all'app un nome unico.",
          "In 'Permissions' spunta account_info.read, dash/content.read, dash/content.write e premi Submit.",
          "In 'Settings' > 'OAuth 2' > 'Redirect URIs' aggiungi {redirect}.",
          "Copia 'App key' (Client ID) e 'App secret' (Client secret) in RedGiant.",
          "Premi Collega e accedi a Dropbox.",
        ],
        en: [
          "Open dropbox.com/developers/apps and click 'Create app'.",
          "Choose 'Scoped access' and 'Full Dropbox', give the app a unique name.",
          "In 'Permissions' tick account_info.read, dash/content.read, dash/content.write and click Submit.",
          "In 'Settings' > 'OAuth 2' > 'Redirect URIs' add {redirect}.",
          "Copy 'App key' (Client ID) and 'App secret' (Client secret) into RedGiant.",
          "Click Connect and sign in to Dropbox.",
        ],
      },
    },
    homepage: "https://help.dropbox.com/integrations/set-up-MCP-server",
    note: {
      it: "Tramite Dropbox Dash: potrebbe servire un piano Dash.",
      en: "Through Dropbox Dash: it may need a Dash plan.",
    },
  },
  {
    id: "hubspot",
    name: "HubSpot",
    official: true,
    category: "work",
    description: {
      it: "Contatti, aziende, trattative e ticket su HubSpot.",
      en: "Contacts, companies, deals and tickets on HubSpot.",
    },
    transport: { type: "http", url: "https://mcp.hubspot.com" },
    auth: {
      type: "app",
      consoleUrl: "https://app.hubspot.com/l/mcp-auth-apps/",
      secret: true,
      guide: {
        it: [
          "In HubSpot apri 'Development' > 'MCP Connectors' (oppure vai su app.hubspot.com/l/mcp-auth-apps/).",
          "Premi 'Create MCP connector' (in alto a destra).",
          "Inserisci un nome e come Redirect URL incolla {redirect}; premi Create.",
          "Apri la pagina di dettaglio del connettore e copia Client ID e Client secret in RedGiant.",
          "Premi Collega e approva; gli scope non si scelgono, HubSpot li ricava dagli strumenti e dai tuoi permessi.",
        ],
        en: [
          "In HubSpot open 'Development' > 'MCP Connectors' (or go to app.hubspot.com/l/mcp-auth-apps/).",
          "Click 'Create MCP connector' (top right).",
          "Enter a name and, as Redirect URL, paste {redirect}; click Create.",
          "Open the connector's details page and copy Client ID and Client secret into RedGiant.",
          "Click Connect and approve; you do not choose scopes, HubSpot derives them from the tools and your permissions.",
        ],
      },
    },
    homepage:
      "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server",
    note: {
      it: "Alcuni strumenti richiedono hub di HubSpot a pagamento.",
      en: "Some tools need paid HubSpot hubs.",
    },
  },
  {
    id: "salesforce",
    name: "Salesforce",
    official: true,
    category: "work",
    description: {
      it: "Leggere e modificare i record di Salesforce.",
      en: "Read and change your Salesforce records.",
    },
    transport: {
      type: "http",
      url: "https://api.salesforce.com/platform/mcp/v1/platform/sobject-all",
    },
    auth: {
      type: "app",
      consoleUrl: "https://login.salesforce.com/",
      secret: false,
      scope: "mcp_api refresh_token",
      guide: {
        it: [
          "In Salesforce Setup cerca 'MCP Servers' (API Catalog) e attiva il server che vuoi (sobject-reads, sobject-mutations, sobject-deletes o sobject-all).",
          "Cerca 'External Client App Manager' e premi 'New External Client App' (le Connected App classiche non funzionano).",
          "Apri 'API (Enable OAuth Settings)', abilita OAuth e come Callback URL metti {redirect}.",
          "Aggiungi gli scope 'Access MCP servers (mcp_api)' e 'Perform requests at any time (refresh_token)'. Non usare 'api'.",
          "Spunta 'Require PKCE' e 'Issue JWT-based access tokens for named users'; lascia spento 'Require Secret' salvo che tu voglia incollare anche un secret.",
          "Salva, copia la Consumer Key (Client ID) in RedGiant e aspetta fino a 30 minuti prima di collegare.",
          "Usa l'URL .../v1/platform/<server> per produzione/Developer Edition, .../v1/sandbox/platform/<server> per le sandbox.",
        ],
        en: [
          "In Salesforce Setup, search 'MCP Servers' (API Catalog) and activate the server you want (sobject-reads, sobject-mutations, sobject-deletes or sobject-all).",
          "Search 'External Client App Manager' and click 'New External Client App' (classic Connected Apps do not work).",
          "Expand 'API (Enable OAuth Settings)', enable OAuth and set the Callback URL to {redirect}.",
          "Add the OAuth scopes 'Access MCP servers (mcp_api)' and 'Perform requests at any time (refresh_token)'. Do not use 'api'.",
          "Tick 'Require PKCE' and 'Issue JWT-based access tokens for named users'; leave 'Require Secret' off unless you want to paste a secret too.",
          "Save, copy the Consumer Key (Client ID) into RedGiant, and wait up to 30 minutes before connecting.",
          "Use the URL .../v1/platform/<server> for production/Developer Edition, .../v1/sandbox/platform/<server> for sandboxes.",
        ],
      },
    },
    homepage:
      "https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/create-external-client-app.html",
    unverified: true,
    note: {
      it: "Non confermato sulle pagine di Salesforce (non si potevano leggere): controlla la sua documentazione. Per un'organizzazione sandbox usa …/v1/sandbox/platform/… nell'indirizzo.",
      en: "Not confirmed on Salesforce's own pages (they could not be read): check its documentation. For a sandbox org use …/v1/sandbox/platform/… in the address.",
    },
  },
  {
    id: "microsoft-365",
    name: "Microsoft 365 (Work IQ)",
    official: true,
    category: "work",
    description: {
      it: "Posta e calendario di Outlook, Teams, OneDrive e SharePoint tramite Microsoft Work IQ.",
      en: "Outlook mail and calendar, Teams, OneDrive and SharePoint through Microsoft Work IQ.",
    },
    transport: { type: "http", url: "https://workiq.svc.cloud.microsoft/mcp" },
    auth: {
      type: "app",
      consoleUrl:
        "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
      secret: true,
      scope:
        "api://workiq.svc.cloud.microsoft/WorkIQ.Read api://workiq.svc.cloud.microsoft/WorkIQ.Act api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask offline_access",
      guide: {
        it: [
          "Un amministratore del tenant deve prima abilitare Work IQ per l'organizzazione (e configurare la fatturazione Copilot Credits).",
          "Apri entra.microsoft.com > 'Registrazioni app' > 'Nuova registrazione'; dai un nome (es. 'RedGiant') e scegli 'Solo account in questa directory dell'organizzazione'.",
          "In 'URI di reindirizzamento' scegli la piattaforma 'Web' e incolla {redirect}; premi Registra.",
          "In 'Certificati e segreti' crea un nuovo segreto client e copia subito il Valore.",
          "In 'Autorizzazioni API' > 'Aggiungi autorizzazione' > 'API usate dall'organizzazione', cerca 'Work IQ', scegli 'Delegate' e spunta WorkIQ.Read (e WorkIQ.Act e/o WorkIQAgent.Ask se vuoi scritture/risposte Copilot).",
          "Premi 'Concedi consenso amministratore per <tenant>' (serve un amministratore).",
          "Da 'Panoramica' copia l'ID applicazione (client); incollalo con il segreto in RedGiant e premi Collega.",
        ],
        en: [
          "A tenant admin must first enable Work IQ for the organization (and set up Copilot Credits billing).",
          "Open entra.microsoft.com > 'App registrations' > 'New registration'; name it (e.g. 'RedGiant') and choose 'Accounts in this organizational directory only'.",
          "Under 'Redirect URI' choose platform 'Web' and paste {redirect}; click Register.",
          "In 'Certificates & secrets' create a new client secret and copy its Value immediately.",
          "In 'API permissions' > 'Add a permission' > 'APIs my organization uses', search 'Work IQ', choose 'Delegated' and tick WorkIQ.Read (and WorkIQ.Act and/or WorkIQAgent.Ask if you want writes/Copilot answers).",
          "Click 'Grant admin consent for <your tenant>' (needs an admin).",
          "From 'Overview' copy the Application (client) ID; paste it and the secret into RedGiant, then Connect.",
        ],
      },
    },
    homepage:
      "https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/work-iq/mcp/overview",
    note: {
      it: "Per le organizzazioni: un amministratore deve attivare Work IQ e approvare l'app; si paga in crediti Copilot.",
      en: "For organisations: an administrator must enable Work IQ and approve the app; it is billed in Copilot Credits.",
    },
  },
  {
    id: "home-assistant",
    name: "Home Assistant",
    official: true,
    category: "home",
    description: {
      it: "La tua casa: luci, sensori, termostati e automazioni di Home Assistant.",
      en: "Your home: Home Assistant's lights, sensors, thermostats and automations.",
    },
    transport: { type: "http", url: "http://homeassistant.local:8123/api/mcp" },
    auth: {
      type: "header",
      header: "Authorization",
      prefix: "Bearer ",
      keyUrl: "https://www.home-assistant.io/docs/authentication/#your-account-profile",
      guide: {
        it: [
          "In Home Assistant vai in Impostazioni > Dispositivi e servizi > Aggiungi integrazione e aggiungi 'Model Context Protocol Server'; scegli cosa esporre.",
          "Premi sul tuo nome utente (in basso a sinistra) > scheda 'Sicurezza' > 'Token di accesso di lunga durata' > 'Crea token'; copialo subito (si vede una volta sola). Usa un utente amministratore (l'opzione 'Richiedi account amministratore' è attiva di default).",
          "In RedGiant inserisci l'indirizzo, es. http://homeassistant.local:8123/api/mcp, e incolla il token.",
          "L'indirizzo deve essere raggiungibile dal server RedGiant.",
        ],
        en: [
          "In Home Assistant go to Settings > Devices & services > Add integration and add 'Model Context Protocol Server'; choose which assistant/entities it exposes.",
          "Click your user name (bottom left) > 'Security' tab > 'Long-lived access tokens' > 'Create token'; copy it now (it is shown once). Use an administrator user ('Require an administrator account' is on by default).",
          "In RedGiant enter the address, e.g. http://homeassistant.local:8123/api/mcp, and paste the token.",
          "The address must be reachable from the RedGiant server (and match HA's internal/external URL if you use OAuth instead).",
        ],
      },
    },
    homepage: "https://www.home-assistant.io/integrations/mcp_server/",
    userUrl: { example: "http://homeassistant.local:8123", path: "/api/mcp" },
    unverified: true,
    note: {
      it: "Home Assistant documenta il proprio accesso OAuth; il token di lunga durata come chiave funziona ma non è nella sua pagina. L'indirizzo deve essere raggiungibile dal server di RedGiant.",
      en: "Home Assistant documents its own OAuth sign-in; a long-lived token as the key works but is not on its page. The address must be reachable from RedGiant's server.",
    },
  },
  {
    id: "wordpress",
    name: "WordPress",
    official: true,
    category: "web",
    description: {
      it: "Il tuo sito WordPress: articoli, pagine, media (e WooCommerce, se c'è).",
      en: "Your WordPress site: posts, pages, media (and WooCommerce, if present).",
    },
    transport: { type: "stdio", command: "npx", args: ["-y", "@automattic/mcp-wordpress-remote"] },
    auth: {
      type: "fields",
      fields: [
        {
          env: "WP_API_URL",
          label: { it: "Indirizzo del server MCP del sito", en: "Your site's MCP server address" },
          secret: false,
          example: "https://example.com/wp-json/mcp/mcp-adapter-default-server",
        },
        {
          env: "WP_API_USERNAME",
          label: { it: "Nome utente WordPress", en: "WordPress username" },
          secret: false,
        },
        {
          env: "WP_API_PASSWORD",
          label: { it: "Password applicazione", en: "Application password" },
          secret: true,
        },
        {
          env: "WOO_CUSTOMER_KEY",
          label: { it: "Chiave WooCommerce (facoltativa)", en: "WooCommerce key (optional)" },
          secret: true,
          optional: true,
        },
        {
          env: "WOO_CUSTOMER_SECRET",
          label: { it: "Segreto WooCommerce (facoltativo)", en: "WooCommerce secret (optional)" },
          secret: true,
          optional: true,
        },
      ],
      guide: {
        it: [
          "Sul tuo sito WordPress installa e attiva il plugin 'MCP Adapter' (github.com/WordPress/mcp-adapter).",
          "In WordPress vai in Utenti > Profilo > 'Password applicazione', scrivi un nome (es. RedGiant) e premi 'Aggiungi'; copia la password.",
          "In RedGiant imposta WP_API_URL a https://tuo-sito.com/wp-json/mcp/mcp-adapter-default-server.",
          "Imposta WP_API_USERNAME al tuo nome utente WordPress e WP_API_PASSWORD alla password applicazione.",
          "Facoltativo per WooCommerce: WOO_CUSTOMER_KEY e WOO_CUSTOMER_SECRET da WooCommerce > Impostazioni > Avanzate > REST API.",
        ],
        en: [
          "On your WordPress site install and activate the 'MCP Adapter' plugin (github.com/WordPress/mcp-adapter).",
          "In WordPress go to Users > Profile > 'Application Passwords', type a name (e.g. RedGiant) and click 'Add New'; copy the password.",
          "In RedGiant set WP_API_URL to https://your-site.com/wp-json/mcp/mcp-adapter-default-server.",
          "Set WP_API_USERNAME to your WordPress username and WP_API_PASSWORD to the application password.",
          "Optional for WooCommerce: WOO_CUSTOMER_KEY and WOO_CUSTOMER_SECRET from WooCommerce > Settings > Advanced > REST API.",
        ],
      },
    },
    homepage: "https://github.com/WordPress/mcp-adapter",
  },
  {
    id: "shopify-dev",
    name: "Shopify (developers)",
    official: true,
    category: "code",
    description: {
      it: "La documentazione di Shopify e la verifica di GraphQL e Liquid, per chi sviluppa app e temi (non i dati del negozio).",
      en: "Shopify's documentation and GraphQL/Liquid checks, for building apps and themes (not your store's data).",
    },
    transport: { type: "stdio", command: "npx", args: ["-y", "@shopify/dev-mcp@latest"] },
    auth: { type: "none" },
    homepage: "https://shopify.dev/docs/apps/build/devmcp",
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    official: false,
    category: "data",
    description: {
      it: "Un tuo database PostgreSQL in sola lettura: tabelle, query, salute del database.",
      en: "One of your PostgreSQL databases, read only: tables, queries, database health.",
    },
    transport: {
      type: "stdio",
      command: "uvx",
      args: ["postgres-mcp", "--access-mode=restricted"],
    },
    auth: {
      type: "env",
      env: "DATABASE_URI",
      keyUrl: "https://github.com/crystaldba/postgres-mcp",
      keyExample: "postgresql://user:password@host:5432/dbname",
      guide: {
        it: [
          "Prepara l'indirizzo del database nella forma postgresql://utente:password@host:5432/nomedb.",
          "Meglio un utente con permessi di sola lettura.",
          "Il database deve essere raggiungibile dal server di RedGiant.",
        ],
        en: [
          "Have the database address ready as postgresql://user:password@host:5432/dbname.",
          "Better a user with read-only rights.",
          "The database must be reachable from RedGiant's server.",
        ],
      },
    },
    homepage: "https://github.com/crystaldba/postgres-mcp",
  },
];

/** The server's configuration and private keys for a catalog entry. */
export function catalogConfig(
  entry: McpCatalogEntry,
  input: string | CatalogInput = {},
): {
  transport:
    | { type: "http"; url: string; oauth?: boolean }
    | { type: "stdio"; command: string; args: string[] };
  secrets?: {
    headers?: Record<string, string>;
    env?: Record<string, string>;
    app?: {
      clientId: string;
      clientSecret?: string;
      scope?: string;
      authParams?: Record<string, string>;
    };
  };
} {
  const given: CatalogInput = typeof input === "string" ? { key: input } : input;
  const a = entry.auth;
  const k = given.key?.trim() ?? "";
  if ((a.type === "header" || a.type === "env") && !k) throw new Error(`${entry.name} needs a key`);
  let transport: ReturnType<typeof catalogConfig>["transport"] = entry.transport;
  if (entry.userUrl && entry.transport.type === "http") {
    const base = given.url?.trim().replace(/\/+$/, "") ?? "";
    if (!/^https?:\/\/[^\s]+$/.test(base)) throw new Error(`${entry.name} needs its address`);
    const url = base.endsWith(entry.userUrl.path) ? base : `${base}${entry.userUrl.path}`;
    transport = { type: "http", url };
  }
  if (transport.type === "http" && (a.type === "oauth" || a.type === "app"))
    transport = { ...transport, oauth: true };
  if (a.type === "app") {
    const id = given.app?.clientId.trim() ?? "";
    const secret = given.app?.clientSecret?.trim() ?? "";
    if (!id || (a.secret && !secret)) throw new Error(`${entry.name} needs your app's details`);
    return {
      transport,
      secrets: {
        app: {
          clientId: id,
          ...(secret && { clientSecret: secret }),
          ...(a.scope && { scope: a.scope }),
          ...(a.authParams && { authParams: a.authParams }),
        },
      },
    };
  }
  if (a.type === "fields") {
    const env: Record<string, string> = {};
    for (const f of a.fields) {
      const v = given.fields?.[f.env]?.trim() ?? "";
      if (!v && !f.optional) throw new Error(`${entry.name} needs ${f.label.en}`);
      if (v) env[f.env] = v;
    }
    return { transport, secrets: { env } };
  }
  return {
    transport,
    ...(a.type === "header" && { secrets: { headers: { [a.header]: `${a.prefix ?? ""}${k}` } } }),
    ...(a.type === "env" && { secrets: { env: { [a.env]: k } } }),
  };
}

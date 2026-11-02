/**
 * MCP servers people can add with a click (G24.9): the services' own servers first, then
 * community ones, marked as such. Each says how it signs in: nothing, the service's sign-in
 * page (OAuth), or a key pasted once (kept in a private file, never in the database).
 */
export type McpCategory = "code" | "docs" | "web" | "data" | "work" | "design" | "cloud";

export type McpCatalogAuth =
  | { type: "none" }
  | { type: "oauth" }
  /** A key sent in a header (`Authorization: Bearer <key>` when `prefix` is "Bearer "). */
  | { type: "header"; header: string; prefix?: string; keyUrl: string; keyExample?: string }
  /** A key given to a local server as an environment variable. */
  | { type: "env"; env: string; keyUrl: string; keyExample?: string };

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
}

/**
 * Checked on the services' own pages (2026-11-02). Left out for now: servers that need an app
 * registered by the person (Google Workspace, Canva, Slack, Asana, Dropbox, HubSpot, Salesforce,
 * Microsoft 365), servers open only to approved clients (Figma, Vercel), and ones with no fixed
 * address (Home Assistant) or not confirmed on a vendor page.
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
];

/** The server's configuration and private keys for a catalog entry. */
export function catalogConfig(
  entry: McpCatalogEntry,
  key?: string,
): {
  transport:
    | { type: "http"; url: string; oauth?: boolean }
    | { type: "stdio"; command: string; args: string[] };
  secrets?: { headers?: Record<string, string>; env?: Record<string, string> };
} {
  const a = entry.auth;
  if ((a.type === "header" || a.type === "env") && !key?.trim())
    throw new Error(`${entry.name} needs a key`);
  const k = key?.trim() ?? "";
  return {
    transport:
      entry.transport.type === "http" && a.type === "oauth"
        ? { ...entry.transport, oauth: true }
        : entry.transport,
    ...(a.type === "header" && { secrets: { headers: { [a.header]: `${a.prefix ?? ""}${k}` } } }),
    ...(a.type === "env" && { secrets: { env: { [a.env]: k } } }),
  };
}

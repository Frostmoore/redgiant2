// Signing in to remote MCP servers (G24.9): the MCP authorization spec's OAuth 2.1 with dynamic
// client registration and PKCE, done by the MCP SDK; this file keeps what it needs per server in
// the person's keychain when the server gives one (G36.20), a private file otherwise (never in the
// database, never in a sandbox): the registered client, the tokens, the PKCE verifier, and, for
// servers that use a plain key, its headers or variables.

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface McpSecrets {
  client?: OAuthClientInformationMixed;
  /** The redirect the client was registered with: a new address registers again. */
  redirect?: string;
  tokens?: OAuthTokens;
  verifier?: string;
  /**
   * The person's own OAuth app (G24.14c), for services that do not let RedGiant register
   * itself: its client id and secret, the scopes it asks for, extra authorisation parameters.
   */
  app?: McpApp;
  /** For servers with a key instead of OAuth. */
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface McpApp {
  clientId: string;
  clientSecret?: string;
  /** Scopes asked at sign-in, space-separated. */
  scope?: string;
  /** Added to the sign-in address (Google: access_type=offline, prompt=consent). */
  authParams?: Record<string, string>;
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");

/**
 * Where the server keeps these secrets instead of files (the keychain, G36.20): one value per
 * owner and server, the JSON of `McpSecrets`.
 */
export interface McpSecretBackend {
  ready(): boolean;
  get(ownerId: string, name: string): string | undefined;
  set(ownerId: string, name: string, value: string | null): Promise<void>;
  /**
   * A file of before: its value written, read back, and only then the file destroyed (and the
   * move recorded). false: the file stays.
   */
  adopt(ownerId: string, name: string, value: string, file: string): Promise<boolean>;
}

/** One entry of the keychain per owner and server; one file each while it cannot be used. */
export class McpCredentialStore {
  constructor(
    private readonly dir: string,
    private readonly backend?: McpSecretBackend,
  ) {}

  private file(ownerId: string, name: string): string {
    return join(this.dir, safe(ownerId), `${safe(name)}.json`);
  }

  private parse(t: string | undefined): McpSecrets {
    try {
      return t ? (JSON.parse(t) as McpSecrets) : {};
    } catch {
      return {};
    }
  }

  async load(ownerId: string, name: string): Promise<McpSecrets> {
    const b = this.backend?.ready() ? this.backend : undefined;
    const kept = b?.get(ownerId, name);
    if (kept !== undefined) return this.parse(kept);
    const file = this.file(ownerId, name);
    const t = await readFile(file, "utf8").catch(() => undefined);
    if (t !== undefined && b) await b.adopt(ownerId, name, t, file).catch(() => false);
    return this.parse(t);
  }

  /** Merges a patch; a field set to undefined is removed. */
  async save(
    ownerId: string,
    name: string,
    patch: { [K in keyof McpSecrets]?: McpSecrets[K] | undefined },
  ): Promise<void> {
    const file = this.file(ownerId, name);
    const next = { ...(await this.load(ownerId, name)), ...patch };
    if (this.backend?.ready()) {
      await this.backend.set(ownerId, name, JSON.stringify(next));
      return;
    }
    await mkdir(join(this.dir, safe(ownerId)), { recursive: true, mode: 0o700 });
    await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
    await chmod(`${file}.tmp`, 0o600);
    await rename(`${file}.tmp`, file);
  }

  async remove(ownerId: string, name: string): Promise<void> {
    await rm(this.file(ownerId, name), { force: true });
    if (this.backend?.ready()) await this.backend.set(ownerId, name, null);
  }
}

/**
 * The SDK's OAuth client for one server: RedGiant registers itself (dynamic registration),
 * the person signs in on the service's page, the service sends them back to `redirectUrl`.
 */
export class StoredOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly store: McpCredentialStore,
    private readonly ownerId: string,
    private readonly name: string,
    private readonly redirect: string,
    private readonly stateValue: string,
    /** Called with the service's sign-in page when the person has to sign in. */
    private readonly onAuthorize: (url: URL) => void,
    /** The person's own app, when they brought one (known before any request is made). */
    app?: McpApp,
  ) {
    this.app = app;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  /** The person's own app, when they brought one; read once per sign-in. */
  private app: McpApp | undefined;
  private async ownApp(): Promise<McpApp | undefined> {
    this.app ??= (await this.store.load(this.ownerId, this.name)).app;
    return this.app;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "RedGiant",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.app?.clientSecret ? "client_secret_post" : "none",
      ...(this.app?.scope && { scope: this.app.scope }),
    };
  }

  state(): string {
    return this.stateValue;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    // The person's own app: never registered by RedGiant, always this one.
    const app = await this.ownApp();
    if (app)
      return {
        client_id: app.clientId,
        ...(app.clientSecret && { client_secret: app.clientSecret }),
        redirect_uris: [this.redirect],
      } as OAuthClientInformationMixed;
    const s = await this.store.load(this.ownerId, this.name);
    // Registered for another address (RedGiant opened from elsewhere): register again.
    return s.redirect === this.redirect ? s.client : undefined;
  }

  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    await this.store.save(this.ownerId, this.name, { client, redirect: this.redirect });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.store.load(this.ownerId, this.name)).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.save(this.ownerId, this.name, { tokens });
  }

  redirectToAuthorization(url: URL): void {
    for (const [k, v] of Object.entries(this.app?.authParams ?? {})) url.searchParams.set(k, v);
    this.onAuthorize(url);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.store.save(this.ownerId, this.name, { verifier });
  }

  async codeVerifier(): Promise<string> {
    const v = (await this.store.load(this.ownerId, this.name)).verifier;
    if (!v) throw new Error("No sign-in is in progress for this server");
    return v;
  }
}

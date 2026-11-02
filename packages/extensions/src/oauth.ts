// Signing in to remote MCP servers (G24.9): the MCP authorization spec's OAuth 2.1 with dynamic
// client registration and PKCE, done by the MCP SDK; this file keeps what it needs per server in
// a private file (never in the database, never in a sandbox): the registered client, the tokens,
// the PKCE verifier, and, for servers that use a plain key, its headers or variables.

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
  /** For servers with a key instead of OAuth. */
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");

/** One file per owner and server, readable only by RedGiant. */
export class McpCredentialStore {
  constructor(private readonly dir: string) {}

  private file(ownerId: string, name: string): string {
    return join(this.dir, safe(ownerId), `${safe(name)}.json`);
  }

  async load(ownerId: string, name: string): Promise<McpSecrets> {
    return readFile(this.file(ownerId, name), "utf8")
      .then((t) => JSON.parse(t) as McpSecrets)
      .catch(() => ({}));
  }

  async save(ownerId: string, name: string, patch: Partial<McpSecrets>): Promise<void> {
    const file = this.file(ownerId, name);
    const next = { ...(await this.load(ownerId, name)), ...patch };
    await mkdir(join(this.dir, safe(ownerId)), { recursive: true, mode: 0o700 });
    await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
    await chmod(`${file}.tmp`, 0o600);
    await rename(`${file}.tmp`, file);
  }

  async remove(ownerId: string, name: string): Promise<void> {
    await rm(this.file(ownerId, name), { force: true });
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
  ) {}

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "RedGiant",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.stateValue;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
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

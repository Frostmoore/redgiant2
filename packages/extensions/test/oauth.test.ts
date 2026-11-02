// Signing in to a remote MCP server with OAuth (G24.9), against a service in miniature: an MCP
// server that answers 401, its metadata, dynamic registration, sign-in, code for tokens (PKCE).
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpConnection, McpCredentialStore, StoredOAuthProvider } from "../src/index.js";

const codes = new Map<string, { challenge: string; redirect: string }>();
const tokens = new Set<string>();
const registered: Record<string, unknown>[] = [];
let base = "";

const service = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", base);
  let body = "";
  for await (const c of req) body += c;
  const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(data));
  };
  if (
    url.pathname === "/.well-known/oauth-protected-resource" ||
    url.pathname === "/.well-known/oauth-protected-resource/mcp"
  )
    return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
  if (url.pathname === "/.well-known/oauth-authorization-server")
    return json(200, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  if (url.pathname === "/register") {
    const meta = JSON.parse(body) as Record<string, unknown>;
    registered.push(meta);
    return json(201, { ...meta, client_id: `client-${registered.length}` });
  }
  if (url.pathname === "/authorize") {
    // The person signs in and accepts: back to RedGiant with a code.
    const code = randomUUID();
    codes.set(code, {
      challenge: url.searchParams.get("code_challenge") ?? "",
      redirect: url.searchParams.get("redirect_uri") ?? "",
    });
    const back = new URL(url.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (url.pathname === "/token") {
    const p = new URLSearchParams(body);
    const c = codes.get(p.get("code") ?? "");
    const verifier = p.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (!c || c.challenge !== challenge) return json(400, { error: "invalid_grant" });
    const token = `tok-${randomUUID()}`;
    tokens.add(token);
    return json(200, {
      access_token: token,
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "r1",
    });
  }
  if (url.pathname === "/mcp") {
    const auth = req.headers.authorization?.replace(/^Bearer /i, "") ?? "";
    if (!tokens.has(auth))
      return json(
        401,
        { error: "invalid_token" },
        {
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        },
      );
    const server = new McpServer({ name: "notes", version: "1" });
    server.registerTool(
      "list_notes",
      { description: "Lists notes", inputSchema: { q: z.string().optional() } },
      async () => ({
        content: [{ type: "text", text: "shopping, ideas" }],
      }),
    );
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(t);
    await t.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    return;
  }
  json(404, { error: "not found" });
});

afterAll(() => new Promise((ok) => service.close(ok)));

describe("signing in to a remote MCP server", () => {
  it("registers, sends the person to the service, takes the code back and keeps the tokens", async () => {
    await new Promise<void>((ok) => service.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
    const dir = await mkdtemp(join(tmpdir(), "rg-oauth-"));
    const store = new McpCredentialStore(dir);
    const redirect = "http://localhost:7600/api/extensions/oauth/callback";
    let page: URL | undefined;
    const provider = new StoredOAuthProvider(store, "me", "notes", redirect, "state-123", (u) => {
      page = u;
    });
    const conn = new McpConnection(
      { name: "notes", transport: { type: "http", url: `${base}/mcp`, oauth: true } },
      undefined,
      { authProvider: provider },
    );
    // No sign-in yet: the service's page, with RedGiant registered and PKCE.
    await expect(conn.tools()).rejects.toThrow();
    expect(page?.origin).toBe(base);
    expect(page?.searchParams.get("state")).toBe("state-123");
    expect(page?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(registered[0]).toMatchObject({ client_name: "RedGiant", redirect_uris: [redirect] });
    // The person signs in; the service sends them back with a code.
    const r = await fetch(page as URL, { redirect: "manual" });
    const back = new URL(r.headers.get("location") ?? "");
    expect(back.origin + back.pathname).toBe(redirect);
    await conn.finishAuth(back.searchParams.get("code") ?? "");
    expect((await conn.tools()).map((t) => t.def.name)).toEqual(["mcp__notes__list_notes"]);
    // The tokens stay in a private file; a new connection uses them without signing in again.
    const file = join(dir, "me", "notes.json");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8")).tokens.access_token).toMatch(/^tok-/);
    const again = new McpConnection(
      { name: "notes", transport: { type: "http", url: `${base}/mcp`, oauth: true } },
      undefined,
      { authProvider: new StoredOAuthProvider(store, "me", "notes", redirect, "s2", () => {}) },
    );
    expect((await again.tools()).length).toBe(1);
    expect(registered).toHaveLength(1);
    await conn.close();
    await again.close();
  });
});

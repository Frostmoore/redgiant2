import { lookup } from "node:dns/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { isIP, connect as netConnect, type Socket } from "node:net";

/**
 * A route that injects credentials: the sandbox calls `http://<proxy>/route/<name>/<path>`
 * and the proxy forwards to `upstream/<path>` adding `headers`. Secrets live only here.
 */
export interface CredentialRoute {
  upstream: string;
  headers: Record<string, string>;
}

export interface EgressPolicy {
  /** Allowed hosts: exact names or `*.example.com` (subdomains only). */
  allow: string[];
  /** Hosts allowed even though they resolve to private/loopback addresses. */
  allowPrivate?: string[];
  routes?: Record<string, CredentialRoute>;
}

export interface EgressDecision {
  kind: "connect" | "http" | "route";
  host: string;
  allowed: boolean;
  reason?: string;
}

export function hostAllowed(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return patterns.some((p) => {
    const q = p.toLowerCase();
    return q.startsWith("*.") ? h.endsWith(q.slice(1)) : h === q;
  });
}

/** Loopback, private, link-local, CGNAT and unique-local addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return (
    v6 === "::1" ||
    v6 === "::" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe80")
  );
}

/**
 * Forward proxy for sandboxes, which sit on an internal network with no other way out.
 * Supports CONNECT (HTTPS tunnels), absolute-URI HTTP requests and credential routes.
 */
export class EgressProxy {
  private readonly server: http.Server;

  constructor(
    private readonly policy: EgressPolicy,
    private readonly onDecision: (d: EgressDecision) => void = () => {},
  ) {
    this.server = http.createServer((req, res) => void this.handleRequest(req, res));
    // A client that disconnects abruptly must never take the proxy down.
    this.server.on("clientError", (_err, socket) => socket.destroy());
    this.server.on(
      "connect",
      (req: IncomingMessage, socket: Socket, head: Buffer) =>
        void this.handleConnect(req, socket, head),
    );
  }

  /**
   * Routes added while running (G24.5: GitHub and Gitea, written by the server when the user
   * connects them). They join the policy's own; a name in both takes these.
   */
  setRoutes(routes: Record<string, CredentialRoute>): void {
    this.extra = routes;
  }

  private extra: Record<string, CredentialRoute> = {};

  listen(port: number, host = "0.0.0.0"): Promise<number> {
    return new Promise((ok) =>
      this.server.listen(port, host, () => {
        const a = this.server.address();
        ok(typeof a === "object" && a ? a.port : port);
      }),
    );
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((ok) => this.server.close(() => ok()));
  }

  /** Checks the policy, including where the name actually resolves (no SSRF via DNS). */
  private async check(kind: EgressDecision["kind"], host: string): Promise<EgressDecision> {
    const decide = (allowed: boolean, reason?: string): EgressDecision => {
      const d = { kind, host, allowed, ...(reason && { reason }) };
      this.onDecision(d);
      return d;
    };
    if (!hostAllowed(host, this.policy.allow)) return decide(false, "host not in the allow list");
    if (!hostAllowed(host, this.policy.allowPrivate ?? [])) {
      const addresses = isIP(host)
        ? [{ address: host }]
        : await lookup(host, { all: true }).catch(() => []);
      if (addresses.length === 0) return decide(false, "host does not resolve");
      if (addresses.some((a) => isPrivateAddress(a.address)))
        return decide(false, "resolves to a private address");
    }
    return decide(true);
  }

  private async handleConnect(req: IncomingMessage, socket: Socket, head: Buffer) {
    socket.on("error", () => socket.destroy());
    const [host = "", portText = "443"] = (req.url ?? "").split(":");
    const d = await this.check("connect", host);
    if (!d.allowed) {
      socket.end(
        `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nRedGiant egress: ${host} blocked (${d.reason})\n`,
      );
      return;
    }
    const upstream = netConnect(Number(portText), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    req.on("error", () => res.destroy());
    res.on("error", () => {});
    const url = req.url ?? "/";
    if (url.startsWith("/route/")) return this.handleRoute(req, res, url);
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return deny(
        res,
        400,
        "Use this server as an HTTP proxy, or /route/<name>/... for credential routes.",
      );
    }
    const d = await this.check("http", target.hostname);
    if (!d.allowed)
      return deny(res, 403, `RedGiant egress: ${target.hostname} blocked (${d.reason})`);
    forward(req, res, target, {});
  }

  private async handleRoute(req: IncomingMessage, res: ServerResponse, url: string) {
    const [, , name = "", ...rest] = url.split("/");
    const route = this.extra[name] ?? this.policy.routes?.[name];
    if (!route) {
      this.onDecision({ kind: "route", host: name, allowed: false, reason: "unknown route" });
      return deny(res, 404, `RedGiant egress: unknown route "${name}"`);
    }
    const target = new URL(
      rest.join("/"),
      route.upstream.endsWith("/") ? route.upstream : `${route.upstream}/`,
    );
    this.onDecision({ kind: "route", host: target.hostname, allowed: true });
    forward(req, res, target, route.headers);
  }
}

function deny(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "text/plain" }).end(`${message}\n`);
}

const HOP_BY_HOP = [
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function forward(
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  inject: Record<string, string>,
) {
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined && !HOP_BY_HOP.includes(k)) headers[k] = v;
  }
  headers.host = target.host;
  // Injected credentials replace whatever the sandbox sent.
  for (const [k, v] of Object.entries(inject)) {
    for (const existing of Object.keys(headers))
      if (existing.toLowerCase() === k.toLowerCase()) delete headers[existing];
    headers[k] = v;
  }
  const client = target.protocol === "https:" ? https : http;
  const upstream = client.request(target, { method: req.method ?? "GET", headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", (err) => {
    if (!res.headersSent) deny(res, 502, `RedGiant egress: upstream error: ${err.message}`);
    else res.destroy();
  });
  req.pipe(upstream);
}

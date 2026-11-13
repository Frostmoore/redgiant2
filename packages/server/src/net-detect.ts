// What already reaches this machine (G39.3): before offering a way in from outside, RedGiant
// looks for what the person may have set up already, so it offers to use it instead of adding a
// second one: Tailscale running here, a reverse proxy in front of RedGiant (or running on this
// machine), and a DNS name or a local DNS server on the network. Pure parsers, tested as tables.
import type { NetDetected } from "@redgiant/protocol";

/** `tailscale status --json`: running, with this machine's name in the tailnet. */
export function parseTailscaleStatus(json: string): NetDetected["tailscale"] {
  try {
    const j = JSON.parse(json) as {
      BackendState?: string;
      Self?: { DNSName?: string; TailscaleIPs?: string[] };
    };
    const state = j.BackendState ?? "";
    if (state !== "Running") return { state: state === "NeedsLogin" ? "logged_out" : "stopped" };
    const name = (j.Self?.DNSName ?? "").replace(/\.$/, "");
    return {
      state: "running",
      ...(name && { name }),
      ...(j.Self?.TailscaleIPs?.[0] && { ip: j.Self.TailscaleIPs[0] }),
    };
  } catch {
    return { state: "absent" };
  }
}

const PROXIES = ["caddy", "nginx", "traefik", "haproxy", "apache2", "httpd", "cloudflared"];

/** The reverse proxies among the programs running (/proc/<pid>/comm), each once. */
export function proxiesRunning(comms: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const c of comms) {
    const n = c.trim().toLowerCase();
    if (PROXIES.includes(n)) seen.add(n);
  }
  return PROXIES.filter((p) => seen.has(p));
}

/**
 * A proxy in front of RedGiant, from the request the page made: Cloudflare's header, the
 * headers proxies add, or a "Via" one. Only what the request carries, never a guess.
 */
export function proxyInFront(h: (name: string) => string | undefined): string | null {
  if (h("cf-connecting-ip") || h("cf-ray")) return "cloudflare";
  // RedGiant OS's own local HTTPS (Caddy on the machine, lan-https.ts) is not someone else's.
  if (h("x-redgiant-local-tls") === "1") return null;
  const via = h("via");
  if (via) return via.toLowerCase().includes("caddy") ? "caddy" : "proxy";
  if (h("x-forwarded-for") || h("x-forwarded-proto") || h("x-real-ip")) return "proxy";
  return null;
}

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fd[0-9a-f]{2}:)/i;

/**
 * /etc/resolv.conf: a name server on the local network (a router, Pi-hole, AdGuard…) rather
 * than a public one or the machine's own stub (127.0.0.53).
 */
export function localDnsServer(resolv: string): string | null {
  for (const line of resolv.split("\n")) {
    const m = /^\s*nameserver\s+(\S+)/.exec(line);
    if (m?.[1] && PRIVATE.test(m[1])) return m[1];
  }
  return null;
}

/** The name the page used to reach RedGiant, when it is a name (not an address). */
export function hostName(host: string | undefined): string | null {
  const h = (host ?? "")
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (!h || h === "localhost" || /^[\d.]+$/.test(h) || h.includes(":")) return null;
  return /^[a-z0-9.-]+$/.test(h) ? h : null;
}

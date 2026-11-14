// «You already have your own infrastructure» (G39.8), without the page: the blocks to copy for
// a reverse proxy, a VPN and a home DNS, filled with RedGiant's name, address and port. Pure,
// so the page and the tests read the same text.
import type { NameProbe } from "@redgiant/protocol";

/** What the blocks are filled with; missing parts become readable placeholders. */
export interface InfraData {
  /** The name RedGiant is reached at (redgiant.home.example.com). */
  name: string;
  /** RedGiant's address on the local network. */
  address: string;
  port: number;
}

export const PLACEHOLDER_NAME = "redgiant.example.com";
export const PLACEHOLDER_ADDRESS = "192.168.1.50";

/** The data, with placeholders for what is not known. */
export function infraData(
  name: string | null | undefined,
  address: string | null | undefined,
  port: number | null | undefined,
): InfraData {
  return {
    name: name?.trim() || PLACEHOLDER_NAME,
    address: address?.trim() || PLACEHOLDER_ADDRESS,
    port: port && port > 0 && port < 65536 ? port : 7600,
  };
}

/** The domain a wildcard covers: redgiant.home.example.com → home.example.com. */
export function parentDomain(name: string): string {
  const parts = name.split(".");
  return parts.length > 2 ? parts.slice(1).join(".") : name;
}

/** The local network of an IPv4 address, as a subnet router announces it (a /24). */
export function subnetOf(address: string): string {
  const m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(address);
  return m ? `${m[1]}.0/24` : "192.168.1.0/24";
}

export const caddyBlock = (d: InfraData) =>
  `${d.name} {\n\treverse_proxy ${d.address}:${d.port}\n}`;

/** A wildcard site already in the Caddyfile: one more name inside it. */
export const caddyWildcardBlock = (d: InfraData) =>
  `*.${parentDomain(d.name)} {\n\t@redgiant host ${d.name}\n\thandle @redgiant {\n\t\treverse_proxy ${d.address}:${d.port}\n\t}\n\t# … the other names of the wildcard\n}`;

/** Traefik's file provider (dynamic configuration). */
export const traefikBlock = (d: InfraData) =>
  [
    "http:",
    "  routers:",
    "    redgiant:",
    `      rule: Host(\`${d.name}\`)`,
    "      entryPoints: [websecure]",
    "      service: redgiant",
    "      tls:",
    "        certResolver: letsencrypt",
    "  services:",
    "    redgiant:",
    "      loadBalancer:",
    "        servers:",
    `          - url: http://${d.address}:${d.port}`,
  ].join("\n");

/** Forward auth in front (Authelia, Authentik…): what to leave out of it in Caddy. */
export const caddyForwardAuthBypass = (d: InfraData) =>
  `${d.name} {\n\t@app path /api/* /ws\n\thandle @app {\n\t\treverse_proxy ${d.address}:${d.port}\n\t}\n\thandle {\n\t\tforward_auth authelia:9091 {\n\t\t\turi /api/authz/forward-auth\n\t\t\tcopy_headers Remote-User Remote-Groups\n\t\t}\n\t\treverse_proxy ${d.address}:${d.port}\n\t}\n}`;

export const tailscaleServe = (d: InfraData) => `tailscale serve --bg ${d.port}`;

export const tailscaleSubnet = (d: InfraData) =>
  `tailscale up --advertise-routes=${subnetOf(d.address)}`;

/** Pi-hole / dnsmasq: every name of a wildcard to the proxy (or to RedGiant). */
export const dnsmasqWildcard = (d: InfraData) => `address=/${parentDomain(d.name)}/${d.address}`;

/** How to check it answers, from any computer. */
export const healthCheck = (url: string) => `curl -s ${url.replace(/\/$/, "")}/api/health`;

/** The address the person reaches RedGiant at, from the name (https unless told otherwise). */
export function reachUrl(name: string, https = true): string {
  return `${https ? "https" : "http"}://${name}`;
}

// «Your home services (Gitea, NAS…) seen by RedGiant» (p3.7.3): RedGiant reaches them by name,
// through the DNS of the machine it runs on, which must give the name the proxy's address on the
// local network (not a Tailscale one, when RedGiant is not in the tailnet).

export interface HomeService {
  /** The service's name, as the person opens it (git.home.example.com). */
  name: string;
  /** The local address of the proxy in front of it (or of the service itself). */
  proxy: string;
}

export const PLACEHOLDER_SERVICE = "git.home.example.com";
export const PLACEHOLDER_PROXY = "192.168.1.12";

export function homeService(
  name: string | null | undefined,
  proxy: string | null | undefined,
): HomeService {
  return {
    name: name?.trim().toLowerCase() || PLACEHOLDER_SERVICE,
    proxy: proxy?.trim() || PLACEHOLDER_PROXY,
  };
}

/** Pi-hole's local DNS records and /etc/hosts: one line, address then name. */
export const homeHostsLine = (h: HomeService) => `${h.proxy} ${h.name}`;

/** dnsmasq (Pi-hole's /etc/dnsmasq.d/, many routers): the name to the proxy's address. */
export const homeDnsmasq = (h: HomeService) => `address=/${h.name}/${h.proxy}`;

/** What the DNS of RedGiant's machine answers for the name (RedGiant OS: its console, SSH). */
export const homeLookup = (h: HomeService) => `resolvectl query ${h.name}`;

/** Which DNS RedGiant OS uses. */
export const WHICH_DNS = "resolvectl status";

/** A Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48): reachable only inside the tailnet. */
export function isTailscaleAddress(address: string): boolean {
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(address);
  if (m) return Number(m[1]) >= 64 && Number(m[1]) <= 127;
  return /^fd7a:115c:a1e0:/i.test(address);
}

export type ProbeKey =
  | "oiProbeOk"
  | "oiProbeNotFound"
  | "oiProbeDnsFailed"
  | "oiProbeTailscale"
  | "oiProbeUnreachable"
  | "oiProbeTimeout"
  | "oiProbeTls";

/** What «Try a name» found, in plain words: the text's key, its tone and its values. */
export function probeVerdict(p: NameProbe): {
  key: ProbeKey;
  ok: boolean;
  params: Record<string, string>;
} {
  const params = {
    name: p.name,
    address: p.address ?? "",
    status: p.status === null ? "" : String(p.status),
  };
  const say = (key: ProbeKey, ok = false) => ({ key, ok, params });
  if (p.why === "not_found") return say("oiProbeNotFound");
  if (p.why === "dns_failed") return say("oiProbeDnsFailed");
  if (p.why === "ok") return say("oiProbeOk", true);
  if (p.why === "tls") return say("oiProbeTls");
  if (p.address && isTailscaleAddress(p.address)) return say("oiProbeTailscale");
  return say(p.why === "timeout" ? "oiProbeTimeout" : "oiProbeUnreachable");
}

// «You already have your own infrastructure» (G39.8), without the page: the blocks to copy for
// a reverse proxy, a VPN and a home DNS, filled with RedGiant's name, address and port. Pure,
// so the page and the tests read the same text.

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

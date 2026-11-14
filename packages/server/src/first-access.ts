// The first access without friction (G39.7, decision of 2026-11-14): while an installation has
// no password and its first start is not completed, whoever opens the page from the local
// network creates the access (a password) and is in, as routers, NAS and Home Assistant do. No
// token, no console. From outside the local network that page is refused (unless the
// administrator allows it), and a proxy in front cannot be fooled by headers a client wrote:
// the connection itself must come from a private address, and so must every address the
// proxies in between say they saw. Pure functions, tested as tables.

/** IPv4 as four numbers, or null. */
function v4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const n = m.slice(1).map(Number);
  return n.every((x) => x <= 255) ? n : null;
}

/**
 * An address of the local network, of this machine, or of the person's own private network
 * (Tailscale's 100.64.0.0/10 and fd7a:115c:a1e0::/48): never a public one.
 */
export function isLocalNetwork(address: string | undefined): boolean {
  if (!address) return false;
  let ip = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  // An IPv4 address carried in IPv6 (::ffff:192.168.1.5), as Node reports it on dual stacks.
  if (ip.startsWith("::ffff:") && ip.includes(".")) ip = ip.slice(7);
  const a = v4(ip);
  if (a) {
    const [x = 0, y = 0] = a;
    return (
      x === 10 ||
      x === 127 ||
      (x === 192 && y === 168) ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 169 && y === 254) ||
      (x === 100 && y >= 64 && y <= 127)
    );
  }
  if (!ip.includes(":")) return false;
  // Zone ids (fe80::1%eth0) are not part of the address.
  ip = ip.replace(/%.*$/, "");
  return ip === "::1" || /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
}

/**
 * Whether a request reaches us from the local network: the connection, and every client address
 * a proxy in between reports (Cloudflare's, X-Real-IP, each X-Forwarded-For entry, Forwarded's
 * `for=`). A tunnel or a proxy that carries a request from the internet says so in one of them.
 */
export function fromLocalNetwork(
  socketAddress: string | undefined,
  header: (name: string) => string | undefined,
): boolean {
  if (!isLocalNetwork(socketAddress)) return false;
  const claims: string[] = [];
  const cf = header("cf-connecting-ip");
  if (cf) claims.push(cf);
  // A Cloudflare tunnel without the client's address is still the internet.
  else if (header("cf-ray")) return false;
  const real = header("x-real-ip");
  if (real) claims.push(real);
  for (const x of (header("x-forwarded-for") ?? "").split(",")) if (x.trim()) claims.push(x.trim());
  for (const m of (header("forwarded") ?? "").matchAll(/for="?\[?([^\]";,]+)/gi))
    if (m[1]) claims.push(m[1].replace(/:\d+$/, ""));
  return claims.every((c) => isLocalNetwork(c));
}

/** Who may create the first access: the local network (default), or anywhere when allowed. */
export type FirstAccessFrom = "lan" | "anywhere";

/** What the sign-in page offers while there is no password (absent: the usual sign-in). */
export type FirstAccess = "password" | "code" | "not_here";

/**
 * The rule, in one place: nothing once a password exists or the first start is completed; the
 * one-time code when the administrator asked for it (`REDGIANT_SETUP_CODE=1`); otherwise the
 * password page, from the local network only unless allowed from anywhere.
 */
export function firstAccessOf(o: {
  hasPassword: boolean;
  completed: boolean;
  /** This start asked for the one-time code (used or not). */
  codeActive: boolean;
  local: boolean;
  from: FirstAccessFrom;
}): FirstAccess | null {
  if (o.hasPassword || o.completed) return null;
  if (o.codeActive) return "code";
  return o.local || o.from === "anywhere" ? "password" : "not_here";
}

/** `REDGIANT_FIRST_ACCESS`: "anywhere" lets the first access be created from any address. */
export function firstAccessFromEnv(v: string | undefined): FirstAccessFrom {
  return v?.trim().toLowerCase() === "anywhere" ? "anywhere" : "lan";
}

/** `REDGIANT_SETUP_CODE`: the one-time code of G39.3 is required only when asked for. */
export function setupCodeRequired(v: string | undefined): boolean {
  return ["1", "on", "yes", "true", "required"].includes(v?.trim().toLowerCase() ?? "");
}

/** The lines the console and the log show at a first start without a code: only the address. */
export function firstAccessBanner(port: number, addresses: string[]): string {
  const where = addresses.length
    ? addresses.map((a) => `http://${a}:${port}`).join("  or  ")
    : `http://<this machine's address>:${port}`;
  const line = "=".repeat(72);
  return [
    line,
    " RedGiant: first start. From a phone or computer on this network open",
    `   ${where}`,
    " and create your access (a password).",
    line,
  ].join("\n");
}

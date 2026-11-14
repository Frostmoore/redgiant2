// «Your home services (Gitea, NAS…) seen by RedGiant» (p3.7.3): whether a name the person gives
// resolves where RedGiant runs, and whether https://<name> answers from here. A home Gitea behind
// the home's proxy failed with «fetch failed» because the DNS RedGiant uses (the router) did not
// know its name, or a Pi-hole answered with a Tailscale address RedGiant cannot reach. Only a
// valid host name (no address, no port, no path), only HEAD (GET when HEAD is not allowed, its
// body never read), a short time limit, and nothing of the answer comes back but the address
// found, reachable or not and the HTTP status.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { NameProbe, NetFailure } from "@redgiant/protocol";

export type { NameProbe, NetFailure };

/** A host name as the person types it, cleaned; null unless it is a valid name (not an address). */
export function probeName(text: string): string | null {
  const n = text.trim().toLowerCase().replace(/\.$/, "");
  if (!n || n.length > 253 || isIP(n) || n.includes(":")) return null;
  if (n === "localhost" || n.endsWith(".localhost")) return null;
  const labels = n.split(".");
  if (labels.every((l) => /^\d+$/.test(l))) return null;
  return labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) ? n : null;
}

const TLS = /^(?:CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/;

/** Why a fetch (or a lookup) failed, from Node's error and its cause; null when it is not the network's. */
export function netFailure(err: unknown): NetFailure | null {
  const codes: string[] = [];
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    const o = e as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof o.code === "string") codes.push(o.code);
    if (o.name === "TimeoutError" || o.name === "AbortError") codes.push("ETIMEDOUT");
    e = o.cause;
  }
  if (codes.some((c) => c === "ENOTFOUND" || c === "ENODATA")) return "not_found";
  if (codes.some((c) => c === "EAI_AGAIN" || c === "ESERVFAIL")) return "dns_failed";
  if (codes.some((c) => TLS.test(c))) return "tls";
  if (codes.some((c) => c === "ETIMEDOUT" || c === "UND_ERR_CONNECT_TIMEOUT")) return "timeout";
  if (
    codes.some((c) =>
      ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EHOSTDOWN"].includes(c),
    )
  )
    return "unreachable";
  return null;
}

export interface ProbeDeps {
  lookup?: (name: string) => Promise<{ address: string }>;
  fetch?: typeof fetch;
  /** The limit of each step (default: 3 s for the name, 6 s for the answer). */
  lookupMs?: number;
  fetchMs?: number;
}

const within = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((ok, no) => {
    const timer = setTimeout(
      () => no(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        ok(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        no(err);
      },
    );
  });

/** Resolves `name` and asks https://<name>/ once, as RedGiant's own requests would. */
export async function probeService(name: string, deps: ProbeDeps = {}): Promise<NameProbe> {
  const lookup = deps.lookup ?? ((n: string) => dnsLookup(n));
  const f = deps.fetch ?? fetch;
  let address: string;
  try {
    address = (await within(lookup(name), deps.lookupMs ?? 3000)).address;
  } catch (err) {
    const why = netFailure(err);
    return {
      name,
      address: null,
      reachable: false,
      status: null,
      why: why === "timeout" ? "dns_failed" : (why ?? "not_found"),
    };
  }
  const ask = async (method: "HEAD" | "GET") => {
    const r = await f(`https://${name}/`, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(deps.fetchMs ?? 6000),
    });
    await r.body?.cancel().catch(() => {});
    return r.status;
  };
  try {
    let status = await ask("HEAD");
    if (status === 405 || status === 501) status = await ask("GET");
    return { name, address, reachable: true, status, why: "ok" };
  } catch (err) {
    const why = netFailure(err) ?? "unreachable";
    return { name, address, reachable: why === "tls", status: null, why };
  }
}

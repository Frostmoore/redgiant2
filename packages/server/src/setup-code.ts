// The first boot from another device (G39.3): a machine without a screen is set up from a
// phone or a computer on the same network. Nobody holds the installation's token there, and
// the wizard must never be an open admin page on the network: at the first start (wizard not
// completed, no password yet) RedGiant prints a one-time code on its console and in its log
// (and writes it to setup-code.txt for RedGiant OS's console). The code, typed on the page,
// opens one ordinary password session; the wizard then asks for the password, and from there
// signing in is the usual one. Wrong codes count like wrong passwords (5 per address, 30 in all,
// every 15 minutes); the code is used once and is gone when the wizard completes.
import { randomInt, timingSafeEqual } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import type { NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";

/** No 0/O, 1/I/L: read from a screen and typed on a phone (31 symbols). */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LENGTH = 10;

/** A new code, "ABCDE-FGHJK" (≈ 49 bits). */
export function newSetupCode(pick: (n: number) => number = randomInt): string {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[pick(CODE_ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** What the person typed, as the code is kept: capitals, no spaces or dashes, O as 0 is not ours. */
export function normalizeCode(typed: string): string {
  return typed.toUpperCase().replace(/[\s-]+/g, "");
}

/** The addresses of this machine on the local network (no loopback, no container bridges). */
export function lanAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (/^(lo|docker\d*|br-|veth|virbr|cni|flannel|tailscale|tun|wg)/.test(name)) continue;
    for (const a of list ?? [])
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push(a.address);
  }
  return out;
}

export type CodeCheck = "ok" | "wrong" | "too_many" | "none";

export class SetupCode {
  private code: string | null = null;
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly o: { dataDir?: string; now?: () => number; pick?: (n: number) => number } = {},
  ) {}

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  get active(): boolean {
    return this.code !== null;
  }

  private get file() {
    return this.o.dataDir ? join(this.o.dataDir, "setup-code.txt") : undefined;
  }

  /** A new code (the old one stops working); written for the OS console, readable by its owner only. */
  async issue(): Promise<string> {
    const shown = newSetupCode(this.o.pick);
    this.code = normalizeCode(shown);
    if (this.file) await writeFile(this.file, `${shown}\n`, { mode: 0o600 }).catch(() => {});
    return shown;
  }

  /** The code is gone: used, or the wizard completed. */
  async clear(): Promise<void> {
    this.code = null;
    if (this.file) await rm(this.file, { force: true }).catch(() => {});
  }

  private tooMany(address: string): boolean {
    const since = this.now() - 15 * 60_000;
    const recent = (key: string) => {
      const list = (this.failures.get(key) ?? []).filter((t) => t > since);
      this.failures.set(key, list);
      return list.length;
    };
    return recent(address) >= 5 || recent("*") >= 30;
  }

  /** Checks a typed code; a right one is used up at once. */
  async use(typed: string, address: string): Promise<CodeCheck> {
    if (!this.code) return "none";
    if (this.tooMany(address)) return "too_many";
    const want = Buffer.from(this.code);
    const got = Buffer.from(normalizeCode(typed));
    if (got.length === want.length && timingSafeEqual(got, want)) {
      await this.clear();
      return "ok";
    }
    for (const key of [address, "*"])
      this.failures.set(key, [...(this.failures.get(key) ?? []), this.now()]);
    return "wrong";
  }
}

/** The lines the console and the log show at a first start. */
export function setupCodeBanner(code: string, port: number, addresses: string[]): string {
  const where = addresses.length
    ? addresses.map((a) => `http://${a}:${port}`).join("  or  ")
    : `http://<this machine's address>:${port}`;
  const line = "=".repeat(72);
  return [
    line,
    " RedGiant: first start. From a phone or computer on this network open",
    `   ${where}`,
    ` and type the setup code:  ${code}`,
    " (one use; a new code at every start until the setup is completed)",
    line,
  ].join("\n");
}

// Signing in with a password (G24.6): what makes RedGiant safe to reach from outside home. A
// password stored only as a scrypt hash, sessions that expire (30 days, revocable), at most five
// wrong tries per address every 15 minutes, and an optional second check with a 6-digit code
// from an authenticator app (TOTP, RFC 6238).

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { SqlClient } from "@redgiant/events";
import type { Principal } from "./auth.js";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const DAY = 86_400_000;

export async function migrateLogin(db: SqlClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_logins (
      owner_id      text PRIMARY KEY,
      password_hash text NOT NULL,
      totp_secret   text,
      updated_at    timestamptz NOT NULL DEFAULT now()
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_login_sessions (
      id           text PRIMARY KEY,
      owner_id     text NOT NULL,
      token_hash   text NOT NULL UNIQUE,
      name         text NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      expires_at   timestamptz NOT NULL,
      last_seen_at timestamptz,
      revoked_at   timestamptz
    )`);
}

/** Why a sign-in failed, in a code the page explains. */
export class LoginError extends Error {
  constructor(
    readonly code: "wrong" | "code_needed" | "too_many" | "weak" | "no_password",
    message: string,
  ) {
    super(message);
  }
}

// --- TOTP (RFC 6238): 30-second steps, 6 digits, SHA-1, one step of drift either side ---------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secret: string, at: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", unbase32(secret)).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 15;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, "0");
}

function totpOk(secret: string, code: string, now: number): boolean {
  const c = code.replace(/\s/g, "");
  return [-30_000, 0, 30_000].some((d) => totp(secret, now + d) === c);
}

// --- Passwords and sessions ---------------------------------------------------------------

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function passwordOk(password: string, stored: string): Promise<boolean> {
  const [kind, salt, key] = stored.split("$");
  if (kind !== "scrypt" || !salt || !key) return false;
  const want = Buffer.from(key, "base64");
  const got = await scryptAsync(password, Buffer.from(salt, "base64"), want.length);
  return timingSafeEqual(want, got);
}

export interface LoginSession {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
}

export class LoginStore {
  private readonly failures = new Map<string, number[]>();
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly db: SqlClient,
    private readonly o: { now?: () => number; sessionDays?: number } = {},
  ) {}

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  async status(ownerId: string): Promise<{ password: boolean; code: boolean }> {
    const [r] = await this.db.query<{ totp_secret: string | null }>(
      "SELECT totp_secret FROM rg_logins WHERE owner_id = $1",
      [ownerId],
    );
    return { password: Boolean(r), code: Boolean(r?.totp_secret) };
  }

  /** Sets (or changes) the password; every session but the caller's ends. */
  async setPassword(ownerId: string, password: string, keep?: string): Promise<void> {
    if (password.length < 10 || /^(.)\1+$/.test(password))
      throw new LoginError("weak", "The password needs at least 10 characters, not all the same");
    await this.db.query(
      `INSERT INTO rg_logins (owner_id, password_hash) VALUES ($1, $2)
       ON CONFLICT (owner_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
      [ownerId, await hashPassword(password)],
    );
    await this.db.query(
      `UPDATE rg_login_sessions SET revoked_at = now()
       WHERE owner_id = $1 AND revoked_at IS NULL AND id <> $2`,
      [ownerId, keep ?? ""],
    );
  }

  /** A new secret for the authenticator app (not active until confirmed with a code). */
  newCodeSecret(ownerId: string, label = "RedGiant"): { secret: string; url: string } {
    const secret = base32(randomBytes(20));
    const url = `otpauth://totp/${encodeURIComponent(label)}:${encodeURIComponent(ownerId)}?secret=${secret}&issuer=${encodeURIComponent(label)}&digits=6&period=30`;
    return { secret, url };
  }

  /** Switches the code on: the app's current code proves it was set up. */
  async enableCode(ownerId: string, secret: string, code: string): Promise<void> {
    if (!(await this.status(ownerId)).password)
      throw new LoginError("no_password", "Set a password first");
    if (!totpOk(secret, code, this.now()))
      throw new LoginError("wrong", "The code does not match: check the app and try again");
    await this.db.query("UPDATE rg_logins SET totp_secret = $2 WHERE owner_id = $1", [
      ownerId,
      secret,
    ]);
  }

  async disableCode(ownerId: string): Promise<void> {
    await this.db.query("UPDATE rg_logins SET totp_secret = NULL WHERE owner_id = $1", [ownerId]);
  }

  /** Five wrong tries per address, thirty in all (many addresses at once), every 15 minutes. */
  private tooMany(address: string): boolean {
    const since = this.now() - 15 * 60_000;
    const recent = (key: string) => {
      const list = (this.failures.get(key) ?? []).filter((t) => t > since);
      this.failures.set(key, list);
      return list.length;
    };
    return recent(address) >= 5 || recent("*") >= 30;
  }

  private failed(address: string): void {
    for (const key of [address, "*"])
      this.failures.set(key, [...(this.failures.get(key) ?? []), this.now()]);
  }

  /** Password (and code, when switched on) for a session token that lasts 30 days. */
  async login(
    ownerId: string,
    password: string,
    code: string | undefined,
    address: string,
    name: string,
  ): Promise<{ token: string; expiresAt: string }> {
    if (this.tooMany(address))
      throw new LoginError("too_many", "Too many wrong tries: wait 15 minutes");
    const [r] = await this.db.query<{ password_hash: string; totp_secret: string | null }>(
      "SELECT password_hash, totp_secret FROM rg_logins WHERE owner_id = $1",
      [ownerId],
    );
    if (!r) throw new LoginError("no_password", "No password is set");
    if (!(await passwordOk(password, r.password_hash))) {
      this.failed(address);
      throw new LoginError("wrong", "Wrong password");
    }
    if (r.totp_secret) {
      if (!code) throw new LoginError("code_needed", "The code from the authenticator app");
      if (!totpOk(r.totp_secret, code, this.now())) {
        this.failed(address);
        throw new LoginError("wrong", "Wrong code");
      }
    }
    this.failures.delete(address);
    return this.openSession(ownerId, name);
  }

  /**
   * A session without a password: only for whoever proved otherwise who they are (the
   * one-time setup code of a first start, G39.3).
   */
  async openSession(ownerId: string, name: string): Promise<{ token: string; expiresAt: string }> {
    const id = `ls_${randomBytes(6).toString("hex")}`;
    const token = `rgs_${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(this.now() + (this.o.sessionDays ?? 30) * DAY).toISOString();
    await this.db.query(
      "INSERT INTO rg_login_sessions (id, owner_id, token_hash, name, expires_at) VALUES ($1, $2, $3, $4, $5)",
      [id, ownerId, hash(token), name.slice(0, 80) || "Browser", expiresAt],
    );
    return { token, expiresAt };
  }

  /** The id of a password session's token (to keep it when the password changes). */
  async sessionIdOf(token: string | undefined): Promise<string | undefined> {
    if (!token?.startsWith("rgs_")) return undefined;
    const [r] = await this.db.query<{ id: string }>(
      "SELECT id FROM rg_login_sessions WHERE token_hash = $1",
      [hash(token)],
    );
    return r?.id;
  }

  async sessions(ownerId: string): Promise<LoginSession[]> {
    const rows = await this.db.query<{
      id: string;
      name: string;
      created_at: Date | string;
      expires_at: Date | string;
      last_seen_at: Date | string | null;
    }>(
      `SELECT id, name, created_at, expires_at, last_seen_at FROM rg_login_sessions
       WHERE owner_id = $1 AND revoked_at IS NULL AND expires_at > $2 ORDER BY created_at`,
      [ownerId, new Date(this.now()).toISOString()],
    );
    return rows.map((x) => ({
      id: x.id,
      name: x.name,
      createdAt: new Date(x.created_at).toISOString(),
      expiresAt: new Date(x.expires_at).toISOString(),
      lastSeenAt: x.last_seen_at ? new Date(x.last_seen_at).toISOString() : null,
    }));
  }

  /** Ends every session (signed out everywhere). */
  async revokeAll(ownerId: string): Promise<void> {
    await this.db.query(
      "UPDATE rg_login_sessions SET revoked_at = now() WHERE owner_id = $1 AND revoked_at IS NULL",
      [ownerId],
    );
  }

  async authenticate(token: string): Promise<Principal | null> {
    if (!token.startsWith("rgs_")) return null;
    const [r] = await this.db.query<{ id: string; owner_id: string }>(
      `SELECT id, owner_id FROM rg_login_sessions
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
      [hash(token), new Date(this.now()).toISOString()],
    );
    if (!r) return null;
    if (this.now() - (this.seen.get(r.id) ?? 0) > 60_000) {
      this.seen.set(r.id, this.now());
      await this.db
        .query("UPDATE rg_login_sessions SET last_seen_at = now() WHERE id = $1", [r.id])
        .catch(() => {});
    }
    return { ownerId: r.owner_id };
  }
}

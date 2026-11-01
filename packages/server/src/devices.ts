import { createHash, randomBytes, randomInt } from "node:crypto";
import type { SqlClient } from "@redgiant/events";
import type { AuthProvider, Principal } from "./auth.js";

export interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export class PairingError extends Error {}

/** Unambiguous letters and digits (no 0/O, 1/I/L): codes are read off a screen, too. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function migrateDevices(db: SqlClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_devices (
      id           text PRIMARY KEY,
      owner_id     text NOT NULL,
      name         text NOT NULL,
      token_hash   text NOT NULL UNIQUE,
      created_at   timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz,
      revoked_at   timestamptz
    )`);
}

/**
 * Phones and other browsers paired by QR code (G20.9): each gets its own token, stored only as a
 * hash and revocable on its own, so the installation's main token never travels to a phone.
 */
export class DeviceStore {
  private readonly codes = new Map<string, { ownerId: string; expires: number }>();
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly db: SqlClient,
    private readonly o: { codeTtlMs?: number; now?: () => number } = {},
  ) {}

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  /** A one-time code for the QR, valid for ten minutes. */
  pairingCode(ownerId: string): { code: string; expiresAt: string } {
    for (const [c, e] of this.codes) if (e.expires < this.now()) this.codes.delete(c);
    let code = "";
    for (let i = 0; i < 10; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    const expires = this.now() + (this.o.codeTtlMs ?? 600_000);
    this.codes.set(code, { ownerId, expires });
    return { code, expiresAt: new Date(expires).toISOString() };
  }

  /** The phone presents the code once and receives its own token. */
  async claim(code: string, name: string): Promise<{ token: string; device: Device }> {
    const key = code.trim().toUpperCase();
    const entry = this.codes.get(key);
    this.codes.delete(key);
    if (!entry || entry.expires < this.now())
      throw new PairingError("This code is not valid any more: show a new QR code");
    const id = `dev_${randomBytes(6).toString("hex")}`;
    const token = `rgd_${randomBytes(24).toString("base64url")}`;
    await this.db.query(
      "INSERT INTO rg_devices (id, owner_id, name, token_hash) VALUES ($1, $2, $3, $4)",
      [id, entry.ownerId, name.trim().slice(0, 80) || "Device", hash(token)],
    );
    const [device] = await this.list(entry.ownerId, id);
    return { token, device: device as Device };
  }

  async list(ownerId: string, only?: string): Promise<Device[]> {
    const rows = await this.db.query<{
      id: string;
      name: string;
      created_at: Date | string;
      last_seen_at: Date | string | null;
    }>(
      `SELECT id, name, created_at, last_seen_at FROM rg_devices
       WHERE owner_id = $1 AND revoked_at IS NULL${only ? " AND id = $2" : ""} ORDER BY created_at`,
      only ? [ownerId, only] : [ownerId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: new Date(r.created_at).toISOString(),
      lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
    }));
  }

  /** The device's token stops working at once. */
  async revoke(ownerId: string, id: string): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      "UPDATE rg_devices SET revoked_at = now() WHERE id = $1 AND owner_id = $2 AND revoked_at IS NULL RETURNING id",
      [id, ownerId],
    );
    return rows.length > 0;
  }

  async authenticate(token: string): Promise<Principal | null> {
    if (!token.startsWith("rgd_")) return null;
    const [r] = await this.db.query<{ id: string; owner_id: string }>(
      "SELECT id, owner_id FROM rg_devices WHERE token_hash = $1 AND revoked_at IS NULL",
      [hash(token)],
    );
    if (!r) return null;
    // "Last seen" at most once a minute per device: no write on every request.
    if (this.now() - (this.seen.get(r.id) ?? 0) > 60_000) {
      this.seen.set(r.id, this.now());
      await this.db
        .query("UPDATE rg_devices SET last_seen_at = now() WHERE id = $1", [r.id])
        .catch(() => {});
    }
    return { ownerId: r.owner_id };
  }
}

/** The installation's own credentials first, then the paired devices. */
export class DeviceAuth implements AuthProvider {
  constructor(
    private readonly base: AuthProvider,
    private readonly devices: DeviceStore,
  ) {}

  async authenticate(token: string | undefined): Promise<Principal | null> {
    if (!token) return null;
    return (await this.base.authenticate(token)) ?? this.devices.authenticate(token);
  }
}

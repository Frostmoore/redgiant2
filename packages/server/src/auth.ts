import { timingSafeEqual } from "node:crypto";

export interface Principal {
  ownerId: string;
}

/**
 * Turns a presented credential into an owner. RedGiant ships the token implementation;
 * a multi-user installation plugs in its own (OIDC, reverse-proxy headers, ...).
 */
export interface AuthProvider {
  authenticate(token: string | undefined): Promise<Principal | null>;
}

/** Static tokens, each bound to an owner. Comparison is constant-time. */
export class TokenAuth implements AuthProvider {
  private readonly entries: { token: Buffer; ownerId: string }[];

  constructor(tokens: Record<string, string>) {
    this.entries = Object.entries(tokens)
      .filter(([t]) => t.length >= 16)
      .map(([t, ownerId]) => ({ token: Buffer.from(t), ownerId }));
    if (this.entries.length === 0)
      throw new Error("TokenAuth needs at least one token of 16+ characters");
  }

  async authenticate(token: string | undefined): Promise<Principal | null> {
    if (!token) return null;
    const given = Buffer.from(token);
    for (const e of this.entries) {
      if (e.token.length === given.length && timingSafeEqual(e.token, given))
        return { ownerId: e.ownerId };
    }
    return null;
  }
}

/** Tries each way of signing in, in order: the first that knows the token wins. */
export class ChainAuth implements AuthProvider {
  constructor(
    private readonly ways: { authenticate(token: string): Promise<Principal | null> }[],
  ) {}

  async authenticate(token: string | undefined): Promise<Principal | null> {
    if (!token) return null;
    for (const w of this.ways) {
      const p = await w.authenticate(token);
      if (p) return p;
    }
    return null;
  }
}

export const bearer = (header: string | undefined) => header?.match(/^Bearer\s+(.+)$/i)?.[1];

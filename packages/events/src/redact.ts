import { SECRET_PATTERNS } from "@redgiant/protocol";

/** Replaces secrets in any string inside a value before it is written to the log. */
export class Redactor {
  // The well-known key formats, shared with the chats' and the memory's recogniser.
  private readonly patterns = SECRET_PATTERNS;
  private readonly literals = new Map<string, string>();

  /** Registers a known secret value (e.g. from configuration); shorter than 6 chars is ignored. */
  addSecret(name: string, value: string): this {
    if (value.length >= 6) this.literals.set(value, name);
    return this;
  }

  redactText(text: string): { text: string; count: number } {
    let count = 0;
    let out = text;
    // Longest first, so a secret containing another is replaced whole.
    for (const [value, name] of [...this.literals].sort((a, b) => b[0].length - a[0].length)) {
      const parts = out.split(value);
      count += parts.length - 1;
      out = parts.join(`[REDACTED:${name}]`);
    }
    for (const { name, re } of this.patterns) {
      out = out.replace(re, () => {
        count++;
        return `[REDACTED:${name}]`;
      });
    }
    return { text: out, count };
  }

  redact<T>(value: T): { value: T; count: number } {
    let count = 0;
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") {
        const r = this.redactText(v);
        count += r.count;
        return r.text;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v !== null && typeof v === "object") {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      }
      return v;
    };
    return { value: walk(value) as T, count };
  }
}

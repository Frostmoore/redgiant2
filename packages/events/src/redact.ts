/** Replaces secrets in any string inside a value before it is written to the log. */
export class Redactor {
  private readonly patterns: { name: string; re: RegExp }[] = [
    {
      name: "private-key",
      re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    },
    { name: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
    { name: "openai-key", re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
    { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
    { name: "huggingface-token", re: /\bhf_[A-Za-z0-9]{30,}/g },
    { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
    { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
    { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
    { name: "telegram-bot-token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
    { name: "bearer", re: /(?<=\bBearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g },
  ];
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

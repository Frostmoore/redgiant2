export const kTokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 10_000
      ? `${Math.round(n / 1000)}k`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}k`
        : String(n);

export const duration = (ms: number | undefined) =>
  ms === undefined
    ? "–"
    : ms >= 60_000
      ? `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
      : ms >= 1000
        ? `${(ms / 1000).toFixed(1)}s`
        : `${Math.round(ms)}ms`;

export const usd = (v: number) =>
  v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;

export const clock = (iso: string | undefined) => (iso ? new Date(iso).toLocaleTimeString() : "–");

export const bytes = (n: number) =>
  n >= 1_073_741_824
    ? `${(n / 1_073_741_824).toFixed(2)} GB`
    : n >= 1_048_576
      ? `${(n / 1_048_576).toFixed(1)} MB`
      : n >= 1024
        ? `${(n / 1024).toFixed(1)} KB`
        : `${n} B`;

const pad2 = (n: number) => String(n).padStart(2, "0");
/** The first day of this month and every day up to today, as YYYY-MM-DD. */
export function monthDays(now = new Date()): string[] {
  const out: string[] = [];
  for (let d = 1; d <= now.getDate(); d++)
    out.push(`${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(d)}`);
  return out;
}

/**
 * A local model's readable name from its file (p3.3.1: the whole path ran out of the agent's
 * card): no folders, no ".gguf", no split suffix ("-00001-of-00002"); dashes before a word
 * become spaces, those before a number stay ("GLM-4.5"). `C:\…\GLM-4.5-Air-Q4_K_S-00001-of-00002.gguf` →
 * "GLM-4.5 Air Q4_K_S". Anything else is returned as it is.
 */
export function localModelName(id: string): string {
  const file = /\.gguf$/i.test(id) || /[\\/]/.test(id) ? (id.split(/[\\/]/).pop() ?? id) : id;
  if (file === id && !/\.gguf$/i.test(id)) return id;
  const stem = file.replace(/\.gguf$/i, "").replace(/-\d{5}-of-\d{5}$/i, "");
  const parts = stem.split("-").filter(Boolean);
  let out = parts[0] ?? stem;
  for (let i = 1; i < parts.length; i++) {
    const cur = parts[i] as string;
    // A number stays joined ("GLM-4.5", "Qwen3.6-35B"); a word starts a new one.
    out += (/^\d/.test(cur) ? "-" : " ") + cur;
  }
  return out || id;
}

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
  n >= 1_048_576
    ? `${(n / 1_048_576).toFixed(1)} MB`
    : n >= 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${n} B`;

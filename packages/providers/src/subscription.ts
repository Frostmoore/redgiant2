/**
 * Usage of a flat-rate subscription window (e.g. "5 hours", "weekly"). Only shown when a
 * provider exposes the data officially; using a personal subscription inside RedGiant may
 * not be allowed by the provider's terms, and the user must be told so before enabling it.
 */
export interface SubscriptionWindow {
  id: string;
  label: string;
  usedPct: number;
  resetsAt?: string | undefined;
}

/** A provider on a flat subscription: its plan's usage windows (G21). */
export interface WithLimits {
  limits(): Promise<SubscriptionWindow[]>;
}

export const hasLimits = (p: unknown): p is WithLimits =>
  typeof (p as Partial<WithLimits> | null)?.limits === "function";

export interface SubscriptionSource {
  readonly provider: string;
  /** Link to the provider terms that govern use of the subscription in third-party tools. */
  readonly termsUrl: string;
  read(signal?: AbortSignal): Promise<SubscriptionWindow[]>;
}

/** API rate-limit state read from response headers (not subscription usage). */
export interface RateLimitSnapshot {
  requestsRemaining?: number | undefined;
  tokensRemaining?: number | undefined;
  resetsAt?: string | undefined;
}

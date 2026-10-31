/**
 * How tools describe themselves. Small local models get short descriptions (their context
 * is small and long instructions confuse them); every model gets every tool (RD29).
 */
export type ModelProfile = "full" | "compact";

export const describe = (profile: ModelProfile, d: { full: string; compact: string }) =>
  profile === "compact" ? d.compact : d.full;

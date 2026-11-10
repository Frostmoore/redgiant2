// find_files says how it searched and how long it took (3.5.5, the person's check of
// 2026-11-09): one English line at the end of the tool's answer, for the model, which the page
// reads back and shows in the person's language next to the call. Written and read only here.

/** Where find_files looked. */
export type FindSource = "everything" | "spotlight" | "locate" | "walk" | "path" | "container";

/** The words of the line for each source (English: the model reads them). */
export const FIND_SOURCE_WORDS: Record<FindSource, string> = {
  everything: "Everything's index",
  spotlight: "Spotlight's index",
  locate: "the locate database",
  walk: "walked the folders",
  path: "the programs on the PATH",
  container: "find in the container",
};

export interface FindTiming {
  source: FindSource;
  /** How long the search took, in seconds (one decimal). */
  seconds: number;
  /** Stopped by its time limit: the limit, in seconds. */
  cutAtSeconds?: number | undefined;
  /** Stopped because the turn was interrupted. */
  interrupted?: boolean | undefined;
}

const PREFIX = "Search: ";

/** «Search: Everything's index, 0.2 s.» / «Search: walked the folders, 20.0 s (cut at 20 s).» */
export function findTimingLine(t: FindTiming): string {
  const why =
    t.cutAtSeconds !== undefined
      ? ` (cut at ${t.cutAtSeconds} s)`
      : t.interrupted
        ? " (interrupted)"
        : "";
  return `${PREFIX}${FIND_SOURCE_WORDS[t.source]}, ${t.seconds.toFixed(1)} s${why}.`;
}

/** The line read back from a find_files answer, or undefined when there is none. */
export function parseFindTiming(output: string): FindTiming | undefined {
  const line = output
    .split("\n")
    .reverse()
    .find((l) => l.startsWith(PREFIX));
  if (!line) return undefined;
  const m = /^Search: (.+), (\d+(?:\.\d+)?) s(?: \((?:cut at (\d+) s|(interrupted))\))?\.$/.exec(
    line,
  );
  if (!m) return undefined;
  const source = (Object.keys(FIND_SOURCE_WORDS) as FindSource[]).find(
    (s) => FIND_SOURCE_WORDS[s] === m[1],
  );
  if (!source) return undefined;
  return {
    source,
    seconds: Number(m[2]),
    ...(m[3] !== undefined && { cutAtSeconds: Number(m[3]) }),
    ...(m[4] !== undefined && { interrupted: true }),
  };
}

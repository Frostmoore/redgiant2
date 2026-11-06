// «Next layer ahead» (G32.2, experimental, off by default): llama.cpp with RedGiant's patch
// (engine/llama-patches/0002) copies the next experts to the card while it computes the current
// ones. llama.cpp's own releases do not have it, so RedGiant's release of the same version carries
// a build for Windows and NVIDIA cards (the `llama-cuda` job of .github/workflows/release.yml).
// Only where those binaries exist: a version released without them says so and stays off.

/** The zip the release carries: llama-server.exe with its DLLs, cudart and cuBLAS. */
export const MOE_PREFETCH_ASSET = "llama-redgiant-win-cuda12.8-x64.zip";

const RELEASES = "https://github.com/Frostmoore/redgiant2/releases/download";

/** A version RedGiant was released as (the installer's, "3.2.0"); anything else is not one. */
export const releaseVersion = (v: string | undefined): string | undefined =>
  v && /^\d+\.\d+\.\d+$/.test(v.replace(/^v/, "")) ? v.replace(/^v/, "") : undefined;

/** Where the patched build of a version is. */
export const moePrefetchUrl = (version: string): string =>
  `${RELEASES}/v${version}/${MOE_PREFETCH_ASSET}`;

/**
 * What the switch can say (shown only on Windows with an NVIDIA card): the binaries are in this
 * version's release, or they are not (a version built without them, or a build that is not a
 * release); null where the switch has nothing to do.
 */
export type MoePrefetchState = "available" | "missing" | null;

/** Whether the computer can use the patched build: RedGiant's Windows engine and an NVIDIA card. */
export function moePrefetchApplies(hw: {
  windowsEngine: boolean;
  onWindows?: boolean | undefined;
  gpus: { vendor: string; integrated: boolean }[];
}): boolean {
  return (
    (hw.onWindows ?? hw.windowsEngine) &&
    hw.gpus.some((g) => g.vendor === "nvidia" && !g.integrated)
  );
}

/**
 * Looks whether the release has the zip (a HEAD request, redirects followed). Found, it stays
 * known; missing, it is asked again after a while (the release's zip is built for an hour after
 * the installer is out); with no network it is asked again next time.
 */
export function moePrefetchChecker(
  version: string | undefined,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): () => Promise<"available" | "missing"> {
  const v = releaseVersion(version);
  let found = false;
  let missingAt = Number.NEGATIVE_INFINITY;
  return async () => {
    if (!v) return "missing";
    if (found) return "available";
    if (now() - missingAt < MISSING_AGAIN_MS) return "missing";
    try {
      const r = await fetcher(moePrefetchUrl(v), {
        method: "HEAD",
        redirect: "follow",
        headers: { "user-agent": "RedGiant" },
        signal: AbortSignal.timeout(4000),
      });
      found = r.ok;
      if (!found) missingAt = now();
      return found ? "available" : "missing";
    } catch {
      return "missing";
    }
  };
}

/** How long a release without the zip is believed before asking GitHub again. */
export const MISSING_AGAIN_MS = 10 * 60_000;

/**
 * The release whose patched build an engine start uses, or undefined for the official one: the
 * option on, SSD stream on (the experts outside the card are what it copies ahead), RedGiant's
 * Windows engine, and the binaries in the release.
 */
export function moePrefetchRelease(
  cfg: { variant: string; stream?: boolean | undefined; moePrefetch?: boolean | undefined },
  binaries: MoePrefetchState,
  version: string | undefined,
): string | undefined {
  if (!cfg.moePrefetch || !cfg.stream || cfg.variant !== "windows") return undefined;
  if (binaries !== "available") return undefined;
  return releaseVersion(version);
}

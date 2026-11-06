// «Next layer ahead» (G32.2, experimental, off by default): llama.cpp with RedGiant's patch
// (engine/llama-patches/0002) copies the next experts to the card while it computes the current
// ones. llama.cpp's own releases do not have it, so RedGiant builds it: a zip for Windows and NVIDIA
// cards (the `llama-cuda` job of .github/workflows/release.yml) and, for the engines in Docker
// (Linux), the image `redgiant2-engine:cuda-prefetch` (docker/engine-prefetch.Dockerfile, job
// `engine-prefetch`). Only where those builds exist: without them the switch says so and stays off.
// Never on a Mac, never with Vulkan or the CPU.

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

/** The patched engine for Docker's NVIDIA runtime (Linux): llama.cpp's server with the patch. */
export const MOE_PREFETCH_IMAGE = "ghcr.io/frostmoore/redgiant2-engine:cuda-prefetch";

const nvidiaCard = (gpus: { vendor: string; integrated: boolean }[]) =>
  gpus.some((g) => g.vendor === "nvidia" && !g.integrated);

/**
 * Whether the computer can use the patched build. "windows": RedGiant's Windows engine and an
 * NVIDIA card. "docker": an NVIDIA card handed to containers by Docker's NVIDIA runtime (the
 * `cuda` engine), never on a Mac.
 */
export function moePrefetchApplies(
  hw: {
    os?: string | undefined;
    windowsEngine: boolean;
    onWindows?: boolean | undefined;
    dockerGpu?: boolean | undefined;
    gpus: { vendor: string; integrated: boolean }[];
  },
  engine: "windows" | "docker" = "windows",
): boolean {
  if (!nvidiaCard(hw.gpus)) return false;
  if (engine === "docker") return hw.dockerGpu === true && hw.os !== "darwin";
  return hw.onWindows ?? hw.windowsEngine;
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
 * Looks whether the patched image is there: on this computer already, or in its registry (asked
 * through Docker itself, `/distribution`, with its network and credentials). Found, it stays
 * known; missing (a version not released yet, no network), it is asked again after a while.
 */
export function moePrefetchImageChecker(
  image: string,
  docker: {
    getImage(name: string): { inspect(): Promise<unknown>; distribution(): Promise<unknown> };
  },
  now: () => number = Date.now,
): () => Promise<"available" | "missing"> {
  let found = false;
  let missingAt = Number.NEGATIVE_INFINITY;
  return async () => {
    if (found) return "available";
    const img = docker.getImage(image);
    found = await img.inspect().then(
      () => true,
      () => false,
    );
    if (found) return "available";
    if (now() - missingAt < MISSING_AGAIN_MS) return "missing";
    found = await withTimeout(img.distribution(), 8000).then(
      () => true,
      () => false,
    );
    if (!found) missingAt = now();
    return found ? "available" : "missing";
  };
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(resolve, reject).finally(() => clearTimeout(timer));
  });

/**
 * The image an engine start in Docker uses for «next layer ahead», or undefined for the usual one:
 * the option on, SSD stream on, the `cuda` engine, and the patched image there.
 */
export function moePrefetchImage(
  cfg: { variant: string; stream?: boolean | undefined; moePrefetch?: boolean | undefined },
  image: MoePrefetchState,
  name: string = MOE_PREFETCH_IMAGE,
): string | undefined {
  if (!cfg.moePrefetch || !cfg.stream || cfg.variant !== "cuda") return undefined;
  return image === "available" ? name : undefined;
}

/**
 * The engine container's environment: CUDA's kernel cache in the KV volume (a card newer than the
 * image's build compiles them at the first use, for minutes; once is enough, 2026-11-04), and the
 * patch switched on only for the patched image.
 */
export function engineContainerEnv(prefetch: boolean): string[] {
  return [
    "CUDA_CACHE_PATH=/kv/cuda-cache",
    "CUDA_CACHE_MAXSIZE=4294967296",
    ...(prefetch ? ["LLAMA_MOE_PREFETCH=1"] : []),
  ];
}

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

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  engineContainerEnv,
  MISSING_AGAIN_MS,
  MOE_PREFETCH_ASSET,
  MOE_PREFETCH_IMAGE,
  moePrefetchApplies,
  moePrefetchChecker,
  moePrefetchImage,
  moePrefetchImageChecker,
  moePrefetchRelease,
  moePrefetchUrl,
  releaseVersion,
} from "../src/moe-prefetch.js";
import { engineEnv } from "../src/native-launcher.js";
import { WinEngine, type WinEngineRequest } from "../src/win-engine.js";

const nvidia = { vendor: "nvidia", integrated: false };

describe("«next layer ahead»: the patched llama.cpp (G32.2)", () => {
  it("is RedGiant's release of the same version, one zip", () => {
    expect(MOE_PREFETCH_ASSET).toBe("llama-redgiant-win-cuda12.8-x64.zip");
    expect(moePrefetchUrl("3.2.0")).toBe(
      "https://github.com/Frostmoore/redgiant2/releases/download/v3.2.0/llama-redgiant-win-cuda12.8-x64.zip",
    );
    expect(releaseVersion("v3.2.0")).toBe("3.2.0");
    expect(releaseVersion("dev")).toBeUndefined();
    expect(releaseVersion("3.2.0 && calc")).toBeUndefined();
    expect(releaseVersion(undefined)).toBeUndefined();
  });

  it("applies only on Windows with an NVIDIA card of its own", () => {
    expect(moePrefetchApplies({ windowsEngine: true, gpus: [nvidia] })).toBe(true);
    expect(moePrefetchApplies({ windowsEngine: false, onWindows: true, gpus: [nvidia] })).toBe(
      true,
    );
    expect(moePrefetchApplies({ windowsEngine: false, onWindows: false, gpus: [nvidia] })).toBe(
      false,
    );
    expect(
      moePrefetchApplies({
        windowsEngine: true,
        gpus: [{ vendor: "nvidia", integrated: true }],
      }),
    ).toBe(false);
    expect(
      moePrefetchApplies({ windowsEngine: true, gpus: [{ vendor: "amd", integrated: false }] }),
    ).toBe(false);
  });

  it("looks for the zip in the release, keeps a yes, asks a no again after a while", async () => {
    const asked: string[] = [];
    let has = false;
    let t = 0;
    const fetcher = (async (url: string, init?: RequestInit) => {
      asked.push(`${init?.method} ${url}`);
      return new Response(null, { status: has ? 200 : 404 });
    }) as typeof fetch;
    const check = moePrefetchChecker("3.2.0", fetcher, () => t);
    expect(await check()).toBe("missing");
    expect(asked).toEqual([`HEAD ${moePrefetchUrl("3.2.0")}`]);
    has = true;
    // The release got its zip later: believed missing for a while, then found.
    t += MISSING_AGAIN_MS - 1;
    expect(await check()).toBe("missing");
    expect(asked).toHaveLength(1);
    t += 1;
    expect(await check()).toBe("available");
    has = false;
    expect(await check()).toBe("available");
    expect(asked).toHaveLength(2);
  });

  it("without a released version, or without network, there are no binaries", async () => {
    let calls = 0;
    const down = (async () => {
      calls++;
      throw new Error("offline");
    }) as typeof fetch;
    expect(await moePrefetchChecker(undefined, down)()).toBe("missing");
    expect(await moePrefetchChecker("dev", down)()).toBe("missing");
    expect(calls).toBe(0);
    const offline = moePrefetchChecker("3.2.0", down);
    expect(await offline()).toBe("missing");
    // No answer is not a «no»: asked again at once.
    expect(await offline()).toBe("missing");
    expect(calls).toBe(2);
  });

  it("is used only with the option, SSD stream, the Windows engine and the binaries", () => {
    const on = { variant: "windows", stream: true, moePrefetch: true };
    expect(moePrefetchRelease(on, "available", "3.2.0")).toBe("3.2.0");
    expect(moePrefetchRelease({ ...on, moePrefetch: false }, "available", "3.2.0")).toBe(undefined);
    expect(moePrefetchRelease({ ...on, stream: false }, "available", "3.2.0")).toBe(undefined);
    expect(moePrefetchRelease({ ...on, variant: "cuda" }, "available", "3.2.0")).toBe(undefined);
    expect(moePrefetchRelease(on, "missing", "3.2.0")).toBe(undefined);
    expect(moePrefetchRelease(on, null, "3.2.0")).toBe(undefined);
    expect(moePrefetchRelease(on, "available", "dev")).toBe(undefined);
  });

  it("asks RedGiant.exe for the patched build, only with CUDA", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-prefetch-"));
    const engine = new WinEngine({ dir, host: "h", pollMs: 5, noticeMs: 30 });
    const plan = {
      ctx: 32768,
      args: ["--cpu-moe", "-b", "4096", "-ub", "4096", "-lm", "none"],
      fit: true,
    };
    const asked = async (flavor: "cuda" | "vulkan", release?: string) => {
      await engine
        .start("m.gguf", undefined, plan, false, {}, flavor, undefined, release)
        .catch(() => {});
      return JSON.parse(await readFile(join(dir, "engine.json"), "utf8")) as WinEngineRequest;
    };
    const cuda = await asked("cuda", "3.2.0");
    expect(cuda).toMatchObject({ flavor: "cuda", prefetch: "1", release: "3.2.0" });
    expect(cuda.args).toContain("-lm none");
    const vulkan = await asked("vulkan", "3.2.0");
    expect(vulkan.prefetch).toBeUndefined();
    expect(vulkan.release).toBeUndefined();
    const official = await asked("cuda");
    expect(official.prefetch).toBeUndefined();
  });

  it("switches the patch on in llama-server's environment, and only then", () => {
    const r: WinEngineRequest = {
      id: "x",
      model: "m.gguf",
      build: "b12034",
      ctx: 4096,
      parallel: 1,
      flavor: "cuda",
      prefetch: "1",
      release: "3.2.0",
    };
    expect(engineEnv(r, { PATH: "p" })).toEqual({ PATH: "p", LLAMA_MOE_PREFETCH: "1" });
    const { prefetch: _p, ...plain } = r;
    // Never inherited from RedGiant's own environment.
    expect(engineEnv(plain, { PATH: "p", LLAMA_MOE_PREFETCH: "1" })).toEqual({ PATH: "p" });
    expect(engineEnv({ ...r, flavor: "vulkan" }, {})).toEqual({});
  });

  it("in Docker: an NVIDIA card through Docker's NVIDIA runtime, never on a Mac", () => {
    const linux = { os: "linux", windowsEngine: false, onWindows: false, dockerGpu: true };
    expect(moePrefetchApplies({ ...linux, gpus: [nvidia] }, "docker")).toBe(true);
    // The card without the runtime runs through Vulkan: not this engine.
    expect(moePrefetchApplies({ ...linux, dockerGpu: false, gpus: [nvidia] }, "docker")).toBe(
      false,
    );
    expect(
      moePrefetchApplies({ ...linux, gpus: [{ vendor: "amd", integrated: false }] }, "docker"),
    ).toBe(false);
    expect(
      moePrefetchApplies({ ...linux, gpus: [{ vendor: "nvidia", integrated: true }] }, "docker"),
    ).toBe(false);
    expect(moePrefetchApplies({ ...linux, os: "darwin", gpus: [nvidia] }, "docker")).toBe(false);
    // The Windows zip does not apply to Linux, the image does not need Windows.
    expect(moePrefetchApplies({ ...linux, gpus: [nvidia] })).toBe(false);
  });

  it("looks for the image here first, then in the registry; keeps a yes, asks a no again later", async () => {
    const asked: string[] = [];
    let local = false;
    let remote = false;
    let t = 0;
    const docker = {
      getImage: (name: string) => ({
        inspect: async () => {
          asked.push(`inspect ${name}`);
          if (!local) throw new Error("no such image");
        },
        distribution: async () => {
          asked.push(`distribution ${name}`);
          if (!remote) throw new Error("404");
        },
      }),
    };
    const check = moePrefetchImageChecker(MOE_PREFETCH_IMAGE, docker, () => t);
    expect(await check()).toBe("missing");
    expect(asked).toEqual([`inspect ${MOE_PREFETCH_IMAGE}`, `distribution ${MOE_PREFETCH_IMAGE}`]);
    remote = true;
    // Published later: the registry is not asked again for a while, the computer is.
    t += MISSING_AGAIN_MS - 1;
    expect(await check()).toBe("missing");
    expect(asked.filter((a) => a.startsWith("distribution"))).toHaveLength(1);
    t += 1;
    expect(await check()).toBe("available");
    remote = false;
    expect(await check()).toBe("available");
    expect(asked).toHaveLength(5);
    // Already pulled: no registry at all.
    const here: string[] = [];
    local = true;
    const pulled = moePrefetchImageChecker("img", {
      getImage: (n) => ({
        inspect: async () => here.push(n),
        distribution: async () => here.push(`remote ${n}`),
      }),
    });
    expect(await pulled()).toBe("available");
    expect(here).toEqual(["img"]);
  });

  it("in Docker the patched image runs only with the option, SSD stream, CUDA and the image", () => {
    const on = { variant: "cuda", stream: true, moePrefetch: true };
    expect(moePrefetchImage(on, "available")).toBe(MOE_PREFETCH_IMAGE);
    expect(moePrefetchImage(on, "available", "mine:test")).toBe("mine:test");
    expect(moePrefetchImage({ ...on, moePrefetch: false }, "available")).toBeUndefined();
    expect(moePrefetchImage({ ...on, stream: false }, "available")).toBeUndefined();
    for (const variant of ["vulkan", "cpu", "windows"])
      expect(moePrefetchImage({ ...on, variant }, "available")).toBeUndefined();
    expect(moePrefetchImage(on, "missing")).toBeUndefined();
    expect(moePrefetchImage(on, null)).toBeUndefined();
  });

  it("switches the patch on in the container's environment only for the patched image", () => {
    const plain = ["CUDA_CACHE_PATH=/kv/cuda-cache", "CUDA_CACHE_MAXSIZE=4294967296"];
    expect(engineContainerEnv(false)).toEqual(plain);
    expect(engineContainerEnv(true)).toEqual([...plain, "LLAMA_MOE_PREFETCH=1"]);
  });

  it("the patched image has the usual engine's defaults, b12034 with apply.sh, every card family", async () => {
    const root = join(import.meta.dirname, "..", "..", "..");
    const usual = await readFile(join(root, "docker", "engine.Dockerfile"), "utf8");
    const patched = await readFile(join(root, "docker", "engine-prefetch.Dockerfile"), "utf8");
    const defaults = (f: string) => {
      const env = f.slice(f.indexOf("ENV LLAMA_ARG_HOST"));
      return [
        env.slice(0, env.indexOf("\nVOLUME")),
        f.match(/^VOLUME .*$/m)?.[0],
        f.match(/^ENTRYPOINT .*$/m)?.[0],
      ];
    };
    expect(defaults(patched)).toEqual(defaults(usual));
    expect(patched).toContain("ARG LLAMA_BUILD=b12034");
    expect(patched).toContain("sh /patches/apply.sh");
    expect(patched).toContain('CUDA_ARCHS="75-real;80-real;86-real;89-real;90-real;120"');
    const workflow = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
    expect(workflow).toContain("docker/engine-prefetch.Dockerfile");
    expect(workflow).toContain(MOE_PREFETCH_IMAGE.split(":")[1]);
  });
});

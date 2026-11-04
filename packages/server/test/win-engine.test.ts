import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectHardware,
  Jobs,
  WIN_ENGINE_BUILD,
  WinEngine,
  type WinEngineRequest,
  type WinEngineStatus,
} from "../src/index.js";

/** RedGiant.exe in miniature: reads the request, then writes the states it is given. */
function launcher(dir: string, states: Omit<WinEngineStatus, "id">[], everyMs = 20) {
  const seen: WinEngineRequest[] = [];
  let stop = false;
  void (async () => {
    let last = "";
    while (!stop) {
      const raw = await readFile(join(dir, "engine.json"), "utf8").catch(() => "");
      if (raw && raw !== last) {
        last = raw;
        const r = JSON.parse(raw) as WinEngineRequest;
        seen.push(r);
        if (r.model === null) {
          await writeFile(
            join(dir, "engine-status.json"),
            JSON.stringify({ id: r.id, state: "stopped" }),
          );
          continue;
        }
        for (const s of states) {
          await writeFile(join(dir, "engine-status.json"), JSON.stringify({ id: r.id, ...s }));
          await new Promise((ok) => setTimeout(ok, everyMs * 3));
        }
      }
      await new Promise((ok) => setTimeout(ok, everyMs));
    }
  })();
  return { seen, close: () => (stop = true) };
}

describe("the engine on Windows itself", () => {
  it("asks RedGiant.exe for a model and follows the download, start and loading", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-win-"));
    const l = launcher(dir, [
      { state: "downloading", done: 10, total: 36 },
      { state: "downloading", done: 36, total: 36 },
      { state: "starting" },
      { state: "loading" },
      { state: "ready", port: 8091 },
    ]);
    const engine = new WinEngine({ dir, host: "172.28.0.1", pollMs: 10 });
    const jobs = new Jobs();
    let url = "";
    const job = jobs.start("me", "engine", ["image", "start", "load", "try"], async (h) => {
      url = await engine.start("gemma-4-12b-it-Q4_K_M.gguf", h);
    });
    const end = await jobs.settled(job.id);
    l.close();
    expect(end?.state).toBe("done");
    expect(url).toBe("http://172.28.0.1:8091");
    expect(end?.steps.map((s) => s.state)).toEqual(["done", "done", "done", "waiting"]);
    expect(l.seen[0]).toMatchObject({
      model: "gemma-4-12b-it-Q4_K_M.gguf",
      build: WIN_ENGINE_BUILD,
      parallel: 4,
    });
    expect(engine.modelsDir).toBe(join(dir, "models"));
  });

  it("asks for the model to be read once first, and follows that reading (2026-11-04)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-win-"));
    const l = launcher(dir, [
      { state: "starting" },
      { state: "preloading", done: 5, total: 10 },
      { state: "loading" },
      { state: "ready", port: 8091 },
    ]);
    const engine = new WinEngine({ dir, host: "h", pollMs: 10 });
    const jobs = new Jobs();
    const job = jobs.start("me", "engine", ["image", "preload", "start", "load"], async (h) => {
      h.skip("image");
      await engine.start("m.gguf", h, undefined, true, {
        speculative: "draft",
        draft: "small.gguf",
      });
    });
    const end = await jobs.settled(job.id);
    l.close();
    expect(end?.state).toBe("done");
    expect(end?.steps.find((s) => s.id === "preload")?.state).toBe("done");
    expect(l.seen[0]).toMatchObject({ preload: "1", draft: "small.gguf" });
  });

  it("says why it failed, from the launcher's code or the engine's log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-win-"));
    const failing = async (status: Omit<WinEngineStatus, "id">) => {
      const l = launcher(dir, [{ state: "starting" }, status]);
      const err = await new WinEngine({ dir, host: "h", pollMs: 10 })
        .start("m.gguf")
        .catch((e: unknown) => e as { code?: string });
      l.close();
      return (err as { code?: string }).code;
    };
    expect(await failing({ state: "failed", error: "download", log: "404" })).toBe(
      "image_download",
    );
    expect(
      await failing({
        state: "failed",
        log: "ggml_vulkan: device memory allocation failed: ErrorOutOfDeviceMemory",
      }),
    ).toBe("out_of_memory");
    expect(await failing({ state: "failed", error: "no_gpu", log: "no usable GPU found" })).toBe(
      "no_gpu",
    );
  });

  it("notices when RedGiant.exe is not there to run it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-win-"));
    const err = await new WinEngine({ dir, host: "h", pollMs: 10, noticeMs: 100 })
      .start("m.gguf")
      .catch((e: unknown) => e as { code?: string });
    expect((err as { code?: string }).code).toBe("launcher_missing");
  });

  it("moves the models to another SSD, following the launcher's progress (2026-11-03)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-win-"));
    let stop = false;
    let asked: { kind?: string; to?: string } = {};
    void (async () => {
      while (!stop) {
        const raw = await readFile(join(dir, "move.json"), "utf8").catch(() => "");
        if (raw) {
          const r = JSON.parse(raw) as { id: string; kind: string; to: string };
          asked = r;
          for (const done of [4, 8]) {
            await writeFile(
              join(dir, "move-status.json"),
              JSON.stringify({ id: r.id, state: "moving", done, total: 8 }),
            );
            await new Promise((ok) => setTimeout(ok, 40));
          }
          await writeFile(
            join(dir, "move-status.json"),
            JSON.stringify({ id: r.id, state: "done", done: 8, total: 8 }),
          );
          return;
        }
        await new Promise((ok) => setTimeout(ok, 15));
      }
    })();
    const engine = new WinEngine({ dir, host: "172.28.0.1", pollMs: 10 });
    const jobs = new Jobs();
    const job = jobs.start("me", "models_move", ["move"], async (h) => {
      h.step("move");
      await engine.move("models", "D:\\RedGiant\\models", h);
    });
    const end = await jobs.settled(job.id);
    stop = true;
    expect(end?.state).toBe("done");
    expect(asked).toMatchObject({ kind: "models", to: "D:\\RedGiant\\models" });
  });

  it("is what the wizard suggests on Windows for AMD, Intel and built-in GPUs", async () => {
    const h = (gpus: string) =>
      detectHardware({
        dataDir: "/tmp",
        gpus: async () => [],
        hostGpus: gpus,
        windowsEngine: true,
      }).then((x) => x.suggestion);
    expect(await h("AMD Radeon RX 7800 XT:16")).toEqual({
      engine: "windows",
      maxModelGb: 12.8,
      kind: "gpu",
      vramGb: 16,
    });
    expect(await h("Intel(R) Arc(TM) B580 Graphics:12")).toMatchObject({
      engine: "windows",
      vramGb: 12,
    });
    expect(await h("Intel(R) UHD Graphics 770:0")).toMatchObject({
      engine: "windows",
      kind: "igpu",
    });
    // NVIDIA with Docker's runtime stays on CUDA.
    const cuda = await detectHardware({
      dataDir: "/tmp",
      gpus: async () => [],
      hostGpus: "NVIDIA GeForce RTX 4080 SUPER:16",
      windowsEngine: true,
      dockerRuntimes: async () => ["nvidia"],
    });
    expect(cuda.suggestion.engine).toBe("cuda");
  });
});

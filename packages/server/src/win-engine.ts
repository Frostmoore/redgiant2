// The engine that runs on Windows itself (G24.3b). Inside WSL, AMD and Intel GPUs cannot be
// reached reliably; on Windows their drivers work. So RedGiant.exe (the Windows launcher) runs
// llama.cpp's official Vulkan build next to RedGiant, and the server drives it through two files
// in a folder both see (%LOCALAPPDATA%\RedGiant\engine, mounted at /winengine):
//
//   engine.json         what the server wants: { id, model | null, build, ctx, parallel }
//   engine-status.json  what the launcher is doing: { id, state, done, total, port, error, log }
//
// The models live in that folder too, so the engine reads them at the disk's full speed.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { debugLog } from "./debug-log.js";
import { engineError } from "./engine-errors.js";
import { JobFailure, type JobHandle } from "./jobs.js";
import { speculativeArgs } from "./stream.js";

/** llama.cpp's release the launcher downloads (`llama-<build>-bin-win-vulkan-x64.zip`). */
export const WIN_ENGINE_BUILD = "b12034";

export interface WinEngineRequest {
  id: string;
  /** The model file in `models/`; null stops the engine. */
  model: string | null;
  build: string;
  ctx: number;
  parallel: number;
  /** Extra flags for llama-server (SSD stream), and whether llama.cpp fits the layers itself. */
  args?: string;
  fit?: "1";
  /** Read the whole model once before starting, into Windows' cache (2026-11-04). */
  preload?: "1";
  /** The small model of speculative decoding: a file name in `models/` (2026-11-04). */
  draft?: string;
}

export interface WinEngineStatus {
  id: string;
  state: "downloading" | "starting" | "preloading" | "loading" | "ready" | "failed" | "stopped";
  /** Bytes of the engine's download, or of the model read once (`preloading`). */
  done?: number;
  total?: number;
  /** Where the engine listens on Windows, once ready. */
  port?: number;
  /** A code when the launcher knows why (`download`, `no_gpu`…). */
  error?: string;
  /** The engine's last lines, for whoever helps. */
  log?: string;
}

export interface WinEngineOptions {
  /** The shared folder, as this server sees it. */
  dir: string;
  /** Windows as seen from WSL (its address on WSL's network). */
  host: string;
  pollMs?: number;
  /** How long the launcher may take to notice a request before it is considered missing. */
  noticeMs?: number;
  /** How long a model may take to load. */
  loadMs?: number;
}

export class WinEngine {
  constructor(private readonly o: WinEngineOptions) {}

  /** The shared folder, where the launcher also says how much memory Windows has free. */
  get dir(): string {
    return this.o.dir;
  }

  get modelsDir(): string {
    return join(this.o.dir, "models");
  }

  get kvDir(): string {
    return join(this.o.dir, "kv");
  }

  private async request(
    model: string | null,
    plan?: { ctx: number; args: string[]; fit: boolean },
    preload = false,
    spec: { speculative?: "draft" | "ngram" | undefined; draft?: string | undefined } = {},
  ): Promise<string> {
    const r: WinEngineRequest = {
      id: randomUUID(),
      model,
      build: WIN_ENGINE_BUILD,
      // One pool for every slot (--kv-unified): each conversation can use all of it.
      ctx: plan?.ctx ?? 65536,
      parallel: 4,
      // Each conversation may use the whole pool (llama.cpp gives a slot a quarter otherwise).
      // The draft model's path is the launcher's to write (it accepts only plain words here).
      args: [
        ...(plan?.args ?? []),
        "--kv-unified-per-slot",
        String(plan?.ctx ?? 65536),
        ...(spec.speculative === "ngram" ? speculativeArgs("ngram", undefined) : []),
      ].join(" "),
      // Always fitted by llama.cpp to the card's free memory (no --n-gpu-layers 999).
      fit: "1" as const,
      ...(preload && { preload: "1" as const }),
      ...(spec.speculative === "draft" && spec.draft && { draft: spec.draft }),
    };
    await mkdir(this.o.dir, { recursive: true });
    const file = join(this.o.dir, "engine.json");
    // Written whole and then renamed: the launcher never reads half a request.
    await writeFile(`${file}.tmp`, JSON.stringify(r));
    await rename(`${file}.tmp`, file);
    return r.id;
  }

  async status(): Promise<WinEngineStatus | undefined> {
    return readFile(join(this.o.dir, "engine-status.json"), "utf8")
      .then((t) => JSON.parse(t) as WinEngineStatus)
      .catch(() => undefined);
  }

  async stop(): Promise<void> {
    await this.request(null);
  }

  /**
   * Asks the launcher to run this model and follows it: the engine's download (`image`), its
   * start (`start`) and the model loading (`load`). Returns the engine's address.
   */
  /**
   * Moves the models (2026-11-03): `models` the Windows engine's folder to `to`, `distro` the
   * whole distribution (RedGiant stops and starts again: nobody follows that here). The launcher
   * does it and reports in move-status.json.
   */
  async move(kind: "models" | "distro", to: string, h?: JobHandle): Promise<void> {
    const id = randomUUID();
    await mkdir(this.o.dir, { recursive: true });
    const file = join(this.o.dir, "move.json");
    await writeFile(`${file}.tmp`, JSON.stringify({ id, kind, to }));
    await rename(`${file}.tmp`, file);
    if (kind === "distro") return;
    const asked = Date.now();
    for (;;) {
      if (h?.signal.aborted) throw new Error("cancelled");
      const s = await readFile(join(this.o.dir, "move-status.json"), "utf8")
        .then(
          (x) =>
            JSON.parse(x) as {
              id: string;
              state: string;
              done: number;
              total: number;
              error?: string;
            },
        )
        .catch(() => undefined);
      if (s?.id === id) {
        if (s.state === "moving") h?.progress(s.done, s.total || null);
        if (s.state === "done") return;
        if (s.state === "failed") throw new JobFailure("move_failed", s.error ?? "The move failed");
      } else if (Date.now() - asked > (this.o.noticeMs ?? 60_000)) {
        throw new JobFailure(
          "launcher_missing",
          "RedGiant's Windows program did not pick up the request: is RedGiant open next to the clock?",
        );
      }
      await new Promise((r) => setTimeout(r, this.o.pollMs ?? 1000));
    }
  }

  /**
   * «Look for updates» (2026-11-04): RedGiant.exe looks now and, with a newer version, asks
   * the person on the desktop as every morning. Its answer, or null when it did not pick it up.
   */
  async checkUpdate(): Promise<{ state: string; version: string } | null> {
    const id = randomUUID();
    await mkdir(this.o.dir, { recursive: true });
    const file = join(this.o.dir, "update.json");
    await writeFile(`${file}.tmp`, JSON.stringify({ id }));
    await rename(`${file}.tmp`, file);
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const s = await readFile(join(this.o.dir, "update-status.json"), "utf8")
        .then((x) => JSON.parse(x) as { id: string; state: string; version: string })
        .catch(() => undefined);
      if (s?.id === id) return { state: s.state, version: s.version };
      await new Promise((r) => setTimeout(r, this.o.pollMs ?? 1000));
    }
    return null;
  }

  async start(
    model: string,
    h?: JobHandle,
    plan?: { ctx: number; args: string[]; fit: boolean },
    preload = false,
    spec: { speculative?: "draft" | "ngram" | undefined; draft?: string | undefined } = {},
  ): Promise<string> {
    if (!this.o.host)
      throw new JobFailure(
        "launcher_missing",
        "RedGiant does not know Windows' address on WSL's network: start RedGiant again from its icon",
      );
    const id = await this.request(model, plan, preload, spec);
    const poll = this.o.pollMs ?? 1000;
    const asked = Date.now();
    let seen = false;
    let lastState = "";
    debugLog.write("engine", "Windows engine asked", { model, plan: plan ?? null, preload, spec });
    for (;;) {
      if (h?.signal.aborted) {
        await this.stop();
        throw new Error("cancelled");
      }
      const s = await this.status();
      if (s?.id === id) {
        seen = true;
        if (s.state !== lastState) {
          debugLog.write("engine", `Windows engine ${s.state}`, {
            msSinceAsked: Date.now() - asked,
          });
          lastState = s.state;
        }
        if (s.state === "downloading") {
          h?.step("image");
          if (s.done !== undefined) h?.progress(s.done, s.total ?? null);
        } else if (s.state === "preloading") {
          h?.step("preload");
          if (s.done !== undefined) h?.progress(s.done, s.total ?? null);
        } else if (s.state === "starting") h?.step("start");
        else if (s.state === "loading") h?.step("load");
        else if (s.state === "ready" && s.port) return `http://${this.o.host}:${s.port}`;
        else if (s.state === "failed" || s.state === "stopped") {
          const log = `${s.error ?? ""}\n${s.log ?? ""}`;
          throw new JobFailure(
            s.error === "download"
              ? "image_download"
              : (engineError(log) ?? s.error ?? "engine_stopped"),
            log.trim().slice(-1500),
          );
        }
      } else if (!seen && Date.now() - asked > (this.o.noticeMs ?? 60_000)) {
        throw new JobFailure(
          "launcher_missing",
          "RedGiant's Windows program did not pick up the request: is RedGiant open next to the clock?",
        );
      }
      if (Date.now() - asked > (this.o.loadMs ?? 20 * 60_000))
        throw new JobFailure("load_timeout", "The model did not load within 20 minutes");
      await new Promise((r) => setTimeout(r, poll));
    }
  }
}

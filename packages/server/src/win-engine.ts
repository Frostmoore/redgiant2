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
import { engineError } from "./engine-errors.js";
import { JobFailure, type JobHandle } from "./jobs.js";

/** llama.cpp's release the launcher downloads (`llama-<build>-bin-win-vulkan-x64.zip`). */
export const WIN_ENGINE_BUILD = "b12034";

export interface WinEngineRequest {
  id: string;
  /** The model file in `models/`; null stops the engine. */
  model: string | null;
  build: string;
  ctx: number;
  parallel: number;
}

export interface WinEngineStatus {
  id: string;
  state: "downloading" | "starting" | "loading" | "ready" | "failed" | "stopped";
  /** Bytes of the engine's download, while downloading. */
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

  get modelsDir(): string {
    return join(this.o.dir, "models");
  }

  get kvDir(): string {
    return join(this.o.dir, "kv");
  }

  private async request(model: string | null): Promise<string> {
    const r: WinEngineRequest = {
      id: randomUUID(),
      model,
      build: WIN_ENGINE_BUILD,
      // One pool for every slot (--kv-unified): each conversation can use all of it.
      ctx: 65536,
      parallel: 4,
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
  async start(model: string, h?: JobHandle): Promise<string> {
    const id = await this.request(model);
    const poll = this.o.pollMs ?? 1000;
    const asked = Date.now();
    let seen = false;
    for (;;) {
      if (h?.signal.aborted) {
        await this.stop();
        throw new Error("cancelled");
      }
      const s = await this.status();
      if (s?.id === id) {
        seen = true;
        if (s.state === "downloading") {
          h?.step("image");
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

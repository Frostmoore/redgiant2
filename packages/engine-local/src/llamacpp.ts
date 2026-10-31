/** The llama.cpp server endpoints RedGiant uses beyond chat completions. */
export interface EngineProps {
  modelPath: string;
  slots: number;
  ctxPerSlot: number;
  build: string;
}

export class EngineError extends Error {}

export class LlamaCppEngine {
  constructor(
    readonly baseURL: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  private url(path: string) {
    return `${this.baseURL.replace(/\/v1\/?$/, "").replace(/\/$/, "")}${path}`;
  }

  async props(): Promise<EngineProps> {
    const r = await this.fetchImpl(this.url("/props"));
    if (!r.ok) throw new EngineError(`llama.cpp /props: HTTP ${r.status}`);
    const p = (await r.json()) as {
      model_path?: string;
      total_slots?: number;
      build_info?: string;
      default_generation_settings?: { n_ctx?: number };
    };
    return {
      modelPath: p.model_path ?? "unknown",
      slots: p.total_slots ?? 1,
      ctxPerSlot: p.default_generation_settings?.n_ctx ?? 4096,
      build: p.build_info ?? "unknown",
    };
  }

  private async slotAction(slot: number, action: "save" | "restore" | "erase", filename?: string) {
    const r = await this.fetchImpl(this.url(`/slots/${slot}?action=${action}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(filename ? { filename } : {}),
    });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok)
      throw new EngineError(
        `llama.cpp slot ${action}: HTTP ${r.status} ${JSON.stringify(body).slice(0, 300)}`,
      );
    return body;
  }

  /** Writes the slot's KV cache to `--slot-save-path/<filename>`. */
  async save(
    slot: number,
    filename: string,
  ): Promise<{ tokens: number; bytes: number; ms: number }> {
    const b = (await this.slotAction(slot, "save", filename)) as {
      n_saved?: number;
      n_written?: number;
      timings?: { save_ms?: number };
    };
    return { tokens: b.n_saved ?? 0, bytes: b.n_written ?? 0, ms: b.timings?.save_ms ?? 0 };
  }

  async restore(slot: number, filename: string): Promise<{ tokens: number; ms: number }> {
    const b = (await this.slotAction(slot, "restore", filename)) as {
      n_restored?: number;
      timings?: { restore_ms?: number };
    };
    return { tokens: b.n_restored ?? 0, ms: b.timings?.restore_ms ?? 0 };
  }

  async erase(slot: number): Promise<void> {
    await this.slotAction(slot, "erase");
  }
}

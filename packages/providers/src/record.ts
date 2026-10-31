import type { CompletionRequest, ModelInfo, Provider, StreamEvent } from "./types.js";

/** One recorded request: what was asked and every event that came back. */
export interface Recording {
  provider: string;
  model: string;
  events: StreamEvent[];
}

/** Wraps a provider and records each request's stream (e.g. to a JSONL file). */
export class RecordingProvider implements Provider {
  readonly id: string;

  constructor(
    private readonly inner: Provider,
    private readonly onRecord: (r: Recording) => void,
  ) {
    this.id = inner.id;
  }

  modelInfo(model: string): ModelInfo {
    return this.inner.modelInfo(model);
  }

  async *stream(request: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const events: StreamEvent[] = [];
    try {
      for await (const e of this.inner.stream(request, signal)) {
        events.push(e);
        yield e;
      }
    } finally {
      this.onRecord({ provider: this.id, model: request.model, events: structuredClone(events) });
    }
  }
}

/**
 * Plays recordings back in order, without any model. A request for a different model than
 * the recorded one fails: the replay must follow the same path as the original run.
 */
export class ReplayProvider implements Provider {
  private next = 0;

  constructor(
    readonly id: string,
    private readonly recordings: Recording[],
    private readonly info: (model: string) => ModelInfo = (model) => ({
      id: model,
      contextWindow: 8192,
      maxOutputTokens: 4096,
      supportsEffort: true,
    }),
  ) {}

  modelInfo(model: string): ModelInfo {
    return this.info(model);
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const r = this.recordings[this.next++];
    if (!r) throw new Error(`ReplayProvider: no recording for request #${this.next - 1}`);
    if (r.model !== request.model) {
      throw new Error(`ReplayProvider: expected model "${r.model}", got "${request.model}"`);
    }
    for (const e of r.events) yield structuredClone(e);
  }
}

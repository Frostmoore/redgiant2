import { MetricsClock } from "./metrics.js";
import {
  type AssistantPart,
  type CompletionRequest,
  type ModelInfo,
  type Provider,
  ProviderError,
  type StopReason,
  type StreamEvent,
  type Usage,
} from "./types.js";

/** One scripted model turn. */
export interface FakeTurn {
  thinking?: string;
  text?: string;
  toolCalls?: { name: string; input: unknown; callId?: string }[];
  stopReason?: StopReason;
  usage?: Partial<Usage>;
  /** Throw this instead of answering (e.g. a retriable 529). */
  error?: ProviderError;
}

export type FakeScript = FakeTurn[] | ((request: CompletionRequest, index: number) => FakeTurn);

export interface FakeProviderOptions {
  id?: string;
  contextWindow?: number;
  now?: () => number;
  /** Awaited between streamed chunks; lets tests abort mid-stream. */
  tick?: () => Promise<void>;
}

/**
 * Deterministic provider driven by a script. Tests must use this (or recorded HTTP fixtures)
 * and never a real model. Every request is kept in `requests` for assertions.
 */
export class FakeProvider implements Provider {
  readonly id: string;
  readonly requests: CompletionRequest[] = [];
  private readonly contextWindow: number;

  constructor(
    private readonly script: FakeScript,
    private readonly options: FakeProviderOptions = {},
  ) {
    this.id = options.id ?? "fake";
    this.contextWindow = options.contextWindow ?? 8192;
  }

  modelInfo(model: string): ModelInfo {
    return {
      id: model,
      contextWindow: this.contextWindow,
      maxOutputTokens: 4096,
      supportsEffort: true,
    };
  }

  async *stream(request: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const index = this.requests.length;
    this.requests.push(structuredClone(request));
    const turn = Array.isArray(this.script) ? this.script[index] : this.script(request, index);
    if (!turn) throw new Error(`FakeProvider: no scripted turn for request #${index}`);
    if (turn.error) throw turn.error;

    const clock = new MetricsClock(this.options.now);
    const parts: AssistantPart[] = [];
    let aborted = false;

    const chunks = async function* (
      text: string,
      tick: (() => Promise<void>) | undefined,
    ): AsyncGenerator<string> {
      for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
        if (tick) await tick();
        if (signal?.aborted) return;
        yield piece;
      }
    };

    if (turn.thinking) {
      for await (const piece of chunks(turn.thinking, this.options.tick)) {
        clock.token();
        yield { type: "thinking_delta", text: piece };
      }
      parts.push({ type: "thinking", text: turn.thinking });
    }
    if (turn.text) {
      let emitted = "";
      for await (const piece of chunks(turn.text, this.options.tick)) {
        clock.token();
        emitted += piece;
        yield { type: "text_delta", text: piece };
      }
      aborted = signal?.aborted ?? false;
      if (emitted) parts.push({ type: "text", text: emitted });
    }
    if (!aborted) {
      for (const [i, call] of (turn.toolCalls ?? []).entries()) {
        const callId = call.callId ?? `call_${index}_${i}`;
        const rawInput = JSON.stringify(call.input);
        clock.token();
        parts.push({ type: "tool_call", callId, name: call.name, input: call.input, rawInput });
        yield { type: "tool_call", callId, name: call.name, input: call.input, rawInput };
      }
    }

    const promptChars =
      request.system.length +
      JSON.stringify(request.messages).length +
      JSON.stringify(request.tools).length;
    const usage: Usage = {
      inputTokens: Math.ceil(promptChars / 4),
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: Math.ceil(((turn.thinking ?? "").length + (turn.text ?? "").length) / 4),
      ...turn.usage,
    };
    const stopReason: StopReason = aborted
      ? "aborted"
      : (turn.stopReason ?? (turn.toolCalls?.length ? "tool_use" : "end_turn"));
    yield {
      type: "done",
      completion: {
        message: { role: "assistant", parts },
        stopReason,
        usage,
        metrics: clock.finish(usage, this.contextWindow),
        model: request.model,
        provider: this.id,
      },
    };
  }
}

export { ProviderError };

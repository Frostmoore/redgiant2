import type {
  AssistantPart,
  ImagePart,
  MessageMetrics,
  ModelSpec,
  StopReason,
} from "@redgiant/protocol";
import type { StreamEvent, ToolDef } from "@redgiant/providers";

/** One of RedGiant's tools run for the engine: validated, permitted, hooked and logged as usual. */
export type RunTool = (call: {
  callId: string;
  name: string;
  input: unknown;
}) => Promise<{ content: string; isError: boolean }>;

export interface EngineTurn {
  text: string;
  images: ImagePart[];
  system: string;
  tools: ToolDef[];
  model: ModelSpec;
  /** The engine's own conversation id from an earlier turn: the turn continues it. */
  resume: string | undefined;
  signal?: AbortSignal | undefined;
  runTool: RunTool;
  /** An assistant message as the engine produced it: recorded at once, before its tools run. */
  onMessage(m: {
    parts: AssistantPart[];
    metrics: MessageMetrics;
    stopReason: StopReason;
    model: string;
  }): Promise<void>;
  live?: ((e: StreamEvent) => void) | undefined;
  /** The engine summarised its own conversation (shown in the chat; RedGiant's history stays). */
  onCompaction?: ((info: { trigger: string; preTokens?: number | undefined }) => void) | undefined;
}

/**
 * A model that runs its own loop (a flat subscription through the vendor's agent, G21): the
 * conversation lives in the engine, the tools stay RedGiant's. The engine compacts its own
 * context; RedGiant only records what happens.
 */
export interface Engine {
  readonly id: string;
  turn(t: EngineTurn): Promise<{ resume: string; stopReason: StopReason }>;
}

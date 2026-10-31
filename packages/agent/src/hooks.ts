import type { ChatMessage } from "@redgiant/protocol";
import type { Completion } from "@redgiant/providers";
import type { ToolContext } from "./tools.js";

export interface ToolCallInfo {
  callId: string;
  name: string;
  input: unknown;
}

export type PreToolUseResult =
  | { action: "allow" }
  | { action: "block"; reason: string }
  | { action: "modify"; input: unknown };

/**
 * Programmatic hooks, in the spirit of Claude Code's. Each list runs in order; for
 * PreToolUse the first `block` wins and `modify` results chain.
 */
export interface Hooks {
  sessionStart?: ((ctx: ToolContext) => Promise<void> | void)[];
  preToolUse?: ((
    call: ToolCallInfo,
    ctx: ToolContext,
  ) => Promise<PreToolUseResult> | PreToolUseResult)[];
  postToolUse?: ((
    call: ToolCallInfo,
    result: { content: string; isError: boolean },
    ctx: ToolContext,
  ) =>
    | Promise<{ content: string; isError: boolean } | undefined>
    | { content: string; isError: boolean }
    | undefined)[];
  /** Return extra instructions for the summary, or `false` to postpone compaction. */
  preCompact?: ((
    messages: ChatMessage[],
    ctx: ToolContext,
  ) => Promise<string | false | undefined> | string | false | undefined)[];
  /**
   * Runs when the model ends its turn. Return a message to make it continue (e.g. "the
   * verifier failed, fix it"); `undefined` lets it stop.
   */
  stop?: ((
    completion: Completion,
    ctx: ToolContext,
  ) => Promise<string | undefined> | string | undefined)[];
}

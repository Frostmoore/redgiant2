import type { Tool } from "@redgiant/agent";
import { z } from "zod";
import { describe, type ModelProfile } from "./profiles.js";
import { truncateMiddle } from "./text.js";
import type { Workspace } from "./workspace.js";

const BashInput = z.object({
  command: z.string().min(1),
  timeout_ms: z.number().int().min(1000).max(600_000).optional(),
});

export function bashTool(
  ws: Workspace,
  profile: ModelProfile,
  maxOutputChars = 30_000,
): Tool<z.infer<typeof BashInput>> {
  return {
    def: {
      name: "bash",
      description: describe(profile, {
        full:
          "Run a shell command in the workspace root and return exit code, stdout and stderr. " +
          "Default timeout 120 s (max 600 s). Long output keeps its beginning and end.",
        compact: "Run a shell command in the workspace.",
      }),
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" }, timeout_ms: { type: "integer" } },
        required: ["command"],
      },
    },
    schema: BashInput,
    async run({ command, timeout_ms = 120_000 }, ctx) {
      const r = await ws.exec(command, { timeoutMs: timeout_ms, signal: ctx.signal });
      const parts = [r.timedOut ? `Timed out after ${timeout_ms} ms.` : `Exit code: ${r.exitCode}`];
      if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
      if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
      return {
        content: truncateMiddle(parts.join("\n"), maxOutputChars),
        isError: r.timedOut || r.exitCode !== 0,
      };
    },
  };
}

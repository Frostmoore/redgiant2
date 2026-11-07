import type { Tool } from "@redgiant/agent";
import { z } from "zod";
import type { BackgroundCommands } from "./background.js";
import { describe, type ModelProfile } from "./profiles.js";
import { truncateMiddle } from "./text.js";
import type { Workspace } from "./workspace.js";

const BashInput = z.object({
  command: z.string().min(1),
  timeout_ms: z.number().int().min(1000).max(600_000).optional(),
  background: z.boolean().optional(),
});

export function bashTool(
  ws: Workspace,
  profile: ModelProfile,
  maxOutputChars = 30_000,
  bg?: BackgroundCommands,
): Tool<z.infer<typeof BashInput>> {
  return {
    def: {
      name: "bash",
      description: describe(profile, {
        full:
          "Run a shell command in the workspace root and return exit code, stdout and stderr. " +
          "Default timeout 120 s (max 600 s). Long output keeps its beginning and end. " +
          "background: true for servers, watchers, long builds: returns an id at once; read it with bash_output. Keep commands verbose (no -q/--silent, no >/dev/null): every line is logged with its time. " +
          "Run on this computer (not in a container), RedGiant's own ffmpeg, and Blender, LibreOffice and Scribus once downloaded, are on the PATH; ffmpeg's drawtext needs fontfile=.",
        compact:
          "Run a shell command in the workspace. background: true returns an id (bash_output); keep it verbose.",
      }),
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "integer" },
          background: { type: "boolean" },
        },
        required: ["command"],
      },
    },
    schema: BashInput,
    async run({ command, timeout_ms = 120_000, background }, ctx) {
      if (background) {
        if (!bg) return { content: "Background commands are not available here.", isError: true };
        try {
          const c = await bg.start(ws, command, ctx);
          return [
            `Started in the background as ${c.id} (at ${c.startedAt}, in ${c.cwd}).`,
            `Every line of its output is logged with its time and stream in ${c.path}.`,
            `Read it with bash_output {"id": "${c.id}"} (new lines), wait for a text with wait_for, stop it with stop: true.`,
            "Keep it verbose: a quiet command (-q, --silent, output thrown away) cannot be checked.",
          ].join("\n");
        } catch (err) {
          return { content: (err as Error).message, isError: true };
        }
      }
      const r = await ws.exec(command, { timeoutMs: timeout_ms, signal: ctx.signal });
      const parts = [r.timedOut ? `Timed out after ${timeout_ms} ms.` : `Exit code: ${r.exitCode}`];
      if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
      if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
      const hint = r.exitCode !== 0 ? ffmpegHint(command, `${r.stdout}\n${r.stderr}`) : undefined;
      if (hint) parts.push(hint);
      return {
        content: truncateMiddle(parts.join("\n"), maxOutputChars),
        isError: r.timedOut || r.exitCode !== 0,
      };
    },
  };
}

/** Where a font file is on each system, for ffmpeg's drawtext. */
export const DRAWTEXT_FONTS =
  "Windows: fontfile='C\\:/Windows/Fonts/arial.ttf' (the colon escaped); macOS: fontfile=/System/Library/Fonts/Supplemental/Arial.ttf; Linux: fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

/**
 * A line for a failed ffmpeg command (p3.3.1, the agent who tried 3.3.0 on Windows): drawtext
 * without a font file crashes the static builds (they carry no font configuration), and a
 * system ffmpeg behind a WinGet link may refuse to start.
 */
export function ffmpegHint(command: string, output: string): string | undefined {
  if (!/\bffmpeg\b/.test(command)) return undefined;
  if (/drawtext/.test(command) && !/fontfile\s*=/.test(command))
    return `Hint: ffmpeg's drawtext needs a font file here (there is no font configuration): add ${DRAWTEXT_FONTS}.`;
  if (/permission denied|cannot execute|attendibile|untrusted mount point/i.test(output))
    return "Hint: RedGiant's own ffmpeg is the first on your PATH (command -v ffmpeg): call it as plain ffmpeg, not through a WinGet link or another path.";
  return undefined;
}

import type { Tool } from "@redgiant/agent";
import { z } from "zod";
import type { BackgroundCommands } from "./background.js";
import { diskWideSearch } from "./disk-wide.js";
import { describe, type ModelProfile } from "./profiles.js";
import { SubprojectWorkspace } from "./scoped.js";
import { truncateMiddle } from "./text.js";
import { shellPath, type Workspace } from "./workspace.js";

const BashInput = z.object({
  command: z.string().min(1),
  // The ceiling is the person's (G36.16, Settings > Commands): a longer wait is cut to it.
  timeout_ms: z.number().int().min(1000).optional(),
  background: z.boolean().optional(),
});

export function bashTool(
  ws: Workspace,
  profile: ModelProfile,
  maxOutputChars = 30_000,
  bg?: BackgroundCommands,
  /** The longest wait for an owner (default 600 s); fixed text in the description either way. */
  maxMs: (ownerId: string) => number = () => DEFAULT_BASH_MAX_MS,
  /**
   * Commands run on this computer, not in a container (p3.4.0): a walk of a whole disk
   * (`diskWideSearch`) is answered at once instead of run.
   */
  host = false,
): Tool<z.infer<typeof BashInput>> {
  return {
    def: {
      name: "bash",
      description: describe(profile, {
        full:
          "Run a shell command in the workspace root and return exit code, stdout and stderr. " +
          "Every call is a new shell that starts in the workspace root: cd and variables (also $OLDPWD) do not carry over. " +
          "Stay in the project: never search a whole disk (find /, ls -R /, grep -r /, Get-ChildItem C:\\ -Recurse); use glob and grep, or a narrow folder you know. " +
          "Default timeout 120 s; a longer timeout_ms is cut to the person's maximum (10 min unless they changed it). Long output keeps its beginning and end. " +
          "background: true for servers, watchers, long builds: returns an id at once; read it with bash_output. Keep commands verbose (no -q/--silent, no >/dev/null): every line is logged with its time. " +
          "Run on this computer (not in a container), RedGiant's own ffmpeg, and Blender, LibreOffice and Scribus once downloaded, are on the PATH; ffmpeg's drawtext needs fontfile=.",
        compact:
          "Run a shell command in the workspace root (a new shell each call). Never search a whole disk (find /). background: true returns an id (bash_output); keep it verbose.",
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
      if (host && diskWideSearch(command)) return { content: diskWideRefusal(ws), isError: true };
      // Always a real limit: a missing or broken setting falls back to the default.
      const chosen = maxMs(ctx.ownerId);
      const ceiling = Number.isFinite(chosen) && chosen > 0 ? chosen : DEFAULT_BASH_MAX_MS;
      const wait = Math.min(timeout_ms, ceiling);
      const r = await ws.exec(command, { timeoutMs: wait, signal: ctx.signal });
      const parts = [r.timedOut ? `Timed out after ${wait} ms.` : `Exit code: ${r.exitCode}`];
      if (wait < timeout_ms)
        parts.push(
          `(timeout_ms was cut to ${Math.round(ceiling / 1000)} s, the person's maximum: use background: true for longer work.)`,
        );
      if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
      if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
      const output = `${r.stdout}\n${r.stderr}`;
      const hint =
        r.exitCode !== 0 ? (ffmpegHint(command, output) ?? cmdHint(command, output)) : undefined;
      if (hint) parts.push(hint);
      return {
        content: truncateMiddle(parts.join("\n"), maxOutputChars),
        isError: r.timedOut || r.exitCode !== 0,
      };
    },
  };
}

/** The answer to a command that would walk a whole disk (p3.4.0): where the project is instead. */
export function diskWideRefusal(ws: Workspace): string {
  return [
    "Not run: this command searches a whole disk (find /, ls -R /, grep -r /, Get-ChildItem C:\\ -Recurse…). On this computer that takes many minutes and finds other projects' files.",
    `Your project is ${shellPath(startFolder(ws))} and every command starts there (a new shell each call, so name this folder in full when you need it again).`,
    'Search the project with glob and grep, or a narrow folder you know (/usr/include, "/c/Program Files"…); a find from the root with -maxdepth 3 or less runs.',
  ].join("\n");
}

/** Where an agent's commands start: the root, or its own subfolder in a subproject (G24.13). */
export function startFolder(ws: Workspace): string {
  if (!(ws instanceof SubprojectWorkspace) || !ws.own) return ws.root;
  const sep = ws.root.includes("\\") && !ws.root.includes("/") ? "\\" : "/";
  return `${ws.root.replace(/[\\/]+$/, "")}${sep}${ws.own.replaceAll("/", sep)}`;
}

/**
 * A line for `cmd /c` written in Git's bash (p3.4.0, the benchmark): the bash turns `/c` into
 * `C:/`, so cmd.exe opens interactively (its banner is the output) instead of running the command.
 */
export function cmdHint(command: string, output: string): string | undefined {
  if (!/\bcmd(\.exe)?\s+\/[cCkK]\b/.test(command) || !/Microsoft Windows \[/.test(output))
    return undefined;
  return 'Hint: Git\'s bash turns /c into a path (C:/), so cmd.exe opened interactively instead of running your command: write cmd //c "…" (or put the commands in a .bat file and run cmd //c file.bat).';
}

/** The longest an ordinary bash call waits unless the person chose otherwise. */
export const DEFAULT_BASH_MAX_MS = 600_000;

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

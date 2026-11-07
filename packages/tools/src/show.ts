// show_file (G34.1): an agent opens a file in the person's canvas, next to the chat. The file is
// one the agent can read: inside its workspace through the workspace's own checks (links,
// hidden subprojects), outside it only because the guardian let the call through (the policy
// asks the person first, unless they chose "let it be"). The tool reads nothing itself: the
// host records what is shown (an event: the page opens it, and opens it again after a reload).
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { Tool, ToolContext } from "@redgiant/agent";
import { z } from "zod";
import { describe, type ModelProfile } from "./profiles.js";
import { PathOutsideWorkspaceError, type Workspace } from "./workspace.js";

/** What the host is asked to show: a file on disk, already checked. */
export interface ShowFileRequest {
  /** The real path on disk (links followed). */
  abs: string;
  /** As the agent gave it. */
  path: string;
  /** Outside the agent's workspace: reached only through the guardian. */
  outside: boolean;
  title: string;
  size: number;
}

/**
 * Records what is shown (the server appends a `canvas.show` event); returns what the person
 * sees there (viewer, conversion, preview), added to the tool's answer.
 */
export type ShowFileHost = (req: ShowFileRequest, ctx: ToolContext) => Promise<string | undefined>;

const ShowInput = z.object({
  path: z.string().min(1),
  title: z.string().max(120).optional(),
});

const within = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${Math.ceil(n / 1024)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * Every agent has it (the tool set never changes); without a host (a test, a tool list built
 * to look at) it says the canvas is not available.
 */
export function showFileTool(
  ws: Workspace,
  profile: ModelProfile,
  host?: ShowFileHost,
): Tool<z.infer<typeof ShowInput>> {
  return {
    def: {
      name: "show_file",
      description: describe(profile, {
        full:
          "Open a file for the person in the canvas next to the chat, in a viewer for its kind (video, audio, picture, PDF, document, sheet, slides, code, 3D model, archive, font, data tree; anything else to download). " +
          "Use it whenever the person should see a file. A path outside your workspace needs their approval; for a site or a port use show.",
        compact:
          "Open a file for the person in the canvas (any kind: video, PDF, sheet, 3D, code...). Path in your workspace.",
      }),
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file: relative to the workspace root" },
          title: {
            type: "string",
            description: "A short title for its tab (the file's name otherwise)",
          },
        },
        required: ["path"],
      },
    },
    schema: ShowInput,
    async run(i, ctx) {
      const lexical = isAbsolute(i.path) ? resolve(i.path) : resolve(ws.root, i.path);
      const outside = !within(resolve(ws.root), lexical);
      let abs: string;
      if (!outside) {
        // The workspace's own checks first (hidden subprojects, links), then the real path.
        if (!(await ws.isFile(i.path).catch(() => false))) {
          const folder = await ws.exists(i.path).catch(() => false);
          return {
            content: folder
              ? `${i.path} is a folder: show_file opens one file (show opens a folder as a site).`
              : `There is no file "${i.path}" in your workspace.`,
            isError: true,
          };
        }
        abs = await realpath(lexical);
        if (!within(await realpath(ws.root), abs)) throw new PathOutsideWorkspaceError(i.path);
      } else {
        // Reached only through the guardian (checked before the tool runs).
        const real = await realpath(lexical).catch(() => undefined);
        const st = real ? await stat(real).catch(() => undefined) : undefined;
        if (!real || !st?.isFile())
          return { content: `There is no file "${i.path}" on this computer.`, isError: true };
        abs = real;
      }
      const st = await stat(abs);
      const title = i.title?.trim() || basename(abs);
      if (!host)
        return { content: "The canvas is not available in this conversation.", isError: true };
      const said = await host({ abs, path: i.path, outside, title, size: st.size }, ctx);
      // The host adds what the person sees (viewer, conversion, paged preview).
      const opened = `Opened ${title} (${size(st.size)}) in the canvas next to the chat: the person sees it now.`;
      return said ? `${opened}\n${said}` : opened;
    },
  };
}

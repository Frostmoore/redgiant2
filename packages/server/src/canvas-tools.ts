// The canvas seen and moved by the agent (G36.12). The person: «se ci deve lavorare dentro
// ovviamente il canvas lo deve vedere, e ci deve anche poter interagire».
//   canvas_look: what the person has open (tabs, the active one, where they are) and a picture of
//     a tab or of any file of the workspace, at a page, a time, some lines or cells.
//   canvas_act: opens a tab, goes to a page, a line or a time, selects, zooms, plays or pauses;
//     an event the page follows live (the person sees the agent leaf through). Nothing is edited.
// A path outside the agent's folders passes the guardian first (as show_file); a tab the person
// opened outside them is described, never drawn, unless the agent asks for its path.
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { Tool, ToolContext } from "@redgiant/agent";
import type {
  CanvasDo,
  CanvasPlace,
  CanvasState,
  CanvasTabInfo,
  CanvasTargetInfo,
} from "@redgiant/protocol";
import type { Workspace } from "@redgiant/tools";
import { z } from "zod";
import type { LookAsk, Looked } from "./canvas-look.js";
import { MODEL_VIEWS } from "./model-render.js";

type FileTarget = Extract<CanvasTargetInfo, { kind: "file" }>;

export interface CanvasToolsHost {
  /** The person's canvas now (undefined: no page open, or none answered). */
  state(ownerId: string): Promise<CanvasState | undefined>;
  /** A file on disk as the canvas names it: its scope and path (or "outside" and the path). */
  targetOf(ownerId: string, abs: string): Promise<FileTarget>;
  /** The file behind a tab, on disk. */
  fileOf(ownerId: string, target: FileTarget): Promise<string>;
  look(abs: string, ask: LookAsk, ctx: ToolContext): Promise<Looked>;
  /** Records the move (a `canvas.act` event). */
  act(ctx: ToolContext, title: string, target: CanvasTargetInfo, d: CanvasDo): Promise<void>;
  /**
   * The editor's model of a file as words (G37.1, `view: "structure"`) and its revision, which
   * the conversation has now seen; undefined when no editor knows the file's kind.
   */
  structure?(
    ownerId: string,
    abs: string,
    ask: { fromLine?: number | undefined; toLine?: number | undefined },
    ctx: ToolContext,
  ): Promise<string | undefined>;
}

export const within = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** A path the agent gave: in its workspace (its own checks), or outside (the guardian let it). */
export async function fileAt(
  ws: Workspace,
  path: string,
): Promise<{ abs: string; outside: boolean } | { error: string }> {
  const lexical = isAbsolute(path) ? resolve(path) : resolve(ws.root, path);
  if (within(resolve(ws.root), lexical)) {
    if (!(await ws.isFile(path).catch(() => false)))
      return { error: `There is no file "${path}" in your workspace.` };
    const abs = await realpath(lexical);
    if (!within(await realpath(ws.root), abs))
      return { error: `"${path}" leads outside your workspace.` };
    return { abs, outside: false };
  }
  const real = await realpath(lexical).catch(() => undefined);
  const st = real ? await stat(real).catch(() => undefined) : undefined;
  if (!real || !st?.isFile()) return { error: `There is no file "${path}" on this computer.` };
  return { abs: real, outside: true };
}

const clock = (s: number) => {
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}:${r < 10 ? "0" : ""}${r}`;
};

/** Where the person is in a tab, in a few words. */
export function placeText(p: CanvasPlace | undefined): string {
  if (!p) return "";
  const parts: string[] = [];
  if (p.page) parts.push(`page ${p.page}${p.pages ? ` of ${p.pages}` : ""}`);
  if (p.line) parts.push(`line ${p.line}${p.lines ? ` of ${p.lines}` : ""}`);
  if (p.time !== undefined)
    parts.push(
      `${p.playing ? "playing" : "paused"} at ${clock(p.time)}${p.duration ? ` of ${clock(p.duration)}` : ""}`,
    );
  if (p.sheet) parts.push(`sheet «${p.sheet}»`);
  if (p.cells) parts.push(`cells ${p.cells} marked`);
  if (p.zoom) parts.push(`zoom ${Math.round(p.zoom)}%`);
  if (p.selection) parts.push(`selected: «${p.selection.slice(0, 300)}»`);
  return parts.join(", ");
}

const targetText = (t: CanvasTargetInfo) =>
  t.kind === "file" ? t.path : `the site on port ${t.port}${t.path ?? ""}`;

/** The canvas as words: every tab numbered, the active one first in the reader's mind. */
export function stateText(s: CanvasState | undefined): string {
  if (!s) return "The person has no RedGiant page open now: their canvas cannot be seen.";
  if (s.tabs.length === 0) return "The person's canvas is empty (no tab open).";
  const lines = s.tabs.map((tab, i) => {
    const where = placeText(tab.place);
    return `${i + 1}. ${tab.active ? "[active] " : ""}${tab.title} (${tab.kind ?? tab.target.kind}: ${targetText(tab.target)})${where ? `: ${where}` : ""}`;
  });
  return `The person's canvas (${s.visible ? "in view" : "hidden behind the chat"}), ${s.tabs.length} tab${s.tabs.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}

const LookInput = z.object({
  path: z.string().min(1).optional(),
  tab: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(),
  time: z.number().nonnegative().optional(),
  from_line: z.number().int().positive().optional(),
  to_line: z.number().int().positive().optional(),
  cells: z.string().max(40).optional(),
  sheet: z.string().max(200).optional(),
  view: z.enum([...MODEL_VIEWS, "structure"]).optional(),
  width: z.number().int().min(256).max(1600).optional(),
});

const ActInput = z.object({
  path: z.string().min(1).optional(),
  tab: z.number().int().positive().optional(),
  title: z.string().max(120).optional(),
  page: z.number().int().positive().optional(),
  line: z.number().int().positive().optional(),
  to_line: z.number().int().positive().optional(),
  time: z.number().nonnegative().optional(),
  play: z.boolean().optional(),
  zoom: z.union([z.number().min(5).max(800), z.literal("fit")]).optional(),
  find: z.string().min(1).max(200).optional(),
  cells: z.string().max(40).optional(),
  sheet: z.string().max(200).optional(),
});

/** The tab asked for (1-based), or the active one. */
export function tabOf(
  s: CanvasState | undefined,
  n: number | undefined,
): CanvasTabInfo | undefined {
  if (!s) return undefined;
  return n ? s.tabs[n - 1] : (s.tabs.find((t) => t.active) ?? s.tabs.at(-1));
}

export function canvasTools(
  agent: { ownerId: string },
  ws: Workspace,
  host: CanvasToolsHost,
): Tool[] {
  const look: Tool<z.infer<typeof LookInput>> = {
    def: {
      name: "canvas_look",
      description:
        "See the person's canvas: its tabs, where they are (page, time, line, selection, zoom) and a picture of the active tab, another tab, or any file you give (path), at the page, time, lines or cells you ask. view \"structure\": the editor's content and revision instead of a picture (before canvas_edit).",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "A file to look at instead of a tab" },
          tab: { type: "number", description: "A tab's number (the active one otherwise)" },
          page: { type: "number", description: "PDF or document page" },
          time: { type: "number", description: "Video time, seconds" },
          from_line: { type: "number" },
          to_line: { type: "number" },
          cells: { type: "string", description: "Sheet cells, e.g. A1:F30" },
          sheet: { type: "string" },
          view: {
            type: "string",
            enum: [...MODEL_VIEWS, "structure"],
            description: '3D: from where; "structure": the editor\'s content',
          },
          width: { type: "number", description: "Picture's longest side, 256-1600" },
        },
      },
    },
    schema: LookInput,
    async run(i, ctx) {
      const state = await host.state(agent.ownerId);
      const said = stateText(state);
      let abs: string;
      let place: CanvasPlace | undefined;
      if (i.path) {
        const f = await fileAt(ws, i.path);
        if ("error" in f) return { content: `${said}\n\n${f.error}`, isError: true };
        abs = f.abs;
      } else {
        const tab = tabOf(state, i.tab);
        if (!tab)
          return i.tab && state
            ? { content: `${said}\n\nThere is no tab ${i.tab}.`, isError: true }
            : `${said}\n\nNothing to look at: give a path to see a file.`;
        if (tab.target.kind !== "file")
          return `${said}\n\nTab ${tab.title} is a site: no picture here (open it with the browser tools).`;
        const file = await host.fileOf(agent.ownerId, tab.target).catch(() => undefined);
        if (!file) return `${said}\n\nThe file of tab ${tab.title} is not there anymore.`;
        const mine =
          (await realpath(ws.root)
            .then((r) => within(r, file))
            .catch(() => false)) || within(resolve(ws.root), file);
        if (!mine)
          return `${said}\n\nTab ${tab.title} is outside your workspace: to see it, call canvas_look with path "${file}" (the person is asked first).`;
        abs = file;
        place = tab.place;
      }
      // The editor's model (G37.1): words and the revision, no picture.
      if (i.view === "structure") {
        const seen = await host
          .structure?.(
            agent.ownerId,
            abs,
            { fromLine: i.from_line ?? place?.line, toLine: i.to_line },
            ctx,
          )
          .catch((err: unknown) => `It cannot be read by the editor: ${(err as Error).message}.`);
        return seen === undefined
          ? `${said}\n\nThere is no editor for ${basename(abs)} yet: look at it without "view", or read it with read_file.`
          : `${said}\n\n${basename(abs)}: ${seen}`;
      }
      // What was not asked comes from where the person is.
      const ask: LookAsk = {
        page: i.page ?? place?.page,
        time: i.time ?? place?.time,
        fromLine: i.from_line ?? place?.line,
        toLine: i.to_line,
        cells: i.cells ?? place?.cells,
        sheet: i.sheet ?? place?.sheet,
        view: i.view,
        width: i.width,
      };
      try {
        const seen = await host.look(abs, ask, ctx);
        return {
          content: `${said}\n\nLooking at ${i.path ?? basename(abs)}: ${seen.text}`,
          ...(seen.image && {
            images: [
              {
                type: "image" as const,
                mediaType: seen.image.mediaType,
                data: Buffer.from(seen.image.data).toString("base64"),
                name: `${basename(abs)}.${seen.image.mediaType === "image/png" ? "png" : "jpg"}`,
              },
            ],
          }),
        };
      } catch (err) {
        return {
          content: `${said}\n\nCould not look at ${basename(abs)}: ${(err as Error).message}`,
          isError: true,
        };
      }
    },
  };

  const act: Tool<z.infer<typeof ActInput>> = {
    def: {
      name: "canvas_act",
      description:
        "Move the person's canvas while they watch: open a file as a tab (path), go to a page, line or time, select lines or cells, find words, zoom, play or pause. Changes no file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "A file to open (or bring forward)" },
          tab: { type: "number", description: "A tab's number (the active one otherwise)" },
          title: { type: "string" },
          page: { type: "number" },
          line: { type: "number", description: "Line to go to (with to_line: select)" },
          to_line: { type: "number" },
          time: { type: "number", description: "Video or sound time, seconds" },
          play: { type: "boolean", description: "true plays, false pauses" },
          zoom: { description: 'Percent, or "fit"' },
          find: { type: "string", description: "Words to find (PDF)" },
          cells: { type: "string", description: "Cells to mark, e.g. B2:D9" },
          sheet: { type: "string" },
        },
      },
    },
    schema: ActInput,
    async run(i, ctx) {
      const d: CanvasDo = {
        ...(i.page !== undefined && { page: i.page }),
        ...(i.line !== undefined && { line: i.line }),
        ...(i.to_line !== undefined && { toLine: i.to_line }),
        ...(i.time !== undefined && { time: i.time }),
        ...(i.play !== undefined && { play: i.play }),
        ...(i.zoom !== undefined && { zoom: i.zoom }),
        ...(i.find !== undefined && { find: i.find }),
        ...(i.cells !== undefined && { cells: i.cells }),
        ...(i.sheet !== undefined && { sheet: i.sheet }),
      };
      let title: string;
      let target: CanvasTargetInfo;
      if (i.path) {
        const f = await fileAt(ws, i.path);
        if ("error" in f) return { content: f.error, isError: true };
        target = await host.targetOf(agent.ownerId, f.abs);
        title = i.title?.trim() || basename(f.abs);
      } else {
        if (Object.keys(d).length === 0)
          return {
            content: "Say what to do: a path to open, or a page, line, time, zoom…",
            isError: true,
          };
        const state = await host.state(agent.ownerId);
        const tab = tabOf(state, i.tab);
        if (!tab)
          return {
            content: state
              ? i.tab
                ? `There is no tab ${i.tab}.`
                : "The person's canvas is empty: give a path to open."
              : "The person has no RedGiant page open: nothing to move.",
            isError: true,
          };
        target = tab.target;
        title = tab.title;
      }
      await host.act(ctx, title, target, d);
      const what = placeText({
        ...(d.page && { page: d.page }),
        ...(d.line && { line: d.line }),
        ...(d.time !== undefined && { time: d.time, playing: d.play ?? false }),
        ...(d.sheet && { sheet: d.sheet }),
        ...(d.cells && { cells: d.cells }),
        ...(typeof d.zoom === "number" && { zoom: d.zoom }),
      });
      return `Done: the person's canvas shows ${title}${what ? ` (${what})` : ""}${d.toLine ? `, lines ${d.line}-${d.toLine} selected` : ""}${d.find ? `, looking for «${d.find}»` : ""}${d.zoom === "fit" ? ", fitted" : ""}${d.play === true && d.time === undefined ? ", playing" : d.play === false && d.time === undefined ? ", paused" : ""}. canvas_look shows what they see.`;
    },
  };
  return [look as Tool, act as Tool];
}

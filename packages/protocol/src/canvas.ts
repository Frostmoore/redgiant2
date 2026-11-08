// The canvas seen by the agent too (G36.12). The page says what the person has open and where
// they are, only when an agent asks (`canvas.query` → `canvas.state`, no steady traffic); an
// agent moves the canvas with `canvas.act` events (open a tab, go to a page, a line, a time,
// select, zoom, play or pause), and the person watches it leaf through. Nothing here edits a file.
import { z } from "zod";

/** What the canvas shows: a file of a workspace (or one shown from outside), or a port. */
export const CanvasTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    scope: z.string(),
    path: z.string(),
    /** Where to open it (G36.4, a citation): a PDF's page, a text's line. */
    at: z
      .object({
        page: z.number().int().positive().optional(),
        line: z.number().int().positive().optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal("port"),
    agentId: z.string(),
    port: z.number().int(),
    path: z.string().optional(),
  }),
]);
export type CanvasTargetInfo = z.infer<typeof CanvasTargetSchema>;

/** Where the person is inside a tab: whatever its viewer knows. */
export const CanvasPlace = z.object({
  /** A PDF's (or a paged preview's) page, a slide. */
  page: z.number().int().positive().optional(),
  pages: z.number().int().nonnegative().optional(),
  /** A text's first line in view, and its length. */
  line: z.number().int().positive().optional(),
  lines: z.number().int().nonnegative().optional(),
  /** A video's or a sound's time, in seconds. */
  time: z.number().nonnegative().optional(),
  duration: z.number().nonnegative().optional(),
  playing: z.boolean().optional(),
  /** Percent; absent when fitted. */
  zoom: z.number().positive().optional(),
  /** A sheet's name, and the cells marked (A1:C4). */
  sheet: z.string().max(200).optional(),
  cells: z.string().max(40).optional(),
  /** The text the person selected, cut short. */
  selection: z.string().max(2000).optional(),
});
export type CanvasPlace = z.infer<typeof CanvasPlace>;

/** One tab of the canvas as the page reports it. */
export const CanvasTabInfo = z.object({
  title: z.string(),
  target: CanvasTargetSchema,
  active: z.boolean(),
  /** The viewer's kind (pdf, video, table…), once it is known. */
  kind: z.string().max(40).optional(),
  place: CanvasPlace.optional(),
});
export type CanvasTabInfo = z.infer<typeof CanvasTabInfo>;

export const CanvasState = z.object({
  /** Whether the canvas is in view (not hidden behind the chat). */
  visible: z.boolean(),
  tabs: z.array(CanvasTabInfo).max(50),
});
export type CanvasState = z.infer<typeof CanvasState>;

/** What an agent does to a tab (`canvas_act`): never an edit. */
export const CanvasDo = z.object({
  page: z.number().int().positive().optional(),
  line: z.number().int().positive().optional(),
  /** With line: the last line of the range to select. */
  toLine: z.number().int().positive().optional(),
  time: z.number().nonnegative().optional(),
  play: z.boolean().optional(),
  /** Percent, or "fit". */
  zoom: z.union([z.number().min(5).max(800), z.literal("fit")]).optional(),
  /** Words to find (a PDF's search). */
  find: z.string().max(200).optional(),
  sheet: z.string().max(200).optional(),
  /** Cells to mark (A1:C4). */
  cells: z.string().max(40).optional(),
});
export type CanvasDo = z.infer<typeof CanvasDo>;

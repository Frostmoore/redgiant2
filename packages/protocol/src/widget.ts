// Widgets and the artifacts' frame (3.5.9, study_artifacts.md §5): a widget is a ```widget block in
// an agent's answer, run in the same isolated frame as an artifact. The page and the server split
// an answer the same way; the frame talks to the page with MCP Apps' message names.
import { z } from "zod";

/**
 * The sandbox of an artifact or a widget (3.5.9, study §4.1): scripts and forms only, in an opaque
 * origin; no popups, modals, downloads or navigation of the page. The server's policy repeats it.
 */
export const ARTIFACT_SANDBOX = "allow-scripts allow-forms";

/** The most a widget block may carry; a bigger one stays text. */
export const WIDGET_MAX_BYTES = 64 * 1024;
/** The most a frame's «send to chat» may carry. */
export const ARTIFACT_MESSAGE_MAX = 4000;
/** How long after a click in the frame its message is taken as the person's (ms). */
export const ARTIFACT_CLICK_MS = 1500;
/** The most errors kept for one artifact or widget. */
export const ARTIFACT_ERRORS_MAX = 20;

/** A piece of an answer: its text, or a widget block (closed once its fence ends). */
export type AnswerSegment =
  | { kind: "text"; text: string }
  | {
      kind: "widget";
      /** Its place among the answer's widget blocks, from 0. */
      index: number;
      /** What follows `widget` on the fence line, if anything. */
      title: string;
      html: string;
      /** The fence was closed (while streaming the last block may still be open). */
      closed: boolean;
      /** Over `WIDGET_MAX_BYTES`: shown as text, never run. */
      tooBig: boolean;
    };

const OPEN = /^(\s{0,3})(`{3,}|~{3,})\s*widget\b[ \t]*(.*)$/i;

/**
 * An answer's text split around its ```widget blocks (pure). Text outside them is left as it is;
 * a block still open at the end (streaming) comes back with `closed: false`.
 */
export function answerSegments(text: string, first = 0): AnswerSegment[] {
  const out: AnswerSegment[] = [];
  const lines = text.split("\n");
  let buf: string[] = [];
  let index = first;
  const flush = () => {
    if (buf.length && buf.join("\n").trim()) out.push({ kind: "text", text: buf.join("\n") });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = OPEN.exec(line);
    if (!m) {
      buf.push(line);
      continue;
    }
    const fence = m[2] as string;
    const close = new RegExp(`^\\s{0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
    const body: string[] = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      if (close.test(lines[j] as string)) {
        closed = true;
        break;
      }
      body.push(lines[j] as string);
    }
    flush();
    const html = body.join("\n");
    const tooBig = new TextEncoder().encode(html).length > WIDGET_MAX_BYTES;
    out.push({ kind: "widget", index, title: (m[3] ?? "").trim(), html, closed, tooBig });
    index++;
    i = j;
  }
  flush();
  return out;
}

/**
 * The html of a widget block of an answer's text parts (numbered across the parts, from 0),
 * closed and within the limit, or undefined.
 */
export function widgetOf(
  texts: readonly string[],
  index: number,
): { html: string; title: string } | undefined {
  let n = 0;
  for (const text of texts) {
    const segs = answerSegments(text, n);
    const w = segs.find((s) => s.kind === "widget" && s.index === index);
    if (w?.kind === "widget")
      return w.closed && !w.tooBig ? { html: w.html, title: w.title } : undefined;
    n += segs.filter((s) => s.kind === "widget").length;
  }
  return undefined;
}

/** One error an artifact or widget met, as the frame's runtime reports it. */
export const ArtifactError = z.object({
  /**
   * `lib`: a library file RedGiant serves did not load; `blocked` (3.5.12): something from outside
   * (a picture, a script, a style) the frame does not let in, since artifacts reach no network.
   */
  kind: z.enum(["error", "rejection", "console", "lib", "compile", "blocked"]),
  message: z.string().max(2000),
  /** Where, when the browser says: the line in the file's own source, and the stack's top. */
  where: z.string().max(200).optional(),
});
export type ArtifactError = z.infer<typeof ArtifactError>;

/** What a frame's errors belong to: a file of a workspace, or a widget of an answer. */
export const ArtifactRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), scope: z.string().max(200), path: z.string().max(1000) }),
  z.object({
    kind: z.literal("widget"),
    sessionId: z.string().max(80),
    seq: z.number().int().nonnegative(),
    index: z.number().int().min(0).max(50),
  }),
]);
export type ArtifactRef = z.infer<typeof ArtifactRef>;

/**
 * What a frame's runtime posts to the page (JSON-RPC 2.0 shapes, MCP Apps' names where there is
 * one). Everything else a frame posts is ignored.
 */
export const FrameMessage = z.union([
  z.object({
    method: z.literal("ui/notifications/size-changed"),
    params: z.object({
      height: z.number().nonnegative().max(100_000),
      width: z.number().optional(),
    }),
  }),
  z.object({
    method: z.literal("ui/message"),
    id: z.union([z.number(), z.string()]).optional(),
    params: z.object({
      role: z.literal("user").default("user"),
      content: z
        .array(z.object({ type: z.literal("text"), text: z.string() }))
        .min(1)
        .max(10),
    }),
  }),
  z.object({ method: z.literal("ui/notifications/initialized"), params: z.object({}).optional() }),
  z.object({ method: z.literal("redgiant/error"), params: ArtifactError }),
]);
export type FrameMessage = z.infer<typeof FrameMessage>;

/** The text a frame's `ui/message` asks to send, or undefined when it is empty or too long. */
export function frameMessageText(m: FrameMessage): string | undefined {
  if (m.method !== "ui/message") return undefined;
  const text = m.params.content
    .map((c) => c.text)
    .join("\n")
    .trim();
  return text && text.length <= ARTIFACT_MESSAGE_MAX ? text : undefined;
}

/** One line in show and show_file's descriptions (3.5.9): how an artifact opens. */
export const ARTIFACT_TOOL_LINE =
  "An HTML file in artefatti/ (or with a redgiant-artifact header) opens as an artifact: a one-file app that runs isolated, with no network; its errors come back to you. In an artifact or a ```widget block, redgiant.sendMessage(text) from a button the person clicks sends text to the chat as theirs. canvas_edit help on an HTML file gives the format (header, libraries).";

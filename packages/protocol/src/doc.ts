// The editor's common model (G37.1, 3.5.0 «Editor»). The person and the agents edit the same
// file with the same operations: small, declarative, JSON, each with its inverse. Every family of
// files (plain text now; sheets, documents, layered pictures, vector, 3D and PDF later) carries its
// engine's own operations as a typed payload inside one envelope, `DocOp`. A batch of operations
// is one revision of the file, recorded as a `doc.ops` event in the file's own stream of the event
// log (`docStreamId`); a change made from outside (write_file, bash, another program) is a
// `doc.replaced`. The file on disk is the snapshot, the log is the history.
import { z } from "zod";

/** A file the editor works on: a workspace's scope and the path inside it. */
export const DocFile = z.object({
  scope: z.string().min(1).max(200),
  path: z.string().min(1).max(4000),
});
export type DocFile = z.infer<typeof DocFile>;

/** The families of files with an editor. G37.2-G37.8 add theirs. */
export const DOC_FAMILIES = ["text"] as const;
export const DocFamilyId = z.enum(DOC_FAMILIES);
export type DocFamilyId = z.infer<typeof DocFamilyId>;

/** The id of a file's own stream in the event log (the `sessionId` column of its events). */
export const docStreamId = (f: DocFile): string => `file:${f.scope}:${f.path}`;

/** The key that names a file in settings and maps (the same as its stream). */
export const docKey = docStreamId;

// -------------------------------------------------------------------------------------------
// Values the engines put in their operations that JSON cannot hold (pdf.js arrays with NaN,
// pixels, pasted pictures): an explicit encoding, so an operation survives the log unchanged.

type Encoded =
  | null
  | boolean
  | number
  | string
  | Encoded[]
  | { [k: string]: Encoded }
  | { $num: "NaN" | "Infinity" | "-Infinity" | "-0" }
  | { $bytes: string };

const toBase64 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000)
    s += String.fromCharCode(...b.subarray(i, Math.min(i + 0x8000, b.length)));
  return btoa(s);
};
const fromBase64 = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/**
 * A value as JSON can keep it: NaN, the infinities and -0 as `{$num}`, bytes as `{$bytes}`
 * (base64; big data goes to a blob instead, cited by its hash). An object key starting with `$`
 * is refused: it would be read back as an encoding.
 */
export function encodeDocValue(v: unknown): Encoded {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") {
    if (Number.isNaN(v)) return { $num: "NaN" };
    if (v === Number.POSITIVE_INFINITY) return { $num: "Infinity" };
    if (v === Number.NEGATIVE_INFINITY) return { $num: "-Infinity" };
    if (Object.is(v, -0)) return { $num: "-0" };
    return v;
  }
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof Uint8Array) return { $bytes: toBase64(v) };
  if (v instanceof ArrayBuffer) return { $bytes: toBase64(new Uint8Array(v)) };
  if (Array.isArray(v)) return v.map(encodeDocValue);
  if (typeof v === "object") {
    const out: Record<string, Encoded> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k.startsWith("$")) throw new Error(`A key starting with "$" cannot be kept: ${k}`);
      if (x !== undefined) out[k] = encodeDocValue(x);
    }
    return out;
  }
  throw new Error(`A ${typeof v} cannot be kept in an operation`);
}

/** The value `encodeDocValue` kept. */
export function decodeDocValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeDocValue);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && typeof o.$num === "string")
      return o.$num === "NaN"
        ? Number.NaN
        : o.$num === "Infinity"
          ? Number.POSITIVE_INFINITY
          : o.$num === "-Infinity"
            ? Number.NEGATIVE_INFINITY
            : -0;
    if (keys.length === 1 && typeof o.$bytes === "string") return fromBase64(o.$bytes);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = decodeDocValue(x);
    return out;
  }
  return v;
}

// -------------------------------------------------------------------------------------------
// Operations

/**
 * CodeMirror's `ChangeSet.toJSON()` (G37.0 prova 5): a number keeps that many characters, an
 * array `[deleted, ...inserted lines]` replaces them.
 */
export const TextChanges = z
  .array(
    z.union([
      z.number().int().nonnegative(),
      z.tuple([z.number().int().nonnegative()]).rest(z.string()),
    ]),
  )
  .max(100_000);
export type TextChanges = z.infer<typeof TextChanges>;

/** A range of the document an operation touches, as [from, to) in its own coordinates. */
const Range = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);

/** What an operation is, for the panel «Modifiche» (in the page's words) and for the agent. */
export const DocSummary = z.object({
  /** One line in English: the agent and the log read it. */
  text: z.string().max(500),
  kind: z.enum(["insert", "delete", "replace", "edit", "undo", "replaced"]),
  /** The first line touched (1-based) and how many lines. */
  line: z.number().int().positive().optional(),
  lines: z.number().int().nonnegative().optional(),
  /** Characters written and removed. */
  added: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
  /** Operations in the batch, when more than one («3 modifiche»). */
  count: z.number().int().positive().optional(),
});
export type DocSummary = z.infer<typeof DocSummary>;

/** Plain text (G37.1): a CodeMirror change set on the document before it. */
export const TextDocOp = z.object({
  family: z.literal("text"),
  engine: z.literal("codemirror-state"),
  engineVersion: z.string().max(40),
  op: z.object({ changes: TextChanges }),
  /** The ranges it changes in the document before it: the host checks conflicts on them. */
  target: z.array(Range).max(10_000).optional(),
});
export type TextDocOp = z.infer<typeof TextDocOp>;

/** The envelope of every family's operation. */
export const DocOp = z.discriminatedUnion("family", [TextDocOp]);
export type DocOp = z.infer<typeof DocOp>;

/** Who made a revision: the person, an agent (its id), or a program from outside. */
export const PERSON = "person";
export const OUTSIDE = "outside";

/** One revision of a file (the `doc.ops` event). */
export const DocOpsPayload = z.object({
  file: DocFile,
  family: DocFamilyId,
  /** The revision the author saw; the host rebased the operations onto the head when it could. */
  baseRevision: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  /** "person", or the agent's id. */
  author: z.string().min(1).max(200),
  /** The agent's name when it was written (the panel shows it). */
  authorName: z.string().max(200).optional(),
  /** The agent's conversation. */
  sessionId: z.string().max(200).optional(),
  /** The agent's turn or the person's gesture: «Annulla tutto il turno» takes the whole group. */
  groupId: z.string().min(1).max(200),
  /** Applied in order, each on the document the one before left. */
  ops: z.array(DocOp).min(1).max(1000),
  /** Applied in order on the document after `ops`, they bring it back. */
  inverse: z.array(DocOp).min(1).max(1000),
  summary: DocSummary,
  /** An undo: the revisions it takes back, and whether it went back to before them all. */
  undoOf: z
    .object({
      revisions: z.array(z.number().int().positive()).min(1).max(10_000),
      toBefore: z.boolean().optional(),
    })
    .optional(),
  /** A proposal the person accepted. */
  proposalId: z.string().max(80).optional(),
});
export type DocOpsPayload = z.infer<typeof DocOpsPayload>;

/** The file changed on disk from outside (the `doc.replaced` event): the host starts from it. */
export const DocReplacedPayload = z.object({
  file: DocFile,
  family: DocFamilyId,
  revision: z.number().int().positive(),
  /** The file's sha256 the host knew, and the new one. */
  hashBefore: z.string().max(64).optional(),
  hashAfter: z.string().max(64),
  by: z.string().max(200),
  summary: DocSummary,
  /** The difference as operations, when it is small enough to keep (it can be undone then). */
  ops: z.array(DocOp).max(1000).optional(),
  inverse: z.array(DocOp).max(1000).optional(),
});
export type DocReplacedPayload = z.infer<typeof DocReplacedPayload>;

/** An agent's edit waiting for the person (the rule «come proposte», `doc.proposed`). */
export const DocProposedPayload = z.object({
  file: DocFile,
  family: DocFamilyId,
  proposalId: z.string().min(1).max(80),
  baseRevision: z.number().int().nonnegative(),
  author: z.string().min(1).max(200),
  authorName: z.string().max(200).optional(),
  sessionId: z.string().max(200).optional(),
  groupId: z.string().min(1).max(200),
  ops: z.array(DocOp).min(1).max(1000),
  summary: DocSummary,
});
export type DocProposedPayload = z.infer<typeof DocProposedPayload>;

/** The person's answer to a proposal (`doc.decided`). */
export const DocDecidedPayload = z.object({
  file: DocFile,
  proposalId: z.string().min(1).max(80),
  decision: z.enum(["accepted", "rejected"]),
  /** The revision it became. */
  revision: z.number().int().positive().optional(),
});
export type DocDecidedPayload = z.infer<typeof DocDecidedPayload>;

// -------------------------------------------------------------------------------------------
// What the page is told

/** A line of the panel «Modifiche». */
export const DocChange = z.object({
  revision: z.number().int().positive(),
  ts: z.string(),
  author: z.string(),
  authorName: z.string().optional(),
  groupId: z.string(),
  summary: DocSummary,
  undoOf: z.array(z.number().int().positive()).optional(),
  /** The revision that took it back. */
  undoneBy: z.number().int().positive().optional(),
  /** A change from outside (doc.replaced). */
  replaced: z.boolean().optional(),
  /** Ranges it wrote, in the document right after it (the page highlights the agent's). */
  wrote: z.array(Range).max(1000).optional(),
});
export type DocChange = z.infer<typeof DocChange>;

export const DocProposal = z.object({
  proposalId: z.string(),
  ts: z.string(),
  author: z.string(),
  authorName: z.string().optional(),
  baseRevision: z.number().int().nonnegative(),
  summary: DocSummary,
});
export type DocProposal = z.infer<typeof DocProposal>;

/** Who is in a file now: the person (on a page) or an agent that edited it a moment ago. */
export const DocPresence = z.object({
  who: z.string(),
  name: z.string().optional(),
  /** Typing now (the person's lead: agents' edits there wait). */
  editing: z.boolean(),
  /** The person's line, when known. */
  line: z.number().int().positive().optional(),
});
export type DocPresence = z.infer<typeof DocPresence>;

/** The file's content as the page loads it, family by family. */
export const DocSnapshot = z.discriminatedUnion("family", [
  z.object({ family: z.literal("text"), text: z.string() }),
]);
export type DocSnapshot = z.infer<typeof DocSnapshot>;

// -------------------------------------------------------------------------------------------
// The rule for the agents' edits (decision of 2026-11-08): applied at once by default, or kept
// as proposals the person accepts, chosen for an agent or for a file.

export const AgentEditMode = z.enum(["now", "propose"]);
export type AgentEditMode = z.infer<typeof AgentEditMode>;

export const EditorSettings = z.object({
  agents: z.record(z.string().max(200), AgentEditMode).default({}),
  /** By `docKey`. */
  files: z.record(z.string().max(4300), AgentEditMode).default({}),
});
export type EditorSettings = z.infer<typeof EditorSettings>;
export const DEFAULT_EDITOR_SETTINGS: EditorSettings = { agents: {}, files: {} };

/** The rule for one agent on one file: the file's choice, then the agent's, then «now». */
export function agentEditMode(s: EditorSettings, agentId: string, file: DocFile): AgentEditMode {
  return s.files[docKey(file)] ?? s.agents[agentId] ?? "now";
}

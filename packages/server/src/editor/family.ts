// A family of files the editor knows (G37.1): how its engine's operations are read, applied,
// inverted, rebased and checked for conflicts, and how an agent's plain operations become them.
// The host (host.ts) is the same for every family; plain text is the first (text-family.ts), the
// others come with G37.2-G37.8.
import type { DocFamilyId, DocFile, DocOp, DocSnapshot, DocSummary } from "@redgiant/protocol";

/** The file's bytes as the family keeps them, with what saving needs to write them back alike. */
export interface Loaded<M> {
  model: M;
  /** Line ends, a byte order mark…: whatever saving must keep. */
  format: unknown;
}

/** An agent's operations turned into the engine's, or why not (the op's index, from 0). */
export type FromAgent = { ops: DocOp[] } | { error: string; index?: number };

/** What a family that writes through an outside engine knows when it saves (G37.4). */
export interface SaveContext {
  ownerId: string;
  file: DocFile;
  abs: string;
  /** Big data kept apart (a page's saved file, a picture), by its sha256. */
  blob(hash: string): Promise<Uint8Array | undefined>;
}

/** What preparing an agent's operations may use (G37.4: a picture of the workspace as a blob). */
export interface PrepareContext {
  read(path: string): Promise<Uint8Array>;
  putBlob(bytes: Uint8Array): Promise<string>;
}

export interface DocFamily<M = unknown> {
  id: DocFamilyId;
  /** The engine and its version, written in every operation. */
  engine: string;
  engineVersion: string;
  /** Whether it edits this file (from its name). */
  accepts(path: string): boolean;
  /** Bytes to a model; throws with a reason when the file is not one it edits. */
  load(bytes: Uint8Array): Loaded<M>;
  save(model: M, format: unknown): Uint8Array;
  snapshot(model: M): DocSnapshot;
  /** Why an operation cannot apply to this model (undefined: it can). */
  check(model: M, op: DocOp): string | undefined;
  apply(model: M, op: DocOp): M;
  /** The operation that undoes `op`, on the model after it (`model` is the one before). */
  invert(model: M, op: DocOp): DocOp;
  /** Several operations as one (rebasing a batch); undefined when the family cannot. */
  compose(ops: readonly DocOp[]): DocOp | undefined;
  /**
   * Whether `a` and `b`, made on the same model, touch the same place: the host refuses to merge
   * them in silence (the libraries would, G37.0).
   */
  conflicts(a: DocOp, b: DocOp): boolean;
  /** `a` made on the same model as `b`, moved to apply after `b`. */
  map(a: DocOp, b: DocOp): DocOp;
  /** Whether `op` touches the range [from, to] of the model it applies to. */
  touches(op: DocOp, from: number, to: number): boolean;
  /** A position of the model before `op`, in the model after it. */
  mapPos(op: DocOp, pos: number, assoc: -1 | 1): number;
  /** The 1-based line of a position (presence, the panel). */
  lineOf(model: M, pos: number): number;
  /** The difference between two models as one operation (doc.replaced), when it is small. */
  diff(before: M, after: M, maxBytes: number): DocOp | undefined;
  /** What a batch does, on the model before it. */
  summarize(model: M, ops: readonly DocOp[], kind?: DocSummary["kind"]): DocSummary;
  /** The ranges a batch wrote, in the model after it (the page highlights the agent's). */
  wrote(ops: readonly DocOp[]): [number, number][];
  /** An agent's plain operations (canvas_edit) on this model, applied one after the other. */
  fromAgent(model: M, ops: readonly unknown[]): FromAgent;
  /** The catalog of the agent's operations (canvas_edit `help`): a result, never the prefix. */
  catalog(): string;
  /** The model as an agent reads it (canvas_look `view: "structure"`). */
  structure(model: M, ask: { fromLine?: number | undefined; toLine?: number | undefined }): string;
  /**
   * Optional (G37.4): the file written by an outside engine (LibreOffice) instead of `save`, and
   * the model its bytes make (the host keeps it).
   */
  render?(model: M, format: unknown, ctx: SaveContext): Promise<{ bytes: Uint8Array; model?: M }>;
  /** Optional (G37.4): after the file was written (a closed format written back). */
  saved?(model: M, ctx: SaveContext): Promise<void>;
  /** Optional (G37.4): an agent's operations made ready before `fromAgent` (pictures to blobs). */
  prepare?(ops: readonly unknown[], ctx: PrepareContext): Promise<unknown[]>;
}

// Shared shapes inside the knowledge modules (G36): what reading a file gives, what cutting it
// gives, and what the indexer needs from the rest of the server. Wire types live in
// `@redgiant/protocol` (knowledge.ts).

import type { KnowledgeDocKind } from "@redgiant/protocol";

/**
 * One logical part of a document as read: a Markdown section, a code symbol, a PDF page, a
 * slide. Cutting (`chunkDocument`) splits the long ones and joins small neighbours.
 */
export interface ExtractedPart {
  text: string;
  /** Section heading path (`Install › Windows`) or symbol (`function startEmbeddedDatabase`). */
  heading?: string;
  /** 1-based page (PDF, Office through its PDF, slide number for presentations). */
  page?: number;
  /** 1-based lines in the original text file, inclusive. */
  lineStart?: number;
  lineEnd?: number;
}

export interface Extracted {
  kind: KnowledgeDocKind;
  /** A title for the document (first heading, PDF title, `<title>`), else the file name. */
  title: string;
  /** How many pages it has (PDF and Office through PDF). */
  pages?: number;
  parts: ExtractedPart[];
  /** What was lost in reading (`no pages: LibreOffice not available`…), for the page. */
  note?: string;
}

/** Why a file was not read. */
export type SkipReason =
  | "binary"
  | "too_big"
  | "empty"
  | "unsupported"
  | "needs_libreoffice"
  | "needs_ocr"
  | "encrypted";

export type ExtractOutcome =
  | { ok: true; doc: Extracted }
  | { ok: false; skipped: SkipReason; message?: string };

/** What reading needs from the server (all optional: tests pass nothing). */
export interface ExtractContext {
  /**
   * The PDF LibreOffice makes of an Office file (the same one the Canvas shows, so pages match);
   * undefined when LibreOffice is not on this computer (never downloaded just for indexing).
   */
  officePdf?: (abs: string, signal?: AbortSignal) => Promise<string | undefined>;
  signal?: AbortSignal;
  /**
   * The text in a picture (G36.6, Tesseract on this computer); unset while the OCR is off or not
   * downloaded yet: pictures and scans are then skipped as `needs_ocr`, read later.
   */
  ocr?: (image: Uint8Array, signal?: AbortSignal) => Promise<string>;
  /** Largest file read, bytes (default 50 MB; text files 5 MB). */
  maxBytes?: number;
}

/** One piece as stored: the text and its place. */
export interface Chunk {
  /** Order inside the document, from 0. */
  ord: number;
  text: string;
  heading?: string;
  page?: number;
  lineStart?: number;
  lineEnd?: number;
  /** sha256 of the text (hex): equal pieces keep their vectors when a file changes. */
  hash: string;
}

export interface ChunkOptions {
  /** Aimed size, characters (default 1200). */
  target?: number;
  /** Never longer than this, characters (default 1800). */
  max?: number;
  /** Characters repeated from the end of the previous piece when a long part is split (default 150). */
  overlap?: number;
}

/** A file found in a source. */
export interface FoundFile {
  /** Path inside the source root, with `/`. */
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

export interface ListOptions {
  /** `.gitignore`-style patterns left out. */
  exclude?: string[];
  /** Follow `.gitignore` files found while walking (default true). */
  gitignore?: boolean;
  /** Stop after this many files (default 200 000). */
  maxFiles?: number;
  signal?: AbortSignal;
}

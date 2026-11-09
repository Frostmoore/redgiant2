// The vector family (G37.6): SVG drawings edited in place, the open SVG copy of an Illustrator or
// PostScript file (`x.ai.open/x.svg`) included. The host keeps the file's own XML tree
// (svg/xml.ts): actions change only the elements they name, and saving writes every other byte as
// it was (Inkscape's and Sodipodi's attributes, metadata, unknown elements, spaces in texts). The
// page edits with @svgedit/svgcanvas and sends the same actions; the server never writes the file
// from the page's DOM.
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, extname, posix, win32 } from "node:path";
import type { DocOp, DocSummary, SvgAction, SvgDocOp } from "@redgiant/protocol";
import type { DocFamily, Loaded } from "./family.js";
import { SVG_CATALOG, svgFromAgent } from "./svg/agent.js";
import { local } from "./svg/geometry.js";
import {
  actionsConflict,
  applyAction,
  checkAction,
  composeActions,
  describe,
  invertAction,
  mapAction,
  type SvgModel,
} from "./svg/ops.js";
import { svgStructure } from "./svg/structure.js";
import { parseXml, writeXml } from "./svg/xml.js";

export const SVG_ENGINE_VERSION = "1";
/** The biggest drawing the editor opens. */
export const MAX_SVG_BYTES = 30 * 1024 * 1024;
/** Closed vector formats whose SVG copy the editor edits. */
export const SVG_COPIES = /\.(ai|eps|epsf|epsi|ps)$/i;

const wrap = (op: SvgAction): SvgDocOp => ({
  family: "svg",
  engine: "svg-dom",
  engineVersion: SVG_ENGINE_VERSION,
  op,
});
const actionOf = (op: DocOp): SvgAction => {
  if (op.family !== "svg") throw new Error("not an operation on a drawing");
  return op.op;
};

/** Where the open SVG copy of an AI/EPS file is (`x.ai` → `x.ai.open/x.svg`). */
export function svgCopyOfOriginal(path: string): string | undefined {
  if (!SVG_COPIES.test(path)) return undefined;
  const b = basename(path);
  const stem = b.slice(0, b.lastIndexOf("."));
  return `${path}.open/${stem}.svg`;
}

/** The AI/EPS file an open SVG copy came from (`x.ai.open/x.svg` → `x.ai`). */
export function originalOfSvgCopy(path: string): string | undefined {
  const dir = dirname(path).replace(/\\/g, "/");
  const m = dir.match(/^(.*)\.open$/);
  if (!m?.[1] || !SVG_COPIES.test(m[1])) return undefined;
  return svgCopyOfOriginal(m[1]) === path.replace(/\\/g, "/") ? m[1] : undefined;
}

/** Inkscape on this computer, if it is installed (never downloaded: «Apri in Inkscape»). */
export function findInkscape(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  list: (dir: string) => string[] = (d) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  },
): string | undefined {
  if (platform === "darwin") {
    const app = "/Applications/Inkscape.app";
    return exists(app) ? app : undefined;
  }
  if (platform === "win32") {
    const roots = [
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
      env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs"),
    ].filter((x): x is string => !!x);
    for (const r of roots) {
      const p = win32.join(r, "Inkscape", "bin", "inkscape.exe");
      if (exists(p)) return p;
    }
    return undefined;
  }
  // The platform asked about, not the one running (tests ask for each).
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
    const p = posix.join(dir, "inkscape");
    if (exists(p)) return p;
  }
  // Flatpak's exported launchers.
  for (const d of [
    "/var/lib/flatpak/exports/bin",
    posix.join(env.HOME ?? "/root", ".local/share/flatpak/exports/bin"),
  ])
    if (list(d).includes("org.inkscape.Inkscape")) return posix.join(d, "org.inkscape.Inkscape");
  return undefined;
}

export class SvgFamily implements DocFamily<SvgModel> {
  readonly id = "svg" as const;
  readonly engine = "svg-dom";
  readonly engineVersion = SVG_ENGINE_VERSION;

  accepts(path: string): boolean {
    return extname(path).toLowerCase() === ".svg";
  }

  load(bytes: Uint8Array): Loaded<SvgModel> {
    if (bytes.length > MAX_SVG_BYTES)
      throw new Error(`it is over ${MAX_SVG_BYTES / 1024 / 1024} MB`);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b)
      throw new Error("it is compressed (svgz): save it as plain SVG");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error("it is not UTF-8 (save it again as UTF-8 SVG)");
    }
    const doc = parseXml(text);
    if (local(doc.root.name) !== "svg") throw new Error("its root element is not <svg>");
    return { model: { doc }, format: {} };
  }

  save(model: SvgModel): Uint8Array {
    return new TextEncoder().encode(writeXml(model.doc));
  }

  snapshot(model: SvgModel) {
    return { family: "svg" as const, text: writeXml(model.doc) };
  }

  check(model: SvgModel, op: DocOp): string | undefined {
    if (op.family !== "svg") return "not an operation on a drawing";
    return checkAction(model.doc, op.op);
  }

  apply(model: SvgModel, op: DocOp): SvgModel {
    return { doc: applyAction(model.doc, actionOf(op)) };
  }

  invert(model: SvgModel, op: DocOp): DocOp {
    return wrap(invertAction(model.doc, actionOf(op)));
  }

  compose(ops: readonly DocOp[]): DocOp {
    return wrap(composeActions(ops.map(actionOf)));
  }

  conflicts(a: DocOp, b: DocOp): boolean {
    return actionsConflict(actionOf(a), actionOf(b));
  }

  map(a: DocOp, b: DocOp): DocOp | undefined {
    const m = mapAction(actionOf(a), actionOf(b));
    return m && wrap(m);
  }

  /** While the person draws or types the agents' edits wait (the whole drawing is theirs). */
  touches(): boolean {
    return true;
  }

  mapPos(_op: DocOp, pos: number): number {
    return pos;
  }

  lineOf(): number {
    return 1;
  }

  placeOf(): string {
    return "the drawing";
  }

  diff(before: SvgModel, after: SvgModel, maxBytes: number): DocOp | undefined {
    const text = writeXml(after.doc);
    return text.length * 2 + writeXml(before.doc).length * 2 <= maxBytes
      ? wrap({ t: "doc", text })
      : undefined;
  }

  summarize(model: SvgModel, ops: readonly DocOp[], kind?: DocSummary["kind"]): DocSummary {
    const d = describe(model.doc, ops.map(actionOf));
    const k: DocSummary["kind"] =
      d.change.action === "add"
        ? "insert"
        : d.change.action === "delete"
          ? "delete"
          : d.change.action === "replace"
            ? "replace"
            : "edit";
    return {
      text: d.text,
      kind: kind ?? k,
      svg: d.change,
      ...(ops.length > 1 && { count: ops.length }),
    };
  }

  wrote(): [number, number][] {
    return [];
  }

  fromAgent(model: SvgModel, ops: readonly unknown[]) {
    const r = svgFromAgent(model.doc, ops);
    if ("error" in r) return r;
    return {
      ops: [
        wrap(r.actions.length === 1 ? (r.actions[0] as SvgAction) : { t: "batch", ops: r.actions }),
      ],
    };
  }

  catalog(): string {
    return SVG_CATALOG;
  }

  structure(
    model: SvgModel,
    ask: { fromLine?: number | undefined; toLine?: number | undefined },
  ): string {
    return svgStructure(model.doc, undefined, ask);
  }
}

export const svgFamily = new SvgFamily();

/** The original's name for an open copy, for the page («Copia SVG di logo.ai»). */
export const svgOriginalName = (path: string) => {
  const o = originalOfSvgCopy(path);
  return o ? basename(o) : undefined;
};

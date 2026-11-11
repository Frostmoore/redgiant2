// Converting closed files into open ones (G34.3, decision of 2026-11-07). The original stays as
// it is; the open copies go into a folder beside it, `<file>.open/`, with `conversion.json`
// saying what was made, from which version of the original, and what the conversion lost.
// Our own code does Photoshop, InDesign (IDML, previews), Sketch, Figma and Affinity previews;
// LibreOffice, Ghostscript and ffmpeg are outside programs, found or downloaded when needed
// (convert-programs.ts). Every path stays inside the workspace it came from.

import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { LocalWorkspace } from "@redgiant/tools";
import { unzipSync } from "fflate";
import { BLENDER_CONVERT_SCRIPT, commands as blenderCommands } from "./convert-blender.js";
import {
  detectFormat,
  extOf,
  type FormatInfo,
  type Needs,
  needsConversion,
  suggestConversion,
  type Target,
  type Via,
} from "./convert-formats.js";
import { idmlLinks, idmlToOdg, linkName, relinkIdml } from "./convert-idml.js";
import {
  type Converted,
  embeddedPreview,
  idmlToOdt,
  psdToOra,
  rezip,
  sketchOutline,
  unzip,
  zipPreview,
} from "./convert-js.js";
import { type LossCode, lossCodes as lossCodesOf } from "./convert-losses.js";
import {
  type DesktopApp,
  execRunner,
  findDesktopApp,
  findXvfbRun,
  PROGRAMS,
  type ProgramId,
  type Programs,
  type Runner,
} from "./convert-programs.js";
import { sketchToSvg } from "./convert-sketch.js";
import { LO_QUIET, type LoProfiles, loProfiles, profileArg } from "./lo-profiles.js";

/**
 * What LibreOffice's AppImage needs from a system without a desktop (checked in
 * node:24-trixie-slim, the Docker image's base, 2026-11-07; the image installs them).
 */
export const LIBREOFFICE_LIBS =
  "libx11-6 libx11-xcb1 libxext6 libxinerama1 libcairo2 libcups2t64 libdbus-1-3 libfontconfig1 libfreetype6 libglib2.0-0t64 libgssapi-krb5-2 libnss3 fonts-dejavu-core";

/**
 * What Scribus's AppImage needs on a Linux without a desktop: a display (Xvfb, through
 * xvfb-run) and one font (checked in node:24-trixie-slim, 2026-11-07; the image installs them).
 */
export const SCRIBUS_LIBS = "xvfb xauth fonts-dejavu-core";

/**
 * The script Scribus runs (`-py`, arguments in sys.argv): opens what it can import (IDML),
 * saves it as .sla and prints a PDF. Written by RedGiant, never by a model; paths are arguments.
 */
export const SCRIBUS_SCRIPT = `# RedGiant: open a document Scribus can import (IDML...), save it as .sla and print a PDF.
import os
import sys
import traceback


def main():
    import scribus

    src, sla = sys.argv[1], sys.argv[2]
    pdf = sys.argv[3] if len(sys.argv) > 3 else ""
    if not scribus.openDoc(src):
        raise RuntimeError("Scribus could not open " + src)
    print("REDGIANT pages=%d" % scribus.pageCount(), flush=True)
    scribus.saveDocAs(sla)
    if pdf:
        p = scribus.PDFfile()
        p.file = pdf
        p.save()
    scribus.closeDoc()


code = 0
try:
    main()
    print("REDGIANT done", flush=True)
except Exception:
    traceback.print_exc()
    code = 1
sys.stdout.flush()
sys.stderr.flush()
os._exit(code)
`;

/** Where the open copies of `path` go. */
export const openDirOf = (path: string) => `${path}.open`;
export const MANIFEST = "conversion.json";

export interface Manifest {
  source: string;
  sourceSize: number;
  sourceModifiedAt: string;
  format: string;
  outputs: { path: string; ext: string }[];
  losses: string[];
  via: Via[];
  convertedAt: string;
  /** Only the stored preview could be taken: not a conversion. */
  previewOnly?: boolean;
  /** The closed app the file needs, and what to export from it (see `Needs`). */
  needs?: Needs;
}

export interface TargetView extends Target {
  /** `losses` as stable codes for the page (same order), the English stays for the agents. */
  lossCodes: LossCode[];
  /** The program it needs (none for our own code), and whether it is here or can come down. */
  program?: {
    id: ProgramId;
    name: string;
    license: string;
    size: string;
    here: boolean;
    canDownload: boolean;
    install: string;
  };
}

/** What the UI and the agents learn about a file before converting it. */
export interface FileReport {
  path: string;
  format: Omit<FormatInfo, "targets"> | null;
  /** The agents must work on an open copy. */
  needsConversion: boolean;
  /** Worth offering at once (closed, or a picture or sound the browser cannot show). */
  suggested: boolean;
  targets: TargetView[];
  /** The last conversion, if any; `stale` when the original changed since. */
  converted: (Manifest & { stale: boolean; lossCodes: LossCode[] }) | null;
  needs?: NeedsView;
}

export interface ConvertResult {
  path: string;
  dir: string;
  outputs: { path: string; ext: string }[];
  losses: string[];
  lossCodes: LossCode[];
  /** Targets asked for that could not be made now, and why. */
  skipped: { ext: string; reason: string }[];
  previewOnly?: boolean;
  needs?: NeedsView;
}

/** `Needs` with whether the app is on this computer (for «Open in…»). */
export interface NeedsView extends Needs {
  installed: boolean;
}

export class ConvertError extends Error {}

const HEAD = 64 * 1024;
/** Larger files are converted only by outside programs (our own code reads them whole). */
const MAX_JS_BYTES = 1024 * 1024 * 1024;

const toPosix = (p: string) => p.split(sep).join("/");
const stemOf = (path: string) => {
  const b = basename(path);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
};

/** A file's format from its name and first bytes (and its entries when it is a zip). */
export async function formatOfFile(abs: string): Promise<FormatInfo | undefined> {
  const st = await stat(abs);
  const fh = await open(abs, "r");
  const head = new Uint8Array(Math.min(HEAD, st.size));
  try {
    await fh.read(head, 0, head.length, 0);
  } finally {
    await fh.close();
  }
  let names: string[] | undefined;
  if (head[0] === 0x50 && head[1] === 0x4b && st.size < 128 * 1024 * 1024) {
    try {
      names = [];
      const list = names;
      unzipSync(new Uint8Array(await readFile(abs)), {
        filter: (f) => {
          list.push(f.name);
          return false;
        },
      });
    } catch {
      names = undefined;
    }
  }
  return detectFormat(abs, head, names);
}

/** Runs one program at a time per kind (LibreOffice cannot share its profile). */
class Queue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(f: () => Promise<T>): Promise<T> {
    const next = this.tail.then(f, f);
    this.tail = next.catch(() => {});
    return next;
  }
}

/** The arguments for each outside program (exported: the tests check them as they are). */
export const commands = {
  libreoffice(input: string, outDir: string, ext: string, profile: string, fromPdf: boolean) {
    const filter = ext === "svg" ? "svg:draw_svg_Export" : ext;
    return [
      ...LO_QUIET,
      profileArg(profile),
      ...(fromPdf ? ["--infilter=draw_pdf_import"] : []),
      "--convert-to",
      filter,
      "--outdir",
      outDir,
      input,
    ];
  },
  ghostscript(input: string, output: string, eps: boolean) {
    return [
      "-dSAFER",
      "-dBATCH",
      "-dNOPAUSE",
      "-dQUIET",
      "-sDEVICE=pdfwrite",
      ...(eps ? ["-dEPSCrop"] : []),
      // Ghostscript reads %d in the output's name as a page number.
      `-sOutputFile=${output.replace(/%/g, "%%")}`,
      input,
    ];
  },
  /**
   * Scribus with its script, without a window. On Linux without a display it runs inside
   * xvfb-run (its AppImage carries only the X11 platform plugin).
   */
  scribus(
    program: string,
    script: string,
    input: string,
    sla: string,
    pdf: string,
    o: { platform?: string; display?: string | undefined; xvfbRun?: string | undefined } = {},
  ): { file: string; args: string[] } {
    const args = ["-g", "-ns", "-py", script, input, sla, pdf];
    const platform = o.platform ?? process.platform;
    if (platform === "linux" && !o.display) {
      if (!o.xvfbRun)
        throw new ConvertError(
          `Scribus needs a display, and this Linux has none: sudo apt install ${SCRIBUS_LIBS} (the Docker image has them)`,
        );
      return { file: o.xvfbRun, args: ["-a", program, ...args] };
    }
    return { file: program, args };
  },
  ffmpeg(input: string, output: string, ext: string) {
    const head = ["-hide_banner", "-nostdin", "-y", "-i", input];
    if (ext === "webm")
      return [
        ...head,
        ...["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "33", "-deadline", "realtime"],
        ...["-cpu-used", "8", "-row-mt", "1", "-c:a", "libopus", "-b:a", "128k", output],
      ];
    if (ext === "opus") return [...head, "-vn", "-c:a", "libopus", "-b:a", "128k", output];
    if (ext === "flac") return [...head, "-vn", "-c:a", "flac", output];
    return [...head, "-frames:v", "1", output];
  },
};

export interface ConverterOptions {
  programs: Programs;
  /**
   * Where LibreOffice keeps its own profiles (RedGiant's, never the person's): this folder and
   * `-2` beside it, one per conversion running (p3.5.3: two at once never share one).
   */
  profileDir: string;
  run?: Runner;
  now?: () => Date;
  /** Where the canvas's paged previews (PDF) are kept; never beside the original. */
  previewDir?: string;
  /** Tests: the system, its display and xvfb-run, and which closed apps are installed. */
  platform?: string;
  display?: string;
  xvfbRun?: string | null;
  desktopApp?: (app: DesktopApp) => string | undefined;
}

/**
 * Documents the canvas shows paged, as LibreOffice prints them (the user, 2026-11-07: «Ovvio che
 * devono essere impaginati sennò a che mi servono»): Word, PowerPoint, Excel, OpenDocument, RTF,
 * Apple iWork. Only a preview: it goes into a cache, never beside the file.
 */
export const PREVIEWABLE = new Set([
  "docx",
  "xlsx",
  "pptx",
  "odt",
  "ods",
  "odp",
  "odg",
  "pages",
  "numbers",
  "key",
  "visio",
  "publisher",
]);

export interface PreviewState {
  /** The cached PDF's absolute path (it exists when `ready`). */
  pdf: string;
  ready: boolean;
}

export class FileConverter {
  private readonly queues = new Map<ProgramId, Queue>();
  private readonly profiles: LoProfiles;
  /** The paged previews being made now, by their PDF: a second ask joins the first (p3.5.7). */
  private readonly making = new Map<string, Promise<string>>();

  constructor(private readonly o: ConverterOptions) {
    this.profiles = loProfiles(o.profileDir, 2);
  }

  /** One LibreOffice run with a profile no other run holds (two at most at once). */
  private office(
    file: string,
    args: (profile: string) => string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    return this.profiles.use((profile) =>
      this.run("libreoffice", file, args(profile), timeoutMs, signal),
    );
  }

  private run(
    id: ProgramId,
    file: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
    cwd?: string,
  ) {
    const exec = () =>
      (this.o.run ?? execRunner)(file, args, { timeoutMs, signal, ...(cwd && { cwd }) });
    // LibreOffice: its profiles' pool says how many at once (`office`).
    if (id === "libreoffice") return exec();
    let q = this.queues.get(id);
    if (!q) {
      q = new Queue();
      this.queues.set(id, q);
    }
    return q.run(exec);
  }

  /** A closed app's needs, with whether it is installed here. */
  needsOf(f: FormatInfo | undefined): NeedsView | undefined {
    if (!f?.needs) return undefined;
    const app = f.needs.app;
    const find = this.o.desktopApp ?? ((a: DesktopApp) => findDesktopApp(a));
    const installed = app === "affinity" || app === "indesign" ? find(app) !== undefined : false;
    return { ...f.needs, installed };
  }

  private view(t: Target): TargetView {
    const lossCodes = lossCodesOf(t.losses);
    if (t.via === "js") return { ...t, lossCodes };
    const id = t.via;
    const p = PROGRAMS[id];
    return {
      ...t,
      lossCodes,
      program: {
        id,
        name: p.name,
        license: p.license,
        size: p.size,
        here: this.o.programs.find(id) !== undefined,
        canDownload: this.o.programs.canDownload(id),
        install: p.install[this.o.programs.platform] ?? p.install.linux ?? "",
      },
    };
  }

  /** What a file is and what it can become; `path` is relative to `root` and stays inside it. */
  async inspect(root: string, path: string): Promise<FileReport> {
    const abs = await new LocalWorkspace(root).resolve(path);
    const st = await stat(abs).catch(() => undefined);
    if (!st?.isFile()) throw new ConvertError(`There is no file "${path}"`);
    const f = await formatOfFile(abs);
    const manifest = await readManifest(root, path);
    const { targets, ...format } = f ?? ({} as FormatInfo);
    const needs = this.needsOf(f);
    return {
      ...(needs && { needs }),
      path,
      format: f ? format : null,
      needsConversion: f ? needsConversion(f) : false,
      suggested: f ? suggestConversion(f) : false,
      targets: f ? targets.map((t) => this.view(t)) : [],
      converted: manifest
        ? {
            ...manifest,
            lossCodes: lossCodesOf(manifest.losses),
            stale:
              manifest.sourceSize !== st.size ||
              manifest.sourceModifiedAt !== st.mtime.toISOString(),
          }
        : null,
    };
  }

  /**
   * Makes the open copies. Without `to`: the default target, plus whatever else can be made now
   * without downloading anything. With `to`: exactly those (downloading what they need).
   */
  async convert(
    root: string,
    path: string,
    o: {
      owner: string;
      to?: string[] | undefined;
      signal?: AbortSignal | undefined;
      /** Before an outside program starts (the job's step). */
      onProgram?: (id: ProgramId) => void;
    },
  ): Promise<ConvertResult> {
    const ws = new LocalWorkspace(root);
    const abs = await ws.resolve(path);
    const st = await stat(abs).catch(() => undefined);
    if (!st?.isFile()) throw new ConvertError(`There is no file "${path}"`);
    const f = await formatOfFile(abs);
    if (!f) throw new ConvertError(`RedGiant does not know the format of ${basename(path)}`);
    if (f.targets.length === 0)
      throw new ConvertError(`${basename(path)} is ${f.name}, an open format: use it as it is.`);
    const wanted = wantedOf(f, o.to);
    if (wanted) {
      const bad = wanted.filter((x) => !f.targets.some((t) => t.ext === x));
      if (bad.length)
        throw new ConvertError(
          `${f.name} cannot become ${bad.join(", ")}: it can become ${f.targets.map((t) => t.ext).join(", ")}`,
        );
    }
    const relDir = openDirOf(path);
    const dir = await ws.resolve(relDir);
    const work = join(dir, ".work");
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    const stem = stemOf(path);
    const made = new Map<string, string>(); // ext → absolute path of the output
    const losses = new Set<string>();
    const via = new Set<Via>();
    const skipped: ConvertResult["skipped"] = [];
    const save = async (files: Record<string, Uint8Array>) => {
      for (const [name, data] of Object.entries(files)) {
        const out = join(dir, name);
        await mkdir(dirname(out), { recursive: true });
        await writeFile(`${out}.part`, data);
        await rename(`${out}.part`, out);
        // One entry per extension (later steps look them up); more files of one kind by name.
        const ext = extOf(name) || name;
        made.set(made.has(ext) && made.get(ext) !== out ? name : ext, out);
      }
    };
    try {
      for (const t of this.chosen(f, wanted)) {
        if (made.has(t.ext)) continue;
        // The fallback of a better target that was made (IDML: the ODG when Scribus made the SLA).
        if (!wanted && t.unless && made.has(t.unless)) continue;
        o.signal?.throwIfAborted();
        try {
          if (t.via === "js") {
            const c = await this.js(f, t, ws, abs, stem, st.size);
            await save(c.files);
            for (const l of c.losses) losses.add(l);
          } else await this.external(f, t, ws, abs, stem, work, made, o);
          if (t.via !== "js" && !made.has(t.ext))
            throw new ConvertError(`${PROGRAMS[t.via].name} made no ${t.ext.toUpperCase()}`);
          via.add(t.via);
          for (const l of t.losses) losses.add(l);
        } catch (err) {
          if (o.signal?.aborted) throw err;
          skipped.push({ ext: t.ext, reason: (err as Error).message });
        }
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    if (made.size === 0)
      throw new ConvertError(
        `Nothing could be made from ${basename(path)}: ${skipped.map((s) => `${s.ext}: ${s.reason}`).join("; ")}`,
      );
    const outputs = [...made.values()].map((p) => ({
      path: toPosix(relative(root, p)),
      ext: extOf(p),
    }));
    const previewOnly = f.targets.filter((t) => made.has(t.ext)).every((t) => t.preview);
    const needs = this.needsOf(f);
    const before = await readManifest(root, path);
    const fresh =
      before && before.sourceSize === st.size && before.sourceModifiedAt === st.mtime.toISOString();
    const manifest: Manifest = {
      source: toPosix(path),
      sourceSize: st.size,
      sourceModifiedAt: st.mtime.toISOString(),
      format: f.id,
      outputs: fresh
        ? [...before.outputs.filter((x) => !outputs.some((y) => y.path === x.path)), ...outputs]
        : outputs,
      losses: fresh ? [...new Set([...before.losses, ...losses])] : [...losses],
      via: fresh ? [...new Set([...before.via, ...via])] : [...via],
      convertedAt: (this.o.now?.() ?? new Date()).toISOString(),
      ...(previewOnly && { previewOnly }),
      ...(f.needs && { needs: f.needs }),
    };
    await writeFile(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    return {
      path,
      dir: toPosix(relDir),
      outputs,
      losses: [...losses],
      lossCodes: lossCodesOf([...losses]),
      skipped,
      ...(previewOnly && { previewOnly }),
      ...(needs && { needs }),
    };
  }

  /**
   * The targets a conversion makes. Without `to`: the default one, our own code's, and those
   * whose program is already here (nothing big comes down unasked). With `to`: those.
   */
  private chosen(f: FormatInfo, wanted: string[] | undefined): Target[] {
    return f.targets.filter((t, i) =>
      wanted
        ? wanted.includes(t.ext)
        : !t.asked && (i === 0 || t.via === "js" || this.o.programs.find(t.via) !== undefined),
    );
  }

  /** The outside programs a conversion will need (the UI's job gets them first, with its bar). */
  async programsFor(root: string, path: string, to?: string[]): Promise<ProgramId[]> {
    const abs = await new LocalWorkspace(root).resolve(path);
    const f = await formatOfFile(abs);
    if (!f) return [];
    const wanted = wantedOf(f, to);
    return [
      ...new Set(
        this.chosen(f, wanted)
          .map((t) => t.via)
          .filter((v): v is ProgramId => v !== "js"),
      ),
    ];
  }

  /** Our own conversions: everything they make at once (an ORA comes with its PNG). */
  private async js(
    f: FormatInfo,
    t: Target,
    ws: LocalWorkspace,
    abs: string,
    stem: string,
    size: number,
  ): Promise<Converted> {
    if (size > MAX_JS_BYTES)
      throw new ConvertError(`${basename(abs)} is larger than 1 GB: too big to convert here`);
    const bytes = new Uint8Array(await readFile(abs));
    const preview = (p: ReturnType<typeof embeddedPreview>, what: string): Converted => {
      if (!p) throw new ConvertError(`${basename(abs)} carries no preview ${what}`);
      return { files: { [`${stem}.preview.${p.ext}`]: p.data }, losses: [] };
    };
    switch (f.id) {
      case "psd":
        return psdToOra(bytes, stem);
      case "ai-pdf":
        // A modern Illustrator file is a PDF: the same bytes, under the open format's name.
        return { files: { [`${stem}.pdf`]: bytes }, losses: [] };
      case "idml": {
        const z = unzip(bytes);
        if (!z) throw new ConvertError("This IDML is not a valid zip");
        if (t.ext === "odt") return idmlToOdt(z, stem);
        const found = await this.idmlPictures(ws, abs, z);
        const pictures: Record<string, Uint8Array> = {};
        for (const [uri, p] of Object.entries(found))
          pictures[uri] = new Uint8Array(await readFile(p));
        const { files, losses } = idmlToOdg(z, stem, pictures);
        return { files, losses };
      }
      case "sketch": {
        const z = unzip(bytes);
        if (!z) throw new ConvertError("This Sketch file is not a valid zip (Sketch 43 or newer)");
        if (t.ext === "svg") return sketchToSvg(z, stem);
        if (t.ext === "txt")
          return {
            files: { [`${stem}.outline.txt`]: new TextEncoder().encode(sketchOutline(z)) },
            losses: [],
          };
        return preview(zipPreview(z), "picture");
      }
      case "fig":
      case "xd": {
        const z = unzip(bytes);
        return preview(z ? zipPreview(z) : embeddedPreview(bytes), "picture");
      }
      case "indd":
      case "affinity":
        return preview(embeddedPreview(bytes), "picture");
      default:
        throw new ConvertError(`No converter for ${f.name}`);
    }
  }

  /**
   * The pictures an IDML links to, found beside it (or in a Links folder there), inside the
   * workspace only: link → absolute path.
   */
  private async idmlPictures(
    ws: LocalWorkspace,
    abs: string,
    entries: Record<string, Uint8Array>,
  ): Promise<Record<string, string>> {
    const rel = toPosix(relative(ws.root, dirname(abs)));
    const out: Record<string, string> = {};
    for (const uri of idmlLinks(entries)) {
      const name = linkName(uri);
      if (!name || name.includes("..")) continue;
      for (const sub of ["", "Links/", "links/"]) {
        const p = await ws.resolve(`${rel ? `${rel}/` : ""}${sub}${name}`).catch(() => undefined);
        if (
          p &&
          (await stat(p).then(
            (x) => x.isFile(),
            () => false,
          ))
        ) {
          out[uri] = p;
          break;
        }
      }
    }
    return out;
  }

  /** LibreOffice, Ghostscript or ffmpeg, each with its own arguments. */
  private async external(
    f: FormatInfo,
    t: Target,
    ws: LocalWorkspace,
    abs: string,
    stem: string,
    work: string,
    made: Map<string, string>,
    o: { owner: string; signal?: AbortSignal | undefined; onProgram?: (id: ProgramId) => void },
  ): Promise<void> {
    const id = t.via as ProgramId;
    const program = await this.o.programs.ensure(o.owner, id);
    o.onProgram?.(id);
    const dir = dirname(work);
    const check = (r: { exitCode: number | null; stderr: string; stdout: string }) => {
      if (r.exitCode === 0) return;
      const out = (r.stderr || r.stdout).trim();
      // A server without a desktop lacks the libraries LibreOffice's AppImage expects.
      const lib = out.match(/error while loading shared libraries: ([^:\s]+)/)?.[1];
      throw new ConvertError(
        lib
          ? `${PROGRAMS[id].name} needs a system library this computer lacks (${lib}). On Debian or Ubuntu: sudo apt install ${LIBREOFFICE_LIBS}`
          : `${PROGRAMS[id].name} stopped (${r.exitCode ?? "timeout"}): ${out.slice(-300)}`,
      );
    };
    const into = async (from: string, ext: string) => {
      const out = join(dir, `${stem}.${ext}`);
      await rename(from, out).catch(async () => {
        await copyFile(from, out);
        await rm(from, { force: true });
      });
      made.set(ext, out);
    };
    if (id === "ghostscript") {
      const out = join(work, `${stem}.pdf`);
      check(
        await this.run(
          id,
          program,
          commands.ghostscript(abs, out, f.id === "eps" && extOf(abs) !== "ps"),
          5 * 60_000,
          o.signal,
        ),
      );
      await into(out, "pdf");
      return;
    }
    if (id === "scribus") {
      // The links pointed at the pictures found here, the script beside it; the SLA is saved
      // where it stays (Scribus writes the pictures' paths relative to it).
      const z = unzip(new Uint8Array(await readFile(abs)));
      if (!z) throw new ConvertError("This IDML is not a valid zip");
      const input = join(work, `${stem}.idml`);
      await writeFile(input, rezip(relinkIdml(z, await this.idmlPictures(ws, abs, z))));
      const script = join(work, "redgiant_scribus.py");
      await writeFile(script, SCRIBUS_SCRIPT);
      const sla = join(dir, `${stem}.sla`);
      const pdf = join(work, `${stem}.pdf`);
      const xvfb = this.o.xvfbRun === null ? undefined : (this.o.xvfbRun ?? findXvfbRun());
      const cmd = commands.scribus(program, script, input, sla, pdf, {
        platform: this.o.platform ?? process.platform,
        display: this.o.display ?? process.env.DISPLAY,
        xvfbRun: xvfb,
      });
      const r = await this.run(id, cmd.file, cmd.args, 10 * 60_000, o.signal, work);
      if (/no fonts found/i.test(`${r.stdout}${r.stderr}`))
        throw new ConvertError(
          `Scribus found no fonts on this computer: sudo apt install ${SCRIBUS_LIBS}`,
        );
      check(r);
      if (
        !(await stat(sla).then(
          () => true,
          () => false,
        ))
      )
        throw new ConvertError(`Scribus made no SLA: ${(r.stderr || r.stdout).slice(-300)}`);
      made.set("sla", sla);
      if (
        await stat(pdf).then(
          () => true,
          () => false,
        )
      )
        await into(pdf, "pdf");
      return;
    }
    if (id === "blender") {
      const script = join(work, "redgiant_blender_convert.py");
      await writeFile(script, BLENDER_CONVERT_SCRIPT);
      const out = join(work, `${stem}.${t.ext}`);
      check(
        await this.run(
          id,
          program,
          blenderCommands.script(script, [abs, out]),
          20 * 60_000,
          o.signal,
          work,
        ),
      );
      await into(out, t.ext);
      return;
    }
    if (id === "ffmpeg") {
      const out = join(work, `${stem}.${t.ext}`);
      check(await this.run(id, program, commands.ffmpeg(abs, out, t.ext), 60 * 60_000, o.signal));
      await into(out, t.ext);
      return;
    }
    // LibreOffice: from the original, or from the PDF made a step before (Illustrator, EPS).
    let input = abs;
    let fromPdf = f.id === "pdf";
    if (["ai-pdf", "ai-ps", "eps"].includes(f.id)) {
      const pdf = made.get("pdf");
      if (!pdf) throw new ConvertError("the PDF copy is needed first (ask for pdf too)");
      input = pdf;
      fromPdf = true;
    }
    // IDML: the PDF is printed from our ODG.
    if (f.id === "idml") {
      const odg = made.get("odg");
      if (!odg) throw new ConvertError("the ODG copy is needed first (ask for odg too)");
      input = odg;
    }
    const outDir = join(work, "lo");
    await mkdir(outDir, { recursive: true });
    check(
      await this.office(
        program,
        (profile) => commands.libreoffice(input, outDir, t.ext, profile, fromPdf),
        10 * 60_000,
        o.signal,
      ),
    );
    await into(join(outDir, `${stemOf(input)}.${t.ext}`), t.ext);
  }

  /** Where a file's paged preview is cached: a key from its path, change time and size. */
  async previewState(root: string, path: string): Promise<PreviewState> {
    if (!this.o.previewDir) throw new ConvertError("Previews are not set up here");
    const abs = await new LocalWorkspace(root).resolve(path);
    const st = await stat(abs).catch(() => undefined);
    if (!st?.isFile()) throw new ConvertError(`There is no file "${path}"`);
    const f = await formatOfFile(abs);
    if (!f || !PREVIEWABLE.has(f.id))
      throw new ConvertError(
        `${basename(path)} has no paged preview (${f?.name ?? "unknown format"})`,
      );
    const key = createHash("sha256")
      .update(`${abs}\0${Math.floor(st.mtimeMs)}\0${st.size}`)
      .digest("hex")
      .slice(0, 32);
    const pdf = join(this.o.previewDir, `${key}.pdf`);
    return {
      pdf,
      ready: await stat(pdf).then(
        () => true,
        () => false,
      ),
    };
  }

  /**
   * The paged preview (PDF) of a document, made with LibreOffice if not cached yet. One making per
   * file at a time (p3.5.7, the person's test of 3.5.6: canvas_look right after show_file said
   * «LibreOffice made no PDF», the page's preview and the look writing in the same work folder):
   * an ask while it is being made waits for that one; if that one fails, and this ask was not
   * stopped, it is made once more.
   */
  async preview(
    root: string,
    path: string,
    o: { owner: string; signal?: AbortSignal | undefined },
  ): Promise<string> {
    const state = await this.previewState(root, path);
    if (state.ready) return state.pdf;
    const running = this.making.get(state.pdf);
    if (running) {
      const joined = await running.then(
        (pdf) => ({ pdf }),
        (err: unknown) => ({ err }),
      );
      if ("pdf" in joined) return joined.pdf;
      if (o.signal?.aborted) throw joined.err;
      const again = await this.previewState(root, path);
      if (again.ready) return again.pdf;
      const other = this.making.get(state.pdf);
      if (other) return other;
    }
    const made = this.makePreview(root, path, state.pdf, o);
    this.making.set(state.pdf, made);
    try {
      return await made;
    } finally {
      if (this.making.get(state.pdf) === made) this.making.delete(state.pdf);
    }
  }

  /** LibreOffice prints the document into a work folder of this run's own; once more on «no PDF». */
  private async makePreview(
    root: string,
    path: string,
    pdf: string,
    o: { owner: string; signal?: AbortSignal | undefined },
  ): Promise<string> {
    const abs = await new LocalWorkspace(root).resolve(path);
    const soffice = await this.o.programs.ensure(o.owner, "libreoffice");
    for (let attempt = 1; ; attempt++) {
      await mkdir(dirname(pdf), { recursive: true });
      const work = await mkdtemp(`${pdf}.work-`);
      try {
        const r = await this.office(
          soffice,
          (profile) => commands.libreoffice(abs, work, "pdf", profile, false),
          10 * 60_000,
          o.signal,
        );
        if (r.exitCode !== 0) {
          const out = (r.stderr || r.stdout).trim();
          const lib = out.match(/error while loading shared libraries: ([^:\s]+)/)?.[1];
          throw new ConvertError(
            lib
              ? `LibreOffice needs a system library this computer lacks (${lib}). On Debian or Ubuntu: sudo apt install ${LIBREOFFICE_LIBS}`
              : `LibreOffice stopped (${r.exitCode ?? "timeout"}): ${out.slice(-300)}`,
          );
        }
        const made = join(work, `${stemOf(abs)}.pdf`);
        if (
          await stat(made).then(
            () => true,
            () => false,
          )
        ) {
          await rename(made, pdf);
          return pdf;
        }
        // LibreOffice said yes and wrote nothing (a moment's clash with another run): once more.
        if (attempt >= 2 || o.signal?.aborted) throw new ConvertError("LibreOffice made no PDF");
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }
  }
}

/**
 * The targets asked for, with the steps they need first: Illustrator and PostScript reach SVG
 * and ODG through their PDF copy; an IDML's PDF is printed from its ODG (unless Scribus makes it).
 */
function wantedOf(f: FormatInfo, to: string[] | undefined): string[] | undefined {
  const wanted = to?.map((x) => x.toLowerCase().replace(/^\./, ""));
  if (!wanted) return undefined;
  if (["ai-pdf", "ai-ps", "eps"].includes(f.id) && !wanted.includes("pdf"))
    if (wanted.some((x) => x === "svg" || x === "odg")) wanted.unshift("pdf");
  if (
    f.id === "idml" &&
    wanted.includes("pdf") &&
    !wanted.includes("sla") &&
    !wanted.includes("odg")
  )
    wanted.unshift("odg");
  return wanted;
}

export async function readManifest(root: string, path: string): Promise<Manifest | null> {
  try {
    const p = await new LocalWorkspace(root).resolve(join(openDirOf(path), MANIFEST));
    return JSON.parse(await readFile(p, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

/** The key and the frame of a Figma link (`node-id=1-2` is the node 1:2). */
export function figmaLink(url: string): { key: string; nodeId?: string } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (!/(^|\.)figma\.com$/.test(u.hostname)) return undefined;
  const m = u.pathname.match(/^\/(?:file|design|proto|board)\/([A-Za-z0-9]+)/);
  if (!m?.[1]) return undefined;
  const node = u.searchParams.get("node-id");
  return { key: m[1], ...(node && { nodeId: node.replace("-", ":") }) };
}

/** A GET to Figma's API with the person's credential (the server puts it on, never the agent). */
export type FigmaGet = (url: string) => Promise<{ status: number; body: string }>;

/**
 * Exports a Figma file's frames (or the one in the link) through Figma's API, into `dir` inside
 * the workspace. Figma answers with addresses of the pictures, fetched without the credential.
 */
export async function figmaExport(
  root: string,
  url: string,
  format: "svg" | "pdf" | "png",
  get: FigmaGet,
  o: { dir?: string; fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ dir: string; outputs: string[]; losses: string[] }> {
  const link = figmaLink(url);
  if (!link) throw new ConvertError(`Not a Figma file link: ${url}`);
  const api = "https://api.figma.com/v1";
  const json = async (u: string) => {
    const r = await get(u);
    if (r.status >= 400)
      throw new ConvertError(`Figma answered ${r.status}: ${r.body.slice(0, 300)}`);
    try {
      return JSON.parse(r.body) as Record<string, unknown>;
    } catch {
      throw new ConvertError(
        "Figma's answer was too long to read: give the link of one frame (right click > Copy link to selection)",
      );
    }
  };
  type FNode = { id: string; name: string; type: string; children?: FNode[] };
  let nodes: FNode[];
  let fileName = link.key;
  if (link.nodeId)
    nodes = [{ id: link.nodeId, name: link.nodeId.replace(":", "-"), type: "FRAME" }];
  else {
    const file = (await json(`${api}/files/${link.key}?depth=2`)) as {
      name?: string;
      document?: { children?: FNode[] };
    };
    fileName = file.name ?? link.key;
    nodes = (file.document?.children ?? [])
      .flatMap((page) => page.children ?? [])
      .filter((n) => ["FRAME", "COMPONENT", "COMPONENT_SET", "SECTION", "GROUP"].includes(n.type))
      .slice(0, 50);
    if (nodes.length === 0) throw new ConvertError("The Figma file has no frames to export");
  }
  const ids = nodes.map((n) => n.id).join(",");
  const images = (await json(
    `${api}/images/${link.key}?ids=${encodeURIComponent(ids)}&format=${format}${format === "png" ? "&scale=2" : ""}`,
  )) as { err?: string | null; images?: Record<string, string | null> };
  if (images.err) throw new ConvertError(`Figma could not export: ${images.err}`);
  const safe = (s: string) => s.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "frame";
  const rel = o.dir ?? `figma-${safe(fileName)}`;
  const ws = new LocalWorkspace(root);
  const dirAbs = await ws.resolve(rel);
  await mkdir(dirAbs, { recursive: true });
  const outputs: string[] = [];
  const failed: string[] = [];
  for (const n of nodes) {
    const src = images.images?.[n.id];
    if (!src) {
      failed.push(n.name);
      continue;
    }
    const at = new URL(src);
    // Only Figma's own picture storage; never somewhere the answer could point us to.
    if (at.protocol !== "https:" || !/(\.amazonaws\.com|\.figma\.com)$/.test(at.hostname)) {
      failed.push(n.name);
      continue;
    }
    const r = await (o.fetch ?? fetch)(src, o.signal ? { signal: o.signal } : {});
    if (!r.ok) {
      failed.push(n.name);
      continue;
    }
    const name = `${safe(n.name)}.${format}`;
    await writeFile(join(dirAbs, name), new Uint8Array(await r.arrayBuffer()));
    outputs.push(toPosix(join(rel, name)));
  }
  return {
    dir: toPosix(rel),
    outputs,
    losses: [
      ...(format === "png" ? ["PNG is pixels: export SVG or PDF to keep the vectors"] : []),
      ...(format === "svg"
        ? [
            "text becomes outlines unless the fonts are installed; prototypes and components' behaviour are not kept",
          ]
        : []),
      ...(failed.length ? [`not exported: ${failed.slice(0, 10).join(", ")}`] : []),
    ],
  };
}

// LibreOffice headless for the document family (G37.4): applies actions to a file with UNO when
// no page has the full editor open (or the page closed before saving), and writes the copy of a
// closed format back when the person asked. One LibreOffice at a time on its own profile; its
// own Python (or the system's, with `uno`), run without a shell and with the agents' environment
// (never the server's secrets). LibreOffice not here yet: it comes down in the background (the
// person sees the bar) and the save is tried again.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { OfficePlainAction } from "@redgiant/protocol";
import { execRunner, type Programs, type Runner } from "../convert-programs.js";
import { SaveWaits } from "./family.js";
import { OFFICE_UNO_SCRIPT } from "./office-uno.js";

export interface EngineResult {
  bytes: Uint8Array;
  /** The actions that did not fit (index and reason), skipped. */
  skipped: { index: number; error: string }[];
}

/** What applies actions to a document's bytes (tests pass a fake). */
export interface OfficeEngine {
  apply(
    owner: string,
    bytes: Uint8Array,
    ops: readonly OfficePlainAction[],
    app: "writer" | "impress",
  ): Promise<EngineResult>;
  /** A copy in another format (export, the closed format written back). */
  convert(owner: string, bytes: Uint8Array, from: string, to: string): Promise<Uint8Array>;
}

/** LibreOffice is not here yet (it is coming down): the host tries the save again. */
export class EngineMissingError extends SaveWaits {}

/** Python candidates for a soffice: its own first (Windows, macOS, The Document Foundation's builds). */
export function pythonCandidates(soffice: string, platform: string = process.platform): string[] {
  const dir = dirname(soffice);
  const out =
    platform === "win32"
      ? [join(dir, "python.exe")]
      : platform === "darwin"
        ? [join(dir, "..", "Resources", "python"), join(dir, "python")]
        : [join(dir, "python"), join(dir, "python3")];
  out.push(platform === "win32" ? "python" : "python3");
  return out;
}

class Queue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(f: () => Promise<T>): Promise<T> {
    const next = this.tail.then(f, f);
    this.tail = next.catch(() => {});
    return next;
  }
}

const FILTERS: Record<string, string> = {
  odt: "writer8",
  odp: "impress8",
  docx: "MS Word 2007 XML",
  doc: "MS Word 97",
  rtf: "Rich Text Format",
  pptx: "Impress MS PowerPoint 2007 XML",
  ppt: "MS PowerPoint 97",
  pdf: "pdf",
};
export const exportFilter = (from: string, to: string): string | undefined =>
  to === "pdf" ? (from === "odp" ? "impress_pdf_Export" : "writer_pdf_Export") : FILTERS[to];

export class LibreOfficeEngine implements OfficeEngine {
  private readonly queue = new Queue();
  private python: { soffice: string; python: string } | undefined;

  constructor(
    private readonly o: {
      programs: Pick<Programs, "find" | "ensure" | "canDownload">;
      dataDir: string;
      run?: Runner;
      platform?: NodeJS.Platform;
    },
  ) {}

  private get dir() {
    return join(this.o.dataDir, "tools", "redgiant-office");
  }

  /** soffice and a Python that imports uno; LibreOffice missing: its download starts. */
  private async ready(owner: string): Promise<{ soffice: string; python: string }> {
    const soffice = this.o.programs.find("libreoffice");
    if (!soffice) {
      if (this.o.programs.canDownload("libreoffice")) {
        void this.o.programs.ensure(owner, "libreoffice").catch(() => {});
        throw new EngineMissingError(
          "LibreOffice is downloading (it applies the edits when the full editor is not open): the file is written when it is here",
          "libreoffice",
        );
      }
      throw new EngineMissingError(
        "LibreOffice is not on this computer: the edits are kept and the file is written when it is",
      );
    }
    if (this.python?.soffice === soffice) return this.python;
    const run = this.o.run ?? execRunner;
    for (const py of pythonCandidates(soffice, this.o.platform)) {
      if (py.includes("/") || py.includes("\\")) if (!existsSync(py)) continue;
      const r = await run(py, ["-c", "import uno"], { timeoutMs: 20_000 }).catch(() => undefined);
      if (r?.exitCode === 0) {
        this.python = { soffice, python: py };
        return this.python;
      }
    }
    throw new EngineMissingError(
      "LibreOffice's Python is missing (on Debian or Ubuntu: sudo apt install python3-uno)",
    );
  }

  apply(
    owner: string,
    bytes: Uint8Array,
    ops: readonly OfficePlainAction[],
    app: "writer" | "impress",
  ): Promise<EngineResult> {
    return this.queue.run(async () => {
      const { soffice, python } = await this.ready(owner);
      await mkdir(this.dir, { recursive: true });
      const script = join(this.dir, "office_uno.py");
      const have = await readFile(script, "utf8").catch(() => "");
      if (have !== OFFICE_UNO_SCRIPT) await writeFile(script, OFFICE_UNO_SCRIPT);
      const work = join(this.o.dataDir, "cache", "office-edit", randomUUID());
      await mkdir(work, { recursive: true });
      const ext = app === "writer" ? "odt" : "odp";
      try {
        const input = join(work, `in.${ext}`);
        const output = join(work, `out.${ext}`);
        await writeFile(input, bytes);
        const spec = {
          soffice,
          input,
          output,
          filter: FILTERS[ext],
          ops,
          blobs: join(this.o.dataDir, "editor", "blobs"),
          profile: pathToFileURL(join(this.o.dataDir, "tools", "libreoffice-profile-office")).href,
        };
        const specFile = join(work, "spec.json");
        await writeFile(specFile, JSON.stringify(spec));
        const run = this.o.run ?? execRunner;
        const r = await run(python, [script, specFile], { timeoutMs: 180_000, cwd: work });
        const line = r.stdout.split("\n").find((l) => l.startsWith("RG-RESULT "));
        const res = line
          ? (JSON.parse(line.slice(10)) as {
              ok: boolean;
              results: (string | null)[];
              error?: string;
            })
          : undefined;
        if (!res?.ok)
          throw new Error(
            `LibreOffice could not apply the edits: ${res?.error ?? (r.stderr.trim().split("\n").pop() || `exit ${r.exitCode}`)}`,
          );
        const out = await readFile(output);
        return {
          bytes: new Uint8Array(out),
          skipped: res.results.flatMap((e, index) => (e ? [{ index, error: e }] : [])),
        };
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  convert(owner: string, bytes: Uint8Array, from: string, to: string): Promise<Uint8Array> {
    return this.queue.run(async () => {
      const { soffice } = await this.ready(owner);
      const filter = exportFilter(from, to);
      if (!filter) throw new Error(`.${from} cannot be written as .${to}`);
      const work = join(this.o.dataDir, "cache", "office-edit", randomUUID());
      await mkdir(work, { recursive: true });
      try {
        const input = join(work, `doc.${from}`);
        await writeFile(input, bytes);
        const run = this.o.run ?? execRunner;
        const r = await run(
          soffice,
          [
            "--headless",
            "--norestore",
            "--nolockcheck",
            "--nodefault",
            `-env:UserInstallation=${pathToFileURL(join(this.o.dataDir, "tools", "libreoffice-profile-office")).href}`,
            "--convert-to",
            `${to}:${filter}`,
            "--outdir",
            join(work, "out"),
            input,
          ],
          { timeoutMs: 180_000, cwd: work },
        );
        const out = await readFile(join(work, "out", `doc.${to}`)).catch(() => undefined);
        if (!out)
          throw new Error(
            `LibreOffice did not write the .${to}: ${r.stderr.trim().split("\n").pop() || `exit ${r.exitCode}`}`,
          );
        return new Uint8Array(out);
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {});
      }
    });
  }
}

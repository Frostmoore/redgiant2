import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalWorkspace } from "@redgiant/tools";
import { decode as decodePng } from "fast-png";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commands, FileConverter, figmaExport, figmaLink, readManifest } from "../src/convert.js";
import { detectFormat, knownFormats, needsConversion } from "../src/convert-formats.js";
import { parseXml, renderOra } from "../src/convert-js.js";
import {
  downloadLibreOffice,
  findGhostscript,
  findLibreOffice,
  newestVersion,
  type ProgramId,
  Programs,
  type Runner,
} from "../src/convert-programs.js";
import { convertFileTool, editPackageTool, xmlProblem } from "../src/convert-tools.js";
import { Jobs } from "../src/jobs.js";
import {
  affinitySample,
  aviSample,
  docxSample,
  epsSample,
  figSample,
  idmlSample,
  inddSample,
  pdfSample,
  psdSample,
  sketchSample,
} from "./fixtures/convert-samples.js";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ctx = { ownerId: "me", projectId: null, agentId: "a", sessionId: "s" } as never;
const text = (r: unknown) => (typeof r === "string" ? r : (r as { content: string }).content);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rg-convert-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A converter whose outside programs are fakes that record their arguments. */
function fakeConverter(present: ProgramId[] = ["libreoffice", "ghostscript", "ffmpeg"]) {
  const calls: { file: string; args: string[] }[] = [];
  const run: Runner = async (file, args) => {
    calls.push({ file, args });
    // Each fake writes what the real program would.
    if (file === "/bin/soffice") {
      const outDir = args[args.indexOf("--outdir") + 1] as string;
      const input = args.at(-1) as string;
      const ext = (args[args.indexOf("--convert-to") + 1] as string).split(":")[0];
      const stem = (input.split("/").pop() as string).replace(/\.[^.]+$/, "");
      await writeFile(join(outDir, `${stem}.${ext}`), `made by soffice from ${input}`);
    } else if (file === "/bin/gs") {
      const out = (args.find((a) => a.startsWith("-sOutputFile=")) as string).slice(13);
      await writeFile(out.replace(/%%/g, "%"), "%PDF-1.4 from gs");
    } else if (file === "/bin/ffmpeg") await writeFile(args.at(-1) as string, "media");
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const where: Record<ProgramId, string> = {
    libreoffice: "/bin/soffice",
    ghostscript: "/bin/gs",
    ffmpeg: "/bin/ffmpeg",
  };
  const programs = new Programs({
    jobs: new Jobs(),
    dataDir: join(root, ".data"),
    find: (id) => (present.includes(id) ? where[id] : undefined),
    download: { platform: "linux", arch: "riscv" },
  });
  const converter = new FileConverter({
    programs,
    profileDir: "/data/lo-profile",
    run,
    previewDir: join(root, ".data", "previews"),
  });
  return { converter, calls, programs };
}

async function put(name: string, bytes: Uint8Array) {
  const p = join(root, name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, bytes);
  return p;
}

describe("formats", () => {
  it("knows formats by name and by their first bytes", () => {
    const pdf = pdfSample();
    expect(detectFormat("logo.ai", pdf)?.id).toBe("ai-pdf");
    expect(detectFormat("old.ai", epsSample())?.id).toBe("ai-ps");
    expect(detectFormat("x.psd", psdSample())?.id).toBe("psd");
    expect(detectFormat("renamed.bin", psdSample())?.id).toBe("psd");
    expect(detectFormat("b.indd", inddSample())?.id).toBe("indd");
    expect(detectFormat("noext", inddSample())?.id).toBe("indd");
    expect(detectFormat("a.zip", new Uint8Array([0x50, 0x4b]), ["designmap.xml"])?.id).toBe("idml");
    expect(detectFormat("a", new Uint8Array(), ["document.json", "meta.json"])?.id).toBe("sketch");
    expect(
      detectFormat("w", new Uint8Array(), ["[Content_Types].xml", "word/document.xml"])?.id,
    ).toBe("docx");
    expect(detectFormat("file.unknown", new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(detectFormat("doc.pdf")?.open).toBe(true);
  });

  it("says which formats are closed and what each becomes", () => {
    const closed = knownFormats()
      .filter(needsConversion)
      .map((f) => f.id);
    for (const id of [
      "psd",
      "ai-pdf",
      "eps",
      "idml",
      "indd",
      "sketch",
      "fig",
      "affinity",
      "docx",
      "xlsx",
      "pptx",
      "avi",
    ])
      expect(closed).toContain(id);
    for (const id of ["png", "svg", "pdf", "ora", "odt", "sla", "webm"])
      expect(closed).not.toContain(id);
    expect(detectFormat("x.docx")?.targets[0]).toMatchObject({ ext: "odt", via: "libreoffice" });
    expect(detectFormat("x.psd")?.targets.map((t) => t.ext)).toEqual(["ora", "png"]);
    expect(detectFormat("x.psd")?.note).toMatch(/convert it first/);
  });
});

describe("our own conversions", () => {
  it("turns a PSD into OpenRaster with its layers, a PNG and the texts, leaving it intact", async () => {
    const psd = psdSample();
    await put("art/poster.psd", psd);
    const { converter, calls } = fakeConverter([]);
    const r = await converter.convert(root, "art/poster.psd", { owner: "me" });
    expect(calls).toEqual([]);
    expect(r.dir).toBe("art/poster.psd.open");
    expect(r.outputs.map((o) => o.path).sort()).toEqual([
      "art/poster.psd.open/layers.json",
      "art/poster.psd.open/poster.ora",
      "art/poster.psd.open/poster.png",
    ]);
    expect(sha(await readFile(join(root, "art/poster.psd")))).toBe(sha(psd));
    const oraBytes = new Uint8Array(await readFile(join(root, "art/poster.psd.open/poster.ora")));
    // The OpenRaster rule: "mimetype" is the first entry, stored without compression.
    expect(strFromU8(oraBytes.subarray(30, 38))).toBe("mimetype");
    expect(oraBytes[8]).toBe(0);
    const ora = unzipSync(oraBytes);
    expect(strFromU8(ora.mimetype as Uint8Array)).toBe("image/openraster");
    const stack = strFromU8(ora["stack.xml"] as Uint8Array);
    // Topmost first: Title, then the group with Red, then the background.
    expect(stack.indexOf('name="Title"')).toBeLessThan(stack.indexOf('name="Group"'));
    expect(stack.indexOf('name="Red"')).toBeLessThan(stack.indexOf('name="Background"'));
    expect(stack).toMatch(/<stack name="Group"[^>]*isolation="auto"/);
    expect(stack).toMatch(
      /name="Red" opacity="0.502?" visibility="visible" composite-op="svg:multiply" src="data\/layer\d.png" x="2" y="1"/,
    );
    expect(ora["mergedimage.png"]).toBeDefined();
    expect(ora["Thumbnails/thumbnail.png"]).toBeDefined();
    const layers = JSON.parse(
      await readFile(join(root, "art/poster.psd.open/layers.json"), "utf8"),
    );
    expect(layers.find((l: { name: string }) => l.name === "Title")).toMatchObject({
      kind: "text",
      text: "Hello",
      font: "ArialMT",
    });
    expect(r.losses.join("\n")).toMatch(/layer effects .*Title/);
    expect(r.losses.join("\n")).toMatch(/text layer kept as pixels/);
    const m = await readManifest(root, "art/poster.psd");
    expect(m).toMatchObject({ source: "art/poster.psd", format: "psd", via: ["js"] });
  });

  it("knows when the original changed after its conversion", async () => {
    await put("p.psd", psdSample());
    const { converter } = fakeConverter([]);
    expect((await converter.inspect(root, "p.psd")).converted).toBeNull();
    await converter.convert(root, "p.psd", { owner: "me" });
    const before = await converter.inspect(root, "p.psd");
    expect(before).toMatchObject({
      needsConversion: true,
      suggested: true,
      converted: { stale: false },
    });
    await utimes(join(root, "p.psd"), new Date(), new Date(Date.now() + 5000));
    expect((await converter.inspect(root, "p.psd")).converted?.stale).toBe(true);
  });

  it("draws an OpenRaster's layers again (normal blending, opacity, offsets)", async () => {
    await put("p.psd", psdSample());
    const { converter } = fakeConverter([]);
    await converter.convert(root, "p.psd", { owner: "me" });
    const ora = unzipSync(new Uint8Array(await readFile(join(root, "p.psd.open/p.ora"))));
    const r = renderOra(ora);
    expect(r.approximated.join()).toMatch(/svg:multiply on «Red»/);
    const img = decodePng(r.merged);
    expect([img.width, img.height]).toEqual([8, 6]);
    const px = (x: number, y: number) =>
      Array.from(img.data.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4));
    expect(px(0, 0)).toEqual([255, 255, 255, 255]); // the background alone
    expect(px(1, 1)).toEqual([0, 0, 0, 255]); // the title on top
    const pink = px(5, 2); // red at half opacity over white (drawn as normal)
    expect(pink[0]).toBe(255);
    expect(pink[1]).toBeGreaterThan(120);
    expect(pink[1]).toBeLessThan(135);
  });

  it("turns an IDML's stories into an ODT with their styles", async () => {
    await put("b.idml", idmlSample());
    const { converter } = fakeConverter([]);
    const r = await converter.convert(root, "b.idml", { owner: "me" });
    expect(r.outputs.map((o) => o.path)).toEqual(["b.idml.open/b.odt"]);
    const odt = unzipSync(new Uint8Array(await readFile(join(root, "b.idml.open/b.odt"))));
    expect(strFromU8(odt.mimetype as Uint8Array)).toBe("application/vnd.oasis.opendocument.text");
    const content = strFromU8(odt["content.xml"] as Uint8Array);
    const styles = strFromU8(odt["styles.xml"] as Uint8Array);
    expect(content).toContain("Spring &amp; Summer");
    expect(content).toContain('text:bookmark text:name="Story_u1"');
    expect(content).toContain('text:style-name="P_Heading_20_1"');
    expect(content).toMatch(/fo:text-align="center"/);
    expect(content).toMatch(/fo:font-weight="bold"/);
    expect(styles).toContain('style:display-name="Heading 1"');
    expect(styles).toContain('fo:font-family="Minion Pro"');
    expect(styles).toMatch(
      /style:display-name="Emphasis"[^>]*><style:text-properties fo:font-style="italic"/,
    );
    expect(xmlProblem(content)).toBeUndefined();
    expect(xmlProblem(styles)).toBeUndefined();
    expect(r.losses.join("\n")).toMatch(/1 placed image.*beach\.jpg/);
    expect(r.losses.join("\n")).toMatch(/page layout/);
  });

  it("takes the previews stored in INDD, Affinity, Sketch and Figma files", async () => {
    const { converter } = fakeConverter([]);
    await put("b.indd", inddSample());
    const indd = await converter.convert(root, "b.indd", { owner: "me" });
    expect(indd.outputs[0]?.path).toBe("b.indd.open/b.preview.jpg");
    expect((await readFile(join(root, "b.indd.open/b.preview.jpg")))[0]).toBe(0xff);
    expect(indd.losses.join()).toMatch(/IDML/);
    await put("c.afdesign", affinitySample());
    const af = await converter.convert(root, "c.afdesign", { owner: "me" });
    expect(decodePng(await readFile(join(root, af.outputs[0]?.path as string))).width).toBe(3);
    await put("s.sketch", sketchSample());
    const sk = await converter.convert(root, "s.sketch", { owner: "me" });
    expect(sk.outputs.map((o) => o.path).sort()).toEqual([
      "s.sketch.open/s.outline.txt",
      "s.sketch.open/s.preview.png",
    ]);
    const outline = await readFile(join(root, "s.sketch.open/s.outline.txt"), "utf8");
    expect(outline).toContain("artboard «Desktop» (1440 x 900)");
    expect(outline).toContain("text «Title»: Welcome home");
    await put("f.fig", figSample());
    const fig = await converter.convert(root, "f.fig", { owner: "me" });
    expect(decodePng(await readFile(join(root, fig.outputs[0]?.path as string))).width).toBe(5);
  });

  it("refuses open formats and targets a format cannot become", async () => {
    const { converter } = fakeConverter([]);
    await put("a.svg", new TextEncoder().encode("<svg/>"));
    await expect(converter.convert(root, "a.svg", { owner: "me" })).rejects.toThrow(/open format/);
    await put("p.psd", psdSample());
    await expect(converter.convert(root, "p.psd", { owner: "me", to: ["docx"] })).rejects.toThrow(
      /cannot become docx/,
    );
  });
});

describe("outside programs", () => {
  it("runs LibreOffice with its own profile, no shell, the output beside the original", async () => {
    await put("docs/letter.docx", docxSample());
    const { converter, calls } = fakeConverter();
    const r = await converter.convert(root, "docs/letter.docx", { owner: "me" });
    // Without `to`: the default (ODT) and, LibreOffice being here, the PDF too.
    expect(r.outputs.map((o) => o.path)).toEqual([
      "docs/letter.docx.open/letter.odt",
      "docs/letter.docx.open/letter.pdf",
    ]);
    expect(calls[0]).toEqual({
      file: "/bin/soffice",
      args: [
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nodefault",
        "--nofirststartwizard",
        "-env:UserInstallation=file:///data/lo-profile",
        "--convert-to",
        "odt",
        "--outdir",
        join(root, "docs/letter.docx.open/.work/lo"),
        join(root, "docs/letter.docx"),
      ],
    });
    expect(r.losses.join()).toMatch(/LibreOffice keeps text/);
    expect(existsSync(join(root, "docs/letter.docx.open/.work"))).toBe(false);
  });

  it("makes an Illustrator file's PDF itself and its SVG through LibreOffice's PDF import", async () => {
    const ai = pdfSample();
    await put("logo.ai", ai);
    const { converter, calls } = fakeConverter();
    const r = await converter.convert(root, "logo.ai", { owner: "me", to: ["svg"] });
    expect(r.outputs.map((o) => o.ext)).toEqual(["pdf", "svg"]);
    expect(sha(await readFile(join(root, "logo.ai.open/logo.pdf")))).toBe(sha(ai));
    expect(calls).toHaveLength(1);
    const args = calls[0]?.args ?? [];
    expect(args).toContain("--infilter=draw_pdf_import");
    expect(args.slice(args.indexOf("--convert-to"), args.indexOf("--convert-to") + 2)).toEqual([
      "--convert-to",
      "svg:draw_svg_Export",
    ]);
    expect(args.at(-1)).toBe(join(root, "logo.ai.open/logo.pdf"));
  });

  it("turns EPS into PDF with Ghostscript (safe mode, %% in names) and media with ffmpeg", async () => {
    expect(commands.ghostscript("/w/in.eps", "/w/50%.pdf", true)).toEqual([
      "-dSAFER",
      "-dBATCH",
      "-dNOPAUSE",
      "-dQUIET",
      "-sDEVICE=pdfwrite",
      "-dEPSCrop",
      "-sOutputFile=/w/50%%.pdf",
      "/w/in.eps",
    ]);
    await put("badge.eps", epsSample());
    await put("clip.avi", aviSample());
    const { converter, calls } = fakeConverter(["ghostscript", "ffmpeg"]);
    const eps = await converter.convert(root, "badge.eps", { owner: "me" });
    expect(eps.outputs.map((o) => o.path)).toEqual(["badge.eps.open/badge.pdf"]);
    expect(calls[0]?.file).toBe("/bin/gs");
    const avi = await converter.convert(root, "clip.avi", { owner: "me" });
    expect(avi.outputs.map((o) => o.path)).toEqual(["clip.avi.open/clip.webm"]);
    expect(calls[1]?.args.slice(0, 7)).toEqual([
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      join(root, "clip.avi"),
      "-c:v",
      "libvpx-vp9",
    ]);
    expect(commands.ffmpeg("/a.wma", "/a.opus", "opus")).toEqual([
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      "/a.wma",
      "-vn",
      "-c:a",
      "libopus",
      "-b:a",
      "128k",
      "/a.opus",
    ]);
  });

  it("says how to install a program it cannot download", async () => {
    await put("badge.eps", epsSample());
    const { converter } = fakeConverter([]);
    await expect(converter.convert(root, "badge.eps", { owner: "me" })).rejects.toThrow(
      /Ghostscript \(AGPL-3.0\).*apt install ghostscript/,
    );
  });

  it("finds programs where people install them", () => {
    const has =
      (...ps: string[]) =>
      (p: string) =>
        ps.includes(p);
    expect(findLibreOffice("/d", { PATH: "/usr/bin" }, "linux", has("/usr/bin/soffice"))).toBe(
      "/usr/bin/soffice",
    );
    expect(
      findLibreOffice(
        "/d",
        { PATH: "", ProgramFiles: "C:\\Program Files" },
        "win32",
        has(join("C:\\Program Files", "LibreOffice", "program", "soffice.com")),
      ),
    ).toBe(join("C:\\Program Files", "LibreOffice", "program", "soffice.com"));
    expect(
      findLibreOffice(
        "/d",
        { PATH: "" },
        "darwin",
        has("/Applications/LibreOffice.app/Contents/MacOS/soffice"),
      ),
    ).toMatch(/LibreOffice.app/);
    expect(
      findLibreOffice("/d", { REDGIANT_LIBREOFFICE: "/x/soffice" }, "linux", has("/x/soffice")),
    ).toBe("/x/soffice");
    expect(
      findGhostscript(
        { PATH: "", ProgramFiles: "C:\\PF" },
        "win32",
        has(join("C:\\PF", "gs", "gs10.08.0", "bin", "gswin64c.exe")),
        () => ["gs10.04.0", "gs10.08.0"],
      ),
    ).toBe(join("C:\\PF", "gs", "gs10.08.0", "bin", "gswin64c.exe"));
    expect(findGhostscript({ PATH: "" }, "darwin", has("/opt/homebrew/bin/gs"))).toBe(
      "/opt/homebrew/bin/gs",
    );
    expect(
      newestVersion('<a href="25.8.7/">x</a><a href="26.8.2/"></a><a href="26.2.10/"></a>'),
    ).toBe("26.8.2");
  });

  it("downloads LibreOffice with its bar and unpacks it without installing (fakes only)", async () => {
    const body = new Uint8Array(3000).fill(1);
    const fetched: string[] = [];
    const fakeFetch = (async (url: string) => {
      fetched.push(String(url));
      if (String(url).endsWith("/stable/"))
        return new Response('<a href="26.2.7/"></a><a href="26.8.2/"></a>');
      return new Response(body, { headers: { "content-length": "3000" } });
    }) as typeof fetch;
    const ran: { file: string; args: string[]; cwd?: string | undefined }[] = [];
    const run: Runner = async (file, args, o) => {
      ran.push({ file, args, cwd: o.cwd });
      if (args[0] === "--appimage-extract") {
        const p = join(o.cwd as string, "squashfs-root", "opt", "libreoffice26.2", "program");
        await mkdir(p, { recursive: true });
        await writeFile(join(p, "soffice"), "");
      }
      if (file === "msiexec") {
        const target = (args.find((a) => a.startsWith("TARGETDIR=")) as string).slice(10);
        await mkdir(join(target, "LibreOffice", "program"), { recursive: true });
        await writeFile(join(target, "LibreOffice", "program", "soffice.com"), "");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const progress: number[] = [];
    const data = join(root, "data");
    const linux = await downloadLibreOffice(
      data,
      (d) => progress.push(d),
      new AbortController().signal,
      () => {},
      {
        fetch: fakeFetch,
        run,
        platform: "linux",
        arch: "x64",
      },
    );
    expect(linux).toBe(
      join(data, "tools/libreoffice/squashfs-root/opt/libreoffice26.2/program/soffice"),
    );
    expect(ran[0]).toMatchObject({
      args: ["--appimage-extract"],
      cwd: join(data, "tools/libreoffice"),
    });
    expect(fetched[0]).toMatch(/LibreOffice-still\.basic-x86_64\.AppImage$/);
    expect(progress.at(-1)).toBe(3000);
    expect(existsSync(join(data, "tools/libreoffice/package.appimage"))).toBe(false);
    // Found again later from the mark it leaves.
    expect(findLibreOffice(data, { PATH: "" }, "linux")).toBe(linux);

    ran.length = 0;
    const win = await downloadLibreOffice(
      data,
      () => {},
      new AbortController().signal,
      () => {},
      {
        fetch: fakeFetch,
        run,
        platform: "win32",
        arch: "x64",
      },
    );
    expect(fetched).toContain(
      "https://download.documentfoundation.org/libreoffice/stable/26.8.2/win/x86_64/LibreOffice_26.8.2_Win_x86-64.msi",
    );
    expect(ran[0]?.args.slice(0, 3)).toEqual([
      "/a",
      join(data, "tools/libreoffice/package.msi"),
      "/qn",
    ]);
    expect(win).toMatch(/soffice\.com$/);
  });

  it("puts the download inside the conversion job, or in a job of its own", async () => {
    const jobs = new Jobs();
    let gotten = false;
    const programs = new Programs({
      jobs,
      dataDir: join(root, "d"),
      find: (id) => (id === "libreoffice" && gotten ? "/bin/soffice" : undefined),
      download: {
        platform: "linux",
        arch: "x64",
        fetch: (async () =>
          new Response(new Uint8Array(10), {
            headers: { "content-length": "10" },
          })) as typeof fetch,
        run: async (_f, _a, o) => {
          const p = join(o.cwd as string, "squashfs-root", "program");
          await mkdir(p, { recursive: true });
          await writeFile(join(p, "soffice"), "");
          gotten = true;
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
    });
    expect(programs.canDownload("libreoffice")).toBe(true);
    expect(programs.canDownload("ghostscript")).toBe(false);
    const path = await programs.ensure("me", "libreoffice");
    expect(path).toMatch(/soffice$/);
    expect(jobs.list("me").map((j) => [j.kind, j.state])).toEqual([
      ["download_libreoffice", "done"],
    ]);
    await expect(programs.ensure("me", "ghostscript")).rejects.toThrow(/Ghostscript/);
  });
});

describe("paged previews", () => {
  it("prints a document to a cached PDF, never beside it, made again when it changes", async () => {
    await put("docs/letter.docx", docxSample());
    const { converter, calls } = fakeConverter();
    const before = await converter.previewState(root, "docs/letter.docx");
    expect(before.ready).toBe(false);
    expect(before.pdf.startsWith(join(root, ".data", "previews"))).toBe(true);
    const pdf = await converter.preview(root, "docs/letter.docx", { owner: "me" });
    expect(pdf).toBe(before.pdf);
    const args = calls[0]?.args ?? [];
    expect(args.slice(args.indexOf("--convert-to"), args.indexOf("--convert-to") + 2)).toEqual([
      "--convert-to",
      "pdf",
    ]);
    expect(args).not.toContain("--infilter=draw_pdf_import");
    expect(args.at(-1)).toBe(join(root, "docs/letter.docx"));
    expect(existsSync(join(root, "docs/letter.docx.open"))).toBe(false);
    // Cached: no second run.
    await converter.preview(root, "docs/letter.docx", { owner: "me" });
    expect(calls).toHaveLength(1);
    await utimes(join(root, "docs/letter.docx"), new Date(), new Date(Date.now() + 5000));
    const after = await converter.previewState(root, "docs/letter.docx");
    expect(after).toMatchObject({ ready: false });
    expect(after.pdf).not.toBe(pdf);
    await put("a.psd", psdSample());
    await expect(converter.previewState(root, "a.psd")).rejects.toThrow(/no paged preview/);
    await expect(converter.previewState(root, "../x.docx")).rejects.toThrow(
      /outside the workspace/,
    );
  });

  it("serves the preview to the page as a job, then at once", async () => {
    const { startServer } = await import("./helpers.js");
    const s = await startServer([]);
    try {
      await s.api("POST", "/api/projects", { name: "Docs" });
      const project = await s.core.projects.get("me", "docs");
      await writeFile(join(project?.path as string, "deck.pptx"), docxSample());
      // LibreOffice "here" as a fake that writes the PDF.
      Object.assign(s.core.programs, { find: () => "/bin/soffice" });
      Object.assign(s.core.converter, {
        run: (_id: string, _file: string, args: string[]) =>
          writeFile(
            join(args[args.indexOf("--outdir") + 1] as string, "deck.pdf"),
            "%PDF-1.7 fake",
          ).then(() => ({
            stdout: "",
            stderr: "",
            exitCode: 0,
          })),
      });
      const scope = "project:docs";
      expect((await s.api("GET", `/api/files/preview?scope=${scope}&path=deck.pptx`)).status).toBe(
        404,
      );
      const first = await s.api<{ ready: boolean; job: { id: string; kind: string } }>(
        "POST",
        "/api/files/preview",
        {
          scope,
          path: "deck.pptx",
        },
      );
      expect(first.status).toBe(202);
      expect(first.body.job.kind).toBe("preview_file");
      expect((await s.core.jobs.settled(first.body.job.id))?.state).toBe("done");
      const again = await s.api<{ ready: boolean }>("POST", "/api/files/preview", {
        scope,
        path: "deck.pptx",
      });
      expect([again.status, again.body.ready]).toEqual([200, true]);
      const r = await fetch(`${s.url}/api/files/preview?scope=${scope}&path=deck.pptx`, {
        headers: { authorization: "Bearer test-token-0123456789" },
      });
      expect(r.headers.get("content-type")).toBe("application/pdf");
      expect(await r.text()).toBe("%PDF-1.7 fake");
      expect(existsSync(join(project?.path as string, "deck.pptx.open"))).toBe(false);
    } finally {
      await s.close();
    }
  });
});

describe("paths", () => {
  it("never reads or writes outside the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "rg-outside-"));
    try {
      await writeFile(join(outside, "x.psd"), psdSample());
      await symlink(join(outside, "x.psd"), join(root, "link.psd"));
      const { converter } = fakeConverter([]);
      await expect(converter.convert(root, "../x.psd", { owner: "me" })).rejects.toThrow(
        /outside the workspace/,
      );
      await expect(converter.convert(root, "link.psd", { owner: "me" })).rejects.toThrow(
        /outside the workspace/,
      );
      await expect(converter.inspect(root, join(outside, "x.psd"))).rejects.toThrow(
        /outside the workspace/,
      );
      expect(existsSync(join(outside, "x.psd.open"))).toBe(false);
      const tool = convertFileTool(new LocalWorkspace(root), { converter });
      expect(text(await tool.run({ path: "../x.psd" }, ctx))).toMatch(/no file/);
      const pkg = editPackageTool(new LocalWorkspace(root));
      expect(text(await pkg.run({ path: "../x.psd", action: "list" }, ctx))).toMatch(/no file/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("the agents' tools", () => {
  it("convert_file checks, converts and says what was lost", async () => {
    await put("p.psd", psdSample());
    const { converter } = fakeConverter([]);
    const tool = convertFileTool(new LocalWorkspace(root), { converter });
    const check = text(await tool.run({ path: "p.psd", check: true }, ctx));
    expect(check).toMatch(/Photoshop, closed format/);
    expect(check).toMatch(/can become ORA/);
    const done = text(await tool.run({ path: "p.psd" }, ctx));
    expect(done).toMatch(/p\.psd\.open\/p\.ora/);
    expect(done).toMatch(/What the conversion lost/);
    expect(text(await tool.run({ path: "p.psd", check: true }, ctx))).toMatch(
      /Already converted: /,
    );
    expect(text(await tool.run({ url: "https://www.canva.com/design/DAF/edit" }, ctx))).toMatch(
      /export-design/,
    );
    const ro = convertFileTool(new LocalWorkspace(root, true), { converter });
    expect(text(await ro.run({ path: "p.psd" }, ctx))).toMatch(/read-only/);
  });

  it("edit_package reads, changes and keeps an OpenRaster valid", async () => {
    await put("p.psd", psdSample());
    const { converter } = fakeConverter([]);
    await converter.convert(root, "p.psd", { owner: "me" });
    const ws = new LocalWorkspace(root);
    const pkg = editPackageTool(ws);
    const ora = "p.psd.open/p.ora";
    expect(text(await pkg.run({ path: ora, action: "list" }, ctx))).toMatch(
      /^mimetype \(16 bytes\)/,
    );
    const stack = text(await pkg.run({ path: ora, action: "read", entry: "stack.xml" }, ctx));
    expect(stack).toContain('name="Title"');
    // Hide the title: the merged picture is drawn again without it.
    const changed = text(
      await pkg.run(
        {
          path: ora,
          action: "replace",
          entry: "stack.xml",
          old_string: 'name="Title" opacity="1.000" visibility="visible"',
          new_string: 'name="Title" opacity="1.000" visibility="hidden"',
        },
        ctx,
      ),
    );
    expect(changed).toMatch(/Replaced 1 .*mergedimage\.png redrawn/);
    const after = unzipSync(new Uint8Array(await readFile(join(root, ora))));
    const merged = decodePng(after["mergedimage.png"] as Uint8Array);
    expect(Array.from(merged.data.slice((1 * 8 + 1) * 4, (1 * 8 + 1) * 4 + 3))).toEqual([
      255, 255, 255,
    ]);
    expect(strFromU8(new Uint8Array(await readFile(join(root, ora))).subarray(30, 38))).toBe(
      "mimetype",
    );
    // Broken XML is refused, and mimetype cannot go.
    expect(
      text(
        await pkg.run(
          { path: ora, action: "write", entry: "stack.xml", content: "<image><stack></image>" },
          ctx,
        ),
      ),
    ).toMatch(/not be valid XML/);
    expect(text(await pkg.run({ path: ora, action: "remove", entry: "mimetype" }, ctx))).toMatch(
      /is needed/,
    );
    // A layer out to a file and back in.
    expect(
      text(
        await pkg.run(
          { path: ora, action: "extract", entry: "data/layer0.png", file: "out/l0.png" },
          ctx,
        ),
      ),
    ).toMatch(/Extracted/);
    expect(decodePng(await readFile(join(root, "out/l0.png"))).width).toBeGreaterThan(0);
    expect(
      text(
        await pkg.run(
          { path: ora, action: "extract", entry: "data/layer0.png", file: "../l0.png" },
          ctx,
        ),
      ),
    ).toMatch(/outside the workspace/);
    expect(
      text(
        await pkg.run(
          { path: ora, action: "insert", entry: "data/layer0.png", file: "out/l0.png" },
          ctx,
        ),
      ),
    ).toMatch(/Put out\/l0\.png/);
    const ro = editPackageTool(new LocalWorkspace(root, true));
    expect(text(await ro.run({ path: ora, action: "render" }, ctx))).toMatch(/read-only/);
    expect(text(await pkg.run({ path: "p.psd", action: "list" }, ctx))).toMatch(
      /not a zip package/,
    );
  });

  it("edit_package changes an ODT's text", async () => {
    await put("b.idml", idmlSample());
    const { converter } = fakeConverter([]);
    await converter.convert(root, "b.idml", { owner: "me" });
    const pkg = editPackageTool(new LocalWorkspace(root));
    const odt = "b.idml.open/b.odt";
    expect(
      text(
        await pkg.run(
          {
            path: odt,
            action: "replace",
            entry: "content.xml",
            old_string: "New colours",
            new_string: "Fresh colours",
          },
          ctx,
        ),
      ),
    ).toMatch(/Replaced 1/);
    const content = strFromU8(
      unzipSync(new Uint8Array(await readFile(join(root, odt))))["content.xml"] as Uint8Array,
    );
    expect(content).toContain("Fresh colours");
    expect(parseXml(content).children.length).toBeGreaterThan(0);
  });

  it("exports a Figma file through the keychain, only from Figma's picture storage", async () => {
    expect(figmaLink("https://www.figma.com/design/AbC123/My-file?node-id=1-2")).toEqual({
      key: "AbC123",
      nodeId: "1:2",
    });
    expect(figmaLink("https://evil.example/design/AbC123")).toBeUndefined();
    const asked: string[] = [];
    const get = async (url: string) => {
      asked.push(url);
      if (url.includes("/files/"))
        return {
          status: 200,
          body: JSON.stringify({
            name: "My file",
            document: {
              children: [
                {
                  id: "0:1",
                  name: "Page",
                  type: "CANVAS",
                  children: [
                    { id: "1:2", name: "Home", type: "FRAME" },
                    { id: "1:3", name: "Bad", type: "FRAME" },
                  ],
                },
              ],
            },
          }),
        };
      return {
        status: 200,
        body: JSON.stringify({
          err: null,
          images: {
            "1:2": "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/x",
            "1:3": "https://evil.example/x",
          },
        }),
      };
    };
    const fetched: string[] = [];
    const fakeFetch = (async (url: string) => {
      fetched.push(String(url));
      return new Response("<svg/>");
    }) as typeof fetch;
    const r = await figmaExport(root, "https://www.figma.com/file/AbC123/My-file", "svg", get, {
      fetch: fakeFetch,
    });
    expect(asked[0]).toBe("https://api.figma.com/v1/files/AbC123?depth=2");
    expect(asked[1]).toBe("https://api.figma.com/v1/images/AbC123?ids=1%3A2%2C1%3A3&format=svg");
    expect(r.outputs).toEqual(["figma-My-file/Home.svg"]);
    expect(fetched).toEqual(["https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/x"]);
    expect(r.losses.join()).toMatch(/not exported: Bad/);
    await expect(
      figmaExport(root, "https://www.figma.com/file/AbC123/x", "svg", get, {
        dir: "../out",
        fetch: fakeFetch,
      }),
    ).rejects.toThrow(/outside the workspace/);
  });
});

describe("the page's API", () => {
  it("tells what a file is and converts it as a job", async () => {
    const { startServer } = await import("./helpers.js");
    const s = await startServer([]);
    try {
      await s.api("POST", "/api/projects", { name: "Art" });
      const project = await s.core.projects.get("me", "art");
      await writeFile(join(project?.path as string, "poster.psd"), psdSample());
      const scope = "project:art";
      const info = await s.api<{
        format: { name: string; open: boolean };
        needsConversion: boolean;
      }>("GET", `/api/files/convert?scope=${scope}&path=poster.psd`);
      expect(info.status).toBe(200);
      expect(info.body).toMatchObject({
        format: { name: "Photoshop", open: false },
        needsConversion: true,
      });
      expect((await s.api("GET", `/api/files/convert?scope=${scope}&path=../x.psd`)).status).toBe(
        400,
      );
      const job = await s.api<{ id: string; kind: string }>("POST", "/api/files/convert", {
        scope,
        path: "poster.psd",
      });
      expect(job.status).toBe(202);
      expect(job.body.kind).toBe("convert_file");
      const end = await s.core.jobs.settled(job.body.id);
      expect(end?.state).toBe("done");
      expect(end?.steps.map((x) => x.state)).toEqual(["skipped", "skipped", "done"]);
      expect(
        (end?.result as { outputs: { path: string }[] } | undefined)?.outputs.map((o) => o.path),
      ).toContain("poster.psd.open/poster.ora");
      const again = await s.api<{ converted: { stale: boolean } }>(
        "GET",
        `/api/files/convert?scope=${scope}&path=poster.psd`,
      );
      expect(again.body.converted.stale).toBe(false);
      const formats = await s.api<{ programs: { id: string; license: string }[] }>(
        "GET",
        "/api/files/formats",
      );
      expect(formats.body.programs.map((p) => `${p.id}:${p.license}`)).toContain(
        "ghostscript:AGPL-3.0",
      );
      await writeFile(join(project?.path as string, "a.svg"), "<svg/>");
      expect((await s.api("POST", "/api/files/convert", { scope, path: "a.svg" })).status).toBe(
        400,
      );
    } finally {
      await s.close();
    }
  });
});

// canvas_look's pictures (G36.12), kind by kind, with small samples and fake programs (the
// outside programs' command lines are checked as they are; their output is made by the fake).
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeCanvas, writePsdBuffer } from "ag-psd";
import { strToU8, zipSync } from "fflate";
import { PDFDocument, rgb } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  cellRange,
  cellsTable,
  type LookDeps,
  lookAt,
  lookKindOf,
  parseDelimited,
  readXlsx,
  textLines,
} from "../src/canvas-look.js";
import { pngOf, rgbaOf } from "../src/convert-js.js";
import type { Runner } from "../src/convert-programs.js";
import { readGlb, readObj, readStl, renderModel } from "../src/model-render.js";

initializeCanvas(
  () => {
    throw new Error("no canvas");
  },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as never,
);

const threePages = fileURLToPath(new URL("./fixtures/knowledge/three-pages.pdf", import.meta.url));

const solid = (w: number, h: number, rgba = [200, 30, 40, 255]) => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
};

async function folder() {
  return mkdtemp(join(tmpdir(), "rg-look-"));
}

interface Fake {
  calls: { file: string; args: string[] }[];
  ensured: string[];
}

/** Deps with programs found (or not) and a runner that plays them. */
function deps(
  dir: string,
  o: {
    found?: Partial<Record<"ffmpeg" | "libreoffice" | "ghostscript", string>>;
    run?: Runner;
    canDownload?: boolean;
    preview?: string;
  } = {},
): LookDeps & { fake: Fake } {
  const fake: Fake = { calls: [], ensured: [] };
  const run: Runner = async (file, args, opts) => {
    fake.calls.push({ file, args });
    return o.run ? o.run(file, args, opts) : { exitCode: 1, stdout: "", stderr: "" };
  };
  return {
    fake,
    owner: "me",
    programs: {
      find: (id) => o.found?.[id as keyof NonNullable<typeof o.found>],
      canDownload: () => o.canDownload ?? true,
      ensure: async (_owner, id) => {
        fake.ensured.push(id);
        throw new Error("not in tests");
      },
    },
    converter: {
      previewState: async () => ({ pdf: o.preview ?? "", ready: !!o.preview }),
      preview: async () => {
        if (!o.preview) throw new Error("no preview");
        return o.preview;
      },
    },
    profileDir: join(dir, "profile"),
    tmpDir: join(dir, "tmp"),
    run,
  };
}

const outArg = (args: string[], prefix: string) =>
  args.find((a) => a.startsWith(prefix))?.slice(prefix.length) as string;

describe("canvas_look's kinds (G36.12)", () => {
  it("knows each kind from the name", () => {
    const table: [string, string][] = [
      ["a.pdf", "pdf"],
      ["a.docx", "paged"],
      ["a.pptx", "paged"],
      ["a.xlsx", "sheet"],
      ["a.csv", "sheet"],
      ["a.mp4", "video"],
      ["a.MOV", "video"],
      ["a.mp3", "audio"],
      ["a.glb", "model"],
      ["a.fbx", "model"],
      ["a.png", "image"],
      ["a.psd", "photoshop"],
      ["a.ora", "openraster"],
      ["a.ts", "text"],
      ["Makefile", "text"],
      ["a.zip", "other"],
    ];
    for (const [name, kind] of table) expect(lookKindOf(name), name).toBe(kind);
  });
});

describe("pictures", () => {
  it("shrinks a large PNG to the asked side", async () => {
    const dir = await folder();
    const abs = join(dir, "big.png");
    await writeFile(abs, pngOf(solid(2000, 1000)));
    const r = await lookAt(abs, { width: 640 }, deps(dir));
    expect(r.text).toMatch(/Picture 2000×1000, shown at 640×320/);
    expect(r.image?.mediaType).toBe("image/png");
    const img = rgbaOf(r.image?.data as Uint8Array);
    expect([img.width, img.height]).toEqual([640, 320]);
    expect([...img.data.subarray(0, 4)]).toEqual([200, 30, 40, 255]);
    // Never past 1600, never under 256; 1280 when not said.
    expect(rgbaOf((await lookAt(abs, {}, deps(dir))).image?.data as Uint8Array).width).toBe(1280);
  });

  it("a JPEG through ffmpeg (scaled), or as it is when small and ffmpeg is not here", async () => {
    const dir = await folder();
    const abs = join(dir, "photo.jpg");
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    await writeFile(abs, jpeg);
    const without = await lookAt(abs, {}, deps(dir));
    expect(without.image).toEqual({ mediaType: "image/jpeg", data: jpeg });
    const d = deps(dir, {
      found: { ffmpeg: "/x/ffmpeg" },
      run: async (_f, args) => {
        await writeFile(args.at(-1) as string, pngOf(solid(300, 200)));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const r = await lookAt(abs, { width: 300 }, d);
    expect(d.fake.calls[0]?.args).toContain(abs);
    expect(d.fake.calls[0]?.args.join(" ")).toMatch(/min\(300,iw\)/);
    expect(r.text).toMatch(/shown at 300×200/);
  });

  it("a Photoshop file's flattened picture and an OpenRaster's merged one", async () => {
    const dir = await folder();
    const psd = join(dir, "cover.psd");
    await writeFile(
      psd,
      new Uint8Array(
        writePsdBuffer({
          width: 40,
          height: 20,
          imageData: {
            ...solid(40, 20, [10, 200, 30, 255]),
            data: new Uint8ClampedArray(solid(40, 20, [10, 200, 30, 255]).data),
          },
          children: [{ name: "Layer", left: 0, top: 0, imageData: solid(40, 20) as never }],
        }),
      ),
    );
    const p = await lookAt(psd, {}, deps(dir));
    expect(p.text).toMatch(/Photoshop file 40×20, flattened/);
    expect([...rgbaOf(p.image?.data as Uint8Array).data.subarray(0, 3)]).toEqual([10, 200, 30]);
    const ora = join(dir, "art.ora");
    await writeFile(
      ora,
      zipSync({
        mimetype: strToU8("image/openraster"),
        "stack.xml": strToU8('<image w="8" h="4"><stack/></image>'),
        "mergedimage.png": pngOf(solid(8, 4, [1, 2, 3, 255])),
      }),
    );
    const o = await lookAt(ora, {}, deps(dir));
    expect(o.text).toMatch(/OpenRaster picture 8×4/);
    expect(rgbaOf(o.image?.data as Uint8Array).width).toBe(8);
  });
});

describe("pages", () => {
  it("a PDF's page: its text, and its picture through Ghostscript at the page asked", async () => {
    const dir = await folder();
    const d = deps(dir, {
      found: { ghostscript: "/x/gs" },
      run: async (_f, args) => {
        await writeFile(outArg(args, "-sOutputFile="), pngOf(solid(900, 1165)));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const r = await lookAt(threePages, { page: 2, width: 800 }, d);
    expect(r.text).toMatch(/PDF: page 2 of 3/);
    expect(r.text).toContain("Chapter two: the engine");
    const args = d.fake.calls[0]?.args ?? [];
    expect(args).toContain("-dFirstPage=2");
    expect(args).toContain("-dLastPage=2");
    expect(args).toContain("-sDEVICE=png16m");
    // 800 px on the long side: Ghostscript's resolution chosen for it, then fitted.
    expect(args).toContain(`-r${Math.round((800 / 792) * 72)}`);
    expect(rgbaOf(r.image?.data as Uint8Array).height).toBe(800);
  });

  it("without Ghostscript LibreOffice draws the page (PageRange), with its own profile", async () => {
    const dir = await folder();
    const d = deps(dir, {
      found: { libreoffice: "/x/soffice" },
      run: async (_f, args) => {
        const out = args[args.indexOf("--outdir") + 1] as string;
        await writeFile(join(out, "three-pages.png"), pngOf(solid(100, 141)));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const r = await lookAt(threePages, { page: 3 }, d);
    const args = d.fake.calls[0]?.args ?? [];
    expect(args).toContain("--infilter=draw_pdf_import");
    const filter = args[args.indexOf("--convert-to") + 1] as string;
    expect(filter.startsWith("png:draw_png_Export:")).toBe(true);
    // The page alone (p3.5.7: LibreOffice draws the first page of what it opens).
    expect(JSON.parse(filter.slice("png:draw_png_Export:".length)).PageRange).toEqual({
      type: "string",
      value: "1",
    });
    const alone = args.at(-1) as string;
    expect(alone).not.toBe(threePages);
    expect(basename(alone)).toBe("three-pages.pdf");
    expect(args.some((a) => a.startsWith("-env:UserInstallation=file:"))).toBe(true);
    expect(r.text).toMatch(/page 3 of 3/);
    expect(r.image?.mediaType).toBe("image/png");
  });

  it("the picture is of the page asked, through LibreOffice too (p3.5.7)", async () => {
    const dir = await folder();
    // Two pages that look different: a tall red one, then a wide blue one.
    const doc = await PDFDocument.create();
    doc
      .addPage([300, 400])
      .drawRectangle({ x: 0, y: 0, width: 300, height: 400, color: rgb(1, 0, 0) });
    doc
      .addPage([600, 200])
      .drawRectangle({ x: 0, y: 0, width: 600, height: 200, color: rgb(0, 0, 1) });
    const abs = join(dir, "modulo.pdf");
    await writeFile(abs, await doc.save());
    const opened: number[] = [];
    // A LibreOffice that draws what it really would: the first page of the file it opens.
    const d = deps(dir, {
      found: { libreoffice: "/x/soffice" },
      run: async (_f, args) => {
        const input = await PDFDocument.load(await readFile(args.at(-1) as string));
        opened.push(input.getPageCount());
        const { width, height } = input.getPage(0).getSize();
        const out = args[args.indexOf("--outdir") + 1] as string;
        const color = width > height ? [0, 0, 255, 255] : [255, 0, 0, 255];
        await writeFile(join(out, "modulo.png"), pngOf(solid(width / 2, height / 2, color)));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const one = await lookAt(abs, { page: 1 }, d);
    const two = await lookAt(abs, { page: 2 }, d);
    expect(two.text).toMatch(/PDF: page 2 of 2/);
    expect(opened).toEqual([1, 1]);
    const a = rgbaOf(one.image?.data as Uint8Array);
    const b = rgbaOf(two.image?.data as Uint8Array);
    expect(
      Buffer.from(one.image?.data as Uint8Array).equals(Buffer.from(two.image?.data as Uint8Array)),
    ).toBe(false);
    expect(a.width < a.height).toBe(true);
    expect(b.width > b.height).toBe(true);
    expect([...a.data.subarray(0, 3)]).toEqual([255, 0, 0]);
    expect([...b.data.subarray(0, 3)]).toEqual([0, 0, 255]);
  });

  it("no program here: the text, and LibreOffice's download starts (said to look again)", async () => {
    const dir = await folder();
    const d = deps(dir);
    const r = await lookAt(threePages, { page: 9 }, d);
    expect(r.text).toMatch(/page 3 of 3/);
    expect(r.text).toMatch(/There is no page 9/);
    expect(r.text).toMatch(/LibreOffice is being downloaded/);
    expect(r.image).toBeUndefined();
    expect(d.fake.ensured).toEqual(["libreoffice"]);
    const none = await lookAt(threePages, {}, deps(dir, { canDownload: false }));
    expect(none.text).toMatch(/cannot be downloaded here/);
  });

  it("an Office document through its paged preview", async () => {
    const dir = await folder();
    const pdf = join(dir, "preview.pdf");
    await copyFile(threePages, pdf);
    const docx = join(dir, "letter.docx");
    await writeFile(
      docx,
      zipSync({
        "[Content_Types].xml": strToU8("<Types/>"),
        "word/document.xml": strToU8("<w:document/>"),
      }),
    );
    const d = deps(dir, {
      preview: pdf,
      found: { ghostscript: "/x/gs" },
      run: async (_f, args) => {
        await writeFile(outArg(args, "-sOutputFile="), pngOf(solid(10, 14)));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const r = await lookAt(docx, { page: 1 }, d);
    expect(r.text).toMatch(/Document, paged as LibreOffice prints it: page 1 of 3/);
    expect(r.image).toBeDefined();
  });

  it("a preview being made: joined, asked once more on «no PDF», waited for a bounded time (p3.5.7)", async () => {
    const dir = await folder();
    const pdf = join(dir, "preview.pdf");
    await copyFile(threePages, pdf);
    const docx = join(dir, "lettera.docx");
    await writeFile(
      docx,
      zipSync({
        "[Content_Types].xml": strToU8("<Types/>"),
        "word/document.xml": strToU8("<w:document/>"),
      }),
    );
    const gs = {
      found: { ghostscript: "/x/gs", libreoffice: "/x/soffice" },
      run: async (_f: string, args: string[]) => {
        await writeFile(outArg(args, "-sOutputFile="), pngOf(solid(10, 14)));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    // The canvas's preview is still being made: the look waits for it, then sees the page.
    let finish: (p: string) => void = () => {};
    const inFlight = new Promise<string>((r) => {
      finish = r;
    });
    const asks: string[] = [];
    const waiting = deps(dir, gs);
    waiting.converter = {
      previewState: async () => ({ pdf, ready: false }),
      preview: async () => {
        asks.push("preview");
        return inFlight;
      },
    };
    const look = lookAt(docx, { page: 2 }, waiting);
    await new Promise((r) => setTimeout(r, 30));
    finish(pdf);
    const r = await look;
    expect(r.text).toMatch(/page 2 of 3/);
    expect(r.image).toBeDefined();
    expect(asks).toEqual(["preview"]);
    // LibreOffice made no PDF once: asked once more, and seen.
    let tries = 0;
    const flaky = deps(dir, gs);
    flaky.converter = {
      previewState: async () => ({ pdf, ready: false }),
      preview: async () => {
        if (++tries === 1) throw new Error("LibreOffice made no PDF");
        return pdf;
      },
    };
    expect((await lookAt(docx, {}, flaky)).text).toMatch(/page 1 of 3/);
    expect(tries).toBe(2);
    // Never ready: after the wait, «look again», no error.
    const slow = { ...deps(dir, gs), previewWaitMs: 30 };
    slow.converter = {
      previewState: async () => ({ pdf, ready: false }),
      preview: () => new Promise<string>(() => {}),
    };
    const late = await lookAt(docx, {}, slow);
    expect(late.text).toMatch(/still being made.*Look again in a moment/);
    expect(late.image).toBeUndefined();
  });
});

describe("video and sound", () => {
  const ff = (dir: string, duration = "00:00:42.50") =>
    deps(dir, {
      found: { ffmpeg: "/x/ffmpeg" },
      run: async (_f, args) => {
        const t = Number(args[args.indexOf("-ss") + 1]);
        const out = args.at(-1) as string;
        if (out.endsWith(".png")) await writeFile(out, pngOf(solid(400, 80)));
        else if (t <= 42.5) await writeFile(out, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
        return { exitCode: 0, stdout: "", stderr: `  Duration: ${duration}, start: 0.0` };
      },
    });

  it("a video's frame at the time asked; past the end, the last moment", async () => {
    const dir = await folder();
    const abs = join(dir, "clip.mp4");
    await writeFile(abs, "not really a video");
    const d = ff(dir);
    const r = await lookAt(abs, { time: 12.5 }, d);
    expect(r.text).toMatch(/the frame at 0:12\.5 of 0:42\.5/);
    expect(r.image?.mediaType).toBe("image/jpeg");
    const args = d.fake.calls[0]?.args ?? [];
    expect(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 4)).toEqual([
      "-ss",
      "12.5",
      "-i",
      abs,
    ]);
    expect(args).toContain("-frames:v");
    const late = ff(dir);
    const r2 = await lookAt(abs, { time: 99 }, late);
    expect(late.fake.calls).toHaveLength(2);
    expect(r2.text).toMatch(/the frame at 0:42 of 0:42\.5/);
  });

  it("without ffmpeg it is fetched in the background", async () => {
    const dir = await folder();
    const abs = join(dir, "clip.webm");
    await writeFile(abs, "x");
    const d = deps(dir);
    expect((await lookAt(abs, {}, d)).text).toMatch(/ffmpeg is being downloaded/);
    expect(d.fake.ensured).toEqual(["ffmpeg"]);
  });

  it("a sound: its length and its waveform", async () => {
    const dir = await folder();
    const abs = join(dir, "voice.mp3");
    await writeFile(abs, "x");
    const d = ff(dir, "00:01:05.00");
    const r = await lookAt(abs, { time: 30 }, d);
    expect(r.text).toMatch(/Sound of 1:05: its waveform\. The person's place: 0:30/);
    expect(d.fake.calls[0]?.args.join(" ")).toMatch(/showwavespic/);
    expect(r.image?.mediaType).toBe("image/png");
  });
});

/** A unit cube as twelve triangles. */
const cube = (): number[][] => {
  const v = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ];
  const f = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [2, 3, 7],
    [2, 7, 6],
    [1, 2, 6],
    [1, 6, 5],
    [0, 4, 7],
    [0, 7, 3],
  ];
  return f.map((t) => t.flatMap((i) => v[i] as number[]));
};

describe("3D models drawn here", () => {
  it("reads STL (text and binary), OBJ and GLB with its node's transform", () => {
    const tris = cube();
    const ascii = `solid c\n${tris.map((t) => `facet normal 0 0 0\nouter loop\n${[0, 1, 2].map((k) => `vertex ${t[k * 3]} ${t[k * 3 + 1]} ${t[k * 3 + 2]}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid c\n`;
    expect(readStl(strToU8(ascii)).length).toBe(12 * 9);
    const bin = new Uint8Array(84 + 12 * 50);
    const dv = new DataView(bin.buffer);
    dv.setUint32(80, 12, true);
    for (const [i, t] of tris.entries())
      for (const [j, x] of t.entries()) dv.setFloat32(84 + i * 50 + 12 + j * 4, x, true);
    expect([...readStl(bin)]).toEqual(tris.flat());
    const obj = "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n";
    expect(readObj(strToU8(obj)).length).toBe(2 * 9);
    // A GLB: one triangle, its node moved by 10 on X.
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const json = strToU8(
      JSON.stringify({
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, translation: [10, 0, 0] }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
        bufferViews: [{ buffer: 0, byteLength: 36 }],
        buffers: [{ byteLength: 36 }],
      }).padEnd(Math.ceil(200 / 4) * 4, " "),
    );
    const padJson = new Uint8Array(Math.ceil(json.length / 4) * 4).fill(0x20);
    padJson.set(json);
    const glb = new Uint8Array(12 + 8 + padJson.length + 8 + 36);
    const g = new DataView(glb.buffer);
    g.setUint32(0, 0x46546c67, true);
    g.setUint32(4, 2, true);
    g.setUint32(8, glb.length, true);
    g.setUint32(12, padJson.length, true);
    g.setUint32(16, 0x4e4f534a, true);
    glb.set(padJson, 20);
    g.setUint32(20 + padJson.length, 36, true);
    g.setUint32(24 + padJson.length, 0x004e4942, true);
    glb.set(new Uint8Array(pos.buffer), 28 + padJson.length);
    expect([...readGlb(glb)]).toEqual([10, 0, 0, 11, 0, 0, 10, 1, 0]);
  });

  it("draws the shape on a light ground, from the view asked", async () => {
    const m = renderModel(new Float32Array(cube().flat()), "iso", 200, 150);
    expect(m.triangles).toBe(12);
    expect(m.size).toEqual([1, 1, 1]);
    const centre = (75 * 200 + 100) * 4;
    expect([...m.img.data.subarray(centre, centre + 3)]).not.toEqual([236, 238, 242]);
    expect([...m.img.data.subarray(0, 3)]).toEqual([236, 238, 242]);
    const dir = await folder();
    const abs = join(dir, "cube.obj");
    await writeFile(
      abs,
      "v 0 0 0\nv 2 0 0\nv 2 1 0\nv 0 1 0\nv 0 0 3\nv 2 0 3\nv 2 1 3\nv 0 1 3\nf 1 2 3 4\nf 5 6 7 8\nf 1 2 6 5\n",
    );
    const r = await lookAt(abs, { view: "top" }, deps(dir));
    expect(r.text).toMatch(/3D model, 6 triangles, 2 × 1 × 3 \(X × Y × Z\), seen from top/);
    expect(rgbaOf(r.image?.data as Uint8Array).width).toBe(800);
    const fbx = join(dir, "chair.fbx");
    await writeFile(fbx, "x");
    expect((await lookAt(fbx, {}, deps(dir))).text).toMatch(/blender tool with render/);
  });
});

describe("sheets and text", () => {
  it("cells as a table, named as in the sheet", () => {
    expect(cellRange("b2:d9")).toEqual({ c0: 1, r0: 1, c1: 3, r1: 8 });
    expect(cellRange("AA10")).toEqual({ c0: 26, r0: 9, c1: 26, r1: 9 });
    expect(cellRange("nope")).toBeUndefined();
    const rows = parseDelimited('name;city\n"Rossi; M.";Roma\nBianchi;Milano\n');
    expect(rows).toEqual([
      ["name", "city"],
      ["Rossi; M.", "Roma"],
      ["Bianchi", "Milano"],
    ]);
    expect(cellsTable(rows, "B2:B3")).toBe(" | B\n2 | Roma\n3 | Milano");
    expect(cellsTable(rows, undefined).split("\n")[0]).toBe(" | A | B");
  });

  it("an Excel workbook: its sheets, shared strings, numbers", async () => {
    const xlsx = zipSync({
      "xl/workbook.xml": strToU8(
        '<workbook><sheets><sheet name="Costi" sheetId="1" r:id="rId1"/><sheet name="Ricavi" sheetId="2" r:id="rId2"/></sheets></workbook>',
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
      ),
      "xl/sharedStrings.xml": strToU8(
        "<sst><si><t>Voce</t></si><si><r><t>Af</t></r><r><t>fitto</t></r></si></sst>",
      ),
      "xl/worksheets/sheet1.xml": strToU8(
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>1200.5</v></c></row></sheetData></worksheet>',
      ),
      "xl/worksheets/sheet2.xml": strToU8(
        '<worksheet><sheetData><row r="1"><c r="C1" t="inlineStr"><is><t>Totale &amp; più</t></is></c></row></sheetData></worksheet>',
      ),
    });
    const first = readXlsx(xlsx);
    expect(first.sheets).toEqual(["Costi", "Ricavi"]);
    expect(first.rows).toEqual([["Voce"], ["Affitto", "1200.5"]]);
    expect(readXlsx(xlsx, "ricavi").rows).toEqual([["", "", "Totale & più"]]);
    const dir = await folder();
    const abs = join(dir, "conti.xlsx");
    await writeFile(abs, xlsx);
    const r = await lookAt(abs, { cells: "A1:B2" }, deps(dir));
    expect(r.text).toMatch(/Sheet «Costi» \(sheets: Costi, Ricavi\)/);
    expect(r.text).toContain("2 | Affitto | 1200.5");
  });

  it("a text's lines, numbered, around the one asked", async () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(textLines(text, 10, 12)).toBe(
      "Lines 10-12 of 500:\n10| line 10\n11| line 11\n12| line 12",
    );
    expect(textLines(text).split("\n")[0]).toBe("Lines 1-80 of 500:");
    expect(textLines(text, 1, 10_000).split("\n")[0]).toBe("Lines 1-300 of 500:");
    const dir = await folder();
    const abs = join(dir, "main.ts");
    await writeFile(abs, text);
    const r = await lookAt(abs, { fromLine: 499 }, deps(dir));
    expect(r.text).toMatch(/main\.ts \(\d+ KB\)\. Lines 499-500 of 500/);
    expect(r.image).toBeUndefined();
    const bin = join(dir, "blob.dat");
    await writeFile(bin, new Uint8Array([1, 0, 2]));
    expect((await lookAt(bin, {}, deps(dir))).text).toMatch(/Not text/);
  });
});

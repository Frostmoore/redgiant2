// @vitest-environment jsdom
// G34.4: the canvas with the converter. Office files laid out by LibreOffice (the wait with its
// bar, the PDF, the table of a sheet, the simple reading only where LibreOffice cannot come),
// closed design files through their open copy with what was lost, the "convert to see it" of a
// video, OpenRaster layers, and the tabs' icons.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";
import { pagedKind, tabIconFor, viewerFor } from "../src/viewers/kind.js";

type Handler = (...args: unknown[]) => unknown;
const calls: [string, unknown[]][] = [];
let handlers: Record<string, Handler> = {};
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        const h = handlers[name];
        return h ? Promise.resolve(h(...args)) : Promise.resolve({});
      };
    },
  },
);
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
}));

const { CanvasFile, bestOutput } = await import("../src/components/viewers/OpenCopy.js");
const { parseStack } = await import("../src/components/viewers/OraView.js");
const { FileIcon } = await import("../src/components/viewers/FileIcon.js");

const job = (state: string, steps: { id: string; state: string; progress?: unknown }[]) => ({
  id: "job_1",
  kind: "preview_file",
  vars: { name: "x" },
  state,
  steps,
  startedAt: "2026-11-07T10:00:00.000Z",
});

beforeEach(() => {
  lang.value = "it";
  calls.length = 0;
  handlers = {};
  // The viewers read their file (the original, or a blob of the pages): nothing to read here.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array(0), { status: 200 })),
  );
  URL.createObjectURL = vi.fn(() => "blob:pages");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("what the canvas lays out and the icons (G34.4)", () => {
  it("lays out the same office formats as the server", () => {
    for (const n of ["a.docx", "a.doc", "a.rtf", "a.odt", "a.pages"])
      expect(pagedKind(n)).toBe("document");
    for (const n of ["a.xlsx", "a.xls", "a.ods", "a.numbers"]) expect(pagedKind(n)).toBe("sheet");
    for (const n of ["a.pptx", "a.ppt", "a.odp", "a.key"]) expect(pagedKind(n)).toBe("slides");
    for (const n of ["a.odg", "a.vsdx", "a.pub"]) expect(pagedKind(n)).toBe("drawing");
    for (const n of ["a.pdf", "a.csv", "a.md", "a.psd"]) expect(pagedKind(n)).toBeUndefined();
  });

  it("draws one icon per family, never a symbol", () => {
    const table: [string, string][] = [
      ["clip.mp4", "video"],
      ["voice.opus", "audio"],
      ["photo.png", "image"],
      ["report.pdf", "pdf"],
      ["letter.docx", "document"],
      ["notes.md", "document"],
      ["budget.xlsx", "sheet"],
      ["data.csv", "sheet"],
      ["deck.pptx", "slides"],
      ["chair.glb", "model"],
      ["bundle.zip", "archive"],
      ["main.ts", "code"],
      ["Inter.woff2", "font"],
      ["config.json", "data"],
      ["poster.psd", "design"],
      ["poster.ora", "design"],
      ["logo.ai", "design"],
      ["index.html", "site"],
      ["thing.xyz", "file"],
    ];
    for (const [name, kind] of table) expect([name, tabIconFor(name)]).toEqual([name, kind]);
    const { container } = render(<FileIcon name="deck.pptx" />);
    expect(container.querySelector(".fi-slides svg")).not.toBeNull();
    expect(container.textContent).toBe("");
  });

  it("opens an OpenRaster file with its layers", () => {
    expect(viewerFor("poster.ora", new Uint8Array([0x50, 0x4b, 3, 4])).kind).toBe("layers");
    const image = parseStack(`<?xml version="1.0"?>
      <image w="200" h="100">
        <stack>
          <layer name="Title" src="data/2.png" x="10" y="5" composite-op="svg:multiply" />
          <stack name="Group" opacity="0.5" visibility="hidden">
            <layer name="Star" src="data/1.png" opacity="0.8" />
          </stack>
          <layer name="Background" src="data/0.png" />
        </stack>
      </image>`);
    expect(image.width).toBe(200);
    expect(image.layers.map((l) => [l.name, l.visible, l.blend, l.depth])).toEqual([
      ["Background", true, "normal", 0],
      ["Star", false, "normal", 1],
      ["Title", true, "multiply", 0],
    ]);
    expect(image.layers[1]?.opacity).toBeCloseTo(0.4);
    expect(image.layers[2]).toMatchObject({ x: 10, y: 5 });
  });

  it("shows the layers first, then pictures, then pages", () => {
    expect(
      bestOutput([
        { path: "p.psd.open/layers.json", ext: "json" },
        { path: "p.psd.open/p.png", ext: "png" },
        { path: "p.psd.open/p.ora", ext: "ora" },
      ])?.ext,
    ).toBe("ora");
    expect(
      bestOutput([
        { path: "l.ai.open/l.odg", ext: "odg" },
        { path: "l.ai.open/l.svg", ext: "svg" },
        { path: "l.ai.open/l.pdf", ext: "pdf" },
      ])?.ext,
    ).toBe("svg");
  });
});

describe("office files laid out by LibreOffice (G34.4)", () => {
  const props = {
    scope: "project:demo",
    path: "docs/lettera.docx",
    name: "lettera.docx",
    url: "/x",
  };

  it("waits with its bar, the download's speed and time left, then shows the pages", async () => {
    let state = "running";
    handlers.startFilePreview = () => ({ ready: false, job: job("running", []) });
    handlers.job = () =>
      job(state, [
        {
          id: "tool_download",
          state: state === "running" ? "running" : "done",
          progress: { done: 100e6, total: 300e6, rate: 20e6, secondsLeft: 600 },
        },
        { id: "tool_unpack", state: "waiting" },
        { id: "convert", state: "waiting" },
      ]);
    handlers.filePreview = () => new Blob(["%PDF-1.7"], { type: "application/pdf" });
    const view = render(<CanvasFile {...props} />);
    await waitFor(() => expect(view.getByText("Preparo l'anteprima impaginata…")).toBeTruthy());
    await waitFor(() => expect(view.container.querySelector("[role=progressbar]")).not.toBeNull());
    await waitFor(() => expect(view.container.textContent).toMatch(/33% .*19\.1 MB\/s/));
    expect(view.container.textContent).toContain("LibreOffice, solo la prima volta");
    // Nothing approximate in the meantime: no text of the document, only the wait.
    expect(view.container.querySelector(".vw-doc")).toBeNull();
    state = "done";
    await waitFor(() => expect(calls.some(([n]) => n === "filePreview")).toBe(true), {
      timeout: 3000,
    });
    await waitFor(() => expect(view.queryByText("Preparo l'anteprima impaginata…")).toBeNull());
    expect(calls.find(([n]) => n === "startFilePreview")?.[1]).toEqual([
      "project:demo",
      "docs/lettera.docx",
    ]);
  });

  it("shows a ready preview at once, and a sheet also as its table", async () => {
    handlers.startFilePreview = () => ({ ready: true });
    handlers.filePreview = () => new Blob(["%PDF-1.7"]);
    const view = render(
      <CanvasFile scope="project:demo" path="bilancio.xlsx" name="bilancio.xlsx" url="/x" />,
    );
    await waitFor(() => expect(calls.some(([n]) => n === "filePreview")).toBe(true));
    const table = view.getByRole("button", { name: "Tabella" });
    expect(view.getByRole("button", { name: "Pagine" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(table);
    await waitFor(() => expect(table.getAttribute("aria-pressed")).toBe("true"));
  });

  it("falls back to the simple reading only where LibreOffice cannot come, and says so", async () => {
    handlers.startFilePreview = () => ({ ready: false, job: job("failed", []) });
    handlers.job = () => ({ ...job("failed", []), error: { message: "LibreOffice is needed" } });
    handlers.fileFormats = () => ({
      programs: [{ id: "libreoffice", name: "LibreOffice", here: false, canDownload: false }],
    });
    const view = render(<CanvasFile {...props} />);
    await waitFor(() => expect(view.container.textContent).toContain("lettura semplice"));
  });

  it("says a failure plainly and tries again, never a simple reading in its place", async () => {
    handlers.startFilePreview = () => ({ ready: false, job: job("failed", []) });
    handlers.job = () => ({ ...job("failed", []), error: { message: "soffice exited 1" } });
    handlers.fileFormats = () => ({
      programs: [{ id: "libreoffice", name: "LibreOffice", here: true, canDownload: true }],
    });
    const view = render(<CanvasFile {...props} />);
    await waitFor(() =>
      expect(view.getByText("Non sono riuscito a preparare l'anteprima impaginata")).toBeTruthy(),
    );
    expect(view.container.textContent).toContain("soffice exited 1");
    expect(view.container.textContent).not.toContain("lettura semplice");
    const before = calls.filter(([n]) => n === "startFilePreview").length;
    fireEvent.click(view.getByRole("button", { name: "Riprova" }));
    await waitFor(() =>
      expect(calls.filter(([n]) => n === "startFilePreview").length).toBe(before + 1),
    );
  });
});

describe("closed files through their open copy (G34.4)", () => {
  const psd = {
    path: "poster.psd",
    format: { id: "psd", name: "Photoshop", kind: "design", open: false, browser: false },
    needsConversion: true,
    suggested: true,
    targets: [{ ext: "ora", via: "js", losses: ["layer effects are not kept"] }],
    converted: null,
  };

  it("offers the copy with what it will lose, then shows it and what was lost", async () => {
    let report: unknown = psd;
    let state = "running";
    handlers.fileReport = () => report;
    handlers.convertFile = () => job("running", []);
    handlers.job = () => ({
      ...job(state, [{ id: "convert", state: state === "running" ? "running" : "done" }]),
      kind: "convert_file",
    });
    handlers.canvasLink = (target: unknown) => ({
      url: `/preview/${(target as { path: string }).path}`,
    });
    const view = render(
      <CanvasFile scope="project:demo" path="poster.psd" name="poster.psd" url="/x" />,
    );
    await waitFor(() => expect(view.getByText("Photoshop è un formato chiuso")).toBeTruthy());
    expect(view.container.textContent).toContain("layer effects are not kept");
    expect(view.container.textContent).toContain("ORA");
    fireEvent.click(view.getByRole("button", { name: "Fai la copia aperta" }));
    await waitFor(() => expect(calls.some(([n]) => n === "convertFile")).toBe(true));
    // The whole default set (no `to`): the layers, the picture and the list of texts.
    expect(calls.find(([n]) => n === "convertFile")?.[1]).toEqual([
      "project:demo",
      "poster.psd",
      undefined,
    ]);
    await waitFor(() => expect(view.container.querySelector(".vw-job")).not.toBeNull());
    report = {
      ...psd,
      converted: {
        outputs: [
          { path: "poster.psd.open/poster.ora", ext: "ora" },
          { path: "poster.psd.open/poster.png", ext: "png" },
        ],
        losses: ["layer effects dropped: Title"],
        convertedAt: "2026-11-07T10:00:00.000Z",
        stale: false,
      },
    };
    state = "done";
    await waitFor(
      () => expect(view.getByText("Copia aperta del file Photoshop, in ORA")).toBeTruthy(),
      { timeout: 3000 },
    );
    await waitFor(() =>
      expect(calls.find(([n]) => n === "canvasLink")?.[1]).toEqual([
        { kind: "file", scope: "project:demo", path: "poster.psd.open/poster.ora" },
      ]),
    );
    fireEvent.click(view.getByRole("button", { name: "Cosa si è perso (1)" }));
    await waitFor(() =>
      expect(view.container.textContent).toContain("layer effects dropped: Title"),
    );
    // No check marks anywhere.
    expect(view.container.querySelector('path[d="M20 6L9 17l-5-5"]')).toBeNull();
  });

  it("gives a video the browser cannot play «Convert to see it», into WebM", async () => {
    handlers.fileReport = () => ({
      path: "clip.avi",
      format: { id: "avi", name: "AVI", kind: "video", open: false, browser: false },
      needsConversion: false,
      suggested: true,
      targets: [{ ext: "webm", via: "ffmpeg", losses: ["re-encoded"] }],
      converted: null,
    });
    handlers.convertFile = () => job("running", []);
    handlers.job = () => job("running", [{ id: "convert", state: "running" }]);
    const view = render(
      <CanvasFile scope="project:demo" path="clip.avi" name="clip.avi" url="/x" />,
    );
    const button = await waitFor(() => view.getByRole("button", { name: "Converti per vederlo" }));
    fireEvent.click(button);
    await waitFor(() =>
      expect(calls.find(([n]) => n === "convertFile")?.[1]).toEqual([
        "project:demo",
        "clip.avi",
        ["webm"],
      ]),
    );
    await waitFor(() => expect(view.container.querySelector(".vw-job")).not.toBeNull());
  });

  it("shows an open file as it is, and a file outside the projects without asking", async () => {
    handlers.fileReport = () => ({
      path: "photo.png",
      format: { id: "png", name: "PNG", kind: "image", open: true, browser: true },
      needsConversion: false,
      suggested: false,
      targets: [],
      converted: null,
    });
    const view = render(
      <CanvasFile scope="project:demo" path="photo.png" name="photo.png" url="/x" />,
    );
    await waitFor(() => expect(calls.some(([n]) => n === "fileReport")).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(view.container.querySelector(".vw-open-box")).toBeNull();
    expect(view.container.querySelector(".vw-open")).toBeNull();
    cleanup();
    calls.length = 0;
    render(<CanvasFile scope="outside" path="/home/a/b.docx" name="b.docx" url="/y" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.map(([n]) => n)).toEqual([]);
  });
});

describe("the OpenRaster viewer (G34.4)", () => {
  it("stacks the layers and switches one off", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const ora = zipSync({
      mimetype: strToU8("image/openraster"),
      "stack.xml": strToU8(
        '<image w="10" h="10"><stack><layer name="Top" src="data/1.png"/><layer name="Bottom" src="data/0.png"/></stack></image>',
      ),
      "data/0.png": png,
      "data/1.png": png,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(ora, { status: 200 })),
    );
    const { OraView } = await import("../src/components/viewers/OraView.js");
    const view = render(
      <OraView src={{ kind: "layers", format: "ora", name: "p.ora", url: "/p.ora" }} />,
    );
    const top = await waitFor(() => view.getByRole("button", { name: /Top/ }));
    expect(view.container.querySelectorAll(".vw-ora-picture img")).toHaveLength(2);
    expect(top.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(top);
    await waitFor(() => expect(top.getAttribute("aria-pressed")).toBe("false"));
    expect(view.container.querySelectorAll(".vw-ora-picture img")).toHaveLength(1);
  });
});

describe("what closed apps need, the ways of an IDML, the losses in words (3.3.0)", () => {
  const PREVIEW_LOSS =
    "this is NOT a conversion: only the small preview picture stored inside the file (layers, text and layout cannot be read by any free program)";
  const closed = (id: string, name: string, needs: Record<string, unknown>) => ({
    path: `art.${id}`,
    format: { id, name, kind: "design", open: false, browser: false },
    needsConversion: true,
    suggested: true,
    targets: [
      {
        ext: "png",
        via: "js",
        preview: true,
        losses: [PREVIEW_LOSS],
        lossCodes: [{ code: "preview_only" }],
      },
    ],
    converted: null,
    needs,
  });
  const affinity = (installed: boolean) =>
    closed("affinity", "Affinity", {
      app: "affinity",
      name: "Affinity",
      url: "https://www.affinity.studio",
      export: ["pdf", "svg"],
      message: "To work on it you need Affinity",
      installed,
    });

  it("says it is only the preview, what Affinity costs and what to export, and opens it", async () => {
    handlers.fileReport = () => affinity(true);
    handlers.openWith = () => ({ opened: true, app: "affinity" });
    const view = render(
      <CanvasFile scope="project:demo" path="art.afdesign" name="art.afdesign" url="/x" />,
    );
    await waitFor(() => expect(view.getByText("Affinity: qui vedi solo l'anteprima")).toBeTruthy());
    const text = view.container.textContent ?? "";
    expect(text).toContain("gratis");
    expect(text).toContain("PDF, SVG, nella stessa cartella");
    // Said once in the box, not repeated in English as a loss.
    expect(text).not.toContain("NOT a conversion");
    expect(view.getByRole("button", { name: "Mostra l'anteprima" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Apri in Affinity" }));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "openWith")?.[1]).toEqual(["project:demo", "art.afdesign"]),
    );
    await waitFor(() => expect(view.container.textContent).toContain("si sta aprendo"));
  });

  it("links Affinity's site when it is not installed, and asks for the IDML of an INDD", async () => {
    handlers.fileReport = () => affinity(false);
    const view = render(
      <CanvasFile scope="project:demo" path="art.afdesign" name="art.afdesign" url="/x" />,
    );
    const link = await waitFor(() => view.getByRole("link", { name: "Scarica Affinity (gratis)" }));
    expect(link.getAttribute("href")).toBe("https://www.affinity.studio");
    expect(view.queryByRole("button", { name: "Apri in Affinity" })).toBeNull();
    cleanup();
    handlers.fileReport = () =>
      closed("indd", "InDesign", {
        app: "indesign",
        name: "Adobe InDesign",
        alt: "idml",
        export: ["idml", "pdf"],
        message: "No free program can read an INDD",
        installed: true,
      });
    const indd = render(
      <CanvasFile scope="project:demo" path="book.indd" name="book.indd" url="/x" />,
    );
    await waitFor(() =>
      expect(indd.getByRole("button", { name: "Apri in Adobe InDesign" })).toBeTruthy(),
    );
    expect(indd.container.textContent).toContain("InDesign Markup");
  });

  it("asks for the Figma token in the Keychain when there is none", async () => {
    handlers.fileReport = () =>
      closed("fig", "Figma (local copy)", {
        app: "figma",
        name: "Figma",
        url: "https://www.figma.com",
        export: ["svg", "pdf"],
        message: "A .fig copy cannot be read",
        installed: false,
      });
    handlers.vault = () => ({
      ready: true,
      entries: [{ name: "github", hosts: ["api.github.com"] }],
    });
    const view = render(<CanvasFile scope="project:demo" path="a.fig" name="a.fig" url="/x" />);
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Aggiungi il token di Figma" })).toBeTruthy(),
    );
    cleanup();
    handlers.vault = () => ({
      ready: true,
      entries: [{ name: "figma", hosts: ["api.figma.com"] }],
    });
    const ready = render(<CanvasFile scope="project:demo" path="a.fig" name="a.fig" url="/x" />);
    await waitFor(() => expect(ready.container.textContent).toContain("è nel Portachiavi"));
    expect(ready.queryByRole("button", { name: "Aggiungi il token di Figma" })).toBeNull();
  });

  const idml = (scribus: { here: boolean; canDownload: boolean }) => ({
    path: "book.idml",
    format: { id: "idml", name: "InDesign IDML", kind: "layout", open: false, browser: false },
    needsConversion: true,
    suggested: true,
    targets: [
      {
        ext: "sla",
        via: "scribus",
        losses: ["x"],
        lossCodes: [{ code: "idml_scribus" }],
        program: {
          id: "scribus",
          name: "Scribus",
          size: "about 125-185 MB (downloaded once, only when needed)",
          ...scribus,
        },
      },
      { ext: "odg", via: "js", unless: "sla", losses: ["y"], lossCodes: [{ code: "idml_odg" }] },
      { ext: "odt", via: "js", asked: true, losses: ["z"], lossCodes: [] },
    ],
    converted: null,
  });

  it("offers Scribus first for an IDML, and the drawing as the other way", async () => {
    handlers.fileReport = () => idml({ here: false, canDownload: true });
    handlers.convertFile = () => job("running", []);
    handlers.job = () => job("running", [{ id: "convert", state: "running" }]);
    const view = render(
      <CanvasFile scope="project:demo" path="book.idml" name="book.idml" url="/x" />,
    );
    const sla = await waitFor(() => view.getByRole("button", { name: /Scribus \(\.sla\)/ }));
    expect(sla.getAttribute("aria-pressed")).toBe("true");
    expect(view.container.textContent).toContain("Consigliato");
    expect(view.container.textContent).toContain(
      "La prima volta RedGiant scarica Scribus (circa 125-185 MB).",
    );
    expect(view.container.textContent).toContain("Scribus porta pagine, mastri");
    fireEvent.click(view.getByRole("button", { name: /Disegno \(ODG\)/ }));
    await waitFor(() => expect(view.container.textContent).toContain("L'importazione di RedGiant"));
    expect(view.container.textContent).not.toContain("La prima volta RedGiant scarica");
    fireEvent.click(view.getByRole("button", { name: "Fai la copia aperta" }));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "convertFile")?.[1]).toEqual([
        "project:demo",
        "book.idml",
        ["odg"],
      ]),
    );
  });

  it("makes the drawing of an IDML when Scribus cannot come", async () => {
    handlers.fileReport = () => idml({ here: false, canDownload: false });
    handlers.convertFile = () => job("running", []);
    const view = render(
      <CanvasFile scope="project:demo" path="book.idml" name="book.idml" url="/x" />,
    );
    await waitFor(() => expect(view.container.textContent).toContain("Scribus non può arrivare"));
    expect(view.queryByRole("button", { name: /Scribus \(\.sla\)/ })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Fai la copia aperta" }));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "convertFile")?.[1]?.[2]).toEqual(["odg"]),
    );
  });

  it("shows what was lost in the person's language, the English only without a code", async () => {
    handlers.fileReport = () => ({
      path: "poster.psd",
      format: { id: "psd", name: "Photoshop", kind: "design", open: false, browser: false },
      needsConversion: true,
      suggested: true,
      targets: [{ ext: "ora", via: "js", losses: ["one"], lossCodes: [{ code: "flat_picture" }] }],
      converted: {
        outputs: [{ path: "poster.psd.open/poster.ora", ext: "ora" }],
        losses: ["adjustment layer dropped: «Curves 1»", "a brand new loss"],
        lossCodes: [{ code: "psd_adjustment", vars: { layer: "Curves 1" } }, { code: null }],
        convertedAt: "2026-11-07T10:00:00.000Z",
        stale: false,
      },
    });
    handlers.canvasLink = () => ({ url: "/preview/poster.ora" });
    const view = render(
      <CanvasFile scope="project:demo" path="poster.psd" name="poster.psd" url="/x" />,
    );
    fireEvent.click(await waitFor(() => view.getByRole("button", { name: "Cosa si è perso (2)" })));
    await waitFor(() =>
      expect(view.container.textContent).toContain("Livello di regolazione tolto: «Curves 1»."),
    );
    expect(view.container.textContent).toContain("a brand new loss");
    lang.value = "en";
    await waitFor(() =>
      expect(view.container.textContent).toContain("Adjustment layer dropped: «Curves 1»."),
    );
  });

  it("has a text in both languages for every loss code of the server", async () => {
    const { dictionaries } = await import("../src/i18n.js");
    const src =
      Object.values(
        import.meta.glob<string>("../../server/src/convert-losses.ts", {
          query: "?raw",
          import: "default",
          eager: true,
        }),
      )[0] ?? "";
    const block = src.slice(src.indexOf("LOSS_TEMPLATES = {"), src.indexOf("} as const;"));
    const codes = [...block.matchAll(/^ {2}([a-z0-9_]+):/gm)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(60);
    for (const c of codes) {
      expect(dictionaries.en, `loss_${c}`).toHaveProperty(`loss_${c}`);
      expect(dictionaries.it, `loss_${c}`).toHaveProperty(`loss_${c}`);
    }
  });
});

// The redaction's safety net (G37.8): when the rewrite leaves something under the area (here the
// rewrite is made to do nothing), pdf.js finds it and nothing is accepted or written. Better no
// redaction than a fake one.
import type { DocOp } from "@redgiant/protocol";
import { describe, expect, it, vi } from "vitest";
import { PdfFamily } from "../src/editor/pdf-family.js";
import { samplePdf } from "./fixtures/pdf-samples.js";

vi.mock("../src/editor/pdf-redact.js", async (orig) => {
  const real = await orig<typeof import("../src/editor/pdf-redact.js")>();
  // A rewrite that takes nothing out: only the check is left to notice.
  return {
    ...real,
    redactPage: async () => ({ glyphs: 0, runs: 0, images: 0, paths: 0, annots: 0 }),
  };
});

describe("a redaction that would leave the text", () => {
  it("is refused to the agent and the person, and never written", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const f = new PdfFamily({ dataDir: await mkdtemp(join(tmpdir(), "rg-pdf-")) });
    const m = (await f.loadAsync(await samplePdf())).model;
    const r = await f.fromAgent(m, [{ op: "redact", page: 1, find: "Mario Rossi" }]);
    expect("error" in r && r.error).toMatch(
      /cannot be done safely: text «.*Mario Rossi.*» would stay/,
    );
    // Accepted around the check (an old client): the save refuses to write it.
    const op: DocOp = {
      family: "pdf",
      engine: "redgiant-pdf",
      engineVersion: "1",
      op: {
        t: "redact",
        page: 0,
        rects: [[120, 715, 190, 732]],
        info: m.outline.pages[0] as never,
      },
    };
    const m1 = f.apply(m, op);
    await expect(
      f.render(
        m1,
        {},
        { ownerId: "me", file: { scope: "platform", path: "a.pdf" }, abs: "/x", blob: f.blob },
      ),
    ).rejects.toThrow(/could not be checked: text «.*» is still under it. Nothing was written/);
  });
});

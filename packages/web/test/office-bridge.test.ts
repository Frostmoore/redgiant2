// @vitest-environment jsdom
// The page's side of documents (G37.4), pure: what stops the full editor here (table), the plain
// actions of a revision and the pictures they need, an open copy's original, the change in words.
import type { DocOp } from "@redgiant/protocol";
import { describe, expect, it } from "vitest";
import { changeText } from "../src/components/viewers/DocEditor.js";
import { lang } from "../src/i18n.js";
import {
  exportsOf,
  fallbackOf,
  hasOfficeCopy,
  isOfficeFile,
  originalOf,
  picturesOf,
  plainActions,
} from "../src/viewers/office-bridge.js";

const op = (o: unknown) =>
  ({ family: "document", engine: "libreoffice-uno", engineVersion: "1", op: o }) as DocOp;
const pic = { blob: "a".repeat(64), mime: "image/png", w: 10, h: 10 };

describe("the full editor or the fallback", () => {
  const cases: [string, Parameters<typeof fallbackOf>[0], ReturnType<typeof fallbackOf>][] = [
    ["http on another computer", { secure: false, isolated: true, webgl: true }, "insecure"],
    ["a phone with little memory", { secure: true, memory: 2 }, "memory"],
    // 3.5.11 (G37.9): on a phone the documents are seen as printed, with find and replace.
    ["a phone", { secure: true, isolated: true, webgl: true, memory: 8, phone: true }, "phone"],
    // p3.5.12: the person's phone on the home network (http): still the phone's reason.
    ["a phone over http", { secure: false, phone: true }, "phone"],
    ["a phone with little memory says phone", { secure: true, memory: 2, phone: true }, "phone"],
    ["a tablet", { secure: true, isolated: true, webgl: true, memory: 8, phone: false }, undefined],
    ["Firefox (no isolated frame)", { secure: true, isolated: false, webgl: true }, "browser"],
    ["no WebGL in workers", { secure: true, isolated: true, webgl: false }, "webgl"],
    ["Chromium on localhost", { secure: true, isolated: true, webgl: true, memory: 8 }, undefined],
    [
      "memory unknown (not Chromium)",
      { secure: true, isolated: true, webgl: true, memory: null },
      undefined,
    ],
  ];
  for (const [name, c, want] of cases) it(name, () => expect(fallbackOf(c)).toBe(want));
});

describe("revisions for the frame", () => {
  it("plain actions in order, a batch spread; a page's saved file means reloading", () => {
    const a = { t: "para_style", item: 1, expect: "x", style: "Title", before: "Standard" };
    const b = { t: "add_shape", slide: 0, expect: "", picture: pic, x: 0, y: 0 };
    expect(plainActions([op(a), op({ t: "batch", ops: [b, a] })])).toEqual([a, b, a]);
    expect(
      plainActions([op({ t: "file", blob: "b".repeat(64), size: 1, hunks: [] })]),
    ).toBeUndefined();
    expect(
      picturesOf([
        b as never,
        { t: "insert_item", at: 0, prev: null, kind: "p", picture: pic } as never,
      ]),
    ).toEqual([pic.blob]);
  });

  it("knows open copies, what is edited and what is exported", () => {
    expect(originalOf("docs/a.docx.open/a.odt")).toBe("docs/a.docx");
    expect(originalOf("docs/a.odt")).toBeUndefined();
    expect(isOfficeFile("x.ODP")).toBe(true);
    expect(hasOfficeCopy("x.pptx")).toBe(true);
    expect(hasOfficeCopy("x.pptx.open/x.odp")).toBe(false);
    expect(exportsOf("x.odp")).toContain("pptx");
    expect(exportsOf("x.odt")).toContain("docx");
  });

  it("says a change in paragraphs and slides", () => {
    lang.value = "it";
    expect(changeText({ text: "", kind: "replace", unit: "paragraph", line: 3, lines: 1 })).toBe(
      "Testo cambiato al paragrafo 3",
    );
    expect(changeText({ text: "", kind: "edit", unit: "slide", line: 2, lines: 2, count: 3 })).toBe(
      "3 modifiche alle diapositive 2-3",
    );
    lang.value = "en";
    expect(changeText({ text: "", kind: "insert", unit: "paragraph", line: 5, lines: 1 })).toBe(
      "Added in paragraph 5",
    );
  });
});

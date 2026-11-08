// @vitest-environment jsdom
// Text and code in the editor (G37.2): changes said in lines (it/en), the light syntax check of
// JSON/YAML/XML (marked, never blocking), Markdown with its preview beside the text (sanitised),
// a tree for JSON, the language in the bar, and the differences view of a turn.
import { render, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changeText, linesText } from "../src/components/viewers/DocEditor.js";
import { setLang } from "../src/i18n.js";
import { applyMessage } from "../src/state.js";
import { looseJson, syntaxProblems } from "../src/viewers/syntax.js";

const calls: unknown[] = [];
const fakeApi = {
  editorDiff: async (file: unknown, what: unknown) => {
    calls.push({ file, what });
    return {
      before: { family: "text", text: "one\ntwo\n" },
      after: { family: "text", text: "one\nTWO\nthree\n" },
      from: 1,
      to: 3,
    };
  },
};
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
}));

afterEach(() => setLang("it"));

describe("changes said in lines", () => {
  const s = (over: object) => ({ text: "", kind: "replace" as const, line: 4, lines: 1, ...over });
  it.each([
    [
      s({ linesChanged: 1, linesAdded: 0, linesRemoved: 0 }),
      "Cambiata la riga 4",
      "Line 4 changed",
    ],
    [
      s({ lines: 3, linesChanged: 3, linesAdded: 0, linesRemoved: 0 }),
      "Cambiate le righe 4-6",
      "Lines 4-6 changed",
    ],
    [
      s({ kind: "insert", lines: 2, linesChanged: 0, linesAdded: 2, linesRemoved: 0 }),
      "2 righe aggiunte alle righe 4-5",
      "2 lines added at lines 4-5",
    ],
    [
      s({ kind: "delete", linesChanged: 0, linesAdded: 0, linesRemoved: 1 }),
      "1 riga tolta dalla riga 4",
      "1 line removed from line 4",
    ],
    [
      s({ lines: 3, linesChanged: 2, linesAdded: 1, linesRemoved: 0 }),
      "2 righe cambiate e 1 riga aggiunta alle righe 4-6",
      "2 lines changed and 1 line added at lines 4-6",
    ],
    [
      s({ kind: "edit", count: 3, linesChanged: 1, linesAdded: 2, linesRemoved: 1 }),
      "3 modifiche dalla riga 4: 1 riga cambiata, 2 righe aggiunte e 1 riga tolta",
      "3 changes from line 4: 1 line changed, 2 lines added and 1 line removed",
    ],
    [
      s({ kind: "undo", linesChanged: 0, linesAdded: 0, linesRemoved: 2 }),
      "Annullata una modifica: 2 righe tolte",
      "Undid a change: 2 lines removed",
    ],
  ])("%j", (summary, it_, en) => {
    setLang("it");
    expect(changeText(summary)).toBe(it_);
    setLang("en");
    expect(changeText(summary)).toBe(en);
  });

  it("a change told before G37.2 (characters only) is still said", () => {
    setLang("it");
    expect(linesText({ text: "", kind: "insert", added: 3 })).toBeUndefined();
    expect(changeText({ text: "", kind: "insert", line: 2, lines: 1, added: 3 })).toMatch(/3/);
  });
});

describe("the light syntax check", () => {
  it("JSON: the place of the error; comments and trailing commas are allowed", async () => {
    const bad = '{\n  "a": 1,\n  "b": 2\n  "c": 3\n}';
    const [p] = await syntaxProblems(bad, "json");
    expect(p?.line).toBe(4);
    expect(await syntaxProblems('{ "a": 1, // note\n "b": [1, 2,], }', "json")).toEqual([]);
    expect(await syntaxProblems('{"a":1}\n{"a":2}', "json")).toEqual([]);
    expect(await syntaxProblems("", "json")).toEqual([]);
    // Blanked out at the same length: offsets stay true.
    const loose = looseJson('{"a": 1, /* x */ }');
    expect(loose.length).toBe('{"a": 1, /* x */ }'.length);
    expect(JSON.parse(loose)).toEqual({ a: 1 });
  });

  it("YAML and XML: where it stops being valid; other formats are not checked", async () => {
    const [y] = await syntaxProblems("a: 1\nb: [1, 2\nc: 3\n", "yaml");
    expect(y?.line).toBeGreaterThanOrEqual(2);
    expect(await syntaxProblems("a: 1\nlist:\n  - x\n", "yml")).toEqual([]);
    const x = await syntaxProblems("<a>\n  <b>\n</a>", "xml");
    expect(x).toHaveLength(1);
    expect(await syntaxProblems("<a><b/></a>", "xml")).toEqual([]);
    expect(await syntaxProblems("{{{", "py")).toEqual([]);
  });
});

const open = (path: string, text: string) =>
  applyMessage({
    type: "doc.opened",
    file: { scope: "platform", path },
    family: "text",
    revision: 3,
    snapshot: { family: "text", text },
    changes: [
      {
        revision: 3,
        ts: new Date().toISOString(),
        author: "ada",
        authorName: "Ada",
        groupId: "turn:x",
        summary: {
          text: "",
          kind: "insert",
          line: 2,
          lines: 1,
          linesAdded: 1,
          linesChanged: 0,
          linesRemoved: 0,
        },
        wrote: [[4, 9]],
      },
    ],
    proposals: [],
    presence: [],
    mode: "now",
    modeOwn: false,
  });

describe("the editor of text and code", () => {
  it("Markdown: the text with its preview beside it, sanitised", async () => {
    setLang("it");
    const { DocEditor } = await import("../src/components/viewers/DocEditor.js");
    const file = { scope: "platform", path: "notes/guide.md" };
    const { container, getByText } = render(<DocEditor file={file} />);
    open(file.path, "# Title\n\nSome **bold** text <img src=x onerror=alert(1)>\n");
    await waitFor(() =>
      expect(container.querySelector(".doc-preview h1")?.textContent).toBe("Title"),
    );
    expect(container.querySelector(".doc-preview [onerror]")).toBeNull();
    expect(container.querySelector(".cm-content")?.textContent).toContain("# Title");
    // Preview alone: the text is hidden, still there.
    getByText("Anteprima").click();
    await waitFor(() =>
      expect(container.querySelector(".doc-text-body.mode-preview")).toBeTruthy(),
    );
    expect(container.querySelector(".cm-content")).toBeTruthy();
  });

  it("JSON: the language, an error marked in the bar, a tree on request", async () => {
    setLang("it");
    const { DocEditor } = await import("../src/components/viewers/DocEditor.js");
    const file = { scope: "platform", path: "conf/app.json" };
    const { container, getByText } = render(<DocEditor file={file} />);
    open(file.path, '{\n  "name": "x"\n  "on": true\n}');
    await waitFor(() => expect(container.querySelector(".doc-syntax.bad")).toBeTruthy());
    expect(container.querySelector(".doc-syntax")?.textContent).toMatch(
      /JSON: 1 errore alla riga 3/,
    );
    // The check already names the language.
    expect(container.querySelector(".doc-lang")).toBeNull();
    getByText("Albero").click();
    await waitFor(() => expect(container.querySelector(".doc-tree")).toBeTruthy());
  });

  it("«Vedi le differenze» of a turn asks the host and shows before and after", async () => {
    setLang("it");
    const { DocEditor } = await import("../src/components/viewers/DocEditor.js");
    const file = { scope: "platform", path: "src/app.ts" };
    const { container } = render(<DocEditor file={file} />);
    open(file.path, "one\nTWO\nthree\n");
    expect(container.querySelector(".doc-lang")?.textContent).toBe("TypeScript");
    const eye = await waitFor(() => {
      const b = container.querySelector<HTMLButtonElement>(".doc-diff-open");
      expect(b).toBeTruthy();
      return b as HTMLButtonElement;
    });
    eye.click();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ what: { groupId: "turn:x" } });
    await waitFor(() => expect(container.querySelector(".doc-diff .cm-editor")).toBeTruthy());
    expect(container.querySelector(".doc-diff-title")?.textContent).toMatch(/Ada/);
  });
});

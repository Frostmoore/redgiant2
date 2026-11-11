// @vitest-environment jsdom
// Text and code in the editor (G37.2): changes said in lines (it/en), the light syntax check of
// JSON/YAML/XML (marked, never blocking), Markdown with its preview beside the text (sanitised),
// a tree for JSON, the language in the bar, and the differences view of a turn.
import { ChangeSet } from "@codemirror/state";
import { render, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changeText, linesText } from "../src/components/viewers/DocEditor.js";
import { setLang } from "../src/i18n.js";
import { agents, applyMessage } from "../src/state.js";
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
  it("JSON: the place of the error; comments and trailing commas only in JSONC", async () => {
    const bad = '{\n  "a": 1,\n  "b": 2\n  "c": 3\n}';
    const [p] = await syntaxProblems(bad, "json");
    expect(p?.line).toBe(4);
    // p3.5.3: the person's config.json, broken for Python («Illegal trailing comma … line 5»).
    const config =
      '{\n  "name": "app",\n  "port": 8080,\n  "debug": true,\n  "level": "info",\n}\n';
    const [c] = await syntaxProblems(config, "json", "progetto/config.json");
    expect(c).toMatchObject({ line: 5, message: "Trailing comma (not allowed in JSON)" });
    expect(c?.from).toBe(config.indexOf('",\n}') + 1);
    const [k] = await syntaxProblems('{"a": 1 // note\n}', "json", "data.json");
    expect(k).toMatchObject({ line: 1, message: "Comment (not allowed in JSON)" });
    // JSONC: VS Code's settings, tsconfig, .jsonc.
    const loose = '{ "a": 1, // note\n "b": [1, 2,], }';
    expect(await syntaxProblems(loose, "json", "tsconfig.base.json")).toEqual([]);
    expect(await syntaxProblems(loose, "json", "proj/.vscode/settings.json")).toEqual([]);
    expect(await syntaxProblems(loose, "jsonc", "a.jsonc")).toEqual([]);
    expect(await syntaxProblems(loose, "json", "config.json")).toHaveLength(1);
    expect(await syntaxProblems('{"a":1}\n{"a":2}', "json")).toEqual([]);
    expect(await syntaxProblems("", "json")).toEqual([]);
    // Blanked out at the same length: offsets stay true.
    const blank = looseJson('{"a": 1, /* x */ }');
    expect(blank.length).toBe('{"a": 1, /* x */ }'.length);
    expect(JSON.parse(blank)).toEqual({ a: 1 });
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

  it("JSON broken when it arrives or by the agent: marked with its line, in the tree too (p3.5.3)", async () => {
    setLang("it");
    const { DocEditor } = await import("../src/components/viewers/DocEditor.js");
    const file = { scope: "platform", path: "progetto/config.json" };
    const { container } = render(<DocEditor file={file} />);
    const button = (text: string) =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLElement;
    open(
      file.path,
      '{\n  "name": "app",\n  "port": 8080,\n  "debug": true,\n  "level": "info",\n}\n',
    );
    await waitFor(() => expect(container.querySelector(".doc-syntax.bad")).toBeTruthy());
    expect(container.querySelector(".doc-syntax")?.textContent).toMatch(
      /JSON: 1 errore alla riga 5.*Trailing comma/,
    );
    button("Albero").click();
    await waitFor(() => expect(container.querySelector(".doc-tree")).toBeTruthy());
    expect(container.querySelector(".doc-syntax.bad")).toBeTruthy();
    button("Testo").click();
    // Mended by the person's revision from elsewhere, then broken again by an agent.
    const fixedText =
      '{\n  "name": "app",\n  "port": 8080,\n  "debug": true,\n  "level": "info"\n}\n';
    const textNow =
      '{\n  "name": "app",\n  "port": 8080,\n  "debug": true,\n  "level": "info",\n}\n';
    const comma = textNow.indexOf('",\n}') + 1;
    applyMessage({
      type: "doc.changed",
      file,
      revision: 4,
      ops: [
        {
          family: "text",
          engine: "codemirror-state",
          engineVersion: "6",
          op: {
            changes: ChangeSet.of({ from: comma, to: comma + 1 }, textNow.length).toJSON() as never,
          },
        },
      ],
      change: {
        revision: 4,
        ts: new Date().toISOString(),
        author: "person",
        groupId: "g",
        summary: { text: "", kind: "delete", line: 5, lines: 1 },
      },
    });
    await waitFor(() => expect(container.querySelector(".doc-syntax.ok")).toBeTruthy());
    const at = fixedText.indexOf('"port"');
    applyMessage({
      type: "doc.changed",
      file,
      revision: 5,
      ops: [
        {
          family: "text",
          engine: "codemirror-state",
          engineVersion: "6",
          op: {
            changes: ChangeSet.of({ from: at, to: at + 1 }, fixedText.length).toJSON() as never,
          },
        },
      ],
      change: {
        revision: 5,
        ts: new Date().toISOString(),
        author: "ada",
        authorName: "Ada",
        groupId: "turn:y",
        summary: { text: "", kind: "delete", line: 3, lines: 1 },
        wrote: [],
      },
    });
    await waitFor(() =>
      expect(container.querySelector(".doc-syntax")?.textContent).toMatch(/riga 3/),
    );
  });

  it("every agent's turn has «Annulla tutto il turno»; the agents' rule says what it is (p3.5.3)", async () => {
    setLang("it");
    agents.value = [{ id: "ada", name: "Ada" } as never];
    const { DocEditor } = await import("../src/components/viewers/DocEditor.js");
    const file = { scope: "platform", path: "notes/one.txt" };
    const { container } = render(<DocEditor file={file} />);
    open(file.path, "one\ntwo\n");
    await waitFor(() => expect(container.querySelector(".doc-group.agent")).toBeTruthy());
    // One change in the turn: both buttons.
    expect(container.querySelector(".doc-undo-turn")?.textContent).toBe("Annulla tutto il turno");
    expect(container.querySelector(".doc-undo")).toBeTruthy();
    const select = () => container.querySelector<HTMLSelectElement>(".doc-mode select");
    expect(select()?.selectedOptions[0]?.textContent).toBe("Come per l'agente: subito");
    applyMessage({ type: "doc.mode", file, mode: "now", modeOwn: false, agentsPropose: ["ada"] });
    await waitFor(() =>
      expect(select()?.selectedOptions[0]?.textContent).toBe("Come per l'agente: proposte (Ada)"),
    );
    applyMessage({
      type: "doc.mode",
      file,
      mode: "propose",
      modeOwn: true,
      agentsPropose: ["ada"],
    });
    await waitFor(() => expect(select()?.value).toBe("propose"));
    expect(select()?.selectedOptions[0]?.textContent).toBe("Come proposte da accettare");
    // A refusal stays until closed, and goes when closed.
    applyMessage({
      type: "doc.rejected",
      file,
      clientId: "u1",
      code: "conflict",
      reason: "the person changed the same place at revision 2",
      revision: 3,
    });
    const notice = await waitFor(() => {
      const n = container.querySelector(".doc-refused");
      expect(n).toBeTruthy();
      return n as HTMLElement;
    });
    (
      [...notice.querySelectorAll("button")].find(
        (b) => b.textContent === "Ho capito",
      ) as HTMLElement
    ).click();
    await waitFor(() => expect(container.querySelector(".doc-refused")).toBeNull());
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

describe("the page and the host never drift apart silently (p3.5.7)", () => {
  it("a revision whose text check differs from the page's: read again, and said", async () => {
    setLang("it");
    const { DocEditor } = await import("../src/components/viewers/DocEditor.js");
    const { textDigest } = await import("@redgiant/protocol");
    const file = { scope: "platform", path: "notes/drift.txt" };
    const { container } = render(<DocEditor file={file} />);
    open(file.path, "one\ntwo\nciao\n");
    await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
    const change = (revision: number) => ({
      revision,
      ts: new Date().toISOString(),
      author: "ada",
      authorName: "Ada",
      groupId: "turn:z",
      summary: { text: "", kind: "insert" as const, line: 1, lines: 1 },
      wrote: [],
    });
    const insert = (revision: number, text: string, digest: string) =>
      applyMessage({
        type: "doc.changed",
        file,
        revision,
        ops: [
          {
            family: "text",
            engine: "codemirror-state",
            engineVersion: "6",
            op: { changes: ChangeSet.of({ from: 0, insert: "> " }, text.length).toJSON() as never },
          },
        ],
        change: change(revision),
        digest,
      });
    // The host's text agrees: nothing said.
    insert(4, "one\ntwo\nciao\n", textDigest("> one\ntwo\nciao\n"));
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector(".doc-resynced")).toBeNull();
    // The host holds something else (an undo of the person's that never reached it).
    insert(5, "> one\ntwo\nciao\n", textDigest("> > one\ntwo\nciao\nciao\n"));
    await waitFor(() => expect(container.querySelector(".doc-resynced")).toBeTruthy());
    expect(container.querySelector(".doc-resynced")?.textContent).toMatch(
      /non corrispondeva più al file sul server/,
    );
  });
});

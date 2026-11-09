// @vitest-environment jsdom
// One way to open a file (p3.5.1, decision of 2026-11-09): the list of files opens the Canvas tab
// an agent would open for the same file (one tab, not two); text with no extension is editable;
// Ctrl+S (Cmd+S) saves at once with «Salvato»; a change from outside is said plainly.
import { EditorView } from "@codemirror/view";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../src/i18n.js";

const sent: { type: string; [k: string]: unknown }[] = [];
const entries = [
  { name: "Makefile", path: "Makefile", type: "file", size: 10, modifiedAt: "" },
  { name: ".env", path: ".env", type: "file", size: 10, modifiedAt: "" },
];

vi.mock("../src/api.js", async (orig) => {
  const real = await orig<typeof import("../src/api.js")>();
  class Api {
    constructor() {
      // Every call answers an empty list, except the files of the folder.
      // biome-ignore lint/correctness/noConstructorReturn: a stand-in for the whole API
      return new Proxy(
        {},
        {
          get: (_t, name) =>
            name === "list"
              ? async () => entries
              : name === "canvasLink"
                ? async () => ({ url: "/preview/x/f" })
                : async () => [],
        },
      );
    }
  }
  class Live {
    send(m: { type: string }) {
      sent.push(m);
    }
    close() {}
  }
  return { ...real, Api, Live };
});

const state = await import("../src/state.js");
const { applyMessage, canvasViewId, openCanvas, sideViews, activeSide, docView } = state;

beforeAll(async () => {
  // Signed in with the stand-ins: the page's socket is the fake above.
  await state.signIn("token").catch(() => {});
});
beforeEach(() => {
  setLang("it");
  sent.length = 0;
  sideViews.value = [];
  activeSide.value = null;
});
afterEach(() => cleanup());

describe("the list of files opens the Canvas (p3.5.1)", () => {
  it("a file opened from the list and then shown by an agent is one tab", async () => {
    const { Explorer } = await import("../src/components/Explorer.js");
    const { findByText } = render(<Explorer />);
    fireEvent.click(await findByText("Makefile"));
    const target = { kind: "file" as const, scope: "platform", path: "Makefile" };
    expect(sideViews.value).toEqual([
      { id: canvasViewId(target), type: "canvas", title: "Makefile", target },
    ]);
    // The agent shows the same file (what `canvas.show` does): the same tab comes forward.
    openCanvas("Makefile", target);
    expect(sideViews.value.map((v) => v.id)).toEqual(["canvas:platform:Makefile"]);
    expect(activeSide.value).toBe("canvas:platform:Makefile");
    // Only Canvas tabs remain on the right: the old «editor» tab is gone.
    expect(sideViews.value.every((v) => v.type === "canvas")).toBe(true);
  });

  it("text with no extension is editable, folders and pictures are not text", async () => {
    const { editableInCanvas } = await import("../src/components/viewers/DocEditor.js");
    const { bareText } = await import("../src/viewers/kind.js");
    for (const p of [".env", "Makefile", "Dockerfile", "LICENSE", "hosts", "bin/run", ".npmrc"])
      expect(editableInCanvas({ scope: "platform", path: p }), p).toBe(true);
    expect(bareText(".env.local")).toBe(true);
    for (const p of ["photo.png", "a.docx", "index.html"]) expect(bareText(p), p).toBe(false);
  });
});

const file = { scope: "platform", path: ".env" };
const opened = (text: string, revision = 3) =>
  applyMessage({
    type: "doc.opened",
    file,
    family: "text",
    revision,
    snapshot: { family: "text", text },
    changes: [],
    proposals: [],
    presence: [],
    mode: "now",
    modeOwn: false,
  });

describe("saving (p3.5.1)", () => {
  it("Ctrl+S sends the last keystrokes, then asks the host to write now: «Salvato»", async () => {
    const { DocEditor } = await import("../src/components/viewers/DocEditor.js");
    const { container } = render(<DocEditor file={file} />);
    opened("A=1\n");
    const content = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(".cm-content");
      expect(el?.textContent).toContain("A=1");
      return el as HTMLElement;
    });
    const view = EditorView.findFromDOM(content) as EditorView;
    view.dispatch({ changes: { from: 4, insert: "B=2\n" } });
    expect(sent.some((m) => m.type === "doc.ops")).toBe(false);
    fireEvent.keyDown(content, { key: "s", code: "KeyS", ctrlKey: true });
    // The keystrokes leave at once; the save waits for the host to have them.
    const ops = sent.find((m) => m.type === "doc.ops") as { clientId: string } | undefined;
    expect(ops).toBeTruthy();
    expect(sent.some((m) => m.type === "doc.save")).toBe(false);
    await waitFor(() =>
      expect(container.querySelector(".doc-save")?.textContent).toBe("Salvataggio…"),
    );
    applyMessage({ type: "doc.ack", file, clientId: ops?.clientId as string, revision: 4 });
    expect(sent.map((m) => m.type)).toEqual(["doc.open", "doc.ops", "doc.save"]);
    applyMessage({ type: "doc.saved", file, revision: 4 });
    await waitFor(() => expect(container.querySelector(".doc-save")?.textContent).toBe("Salvato"));
  });

  it("Cmd+S elsewhere in the tab saves too, with nothing typed", async () => {
    const { DocEditor } = await import("../src/components/viewers/DocEditor.js");
    const { container } = render(<DocEditor file={file} />);
    opened("A=1\n");
    fireEvent.keyDown(container.querySelector(".doc-bar") as HTMLElement, {
      key: "s",
      metaKey: true,
    });
    expect(sent.filter((m) => m.type === "doc.save")).toHaveLength(1);
    // Ctrl+Shift+S is not a save.
    fireEvent.keyDown(container.querySelector(".doc-bar") as HTMLElement, {
      key: "S",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(sent.filter((m) => m.type === "doc.save")).toHaveLength(1);
  });

  it("saveState: what the bar says, from the host's messages", async () => {
    const { saveState } = await import("../src/components/viewers/DocEditor.js");
    expect(saveState({ revision: 3, opened: 3 })).toBeUndefined();
    expect(saveState({ revision: 4, opened: 3 })).toBe("unsaved");
    expect(saveState({ revision: 4, opened: 3, saving: true })).toBe("saving");
    expect(saveState({ revision: 4, opened: 3, saved: { revision: 4 } })).toBe("saved");
    expect(saveState({ revision: 5, opened: 3, saved: { revision: 4 } })).toBe("unsaved");
    expect(saveState({ revision: 4, saved: { revision: 3, error: "disk full" } })).toBe("failed");
  });
});

describe("a change from outside (p3.5.1)", () => {
  it("is said above the text, with the way back and «Ho capito»", async () => {
    const { DocEditor } = await import("../src/components/viewers/DocEditor.js");
    const { container, findByRole, getByRole } = render(<DocEditor file={file} />);
    opened("A=1\n");
    applyMessage({
      type: "doc.replaced",
      file,
      revision: 4,
      snapshot: { family: "text", text: "A=9\n" },
      change: {
        revision: 4,
        ts: new Date().toISOString(),
        author: "outside",
        groupId: "replaced:4",
        summary: { text: "changed from outside", kind: "replaced" },
        replaced: true,
      },
    });
    const alert = await waitFor(() => {
      const el = container.querySelector(".doc-outside");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(alert.textContent).toMatch(/\.env è cambiato sul disco, fuori dall'editor/);
    await waitFor(() => expect(container.querySelector(".cm-content")?.textContent).toBe("A=9"));
    expect(docView(file).value.saved).toEqual({ revision: 4 });
    fireEvent.click(await findByRole("button", { name: /Torna alla versione di prima/ }));
    expect(sent.find((m) => m.type === "doc.undo")).toMatchObject({ revision: 4 });
    expect(container.querySelector(".doc-outside")).toBeNull();
    // English too.
    setLang("en");
    applyMessage({
      type: "doc.replaced",
      file,
      revision: 5,
      snapshot: { family: "text", text: "A=8\n" },
      change: {
        revision: 5,
        ts: new Date().toISOString(),
        author: "outside",
        groupId: "replaced:5",
        summary: { text: "changed from outside", kind: "replaced" },
        replaced: true,
      },
    });
    await waitFor(() =>
      expect(container.querySelector(".doc-outside")?.textContent).toMatch(
        /\.env changed on disk, outside the editor/,
      ),
    );
    fireEvent.click(getByRole("button", { name: "Got it" }));
    expect(container.querySelector(".doc-outside")).toBeNull();
  });
});

// @vitest-environment jsdom
// The editor from the person's test of 3.5.11 (p3.5.12): an original with an open copy is shown
// through it in its tab, an older copy says so and offers «Rifai la copia»; documents on a phone
// say they are only looked at, whoever opened them (tables first).
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../src/i18n.js";
import { isPhone, phoneViewNote } from "../src/phone.js";
import { copyQuestion, fallbackOf } from "../src/viewers/office-bridge.js";

const calls: [string, unknown[]][] = [];
/** What the server says of each original's copy. */
const copies = new Map<string, { copy: string | null; stale?: boolean }>();
const jobs = new Map<string, string>();

vi.mock("../src/api.js", async (orig) => {
  const real = await orig<typeof import("../src/api.js")>();
  class Api {
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: a stand-in for the whole API
      return new Proxy(
        {},
        {
          get:
            (_t, name) =>
            async (...args: unknown[]) => {
              calls.push([String(name), args]);
              if (name === "canvasLink") return { url: `/preview/T/${String(args[0])}` };
              if (name === "canvasVersion") return { version: 1 };
              if (name === "editorCopy") return copies.get(String(args[1])) ?? { copy: null };
              if (name === "remakeCopy") {
                jobs.set("j1", "done");
                return { job: "j1" };
              }
              if (name === "job")
                return { id: args[0], state: jobs.get(String(args[0])) ?? "running", steps: [] };
              if (name === "fileReport") return null;
              return [];
            },
        },
      );
    }
  }
  class Live {
    send() {}
    close() {}
  }
  return { ...real, Api, Live };
});

const state = await import("../src/state.js");
const { asking } = await import("../src/components/dialogs.js");

beforeAll(async () => {
  await state.signIn("token").catch(() => {});
});
beforeEach(() => {
  setLang("it");
  calls.length = 0;
  copies.clear();
  jobs.clear();
});
afterEach(() => {
  cleanup();
  for (const v of state.sideViews.value) state.closeSide(v.id);
});

describe("which tabs ask about open copies", () => {
  it.each([
    ["presentazione.pptx", { original: "presentazione.pptx", showing: "original" }],
    ["docs/lettera.docx", { original: "docs/lettera.docx", showing: "original" }],
    ["conti/bilancio.xlsx", { original: "conti/bilancio.xlsx", showing: "original" }],
    ["logo.ai", { original: "logo.ai", showing: "original" }],
    ["art/poster.psd", { original: "art/poster.psd", showing: "original" }],
    ["tri.obj", { original: "tri.obj", showing: "original" }],
    [
      "presentazione.pptx.open/presentazione.odp",
      { original: "presentazione.pptx", showing: "copy" },
    ],
    ["art/poster.psd.open/poster.ora", { original: "art/poster.psd", showing: "copy" }],
    ["logo.ai.open/logo.svg", { original: "logo.ai", showing: "copy" }],
    ["foto.png", undefined],
    ["foto.png.open/foto.ora", undefined],
    ["note.txt", undefined],
    ["lettera.odt", undefined],
  ] as const)("%s", (path, want) => {
    expect(copyQuestion(path)).toEqual(want);
  });
});

describe("an original with an open copy, in the canvas", () => {
  it("the tab shows the copy in place of the original (show_file, the list of files)", async () => {
    copies.set("presentazione.pptx", {
      copy: "presentazione.pptx.open/presentazione.odp",
      stale: false,
    });
    const target = { kind: "file" as const, scope: "platform", path: "presentazione.pptx" };
    const id = state.openCanvas("presentazione.pptx", target);
    const { Canvas } = await import("../src/components/Canvas.js");
    render(<Canvas title="presentazione.pptx" target={target} />);
    await waitFor(() => {
      const v = state.sideViews.value.find((x) => x.id === id);
      expect(v?.type === "canvas" && v.target).toEqual({
        kind: "file",
        scope: "platform",
        path: "presentazione.pptx.open/presentazione.odp",
      });
    });
    // Same tab, under the original's name.
    expect(state.sideViews.value).toHaveLength(1);
    expect(state.sideViews.value[0]?.title).toBe("presentazione.pptx");
  });

  it("an original with no copy stays as it is", async () => {
    const target = { kind: "file" as const, scope: "platform", path: "vecchia.pptx" };
    const id = state.openCanvas("vecchia.pptx", target);
    const { Canvas } = await import("../src/components/Canvas.js");
    render(<Canvas title="vecchia.pptx" target={target} />);
    await waitFor(() => expect(calls.some(([n]) => n === "editorCopy")).toBe(true));
    await new Promise((ok) => setTimeout(ok, 30));
    const v = state.sideViews.value.find((x) => x.id === id);
    expect(v?.type === "canvas" && v.target).toEqual(target);
  });

  it("a copy older than its original says so; «Rifai la copia» asks, then makes it again", async () => {
    copies.set("presentazione.pptx", {
      copy: "presentazione.pptx.open/presentazione.odp",
      stale: true,
    });
    const { Canvas } = await import("../src/components/Canvas.js");
    const r = render(
      <Canvas
        title="presentazione.pptx"
        target={{
          kind: "file",
          scope: "platform",
          path: "presentazione.pptx.open/presentazione.odp",
        }}
      />,
    );
    const button = await waitFor(() => r.getByText("Rifai la copia"));
    expect(r.getByText(/presentazione\.pptx è cambiato fuori da qui/)).toBeTruthy();
    fireEvent.click(button);
    // Our question, never the browser's.
    await waitFor(() => expect(asking.value).toHaveLength(1));
    const ask = asking.value[0];
    expect(ask?.title).toBe("Rifare la copia di presentazione.pptx?");
    copies.set("presentazione.pptx", {
      copy: "presentazione.pptx.open/presentazione.odp",
      stale: false,
    });
    if (ask?.kind === "confirm") ask.done(true);
    asking.value = [];
    await waitFor(() =>
      expect(calls.find(([n]) => n === "remakeCopy")?.[1]).toEqual([
        "platform",
        "presentazione.pptx",
      ]),
    );
    // Made again: asked once more, fresh, the line goes.
    await waitFor(() => expect(r.queryByText("Rifai la copia")).toBeNull(), { timeout: 4000 });
  });
});

describe("a phone, and its note over documents", () => {
  it.each([
    // w, h, coarse, mobile, ua → a phone
    ["a phone's screen with a finger", 412, 915, true, undefined, "", true],
    ["Chromium says mobile (desktop site)", 980, 1800, false, true, "", true],
    [
      "an Android phone's name",
      980,
      1800,
      false,
      undefined,
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36",
      true,
    ],
    ["an iPhone", 980, 1800, false, undefined, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)", true],
    [
      "an Android tablet",
      800,
      1280,
      true,
      false,
      "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/130 Safari/537.36",
      false,
    ],
    ["a desktop", 1920, 1080, false, false, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", false],
  ] as const)("%s", (_n, w, h, coarse, mobile, ua, want) => {
    expect(isPhone({ w, h, coarse, mobile, ua })).toBe(want);
  });

  it.each([
    // phone, path, the document editor runs there → the note
    [true, "lettera.docx", false, true],
    [true, "presentazione.pptx", false, true],
    [true, "vecchio.doc", false, true],
    [true, "talk.key", false, true],
    [true, "lettera.docx.open/lettera.odt", true, false],
    [true, "bilancio.xlsx", false, false],
    [true, "foto.png", false, false],
    [false, "lettera.docx", false, false],
  ] as const)("phone %s, %s (editor %s): %s", (phone, path, editor, want) => {
    expect(phoneViewNote({ phone, path, editor })).toBe(want);
  });

  it("on a phone over plain http the reason said is the phone's (the person's test of 3.5.11)", () => {
    expect(fallbackOf({ secure: false, phone: true })).toBe("phone");
    expect(fallbackOf({ secure: false, phone: false })).toBe("insecure");
  });

  it("the canvas says it over a document an agent showed on a phone, and it can be closed", async () => {
    const before = window.matchMedia;
    window.matchMedia = ((q: string) =>
      ({
        matches: q.includes("coarse"),
        media: q,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    const size = vi.spyOn(window.screen, "width", "get").mockReturnValue(412);
    const height = vi.spyOn(window.screen, "height", "get").mockReturnValue(915);
    try {
      const { Canvas } = await import("../src/components/Canvas.js");
      const r = render(
        <Canvas
          title="lettera.docx"
          target={{ kind: "file", scope: "platform", path: "lettera.docx" }}
        />,
      );
      const note = await waitFor(() => r.getByText(/si guardano soltanto/));
      expect(note.closest("[role=note]")).toBeTruthy();
      fireEvent.click(r.getByLabelText("Chiudi"));
      expect(r.queryByText(/si guardano soltanto/)).toBeNull();
    } finally {
      window.matchMedia = before;
      size.mockRestore();
      height.mockRestore();
    }
  });
});

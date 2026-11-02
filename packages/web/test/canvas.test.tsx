// @vitest-environment jsdom
import type { Event } from "@redgiant/protocol";
import { describe, expect, it } from "vitest";
import { canvasKind, parseDelimited } from "../src/components/Canvas.js";
import { boardOf } from "../src/components/Variants.js";
import { buildItems } from "../src/state.js";

describe("the canvas (G25.1)", () => {
  it("picks the view from the file, a folder or a port being a site", () => {
    const f = (path: string) => canvasKind({ kind: "file", scope: "platform", path });
    expect(f("site")).toBe("site");
    expect(f("site/index.html")).toBe("site");
    expect(f("shots/desktop.PNG")).toBe("image");
    expect(f("clip.webm")).toBe("video");
    expect(f("voice.mp3")).toBe("audio");
    expect(f("report.pdf")).toBe("pdf");
    expect(f("data.csv")).toBe("sheet");
    expect(f("budget.xlsx")).toBe("xlsx");
    expect(f("chair.glb")).toBe("model");
    expect(f("part.stl")).toBe("model");
    expect(f("README.md")).toBe("markdown");
    expect(f("main.ts")).toBe("text");
    expect(canvasKind({ kind: "port", agentId: "a", port: 8000 })).toBe("site");
  });

  it("reads CSV with quotes, doubled quotes and new lines in cells", () => {
    expect(parseDelimited('name,note\r\n"Rossi, M.","said ""hi""\nthen left"\nB,2', ",")).toEqual([
      ["name", "note"],
      ["Rossi, M.", 'said "hi"\nthen left'],
      ["B", "2"],
    ]);
    expect(parseDelimited("a\tb\n1\t2\n", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("puts a card in the chat where the agent showed something", () => {
    const e = {
      seq: 3,
      type: "canvas.show",
      payload: { title: "Il sito", target: { kind: "file", scope: "project:x", path: "site" } },
    } as unknown as Event;
    expect(buildItems([e])).toEqual([
      {
        kind: "canvas",
        key: "e3",
        title: "Il sito",
        target: { kind: "file", scope: "project:x", path: "site" },
      },
    ]);
  });

  it("puts the file an agent sent in the chat (G25.2)", () => {
    const e = {
      seq: 5,
      type: "file.sent",
      payload: {
        scope: "platform",
        path: "shots/desktop.png",
        name: "desktop.png",
        size: 991_000,
        mime: "image/png",
        caption: "Il sito",
      },
    } as unknown as Event;
    expect(buildItems([e])).toEqual([
      {
        kind: "file",
        key: "e5",
        scope: "platform",
        path: "shots/desktop.png",
        name: "desktop.png",
        size: 991_000,
        mime: "image/png",
        caption: "Il sito",
      },
    ]);
  });

  it("shows a board's card, and the variant chosen last (G25.4)", () => {
    const ev = (seq: number, type: string, payload: unknown) =>
      ({ seq, type, sessionId: "s1", ts: "2026-11-03T10:00:00Z", payload }) as unknown as Event;
    const events = [
      ev(1, "variants.proposed", {
        proposalId: "0123456789ab",
        title: "La home",
        variants: [
          { title: "A", bytes: 10 },
          { title: "B", bytes: 20 },
        ],
      }),
      ev(2, "variants.answered", {
        proposalId: "0123456789ab",
        variant: 2,
        choice: false,
        comment: "Più grande",
      }),
      ev(3, "variants.answered", { proposalId: "0123456789ab", variant: 1, choice: true }),
      ev(4, "variants.answered", {
        proposalId: "0123456789ab",
        variant: null,
        choice: false,
        comment: "Ok",
      }),
    ];
    expect(buildItems(events)).toEqual([
      {
        kind: "variants",
        key: "e1",
        sessionId: "s1",
        proposalId: "0123456789ab",
        title: "La home",
        count: 2,
        chosen: 1,
      },
    ]);
    const b = boardOf(events, "0123456789ab");
    expect(b?.chosen).toBe(1);
    expect(b?.answers.map((a) => a.variant)).toEqual([2, 1, null]);
    expect(boardOf(events, "ffffffffffff")).toBeUndefined();
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderAnswer, renderStreamingMarkdown } from "../src/markdown.js";

/** Where the cursor ends up: the element that holds it, and the text just before it. */
function cursorIn(html: string): { parent: string; before: string } {
  const box = document.createElement("div");
  box.innerHTML = html;
  const cursor = box.querySelector(".stream-cursor");
  expect(box.querySelectorAll(".stream-cursor")).toHaveLength(1);
  return {
    parent: cursor?.parentElement?.tagName.toLowerCase() ?? "",
    before: cursor?.previousSibling?.textContent ?? "",
  };
}

describe("the cursor while a reply is written (2026-11-04)", () => {
  it("stays after the last word, inside a list, a table cell or a quote", () => {
    expect(cursorIn(renderStreamingMarkdown("Some words"))).toEqual({
      parent: "p",
      before: "Some words",
    });
    expect(cursorIn(renderStreamingMarkdown("Steps:\n\n1. First\n2. Seco")).parent).toBe("li");
    expect(cursorIn(renderStreamingMarkdown("- one\n- two\n")).parent).toBe("li");
    expect(
      cursorIn(renderStreamingMarkdown("| a | b |\n|---|---|\n| La Torre | Un vecchio")).parent,
    ).toBe("td");
    expect(cursorIn(renderStreamingMarkdown("> Chiunque riesca a recuperare")).parent).toBe("p");
    expect(cursorIn(renderStreamingMarkdown("> Chiunque riesca a recuperare")).before).toBe(
      "Chiunque riesca a recuperare",
    );
  });

  it("never inside an address: the mark is taken away there", () => {
    const html = renderStreamingMarkdown("See https://example.com/page");
    expect(html).not.toContain("");
    const box = document.createElement("div");
    box.innerHTML = html;
    expect(box.querySelector("a")?.getAttribute("href")).toBe("https://example.com/page");
    expect(box.querySelectorAll(".stream-cursor")).toHaveLength(1);
  });
});

describe("an answer with its sources (2026-11-06)", () => {
  const answer = [
    "Le hanno vinte **i Democratici**, che hanno preso Camera e Senato [1][2][3].",
    "",
    "- **Senato:** almeno 54 seggi [3], vittorie in Texas [2].",
    "- In `code [1]` nothing changes.",
    "",
    "**Fonti**",
    "",
    "1. CBS News: House results: https://www.cbsnews.com/live-updates/house/",
    "2. CBS News: Senate results: https://www.cbsnews.com/live-updates/senate/",
    "3. Il Sole 24 Ore: Midterm 2026: https://lab24.ilsole24ore.com/midterm-usa-2026/",
  ].join("\n");

  it("turns [n] into links named after their site, one link for a run", () => {
    const box = document.createElement("div");
    box.innerHTML = renderAnswer(answer);
    const cites = [...box.querySelectorAll("a.cite")].map((a) => [
      a.textContent,
      a.getAttribute("href"),
    ]);
    expect(cites).toEqual([
      ["cbsnews.com +2", "https://www.cbsnews.com/live-updates/house/"],
      ["lab24.ilsole24ore.com", "https://lab24.ilsole24ore.com/midterm-usa-2026/"],
      ["cbsnews.com", "https://www.cbsnews.com/live-updates/senate/"],
    ]);
    const first = box.querySelector("a.cite");
    expect(first?.getAttribute("target")).toBe("_blank");
    expect(first?.getAttribute("title")).toBe("CBS News\nCBS News\nIl Sole 24 Ore");
    // Code stays as written; the list is marked to be drawn small, with its title.
    expect(box.querySelector("code")?.textContent).toBe("code [1]");
    expect(box.querySelector("ol.sources")).not.toBeNull();
    expect(box.querySelector(".sources-title")?.textContent).toBe("Fonti");
    box.querySelector("code")?.remove();
    expect(box.textContent).not.toMatch(/\[[123]\]/);
  });

  it("leaves [n] alone when the answer has no list of sources", () => {
    const box = document.createElement("div");
    box.innerHTML = renderAnswer("Vedi l'elemento [2] dell'array.");
    expect(box.querySelector("a.cite")).toBeNull();
    expect(box.textContent).toContain("[2]");
  });
});

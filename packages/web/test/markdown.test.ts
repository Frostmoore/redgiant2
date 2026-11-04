// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderStreamingMarkdown } from "../src/markdown.js";

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

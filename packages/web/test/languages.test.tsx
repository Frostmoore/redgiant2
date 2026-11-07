// @vitest-environment jsdom
// G33.5: the agents' language picked apart from the interface's, in a window with a search box,
// the most common languages first and every language in its own name (no flags, no check marks).
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLanguagePicker, matchLanguages } from "../src/components/LanguagePicker.js";
import { lang } from "../src/i18n.js";

afterEach(() => {
  cleanup();
  lang.value = "en";
});

describe("the agents' language picker (G33.5)", () => {
  it("finds a language by its own name, either translation or code, accents aside", () => {
    expect(matchLanguages("francais").map((l) => l.code)).toEqual(["fr"]);
    expect(matchLanguages("Spagnolo").map((l) => l.code)).toEqual(["es"]);
    expect(matchLanguages("portug").map((l) => l.code)).toEqual(["pt-BR", "pt-PT"]);
    expect(matchLanguages("日本").map((l) => l.code)).toEqual(["ja"]);
    expect(matchLanguages("zh-hant").map((l) => l.code)).toEqual(["zh-Hant"]);
    expect(matchLanguages("").length).toBeGreaterThanOrEqual(40);
  });

  it("shows the chosen one, opens the list with the common ones first, and picks", () => {
    lang.value = "it";
    let picked = "";
    const r = render(<AgentLanguagePicker value="es" onChange={(c) => (picked = c)} />);
    const box = r.container.querySelector(".wz-alang") as HTMLElement;
    expect(box.textContent).toContain("Español");
    expect(box.textContent).toContain("Spagnolo");
    fireEvent.click(box);
    expect(r.getByText("Le più usate")).toBeTruthy();
    expect(r.getByText("Tutte le lingue")).toBeTruthy();
    const options = [...document.querySelectorAll(".wz-alang-opt")];
    expect(options.length).toBeGreaterThanOrEqual(40);
    expect(options[0]?.textContent).toBe("Italiano");
    const on = document.querySelectorAll(".wz-alang-opt.on");
    expect(on).toHaveLength(1);
    expect(on[0]?.textContent).toContain("Español");
    // No check mark on the chosen one.
    expect(document.querySelector('.ui-modal path[d="M20 6L9 17l-5-5"]')).toBeNull();

    const search = document.querySelector(".wz-alang-search input") as HTMLInputElement;
    fireEvent.input(search, { target: { value: "giapp" } });
    expect([...document.querySelectorAll(".wz-alang-opt")].map((b) => b.textContent)).toEqual([
      "日本語Giapponese",
    ]);
    fireEvent.click(document.querySelector(".wz-alang-opt") as HTMLElement);
    expect(picked).toBe("ja");
    expect(document.querySelector(".ui-modal")).toBeNull();
  });

  it("says when nothing matches", () => {
    const r = render(<AgentLanguagePicker value="en" onChange={() => {}} />);
    fireEvent.click(r.container.querySelector(".wz-alang") as HTMLElement);
    fireEvent.input(document.querySelector(".wz-alang-search input") as HTMLInputElement, {
      target: { value: "qqqq" },
    });
    expect(document.body.textContent).toContain("No language matches «qqqq».");
  });
});

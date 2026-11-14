// @vitest-environment jsdom
// 3.7.2, the person: «spaziature coerenti ovunque nelle Impostazioni». The kit's pieces that carry
// the rules: a short scale of pills stays on one line (never wrapped), a long list wraps; a how-to
// in numbered steps; and the stylesheet keeps one scale of room for every Settings page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chips, Steps } from "../src/components/SettingsKit.js";

afterEach(cleanup);
const css = readFileSync(join(import.meta.dirname, "..", "src", "styles.css"), "utf8");

describe("Chips", () => {
  it("keeps a short scale of values on one line", () => {
    const onChange = vi.fn();
    const r = render(
      <Chips
        options={["2", "4", "8", "16", "Senza limite"].map((id) => ({ id, label: id }))}
        value={["4"]}
        onChange={onChange}
      />,
    );
    const row = r.container.querySelector(".st-chips");
    expect(row?.classList.contains("one")).toBe(true);
    fireEvent.click(r.getByText("16"));
    expect(onChange).toHaveBeenCalledWith(["16"]);
  });

  it("lets a long list (many options, or long names) wrap", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: String(i), label: `Item ${i}` }));
    const long = [
      { id: "a", label: "Microsoft Cosimo - Italian (Italy)" },
      { id: "b", label: "Microsoft Elsa - Italian (Italy)" },
    ];
    for (const options of [many, long]) {
      const r = render(<Chips options={options} value={[]} onChange={() => {}} />);
      expect(r.container.querySelector(".st-chips")?.classList.contains("one")).toBe(false);
      cleanup();
    }
  });
});

describe("Steps", () => {
  it("numbers the steps in order, each with its title and words", () => {
    const r = render(
      <Steps
        label="How"
        steps={[
          { title: "Install it", text: "Once." },
          { title: "Add it", text: "To a project." },
        ]}
      />,
    );
    const items = [...r.container.querySelectorAll(".st-steps > li")];
    expect(items.map((li) => li.querySelector(".st-step-n")?.textContent)).toEqual(["1", "2"]);
    expect(items.map((li) => li.querySelector("b")?.textContent)).toEqual(["Install it", "Add it"]);
    expect(r.getByRole("list", { name: "How" })).toBeTruthy();
  });
});

describe("the room in Settings", () => {
  it("has one scale, used between blocks, inside boxes and cards, and before a part", () => {
    expect(css).toMatch(/--st-gap: 24px;/);
    expect(css).toMatch(/--st-gap-in: 16px;/);
    expect(css).toMatch(/--st-gap-part: 64px;/);
    expect(css).toMatch(/\.st-page > \.wz-inner > \* \+ \*[^{]*\{\s*margin-top: var\(--st-gap\);/);
    expect(css).toMatch(/\.st-box > \* \+ \* \{\s*margin-top: var\(--st-gap-in\);/);
    expect(css).toMatch(/\.st-page h2\.wz-sub \{\s*margin-top: var\(--st-gap-part\);/);
  });
});

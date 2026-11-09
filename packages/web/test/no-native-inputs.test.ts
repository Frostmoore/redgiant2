// Never native checkboxes or radio buttons in the page (the person's decision of 2026-11-09):
// on/off is our switch (`Toggle`, `SmallSwitch` in ui.tsx, `Switch`/`SwitchRow` in
// SettingsKit.tsx), choices are our drawn controls. The styles may still name them (to leave
// them out of a rule); the sources may not make one.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : /\.(tsx?|jsx?|mjs|html)$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
}

describe("native inputs", () => {
  it("no checkbox or radio button anywhere in the page's sources", () => {
    const found = sources(SRC).flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          /type\s*[=:]\s*\{?\s*["'](checkbox|radio)["']/.test(line)
            ? [`${relative(SRC, f)}:${i + 1}: ${line.trim()}`]
            : [],
        ),
    );
    expect(found).toEqual([]);
  });
});

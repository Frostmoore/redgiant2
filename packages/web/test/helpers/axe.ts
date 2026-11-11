// axe-core on what a test rendered (p3.5.11, G37.9): the WCAG A/AA rules jsdom can judge. Colours
// and sizes need a real browser (jsdom lays nothing out): those run in Playwright on the demo
// (rg-test/3511-a11y/axe.mjs), light and dark.
import axe from "axe-core";

export interface AxeFinding {
  id: string;
  impact: string | null | undefined;
  targets: string[];
}

/** The serious and critical violations under `el` (by default every one, with `all`). */
export async function axeViolations(el: Element, all = false): Promise<AxeFinding[]> {
  const res = await axe.run(el, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: {
      // jsdom has no layout: no colours, sizes or scrolling to judge.
      "color-contrast": { enabled: false },
      "target-size": { enabled: false },
      "scrollable-region-focusable": { enabled: false },
    },
  });
  return res.violations
    .filter((v) => all || v.impact === "serious" || v.impact === "critical")
    .map((v) => ({
      id: v.id,
      impact: v.impact,
      targets: v.nodes.map((n) => n.target.join(" ")),
    }));
}

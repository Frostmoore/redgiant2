// @vitest-environment jsdom
// Never the browser's native dialogs (decision of 2026-11-09, collaudo della 3.5.1: «nuovo file»
// used prompt()): every alert, prompt and confirm of the page is our Modal (`askConfirm`,
// `askText` in components/dialogs.tsx). This test fails if one comes back in the sources.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { askConfirm, asking, askText, Dialogs } from "../src/components/dialogs.js";

const SRC = join(__dirname, "../src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [p] : [];
  });
}

/** The code without its comments and strings' contents, so a word in a comment does not count. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
    .replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
}

// A call of the browser's own dialogs: bare, or through window, globalThis or self.
const NATIVE = /(^|[^\w.$]|\b(?:window|globalThis|self)\s*\.\s*)(alert|prompt|confirm)\s*\(/;

describe("the browser's native dialogs (2026-11-09)", () => {
  it("are never called in packages/web/src", () => {
    const found: string[] = [];
    for (const file of sources(SRC)) {
      const lines = code(readFileSync(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (NATIVE.test(line)) found.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("the check itself sees them, also through window", () => {
    for (const bad of [
      'const n = prompt("x");',
      "if (!confirm(t('y'))) return;",
      "window.alert(1)",
      "globalThis.confirm('z')",
      "  alert ( 'a' )",
    ])
      expect(NATIVE.test(code(bad)), bad).toBe(true);
    for (const ok of [
      "await askConfirm(t('y'))",
      "// never confirm() here",
      "x.prompt(1)",
      "const text = 'confirm(';",
      "systemPrompt(a)",
    ])
      expect(NATIVE.test(code(ok)), ok).toBe(false);
  });
});

describe("our own questions", () => {
  afterEach(() => {
    cleanup();
    asking.value = [];
  });

  it("asks yes or no in our window and answers the promise", async () => {
    const { findByRole, getByText, queryByRole } = render(<Dialogs />);
    const answer = askConfirm("Delete the file?", { text: "It goes for good.", yes: "Delete" });
    const dialog = await findByRole("dialog");
    expect(dialog.textContent).toContain("It goes for good.");
    fireEvent.click(getByText("Delete"));
    expect(await answer).toBe(true);
    expect(queryByRole("dialog")).toBeNull();
    const no = askConfirm("Again?");
    await findByRole("dialog");
    fireEvent.click(getByText("Cancel"));
    expect(await no).toBe(false);
  });

  it("asks a line of text, given back as written, or null when given up", async () => {
    const { findByRole, getByRole, getByText } = render(<Dialogs />);
    const name = askText("New file", "docs/", { yes: "Make" });
    await findByRole("dialog");
    const input = getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("docs/");
    fireEvent.input(input, { target: { value: "docs/note.md" } });
    fireEvent.click(getByText("Make"));
    expect(await name).toBe("docs/note.md");
    const none = askText("Rename");
    await findByRole("dialog");
    fireEvent.click(getByText("Cancel"));
    expect(await none).toBeNull();
  });
});

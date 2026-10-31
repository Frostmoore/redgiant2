import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolContext } from "@redgiant/agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyEdit,
  baseTools,
  htmlToText,
  LocalWorkspace,
  PathOutsideWorkspaceError,
  SearxngSearch,
  truncateMiddle,
  webSearchTool,
} from "../src/index.js";

let dir: string;
let ws: LocalWorkspace;
const ctx: ToolContext = { ownerId: "local", projectId: "p", agentId: "a", sessionId: "s" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rg-tools-"));
  await mkdir(join(dir, "src/deep"), { recursive: true });
  await mkdir(join(dir, "node_modules/x"), { recursive: true });
  await writeFile(
    join(dir, "src/a.ts"),
    "export const a = 1;\nexport function hello() {\n  return 'hi';\n}\n",
  );
  await writeFile(join(dir, "src/deep/b.ts"), "const TODO = 'b';\n");
  await writeFile(join(dir, "node_modules/x/c.ts"), "TODO ignored\n");
  await writeFile(join(dir, "README.md"), "# Title\nTODO: docs\n");
  ws = new LocalWorkspace(dir);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const tools = (extra: Partial<Parameters<typeof baseTools>[0]> = {}) =>
  baseTools({ workspace: ws, ...extra });
const tool = (name: string, list = tools()) =>
  list.find((t) => t.def.name === name) as Tool<Record<string, unknown>>;
const run = async (name: string, input: Record<string, unknown>, list?: Tool[]) => {
  const out = await tool(name, list).run(input, ctx);
  return typeof out === "string"
    ? { content: out, isError: false }
    : { content: out.content, isError: out.isError ?? false };
};

describe("baseTools", () => {
  it("gives every agent the same tools in canonical order", () => {
    expect(tools().map((t) => t.def.name)).toEqual([
      "bash",
      "edit_file",
      "fetch",
      "glob",
      "grep",
      "read_file",
      "web_search",
      "write_file",
    ]);
    expect(tools({ profile: "compact" }).map((t) => t.def.name)).toEqual(
      tools().map((t) => t.def.name),
    );
    const long = tools().reduce((n, t) => n + t.def.description.length, 0);
    const short = tools({ profile: "compact" }).reduce((n, t) => n + t.def.description.length, 0);
    expect(short).toBeLessThan(long / 2);
  });
});

describe("LocalWorkspace", () => {
  it("refuses paths outside the root, including through symlinks", async () => {
    await expect(ws.readText("../etc/passwd")).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
    await expect(ws.readText("/etc/passwd")).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
    await symlink("/etc", join(dir, "escape"));
    await expect(ws.readText("escape/passwd")).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
    await expect(ws.writeText("escape/new-file", "x")).rejects.toBeInstanceOf(
      PathOutsideWorkspaceError,
    );
    await expect(ws.glob("../**/*")).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
  });

  it("refuses writes when read-only", async () => {
    const ro = new LocalWorkspace(dir, true);
    await expect(ro.writeText("x.txt", "y")).rejects.toThrow(/read-only/);
    await expect(
      tool("write_file", baseTools({ workspace: ro })).run({ path: "x.txt", content: "y" }, ctx),
    ).rejects.toThrow(/read-only/);
    expect(await ro.readText("README.md")).toContain("Title");
  });
});

describe("file tools", () => {
  it("reads with line numbers and paging", async () => {
    const r = await run("read_file", { path: "src/a.ts", offset: 2, limit: 2 });
    expect(r.content).toBe(
      "     2\texport function hello() {\n     3\t  return 'hi';\n[2 more lines; continue with offset 4]",
    );
    expect((await run("read_file", { path: "missing.ts" })).isError).toBe(true);
    // Compact profile: plain text, so small models do not copy line numbers into files.
    const compact = await run(
      "read_file",
      { path: "src/a.ts", limit: 1 },
      tools({ profile: "compact" }),
    );
    expect(compact.content).toBe("export const a = 1;\n[4 more lines; continue with offset 2]");
  });

  it("writes, creating directories", async () => {
    expect((await run("write_file", { path: "new/dir/f.txt", content: "a\nb" })).content).toBe(
      "Created new/dir/f.txt (2 lines).",
    );
    expect(await readFile(join(dir, "new/dir/f.txt"), "utf8")).toBe("a\nb");
  });

  it("edits with exact and tolerant matching", async () => {
    expect(
      (
        await run("edit_file", {
          path: "src/a.ts",
          old_string: "return 'hi';",
          new_string: "return 'hello';",
        })
      ).content,
    ).toBe("Edited src/a.ts: 1 replacement.");
    // The model lost the indentation: still a unique match, and the new code is re-indented.
    const r = await run("edit_file", {
      path: "src/a.ts",
      old_string: "export function hello() {\nreturn 'hello';\n}",
      new_string: "export function hello() {\nreturn 'ciao';\n}",
    });
    expect(r.content).toMatch(/ignoring indentation/);
    expect(await readFile(join(dir, "src/a.ts"), "utf8")).toContain("return 'ciao';");
    expect(
      (await run("edit_file", { path: "src/a.ts", old_string: "nope", new_string: "x" })).isError,
    ).toBe(true);
  });
});

describe("applyEdit", () => {
  const file = "def f():\n    x = 1\n    return x\n\ndef g():\n    x = 1\n    return x\n";

  it("refuses ambiguous matches unless replace_all", () => {
    expect(applyEdit(file, "x = 1", "x = 2")).toMatchObject({ ok: false, error: /2 times/ });
    expect(applyEdit(file, "x = 1", "x = 2", true)).toMatchObject({ ok: true, replacements: 2 });
  });

  it("tolerates trailing whitespace", () => {
    const r = applyEdit("a = 1   \nb = 2\n", "a = 1\nb = 2", "a = 3\nb = 4");
    expect(r).toMatchObject({
      ok: true,
      strategy: "trailing-whitespace",
      content: "a = 3\nb = 4\n",
    });
  });

  it("re-indents a block matched ignoring indentation", () => {
    const src = "class A:\n    def f(self):\n        return 1\n";
    const r = applyEdit(src, "def f(self):\n    return 1", "def f(self):\n    y = 2\n    return y");
    expect(r).toMatchObject({
      ok: true,
      strategy: "indentation",
      content: "class A:\n    def f(self):\n        y = 2\n        return y\n",
    });
  });

  it("keeps CRLF line endings", () => {
    const r = applyEdit("a\r\nb\r\n", "a\nb", "c\nd");
    expect(r).toMatchObject({ ok: true, content: "c\r\nd\r\n" });
  });

  it("points to the closest line when nothing matches", () => {
    const r = applyEdit(file, "def h():\n    return x", "x");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Line 3 matches part of it/);
  });
});

describe("search tools", () => {
  it("globs and greps, skipping node_modules", async () => {
    expect((await run("glob", { pattern: "**/*.ts" })).content).toBe("src/a.ts\nsrc/deep/b.ts");
    expect((await run("grep", { pattern: "todo", ignore_case: true })).content).toBe(
      "README.md:2: TODO: docs\nsrc/deep/b.ts:1: const TODO = 'b';",
    );
    expect((await run("grep", { pattern: "TODO", glob: "**/*.ts", path: "src" })).content).toBe(
      "src/deep/b.ts:1: const TODO = 'b';",
    );
    expect((await run("grep", { pattern: "([" })).isError).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("bash", () => {
  it("reports exit codes, output and timeouts", async () => {
    const ok = await run("bash", { command: "echo out; echo err >&2" });
    expect(ok).toEqual({ content: "Exit code: 0\nstdout:\nout\n\nstderr:\nerr\n", isError: false });
    expect((await run("bash", { command: "exit 3" })).content).toBe("Exit code: 3");
    const slow = await run("bash", { command: "sleep 5", timeout_ms: 1000 });
    expect(slow).toMatchObject({ isError: true, content: /Timed out/ });
  });
});

describe("web tools", () => {
  it("fetches pages as text", async () => {
    const fake = (async () =>
      new Response(
        "<html><head><title>x</title><script>evil()</script></head><body><h1>Hi &amp; bye</h1><p>One<br>Two</p></body></html>",
        {
          headers: { "content-type": "text/html" },
        },
      )) as unknown as typeof fetch;
    const r = await run("fetch", { url: "https://example.com" }, tools({ fetch: fake }));
    expect(r.content).toBe("URL: https://example.com\nStatus: 200\n\nHi & bye\nOne\nTwo");
  });

  it("searches with SearXNG and explains when search is not configured", async () => {
    const fake = (async (url: string) => {
      expect(url).toBe("http://searx:8080/search?format=json&q=red%20giant");
      return Response.json({
        results: [
          { title: "Red giant", url: "https://en.wikipedia.org/wiki/Red_giant", content: "A star" },
        ],
      });
    }) as unknown as typeof fetch;
    const r = await run("web_search", { query: "red giant" }, [
      webSearchTool(new SearxngSearch("http://searx:8080/", fake), "full"),
    ] as Tool[]);
    expect(r.content).toBe("1. Red giant\n   https://en.wikipedia.org/wiki/Red_giant\n   A star");
    expect((await run("web_search", { query: "x" })).isError).toBe(true);
  });

  it("converts HTML entities and keeps text structure", () => {
    expect(htmlToText("<ul><li>a</li><li>b &#x263A; &#65;</li></ul>")).toBe("- a\n- b ☺ A");
  });
});

describe("truncateMiddle", () => {
  it("keeps head and tail", () => {
    const t = truncateMiddle(`${"a".repeat(100)}${"b".repeat(100)}`, 100);
    expect(t.startsWith("aaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(t.endsWith("bbbbbbbbbbbbbbbbbbbb")).toBe(true);
    expect(t).toMatch(/characters omitted/);
  });
});

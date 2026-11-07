import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compileIgnore,
  hashFile,
  isSecretFile,
  listFiles,
  looksBinary,
} from "../src/knowledge/files.js";
import { FetchPageError, fetchPage } from "../src/knowledge/web.js";

describe("compileIgnore (gitignore rules)", () => {
  // [patterns, path, isDir, ignored]
  const table: [string[], string, boolean, boolean][] = [
    [["*.log"], "a.log", false, true],
    [["*.log"], "deep/dir/a.log", false, true],
    [["*.log"], "a.log.txt", false, false],
    [["/build"], "build", true, true],
    [["/build"], "src/build", true, false],
    [["build/"], "build", false, false],
    [["build/"], "build", true, true],
    [["build/"], "src/build", true, true],
    [["build/"], "build/out.js", false, true],
    [["doc/*.txt"], "doc/notes.txt", false, true],
    [["doc/*.txt"], "doc/sub/notes.txt", false, false],
    [["doc/**/*.txt"], "doc/sub/deep/notes.txt", false, true],
    [["doc/**/*.txt"], "doc/notes.txt", false, true],
    [["**/temp"], "a/b/temp", true, true],
    [["**/temp"], "temp", false, true],
    [["logs/**"], "logs/x/y.txt", false, true],
    [["logs/**"], "logs", true, false],
    [["file?.md"], "file1.md", false, true],
    [["file?.md"], "file12.md", false, false],
    [["[ab].txt"], "a.txt", false, true],
    [["[ab].txt"], "c.txt", false, false],
    [["[!ab].txt"], "c.txt", false, true],
    [["[a-c]x"], "bx", false, true],
    [["*.log", "!keep.log"], "keep.log", false, false],
    [["*.log", "!keep.log"], "other.log", false, true],
    [["!keep.log", "*.log"], "keep.log", false, true],
    // A file inside an ignored folder cannot be put back.
    [["secret/", "!secret/ok.txt"], "secret/ok.txt", false, true],
    [["# comment", "", "  "], "# comment", false, false],
    [["\\#hash"], "#hash", false, true],
    [["\\!bang"], "!bang", false, true],
    [["trailing   "], "trailing", false, true],
    [["a\\ "], "a ", false, true],
    [["*"], "anything/at/all", false, true],
    [["/*.md"], "README.md", false, true],
    [["/*.md"], "docs/README.md", false, false],
  ];
  it.each(table)("%j on %s (dir %s) → %s", (patterns, path, isDir, ignored) => {
    expect(compileIgnore(patterns)(path, isDir)).toBe(ignored);
  });

  it("applies a nested .gitignore to its own folder only", () => {
    const m = compileIgnore(["*.tmp", "/local"], "pkg");
    expect(m("pkg/a.tmp", false)).toBe(true);
    expect(m("pkg/local", true)).toBe(true);
    expect(m("pkg/sub/local", true)).toBe(false);
    expect(m("other/a.tmp", false)).toBe(false);
  });

  it("keeps secret files out", () => {
    for (const n of [
      ".env",
      ".env.local",
      "id_rsa",
      "id_ed25519.pub",
      "server.pem",
      "secrets.json",
    ])
      expect(isSecretFile(n)).toBe(true);
    for (const n of [".env.example", "env.ts", "README.md", "keys.md"])
      expect(isSecretFile(n)).toBe(false);
  });
});

describe("listFiles", () => {
  let root: string;
  let outside: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "rg-kfiles-"));
    outside = await mkdtemp(join(tmpdir(), "rg-kout-"));
    const put = async (p: string, text = "x") => {
      await mkdir(join(root, p, ".."), { recursive: true });
      await writeFile(join(root, p), text);
    };
    await put("b.md");
    await put("a.ts");
    await put("node_modules/lib/index.js");
    await put(".git/config");
    await put("report.docx.open/report.odt");
    await put("src/z.ts");
    await put("src/gen/out.ts");
    await put("src/debug.log");
    await put("src/.gitignore", "gen/\n*.log\n!important.log\n");
    await put("src/important.log");
    await put(".gitignore", "/private\n");
    await put("private/p.txt");
    await put("sub/private/kept.txt");
    await put(".env", "KEY=1");
    await put("notes/todo.txt");
    await writeFile(join(outside, "leak.txt"), "secret");
    await symlink(join(outside, "leak.txt"), join(root, "leak.txt"));
    await symlink(join(root, "a.ts"), join(root, "alias.ts"));
    await symlink(outside, join(root, "linked-dir"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("walks in a stable order, following .gitignore and skipping what nobody searches", async () => {
    const found: string[] = [];
    for await (const f of listFiles(root)) found.push(f.rel);
    expect(found).toEqual([
      "a.ts",
      "alias.ts",
      "b.md",
      "notes/todo.txt",
      "src/important.log",
      "src/z.ts",
      "sub/private/kept.txt",
    ]);
  });

  it("follows the person's patterns over the .gitignore, or ignores the .gitignore", async () => {
    const found: string[] = [];
    for await (const f of listFiles(root, { exclude: ["notes/", "!src/debug.log"] }))
      found.push(f.rel);
    expect(found).toContain("src/debug.log");
    expect(found).not.toContain("notes/todo.txt");
    const raw: string[] = [];
    for await (const f of listFiles(root, { gitignore: false })) raw.push(f.rel);
    expect(raw).toContain("private/p.txt");
    expect(raw).toContain("src/gen/out.ts");
    expect(raw).not.toContain(".env");
  });

  it("stops at maxFiles and on abort", async () => {
    const found: string[] = [];
    for await (const f of listFiles(root, { maxFiles: 2 })) found.push(f.rel);
    expect(found).toHaveLength(2);
    const ac = new AbortController();
    ac.abort();
    await expect(async () => {
      for await (const _ of listFiles(root, { signal: ac.signal })) void _;
    }).rejects.toThrow(/stopped/);
  });

  it("hashes files and tells binaries", async () => {
    expect(await hashFile(join(root, "a.ts"))).toBe(
      "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
    );
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode("ciao, è un testo\n"))).toBe(false);
    expect(looksBinary(new Uint8Array([0xff, 0xfe, 0x61, 0x00]))).toBe(false);
    expect(looksBinary(new Uint8Array(100).fill(3))).toBe(true);
  });
});

describe("fetchPage", () => {
  const publicLookup = async () => ["93.184.216.34"];
  const page = (body: string, init: ResponseInit = {}) =>
    new Response(body, { headers: { "content-type": "text/html; charset=utf-8" }, ...init });

  it("reads a public page and follows a checked redirect", async () => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      if (url === "https://example.org/old")
        return new Response(null, { status: 301, headers: { location: "/new" } });
      return page("<html><title>Hi</title><p>Ciao</p></html>");
    }) as typeof fetch;
    const r = await fetchPage("https://example.org/old", { fetch: f, lookup: publicLookup });
    expect(r.kind).toBe("html");
    expect(r.finalUrl).toBe("https://example.org/new");
    expect(r.html).toContain("Ciao");
    expect(calls).toEqual(["https://example.org/old", "https://example.org/new"]);
  });

  it("refuses private addresses, also behind a redirect", async () => {
    const f = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:7600/api" },
      })) as typeof fetch;
    await expect(
      fetchPage("https://example.org/", { fetch: f, lookup: publicLookup }),
    ).rejects.toMatchObject({
      code: "non_public_address",
    });
    await expect(
      fetchPage("https://intranet.example/", { fetch: f, lookup: async () => ["10.0.0.5"] }),
    ).rejects.toBeInstanceOf(FetchPageError);
    await expect(fetchPage("http://localhost/", { fetch: f })).rejects.toMatchObject({
      code: "non_public_address",
    });
    await expect(fetchPage("http://[::1]/", { fetch: f })).rejects.toMatchObject({
      code: "non_public_address",
    });
    await expect(fetchPage("file:///etc/passwd")).rejects.toMatchObject({ code: "bad_url" });
  });

  it("stops past the byte limit and on too many redirects", async () => {
    const big = (async () => page("x".repeat(5000))) as typeof fetch;
    await expect(
      fetchPage("https://example.org/", { fetch: big, lookup: publicLookup, maxBytes: 1000 }),
    ).rejects.toMatchObject({ code: "too_big" });
    const loop = (async () =>
      new Response(null, { status: 302, headers: { location: "/again" } })) as typeof fetch;
    await expect(
      fetchPage("https://example.org/", { fetch: loop, lookup: publicLookup }),
    ).rejects.toMatchObject({ code: "too_many_redirects" });
  });

  it("gives PDFs as bytes, decodes declared charsets, refuses other types", async () => {
    const pdf = (async () =>
      new Response("%PDF-1.4 ...", {
        headers: { "content-type": "application/pdf" },
      })) as typeof fetch;
    const r = await fetchPage("https://example.org/a.pdf", { fetch: pdf, lookup: publicLookup });
    expect(r.kind).toBe("pdf");
    expect(r.bytes[0]).toBe(0x25);
    const latin = (async () =>
      new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe8]), {
        headers: { "content-type": "text/plain; charset=iso-8859-1" },
      })) as typeof fetch;
    expect(
      (await fetchPage("https://example.org/t", { fetch: latin, lookup: publicLookup })).html,
    ).toBe("cafè");
    const img = (async () =>
      new Response("x", { headers: { "content-type": "image/png" } })) as typeof fetch;
    await expect(
      fetchPage("https://example.org/i", { fetch: img, lookup: publicLookup }),
    ).rejects.toMatchObject({ code: "unsupported_type" });
  });
});

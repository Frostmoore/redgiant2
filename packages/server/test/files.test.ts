import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OTHER, startServer, TOKEN } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe("file explorer API", () => {
  it("lists, writes, reads, renames and deletes inside a project, logging every change", async () => {
    s = await startServer([]);
    await s.api("POST", "/api/projects", { name: "Files" });
    const scope = "project:files";
    expect(
      (await s.api("PUT", "/api/files/content", { scope, path: "src/a.txt", content: "hello" }))
        .status,
    ).toBe(200);
    expect(
      (await s.api("POST", "/api/files/op", { op: "mkdir", scope, path: "docs" })).status,
    ).toBe(200);
    const list = await s.api<{ name: string; type: string; path: string }[]>(
      "GET",
      `/api/files/list?scope=${scope}`,
    );
    expect(list.body.map((e) => `${e.type}:${e.path}`)).toEqual(["dir:docs", "dir:src"]);
    expect(
      (await s.api("GET", `/api/files/content?scope=${scope}&path=src/a.txt`)).body,
    ).toMatchObject({ encoding: "utf8", content: "hello", size: 5 });
    expect(
      (
        await s.api("POST", "/api/files/op", {
          op: "rename",
          scope,
          path: "src/a.txt",
          to: "docs/b.txt",
        })
      ).status,
    ).toBe(200);
    expect(
      (await s.api("POST", "/api/files/op", { op: "delete", scope, path: "src" })).status,
    ).toBe(200);
    expect(
      (await s.api<{ path: string }[]>("GET", `/api/files/list?scope=${scope}&path=docs`)).body.map(
        (e) => e.path,
      ),
    ).toEqual(["docs/b.txt"]);

    const changes = (await s.core.store.list({ projectId: "files" }))
      .filter((e) => e.type === "workspace.changed")
      .map((e) => (e.payload as { action: string }).action);
    expect(changes).toEqual(["write", "mkdir", "rename", "delete"]);
  });

  it("detects save conflicts, keeps both on upload, and moves deleted files to the trash", async () => {
    s = await startServer([]);
    await s.api("POST", "/api/projects", { name: "Files" });
    const scope = "project:files";
    const put = (body: Record<string, unknown>) =>
      s?.api<{ path: string; modifiedAt: string; error?: string }>("PUT", "/api/files/content", {
        scope,
        ...body,
      });
    const first = await put({ path: "notes.md", content: "one" });
    const read = await s.api<{ modifiedAt: string }>(
      "GET",
      `/api/files/content?scope=${scope}&path=notes.md`,
    );
    expect(read.body.modifiedAt).toBe(first?.body.modifiedAt);
    // An agent writes meanwhile (a different time); the human's save is refused.
    await new Promise((r) => setTimeout(r, 20));
    await put({ path: "notes.md", content: "agent" });
    const stale = await put({
      path: "notes.md",
      content: "human",
      expectedModifiedAt: read.body.modifiedAt,
    });
    expect(stale?.status).toBe(409);
    expect(stale?.body.modifiedAt).not.toBe(read.body.modifiedAt);
    // Uploads: fail, keep both, replace.
    expect((await put({ path: "notes.md", content: "x", ifExists: "fail" }))?.status).toBe(409);
    expect((await put({ path: "notes.md", content: "x", ifExists: "keep-both" }))?.body.path).toBe(
      "notes (2).md",
    );
    expect((await put({ path: "notes.md", content: "x", ifExists: "keep-both" }))?.body.path).toBe(
      "notes (3).md",
    );
    expect((await put({ path: "notes.md", content: "new", ifExists: "replace" }))?.status).toBe(
      200,
    );
    // Deleting moves to .trash; deleting there is for good.
    await s.api("POST", "/api/files/op", { op: "delete", scope, path: "notes.md" });
    const names = async (path: string) =>
      (
        await s?.api<{ path: string }[]>("GET", `/api/files/list?scope=${scope}&path=${path}`)
      )?.body.map((e) => e.path);
    expect(await names(".")).toEqual([".trash", "notes (2).md", "notes (3).md"]);
    const [stamp] = (await names(".trash")) ?? [];
    expect(await names(stamp ?? "")).toEqual([`${stamp}/notes.md`]);
    await s.api("POST", "/api/files/op", { op: "delete", scope, path: stamp });
    expect(await names(".trash")).toEqual([]);
  });

  it("serves binary files as base64 and as raw downloads", async () => {
    s = await startServer([]);
    await s.api("POST", "/api/projects", { name: "Bin" });
    const bytes = Buffer.from([0, 1, 2, 255, 0, 10]).toString("base64");
    await s.api("PUT", "/api/files/content", {
      scope: "project:bin",
      path: "x.bin",
      content: bytes,
      encoding: "base64",
    });
    expect(
      (await s.api("GET", "/api/files/content?scope=project:bin&path=x.bin")).body,
    ).toMatchObject({ encoding: "base64", content: bytes });
    const raw = await fetch(`${s.url}/api/files/raw?scope=project:bin&path=x.bin`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(raw.headers.get("content-disposition")).toMatch(/x\.bin/);
    expect(Buffer.from(await raw.arrayBuffer()).toString("base64")).toBe(bytes);
  });

  it("gives God's platform its own space, per owner", async () => {
    s = await startServer([]);
    await s.api("PUT", "/api/files/content", {
      scope: "platform",
      path: "notes.md",
      content: "mine",
    });
    expect(
      (await s.api("GET", "/api/files/content?scope=platform&path=notes.md")).body,
    ).toMatchObject({ content: "mine" });
    expect(
      (await s.api("GET", "/api/files/content?scope=platform&path=notes.md", undefined, OTHER))
        .status,
    ).toBe(404);
  });

  it("refuses escapes, bad scopes and other owners' projects", async () => {
    s = await startServer([]);
    await s.api("POST", "/api/projects", { name: "Safe" });
    const scope = "project:safe";
    expect(
      (await s.api("GET", `/api/files/content?scope=${scope}&path=../../etc/passwd`)).status,
    ).toBe(400);
    await symlink("/etc", join(s.dir, "workspaces", "me", "safe", "out"));
    expect((await s.api("GET", `/api/files/list?scope=${scope}&path=out`)).status).toBe(400);
    expect((await s.api("POST", "/api/files/op", { op: "delete", scope, path: "." })).status).toBe(
      400,
    );
    expect((await s.api("GET", "/api/files/list?scope=nonsense")).status).toBe(400);
    expect((await s.api("GET", `/api/files/content?scope=${scope}&path=missing.txt`)).status).toBe(
      404,
    );
    expect((await s.api("GET", `/api/files/list?scope=${scope}`, undefined, OTHER)).status).toBe(
      404,
    );
  });
});

describe("budgets and web UI", () => {
  it("lists and sets the owner's budgets only", async () => {
    s = await startServer([]);
    await s.api("POST", "/api/projects", { name: "B" });
    expect((await s.api("PUT", "/api/budgets", { scope: "project", id: "b", usd: 5 })).status).toBe(
      200,
    );
    expect(
      (await s.api("PUT", "/api/budgets", { scope: "global", id: "me", tokens: 1000000 })).status,
    ).toBe(200);
    expect(
      (await s.api("PUT", "/api/budgets", { scope: "project", id: "b", usd: 1 }, OTHER)).status,
    ).toBe(404);
    const list = (
      await s.api<{ scope: string; id: string; limit: { usd?: number } }[]>("GET", "/api/budgets")
    ).body;
    expect(list.map((b) => `${b.scope}:${b.id}`).sort()).toEqual(["global:me", "project:b"]);
    // Someone else sees only their own (empty) total.
    expect((await s.api("GET", "/api/budgets", undefined, OTHER)).body).toEqual([
      { scope: "global", id: "someone-else", limit: {}, used: { usd: 0, tokens: 0 } },
    ]);
  });

  it("serves the built UI with a fallback to index.html, never outside its folder", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const web = await mkdtemp(join(tmpdir(), "rg-web-"));
    await mkdir(join(web, "assets"));
    await writeFile(join(web, "index.html"), "<!doctype html><title>RedGiant</title>");
    await writeFile(join(web, "assets", "app-1234.js"), "console.log(1)");
    s = await startServer([], {}, {}, web);
    const page = await fetch(`${s.url}/projects/x`);
    expect(await page.text()).toMatch(/<title>RedGiant/);
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const asset = await fetch(`${s.url}/assets/app-1234.js`);
    expect(asset.headers.get("content-type")).toMatch(/javascript/);
    expect(asset.headers.get("cache-control")).toMatch(/immutable/);
    // A script big enough is sent compressed (3.5.11), brotli first, raw to who takes neither.
    const big = `export const words = ${JSON.stringify("parola ".repeat(2000))};\n`;
    await writeFile(join(web, "assets", "big-5678.js"), big);
    const br = await fetch(`${s.url}/assets/big-5678.js`, { headers: { "accept-encoding": "br" } });
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("vary")).toMatch(/accept-encoding/);
    expect(await br.text()).toBe(big);
    const gz = await fetch(`${s.url}/assets/big-5678.js`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(await gz.text()).toBe(big);
    const plain = await fetch(`${s.url}/assets/big-5678.js`, {
      headers: { "accept-encoding": "identity" },
    });
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.text()).toBe(big);
    expect((await fetch(`${s.url}/assets/app-1234.js`)).headers.get("content-encoding")).toBeNull();
    expect(await (await fetch(`${s.url}/..%2F..%2Fetc%2Fpasswd`)).text()).toMatch(
      /<title>RedGiant/,
    );
    expect(
      (await fetch(`${s.url}/api/nope`, { headers: { authorization: `Bearer ${TOKEN}` } })).status,
    ).toBe(404);
  });
});

describe.skipIf(process.platform === "win32")("terminal", () => {
  it("opens a shell in the project, runs commands, resizes and logs open/close", async () => {
    s = await startServer([]);
    await s.api("POST", "/api/projects", { name: "Term" });
    const ws = new WebSocket(`${s.url.replace(/^http/, "ws")}/term`);
    let output = "";
    const events: { type: string; code?: number | null }[] = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data)) as { type: string; data?: string; code?: number | null };
      if (m.type === "output") output += m.data;
      else events.push(m);
    });
    await new Promise((ok) => ws.addEventListener("open", ok, { once: true }));
    ws.send(
      JSON.stringify({ type: "hello", token: TOKEN, scope: "project:term", cols: 100, rows: 30 }),
    );
    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(pred()).toBe(true);
    };
    await until(() => events.some((e) => e.type === "ready"));
    ws.send(JSON.stringify({ type: "input", data: "echo marker-$((40+2)) && pwd\r" }));
    await until(() => output.includes("marker-42"));
    expect(output).toMatch(/workspaces\/me\/term/);
    ws.send(JSON.stringify({ type: "resize", cols: 132, rows: 40 }));
    ws.send(JSON.stringify({ type: "input", data: "stty size\r" }));
    await until(() => output.includes("40 132"));
    ws.send(JSON.stringify({ type: "input", data: "exit\r" }));
    await until(() => events.some((e) => e.type === "exit"));
    expect(events.find((e) => e.type === "exit")?.code).toBe(0);
    const logged = (await s.core.store.list({ projectId: "term" })).map((e) => e.type);
    expect(logged).toEqual(["terminal.opened", "terminal.closed"]);
  });

  it("refuses connections without a valid token", async () => {
    s = await startServer([]);
    const ws = new WebSocket(`${s.url.replace(/^http/, "ws")}/term`);
    await new Promise((ok) => ws.addEventListener("open", ok, { once: true }));
    const closed = new Promise<number>((ok) => ws.addEventListener("close", (e) => ok(e.code)));
    ws.send(
      JSON.stringify({
        type: "hello",
        token: "nope-nope-nope-nope",
        scope: "platform",
        cols: 80,
        rows: 24,
      }),
    );
    expect(await closed).toBe(4003);
  });
});

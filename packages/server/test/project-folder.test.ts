import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { folderProblem } from "../src/projects.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
const extra: string[] = [];
afterEach(async () => {
  await s?.close();
  s = undefined;
  for (const d of extra.splice(0))
    await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("folderProblem (G36.15: a project on an existing folder)", () => {
  const rules = { dataDir: "/srv/redgiant", home: "/home/me" };
  const others = ["/home/me/code/shop"];
  // [folder, allowed?, rules]
  const table: [string, boolean, typeof rules & { inside?: string }][] = [
    ["/home/me/code/blog", true, rules],
    ["/home/me/code/blog/", true, rules],
    ["/tmp/bench/s01", true, rules],
    ["/mnt/archive1/work/app", true, rules],
    ["code/blog", false, rules],
    ["/", false, rules],
    ["/home", false, rules],
    ["/home/me", false, rules],
    ["/home/me/", false, rules],
    ["/etc", false, rules],
    ["/etc/nginx", false, rules],
    ["/usr/local/src/x", false, rules],
    ["/private/etc/hosts", false, rules],
    ["/private/var/folders/x/T/bench", true, rules],
    ["/var", false, rules],
    ["/var/www/site", true, rules],
    ["/srv/redgiant", false, rules],
    ["/srv/redgiant/keychain", false, rules],
    ["/srv/redgiant/workspaces/me/x", false, rules],
    ["/srv", false, rules],
    ["/home/me/code/shop", false, rules],
    ["/home/me/code/shop/web", false, rules],
    ["/home/me/code", false, rules],
    // The Docker image: inside the workspaces of the data volume only.
    ["/srv/redgiant/workspaces/me/x", true, { ...rules, inside: "/srv/redgiant/workspaces" }],
    ["/srv/redgiant/workspaces", false, { ...rules, inside: "/srv/redgiant/workspaces" }],
    ["/home/me/code/blog", false, { ...rules, inside: "/srv/redgiant/workspaces" }],
    // Windows, compared as Windows does.
    [
      "E:\\coding\\XAMPP\\htdocs\\site",
      true,
      { dataDir: "C:\\Users\\Me\\AppData\\RedGiant", home: "C:\\Users\\Me" },
    ],
    [
      "C:\\Users\\Me\\Desktop\\bench",
      true,
      { dataDir: "C:\\Users\\Me\\AppData\\RedGiant", home: "C:\\Users\\Me" },
    ],
    ["C:\\", false, { dataDir: "C:\\Users\\Me\\AppData\\RedGiant", home: "C:\\Users\\Me" }],
    ["E:", false, { dataDir: "C:\\Users\\Me\\AppData\\RedGiant", home: "C:\\Users\\Me" }],
    ["C:\\Users", false, { dataDir: "C:\\Users\\Me\\AppData\\RedGiant", home: "C:\\Users\\Me" }],
    [
      "c:\\users\\me",
      false,
      { dataDir: "C:\\Users\\Me\\AppData\\RedGiant", home: "C:\\Users\\Me" },
    ],
    [
      "C:\\Windows\\System32",
      false,
      { dataDir: "C:\\Users\\Me\\AppData\\RedGiant", home: "C:\\Users\\Me" },
    ],
    [
      "C:\\Program Files\\App",
      false,
      { dataDir: "C:\\Users\\Me\\AppData\\RedGiant", home: "C:\\Users\\Me" },
    ],
    [
      "c:/users/me/appdata/redgiant/keychain",
      false,
      { dataDir: "C:\\Users\\Me\\AppData\\RedGiant", home: "C:\\Users\\Me" },
    ],
  ];
  it.each(table)("%s -> allowed %s", (folder, allowed, r) => {
    expect(folderProblem(folder, r, others) === undefined).toBe(allowed);
  });
});

describe("POST /api/projects with a path", () => {
  it("adopts an existing folder as it is, and refuses the ones the rules forbid", async () => {
    s = await startServer([]);
    const outside = await mkdtemp(join(tmpdir(), "rg-adopt-"));
    extra.push(outside);
    const code = join(outside, "shop");
    await mkdir(join(code, "src"), { recursive: true });
    await writeFile(join(code, "src", "a.txt"), "already here");

    const made = await s.api<{ id: string; path: string }>("POST", "/api/projects", {
      name: "Shop",
      path: code,
    });
    expect(made.status).toBe(201);
    expect(made.body.path).toBe(await realpath(code));
    // The project's files are the folder's: listed and written in place.
    const list = await s.api<{ path: string }[]>(
      "GET",
      "/api/files/list?scope=project:shop&path=src",
    );
    expect(list.body.map((e) => e.path)).toEqual(["src/a.txt"]);
    await s.api("PUT", "/api/files/content", {
      scope: "project:shop",
      path: "b.txt",
      content: "new",
    });
    expect(await readFile(join(code, "b.txt"), "utf8")).toBe("new");

    const refused = async (body: unknown) => {
      const r = await s?.api<{ error: string }>("POST", "/api/projects", body);
      expect(r?.status).toBe(400);
      return r?.body.error ?? "";
    };
    // The same folder, one inside it, one around it: folders never overlap.
    expect(await refused({ name: "Shop two", path: code })).toMatch(/overlaps/);
    expect(await refused({ name: "Shop src", path: join(code, "src") })).toMatch(/overlaps/);
    expect(await refused({ name: "Around", path: outside })).toMatch(/overlaps/);
    // Nothing there, a file, a relative path, RedGiant's own data.
    expect(await refused({ name: "Ghost", path: join(outside, "nope") })).toMatch(/No folder/);
    expect(await refused({ name: "File", path: join(code, "b.txt") })).toMatch(/No folder/);
    expect(await refused({ name: "Rel", path: "shop" })).toMatch(/full path/);
    expect(await refused({ name: "Data", path: s.dir })).toMatch(/data folder/);
    // A link does not open a way into a forbidden folder.
    if (process.platform !== "win32") {
      await symlink(s.dir, join(outside, "to-data"));
      expect(await refused({ name: "Link", path: join(outside, "to-data") })).toMatch(
        /data folder/,
      );
    }
    // The name rule still holds.
    expect(await refused({ name: "Shop", path: join(outside, "other") })).toMatch(/No folder/);
    const other = join(outside, "other");
    await mkdir(other);
    expect(await refused({ name: "Shop", path: other })).toMatch(/already exists/);
  });

  it("in the Docker image takes only folders inside the data volume's workspaces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-adopt-"));
    extra.push(dir);
    s = await startServer([], {}, { projectFoldersInside: join(dir, "ws") });
    await mkdir(join(dir, "ws", "me", "old"), { recursive: true });
    await mkdir(join(dir, "elsewhere"));
    expect(
      (await s.api("POST", "/api/projects", { name: "Old", path: join(dir, "ws", "me", "old") }))
        .status,
    ).toBe(201);
    const r = await s.api<{ error: string }>("POST", "/api/projects", {
      name: "Else",
      path: join(dir, "elsewhere"),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/data volume/);
  });
});

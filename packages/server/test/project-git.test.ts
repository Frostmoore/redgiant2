import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ChatMessage } from "@redgiant/protocol";
import type { CompletionRequest, FakeTurn } from "@redgiant/providers";
import { createWorktree } from "@redgiant/sandbox";
import { LocalWorkspace } from "@redgiant/tools";
import { afterEach, describe, expect, it } from "vitest";
import {
  initProjectRepo,
  type RunGit,
  repoSentence,
  runGit,
  safeDirectoryPath,
} from "../src/project-git.js";
import { startServer } from "./helpers.js";

// A git repository in every new project (3.5.12, the person's test of 3.5.11 on Windows).

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await exec("git", args, { cwd })).stdout.trim();

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
const extra: string[] = [];
afterEach(async () => {
  await s?.close();
  s = undefined;
  for (const d of extra.splice(0))
    await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
const folder = async () => {
  const d = await mkdtemp(join(tmpdir(), "rg-git-"));
  extra.push(d);
  return d;
};
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
/** No git at all: what Windows says before Git for Windows is there. */
const noGit: RunGit = () =>
  Promise.reject(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }));

describe("safeDirectoryPath", () => {
  const table: [string, string][] = [
    [
      "C:\\Users\\Me\\AppData\\Roaming\\RedGiant\\workspaces\\me\\shop",
      "C:/Users/Me/AppData/Roaming/RedGiant/workspaces/me/shop",
    ],
    ["E:\\coding\\XAMPP\\htdocs\\site\\", "E:/coding/XAMPP/htdocs/site"],
    ["D:\\", "D:/"],
    ["C:/Users/Me/x", "C:/Users/Me/x"],
    ["/srv/redgiant/workspaces/me/shop", "/srv/redgiant/workspaces/me/shop"],
    ["/", "/"],
  ];
  it.each(table)("%s -> %s", (path, want) => {
    expect(safeDirectoryPath(path)).toBe(want);
  });
});

describe("initProjectRepo", () => {
  it("makes a repository on main with a first commit of what is there, once", async () => {
    const d = await folder();
    await writeFile(join(d, "index.html"), "<h1>Hi</h1>\n");
    expect(await initProjectRepo(d)).toEqual({ git: "created" });
    expect(await git(d, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await git(d, "log", "--format=%s %an")).toBe("Initial commit RedGiant");
    expect(await git(d, "ls-files")).toBe("index.html");
    expect(await git(d, "config", "core.autocrlf")).toBe("false");
    expect(await readFile(join(d, ".git", "info", "exclude"), "utf8")).toMatch(
      /^\.worktrees\/$[\s\S]*^\.redgiant\/$/m,
    );
    // A repository already there is left as it is.
    expect(await initProjectRepo(d)).toEqual({ git: "present" });
    expect(await git(d, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("an empty folder gets main without a commit; the first worktree takes what is there by then", async () => {
    const d = await folder();
    expect(await initProjectRepo(d)).toEqual({ git: "created" });
    expect(await git(d, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(await git(d, "rev-list", "--all", "--count")).toBe("0");
    await mkdir(join(d, "shared"));
    await writeFile(join(d, "shared", "theme.css"), "body{}");
    const wt = await createWorktree(new LocalWorkspace(d), "agent_1");
    expect(await readFile(join(d, wt, "shared", "theme.css"), "utf8")).toBe("body{}");
    expect(await git(d, "log", "--format=%s", "main")).toBe("Initial commit");
  });

  it("says git is missing instead of claiming a repository", async () => {
    const d = await folder();
    const r = await initProjectRepo(d, noGit);
    expect(r.git).toBe("missing");
    expect(repoSentence(r)).toMatch(/NO git repository: git is not installed/);
    expect(await exists(join(d, ".git"))).toBe(false);
  });

  it("marks a folder git calls of dubious ownership as safe (Windows), with forward slashes", async () => {
    const d = await folder();
    const asked: string[][] = [];
    const run: RunGit = async (args, cwd) => {
      asked.push(args);
      if (args[0] === "rev-parse")
        return {
          code: 128,
          stdout: "",
          stderr: `fatal: detected dubious ownership in repository at '${cwd}'`,
        };
      // The person's global configuration is not touched by the test.
      if (args.includes("--global")) return { code: 0, stdout: "", stderr: "" };
      return runGit(args, cwd);
    };
    expect(await initProjectRepo(d, run)).toEqual({ git: "created" });
    expect(asked).toContainEqual([
      "config",
      "--global",
      "--add",
      "safe.directory",
      safeDirectoryPath(d),
    ]);
  });

  it("reports a git that fails, with git's own words", async () => {
    const d = await folder();
    const run: RunGit = async () => ({ code: 128, stdout: "", stderr: "fatal: cannot mkdir" });
    expect(await initProjectRepo(d, run)).toEqual({
      git: "failed",
      error: "git init: fatal: cannot mkdir",
    });
  });
});

describe("projects and their repository (server)", () => {
  it("every new project from the page has its repository; the list says which have one", async () => {
    s = await startServer([]);
    const made = await s.api<{ id: string; path: string; git: boolean }>("POST", "/api/projects", {
      name: "Shop",
    });
    expect(made.status).toBe(201);
    expect(made.body.git).toBe(true);
    // An empty new folder: a repository on main, no commit yet; git answers in it.
    expect(await git(made.body.path, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(await git(made.body.path, "status", "--porcelain")).toBe("");
    expect(await git(made.body.path, "rev-list", "--all", "--count")).toBe("0");
    // git's folder is not in the files panel.
    await writeFile(join(made.body.path, "a.txt"), "a");
    const files = await s.api<{ path: string }[]>("GET", "/api/files/list?scope=project:shop");
    expect(files.body.map((e) => e.path)).toEqual(["a.txt"]);

    // An adopted folder keeps what it has: no repository, said, and «Initialise git» makes it.
    const outside = await folder();
    await writeFile(join(outside, "notes.md"), "# Notes\n");
    const adopted = await s.api<{ id: string; git: boolean }>("POST", "/api/projects", {
      name: "Notes",
      path: outside,
    });
    expect(adopted.body.git).toBe(false);
    const list = async () =>
      (await s?.api<{ id: string; git: boolean }[]>("GET", "/api/projects"))?.body.map((p) => [
        p.id,
        p.git,
      ]);
    expect(await list()).toEqual([
      ["shop", true],
      ["notes", false],
    ]);
    const init = await s.api<{ git: string }>("POST", "/api/projects/notes/git");
    expect(init).toEqual({ status: 200, body: { git: "created" } });
    expect(await git(outside, "ls-files")).toBe("notes.md");
    expect(await list()).toEqual([
      ["shop", true],
      ["notes", true],
    ]);
    expect((await s.api("POST", "/api/projects/notes/git")).body).toEqual({ git: "present" });
    expect((await s.api("POST", "/api/projects/ghost/git")).status).toBe(400);
  });

  it("without git the project is made and says so: the page and «Initialise git» alike", async () => {
    s = await startServer([]);
    s.core.projects.runGit = noGit;
    const made = await s.api<{ path: string; git: boolean; gitError: string }>(
      "POST",
      "/api/projects",
      { name: "Bare" },
    );
    expect(made.status).toBe(201);
    expect(made.body.git).toBe(false);
    expect(made.body.gitError).toMatch(/git is not installed/);
    expect(await exists(join(made.body.path, ".git"))).toBe(false);
    const again = await s.api<{ error: string }>("POST", "/api/projects/bare/git");
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/git is not installed/);
    // Once git is there, the button works.
    s.core.projects.runGit = runGit;
    expect((await s.api("POST", "/api/projects/bare/git")).status).toBe(200);
    expect(await exists(join(made.body.path, ".git"))).toBe(true);
  });

  it("an archived project is not given a repository (read only)", async () => {
    s = await startServer([]);
    const outside = await folder();
    await mkdir(join(outside, "src"));
    await s.api("POST", "/api/projects", { name: "Old", path: outside });
    await s.core.archiveProject("me", "old", "human");
    const r = await s.api<{ error: string }>("POST", "/api/projects/old/git");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/archived/);
    expect(await exists(join(outside, ".git"))).toBe(false);
  });
});

const textOf = (m: ChatMessage | undefined) =>
  m?.parts.flatMap((p) => (p.type === "tool_result" ? [p.content] : [])).join("\n") ?? "";
const call = (name: string, input: unknown): FakeTurn => ({ toolCalls: [{ name, input }] });

describe("God's create_project (3.5.12)", () => {
  const godMakes = async (name: string, missing = false) => {
    let result = "";
    s = await startServer((req: CompletionRequest) => {
      const last = req.messages.at(-1);
      if (last?.parts.some((p) => p.type === "tool_result")) {
        result = textOf(last);
        return { text: "Done." };
      }
      return call("create_project", { name });
    });
    if (missing) s.core.projects.runGit = noGit;
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const sid = await s.core.startSession("me", god.body.id);
    await (await s.core.send("me", sid, "Make it")).done;
    return result;
  };

  it("says the project has its repository only when it does", async () => {
    const r = await godMakes("Blog");
    expect(r).toMatch(/Created project blog/);
    expect(r).toMatch(/own git repository \(branch main\)/);
    expect(
      await git(
        join(s?.dir ?? "", "workspaces", "me", "blog"),
        "rev-parse",
        "--is-inside-work-tree",
      ),
    ).toBe("true");
  });

  it("tells God plainly when git is missing", async () => {
    const r = await godMakes("Blog", true);
    expect(r).toMatch(/Created project blog/);
    expect(r).toMatch(/NO git repository: git is not installed/);
    expect(r).not.toMatch(/own git repository/);
  });
});

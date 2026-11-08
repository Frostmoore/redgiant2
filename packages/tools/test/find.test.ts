// find_files (p3.4.0): never the real disks, never a real index. A fake computer (folders as a
// map, an index program as a function) for the order, the limits and the indexes; one small real
// tree in a temporary folder for the walk through Node's own fs.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  bashTool,
  baseTools,
  type DirEntry,
  diskWideRefusal,
  type ExecOptions,
  type FindDeps,
  type FindQuery,
  findFilesTool,
  findOnHost,
  findPattern,
  findPrograms,
  findReport,
  globRegExp,
  knownRoots,
  LocalWorkspace,
  realFindDeps,
  type Workspace,
} from "../src/index.js";

const ctx = { ownerId: "o", projectId: null, agentId: null, sessionId: "s" };

/**
 * A computer made of a map: each folder and its entries (a trailing "@" makes a link). What is
 * not a folder of the map is a file; `noexec` files have no execute bit.
 */
function fake(
  tree: Record<string, string[]>,
  o: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
    delayMs?: number;
    noexec?: string[];
    run?: FindDeps["run"];
  } = {},
) {
  const platform = o.platform ?? "linux";
  const p = platform === "win32" ? win32 : posix;
  const reads: string[] = [];
  const runs: { file: string; args: string[] }[] = [];
  const files = new Set<string>();
  for (const [dir, names] of Object.entries(tree))
    for (const n of names) {
      const full = p.join(dir, n.replace(/@$/, ""));
      if (!(full in tree)) files.add(full);
    }
  const deps: FindDeps = {
    platform,
    env: o.env ?? { PATH: "" },
    home: o.home ?? (platform === "win32" ? "C:\\Users\\me" : "/home/me"),
    async readdir(dir) {
      reads.push(dir);
      if (o.delayMs && tree[dir]) await new Promise((r) => setTimeout(r, o.delayMs));
      const names = tree[dir];
      if (!names) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return names.map(
        (n): DirEntry => ({
          name: n.replace(/@$/, ""),
          dir: p.join(dir, n.replace(/@$/, "")) in tree,
          link: n.endsWith("@"),
        }),
      );
    },
    async stat(path) {
      if (path in tree) return { dir: true, file: false, mode: 0o755 };
      if (files.has(path))
        return { dir: false, file: true, mode: o.noexec?.includes(path) ? 0o644 : 0o755 };
      return undefined;
    },
    async run(file, args, opts) {
      runs.push({ file, args });
      if (!o.run) throw new Error("no index here");
      return o.run(file, args, opts);
    },
    now: () => Date.now(),
  };
  return { deps, reads, runs };
}

const q = (over: Partial<FindQuery>): FindQuery => ({
  kind: "any",
  maxResults: 100,
  timeLimitMs: 5_000,
  ...over,
});

describe("find_files patterns", () => {
  it("reads globs on names, a part of the path, and a path's tail given as the name", () => {
    expect(globRegExp("*.jar").test("assertj-core-3.24.jar")).toBe(true);
    expect(globRegExp("*.jar").test("a.jar.txt")).toBe(false);
    expect(globRegExp("g++*").test("g++-13")).toBe(true);
    expect(globRegExp("g++*").test("gpp")).toBe(false);
    expect(globRegExp("file?.[ch]").test("FILE1.H")).toBe(true);
    expect(globRegExp("[!a]x").test("ax")).toBe(false);
    const part = findPattern(undefined, "date_time");
    expect(part.test("/usr/include/boost/date_time/x.hpp", "x.hpp")).toBe(true);
    expect(part.test("/usr/include/boost/other/x.hpp", "x.hpp")).toBe(false);
    const tail = findPattern("boost/date_time/gregorian/gregorian.hpp");
    expect(tail.name).toBe("gregorian.hpp");
    expect(
      tail.test(
        "C:\\msys64\\usr\\include\\boost\\date_time\\gregorian\\gregorian.hpp",
        "gregorian.hpp",
      ),
    ).toBe(true);
    expect(tail.test("/x/gregorian/gregorian.hpp", "gregorian.hpp")).toBe(false);
  });
});

describe("find_files places", () => {
  it("puts the project, the PATH, the package caches and the home before the disks (Linux)", () => {
    const roots = knownRoots({
      platform: "linux",
      env: { PATH: "/usr/bin:/home/me/bin" },
      home: "/home/me",
      project: "/home/me/work/app",
    });
    const dirs = roots.map((r) => r.dir);
    expect(dirs[0]).toBe("/home/me/work/app");
    expect(roots.slice(1, 3)).toEqual([
      { dir: "/usr/bin", depth: 0 },
      { dir: "/home/me/bin", depth: 0 },
    ]);
    const at = (d: string) => dirs.indexOf(d);
    expect(at("/home/me/.gradle")).toBeGreaterThan(2);
    expect(at("/home/me/.m2")).toBeGreaterThan(at("/home/me/.gradle"));
    expect(at("/usr/include")).toBeGreaterThan(0);
    expect(at("/home/me")).toBeGreaterThan(at("/usr/include"));
    expect(dirs.at(-1)).toBe("/");
  });

  it("on Windows: MSYS2 and Program Files before the home, the system drive before the others", () => {
    const dirs = knownRoots({
      platform: "win32",
      env: {
        Path: "C:\\Windows\\system32;C:\\msys64\\ucrt64\\bin",
        SystemDrive: "C:",
        ProgramFiles: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      },
      home: "C:\\Users\\me",
      project: "E:\\code\\app",
    }).map((r) => r.dir);
    expect(dirs[0]).toBe("E:\\code\\app");
    expect(dirs[1]).toBe("C:\\Windows\\system32");
    const at = (d: string) => dirs.indexOf(d);
    expect(at("C:\\Users\\me\\.gradle")).toBeGreaterThan(0);
    expect(at("C:\\msys64")).toBeGreaterThan(at("C:\\Users\\me\\.gradle"));
    expect(at("C:\\Program Files")).toBeGreaterThan(at("C:\\msys64"));
    expect(at("C:\\Users\\me")).toBeGreaterThan(at("C:\\Program Files (x86)"));
    expect(at("C:\\")).toBeGreaterThan(at("C:\\Users\\me"));
    expect(at("D:\\")).toBe(at("C:\\") + 1);
  });
});

/** A small computer: the same jar in the project, a Gradle cache and elsewhere on the disk. */
const disk: Record<string, string[]> = {
  "/": ["home", "opt", "proc", "srv"],
  "/home": ["me"],
  "/home/me": ["work", ".gradle", "Pictures"],
  "/home/me/work": ["app"],
  "/home/me/work/app": ["lib", "node_modules", ".git"],
  "/home/me/work/app/lib": ["junit-a.jar"],
  "/home/me/work/app/node_modules": ["junit-hidden.jar"],
  "/home/me/work/app/.git": ["junit-git.jar"],
  "/home/me/.gradle": ["caches"],
  "/home/me/.gradle/caches": ["junit-b.jar", "notes.txt"],
  "/home/me/Pictures": ["cat.png"],
  "/opt": ["junit-c.jar"],
  "/proc": ["junit-proc.jar"],
  "/srv": ["link@"],
  "/srv/link": ["junit-through-link.jar"],
};

describe("find_files walk", () => {
  it("finds in the likely places first, skips what nobody looks in, and walks each folder once", async () => {
    const { deps, reads } = fake(disk);
    const r = await findOnHost(q({ name: "junit-*.jar" }), { project: "/home/me/work/app", deps });
    expect(r).toMatchObject({ source: "walk", cut: undefined, notSearched: [] });
    expect(r.paths).toEqual([
      "/home/me/work/app/lib/junit-a.jar",
      "/home/me/.gradle/caches/junit-b.jar",
      "/opt/junit-c.jar",
    ]);
    // node_modules, .git, /proc and a link's target are never read; the project only once.
    for (const d of ["node_modules", ".git", "/proc", "/srv/link"])
      expect(
        reads.some((x) => x.includes(d)),
        d,
      ).toBe(false);
    expect(reads.filter((x) => x === "/home/me/work/app").length).toBe(1);
    expect(reads.filter((x) => x === "/home/me/.gradle/caches").length).toBe(1);
  });

  it("stops at max_results with the nearest ones, and finds folders and parts of paths", async () => {
    const { deps } = fake(disk);
    const one = await findOnHost(q({ name: "*.jar", maxResults: 1 }), {
      project: "/home/me/work/app",
      deps,
    });
    expect(one).toMatchObject({ paths: ["/home/me/work/app/lib/junit-a.jar"], cut: "max" });
    const folders = await findOnHost(q({ name: "caches", kind: "folder" }), { deps });
    expect(folders.paths).toEqual(["/home/me/.gradle/caches/"]);
    const part = await findOnHost(q({ path: "gradle/caches", kind: "file" }), { deps });
    expect(part.paths).toEqual([
      "/home/me/.gradle/caches/junit-b.jar",
      "/home/me/.gradle/caches/notes.txt",
    ]);
    const under = await findOnHost(q({ name: "*.jar", under: "/opt" }), { deps });
    expect(under.paths).toEqual(["/opt/junit-c.jar"]);
  });

  it("is cut by its time limit and says what it did not search", async () => {
    // A slow disk with folders without end.
    const tree: Record<string, string[]> = { "/": ["deep"], "/home/me": ["x.txt"] };
    let dir = "/deep";
    for (let i = 0; i < 200; i++) {
      tree[dir] = ["d", `f${i}.log`];
      dir = `${dir}/d`;
    }
    const { deps } = fake(tree, { delayMs: 20 });
    const t0 = Date.now();
    const r = await findOnHost(q({ name: "*.log", timeLimitMs: 300 }), { deps });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.cut).toBe("time");
    expect(r.paths.length).toBeGreaterThan(0);
    expect(r.paths.length).toBeLessThan(200);
    expect(r.notSearched).toContain("/");
    const text = findReport(r, { maxResults: 100, seconds: 0 });
    expect(text).toContain("Stopped by the time limit");
    expect(text).toContain("Not searched (or not to the end): /");
  });

  it("stops at once when the session is interrupted, with what it found so far", async () => {
    const tree: Record<string, string[]> = { "/": ["deep", "a.log"] };
    let dir = "/deep";
    for (let i = 0; i < 200; i++) {
      tree[dir] = ["d"];
      dir = `${dir}/d`;
    }
    const { deps } = fake(tree, { delayMs: 20 });
    const c = new AbortController();
    setTimeout(() => c.abort(), 100);
    const t0 = Date.now();
    const r = await findOnHost(q({ name: "*.log", signal: c.signal, timeLimitMs: 30_000 }), {
      deps,
    });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r).toMatchObject({ cut: "interrupted", paths: ["/a.log"] });
    expect(findReport(r, { maxResults: 100, seconds: 0 })).toContain("Interrupted");
  });

  it("skips Windows' own folders and the recycle bin", async () => {
    const tree: Record<string, string[]> = {
      "C:\\": ["$Recycle.Bin", "Windows", "System Volume Information", "data"],
      "C:\\$Recycle.Bin": ["x.jar"],
      "C:\\System Volume Information": ["x.jar"],
      "C:\\Windows": ["WinSxS", "Installer", "ok.jar"],
      "C:\\Windows\\WinSxS": ["x.jar"],
      "C:\\Windows\\Installer": ["x.jar"],
      "C:\\data": ["X.JAR"],
    };
    const { deps, reads } = fake(tree, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows", SystemDrive: "C:", Path: "" },
    });
    const r = await findOnHost(q({ name: "*.jar" }), { deps });
    expect(r.paths).toEqual(["C:\\Windows\\ok.jar", "C:\\data\\X.JAR"]);
    expect(reads.some((d) => /Recycle|WinSxS|Installer|Volume/.test(d))).toBe(false);
  });

  it("walks a real folder through Node's own fs", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-find-"));
    try {
      mkdirSync(join(root, "a", "b"), { recursive: true });
      mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "a", "b", "gregorian.hpp"), "");
      writeFileSync(join(root, "node_modules", "gregorian.hpp"), "");
      const r = await findOnHost(q({ name: "a/b/gregorian.hpp", under: root }), {
        deps: realFindDeps({ PATH: "" }),
      });
      expect(r).toMatchObject({ source: "walk", cut: undefined });
      expect(r.paths).toEqual([join(root, "a", "b", "gregorian.hpp")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("find_files programs (like which)", () => {
  it("on Windows uses PATHEXT, in the PATH's order", async () => {
    const { deps } = fake(
      {
        "C:\\bin": ["g++.exe", "g++.txt", "gcc.EXE", "clang++.CMD", "g++.d"],
        "C:\\bin\\g++.d": [],
        "C:\\tools": ["g++.exe", "g++-13.exe"],
      },
      { platform: "win32", env: { Path: "C:\\bin;C:\\missing;C:\\tools", PATHEXT: ".EXE;.CMD" } },
    );
    expect(await findPrograms("g++", deps)).toEqual(["C:\\bin\\g++.exe", "C:\\tools\\g++.exe"]);
    expect(await findPrograms("g++*", deps)).toEqual([
      "C:\\bin\\g++.exe",
      "C:\\tools\\g++-13.exe",
      "C:\\tools\\g++.exe",
    ]);
    expect(await findPrograms("CLANG++", deps)).toEqual(["C:\\bin\\clang++.CMD"]);
    expect(await findPrograms("gcc.exe", deps)).toEqual(["C:\\bin\\gcc.EXE"]);
  });

  it("elsewhere needs the execute bit, and the tool says which one runs", async () => {
    const { deps } = fake(
      { "/usr/bin": ["clang++", "readme"], "/opt/bin": ["clang++"] },
      { env: { PATH: "/usr/bin:/opt/bin" }, noexec: ["/usr/bin/readme"] },
    );
    expect(await findPrograms("readme", deps)).toEqual([]);
    const tool = findFilesTool(new LocalWorkspace(tmpdir()), "full", { host: true, deps });
    const out = await tool.run({ name: "clang++", executable: true }, ctx);
    expect(out).toBe(
      "2 found (the PATH):\n/usr/bin/clang++\n/opt/bin/clang++\n(The first one is what runs.)\nThe search was complete.",
    );
  });
});

describe("find_files indexes", () => {
  const files = {
    "C:\\": ["x"],
    "C:\\x": [],
    "C:\\Everything": ["es.exe"],
    "C:\\Users\\me\\.gradle\\caches": ["junit-1.jar"],
  };

  it("asks Everything when its es.exe is there, and checks what it says", async () => {
    const { deps, runs, reads } = fake(files, {
      platform: "win32",
      env: { Path: "C:\\Everything", ProgramFiles: "C:\\Program Files" },
      run: async () => ({
        stdout: "C:\\Users\\me\\.gradle\\caches\\junit-1.jar\r\nC:\\gone\\junit-2.jar\r\n",
        exitCode: 0,
      }),
    });
    const r = await findOnHost(q({ name: "junit-*.jar", path: "gradle", kind: "file" }), { deps });
    expect(r).toMatchObject({
      source: "everything",
      paths: ["C:\\Users\\me\\.gradle\\caches\\junit-1.jar"],
    });
    expect(runs[0]?.file).toBe("C:\\Everything\\es.exe");
    expect(runs[0]?.args).toEqual(["-n", "1000", "/a-d", "junit-*.jar", "path:*gradle*"]);
    expect(reads).toEqual([]);
  });

  it("believes Everything when it finds nothing, never lets a name be an es.exe option", async () => {
    const empty = fake(files, {
      platform: "win32",
      env: { Path: "C:\\Everything" },
      run: async () => ({ stdout: "", exitCode: 0 }),
    });
    const none = await findOnHost(q({ name: "gregorian.hpp" }), { deps: empty.deps });
    expect(none).toMatchObject({ source: "everything", paths: [] });
    expect(empty.reads).toEqual([]);
    const opt = fake(files, {
      platform: "win32",
      env: { Path: "C:\\Everything" },
      run: async () => ({ stdout: "", exitCode: 0 }),
    });
    const r = await findOnHost(q({ name: "-export-csv", under: "C:\\x" }), { deps: opt.deps });
    expect(opt.runs).toEqual([]);
    expect(r.source).toBe("walk");
  });

  it("walks when Everything's service is not running", async () => {
    const { deps, reads } = fake(files, {
      platform: "win32",
      env: { Path: "C:\\Everything" },
      run: async () => ({ stdout: "Error 8: Everything IPC not found.", exitCode: 8 }),
    });
    const r = await findOnHost(q({ name: "*.jar", under: "C:\\Users\\me\\.gradle\\caches" }), {
      deps,
    });
    expect(r).toMatchObject({
      source: "walk",
      paths: ["C:\\Users\\me\\.gradle\\caches\\junit-1.jar"],
    });
    expect(reads.length).toBeGreaterThan(0);
  });

  it("asks Spotlight on macOS, and walks when it finds nothing (it skips hidden folders)", async () => {
    const tree = {
      "/usr/bin": ["mdfind"],
      "/Users/me/.gradle": ["a.jar"],
      "/Users/me/Downloads": ["b.jar"],
    };
    const found = fake(tree, {
      platform: "darwin",
      home: "/Users/me",
      run: async () => ({ stdout: "/Users/me/Downloads/b.jar\n", exitCode: 0 }),
    });
    await findOnHost(q({ name: 'a"b?.jar', under: "/none" }), { deps: found.deps });
    expect(found.runs[0]?.args).toEqual(["-onlyin", "/none", 'kMDItemFSName == "a\\"b*.jar"c']);
    const r = await findOnHost(q({ name: "*.jar" }), { deps: found.deps });
    expect(r).toMatchObject({ source: "spotlight", paths: ["/Users/me/Downloads/b.jar"] });
    const empty = fake(tree, {
      platform: "darwin",
      home: "/Users/me",
      run: async () => ({ stdout: "", exitCode: 0 }),
    });
    const w = await findOnHost(q({ name: "a.jar", under: "/Users/me/.gradle" }), {
      deps: empty.deps,
    });
    expect(empty.runs[0]?.args).toEqual([
      "-onlyin",
      "/Users/me/.gradle",
      'kMDItemFSName == "a.jar"c',
    ]);
    expect(w).toMatchObject({ source: "walk", paths: ["/Users/me/.gradle/a.jar"] });
  });

  it("asks plocate on Linux with the pattern after --", async () => {
    const { deps, runs } = fake(
      { "/usr/bin": ["plocate"], "/usr/share/java": ["junit.jar"] },
      {
        env: { PATH: "/usr/bin" },
        run: async () => ({ stdout: "/usr/share/java/junit.jar\n/old/junit.jar\n", exitCode: 0 }),
      },
    );
    const r = await findOnHost(q({ name: "*.jar" }), { deps });
    expect(runs[0]).toEqual({
      file: "/usr/bin/plocate",
      args: ["-i", "-l", "1000", "-b", "--", "*.jar"],
    });
    expect(r).toMatchObject({ source: "locate", paths: ["/usr/share/java/junit.jar"] });
  });
});

describe("find_files in a container", () => {
  /** A container: execFile is recorded and answers what `answer` says. */
  function container(
    answer: (file: string, args: string[]) => { stdout: string; timedOut?: boolean },
  ) {
    const calls: { file: string; args: string[]; o: ExecOptions }[] = [];
    const ws = {
      root: "/data/p",
      readOnly: false,
      execFile: async (file: string, args: string[], o: ExecOptions) => {
        calls.push({ file, args, o });
        const a = answer(file, args);
        return {
          stdout: a.stdout,
          stderr: "",
          exitCode: a.timedOut ? 137 : 0,
          timedOut: a.timedOut ?? false,
        };
      },
    } as unknown as Workspace;
    return { ws, calls };
  }

  it("runs one find there, project first, with the limits, and reports a cut", async () => {
    const { ws, calls } = container(() => ({
      stdout: "./lib/a.jar\n/usr/share/java/b.jar\n/usr/share/java/b.jar\n",
      timedOut: true,
    }));
    const tool = findFilesTool(ws, "full");
    const out = await tool.run({ name: "*.jar", path: "java", time_limit_s: 5 }, ctx);
    expect(calls[0]?.file).toBe("find");
    expect(calls[0]?.args.slice(0, 5)).toEqual([".", "/", "-xdev", "-maxdepth", "20"]);
    expect(calls[0]?.args).toContain("-iname");
    expect(calls[0]?.args.slice(-4)).toEqual(["*.jar", "-ipath", "*java*", "-print"]);
    expect(calls[0]?.o.timeoutMs).toBe(5_000);
    expect(out).toContain("2 found (find in the container):\nlib/a.jar\n/usr/share/java/b.jar");
    expect(out).toContain("Stopped by the time limit");
  });

  it("lists the container's programs with a fixed script, nothing of the model in it", async () => {
    const { ws, calls } = container(() => ({
      stdout: "/usr/bin/g++\n/usr/bin/gcc\n/usr/local/bin/g++-13\n",
    }));
    const out = await findFilesTool(ws, "full").run({ name: "g++*", executable: true }, ctx);
    expect(calls[0]?.file).toBe("sh");
    expect(calls[0]?.args[1]).not.toContain("g++");
    expect(out).toContain("2 found (the PATH):\n/usr/bin/g++\n/usr/local/bin/g++-13");
  });
});

describe("find_files as a tool", () => {
  const root = mkdtempSync(join(tmpdir(), "rg-findtool-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("is a base tool, wants a name or a path, and bash points to it", async () => {
    const ws = new LocalWorkspace(root);
    const tools = baseTools({ workspace: ws, host: true });
    const t = tools.find((x) => x.def.name === "find_files");
    expect(t?.def.description).toContain("instead of find /");
    expect(t?.schema?.safeParse({}).success).toBe(false);
    expect(t?.schema?.safeParse({ path: "x", executable: true }).success).toBe(false);
    expect(t?.schema?.safeParse({ name: "*.jar", time_limit_s: 61 }).success).toBe(false);
    const bash = bashTool(ws, "full");
    expect(bash.def.description).toContain("use find_files");
    expect(bashTool(ws, "compact").def.description).toContain("use find_files");
    expect(diskWideRefusal(ws)).toContain("use find_files");
  });
});

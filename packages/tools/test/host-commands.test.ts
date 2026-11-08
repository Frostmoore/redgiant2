// Commands on this computer (p3.4.0, the benchmark on Windows, 2026-11-08): a stopped command
// always comes back, even when something keeps its output open; a turn the person stops ends even
// when a tool never returns, and the next message runs; commands have no input; a walk of a whole
// disk is answered at once instead of run.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@redgiant/agent";
import { EventStore, migrate } from "@redgiant/events";
import { FakeProvider, ProviderRegistry } from "@redgiant/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bashTool,
  cmdHint,
  diskWideSearch,
  isDiskRoot,
  LocalWorkspace,
  SubprojectWorkspace,
  shellPath,
  startFolder,
  type Workspace,
} from "../src/index.js";
import { memoryDb } from "./pglite.js";

const posix = process.platform !== "win32";
const ctx = { ownerId: "me", projectId: "p", agentId: "a", sessionId: "s" } as never;
const text = (r: unknown) => (typeof r === "string" ? r : (r as { content: string }).content);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rg-hostcmd-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("diskWideSearch (a table: change it first)", () => {
  const refused = [
    'find / -name "gregorian.hpp" -path "*date_time*" 2>/dev/null | head -3; echo done',
    `cd ~ 2>/dev/null; cd "$(dirname "$(find / -path '*/src/main/java/ChangeCalculator.java' 2>/dev/null | head -1)")/../../.." 2>/dev/null && pwd && ls`,
    'ls /mingw64/bin 2>/dev/null | head -50; find / -name "g++*" -type f 2>/dev/null | grep -v proc | head -5',
    "find /c -iname cl.exe",
    "find /c/ -iname cl.exe",
    "find /mnt/c -name x",
    "find C:/ -name x",
    "find . / -name x",
    "find /* -name x",
    "sudo find / -name x",
    "timeout 60 find / -name x",
    "ls -R /",
    "ls -laR /c",
    "grep -rn TODO /",
    "grep -R --include=*.h boost /c/",
    "rg gregorian /",
    "du -sh /",
    'bash -c "find / -name x"',
    'powershell -Command "Get-ChildItem C:\\ -Recurse -Filter cl.exe"',
    "powershell.exe -NoProfile -Command \"gci -Path 'C:\\' -rec -Filter x.h\"",
    "cmd //c dir C:\\ /s /b",
    "cmd.exe /c dir C:\\cl.exe /s",
    "echo start\nfind / -name x\necho end",
    "x=$(find / -name a.h)",
    "echo `find / -name a.h`",
  ];
  const allowed = [
    "find . -name '*.java'",
    "find src -type f",
    'find "$VS" -iname "cl.exe" 2>/dev/null | head -3',
    "find /usr/include -name gregorian.hpp",
    "find / -maxdepth 2 -name boost",
    "find / -name boost -maxdepth 3",
    "find /c/Users/Pixel/.gradle/caches -name '*.jar'",
    "ls /",
    "ls -la /c/",
    "ls -r /",
    "grep -n main /etc/hosts",
    "grep -r TODO .",
    "grep -rn TODO src/",
    "rg TODO",
    "du -sh node_modules",
    "echo 'never run find / here'",
    "git commit -m 'stop find / walks'",
    "cat > note.sh <<'EOF'\nfind / -name x\nEOF\nchmod +x note.sh",
    'powershell -Command "Get-ChildItem . -Recurse"',
    "cmd //c dir /b",
    "dir C:\\",
    "cd /c/Users/Pixel/project && ls",
  ];
  it.each(refused)("refuses %s", (c) => expect(diskWideSearch(c)).toBe(true));
  it.each(allowed)("allows %s", (c) => expect(diskWideSearch(c)).toBe(false));

  it("knows a disk's root from a folder", () => {
    for (const p of ["/", "//", "/.", "/*", "C:", "C:\\", "c:/", "\\", "/c", "/d/", "/mnt/c"])
      expect(isDiskRoot(p), p).toBe(true);
    for (const p of ["/usr", "/c/Users", "C:\\Users", ".", "src", "/tmp", "~"])
      expect(isDiskRoot(p), p).toBe(false);
  });
});

describe("where the project is", () => {
  it("writes a folder as Git's bash does on Windows, and as it is elsewhere", () => {
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
    expect(shellPath("C:\\Users\\Pixel\\ws\\p1", "win32", bash)).toBe("/c/Users/Pixel/ws/p1");
    expect(shellPath("D:\\", "win32", bash)).toBe("/d");
    expect(shellPath("C:\\Users\\Pixel", "win32", "powershell.exe")).toBe("C:\\Users\\Pixel");
    expect(shellPath("/home/me/p1", "linux", "/bin/bash")).toBe("/home/me/p1");
  });

  it("starts in a subproject's own folder", () => {
    const inner = new LocalWorkspace(dir);
    expect(startFolder(inner)).toBe(inner.root);
    const sub = new SubprojectWorkspace(inner, "apps/shop", []);
    expect(startFolder(sub)).toMatch(/apps[\\/]shop$/);
  });

  it("explains a cmd /c that opened interactively in Git's bash", () => {
    const banner =
      "Microsoft Windows [Versione 10.0.26200]\r\n(c) Microsoft Corporation.\r\n\r\nC:\\ws>";
    expect(cmdHint(`cmd.exe /c '"vcvars64.bat" && cl x.cpp'`, banner)).toMatch(/cmd \/\/c/);
    expect(cmdHint("cmd //c dir", banner)).toBeUndefined();
    expect(cmdHint("cmd.exe /c dir", "x.cpp")).toBeUndefined();
  });
});

/** A workspace whose commands never end and ignore every stop (the benchmark's `find /`). */
function hangingWorkspace(root: string, ran: string[] = []): Workspace {
  return {
    root,
    readOnly: false,
    readText: async () => "",
    writeText: async () => {},
    exists: async () => false,
    isFile: async () => false,
    glob: async () => [],
    exec: (command) => {
      ran.push(command);
      return new Promise(() => {});
    },
    execFile: () => new Promise(() => {}),
    openTerminal: async () => {
      throw new Error("none");
    },
  };
}

describe("bash on this computer", () => {
  it("answers a walk of the whole disk at once, with the project's folder; in a container it runs", async () => {
    const ran: string[] = [];
    const ws = hangingWorkspace(dir, ran);
    const host = bashTool(ws, "full", 30_000, undefined, undefined, true);
    const r = await host.run({ command: "find / -name gregorian.hpp 2>/dev/null" }, ctx);
    expect(r).toMatchObject({ isError: true });
    expect(text(r)).toMatch(/^Not run: this command searches a whole disk/);
    expect(text(r)).toContain(shellPath(dir));
    expect(ran).toEqual([]);
    // The same tool and description everywhere: only the check differs.
    const container = bashTool(ws, "full", 30_000, undefined, undefined, false);
    expect(container.def).toEqual(host.def);
    void container.run({ command: "find / -name x", timeout_ms: 1000 }, ctx);
    expect(ran).toEqual(["find / -name x"]);
  });

  it("gives commands no input: a program that reads it ends at once", async () => {
    const ws = new LocalWorkspace(dir);
    const t0 = Date.now();
    const r = await ws.exec(
      `node -e "process.stdin.resume(); process.stdin.on('end', () => console.log('eof'))"`,
      { timeoutMs: 20_000 },
    );
    expect(r).toMatchObject({ timedOut: false, exitCode: 0 });
    expect(r.stdout).toContain("eof");
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it.runIf(posix)(
    "comes back after a timeout or a stop even when something it started keeps the output open",
    async () => {
      const ws = new LocalWorkspace(dir, false, undefined, 300);
      // A grandchild in a session of its own: stopping the command's group does not reach it, and
      // it holds the output open for 20 s (as the stuck `find` did on Windows).
      const node = JSON.stringify(process.execPath);
      const escaper = `${node} -e "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: ['ignore', 1, 2] }); console.log('pid ' + c.pid); c.unref()"`;
      const pids: number[] = [];
      try {
        const t0 = Date.now();
        const r = await ws.exec(`${escaper}; sleep 30`, { timeoutMs: 500 });
        expect(r.timedOut).toBe(true);
        expect(Date.now() - t0).toBeLessThan(5_000);
        expect(r.stderr).toMatch(/\[RedGiant: the command was stopped/);
        pids.push(Number(/pid (\d+)/.exec(r.stdout)?.[1]));

        const c = new AbortController();
        setTimeout(() => c.abort(), 300);
        const t1 = Date.now();
        const s = await ws.exec(`${escaper}; sleep 30`, { timeoutMs: 60_000, signal: c.signal });
        expect(s.timedOut).toBe(false);
        expect(Date.now() - t1).toBeLessThan(5_000);
        pids.push(Number(/pid (\d+)/.exec(s.stdout)?.[1]));
      } finally {
        for (const p of pids)
          try {
            if (p) process.kill(p, "SIGKILL");
          } catch {}
      }
    },
  );
});

describe("a stopped turn (the benchmark's interrupt)", () => {
  it("ends even when a command never returns, and the next message runs a turn", async () => {
    const { db } = await memoryDb();
    await migrate(db);
    const store = new EventStore(db);
    const fake = new FakeProvider((req) => {
      const last = req.messages.at(-1)?.parts[0];
      return last?.type === "text" && last.text === "tests failed, go on"
        ? { text: "on it" }
        : {
            text: "Running the tests.",
            toolCalls: [{ name: "bash", input: { command: "make test" } }],
          };
    });
    const ran: string[] = [];
    const session = await AgentSession.start({
      store,
      providers: new ProviderRegistry().register(fake),
      model: { provider: "fake", model: "m1", effort: "medium" },
      system: "You are a test agent.",
      tools: [bashTool(hangingWorkspace(dir, ran), "full")],
      sessionId: "s1",
      projectId: "p1",
      stopGraceMs: 200,
    });
    const stop = new AbortController();
    const turn = session.send("solve it", stop.signal);
    while (ran.length === 0) await new Promise((r) => setTimeout(r, 10));
    const t0 = Date.now();
    stop.abort();
    expect((await turn).stopReason).toBe("aborted");
    expect(Date.now() - t0).toBeLessThan(3_000);
    const results = (await store.list({ sessionId: "s1" })).filter((e) => e.type === "tool.result");
    expect(results.at(-1)?.payload).toMatchObject({ ok: false, output: /^Cancelled/ });

    const next = await session.send("tests failed, go on");
    expect(next).toMatchObject({ stopReason: "end_turn", turns: 1 });
  });
});

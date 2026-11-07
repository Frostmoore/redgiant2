// The programs that keep the layout (G34.3, «se c'è da scaricare qualcosa si scaricherà la prima
// volta e via»): Scribus and Blender downloaded for each system with their bar, unpacked without
// installing; closed apps found to open what no free program reads; the agents' blender tool.
// Everything here is faked: nothing downloads and no program runs.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { type ExecOptions, type ExecResult, LocalWorkspace } from "@redgiant/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blenderTool, commands } from "../src/convert-blender.js";
import {
  blenderAsset,
  downloadProgram,
  findDesktopApp,
  findProgram,
  openInApp,
  Programs,
  type Runner,
  scribusAsset,
} from "../src/convert-programs.js";
import { Jobs } from "../src/jobs.js";

const ctx = { ownerId: "me", projectId: null, agentId: "a", sessionId: "s" } as never;
const text = (r: unknown) => (typeof r === "string" ? r : (r as { content: string }).content);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rg-programs-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("what to download", () => {
  it("knows Scribus's and Blender's official packages for each system", () => {
    const sf = "https://downloads.sourceforge.net/project/scribus/scribus/1.6.7/scribus-1.6.7";
    expect(scribusAsset("1.6.7", "linux", "x64")).toEqual({
      url: `${sf}-linux-x86_64.AppImage`,
      kind: "appimage",
    });
    expect(scribusAsset("1.6.7", "win32", "x64")).toEqual({
      url: `${sf}-windows-x64.exe`,
      kind: "nsis",
    });
    expect(scribusAsset("1.6.7", "darwin", "arm64")).toMatchObject({
      url: `${sf}-arm64.dmg`,
      app: "Scribus.app",
    });
    expect(scribusAsset("1.6.7", "darwin", "x64")?.url).toBe(`${sf}.dmg`);
    expect(scribusAsset("1.6.7", "linux", "arm64")).toBeUndefined();
    const bl = "https://download.blender.org/release";
    expect(blenderAsset("5.2.3", "linux", "x64")).toEqual({
      url: `${bl}/Blender5.2/blender-5.2.3-linux-x64.tar.xz`,
      kind: "tarxz",
    });
    expect(blenderAsset("5.2.3", "win32", "arm64")?.url).toBe(
      `${bl}/Blender5.2/blender-5.2.3-windows-arm64.zip`,
    );
    expect(blenderAsset("5.2.3", "darwin", "arm64")?.url).toBe(
      `${bl}/Blender5.2/blender-5.2.3-macos-arm64.dmg`,
    );
    // Intel Macs: the last LTS that still runs there.
    expect(blenderAsset("5.2.3", "darwin", "x64")?.url).toBe(
      `${bl}/Blender4.5/blender-4.5.15-macos-x64.dmg`,
    );
  });

  it("downloads Scribus with its bar and unpacks it without installing (fakes only)", async () => {
    const fetched: string[] = [];
    const fakeFetch = (async (url: string) => {
      fetched.push(String(url));
      return new Response(new Uint8Array(2000).fill(1), { headers: { "content-length": "2000" } });
    }) as typeof fetch;
    const ran: { file: string; args: string[]; cwd?: string | undefined }[] = [];
    const run: Runner = async (file, args, o) => {
      ran.push({ file, args, cwd: o.cwd });
      if (args[0] === "--appimage-extract") {
        await mkdir(join(o.cwd as string, "squashfs-root"), { recursive: true });
        await writeFile(join(o.cwd as string, "squashfs-root", "AppRun"), "");
      }
      if (file === "msiexec") {
        const target = (args.find((a) => a.startsWith("TARGETDIR=")) as string).slice(10);
        await mkdir(join(target, "Files", "7-Zip"), { recursive: true });
        await writeFile(join(target, "Files", "7-Zip", "7z.exe"), "");
      }
      if (file.endsWith("7z.exe")) {
        const out = (args.find((a) => a.startsWith("-o")) as string).slice(2);
        await mkdir(out, { recursive: true });
        await writeFile(join(out, "Scribus.exe"), "");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const data = join(root, "data");
    const progress: number[] = [];
    const linux = await downloadProgram(
      "scribus",
      data,
      (d) => progress.push(d),
      new AbortController().signal,
      () => {},
      { fetch: fakeFetch, run, platform: "linux", arch: "x64" },
    );
    expect(linux).toBe(join(data, "tools/scribus/squashfs-root/AppRun"));
    expect(ran[0]).toMatchObject({
      args: ["--appimage-extract"],
      cwd: join(data, "tools/scribus"),
    });
    expect(progress.at(-1)).toBe(2000);
    expect(existsSync(join(data, "tools/scribus/package.appimage"))).toBe(false);
    expect(findProgram("scribus", data, { PATH: "" }, "linux")).toBe(linux);

    // Windows: 7-Zip (from its MSI, files only) unpacks the NSIS installer; nothing installed.
    ran.length = 0;
    const win = await downloadProgram(
      "scribus",
      data,
      () => {},
      new AbortController().signal,
      () => {},
      { fetch: fakeFetch, run, platform: "win32", arch: "x64" },
    );
    expect(fetched).toContain("https://www.7-zip.org/a/7z2501-x64.msi");
    expect(ran.map((r) => r.file)[0]).toBe("msiexec");
    expect(ran[1]?.file).toMatch(/7z\.exe$/);
    expect(ran[1]?.args.slice(0, 2)).toEqual(["x", "-y"]);
    expect(ran[1]?.args.at(-1)).toBe(join(data, "tools/scribus/package.exe"));
    expect(win).toMatch(/Scribus\.exe$/);
  });

  it("downloads Blender as its portable build: tar.xz, zip, DMG", async () => {
    const fakeFetch = (async () =>
      new Response(new Uint8Array(10), { headers: { "content-length": "10" } })) as typeof fetch;
    const ran: { file: string; args: string[] }[] = [];
    const run: Runner = async (file, args) => {
      ran.push({ file, args });
      if (file === "tar") {
        const dir = args[args.indexOf("-C") + 1] as string;
        const sub = join(dir, "blender-5.2.3-x");
        await mkdir(sub, { recursive: true });
        await writeFile(join(sub, args[0] === "-xJf" ? "blender" : "blender.exe"), "");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const data = join(root, "data");
    const linux = await downloadProgram(
      "blender",
      data,
      () => {},
      new AbortController().signal,
      () => {},
      {
        fetch: fakeFetch,
        run,
        platform: "linux",
        arch: "x64",
      },
    );
    expect(ran[0]).toEqual({
      file: "tar",
      args: ["-xJf", join(data, "tools/blender/package.tar.xz"), "-C", join(data, "tools/blender")],
    });
    expect(linux).toBe(join(data, "tools/blender/blender-5.2.3-x/blender"));
    const win = await downloadProgram(
      "blender",
      data,
      () => {},
      new AbortController().signal,
      () => {},
      {
        fetch: fakeFetch,
        run,
        platform: "win32",
        arch: "x64",
      },
    );
    expect(ran[1]?.args[0]).toBe("-xf");
    expect(win).toMatch(/blender\.exe$/);
    // The job of its own, with its bar, as for LibreOffice.
    const jobs = new Jobs();
    let got = false;
    const programs = new Programs({
      jobs,
      dataDir: join(root, "d"),
      find: (id) => (id === "blender" && got ? "/x/blender" : undefined),
      download: {
        platform: "linux",
        arch: "x64",
        fetch: fakeFetch,
        run: async (f, a) => {
          const r = await run(f, a, { timeoutMs: 1 });
          got = true;
          return r;
        },
      },
    });
    expect(programs.canDownload("scribus")).toBe(true);
    await programs.ensure("me", "blender");
    expect(jobs.list("me").map((j) => [j.kind, j.state])).toEqual([["download_blender", "done"]]);
  });

  it("finds Scribus, Blender and the closed apps where people install them", () => {
    const has =
      (...ps: string[]) =>
      (p: string) =>
        ps.includes(p);
    const pf = "C:\\PF";
    expect(
      findProgram(
        "scribus",
        "/d",
        { PATH: "", ProgramFiles: pf },
        "win32",
        has(win32.join(pf, "Scribus 1.6.7", "Scribus.exe")),
        (d) => (d === pf ? ["Scribus 1.6.5", "Scribus 1.6.7", "Other"] : []),
      ),
    ).toBe(win32.join(pf, "Scribus 1.6.7", "Scribus.exe"));
    expect(
      findProgram(
        "blender",
        "/d",
        { PATH: "" },
        "darwin",
        has("/Applications/Blender.app/Contents/MacOS/Blender"),
      ),
    ).toMatch(/Blender\.app/);
    expect(findProgram("blender", "/d", { REDGIANT_BLENDER: "/b" }, "linux", has("/b"))).toBe("/b");
    expect(
      findDesktopApp(
        "affinity",
        "win32",
        { ProgramFiles: pf },
        has(win32.join(pf, "Affinity", "Affinity", "Affinity.exe")),
      ),
    ).toBe(win32.join(pf, "Affinity", "Affinity", "Affinity.exe"));
    expect(
      findDesktopApp("affinity", "darwin", {}, has("/Applications/Affinity Designer 2.app"), () => [
        "Affinity Designer 2.app",
        "Mail.app",
      ]),
    ).toBe("/Applications/Affinity Designer 2.app");
    expect(
      findDesktopApp(
        "indesign",
        "win32",
        { ProgramFiles: pf },
        has(win32.join(pf, "Adobe", "Adobe InDesign 2026", "InDesign.exe")),
        () => ["Adobe InDesign 2025", "Adobe InDesign 2026"],
      ),
    ).toBe(win32.join(pf, "Adobe", "Adobe InDesign 2026", "InDesign.exe"));
    expect(findDesktopApp("affinity", "linux")).toBeUndefined();
    const launched: string[][] = [];
    openInApp("/Applications/Affinity.app", "/w/a.afdesign", "darwin", (f, a) =>
      launched.push([f, ...a]),
    );
    openInApp("C:\\A\\Affinity.exe", "C:\\w\\a.af", "win32", (f, a) => launched.push([f, ...a]));
    expect(launched).toEqual([
      ["open", "-a", "/Applications/Affinity.app", "/w/a.afdesign"],
      ["C:\\A\\Affinity.exe", "C:\\w\\a.af"],
    ]);
  });
});

/** A workspace whose programs are a fake Blender that writes what the spec asks for. */
class FakeBlenderWorkspace extends LocalWorkspace {
  calls: { file: string; args: string[]; o: ExecOptions }[] = [];
  answer: Partial<ExecResult> | undefined;
  override async execFile(file: string, args: string[], o: ExecOptions): Promise<ExecResult> {
    this.calls.push({ file, args, o });
    const spec = JSON.parse(await readFile(join(this.root, args.at(-1) as string), "utf8")) as {
      out: string;
      script?: string;
      save_blend: boolean;
      render?: { turntable?: boolean };
    };
    const made: string[] = [];
    const write = async (ext: string) => {
      await mkdir(join(this.root, spec.out, ".."), { recursive: true });
      await writeFile(join(this.root, `${spec.out}${ext}`), ext);
      made.push(`${spec.out}${ext}`);
    };
    if (spec.save_blend) await write(".blend");
    await write(".glb");
    if (spec.render) await write(spec.render.turntable ? ".webm" : ".png");
    const script = spec.script ? await readFile(join(this.root, spec.script), "utf8") : "";
    return {
      stdout: `Blender 5.2.3\n${script.includes("print") ? "hello from bpy\n" : ""}REDGIANT_RESULT ${JSON.stringify(made)}\n`,
      stderr: "",
      exitCode: 0,
      timedOut: false,
      ...this.answer,
    };
  }
}

describe("the blender tool", () => {
  const programs = () =>
    new Programs({
      jobs: new Jobs(),
      dataDir: join(root, ".d"),
      find: () => "/opt/blender/blender",
    });

  it("runs the agent's script without a window, in the project, with time and thread limits", async () => {
    const ws = new FakeBlenderWorkspace(root);
    await writeFile(join(root, "chair.fbx"), "fbx");
    const shown: string[] = [];
    const tool = blenderTool(ws, {
      programs: programs(),
      threads: 2,
      show: async (r) => {
        shown.push(r.path);
        return "shown";
      },
    });
    const said = text(
      await tool.run(
        {
          file: "chair.fbx",
          script: "print('hi')",
          render: { turntable: true, frames: 24 },
          show: true,
          timeout_s: 60,
        },
        ctx,
      ),
    );
    const call = ws.calls[0];
    expect(call?.file).toBe("/opt/blender/blender");
    expect(call?.args).toEqual(
      commands.script(
        expect.stringMatching(/^\.redgiant-blender\/[^/]+\/run\.py$/) as never,
        [expect.stringMatching(/spec\.json$/) as never],
        2,
      ),
    );
    expect(call?.args.slice(0, 6)).toEqual([
      "-b",
      "--factory-startup",
      "-noaudio",
      "-t",
      "2",
      "-P",
    ]);
    expect(call?.o.timeoutMs).toBe(60_000);
    expect(said).toContain("- blender/chair.blend");
    expect(said).toContain("- blender/chair.glb");
    expect(said).toContain("- blender/chair.webm");
    expect(said).toContain("hello from bpy");
    expect(shown).toEqual(["blender/chair.webm"]);
    // The script and spec are gone afterwards.
    expect(existsSync(join(root, ".redgiant-blender"))).toBe(false);
  });

  it("accepts the render values models really send (p3.3.1: «render: Invalid input»)", async () => {
    const ws = new FakeBlenderWorkspace(root);
    await writeFile(join(root, "cube.glb"), "glb");
    const tool = blenderTool(ws, { programs: programs() });
    // The schema the model sees says render is an object.
    const props = (tool.def.inputSchema as { properties: Record<string, { type?: string }> })
      .properties;
    expect(props.render?.type).toBe("object");
    const cases: [unknown, string][] = [
      [true, ".png"],
      [{ samples: 64 }, ".png"],
      [{ width: 1280, height: 800, samples: 64 }, ".png"],
      [{ turntable: true }, ".webm"],
      // The same, as engines hand them over when they stringify arguments.
      ["true", ".png"],
      ['{"samples": 64}', ".png"],
      ['{"width": "1280", "height": "800", "samples": "64"}', ".png"],
      ['{"turntable": "true", "frames": 36}', ".webm"],
      ["turntable", ".webm"],
      [{ engine: "EEVEE", view: "Front" }, ".png"],
    ];
    for (const [render, ext] of cases) {
      for (const base of [{ script: "import bpy" }, { file: "cube.glb" }]) {
        const parsed = tool.schema?.safeParse({ ...base, render });
        expect(parsed?.success, JSON.stringify(render)).toBe(true);
        const said = text(await tool.run(parsed?.data, ctx));
        expect(said, JSON.stringify(render)).toContain(`${ext}`);
      }
    }
    expect(tool.schema?.safeParse({ script: "x", render: { samples: 0 } }).success).toBe(false);
    expect(tool.schema?.safeParse({ script: "x", render: "false" }).data).toMatchObject({
      render: false,
    });
  });

  it("refuses what it cannot do and says why Blender stopped", async () => {
    const ws = new FakeBlenderWorkspace(root);
    const tool = blenderTool(ws, { programs: programs() });
    expect(text(await tool.run({}, ctx))).toMatch(/Give a script/);
    expect(text(await tool.run({ file: "nope.blend" }, ctx))).toMatch(/no file/);
    await writeFile(join(root, "a.dae"), "x");
    expect(text(await tool.run({ file: "a.dae" }, ctx))).toMatch(/not \.dae/);
    ws.answer = {
      exitCode: 1,
      stdout: "",
      stderr: "Traceback\nNameError: name 'x' is not defined\n",
    };
    expect(text(await tool.run({ script: "x" }, ctx))).toMatch(
      /Blender stopped \(1\)[\s\S]*NameError/,
    );
    ws.answer = { exitCode: null, timedOut: true, stdout: "", stderr: "" };
    expect(text(await tool.run({ script: "while True: pass", timeout_s: 10 }, ctx))).toMatch(
      /past 10 s/,
    );
    ws.answer = { exitCode: 127, stdout: "", stderr: "not found" };
    expect(text(await tool.run({ render: true }, ctx))).toMatch(/sandbox has no Blender/);
  });
});

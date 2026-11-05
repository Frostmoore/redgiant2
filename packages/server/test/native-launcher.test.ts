import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { appleGpu, detectHardware } from "../src/hardware.js";
import {
  engineArgs,
  engineAsset,
  modelParts,
  NativeLauncher,
  parseVmStat,
  safeArgs,
} from "../src/native-launcher.js";
import { WinEngine } from "../src/win-engine.js";

/** A tar.gz with these files (path → content, mode). */
function tgz(files: [string, string, number][]): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text, mode] of files) {
    const data = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write(
      `${Math.floor(Date.now() / 1000)
        .toString(8)
        .padStart(11, "0")}\0`,
      136,
    );
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

let launcher: NativeLauncher | undefined;
afterEach(async () => {
  await launcher?.close();
  launcher = undefined;
});

describe("the local engine on a Mac (2026-11-05)", () => {
  it("knows llama.cpp's macOS builds and builds the launcher's arguments as a list", () => {
    expect(engineAsset("b1", "darwin", "arm64")).toBe("llama-b1-bin-macos-arm64.tar.gz");
    expect(engineAsset("b1", "darwin", "x64")).toBe("llama-b1-bin-macos-x64.tar.gz");
    expect(engineAsset("b1", "linux", "x64")).toBeUndefined();
    expect(safeArgs("--n-cpu-moe 30  -ot exps=CPU")).toEqual([
      "--n-cpu-moe",
      "30",
      "-ot",
      "exps=CPU",
    ]);
    // Anything but plain words is dropped, as by the Windows launcher.
    expect(safeArgs("--x; rm -rf /")).toEqual([]);
    expect(modelParts("/m", "a.gguf")).toEqual([join("/m", "a.gguf")]);
    expect(modelParts("/m", "big-00001-of-00003.gguf")).toEqual([
      join("/m", "big-00001-of-00003.gguf"),
      join("/m", "big-00002-of-00003.gguf"),
      join("/m", "big-00003-of-00003.gguf"),
    ]);
    const args = engineArgs(
      "/e",
      {
        id: "1",
        model: "m.gguf",
        build: "b1",
        ctx: 8192,
        parallel: 4,
        args: "--kv-unified-per-slot 8192",
        fit: "1",
        draft: "../evil.gguf",
      },
      8091,
    );
    expect(args.slice(0, 8)).toEqual([
      "-m",
      join("/e", "models", "m.gguf"),
      "--host",
      "127.0.0.1",
      "--port",
      "8091",
      "-c",
      "8192",
    ]);
    expect(args).toContain("--jinja");
    expect(args).not.toContain("--n-gpu-layers");
    expect(args.slice(-2)).toEqual(["--kv-unified-per-slot", "8192"]);
    // A draft model is a plain file name in models/, nothing else.
    expect(args).not.toContain("-md");
  });

  it("reads what macOS can hand out from vm_stat", () => {
    const text = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               65536.
Pages active:                            300000.
Pages inactive:                           65536.
Pages speculative:                            0.
Pages purgeable:                          65536.
`;
    expect(parseVmStat(text)).toBe(3);
    expect(parseVmStat("nothing")).toBeUndefined();
  });

  it("sees Apple Silicon's GPU and runs the engine next to RedGiant", async () => {
    expect(appleGpu("Apple M6", 16)).toEqual({
      name: "Apple M6",
      vramGb: 12,
      vendor: "apple",
      integrated: false,
    });
    const hw = await detectHardware({
      dataDir: tmpdir(),
      gpus: async () => [],
      hostGpus: "",
      platform: "darwin",
      arch: "arm64",
    });
    expect(hw.windowsEngine).toBe(true);
    expect(hw.gpus[0]?.vendor).toBe("apple");
    expect(hw.suggestion.engine).toBe("windows");
    expect(hw.suggestion.kind).toBe("gpu");
  });

  it.skipIf(process.platform === "win32")(
    "downloads llama.cpp once, starts the model, says when it is ready, and stops it",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "rg-native-engine-"));
      // A stand-in for llama-server: records its arguments and answers /health.
      const fake = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(require("node:path").join(__dirname, "args.json"), JSON.stringify(process.argv.slice(2)));
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
require("node:http").createServer((q, r) => r.end("ok")).listen(port, "127.0.0.1");
`;
      const archive = tgz([
        ["llama-b7/", "", 0o755],
        ["llama-b7/llama-server", fake, 0o755],
        ["llama-b7/libggml.dylib", "lib", 0o644],
      ]);
      let downloads = 0;
      const server = createServer((req, res) => {
        if (req.url === "/b7/llama-b7-bin-macos-arm64.tar.gz") {
          downloads++;
          res.writeHead(200, { "content-length": archive.length });
          res.end(archive);
        } else res.writeHead(404).end();
      });
      await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
      const port = 30000 + Math.floor(Math.random() * 20000);
      try {
        launcher = new NativeLauncher({
          dir,
          build: "b7",
          port,
          pollMs: 50,
          platform: "darwin",
          arch: "arm64",
          releases: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        });
        launcher.start();
        await mkdir(join(dir, "models"), { recursive: true });
        await writeFile(join(dir, "models", "tiny.gguf"), "GGUF");
        const engine = new WinEngine({ dir, host: "127.0.0.1", pollMs: 50, noticeMs: 5000 });
        const steps: string[] = [];
        const h = {
          signal: new AbortController().signal,
          step: (s: string) => void (steps.at(-1) !== s && steps.push(s)),
          progress: () => {},
          skip: () => {},
        };
        const url = await engine.start("tiny.gguf", h as never, undefined, true);
        expect(url).toBe(`http://127.0.0.1:${port}`);
        expect(await (await fetch(`${url}/health`)).text()).toBe("ok");
        // The steps the server shows (a fast fake server may pass the first ones between two looks).
        expect(steps.at(-1)).toBe("load");
        expect(downloads).toBe(1);
        const bin = join(dir, "bin", "current");
        expect(await readFile(join(bin, "build.txt"), "utf8")).toBe("b7");
        expect(existsSync(join(bin, "libggml.dylib"))).toBe(true);
        const args = JSON.parse(await readFile(join(bin, "args.json"), "utf8")) as string[];
        expect(args.slice(0, 2)).toEqual(["-m", join(dir, "models", "tiny.gguf")]);
        expect(args).toContain("--slot-save-path");
        // Memory for the models page, as Windows' launcher writes it.
        for (let i = 0; i < 50 && !existsSync(join(dir, "memory.json")); i++)
          await new Promise((r) => setTimeout(r, 50));
        const mem = JSON.parse(await readFile(join(dir, "memory.json"), "utf8"));
        expect(mem.totalGb).toBeGreaterThan(0);

        // Another model: the engine is there already, nothing comes down again.
        await writeFile(join(dir, "models", "other.gguf"), "GGUF");
        await engine.start("other.gguf", h as never);
        expect(downloads).toBe(1);
        await engine.stop();
        for (let i = 0; i < 50 && (await engine.status())?.state !== "stopped"; i++)
          await new Promise((r) => setTimeout(r, 50));
        expect((await engine.status())?.state).toBe("stopped");
        await expect(
          fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) }),
        ).rejects.toThrow();
      } finally {
        server.close();
        await launcher?.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

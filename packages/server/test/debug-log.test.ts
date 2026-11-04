import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { debugLog } from "../src/debug-log.js";
import { Jobs } from "../src/jobs.js";

const flush = () => new Promise((r) => setTimeout(r, 50));

describe("debug mode (2026-11-04)", () => {
  it("logs nothing while off; when on, every job's steps with their times, and an archive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-dbg-"));
    const win = await mkdtemp(join(tmpdir(), "rg-dbg-win-"));
    await debugLog.configure({ dir: join(dir, "logs"), winDir: win });
    expect(debugLog.enabled).toBe(false);
    debugLog.write("test", "not written");

    await debugLog.setEnabled(true);
    // The Windows launcher sees the switch in its own folder.
    expect((await stat(join(win, "debug.on"))).isFile()).toBe(true);
    const jobs = new Jobs();
    const job = jobs.start("me", "engine", ["image", "load"], async (h) => {
      h.step("image");
      h.step("load");
      h.info({ preloadGbs: "3.2" });
    });
    expect((await jobs.settled(job.id))?.state).toBe("done");
    debugLog.raw("engine", "llama: offloaded 20/40 layers to GPU\nsecond line");
    await flush();
    const files = await readdir(join(dir, "logs"));
    expect(files.some((f) => f.startsWith("redgiant-"))).toBe(true);
    const server = await readFile(
      join(dir, "logs", files.find((f) => f.startsWith("redgiant-")) ?? ""),
      "utf8",
    );
    expect(server).not.toContain("not written");
    const events = server
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { message: string; data?: Record<string, unknown> });
    expect(events.map((e) => e.message)).toEqual(
      expect.arrayContaining([
        "engine started",
        "engine step image",
        "engine step load",
        "engine done",
      ]),
    );
    expect(events.find((e) => e.message === "engine step load")?.data).toMatchObject({
      after: "image",
    });

    const state = await debugLog.state();
    expect(state).toMatchObject({ enabled: true, forced: false });
    expect(state.files).toBeGreaterThanOrEqual(2);
    const tar = gunzipSync(await debugLog.archive()).toString("latin1");
    expect(tar).toContain("offloaded 20/40 layers");
    expect(tar).toContain("engine step load");

    await debugLog.clear();
    await debugLog.setEnabled(false);
    await expect(stat(join(win, "debug.on"))).rejects.toThrow();
    expect((await debugLog.state()).enabled).toBe(false);
  });
});

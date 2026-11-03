import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tarFile } from "../src/runtime.js";

describe("RedGiant's own search engine (2026-11-03)", () => {
  it.skipIf(process.platform === "win32")(
    "puts its settings in a tar archive that tar itself reads back",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "rg-tar-"));
      try {
        const settings = "use_default_settings: true\nsearch:\n  formats: [html, json]\n";
        await writeFile(join(dir, "s.tar"), tarFile("settings.yml", settings));
        expect(
          execFileSync("tar", ["-tf", join(dir, "s.tar")])
            .toString()
            .trim(),
        ).toBe("settings.yml");
        expect(execFileSync("tar", ["-xOf", join(dir, "s.tar"), "settings.yml"]).toString()).toBe(
          settings,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

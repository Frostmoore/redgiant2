import { chmod, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { browserCandidates, findBrowser, LocalBrowserLauncher } from "../src/browser.js";

/** A stand-in for Chrome: answers DevTools' /json/version on the port it is given. */
const FAKE_CHROME = `#!/usr/bin/env node
const port = Number(process.argv.find((a) => a.startsWith("--remote-debugging-port="))?.split("=")[1]);
const profile = process.argv.find((a) => a.startsWith("--user-data-dir="))?.split("=")[1];
require("fs").writeFileSync(profile + "/args.json", JSON.stringify({ args: process.argv.slice(2), secret: process.env.REDGIANT_TOKEN_PROBE ?? null }));
require("http").createServer((q, r) => r.end(JSON.stringify({ Browser: "Fake/1" }))).listen(port, "127.0.0.1");
`;

describe("the browser on this computer (G29.8)", () => {
  it("finds Chrome, Chromium or Edge where each system keeps them", () => {
    const linux = browserCandidates("linux", {});
    expect(linux).toContain("/usr/bin/chromium");
    expect(browserCandidates("darwin", { HOME: "/Users/m" })[0]).toMatch(/Google Chrome\.app/);
    expect(
      browserCandidates("win32", { PROGRAMFILES: "C:\\Program Files" }).some((p) =>
        p.endsWith("msedge.exe"),
      ),
    ).toBe(true);
    expect(findBrowser({}, "linux", (p) => p === "/usr/bin/chromium")).toBe("/usr/bin/chromium");
    expect(findBrowser({ REDGIANT_BROWSER_PATH: "/opt/c" }, "linux", () => false)).toBe("/opt/c");
    expect(findBrowser({}, "linux", () => false)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "starts it with a profile of its own, headless, without the server's secrets",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "rg-browser-"));
      const exe = join(dir, "chrome");
      await writeFile(exe, FAKE_CHROME);
      await chmod(exe, 0o755);
      process.env.REDGIANT_TOKEN_PROBE = "secret";
      const l = new LocalBrowserLauncher({ executable: exe, profilesDir: join(dir, "profiles") });
      try {
        const url = await l.endpoint("me");
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        // The same browser while it runs.
        expect(await l.endpoint("me")).toBe(url);
        const { args, secret } = JSON.parse(
          await import("node:fs/promises").then((f) =>
            f.readFile(join(dir, "profiles", "me", "args.json"), "utf8"),
          ),
        ) as { args: string[]; secret: string | null };
        expect(args).toContain("--headless=new");
        expect(args).toContain(`--user-data-dir=${join(dir, "profiles", "me")}`);
        expect(secret).toBeNull();
      } finally {
        delete process.env.REDGIANT_TOKEN_PROBE;
        await l.stop("me");
      }
      expect(await readdir(join(dir, "profiles"))).toEqual(["me"]);
    },
  );
});

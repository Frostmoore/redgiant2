// LibreOffice's profiles (p3.5.3, the person's test of 3.5.1 on Windows: an agent's soffice met
// another LibreOffice on the same profile and Windows showed a dialog until the person pressed
// OK). Every run RedGiant starts has a profile of its own and no window; the agents' commands get
// RedGiant's soffice, which makes a profile for each command and removes it.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileConverter } from "../src/convert.js";
import { Programs } from "../src/convert-programs.js";
import { Jobs } from "../src/jobs.js";
import { installOfficeLaunchers, officeLaunchers } from "../src/lo-agents.js";
import { LO_QUIET, LoProfiles } from "../src/lo-profiles.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const temp = async (name: string) => {
  const d = await mkdtemp(join(tmpdir(), name));
  dirs.push(d);
  return d;
};
const profileOf = (args: string[]) =>
  args.find((a) => a.startsWith("-env:UserInstallation="))?.slice("-env:UserInstallation=".length);

describe("RedGiant's own LibreOffice runs", () => {
  it("never share a profile, and never show a window", async () => {
    const root = await temp("rg-lo-");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "a.docx"), "PK fake a");
    await writeFile(join(root, "docs", "b.docx"), "PK fake b");
    const running = new Set<string>();
    const seen: { profile: string; overlapped: boolean; args: string[] }[] = [];
    const run = async (_file: string, args: string[]) => {
      const profile = profileOf(args) ?? "";
      const overlapped = running.size > 0;
      expect(running.has(profile)).toBe(false);
      running.add(profile);
      await new Promise((r) => setTimeout(r, 80));
      running.delete(profile);
      seen.push({ profile, overlapped, args });
      const out = args[args.indexOf("--outdir") + 1] as string;
      const input = args.at(-1) as string;
      const stem = basename(input).replace(/\.[^.]+$/, "");
      await mkdir(out, { recursive: true });
      await writeFile(join(out, `${stem}.odt`), "odt");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const converter = new FileConverter({
      programs: new Programs({
        jobs: new Jobs(),
        dataDir: join(root, ".data"),
        find: (id) => (id === "libreoffice" ? "/bin/soffice" : undefined),
        download: { platform: "linux", arch: "riscv" },
      }),
      profileDir: join(root, ".data", "tools", "libreoffice-profile"),
      run,
      platform: "linux",
    });
    await Promise.all([
      converter.convert(root, "docs/a.docx", { owner: "me", to: ["odt"] }),
      converter.convert(root, "docs/b.docx", { owner: "me", to: ["odt"] }),
    ]);
    expect(seen).toHaveLength(2);
    // Both at once, each on its own profile.
    expect(seen.some((x) => x.overlapped)).toBe(true);
    expect(new Set(seen.map((x) => x.profile)).size).toBe(2);
    for (const x of seen) {
      expect(x.profile).toMatch(/^file:\/\/.*libreoffice-profile(-2)?$/);
      for (const flag of LO_QUIET) expect(x.args).toContain(flag);
    }
  });

  it("wait for a free profile beyond the pool's size", async () => {
    const pool = new LoProfiles("/data/p", 2);
    const held: string[] = [];
    let most = 0;
    await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        pool.use(async (dir) => {
          expect(held).not.toContain(dir);
          held.push(dir);
          most = Math.max(most, held.length);
          await new Promise((r) => setTimeout(r, 10));
          held.splice(held.indexOf(dir), 1);
        }),
      ),
    );
    expect(most).toBe(2);
    expect([pool.dirOf(0), pool.dirOf(1)]).toEqual(["/data/p", "/data/p-2"]);
  });
});

// A real LibreOffice, when the machine has one (REDGIANT_TEST_SOFFICE=/…/soffice); never in CI.
const SOFFICE = process.env.REDGIANT_TEST_SOFFICE;
describe.skipIf(!SOFFICE)("two conversions at once with a real LibreOffice", () => {
  it("both finish, on two profiles", async () => {
    const root = await temp("rg-lo-real-");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "a.txt"), "Alpha\n");
    await writeFile(join(root, "docs", "b.txt"), "Beta\n");
    const converter = new FileConverter({
      programs: new Programs({
        jobs: new Jobs(),
        dataDir: join(root, ".data"),
        find: (id) => (id === "libreoffice" ? SOFFICE : undefined),
      }),
      profileDir: join(root, ".data", "tools", "libreoffice-profile"),
    });
    const [a, b] = await Promise.all([
      converter.convert(root, "docs/a.txt", { owner: "me", to: ["pdf"] }),
      converter.convert(root, "docs/b.txt", { owner: "me", to: ["pdf"] }),
    ]);
    expect(a.outputs.map((o) => o.path)).toEqual(["docs/a.txt.open/a.pdf"]);
    expect(b.outputs.map((o) => o.path)).toEqual(["docs/b.txt.open/b.pdf"]);
  }, 180_000);
});

describe("the agents' soffice", () => {
  const run = (file: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((ok) =>
      execFile(file, args, { env }, (err, stdout, stderr) =>
        ok({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      ),
    );

  it.skipIf(process.platform === "win32")(
    "passes every argument intact, with a profile of its own made and removed",
    async () => {
      const root = await temp("rg lo agents ");
      // The «real» LibreOffice: prints each argument on a line and whether its profile exists.
      const real = join(root, "Program Files", "soffice");
      await mkdir(join(root, "Program Files"), { recursive: true });
      await writeFile(
        real,
        [
          "#!/bin/sh",
          'for a in "$@"; do printf "%s\\n" "$a"; done',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the script's own parameter expansion
          'for a in "$@"; do case "$a" in -env:UserInstallation=file://*) p=$(printf "%s" "${a#-env:UserInstallation=file://}" | sed "s/%20/ /g"); [ -d "$p" ] && echo PROFILE-EXISTS ;; esac; done',
          "exit 7",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const data = join(root, "data dir");
      const bin = installOfficeLaunchers(data, real, "linux");
      expect(bin).toBeDefined();
      const args = [
        "--convert-to",
        "pdf",
        "--outdir",
        join(root, "out dir"),
        "my file (1).docx",
        "it's $HOME *",
        "",
        'a"b',
      ];
      const twice = await Promise.all([
        run(join(bin as string, "soffice"), args),
        run(join(bin as string, "libreoffice"), args),
      ]);
      const profiles: string[] = [];
      for (const r of twice) {
        // The real program's exit code comes back.
        expect(r.code).toBe(7);
        const lines = r.stdout.split("\n");
        expect(lines.at(-2)).toBe("PROFILE-EXISTS");
        const profile = lines[0] as string;
        expect(profile).toMatch(/^-env:UserInstallation=file:\/\/.*\/libreoffice-agents\/p-/);
        expect(profile).toContain("data%20dir");
        profiles.push(profile);
        expect(lines.slice(1, 1 + LO_QUIET.length)).toEqual([...LO_QUIET]);
        expect(lines.slice(1 + LO_QUIET.length, -2)).toEqual(args);
      }
      expect(profiles[0]).not.toBe(profiles[1]);
      // Each command's profile is gone after it.
      expect(await readdir(join(data, "tools", "libreoffice-agents"))).toEqual([]);
      // A profile the command chose itself is kept, and none is made.
      const own = await run(join(bin as string, "soffice"), [
        "-env:UserInstallation=file:///tmp/mine",
        "x",
      ]);
      expect(own.stdout.split("\n").filter((l) => l.startsWith("-env:"))).toEqual([
        "-env:UserInstallation=file:///tmp/mine",
      ]);
    },
  );

  it("on Windows: Git's bash script and the .cmd for PowerShell, paths with spaces quoted", () => {
    const files = officeLaunchers(
      "C:\\Program Files\\LibreOffice\\program\\soffice.com",
      "C:\\Users\\Ana Rossi\\AppData\\Local\\RedGiant 100%\\tools\\libreoffice-agents",
      "win32",
    );
    expect(files.map((f) => f.name)).toEqual([
      "soffice",
      "libreoffice",
      "soffice.cmd",
      "libreoffice.cmd",
    ]);
    const sh = files[0]?.content ?? "";
    expect(sh).toContain("real='C:/Program Files/LibreOffice/program/soffice.com'");
    expect(sh).toContain(
      "url='file:///C:/Users/Ana%20Rossi/AppData/Local/RedGiant%20100%25/tools/libreoffice-agents'",
    );
    const cmd = files[2]?.content ?? "";
    expect(cmd.split("\r\n")).toContain(
      `"C:\\Program Files\\LibreOffice\\program\\soffice.com" "-env:UserInstallation=%RG_URL%/%RG_NAME%" ${LO_QUIET.join(" ")} %*`,
    );
    // Percent signs of the paths are doubled (a .cmd would expand them), the URL's too.
    expect(cmd).toContain(
      'set "RG_BASE=C:\\Users\\Ana Rossi\\AppData\\Local\\RedGiant 100%%\\tools\\libreoffice-agents"',
    );
    expect(cmd).toContain("RedGiant%%20100%%25");
    // Never anything of the server's environment.
    expect(cmd).not.toMatch(/TOKEN|KEY|SECRET/i);
    expect(sh).not.toMatch(/TOKEN|KEY|SECRET/i);
  });

  it("are not made for a soffice the agents cannot reach", () => {
    // Only the server shares its programs (share: true); tests and tools never write launchers.
    const p = new Programs({
      jobs: new Jobs(),
      dataDir: join(tmpdir(), "rg-no-launchers"),
      find: () => "/usr/bin/soffice",
    });
    p.find("libreoffice");
    expect(existsSync(join(tmpdir(), "rg-no-launchers", "tools", "agent-bin"))).toBe(false);
  });
});

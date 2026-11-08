// Homebrew and winget (G36.10): the files made from a release's installers.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript, no types
import { homebrewCask, INNO_PRODUCT_CODE, wingetManifests } from "../stores.mjs";

// The yaml parser the server already has (this folder has no dependencies of its own).
const YAML = createRequire(new URL("../../../packages/server/package.json", import.meta.url))(
  "yaml",
) as { parse: (s: string) => Record<string, unknown> };
const sha = "ab".repeat(32);

describe("stores.mjs", () => {
  it("writes the cask with the release's disk image and the command line", () => {
    const cask: string = homebrewCask({ version: "3.4.0", sha256: sha.toUpperCase() });
    expect(cask).toContain('version "3.4.0"');
    expect(cask).toContain(`sha256 "${sha}"`);
    expect(cask).toContain(
      'url "https://github.com/Frostmoore/redgiant2/releases/download/v#{version}/RedGiant-mac-arm64.dmg"',
    );
    expect(cask).toContain('binary "#{appdir}/RedGiant.app/Contents/Resources/bin/redgiant"');
    // The bundle id is the app's own (Info.plist).
    const plist = readFileSync(new URL("../../mac/Info.plist", import.meta.url), "utf8");
    const id = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
    expect(cask).toContain(`uninstall quit: "${id}"`);
    // Before 3.4.0 the app had no command line inside: no link to a file that is not there.
    expect(homebrewCask({ version: "3.3.2", sha256: sha })).not.toContain("binary");
    expect(homebrewCask({ version: "3.10.0", sha256: sha })).toContain("binary");
    expect(homebrewCask({ version: "4.0.0", sha256: sha })).toContain("binary");
    expect(() => homebrewCask({ version: "3.4", sha256: sha })).toThrow(/version/);
    expect(() => homebrewCask({ version: "3.4.0", sha256: "x" })).toThrow(/sha256/);
  });

  it("writes winget's three files, valid YAML, for Inno Setup per user", () => {
    const files: Record<string, string> = wingetManifests({
      version: "3.4.0",
      sha256: sha,
      date: "2026-11-08",
    });
    const dir = "manifests/f/Frostmoore/RedGiant/3.4.0";
    expect(Object.keys(files).sort()).toEqual([
      `${dir}/Frostmoore.RedGiant.installer.yaml`,
      `${dir}/Frostmoore.RedGiant.locale.en-US.yaml`,
      `${dir}/Frostmoore.RedGiant.yaml`,
    ]);
    const doc = (name: string) => YAML.parse(files[`${dir}/${name}`] as string);
    expect(doc("Frostmoore.RedGiant.yaml")).toEqual({
      PackageIdentifier: "Frostmoore.RedGiant",
      PackageVersion: "3.4.0",
      DefaultLocale: "en-US",
      ManifestType: "version",
      ManifestVersion: "1.12.0",
    });
    const inst = doc("Frostmoore.RedGiant.installer.yaml");
    expect(inst).toMatchObject({
      InstallerType: "inno",
      Scope: "user",
      UpgradeBehavior: "install",
      ProductCode: INNO_PRODUCT_CODE,
      ReleaseDate: "2026-11-08",
      ManifestType: "installer",
      Installers: [
        {
          Architecture: "x64",
          InstallerUrl:
            "https://github.com/Frostmoore/redgiant2/releases/download/v3.4.0/RedGiant-Setup.exe",
          InstallerSha256: sha.toUpperCase(),
        },
      ],
    });
    // The product code is RedGiant.iss's AppId, as Windows lists it.
    const iss = readFileSync(new URL("../../windows/RedGiant.iss", import.meta.url), "utf8");
    const appId = /^AppId=\{(\{[0-9A-F-]+\})$/m.exec(iss)?.[1];
    expect(INNO_PRODUCT_CODE).toBe(`${appId}_is1`);
    expect(iss).toMatch(/^PrivilegesRequired=lowest$/m);
    const locale = doc("Frostmoore.RedGiant.locale.en-US.yaml");
    expect(locale).toMatchObject({ PackageName: "RedGiant", License: "MIT", Moniker: "redgiant" });
    expect(String(locale.ShortDescription).length).toBeLessThanOrEqual(256);
  });

  it("runs as a command on the installers' files", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-stores-"));
    try {
      writeFileSync(join(dir, "a.dmg"), "dmg");
      writeFileSync(join(dir, "s.exe"), "exe");
      const script = fileURLToPath(new URL("../stores.mjs", import.meta.url));
      execFileSync(process.execPath, [
        script,
        "--version",
        "v3.4.0",
        "--dmg",
        join(dir, "a.dmg"),
        "--setup",
        join(dir, "s.exe"),
        "--out",
        join(dir, "out"),
      ]);
      const cask = readFileSync(join(dir, "out", "homebrew", "Casks", "redgiant.rb"), "utf8");
      expect(cask).toContain(`sha256 "${createHash("sha256").update("dmg").digest("hex")}"`);
      const inst = readFileSync(
        join(
          dir,
          "out",
          "winget",
          "manifests/f/Frostmoore/RedGiant/3.4.0/Frostmoore.RedGiant.installer.yaml",
        ),
        "utf8",
      );
      expect(inst).toContain("PackageVersion: 3.4.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

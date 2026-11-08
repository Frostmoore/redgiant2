#!/usr/bin/env node
// Homebrew and winget (G36.10): the files that put a RedGiant release in the two stores, made from
// the release's own installers (their sha256), never written by hand.
//
//   node packaging/stores/stores.mjs --version 3.4.0 --dmg RedGiant-mac-arm64.dmg \
//     --setup RedGiant-Setup.exe --out <dir> [--repo Frostmoore/redgiant2] [--date 2026-11-08]
//   (or --dmg-sha256 / --setup-sha256 with the digests GitHub lists for the release's assets)
//     → <dir>/homebrew/Casks/redgiant.rb (for the tap Frostmoore/homebrew-redgiant)
//     → <dir>/winget/manifests/f/Frostmoore/RedGiant/<version>/*.yaml (for microsoft/winget-pkgs)
//
// Only Node's own modules: it runs in the release job on the files it just downloaded.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

export const DEFAULT_REPO = "Frostmoore/redgiant2";
export const WINGET_ID = "Frostmoore.RedGiant";
/** The schema winget-pkgs' own tools write (Tools/YamlCreate.ps1), checked 2026-11-08. */
export const WINGET_MANIFEST_VERSION = "1.12.0";
/** RedGiant.iss's AppId: Windows lists the installed app under it (with Inno Setup's "_is1"). */
export const INNO_PRODUCT_CODE = "{6F0E3B52-8D4A-4C1E-9B7A-2E1D5C9F4A10}_is1";

const SHA = /^[0-9a-f]{64}$/i;
/** The first version whose app carries the `redgiant` command line (G36.15). */
const CLI_SINCE = [3, 4, 0];
const CLI_LINK = '  binary "#{appdir}/RedGiant.app/Contents/Resources/bin/redgiant"\n';
const atLeast = (version, min) => {
  const v = version.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return (v[i] ?? 0) > (min[i] ?? 0);
  return true;
};
const VERSION = /^\d+\.\d+\.\d+$/;

function check(version, sha256, what) {
  if (!VERSION.test(version)) throw new Error(`not a release version: ${version}`);
  if (!SHA.test(sha256)) throw new Error(`not a sha256 for the ${what}: ${sha256}`);
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The cask for the tap (brew install --cask frostmoore/redgiant/redgiant). The app updates itself
 * only through the person (G36.19), so no `auto_updates`: `brew upgrade` brings new versions. The
 * command line inside the app (G36.15) is linked as `redgiant`. `zap` (only with --zap) removes
 * the data too; a plain uninstall keeps them, as the app's own "Uninstall" asks.
 */
export function homebrewCask({ version, sha256, repo = DEFAULT_REPO }) {
  check(version, sha256, "disk image");
  return `cask "redgiant" do
  version "${version}"
  sha256 "${sha256.toLowerCase()}"

  url "https://github.com/${repo}/releases/download/v#{version}/RedGiant-mac-arm64.dmg"
  name "RedGiant"
  desc "Self-hosted agent harness for coding, daily assistance and automations"
  homepage "https://github.com/${repo}"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: ">= :ventura"

  app "RedGiant.app"
${atLeast(version, CLI_SINCE) ? CLI_LINK : ""}
  uninstall quit: "com.redgiant.app"

  zap trash: [
    "~/Library/Application Support/RedGiant",
    "~/Library/Logs/RedGiant",
  ]
end
`;
}

const yaml = (type, lines) =>
  [
    `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.${WINGET_MANIFEST_VERSION}.schema.json`,
    "",
    ...lines,
    `ManifestType: ${type}`,
    `ManifestVersion: ${WINGET_MANIFEST_VERSION}`,
    "",
  ].join("\n");

/**
 * The three files of a winget multi-file manifest. Inno Setup's installer: winget runs it with
 * /VERYSILENT /SUPPRESSMSGBOXES /NORESTART by itself (InstallerType inno); per user, no
 * administrator (PrivilegesRequired=lowest). No /TASKS: a first installation gets the setup's own
 * defaults and an upgrade keeps the tasks chosen before (the `redgiant` command in PATH stays a
 * choice made in the interactive setup).
 */
export function wingetManifests({ version, sha256, repo = DEFAULT_REPO, date }) {
  check(version, sha256, "installer");
  const dir = `manifests/f/Frostmoore/RedGiant/${version}`;
  const head = [`PackageIdentifier: ${WINGET_ID}`, `PackageVersion: ${version}`];
  const release = `https://github.com/${repo}/releases/tag/v${version}`;
  return {
    [`${dir}/${WINGET_ID}.yaml`]: yaml("version", [...head, "DefaultLocale: en-US"]),
    [`${dir}/${WINGET_ID}.installer.yaml`]: yaml("installer", [
      ...head,
      "InstallerType: inno",
      "Scope: user",
      "InstallModes:",
      "- interactive",
      "- silent",
      "- silentWithProgress",
      "UpgradeBehavior: install",
      "MinimumOSVersion: 10.0.17763.0",
      ...(date ? [`ReleaseDate: ${date}`] : []),
      `ProductCode: '${INNO_PRODUCT_CODE}'`,
      "AppsAndFeaturesEntries:",
      "- DisplayName: RedGiant",
      "  Publisher: RedGiant",
      `  ProductCode: '${INNO_PRODUCT_CODE}'`,
      "Installers:",
      "- Architecture: x64",
      `  InstallerUrl: https://github.com/${repo}/releases/download/v${version}/RedGiant-Setup.exe`,
      `  InstallerSha256: ${sha256.toUpperCase()}`,
    ]),
    [`${dir}/${WINGET_ID}.locale.en-US.yaml`]: yaml("defaultLocale", [
      ...head,
      "PackageLocale: en-US",
      "Publisher: RedGiant",
      `PublisherUrl: https://github.com/${repo.split("/")[0]}`,
      `PublisherSupportUrl: https://github.com/${repo}/issues`,
      "PackageName: RedGiant",
      `PackageUrl: https://github.com/${repo}`,
      "License: MIT",
      `LicenseUrl: https://github.com/${repo}/blob/main/LICENSE`,
      "ShortDescription: Self-hosted agent harness for coding, daily assistance and automations.",
      "Description: |-",
      "  RedGiant runs a team of AI agents on your own computer: projects with their orchestrators,",
      "  personal assistants, automations and chats, with cloud models, subscriptions or a local",
      "  engine. Everything runs on Windows itself, with its own database: no WSL, no Docker.",
      "Moniker: redgiant",
      "Tags:",
      "- agents",
      "- ai",
      "- automation",
      "- coding",
      "- llm",
      "- self-hosted",
      `ReleaseNotesUrl: ${release}`,
    ]),
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      dmg: { type: "string" },
      setup: { type: "string" },
      "dmg-sha256": { type: "string" },
      "setup-sha256": { type: "string" },
      out: { type: "string" },
      repo: { type: "string" },
      date: { type: "string" },
    },
  });
  const version = values.version?.replace(/^v/, "");
  const dmgSha = values["dmg-sha256"] ?? (values.dmg && sha256File(values.dmg));
  const setupSha = values["setup-sha256"] ?? (values.setup && sha256File(values.setup));
  if (!version || !values.out || (!dmgSha && !setupSha)) {
    console.error(
      "usage: stores.mjs --version X.Y.Z --out <dir> [--dmg <file> | --dmg-sha256 <hex>] [--setup <file> | --setup-sha256 <hex>] [--repo o/r] [--date YYYY-MM-DD]",
    );
    process.exit(2);
  }
  const repo = values.repo ?? DEFAULT_REPO;
  const write = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    console.log(path);
  };
  if (dmgSha) {
    const cask = homebrewCask({ version, sha256: dmgSha, repo });
    write(join(values.out, "homebrew", "Casks", "redgiant.rb"), cask);
  }
  if (setupSha) {
    const files = wingetManifests({ version, sha256: setupSha, repo, date: values.date });
    for (const [path, text] of Object.entries(files)) write(join(values.out, "winget", path), text);
  }
}

if (process.argv[1]?.endsWith("stores.mjs")) main();

// The agents' own `soffice` and `libreoffice` (p3.5.3). An agent that runs LibreOffice with bash
// (God made ODS, DOCX and PPTX that way in the person's test of 3.5.1) used the person's own
// profile: with another LibreOffice open, Windows showed «another instance is running» and the
// command waited for the person's OK. These small launchers go first on the PATH of the agents'
// commands and call the real program with a profile made for that one command, removed after,
// and the options that keep it without windows. Arguments pass through untouched; nothing of the
// server's environment is added (no secret ever reaches a command).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LO_QUIET } from "./lo-profiles.js";

export interface LauncherFile {
  name: string;
  content: string;
  /** Unix scripts are made executable. */
  executable: boolean;
}

/** A POSIX shell single-quoted literal. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Inside a .cmd file's double quotes: percent signs doubled (nothing else expands there). */
const cmdText = (s: string) => s.replace(/%/g, "%%");
/** Forward slashes: what Git's bash takes on Windows (and the same on Unix). */
const slashed = (p: string) => p.replace(/\\/g, "/");

/**
 * The launchers for one real soffice: `soffice` and `libreoffice` as POSIX scripts (Linux, macOS,
 * and Git's bash on Windows), plus `soffice.cmd` and `libreoffice.cmd` on Windows (PowerShell,
 * cmd). `profiles` is where each command's own profile is made and removed.
 */
export function officeLaunchers(
  real: string,
  profiles: string,
  platform: string = process.platform,
): LauncherFile[] {
  const win = platform === "win32";
  // The file URL of the profiles' folder (spaces and the like encoded), and each command's
  // folder name made of letters and digits only, so the URL stays valid as it is.
  const url = (win ? pathToFileURL(profiles, { windows: true }) : pathToFileURL(profiles)).href;
  const quiet = LO_QUIET.join(" ");
  const sh = [
    "#!/bin/sh",
    "# Made by RedGiant (p3.5.3): LibreOffice for the agents' commands, with a profile of its",
    "# own for this command (never the person's, never another command's) and no windows.",
    `real=${shQuote(win ? slashed(real) : real)}`,
    `base=${shQuote(win ? slashed(profiles) : profiles)}`,
    `url=${shQuote(url)}`,
    "# A profile chosen by the command itself is kept.",
    'for a in "$@"; do',
    `  case "$a" in -env:UserInstallation=*) exec "$real" ${quiet} "$@" ;; esac`,
    "done",
    'mkdir -p "$base" || exit 1',
    'dir=$(mktemp -d "$base/p-XXXXXXXX") || exit 1',
    `trap 'rm -rf "$dir"' EXIT`,
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    `"$real" "-env:UserInstallation=$url/\${dir##*/}" ${quiet} "$@"`,
    "status=$?",
    'exit "$status"',
    "",
  ].join("\n");
  const files: LauncherFile[] = [
    { name: "soffice", content: sh, executable: true },
    { name: "libreoffice", content: sh, executable: true },
  ];
  if (win) {
    const cmd = [
      "@echo off",
      "rem Made by RedGiant (p3.5.3): LibreOffice for the agents' commands, with a profile of its",
      "rem own for this command (never the person's, never another command's) and no windows.",
      "setlocal EnableExtensions DisableDelayedExpansion",
      `set "RG_BASE=${cmdText(profiles)}"`,
      `set "RG_URL=${cmdText(url)}"`,
      'if not exist "%RG_BASE%" mkdir "%RG_BASE%" 2>nul',
      "set /a RG_TRY=0",
      ":pick",
      "set /a RG_TRY+=1",
      "if %RG_TRY% gtr 50 exit /b 1",
      'set "RG_NAME=p%RANDOM%%RANDOM%%RANDOM%"',
      'mkdir "%RG_BASE%\\%RG_NAME%" 2>nul || goto pick',
      `"${cmdText(real)}" "-env:UserInstallation=%RG_URL%/%RG_NAME%" ${quiet} %*`,
      'set "RG_EXIT=%ERRORLEVEL%"',
      'rmdir /s /q "%RG_BASE%\\%RG_NAME%" 2>nul',
      "exit /b %RG_EXIT%",
      "",
    ].join("\r\n");
    files.push(
      { name: "soffice.cmd", content: cmd, executable: false },
      { name: "libreoffice.cmd", content: cmd, executable: false },
    );
  }
  return files;
}

/** The folder of the agents' launchers in the data folder. */
export const agentBinDir = (dataDir: string) => join(dataDir, "tools", "agent-bin");

/**
 * Writes the launchers for this soffice (only what changed) and returns their folder, to go
 * first on the agents' PATH. A folder that cannot be written leaves the agents without them.
 */
export function installOfficeLaunchers(
  dataDir: string,
  real: string,
  platform: string = process.platform,
): string | undefined {
  const dir = agentBinDir(dataDir);
  try {
    mkdirSync(dir, { recursive: true });
    for (const f of officeLaunchers(real, join(dataDir, "tools", "libreoffice-agents"), platform)) {
      const path = join(dir, f.name);
      const have = existsSync(path) ? readFileSync(path, "utf8") : undefined;
      if (have !== f.content) writeFileSync(path, f.content);
      if (f.executable) chmodSync(path, 0o755);
    }
    return dir;
  } catch {
    return undefined;
  }
}

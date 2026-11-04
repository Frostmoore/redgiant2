// The programs behind the subscriptions (2026-11-05): OpenAI's Codex and Anthropic's Claude Code.
// Their native builds weigh hundreds of MB each, so RedGiant no longer carries them: when a
// subscription is switched on it first looks for one already here (carried by this install, one
// downloaded before, or the person's own on the PATH), and only then downloads the build for this
// system from npm, the same files `npm install` would fetch. It also says whether the person is
// already signed in with their own copy, so that login can be used as it is.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readdirSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type ToolName = "codex" | "claude";

export interface ToolLocation {
  /** The program to run, and the arguments before RedGiant's own (Node and a script, or none). */
  file: string;
  args: string[];
  /** Folders the program wants first on its PATH (Codex's ripgrep). */
  path?: string[];
  source: "bundled" | "downloaded" | "system";
}

const require = createRequire(import.meta.url);
const exe = process.platform === "win32" ? ".exe" : "";

/** Codex's name for this system (the folder inside its package). */
function codexTriple(): string | undefined {
  const t: Record<string, string> = {
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
  };
  return t[`${process.platform}-${process.arch}`];
}

/** npm's registry, or a mirror (and a fake one in tests). */
const registry = () =>
  (process.env.REDGIANT_NPM_REGISTRY ?? "https://registry.npmjs.org").replace(/\/+$/, "");

/** The npm package of this system's build, and its version (the one the SDK asks for). */
export function nativePackage(name: ToolName): { name: string; version: string; tarball: string } {
  if (name === "codex") {
    const pkg = require("@openai/codex/package.json") as {
      optionalDependencies?: Record<string, string>;
    };
    const spec = pkg.optionalDependencies?.[`@openai/codex-${process.platform}-${process.arch}`];
    // "npm:@openai/codex@0.166.0-win32-x64"
    const version = spec?.split("@").at(-1);
    if (!version) throw new Error(`Codex has no build for ${process.platform}-${process.arch}`);
    return {
      name: "@openai/codex",
      version,
      tarball: `${registry()}/@openai/codex/-/codex-${version}.tgz`,
    };
  }
  const sdk = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
  const pkg = sdk("./package.json") as { optionalDependencies?: Record<string, string> };
  const id = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const version = pkg.optionalDependencies?.[`@anthropic-ai/${id}`];
  if (!version) throw new Error(`Claude Code has no build for ${process.platform}-${process.arch}`);
  return {
    name: `@anthropic-ai/${id}`,
    version,
    tarball: `${registry()}/@anthropic-ai/${id}/-/${id}-${version}.tgz`,
  };
}

/** Where a downloaded build is kept: `<tools>/<name>/<version>/package`. */
function downloadedRoot(name: ToolName, toolsDir: string): string {
  return join(toolsDir, name, nativePackage(name).version, "package");
}

function codexIn(root: string): ToolLocation | undefined {
  const triple = codexTriple();
  if (!triple) return undefined;
  const file = join(root, "vendor", triple, "bin", `codex${exe}`);
  return existsSync(file)
    ? { file, args: [], path: [join(root, "vendor", triple, "codex-path")], source: "downloaded" }
    : undefined;
}

/** A program on the PATH (the person's own Codex or Claude Code). */
function onPath(names: string[]): string | undefined {
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const n of names) if (existsSync(join(dir, n))) return join(dir, n);
  }
  return undefined;
}

/** The program to run, without downloading anything; undefined when there is none. */
export function locateTool(name: ToolName, toolsDir: string): ToolLocation | undefined {
  if (name === "codex") {
    // Carried by this install (Docker image, development).
    try {
      const pkg = require.resolve(
        `@openai/codex-${process.platform}-${process.arch}/package.json`,
        {
          paths: [dirname(require.resolve("@openai/codex/package.json"))],
        },
      );
      const found = codexIn(dirname(pkg));
      if (found) return { ...found, source: "bundled" };
    } catch {}
    const got = codexIn(downloadedRoot(name, toolsDir));
    if (got) return got;
    // The person's own: an npm install's script (a .cmd on Windows cannot be started directly).
    const own = onPath(process.platform === "win32" ? ["codex.cmd", "codex.exe"] : ["codex"]);
    if (own?.endsWith(".exe")) return { file: own, args: [], source: "system" };
    if (own) {
      const script = join(dirname(own), "node_modules", "@openai", "codex", "bin", "codex.js");
      if (process.platform === "win32" && existsSync(script))
        return { file: process.execPath, args: [script], source: "system" };
      if (process.platform !== "win32") return { file: own, args: [], source: "system" };
    }
    return undefined;
  }
  const id = `claude-agent-sdk-${process.platform}-${process.arch}`;
  try {
    const sdk = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
    for (const n of [id, `${id}-musl`])
      try {
        return {
          file: sdk.resolve(`@anthropic-ai/${n}/claude${exe}`),
          args: [],
          source: "bundled",
        };
      } catch {}
  } catch {}
  const got = join(downloadedRoot(name, toolsDir), `claude${exe}`);
  if (existsSync(got)) return { file: got, args: [], source: "downloaded" };
  // The person's own Claude Code: the native installer's, or npm's.
  const own =
    onPath(process.platform === "win32" ? ["claude.exe"] : ["claude"]) ??
    [join(homedir(), ".local", "bin", `claude${exe}`)].find((p) => existsSync(p));
  return own ? { file: own, args: [], source: "system" } : undefined;
}

/**
 * Downloads this system's build from npm into the tools folder, reporting the bytes as they come.
 * Unpacked with the system's `tar` (Windows 10 and later have it), then moved into place whole.
 */
export async function downloadTool(
  name: ToolName,
  toolsDir: string,
  progress: (done: number, total: number | null) => void = () => {},
  signal?: AbortSignal,
): Promise<ToolLocation> {
  const pkg = nativePackage(name);
  const dir = join(toolsDir, name, pkg.version);
  const tmp = `${dir}.part`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const r = await fetch(pkg.tarball, signal ? { signal } : {});
  if (!r.ok || !r.body) throw new Error(`npm answered ${r.status} for ${pkg.name}@${pkg.version}`);
  const total = Number(r.headers.get("content-length")) || null;
  let done = 0;
  const body = Readable.fromWeb(r.body as never);
  body.on("data", (b: Buffer) => {
    done += b.length;
    progress(done, total);
  });
  const file = join(tmp, "package.tgz");
  await pipeline(body, createWriteStream(file));
  await new Promise<void>((ok, ko) => {
    const t = spawn("tar", ["-xzf", "package.tgz"], {
      cwd: tmp,
      stdio: "ignore",
      windowsHide: true,
    });
    t.once("error", ko);
    t.once("exit", (code) => (code === 0 ? ok() : ko(new Error(`tar exited with ${code}`))));
  });
  await rm(file, { force: true });
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
  const found = locateTool(name, toolsDir);
  if (!found || (found.source !== "downloaded" && found.source !== "bundled"))
    throw new Error(`${pkg.name} was downloaded but its program is not where expected`);
  return found;
}

/** Older downloaded versions, removed once a newer one is in place. */
export async function pruneTools(name: ToolName, toolsDir: string): Promise<void> {
  const keep = nativePackage(name).version;
  const root = join(toolsDir, name);
  if (!existsSync(root)) return;
  for (const v of readdirSync(root))
    if (v !== keep) await rm(join(root, v), { recursive: true, force: true });
}

/**
 * The person's own sign-in, made outside RedGiant with their own Codex or Claude Code: its
 * folder, when there is one. RedGiant uses it as it is instead of asking to sign in again.
 */
export function existingLogin(name: ToolName): string | undefined {
  if (name === "codex") {
    const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    return existsSync(join(home, "auth.json")) ? home : undefined;
  }
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return existsSync(join(dir, ".credentials.json")) ? dir : undefined;
}

/** What a program needs to start at all on Windows (2026-11-05: RedGiant runs there natively). */
export function windowsBasics(): Record<string, string> {
  if (process.platform !== "win32") return {};
  const out: Record<string, string> = {};
  for (const k of [
    "SystemRoot",
    "windir",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "SystemDrive",
    "ProgramData",
    "LOCALAPPDATA",
    "APPDATA",
  ])
    if (process.env[k]) out[k] = process.env[k] as string;
  return out;
}

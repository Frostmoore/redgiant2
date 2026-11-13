// Mandatory and breaking updates (G36.19). At start and every few hours the server reads the
// latest release from GitHub and its signed `release.json`: what kind it is ("normal",
// "mandatory", "breaking") counts only with a valid signature of the update key
// (`release-key.ts`, the same key as the Windows launcher's). A mandatory update holds the
// agents' work (RedGiantCore refuses new turns, automations are skipped with a reason) until the
// person updates or closes RedGiant; a breaking one asks for a clean install and is never applied
// over the old version. The page reads `status()`; the Mac app reads `update-required.json` in
// the data folder (it has no way of its own to check a signature).
import { verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assessRelease,
  type InstallKind,
  ReleaseInfo,
  type ReleaseNote,
  type UpdateStatus,
} from "@redgiant/protocol";
import { debugLog } from "./debug-log.js";
import { RELEASE_PUBLIC_KEY } from "./release-key.js";

export const LATEST_RELEASE = "https://api.github.com/repos/Frostmoore/redgiant2/releases/latest";
const DOWNLOADS = "https://github.com/Frostmoore/redgiant2/releases/latest/download";
export const RELEASE_INFO_ASSET = "release.json";
/** Looked at again this often while RedGiant runs (and at every start). */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * `release.json` as signed: null unless `signature` (base64, RSA SHA-256 PKCS #1 v1.5) is the
 * key's signature of exactly these bytes and the content is a valid ReleaseInfo. With no key
 * nothing is trusted.
 */
export function verifyReleaseInfo(
  bytes: Buffer,
  signature: string,
  publicPem: string = RELEASE_PUBLIC_KEY,
): ReleaseInfo | null {
  if (!publicPem.trim()) return null;
  try {
    if (!verify("sha256", bytes, publicPem, Buffer.from(signature.trim(), "base64"))) return null;
    const parsed = ReleaseInfo.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** How this RedGiant is installed: Windows' launcher, the Mac app, Docker or the source. */
export function installKind(env: NodeJS.ProcessEnv = process.env): InstallKind {
  if (env.REDGIANT_INSTALL === "windows" || env.REDGIANT_INSTALL === "mac")
    return env.REDGIANT_INSTALL;
  if (env.REDGIANT_INSTALL === "docker" || env.REDGIANT_INSTALL === "source")
    return env.REDGIANT_INSTALL;
  // RedGiant OS (G39.1): its compose.os.yaml says so; updates go through its signed updater.
  if (env.REDGIANT_INSTALL === "os" || env.REDGIANT_OS === "1") return "os";
  if (process.platform === "win32" && env.REDGIANT_WIN_ENGINE_DIR) return "windows";
  if (process.platform === "darwin" && env.REDGIANT_STOP_ON_STDIN_END === "1") return "mac";
  if (existsSync("/.dockerenv") || existsSync("/opt/redgiant/.image-version")) return "docker";
  return "source";
}

/** The version installed here: the launcher's or the app's, or the image's; null from the source. */
export function installedVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.REDGIANT_VERSION?.trim();
  if (v && /^\d+\.\d+\.\d+$/.test(v)) return v;
  try {
    const image = readFileSync(
      env.REDGIANT_IMAGE_VERSION_FILE ?? "/opt/redgiant/.image-version",
      "utf8",
    )
      .trim()
      .replace(/^v/, "");
    return /^\d+\.\d+\.\d+$/.test(image) ? image : null;
  } catch {
    return null;
  }
}

/** Where a breaking update's backup goes, a folder the person sees: Documents, or the data volume. */
export function safetyBackupBase(
  install: InstallKind,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.REDGIANT_DOCUMENTS_DIR) return env.REDGIANT_DOCUMENTS_DIR;
  if (install === "windows" || install === "mac") return join(homedir(), "Documents");
  return join(dataDir, "RedGiant-backups");
}

export interface UpdateWatcherOptions {
  install: InstallKind;
  installed: string | null;
  dataDir: string;
  backupBase: string;
  /** For tests and the CI: the API's answer for the latest release (default GitHub's). */
  feed?: string;
  fetch?: typeof fetch;
  publicKey?: string;
  now?: () => Date;
  everyMs?: number;
  /** Windows: RedGiant.exe updates in place and can run the uninstaller. */
  launcher?: boolean;
  /** RedGiant OS: the OS helper can run the signed updater (redgiant-os-update). */
  osUpdater?: boolean;
  /** Docker: where the compose file is, for the command shown. */
  composeDir?: string;
  arch?: string;
  /** Called whenever the gate changes (the core holds work on "mandatory"). */
  onChange?: (status: UpdateStatus) => void;
  /**
   * Asks the launcher or the app (Windows: update now, quit, run the uninstaller; Mac: quit).
   * False when this installation cannot.
   */
  act?: (action: UpdateAction) => Promise<boolean>;
}

export type UpdateAction = "update" | "quit" | "uninstall";

interface Asset {
  name?: string;
  browser_download_url?: string;
}

export class UpdateWatcher {
  private last: UpdateStatus;
  private timer: ReturnType<typeof setInterval> | undefined;
  private first: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<UpdateStatus> | undefined;

  constructor(private readonly o: UpdateWatcherOptions) {
    this.last = this.base();
  }

  private base(): UpdateStatus {
    const o = this.o;
    return {
      install: o.install,
      installed: o.installed,
      latest: null,
      checkedAt: null,
      state: "unknown",
      gate: "none",
      signed: false,
      note: null,
      downloadUrl:
        o.install === "windows"
          ? `${DOWNLOADS}/RedGiant-Setup.exe`
          : o.install === "mac"
            ? `${DOWNLOADS}/RedGiant-mac-${(o.arch ?? process.arch) === "x64" ? "x86_64" : "arm64"}.dmg`
            : null,
      command:
        o.install === "docker"
          ? `cd ${o.composeDir ?? "~/redgiant"} && docker compose pull && docker compose up -d`
          : null,
      backupDir: o.backupBase,
      canUpdateHere:
        (o.install === "windows" && o.launcher === true) ||
        (o.install === "os" && o.osUpdater === true),
      canUninstall: o.install === "windows" && o.launcher === true,
    };
  }

  status(): UpdateStatus {
    return this.last;
  }

  /** True while a mandatory update holds the agents' work. */
  get held(): boolean {
    return this.last.gate === "mandatory";
  }

  /** What the window's buttons ask; a breaking update is never applied in place. */
  async act(action: UpdateAction): Promise<boolean> {
    if (action === "update" && this.last.gate === "breaking") return false;
    if (!this.o.act) return false;
    debugLog.write("update", `the person chose: ${action}`);
    return this.o.act(action);
  }

  /** At start (after a few seconds) and every `everyMs`. */
  start(): void {
    // Left by the previous run (maybe the previous version): only a look of this run says it.
    void rm(join(this.o.dataDir, "update-required.json"), { force: true }).catch(() => {});
    if (this.timer || !this.o.installed) return;
    this.first = setTimeout(() => void this.check(), 5000);
    this.first.unref?.();
    this.timer = setInterval(() => void this.check(), this.o.everyMs ?? CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Looks now; one look at a time. Never throws: an unreachable GitHub keeps the last gate. */
  check(): Promise<UpdateStatus> {
    this.running ??= this.look().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async look(): Promise<UpdateStatus> {
    const o = this.o;
    const f = o.fetch ?? fetch;
    const now = (o.now ?? (() => new Date()))().toISOString();
    if (!o.installed) {
      this.set({ ...this.base(), checkedAt: now });
      return this.last;
    }
    const get = (url: string) =>
      f(url, {
        headers: { "user-agent": "RedGiant", accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(15_000),
      });
    try {
      const r = await get(o.feed ?? LATEST_RELEASE);
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
      const rel = (await r.json()) as { tag_name?: string; assets?: Asset[] };
      const latest = rel.tag_name?.replace(/^v/, "");
      if (!latest || !/^\d+\.\d+\.\d+$/.test(latest)) throw new Error("no version in the release");
      const url = (name: string) => rel.assets?.find((a) => a.name === name)?.browser_download_url;
      let info: ReleaseInfo | null = null;
      const infoUrl = url(RELEASE_INFO_ASSET);
      const sigUrl = url(`${RELEASE_INFO_ASSET}.sig`);
      if (infoUrl && sigUrl) {
        const [a, b] = await Promise.all([get(infoUrl), get(sigUrl)]);
        if (a.ok && b.ok) {
          const bytes = Buffer.from(await a.arrayBuffer());
          info = verifyReleaseInfo(bytes, await b.text(), o.publicKey);
          if (!info)
            debugLog.write("update", "release.json of the latest release is not validly signed");
        }
      }
      // The signed file must be this release's own (an old one copied over says nothing).
      if (info && info.version !== latest) info = null;
      const gate = assessRelease(info, o.installed, latest);
      this.set({
        ...this.base(),
        latest,
        checkedAt: now,
        state: gate === "none" ? "latest" : "available",
        gate,
        signed: info !== null,
        note: gate === "mandatory" || gate === "breaking" ? noteFor(info, gate) : null,
      });
    } catch (err) {
      debugLog.write("update", `could not look for updates: ${(err as Error).message}`);
      // What was known stays (a mandatory update is not lifted by a network failure).
      this.set({
        ...this.last,
        checkedAt: now,
        state: this.last.latest ? this.last.state : "unreachable",
      });
    }
    await this.writing;
    return this.last;
  }

  /** The file for the Mac app being written. */
  private writing: Promise<void> = Promise.resolve();

  private set(next: UpdateStatus): void {
    const before = this.last;
    this.last = next;
    if (before.gate !== next.gate || before.latest !== next.latest) {
      debugLog.write("update", `latest ${next.latest ?? "?"}: ${next.gate}`);
      // check() waits for it: whoever reads the file right after a check finds it (a slow disk on
      // Windows made the test read it before it was written).
      this.writing = this.writeForApp(next);
      this.o.onChange?.(next);
    }
  }

  /** The Mac app (and anyone reading the data folder) learns of a mandatory or breaking update. */
  private async writeForApp(s: UpdateStatus): Promise<void> {
    const file = join(this.o.dataDir, "update-required.json");
    try {
      if (s.gate === "mandatory" || s.gate === "breaking")
        await writeFile(
          file,
          `${JSON.stringify({ gate: s.gate, version: s.latest, installed: s.installed, note: s.note, downloadUrl: s.downloadUrl })}\n`,
        );
      else await rm(file, { force: true });
    } catch {
      // The page still says it.
    }
  }
}

/** The release's own reason when it is about this gate; otherwise the carried rule speaks for itself. */
function noteFor(info: ReleaseInfo | null, gate: "mandatory" | "breaking"): ReleaseNote | null {
  return info?.note && info.kind === gate ? info.note : null;
}

/** The error a new turn gets while a mandatory update is waiting (G36.19): nothing is lost. */
export class UpdateRequiredError extends Error {
  readonly code = "update_required";
  constructor(version: string | null) {
    super(
      `RedGiant must be updated${version ? ` to ${version}` : ""} before agents can work again; nothing was lost, the message was not sent.`,
    );
    this.name = "UpdateRequiredError";
  }
}

// What a release says about itself (G36.19): `release.json`, signed with the update key and
// attached to every GitHub release. Most releases are "normal"; a "mandatory" one must be
// installed before RedGiant can be used again, a "breaking" one cannot be installed over the
// old version (a clean install: backup, uninstall, install, restore). Without a valid signature
// the file counts for nothing: nobody can force an update with forged metadata.
//
// The same rules live in the Windows launcher (`packaging/windows/launcher/ReleaseInfo.cs`) and
// in `packaging/update/release-info.mjs`, which writes the file at release time.
import { z } from "zod";

export const ReleaseKind = z.enum(["normal", "mandatory", "breaking"]);
export type ReleaseKind = z.infer<typeof ReleaseKind>;

const Version = z.string().regex(/^\d+\.\d+\.\d+$/);

/** A short reason, in both languages of the interface. */
export const ReleaseNote = z.object({ it: z.string().max(600), en: z.string().max(600) });
export type ReleaseNote = z.infer<typeof ReleaseNote>;

export const ReleaseInfo = z.object({
  format: z.literal(1),
  version: Version,
  kind: ReleaseKind,
  /** For mandatory and breaking: only installed versions below this one are concerned (default: all older). */
  minVersion: Version.optional(),
  note: ReleaseNote.optional(),
  /**
   * Carried by every later release, so skipping versions never skips a rule: installed versions
   * below `requiredBelow` must update, below `cleanInstallBelow` need a clean install.
   */
  requiredBelow: Version.optional(),
  cleanInstallBelow: Version.optional(),
  publishedAt: z.string().optional(),
});
export type ReleaseInfo = z.infer<typeof ReleaseInfo>;

/** "3.4.0" against "3.10.0": negative when `a` is older. Anything unreadable counts as 0. */
export function compareVersions(a: string, b: string): number {
  const x = a.replace(/^v/, "").split(".");
  const y = b.replace(/^v/, "").split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = Number.parseInt(x[i] ?? "0", 10) || 0;
    const q = Number.parseInt(y[i] ?? "0", 10) || 0;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** What the latest release means for this installation. */
export type UpdateGate = "none" | "normal" | "mandatory" | "breaking";

/**
 * The pure rule (tested as a table): nothing when the installed version is the latest or newer;
 * breaking before mandatory (a clean install also brings the new version); `minVersion` limits a
 * release's own kind to the versions below it; the carried bounds always apply. `info` is null
 * when the release has no valid signed metadata: then a newer version is only "normal".
 */
export function assessRelease(
  info: ReleaseInfo | null,
  installed: string,
  latest: string = info?.version ?? "0.0.0",
): UpdateGate {
  if (compareVersions(installed, latest) >= 0) return "none";
  if (!info || info.version !== latest) return "normal";
  const below = (v: string | undefined) => v !== undefined && compareVersions(installed, v) < 0;
  const own = info.minVersion ?? info.version;
  if (below(info.cleanInstallBelow) || (info.kind === "breaking" && below(own))) return "breaking";
  if (below(info.requiredBelow) || (info.kind === "mandatory" && below(own))) return "mandatory";
  return "normal";
}

/** How RedGiant is installed here: it decides how an update is done ("os": RedGiant OS). */
export const InstallKind = z.enum(["windows", "mac", "docker", "os", "source"]);
export type InstallKind = z.infer<typeof InstallKind>;

/** The last look for updates, as the page shows it (`GET /api/update/status`). */
export const UpdateStatus = z.object({
  install: InstallKind,
  /** Null when this installation does not know its version (run from the source). */
  installed: z.string().nullable(),
  latest: z.string().nullable(),
  checkedAt: z.string().nullable(),
  state: z.enum(["latest", "available", "unreachable", "unknown"]),
  gate: z.enum(["none", "normal", "mandatory", "breaking"]),
  /** The release carried valid signed metadata (its kind counts). */
  signed: z.boolean(),
  note: ReleaseNote.nullable(),
  /** The new version's installer or app, a fixed link (Windows, Mac). */
  downloadUrl: z.string().nullable(),
  /** Docker: the commands that bring the new image. */
  command: z.string().nullable(),
  /** Where the safety backup of a breaking update goes, as the person sees it. */
  backupDir: z.string().nullable(),
  /** Windows: RedGiant.exe can update itself, and run the uninstaller. RedGiant OS: its signed updater. */
  canUpdateHere: z.boolean(),
  canUninstall: z.boolean(),
});
export type UpdateStatus = z.infer<typeof UpdateStatus>;

/** A backup found in the folder where breaking updates leave them, for the wizard to offer. */
export const FoundBackup = z.object({
  /** "<folder>/<file>", relative to the backups' folder: what the restore names. */
  id: z.string(),
  folder: z.string(),
  file: z.string(),
  /** Full path, to show. */
  path: z.string(),
  bytes: z.number(),
  createdAt: z.string(),
  version: z.string().nullable(),
  projects: z.number(),
  conversations: z.number(),
  keychain: z.boolean(),
});
export type FoundBackup = z.infer<typeof FoundBackup>;

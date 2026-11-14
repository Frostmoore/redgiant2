// Scheduled backups (G39.3): the backup of Settings › Backup, made by itself at the hour the
// person chose, into the destination they picked (a removable disk or a folder). Each one goes
// in a folder like the safety backup's ("RedGiant-backup-2026-11-12", found again by the restore
// page) and is read back once written; only the folders this schedule made are ever removed,
// the oldest first, keeping the number chosen. A run never overlaps the previous one, and a
// destination that is missing (the disk unplugged) is a failed run the page shows, never a
// backup written somewhere else. Times come from the service's clock (`now`, `tick`).
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { BackupSchedule, BackupSettings } from "@redgiant/protocol";
import { SAFETY_FOLDER } from "./backup.js";
import { type BackupTarget, localTarget, MADE_FILE } from "./backup-targets.js";

export { MADE_FILE };

/** The latest moment the schedule asked for, at or before `now` (local time); null when off. */
export function lastSlot(s: BackupSchedule, now: Date): Date | null {
  if (s.every === "off") return null;
  const d = new Date(now);
  d.setHours(s.hour, 0, 0, 0);
  if (s.every === "daily") {
    if (d > now) d.setDate(d.getDate() - 1);
    return d;
  }
  const want = s.weekday ?? 0;
  d.setDate(d.getDate() - ((d.getDay() - want + 7) % 7));
  if (d > now) d.setDate(d.getDate() - 7);
  return d;
}

/** The next moment, for the page. */
export function nextSlot(s: BackupSchedule, now: Date): Date | null {
  const last = lastSlot(s, now);
  if (!last) return null;
  const n = new Date(last);
  n.setDate(n.getDate() + (s.every === "daily" ? 1 : 7));
  return n;
}

/**
 * Due when a slot passed after `since` (the last run, or when the schedule was set: setting it
 * at 15:00 for 03:00 does not run at once). A machine off for a week makes one backup when it
 * comes back, not seven.
 */
export function backupDue(s: BackupSchedule, since: Date, now: Date): boolean {
  const slot = lastSlot(s, now);
  return slot !== null && slot > since;
}

/** The folders to remove: those this schedule made, beyond the `keep` newest. */
export function toPrune(made: readonly string[], keep: number): string[] {
  const sorted = [...new Set(made.filter((f) => SAFETY_FOLDER.test(f)))].sort(byDay);
  return sorted.slice(0, Math.max(0, sorted.length - Math.max(1, keep)));
}

/** "RedGiant-backup-2026-11-12-2" after "…-12", before "…-13". */
function byDay(a: string, b: string): number {
  const key = (f: string) => {
    const m = /(\d{4}-\d{2}-\d{2})(?:-(\d+))?$/.exec(f);
    return `${m?.[1] ?? ""}-${String(m?.[2] ?? 1).padStart(3, "0")}`;
  };
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
}

/** The local day's folder name, "-2"… when one is there already. */
export function folderFor(now: Date, taken: (name: string) => boolean): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString();
  const base = `RedGiant-backup-${local.slice(0, 10)}`;
  if (!taken(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-999`;
}

export interface SchedulerOptions {
  settings: () => (BackupSettings & { setAt?: string }) | undefined;
  /** Saves how the last run went. */
  record: (last: NonNullable<BackupSettings["last"]>) => Promise<void>;
  /**
   * The destination now: a folder here (mounting the disk if needed), or a target elsewhere
   * (backup-targets.ts: SFTP, SMB, a node). Throws when it is not there.
   */
  prepare: (s: BackupSettings) => Promise<string | BackupTarget>;
  /** Writes the backup into this file and reads it back; resolves when done. */
  backup: (file: string) => Promise<void>;
  version: () => string | null;
  now?: () => number;
  everyMs?: number;
}

export class BackupScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly o: SchedulerOptions) {}

  private now() {
    return new Date(this.o.now?.() ?? Date.now());
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), this.o.everyMs ?? 5 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  get busy(): boolean {
    return this.running;
  }

  /** One check: runs the backup when it is due. */
  async tick(): Promise<"ran" | "idle" | "busy" | "failed"> {
    const s = this.o.settings();
    if (!s?.destination) return "idle";
    if (this.running) return "busy";
    const since = new Date(s.last?.at ?? s.setAt ?? 0);
    if (!backupDue(s.schedule, since, this.now())) return "idle";
    return this.runNow();
  }

  /** A backup now (the page's «Fai una copia adesso», or a due one). */
  async runNow(): Promise<"ran" | "busy" | "failed"> {
    const s = this.o.settings();
    if (this.running) return "busy";
    this.running = true;
    const at = this.now().toISOString();
    let file = "";
    try {
      if (!s?.destination) throw new Error("No destination chosen");
      const got = await this.o.prepare(s);
      const target = typeof got === "string" ? localTarget(got) : got;
      let staged: string | undefined;
      try {
        const made = await target.readMade();
        const there = new Set(await target.folders());
        const now = this.now();
        const folder = folderFor(now, (n) => there.has(n));
        const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString();
        file = `redgiant-${this.o.version() ?? "dev"}-${local.slice(11, 16).replace(":", "")}.rgbackup`;
        // Listed before writing: a run cut short leaves a folder this schedule may remove later.
        const list = [...made, folder];
        await target.writeMade(list);
        staged = await target.stage(folder, file);
        await this.o.backup(staged);
        // Whole and checked, or not at all: a temporary name until then.
        await target.put(staged, folder, file);
        const gone = toPrune(list, s.schedule.keep);
        for (const f of gone) await target.removeFolder(f);
        await target.writeMade(list.filter((f) => !gone.includes(f)));
        file = join(folder, file);
      } finally {
        // A staging file of a backup that travelled (a folder here's was renamed already).
        if (staged) await rm(staged, { force: true }).catch(() => {});
        await target.close().catch(() => {});
      }
      await this.o.record({ at, ok: true, file });
      return "ran";
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      await this.o
        .record({
          at,
          ok: false,
          error: (err as Error).message,
          ...(typeof code === "string" && { code }),
        })
        .catch(() => {});
      return "failed";
    } finally {
      this.running = false;
    }
  }
}

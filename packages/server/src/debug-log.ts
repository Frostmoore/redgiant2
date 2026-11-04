// Debug mode (2026-11-04, the person's request: "una modalità di debug in cui tutto quello che
// succede lascia un log"). Off by default; when on, every job's steps with their times, the
// local engine's commands and its whole log, the requests to the server and what the Windows
// launcher does go into files, one a day, at most MAX_BYTES in all (the oldest go first).
// The files can be downloaded as one archive to send to whoever helps, or deleted.
//
//   <logs>/debug.on                 the switch (also REDGIANT_DEBUG=1), read at startup
//   <logs>/redgiant-YYYY-MM-DD.log  the server: one JSON line per event
//   <logs>/engine-YYYY-MM-DD.log    the engine in Docker: its own lines
//   <win>/debug.on, <win>/launcher-*.log, <win>/engine-windows-*.log   the Windows side

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const MAX_BYTES = 300 * 1024 * 1024;

const day = () => new Date().toISOString().slice(0, 10);

export interface DebugLogState {
  enabled: boolean;
  /** Set by the environment: the page cannot turn it off. */
  forced: boolean;
  bytes: number;
  files: number;
}

class DebugLog {
  private dir: string | undefined;
  private winDir: string | undefined;
  private on = false;
  private forced = false;
  private streams = new Map<string, WriteStream>();
  private written = 0;

  /** Where the files go; reads the switch. Called once at startup, before anything else. */
  async configure(o: {
    dir: string;
    winDir?: string | undefined;
    forced?: boolean;
  }): Promise<void> {
    this.dir = o.dir;
    this.winDir = o.winDir;
    this.forced = o.forced === true;
    await mkdir(o.dir, { recursive: true }).catch(() => {});
    const flag = await stat(join(o.dir, "debug.on")).then(
      () => true,
      () => false,
    );
    this.on = this.forced || flag;
    if (this.on) {
      await this.syncWindows();
      this.write("debug", "debug mode on", { forced: this.forced });
    }
  }

  get enabled(): boolean {
    return this.on;
  }

  async setEnabled(on: boolean): Promise<void> {
    if (!this.dir) return;
    if (this.forced) on = true;
    if (on && !this.on) {
      this.on = true;
      await writeFile(join(this.dir, "debug.on"), new Date().toISOString());
      this.write("debug", "debug mode on");
    } else if (!on && this.on) {
      this.write("debug", "debug mode off");
      this.on = false;
      await unlink(join(this.dir, "debug.on")).catch(() => {});
      this.closeAll();
    }
    await this.syncWindows();
  }

  /** The launcher on Windows logs too while the same file is in its folder. */
  private async syncWindows(): Promise<void> {
    if (!this.winDir) return;
    const flag = join(this.winDir, "debug.on");
    if (this.on) await writeFile(flag, new Date().toISOString()).catch(() => {});
    else await unlink(flag).catch(() => {});
  }

  /** One event of the server: what, where, and the details that help (never secrets). */
  write(area: string, message: string, data?: Record<string, unknown>): void {
    if (!this.on) return;
    const line = `${JSON.stringify({ t: new Date().toISOString(), area, message, ...(data && { data }) })}\n`;
    this.append("redgiant", line);
  }

  /** Raw lines of another program (the engine), kept as they come with the time in front. */
  raw(name: string, text: string): void {
    if (!this.on) return;
    const t = new Date().toISOString();
    const lines = text
      .split(/\r?\n/)
      .filter((l) => l.length > 0)
      .map((l) => `${t} ${l}\n`)
      .join("");
    if (lines) this.append(name, lines);
  }

  private append(name: string, text: string): void {
    if (!this.dir) return;
    const file = `${name}-${day()}.log`;
    let s = this.streams.get(file);
    if (!s) {
      // Yesterday's files are closed when the day changes.
      for (const [f, old] of this.streams) {
        if (f.startsWith(`${name}-`)) {
          old.end();
          this.streams.delete(f);
        }
      }
      s = createWriteStream(join(this.dir, file), { flags: "a" });
      s.on("error", () => {});
      this.streams.set(file, s);
    }
    s.write(text);
    this.written += text.length;
    if (this.written > 8 * 1024 * 1024) {
      this.written = 0;
      void this.prune();
    }
  }

  private closeAll(): void {
    for (const s of this.streams.values()) s.end();
    this.streams.clear();
  }

  /** Every log file, the server's and the launcher's, oldest first. */
  private async logFiles(): Promise<{ path: string; name: string; size: number; mtime: number }[]> {
    const out: { path: string; name: string; size: number; mtime: number }[] = [];
    for (const [dir, prefix] of [
      [this.dir, ""],
      [this.winDir, "windows/"],
    ] as const) {
      if (!dir) continue;
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const n of names) {
        if (!n.endsWith(".log")) continue;
        const st = await stat(join(dir, n)).catch(() => undefined);
        if (st?.isFile())
          out.push({ path: join(dir, n), name: prefix + n, size: st.size, mtime: st.mtimeMs });
      }
    }
    return out.sort((a, b) => a.mtime - b.mtime);
  }

  /** The oldest files go until everything fits in MAX_BYTES. */
  async prune(): Promise<void> {
    const files = await this.logFiles();
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files) {
      if (total <= MAX_BYTES) break;
      if ([...this.streams.keys()].some((k) => f.path.endsWith(k))) continue;
      await unlink(f.path).catch(() => {});
      total -= f.size;
    }
  }

  async state(): Promise<DebugLogState> {
    const files = await this.logFiles();
    return {
      enabled: this.on,
      forced: this.forced,
      bytes: files.reduce((n, f) => n + f.size, 0),
      files: files.length,
    };
  }

  /** Every log as one .tar.gz, to download and send. */
  async archive(): Promise<Buffer> {
    const parts: Buffer[] = [];
    for (const f of await this.logFiles()) {
      const body = await readFile(f.path).catch(() => Buffer.alloc(0));
      parts.push(tarEntry(f.name, body, f.mtime));
    }
    parts.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(parts));
  }

  async clear(): Promise<void> {
    this.closeAll();
    for (const f of await this.logFiles()) await rm(f.path, { force: true });
    if (this.on) this.write("debug", "logs cleared");
  }
}

/** One file of a tar archive (ustar header, the content, padding to 512 bytes). */
function tarEntry(name: string, body: Buffer, mtimeMs: number): Buffer {
  const header = Buffer.alloc(512);
  const put = (s: string, at: number, len: number) => header.write(s, at, len, "ascii");
  const octal = (n: number, len: number) => `${n.toString(8).padStart(len - 1, "0")}\0`;
  put(name.slice(0, 99), 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(body.length, 12), 124, 12);
  put(octal(Math.floor(mtimeMs / 1000), 12), 136, 12);
  put("        ", 148, 8);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of header) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

/** The server's one debug log. */
export const debugLog = new DebugLog();

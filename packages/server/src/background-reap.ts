// Background commands left by a previous run of RedGiant (p3.3.1): a crash or a kill leaves no
// chance to stop them, so at the next start each one still recorded as running is looked for by
// its process id and stopped with its tree, but only when that process started when the command
// did (a process id is reused by the system). Then the log marks it interrupted.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { killTree } from "@redgiant/tools";

/** When the process with this id started (ms), or undefined when there is none. */
export type StartTimeOf = (pid: number) => Promise<number | undefined>;

const run = (file: string, args: string[]) =>
  new Promise<string>((ok) =>
    execFile(file, args, { timeout: 5000, windowsHide: true }, (err, out) => ok(err ? "" : out)),
  );

/** The system's own record of a process's start: PowerShell on Windows, `ps` elsewhere. */
export function processStartTime(platform: NodeJS.Platform = process.platform): StartTimeOf {
  return async (pid) => {
    if (platform === "win32") {
      const out = await run("powershell.exe", [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString('o')`,
      ]);
      const t = Date.parse(out.trim());
      return Number.isFinite(t) ? t : undefined;
    }
    if (platform === "linux") {
      // Its environment names the command (REDGIANT_COMMAND), better than any clock.
      try {
        readFileSync(`/proc/${pid}/stat`);
      } catch {
        return undefined;
      }
    }
    const out = await run("ps", ["-o", "lstart=", "-p", String(pid)]);
    const t = Date.parse(out.trim());
    return Number.isFinite(t) ? t : undefined;
  };
}

/** Whether a Linux process belongs to this command (its environment says so). */
function namesCommand(pid: number, id: string): boolean | undefined {
  try {
    return readFileSync(`/proc/${pid}/environ`, "latin1")
      .split("\0")
      .includes(`REDGIANT_COMMAND=${id}`);
  } catch {
    return undefined;
  }
}

export interface ReapDeps {
  platform?: NodeJS.Platform;
  startTime?: StartTimeOf;
  kill?: (pid: number) => void | Promise<void>;
}

/**
 * Stops a command's process left from before, if it is still that process: on Linux its
 * environment names the command; elsewhere it started within 10 s of the command. True when
 * something was stopped.
 */
export async function reapOrphan(
  c: { id: string; pid?: number | undefined; startedAt: string },
  d: ReapDeps = {},
): Promise<boolean> {
  if (!c.pid) return false;
  const platform = d.platform ?? process.platform;
  const kill = d.kill ?? ((pid: number) => killTree(pid, platform));
  if (platform === "linux" && !d.startTime) {
    const ours = namesCommand(c.pid, c.id);
    if (ours === undefined || !ours) return false;
    await kill(c.pid);
    return true;
  }
  const started = await (d.startTime ?? processStartTime(platform))(c.pid);
  if (started === undefined || Math.abs(started - Date.parse(c.startedAt)) > 10_000) return false;
  await kill(c.pid);
  return true;
}

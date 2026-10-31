import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Exit code with which the server asks to be rebuilt and restarted on the promoted code. */
export const RESTART_EXIT_CODE = 75;

/** What happened to one candidate version. */
export interface ReleaseEntry {
  commit: string;
  result: "promoted" | "rolled_back";
  /** Why a version was rolled back. */
  reason?: string;
  /** The platform change that produced it, when God promoted it. */
  changeId?: string;
  ownerId?: string;
  at: string;
}

/** The supervisor's state, shared with the server through the state directory. */
export interface ReleaseState {
  /** The last version that came up healthy. */
  lastGood: string | null;
  /** The version whose build is in place. */
  built: string | null;
  history: ReleaseEntry[];
}

/** Left by the server before it exits with RESTART_EXIT_CODE: which change is being promoted. */
export interface ReleaseRequest {
  changeId: string;
  ownerId: string;
  commit: string;
}

export const releaseFile = (stateDir: string) => join(stateDir, "release.json");
export const requestFile = (stateDir: string) => join(stateDir, "request.json");

export async function readRelease(stateDir: string): Promise<ReleaseState> {
  try {
    return JSON.parse(await readFile(releaseFile(stateDir), "utf8")) as ReleaseState;
  } catch {
    return { lastGood: null, built: null, history: [] };
  }
}

/** Written atomically: a crash never leaves half a file. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

export async function readRequest(stateDir: string): Promise<ReleaseRequest | undefined> {
  try {
    return JSON.parse(await readFile(requestFile(stateDir), "utf8")) as ReleaseRequest;
  } catch {
    return undefined;
  }
}

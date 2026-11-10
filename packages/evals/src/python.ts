import { execFileSync } from "node:child_process";

/**
 * The Python 3 that runs the verifiers (3.5.5). On Linux and macOS it is `python3`; on Windows
 * often only `python` or the launcher `py -3` (Rig: only `python`, 3.13), and `python3` may be
 * the Microsoft Store's stand-in that prints a hint and fails. Tried in this order, each asked
 * for its major version, so a Python 2 or a stand-in never counts.
 */
export const PYTHON_CANDIDATES: readonly (readonly string[])[] = [
  ["python3"],
  ["python"],
  ["py", "-3"],
];

export interface Python {
  cmd: string;
  /** Arguments that come before the script's (`-3` for `py`). */
  args: string[];
}

/** Runs `cmd args` and returns what it printed, or undefined when it cannot run or fails. */
export type Probe = (cmd: string, args: string[]) => string | undefined;

const realProbe: Probe = (cmd, args) => {
  try {
    return execFileSync(cmd, args, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).toString();
  } catch {
    return undefined;
  }
};

const ASK_MAJOR = ["-c", "import sys; print(sys.version_info[0])"];

/** The first candidate that is Python 3, or undefined. */
export function findPython(probe: Probe = realProbe): Python | undefined {
  for (const [cmd = "", ...args] of PYTHON_CANDIDATES) {
    if (probe(cmd, [...args, ...ASK_MAJOR])?.trim() === "3") return { cmd, args };
  }
  return undefined;
}

export const NO_PYTHON = `No Python 3 found: tried ${PYTHON_CANDIDATES.map((c) => c.join(" ")).join(", ")}. The verifiers need Python 3 on the PATH (https://www.python.org/downloads/).`;

let cached: Python | undefined;

/** findPython once per process; throws NO_PYTHON when there is none. */
export function python(): Python {
  cached ??= findPython();
  if (!cached) throw new Error(NO_PYTHON);
  return cached;
}

/**
 * A verifier's command line as program and arguments (no shell): a leading `python3` becomes
 * the Python 3 found here. Throws NO_PYTHON when the command needs one and there is none.
 */
export function commandLine(command: string, find: () => Python = python): [string, string[]] {
  const [cmd = "", ...args] = command.split(" ");
  if (cmd !== "python3") return [cmd, args];
  const p = find();
  return [p.cmd, [...p.args, ...args]];
}

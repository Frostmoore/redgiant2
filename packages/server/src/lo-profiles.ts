// LibreOffice's profiles (p3.5.3). Two soffice with the same profile collide: the second one
// hands its work to the first or, on Windows, shows a «another instance is running» dialog and
// waits for the person's OK (the person's test of 3.5.1). Every LibreOffice RedGiant starts has a
// profile of its own, never the person's, and no window.
import { pathToFileURL } from "node:url";

/** The options that keep LibreOffice without windows, dialogs or a restored session. */
export const LO_QUIET = [
  "--headless",
  "--invisible",
  "--norestore",
  "--nologo",
  "--nodefault",
  "--nolockcheck",
  "--nofirststartwizard",
] as const;

/** The `-env:UserInstallation=` argument for a profile folder (a file URL, spaces encoded). */
export const profileArg = (dir: string) => `-env:UserInstallation=${pathToFileURL(dir).href}`;

/**
 * Profiles for one kind of LibreOffice work: at most `size` at once, each run with a profile no
 * other run holds now. The first slot is `base` itself (warm after the first run), the others
 * `base-2`, `base-3`…; a run waits for a free one.
 */
export class LoProfiles {
  private readonly busy = new Set<number>();
  private readonly waiters: (() => void)[] = [];

  constructor(
    readonly base: string,
    readonly size = 1,
  ) {}

  /** The folder of slot `i` (0 is the base). */
  dirOf(i: number): string {
    return i === 0 ? this.base : `${this.base}-${i + 1}`;
  }

  async use<T>(f: (profileDir: string) => Promise<T>): Promise<T> {
    let slot = this.free();
    while (slot === undefined) {
      await new Promise<void>((ok) => this.waiters.push(ok));
      slot = this.free();
    }
    this.busy.add(slot);
    try {
      return await f(this.dirOf(slot));
    } finally {
      this.busy.delete(slot);
      this.waiters.shift()?.();
    }
  }

  private free(): number | undefined {
    for (let i = 0; i < this.size; i++) if (!this.busy.has(i)) return i;
    return undefined;
  }
}

const pools = new Map<string, LoProfiles>();
/** The one pool for a profile folder in this process (two users of one base share its slots). */
export function loProfiles(base: string, size = 1): LoProfiles {
  let p = pools.get(base);
  if (!p) {
    p = new LoProfiles(base, size);
    pools.set(base, p);
  }
  return p;
}

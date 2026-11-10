// Git Bash's paths on Windows (p3.5.4, the 3.5.3 test). Agents run bash on Windows through Git
// Bash, and write paths its way: `/c/Users/…` (also Cygwin's `/cygdrive/c/…` and WSL's `/mnt/c/…`),
// `~`, `$HOME`, `$USERPROFILE`. Node reads `/c/Users/…` as `C:\c\Users\…`, so a file tool found
// nothing and the guardian did not recognise an archived project's folder written that way. This
// is the one place that turns them into Windows paths: the file tools' input (`nativePaths`) and
// the guardian's reading of paths and commands (@redgiant/hierarchy) both use it. Pure; elsewhere
// than Windows nothing changes.

export interface NativePathOptions {
  /** Whether paths are Windows paths (the computer, or the folders the guardian checks). */
  windows: boolean;
  /** The home folder, for `~`, `$HOME`, `$USERPROFILE` and the like. */
  home?: string | undefined;
}

/** The home's names at the start of a path, as bash, PowerShell and cmd write them. */
const HOME =
  /^(~|\$HOME|\$\{HOME\}|\$USERPROFILE|\$\{USERPROFILE\}|\$env:(?:USERPROFILE|HOME)|%USERPROFILE%|%HOME%)(?=$|[\\/])/i;
/** A drive as Git Bash, Cygwin and WSL write it: `/c/…`, `/cygdrive/c/…`, `/mnt/c/…`. */
const DRIVE = /^\/(?:cygdrive\/|mnt\/)?([a-zA-Z])(?=$|\/)(.*)$/;

/** A path as Windows names it; anything else as it is. */
export function nativePath(path: string, o: NativePathOptions): string {
  if (!o.windows) return path;
  let p = path;
  const home = o.home?.replace(/[\\/]+$/, "");
  const h = home ? p.match(HOME) : null;
  if (h && home) p = home + p.slice(h[0].length).replace(/\//g, "\\");
  const d = p.match(DRIVE);
  if (d)
    return `${(d[1] as string).toUpperCase()}:\\${(d[2] ?? "").replace(/^\/+/, "").replace(/\//g, "\\")}`;
  return p;
}

/** The fields of a tool's input that hold paths (never a command, a pattern or a text). */
const PATH_KEY =
  /^(path|paths|file|files|cwd|dir|directory|folder|folders|root|target|source|src|dest|destination|image|images|output|out)$|_(path|paths|dir|file|files|folder)$/i;

/**
 * A tool's input with the paths in it (by their fields' names, however deep) as Windows names
 * them. The same object when nothing changes.
 */
export function nativePaths<T>(input: T, o: NativePathOptions): T {
  if (!o.windows) return input;
  const walk = (v: unknown, pathy: boolean): unknown => {
    if (typeof v === "string") return pathy ? nativePath(v, o) : v;
    if (Array.isArray(v)) {
      const out = v.map((x) => walk(x, pathy));
      return out.some((x, i) => x !== v[i]) ? out : v;
    }
    if (v && typeof v === "object") {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const y = walk(x, PATH_KEY.test(k));
        if (y !== x) changed = true;
        out[k] = y;
      }
      return changed ? out : v;
    }
    return v;
  };
  return walk(input, false) as T;
}

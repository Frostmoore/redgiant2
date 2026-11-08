// Commands that walk a whole disk (p3.4.0, the benchmark on Windows, 2026-11-08): a small model
// looking for a header or for its own project ran `find / -name …` in Git's bash, which went on
// for more than ten minutes and never came back. On this computer such a walk is almost always a
// mistake, so `bash` answers at once instead of running it. Only a disk's root counts (and a
// drive's root on Windows): `find /usr/include`, `grep -r x .`, `ls /` stay allowed, and so does a
// `find /` limited to a few levels with -maxdepth.

/** The deepest a `find` from the root may go and still run. */
const SHALLOW = 3;

/** A path that stands for a whole disk: `/`, `/*`, a drive (`C:\`, `/c`, `/mnt/c`, `/cygdrive/c`). */
export function isDiskRoot(path: string): boolean {
  return (
    /^\/+(\.|\*)?$/.test(path) ||
    /^[A-Za-z]:[\\/]*\*?$/.test(path) ||
    /^\\+$/.test(path) ||
    /^\/(mnt\/|cygdrive\/)?[A-Za-z]\/*\*?$/.test(path)
  );
}

/**
 * Splits a command into simple commands, each a list of words without their quotes: separators
 * (; & | && || and new lines) count only outside quotes. Good enough to read options and paths.
 */
function commands(text: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1);
      const end = close < 0 ? text.length : close;
      word += text.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === "\\" && i + 1 < text.length && text[i + 1] !== "\n") {
      // Kept: Windows paths (C:\) are written with it, and bash escapes rarely matter here.
      word += c;
      inWord = true;
    } else if (c === ";" || c === "&" || c === "|" || c === "\n") endCommand();
    else if (c === " " || c === "\t" || c === "\r") endWord();
    else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return out;
}

/** Here-documents are data (a script being written), not commands: only their first line stays. */
const withoutHeredocs = (text: string) =>
  text.replace(/(<<-?\s*(['"]?)([A-Za-z_]\w*)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, "$1");

/** Words that only wrap the real command. */
const WRAPPERS = new Set(["sudo", "time", "command", "nohup", "exec", "nice", "env", "timeout"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "powershell", "pwsh", "cmd"]);

const nameOf = (w: string) =>
  w
    .replace(/^.*[\\/]/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();

function hitIn(all: string[], depth: number): boolean {
  let i = 0;
  while (
    i < all.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(all[i] as string) ||
      WRAPPERS.has(all[i] as string) ||
      // `timeout 60 find …`
      (all[i - 1] === "timeout" && /^\d/.test(all[i] as string)))
  )
    i++;
  const name = nameOf(all[i] ?? "");
  const args = all.slice(i + 1);
  // A shell given a command: `bash -c "find / …"`, `powershell -Command "…"`, `cmd /c dir C:\ /s`.
  if (SHELLS.has(name) && depth < 2) {
    const at = args.findIndex((a) => /^(-c|-command|\/c|\/k|\/\/c)$/i.test(a));
    if (at >= 0)
      return detect(
        name === "cmd" ? args.slice(at + 1).join(" ") : (args[at + 1] ?? ""),
        depth + 1,
      );
    return false;
  }
  if (name === "find") {
    const starts: string[] = [];
    for (const a of args) {
      if (a.startsWith("-") || a === "(" || a === "!" || a === "\\(") break;
      starts.push(a);
    }
    if (!starts.some(isDiskRoot)) return false;
    const d = args.indexOf("-maxdepth");
    const max = d >= 0 ? Number(args[d + 1]) : Number.NaN;
    return !(Number.isFinite(max) && max <= SHALLOW);
  }
  const flags = args.filter((a) => a.startsWith("-"));
  const paths = args.filter((a) => !a.startsWith("-"));
  const short = (letters: RegExp) =>
    flags.some((f) => !f.startsWith("--") && letters.test(f.slice(1)));
  // PowerShell's `-Recurse`, in any case and shortened (`-r`, `-rec`).
  const recurse = flags.some((f) => /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(f) && f !== "-r");
  switch (name) {
    case "ls":
      return (short(/R/) || flags.includes("--recursive") || recurse) && paths.some(isDiskRoot);
    case "tree":
    case "du":
    case "rg":
    case "ag":
    case "fd":
      return paths.some(isDiskRoot);
    case "grep":
    case "egrep":
    case "fgrep":
      return (
        (short(/[rR]/) ||
          flags.includes("--recursive") ||
          flags.includes("--dereference-recursive")) &&
        paths.some(isDiskRoot)
      );
    case "get-childitem":
    case "gci":
    case "dir": {
      const slashS = args.some((a) => /^\/s$/i.test(a));
      const r = recurse || flags.some((f) => /^-r$/i.test(f)) || slashS;
      const targets = args.filter((a) => !a.startsWith("-") && !/^\/[a-z]$/i.test(a));
      // cmd's `dir C:\cl.exe /s` looks for the name in every folder of the drive.
      if (slashS) targets.push(...targets.map((t) => t.replace(/^([A-Za-z]:\\?)[^\\/]*$/, "$1")));
      const p = args.findIndex((a) => /^-(path|literalpath)$/i.test(a));
      if (p >= 0 && args[p + 1]) targets.push(args[p + 1] as string);
      return r && targets.some(isDiskRoot);
    }
    default:
      return false;
  }
}

function detect(text: string, depth: number): boolean {
  // Substitutions run too (`cd "$(dirname "$(find / …)")"`): each becomes a command of its own.
  const flat = withoutHeredocs(text).replace(/\$\(|`|\)/g, "\n");
  return commands(flat).some((c) => hitIn(c, depth));
}

/**
 * Whether `command` walks a whole disk (`find / -name x`, `ls -R /`, `grep -r x /`,
 * `Get-ChildItem C:\ -Recurse`, `cmd /c dir C:\ /s`). A pure function.
 */
export function diskWideSearch(command: string): boolean {
  return detect(command, 0);
}

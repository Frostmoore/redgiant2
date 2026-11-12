// The truly dangerous requests (G36.17b, the person: «Solo le richieste VERAMENTE pericolose devono
// arrivare a me sempre e ovunque. Roba come modificare file di sistema, cancellazioni
// irrecuperabili di cose importanti, pubblicazione di segreti... Git push è attività ordinaria che
// si fa decine di volte al giorno»). This file only says whether a tool call is one of them, and
// why: the policy turns a critical call into a request for the person (whatever the rules and the
// mode), the broker never lets a parent agent or the person's classifier decide it, and it
// reaches the person everywhere. It is a pure function, tested as a table
// (test/critical.test.ts): change the table first.
//
// What is critical:
//  - critical-system: writing or deleting in the operating system's and the programs' folders,
//    the Windows registry, drivers and services, users, the system's security settings;
//  - critical-delete: deletions nothing brings back: recursive deletes outside the project, of
//    the home, of important folders, of a disk, of a project's root or its .git; formatting;
//    dropping a database; deleting a repository or a remote branch; a forced push over a shared
//    branch (main, master…). A plain `git push` is not critical;
//  - critical-secret: a password, a key, a token or a keychain value leaving: committed, written
//    into a file that may be committed, sent to a host that is not its own, posted, pasted;
//  - critical-payment: payments and purchases with real money;
//  - critical-protections: switching off RedGiant's own protections (the permission policy, its
//    settings files and keychain, its own code going live).
//
// Shell commands are read roughly, for bash, PowerShell and cmd alike: split on ; && || | and
// new lines, `cd` followed, `bash -c`, `powershell -Command`, `cmd /c` and `ssh host …` read
// inside. Backslashes are kept (Windows paths); quotes are removed.

import { posix, win32 } from "node:path";
import type { ToolCallInfo } from "@redgiant/agent";
import {
  type CriticalAction,
  type CriticalDetail,
  type CriticalId,
  type LeakableSecret,
  leakableSecrets,
  nativePath,
} from "@redgiant/protocol";

export interface CriticalContext {
  /** The folders the agent works in (its project, its worktree); the first is where commands start. */
  roots?: readonly string[];
  /** The home folder, for `~`. */
  home?: string;
  /** The values of the person's keychain: an agent never has them, so any of them leaving is critical. */
  knownSecrets?: readonly string[];
  /** RedGiant's own files (its settings, its keychain, its database): touching them is critical. */
  protectedPaths?: readonly string[];
  /**
   * The person's machines (G38.2), by name: where commands start there and what counts as their
   * project (the working folder). A machine not here has none: every deletion there is outside.
   */
  machines?: Readonly<Record<string, RemoteMachineInfo>>;
}

/** What the rules need of a machine: its working folder and the home of the user it logs in as. */
export interface RemoteMachineInfo {
  folder?: string | undefined;
  home?: string | undefined;
}

/**
 * One truly dangerous kind of a call: why (for the model and the log) and, for the person, what
 * it does with the call's own arguments (`action`, `target`…: the red card's sentence, p3.5.4).
 */
export interface CriticalHit extends CriticalDetail {
  /** Why, in a line (English, like the policy's reasons). */
  why: string;
}

// -------------------------------------------------------------------------------------------
// Paths

type Loc =
  | { kind: "path"; path: string; win: boolean; glob: boolean }
  /** A path that is only a variable (`rm -rf $DIR/`): if it is empty, it is the root. */
  | { kind: "unknown"; raw: string };

const isWinAbs = (p: string) => /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith("\\\\");

/** Where scratch files go: deleting there is never critical. */
const TMP_POSIX = ["/tmp", "/var/tmp", "/private/tmp", "/private/var/folders", "/var/folders"];

/** The operating system's and the programs' folders. */
const SYSTEM_POSIX = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/boot",
  "/sys",
  "/proc",
  "/var/lib",
  "/var/db",
  "/System",
  "/Library",
  "/Applications",
  "/private/etc",
  "/private/var/db",
  "/snap",
];
/** Devices that are not disks. */
const HARMLESS_DEV =
  /^\/dev\/(null|zero|stdout|stderr|stdin|tty|fd\/\d+|shm(\/.*)?|pts\/\d+|random|urandom)$/;
const SYSTEM_WIN = [
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "system volume information",
  "boot",
  "recovery",
  "$recycle.bin",
];
/** A home's folders whose loss is a disaster. */
const IMPORTANT_IN_HOME = new Set([
  "documents",
  "documenti",
  "desktop",
  "scrivania",
  "pictures",
  "immagini",
  "downloads",
  "download",
  "music",
  "musica",
  "videos",
  "video",
  "movies",
  "onedrive",
  "dropbox",
  "google drive",
  "icloud drive",
  "library",
  "appdata",
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".config",
]);
/** Folders whose children are each a person's home or a disk. */
const PARENTS_POSIX = ["/home", "/Users", "/mnt", "/media", "/Volumes", "/run/media"];
/** Caches: deleting them (even outside the project) loses nothing. */
const CACHE_PART =
  /(^|[\\/])(node_modules|\.cache|__pycache__|\.pytest_cache|\.npm|\.pnpm-store)([\\/]|$)/i;
const WIN_TMP = /\\(appdata\\local\\temp|windows\\temp)(\\|$)/i;

const winKey = (p: string) =>
  win32
    .normalize(p)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
const posixKey = (p: string) => posix.normalize(p).replace(/\/+$/, "") || "/";

function under(path: string, win: boolean, base: string): boolean {
  if (win !== isWinAbs(base)) return false;
  const [p, b] = win ? [winKey(path), winKey(base)] : [posixKey(path), posixKey(base)];
  const sep = win ? "\\" : "/";
  return p === b || p.startsWith(b.endsWith(sep) ? b : `${b}${sep}`);
}
const same = (a: string, win: boolean, b: string) =>
  win === isWinAbs(b) && (win ? winKey(a) === winKey(b) : posixKey(a) === posixKey(b));

interface Where {
  roots: string[];
  home: string;
  cwd: string;
  ctx: CriticalContext;
  /** On another machine (G38.2): any deletion outside its working folder is critical. */
  remote?: boolean;
}

/** Variables that point to known places, as bash, PowerShell and cmd write them. */
function expand(t: string, w: Where): string {
  const home = w.home;
  let s = t.replace(/^FileSystem::/i, "");
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = home + s.slice(1);
  const swap: [RegExp, string][] = [
    [/^(\$\{?HOME\}?|\$env:(USERPROFILE|HOME)|%USERPROFILE%)/i, home],
    [/^(\$\{?PWD\}?|\$pwd)/i, w.cwd],
    [/^(\$env:(SystemRoot|windir)|%(SystemRoot|windir)%)/i, "C:\\Windows"],
    [/^(\$env:ProgramFiles\(x86\)|%ProgramFiles\(x86\)%)/i, "C:\\Program Files (x86)"],
    [/^(\$env:ProgramFiles|%ProgramFiles%)/i, "C:\\Program Files"],
    [/^(\$env:ProgramData|%ProgramData%)/i, "C:\\ProgramData"],
    [/^(\$env:SystemDrive|%SystemDrive%)/i, "C:"],
    [/^(\$\{?TMPDIR\}?|\$env:(TEMP|TMP)|%(TEMP|TMP)%)/i, "/tmp"],
  ];
  for (const [re, to] of swap) if (re.test(s)) return s.replace(re, to.replace(/\$/g, "$$$$"));
  return s;
}

function locate(token: string, w: Where): Loc | undefined {
  if (!token || /^[a-z][\w+.-]*:\/\//i.test(token)) return undefined;
  // Git Bash's paths on Windows (/c/Windows/…, p3.5.4) as Windows names them.
  const raw = expand(nativePath(token, { windows: isWinAbs(w.cwd), home: w.home }), w);
  // Only a variable, maybe with a slash or a star after it: empty, it is the root.
  if (/^(\$\{?\w+\}?|\$env:\w+|%\w+%)([\\/]\*?|[\\/]?)$/i.test(raw))
    return { kind: "unknown", raw };
  // Another variable in front: where it points cannot be known (not critical by itself).
  if (/^(\$|%\w+%)/.test(raw)) return undefined;
  const t = raw.replace(/\$\{?\w+\}?|\$env:\w+|%\w+%/gi, "__var__");
  const cwdWin = isWinAbs(w.cwd);
  const win = isWinAbs(t) || (cwdWin && !t.startsWith("/"));
  const parts = t.split(/[\\/]/);
  const last = parts.at(-1) ?? "";
  const glob = /[*?]/.test(last);
  const base = glob
    ? parts.slice(0, -1).join(win ? "\\" : "/") || (win ? "." : t.startsWith("/") ? "/" : ".")
    : t;
  const path = win
    ? win32.resolve(cwdWin ? w.cwd : "C:\\", base)
    : posix.resolve(cwdWin ? "/" : w.cwd, base);
  return { kind: "path", path, win, glob };
}

const inTmp = (l: Extract<Loc, { kind: "path" }>) =>
  l.win ? WIN_TMP.test(l.path) : TMP_POSIX.some((t) => under(l.path, false, t));
const inRoots = (l: Extract<Loc, { kind: "path" }>, w: Where) =>
  w.roots.some((r) => under(l.path, l.win, r));

function isSystem(l: Loc, w: Where): boolean {
  if (l.kind !== "path" || inRoots(l, w) || inTmp(l)) return false;
  if (l.win) {
    const k = winKey(l.path);
    const m = /^[a-z]:\\([^\\]+)/.exec(k);
    return m !== null && SYSTEM_WIN.includes(m[1] as string);
  }
  if (l.path.startsWith("/dev/")) return !HARMLESS_DEV.test(l.path);
  return SYSTEM_POSIX.some((s) => under(l.path, false, s));
}

const isProtected = (l: Loc, w: Where) =>
  l.kind === "path" && (w.ctx.protectedPaths ?? []).some((p) => under(l.path, l.win, p));

/** Whether losing this folder (or everything in it) is a disaster: what it is, and the action. */
function isImportant(l: Loc, w: Where): { text: string; action: CriticalAction } | undefined {
  const is = (text: string, action: CriticalAction) => ({ text, action });
  if (l.kind === "unknown")
    return is(`${l.raw} (if the variable is empty, this is the whole disk)`, "delete-variable");
  const p = l.path;
  const name = (l.win ? win32.basename(p) : posix.basename(p)).toLowerCase();
  if (name === ".git") return is(`${p} (the project's whole history)`, "delete-git");
  // Your own home first: the person reads «your home», not «a home».
  if (same(p, l.win, w.home)) return is(`${p} (your home)`, "delete-your-home");
  if (l.win) {
    const k = winKey(p);
    if (/^[a-z]:$/.test(k) || /^\\\\[^\\]+\\[^\\]+$/.test(k))
      return is(`${p} (a whole disk)`, "delete-disk");
    if (/^[a-z]:\\users(\\[^\\]+)?$/.test(k)) return is(`${p} (a person's home)`, "delete-home");
    const m = /^[a-z]:\\users\\[^\\]+\\([^\\]+)$/.exec(k);
    if (m && IMPORTANT_IN_HOME.has(m[1] as string)) return is(p, "delete-important");
  } else {
    const k = posixKey(p);
    if (k === "/") return is("/ (the whole disk)", "delete-disk");
    if (k === "/root") return is(`${k} (a home)`, "delete-home");
    for (const parent of PARENTS_POSIX)
      if (k === parent || posix.dirname(k) === parent)
        return is(`${k} (a home or a disk)`, "delete-home");
  }
  const inHome = l.win ? win32.dirname(p) : posix.dirname(p);
  if (same(inHome, l.win, w.home) && IMPORTANT_IN_HOME.has(name)) return is(p, "delete-important");
  // The project's root, or a folder above it (emptying it with * keeps its .git: not this).
  if (!l.glob)
    for (const r of w.roots)
      if (isWinAbs(r) === l.win && under(r, l.win, p))
        return is(`${p} (the whole project)`, "delete-project");
  return undefined;
}

// -------------------------------------------------------------------------------------------
// Shell words

interface Simple {
  words: string[];
  /** Files the output goes to (> and >>). */
  redirects: string[];
  /** The text of this command, as written. */
  text: string;
}

/** Splits a command line into simple commands, roughly as bash, PowerShell or cmd would. */
function simpleCommands(command: string): Simple[] {
  const out: Simple[] = [];
  let words: string[] = [];
  let redirects: string[] = [];
  let cur = "";
  let has = false;
  let quote: string | null = null;
  let start = 0;
  let nextIsRedirect = false;
  const push = () => {
    if (has) {
      if (nextIsRedirect) {
        if (!cur.startsWith("&")) redirects.push(cur);
        nextIsRedirect = false;
      } else words.push(cur);
    }
    cur = "";
    has = false;
  };
  const end = (i: number) => {
    push();
    if (words.length || redirects.length)
      out.push({ words, redirects, text: command.slice(start, i).trim() });
    words = [];
    redirects = [];
    start = i + 1;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      end(i);
      start = i + 2;
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "\n" || (c === "&" && command[i + 1] !== ">")) {
      end(i);
      continue;
    }
    // Redirections: > >> 2> &> *> >|, and 2>&1 (not a file).
    if (c === ">" || (/[12*&]/.test(c) && command[i + 1] === ">" && !has)) {
      push();
      if (c !== ">") i++;
      while (command[i + 1] === ">") i++;
      if (command[i + 1] === "|") i++;
      if (command[i + 1] === "&") {
        i++;
        while (i + 1 < command.length && /\d/.test(command[i + 1] as string)) i++;
        continue;
      }
      nextIsRedirect = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      push();
      continue;
    }
    if ((c === "(" || c === ")" || c === "{" || c === "}") && !has) continue;
    cur += c;
    has = true;
  }
  end(command.length);
  return out;
}

/** The command's own name: no folder, no .exe, lower case (PowerShell does not mind case). */
const baseName = (w: string) =>
  (w.split(/[\\/]/).at(-1) ?? "").replace(/\.exe$/i, "").toLowerCase();

/** Drops what comes before the real command: sudo, env, time, assignments. */
function strip(words: string[]): string[] {
  let ws = words;
  for (;;) {
    const [first = "", ...rest] = ws;
    const b = baseName(first);
    if (/^\w+=/.test(first)) ws = rest;
    else if (
      ["sudo", "doas", "time", "nice", "nohup", "command", "exec", "builtin", "env"].includes(b)
    ) {
      ws = rest;
      // sudo -u someone, nice -n 5: options of the prefix.
      while (ws[0]?.startsWith("-")) {
        const o = ws[0];
        ws = ws.slice(1);
        if (/^-(u|g|n|C|D)$/.test(o) && ws.length > 1) ws = ws.slice(1);
      }
    } else return ws;
  }
}

/** PowerShell switches that take no value. */
const PS_SWITCHES = new Set([
  "-recurse",
  "-force",
  "-confirm",
  "-verbose",
  "-whatif",
  "-passthru",
  "-nonewline",
  "-append",
  "-container",
]);

/** Paths a command is given: no flags (and no values of PowerShell's named options). */
function pathArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const l = a.toLowerCase();
    if (/^-(path|literalpath|destination|filepath|destinationpath|target)$/.test(l)) {
      const v = args[++i];
      if (v) out.push(v);
    } else if (/^-(path|literalpath|destination|filepath):/.test(l))
      out.push(a.slice(a.indexOf(":") + 1));
    else if (a.startsWith("--")) continue;
    else if (a.startsWith("-")) {
      // A PowerShell option with a value (-Include *.log, -ErrorAction Stop).
      if (a.length > 4 && !PS_SWITCHES.has(l) && /^-[a-z]+$/i.test(a)) i++;
    } else if (/^\/[a-z]$/i.test(a)) continue;
    else out.push(a);
  }
  return out;
}

const recursiveFlag = (args: string[]) =>
  args.some((a) => {
    const l = a.toLowerCase();
    return (
      l === "--recursive" ||
      /^-rec/.test(l) ||
      l === "/s" ||
      (/^-[a-z]{1,4}$/i.test(a) && /r/i.test(a.slice(1)) && !/^-for/i.test(a))
    );
  });

/** The secrets files that stay on the computer (gitignored by habit): writing a key there is normal. */
const LOCAL_SECRET_FILE =
  /(^|[\\/])(\.env(\.[\w-]+)?|\.dev\.vars|[^\\/]*\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519)|credentials\.json|\.netrc|[^\\/]*\.local(\.\w+)?|secrets?\.(json|ya?ml|toml|env))$/i;
const EXAMPLE_FILE = /\.(example|sample|template|dist)$/i;
/** Tests and fixtures hold fake keys on purpose. */
const TEST_FILE =
  /(^|[\\/])(test|tests|__tests__|spec|specs|fixtures?|__fixtures__|testdata)[\\/]|\.(test|spec)\.[a-z]+$/i;

/** Hosts that own each well-known key: the key going there is its normal use. */
const KEY_HOSTS: Record<string, RegExp> = {
  "anthropic-key": /(^|\.)anthropic\.com$/,
  "openai-key": /(^|\.)openai\.com$|(^|\.)openai\.azure\.com$/,
  "github-token": /(^|\.)github\.com$|(^|\.)githubusercontent\.com$/,
  "huggingface-token": /(^|\.)huggingface\.co$|(^|\.)hf\.co$/,
  "aws-access-key": /(^|\.)amazonaws\.com$/,
  "google-api-key": /(^|\.)googleapis\.com$|(^|\.)google\.com$/,
  "slack-token": /(^|\.)slack\.com$/,
  "telegram-bot-token": /^api\.telegram\.org$/,
};
/** Places where whatever is sent becomes public. */
const PASTE_HOSTS =
  /(^|\.)(pastebin\.com|paste\.ee|hastebin\.com|ghostbin\.\w+|termbin\.com|0x0\.st|transfer\.sh|dpaste\.\w+|paste\.rs|rentry\.co|gist\.github\.com|controlc\.com|justpaste\.it|webhook\.site|requestbin\.\w+)$/;

const hostsIn = (text: string) =>
  [...text.matchAll(/\bhttps?:\/\/([^/\s"'?#:]+)/gi)].map((m) => (m[1] as string).toLowerCase());

/** The keychain's values found in a text (only values long enough to mean something). */
const knownIn = (text: string, w: Where) =>
  (w.ctx.knownSecrets ?? []).filter((v) => v.length >= 8 && text.includes(v));

const short = (s: string) => (s.length > 80 ? `${s.slice(0, 77)}…` : s);
const showPath = (l: Loc) => (l.kind === "path" ? l.path : l.raw);

/** What the person reads besides the kind: the action and the call's own arguments. */
type Say = Omit<CriticalDetail, "id">;
type Add = (id: CriticalId, why: string, say: Say) => void;

// -------------------------------------------------------------------------------------------
// Rules on the whole text (every tool that runs something)

const DB_DROP: RegExp[] = [
  /\bdrop\s+(database|schema)\b/i,
  /\bdropdb\b/i,
  /\bflush(all|db)\b/i,
  /\.dropDatabase\s*\(/,
  /\bmysqladmin\b[^\n;|]*\bdrop\b/i,
];
const PROTECTED_SQL =
  /\b(update|delete\s+from|insert\s+into|truncate(\s+table)?|drop\s+table|alter\s+table)\s+("?public"?\.)?"?(rg_settings|rg_events|rg_unattended)\b/i;
const PAYMENT_HTTP =
  /\bapi\.stripe\.com\/v1\/(charges|payment_intents|payouts|transfers|refunds|checkout\/sessions|invoices\/[^/\s]+\/pay)\b|\bapi(-m)?\.(sandbox\.)?paypal\.com\/v[12]\/(payments|checkout\/orders)/i;

function textRules(text: string, add: Add) {
  for (const re of DB_DROP)
    if (re.test(text))
      add("critical-delete", `deletes a whole database: ${short(re.exec(text)?.[0] ?? "")}`, {
        action: "db-drop",
        target: short(re.exec(text)?.[0] ?? ""),
      });
  if (PROTECTED_SQL.test(text))
    add("critical-protections", "changes RedGiant's own settings or history in its database", {
      action: "protect-db",
    });
  if (PAYMENT_HTTP.test(text))
    add("critical-payment", "makes a payment through a payment service", {
      action: "pay-service",
      target: /stripe/i.test(text) ? "Stripe" : "PayPal",
    });
}

// -------------------------------------------------------------------------------------------
// Shell commands

const SYSTEM_COMMANDS: [RegExp, string, CriticalAction][] = [
  [
    /^sc (create|delete|config|stop|failure|sdset|pause)\b/,
    "changes a Windows service",
    "system-service",
  ],
  [
    /^(new|set|remove|stop|suspend|restart)-service\b/,
    "changes a Windows service",
    "system-service",
  ],
  [
    /^(pnputil|bcdedit|bootcfg|bcdboot|bootrec)\b/,
    "changes drivers or how the computer starts",
    "system-drivers",
  ],
  [
    /^systemctl\b(?!.*\s--user\b).*\s(disable|mask|stop|enable|unmask|kill|isolate|edit)\b/,
    "changes a system service",
    "system-service",
  ],
  [/^launchctl (unload|remove|bootout|disable)\b/, "changes a system service", "system-service"],
  [
    /^(insmod|rmmod|modprobe|kextload|kextunload|update-rc\.d|chkconfig)\b/,
    "changes drivers or services",
    "system-drivers",
  ],
  [/^set-mppreference\b.*-disable/, "switches off the antivirus", "system-antivirus"],
  [/^add-mppreference\b.*-exclusion/, "hides files from the antivirus", "system-antivirus"],
  [
    /^netsh\b.*\b(firewall|advfirewall)\b.*\b(off|disable|reset|delete)\b/,
    "switches off the firewall",
    "system-firewall",
  ],
  [
    /^set-netfirewallprofile\b.*-enabled\s+(false|0|\$false)/,
    "switches off the firewall",
    "system-firewall",
  ],
  [/^ufw (disable|reset)\b/, "switches off the firewall", "system-firewall"],
  [/^iptables\b.*\s(-f|--flush|-x)\b/, "removes the firewall's rules", "system-firewall"],
  [/^setenforce\s+(0|permissive)\b/, "switches off SELinux", "system-protection"],
  [/^csrutil\s+disable\b/, "switches off macOS's system protection", "system-protection"],
  [/^spctl\s+--master-disable\b/, "switches off macOS's app checks", "system-protection"],
  [
    /^set-executionpolicy\b.*\b(unrestricted|bypass)\b/,
    "lets any script run on the computer",
    "system-protection",
  ],
  [
    /^(useradd|userdel|usermod|adduser|deluser|passwd|chpasswd|visudo|groupadd|groupdel|gpasswd)\b/,
    "changes the computer's users",
    "system-users",
  ],
  [/^net (user|localgroup)\s+\S+\s+\S+/, "changes the computer's users", "system-users"],
  [
    /^(new|remove|set|enable|disable|rename)-localuser\b/,
    "changes the computer's users",
    "system-users",
  ],
  [/^(add|remove)-localgroupmember\b/, "changes the computer's administrators", "system-users"],
];
const DISK_COMMANDS: [RegExp, string, CriticalAction][] = [
  [/^mkfs(\.\w+)?\b/, "formats a disk", "disk-format"],
  [
    /^(wipefs|blkdiscard|sfdisk|sgdisk|gdisk|mkswap)\b/,
    "erases or repartitions a disk",
    "disk-format",
  ],
  [/^(fdisk|parted)\b(?!.*\s(-l|--list|print)\b)/, "repartitions a disk", "disk-partition"],
  [/^format\s+[a-z]:/, "formats a disk", "disk-format"],
  [
    /^(format-volume|clear-disk|initialize-disk|remove-partition)\b/,
    "formats or erases a disk",
    "disk-format",
  ],
  [
    /^diskutil\s+(erase\w*|zerodisk|partitiondisk|reformat|secureerase|apfs\s+delete\w*)\b/,
    "erases a disk",
    "disk-format",
  ],
  [/^diskpart\b/, "repartitions a disk", "disk-partition"],
];
const REGISTRY_PATH = /^(registry::|hk(lm|cu|cr|u|cc)(:|\\)|hkey_)/i;
const PROTECTED_BRANCH = /^(main|master|trunk|production|prod|stable|release([/-].*)?)$/;
const REPO_DELETE =
  /\b(gh|glab)\s+repo\s+delete\b|(-X|--method|--request)\s*delete\b[^\n;|]*\/repos\/[^/\s"']+\/[^/\s"']+\/?(["'\s]|$)/i;
const PAY_CLI =
  /^stripe\s+(charges|payment_intents|payouts|transfers|refunds|invoices|checkout)\b.*\b(create|pay|confirm)\b/;
const HTTP_CLIENTS = new Set([
  "curl",
  "wget",
  "http",
  "https",
  "xh",
  "invoke-webrequest",
  "invoke-restmethod",
  "iwr",
  "irm",
  "nc",
  "ncat",
  "telnet",
]);
const SECRET_FILE_NAME =
  /(^|[\\/])(\.env(\.[\w-]+)?|[^\\/]*\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519)|credentials\.json|\.netrc|service-account[^\\/]*\.json|secrets?\.(json|ya?ml|toml|env))$/i;

/** Commands that write each path they are given; the others write their last path only. */
const WRITES_ALL = new Set([
  "rm",
  "rmdir",
  "mkdir",
  "touch",
  "tee",
  "chmod",
  "chown",
  "chgrp",
  "truncate",
  "shred",
  "unlink",
  "setfacl",
  "chattr",
  "mv",
  "ln",
  "remove-item",
  "ri",
  "del",
  "erase",
  "rd",
  "set-content",
  "add-content",
  "ac",
  "clear-content",
  "clc",
  "out-file",
  "new-item",
  "ni",
  "move-item",
  "mi",
  "move",
  "rename-item",
  "ren",
  "rni",
  "set-acl",
  "icacls",
  "takeown",
  "attrib",
  "md",
]);
const WRITES_LAST = new Set([
  "cp",
  "install",
  "rsync",
  "scp",
  "copy-item",
  "cpi",
  "copy",
  "xcopy",
  "robocopy",
]);
const DELETES = new Set([
  "rm",
  "remove-item",
  "ri",
  "del",
  "erase",
  "rd",
  "rmdir",
  "shred",
  "unlink",
]);

function deleteTarget(l: Loc, recursive: boolean, w: Where, add: Add, how: string, inside = false) {
  const say = (action: CriticalAction, target: string): Say => ({
    action,
    target,
    ...(inside && { inside: true }),
  });
  if (isSystem(l, w))
    return add(
      "critical-system",
      `${how} system files: ${showPath(l)}`,
      say("system-delete", showPath(l)),
    );
  if (isProtected(l, w))
    return add(
      "critical-protections",
      `${how} RedGiant's own files: ${showPath(l)}`,
      say("protect-delete", showPath(l)),
    );
  const important = isImportant(l, w);
  if (important)
    return add("critical-delete", `${how} ${important.text}`, say(important.action, showPath(l)));
  if (
    (recursive || w.remote) &&
    l.kind === "path" &&
    !inRoots(l, w) &&
    !inTmp(l) &&
    !CACHE_PART.test(l.path)
  )
    add(
      "critical-delete",
      w.remote
        ? `${how} outside the machine's working folder, for good: ${l.path}`
        : `${how} a folder outside the project, for good: ${l.path}`,
      say(w.remote ? "remote-delete-outside" : "delete-outside", l.path),
    );
}

/** Running as another user on another machine (G38.2): the prefix and the commands. */
const REMOTE_SUDO = new Set(["sudo", "doas", "su", "pkexec", "runuser"]);
/** What else is dangerous on another machine (G38.2): switching it off, its system programs. */
const REMOTE_COMMANDS: [RegExp, string, CriticalAction][] = [
  [
    /^(shutdown|reboot|poweroff|halt|systemctl\s+(reboot|poweroff|halt|kexec|suspend|hibernate)|init\s+[06]|telinit\s+[06])\b/,
    "switches the machine off or restarts it",
    "remote-power",
  ],
  [
    /^(apt|apt-get|aptitude)\s+(-\S+\s+)*(install|remove|purge|reinstall|autoremove|upgrade|full-upgrade|dist-upgrade)\b/,
    "installs or removes system programs",
    "remote-install",
  ],
  [
    /^(yum|dnf|zypper|microdnf)\s+(-\S+\s+)*(install|in|remove|rm|erase|reinstall|update|upgrade|up|dup|autoremove|groupinstall)\b/,
    "installs or removes system programs",
    "remote-install",
  ],
  [
    /^dpkg\s+.*(-i|--install|-r|--remove|-p|--purge)\b/,
    "installs or removes system programs",
    "remote-install",
  ],
  [
    /^rpm\s+.*(-i|-u|-e|--install|--upgrade|--erase)\b/,
    "installs or removes system programs",
    "remote-install",
  ],
  [/^pacman\s+(-\S*[SRU]\S*)\b/, "installs or removes system programs", "remote-install"],
  [/^apk\s+(-\S+\s+)*(add|del|upgrade)\b/, "installs or removes system programs", "remote-install"],
  [
    /^(snap|flatpak)\s+(install|remove|uninstall|refresh)\b/,
    "installs or removes system programs",
    "remote-install",
  ],
  [
    /^(emerge|pkg|brew|port)\s+(-\S+\s+)*(install|uninstall|remove|delete|upgrade)\b/,
    "installs or removes system programs",
    "remote-install",
  ],
];

function writeTarget(l: Loc | undefined, w: Where, add: Add, how = "changes") {
  if (!l) return;
  if (isSystem(l, w))
    add("critical-system", `${how} system files: ${showPath(l)}`, {
      action: "system-write",
      target: showPath(l),
    });
  else if (isProtected(l, w))
    add("critical-protections", `${how} RedGiant's own files: ${showPath(l)}`, {
      action: "protect-files",
      target: showPath(l),
    });
}

function gitPush(args: string[], add: Add) {
  let force = false;
  let del = false;
  let mirror = false;
  let all = false;
  const pos: string[] = [];
  for (const a of args) {
    if (a === "--force" || a.startsWith("--force-with-lease") || a === "--force-if-includes")
      force = true;
    else if (a === "--delete") del = true;
    else if (a === "--mirror") mirror = true;
    else if (a === "--all" || a === "--branches") all = true;
    else if (/^-[a-zA-Z]+$/.test(a)) {
      if (a.includes("f")) force = true;
      if (a.includes("d")) del = true;
    } else if (!a.startsWith("-")) pos.push(a);
  }
  const refspecs = pos.slice(1);
  if (mirror)
    return add(
      "critical-delete",
      "git push --mirror: makes the remote equal to this copy, deleting what is only there",
      { action: "push-mirror" },
    );
  if (del || refspecs.some((r) => r.startsWith(":")))
    return add("critical-delete", "deletes a branch on the remote repository", {
      action: "branch-delete",
    });
  const branch = (r: string) =>
    (r.replace(/^\+/, "").split(":").at(-1) ?? "").replace(/^refs\/heads\//, "");
  const forced = refspecs.filter((r) => force || r.startsWith("+"));
  const hit = forced.find((r) => PROTECTED_BRANCH.test(branch(r)));
  if (hit)
    add(
      "critical-delete",
      `forced push over the shared branch "${branch(hit)}": rewrites its history for everyone`,
      { action: "push-force", target: branch(hit) },
    );
  else if (force && all)
    add("critical-delete", "forced push of every branch: rewrites the shared history", {
      action: "push-force-all",
    });
}

function shellSecrets(c: Simple, name: string, args: string[], w: Where, add: Add) {
  const found = leakableSecrets(c.text);
  const known = knownIn(c.text, w);
  if (known.length)
    return add(
      "critical-secret",
      "a value of your keychain is in a command (agents never get them)",
      { action: "secret-keychain" },
    );
  if (name === "git" && args[0] === "add") {
    const files = args.slice(1).filter((a) => !a.startsWith("-"));
    const f = files.find((x) => SECRET_FILE_NAME.test(x) && !EXAMPLE_FILE.test(x));
    if (f)
      return add("critical-secret", `puts a secrets file into git: ${f}`, {
        action: "secret-git-add",
        target: f,
      });
  }
  if (!found.length) return;
  const what = describeSecret(found[0] as LeakableSecret);
  const secret = (found[0] as LeakableSecret).name;
  if (name === "git" && ["commit", "tag", "notes"].includes(args[0] ?? ""))
    return add("critical-secret", `commits ${what}`, { action: "secret-commit", secret });
  if (name === "gh" || name === "glab")
    return add("critical-secret", `publishes ${what} on the repository's site`, {
      action: "secret-publish",
      secret,
    });
  if (HTTP_CLIENTS.has(name)) {
    const hosts = hostsIn(c.text);
    const paste = hosts.find((h) => PASTE_HOSTS.test(h));
    if (paste)
      return add("critical-secret", `sends ${what} to a public paste site`, {
        action: "secret-paste",
        secret,
        target: paste,
      });
    const foreign = found.find(
      (s) => KEY_HOSTS[s.name] && hosts.length && !hosts.every((h) => KEY_HOSTS[s.name]?.test(h)),
    );
    if (foreign)
      return add(
        "critical-secret",
        `sends ${describeSecret(foreign)} to a site that is not its own: ${hosts.join(", ")}`,
        { action: "secret-send", secret: foreign.name, target: hosts.join(", ") },
      );
  }
  // Written into a file that may be committed (echo "sk-…" >> config.js).
  const strong = found.filter((s) => KEY_HOSTS[s.name] || s.name === "private-key");
  for (const r of c.redirects)
    if (strong.length && !LOCAL_SECRET_FILE.test(r) && !TEST_FILE.test(r))
      return add(
        "critical-secret",
        `writes ${describeSecret(strong[0] as LeakableSecret)} into ${r}, a file that can be committed and published`,
        { action: "secret-file", secret: (strong[0] as LeakableSecret).name, target: r },
      );
}

const describeSecret = (s: LeakableSecret) =>
  s.name === "password"
    ? "a password"
    : s.name === "token"
      ? "a token"
      : s.name === "private-key"
        ? "a private key"
        : `a key (${s.name})`;

/**
 * Words given back to a shell inside a shell: one word is the whole command (`bash -c '…'`);
 * several keep their spaces inside quotes (`cmd /c del "C:\\Program Files\\x"`).
 */
const rejoin = (args: string[]) =>
  args.length === 1
    ? (args[0] as string)
    : args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");

function shellRules(command: string, w: Where, add: Add, depth = 0): void {
  if (depth > 3) return;
  textRules(command, add);
  let cwd = w.cwd;
  for (const c of simpleCommands(command)) {
    const here: Where = { ...w, cwd };
    for (const r of c.redirects) {
      const l = locate(r, here);
      if (l?.kind === "path" && !l.win && /^\/dev\/(sd|nvme|hd|xvd|vd|mmcblk|disk)/.test(l.path))
        add("critical-delete", `writes straight onto a disk: ${l.path}`, {
          action: "disk-write",
          target: l.path,
        });
      else writeTarget(l, here, add, "writes into");
    }
    const ws = strip(c.words);
    const [first = "", ...args] = ws;
    const name = baseName(first);
    if (!name) continue;
    const line = [name, ...args].join(" ").toLowerCase();
    if (here.remote) {
      // As another user (sudo in front, or su itself), then what switches it off or changes its programs.
      const prefix = c.words.slice(0, c.words.length - ws.length).map(baseName);
      if (REMOTE_SUDO.has(name) || prefix.some((p) => REMOTE_SUDO.has(p)))
        add("critical-system", `runs a command as administrator: ${short(c.text.trim())}`, {
          action: "remote-sudo",
          target: short(c.text.trim()),
        });
      // As written: pacman's -S installs, its -s searches.
      const said = [name, ...args].join(" ");
      for (const [re, why, action] of REMOTE_COMMANDS)
        if (re.test(said))
          add("critical-system", why, {
            action,
            ...(action === "remote-install" && { target: short(said) }),
          });
    }
    // Shells inside shells.
    if (["bash", "sh", "zsh", "dash", "ksh"].includes(name)) {
      const i = args.findIndex((a) => /^-[a-z]*c$/.test(a));
      if (i >= 0 && args[i + 1]) shellRules(args[i + 1] as string, here, add, depth + 1);
      continue;
    }
    if (name === "powershell" || name === "pwsh") {
      const i = args.findIndex((a) => /^-(c|command)$/i.test(a));
      if (i >= 0) shellRules(rejoin(args.slice(i + 1)), here, add, depth + 1);
      continue;
    }
    if (name === "cmd") {
      const i = args.findIndex((a) => /^\/[ck]$/i.test(a));
      if (i >= 0) shellRules(rejoin(args.slice(i + 1)), here, add, depth + 1);
      continue;
    }
    if (name === "eval") {
      shellRules(rejoin(args), here, add, depth + 1);
      continue;
    }
    if (name === "ssh") {
      // ssh [options] host command…: the command runs on another computer, whose folders are unknown.
      let i = 0;
      while (i < args.length && (args[i] as string).startsWith("-"))
        i += /^-[bcDEeFIiJLlmOoPpRSWw]$/.test(args[i] as string) ? 2 : 1;
      const rest = args.slice(i + 1);
      if (rest.length)
        shellRules(
          rejoin(rest),
          { ...here, roots: [], cwd: "/__remote__", home: "/__remote_home__" },
          add,
          depth + 1,
        );
      continue;
    }
    if (
      name === "cd" ||
      name === "set-location" ||
      name === "sl" ||
      name === "pushd" ||
      name === "chdir"
    ) {
      const l = locate(args.find((a) => !a.startsWith("-")) ?? here.home, here);
      if (l?.kind === "path") cwd = l.path;
      continue;
    }
    for (const [re, why, action] of SYSTEM_COMMANDS)
      if (re.test(line)) add("critical-system", why, { action });
    for (const [re, why, action] of DISK_COMMANDS)
      if (re.test(line)) add("critical-delete", why, { action });
    const registry: Say = { action: "system-registry" };
    if (name === "reg" && /^(add|delete|import|restore|load|unload|copy)$/i.test(args[0] ?? ""))
      add("critical-system", "changes the Windows registry", registry);
    if ((name === "regedit" || name === "regedt32") && args.length)
      add("critical-system", "changes the Windows registry", registry);
    if (
      /-item(property)?$|^(ni|ri|si|sp|rp|clp)$/.test(name) &&
      args.some((a) => REGISTRY_PATH.test(a)) &&
      !/^get-/.test(name)
    )
      add("critical-system", "changes the Windows registry", registry);
    if (REPO_DELETE.test(c.text))
      add("critical-delete", "deletes a repository online", { action: "repo-delete" });
    if (PAY_CLI.test(line))
      add("critical-payment", "makes a payment with Stripe", {
        action: "pay-service",
        target: "Stripe",
      });
    // git: pushes, and what git touches outside.
    if (name === "git") {
      const sub: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i] as string;
        if (
          sub.length === 0 &&
          (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree")
        ) {
          i++;
          continue;
        }
        if (sub.length === 0 && a.startsWith("-")) continue;
        sub.push(a);
      }
      if (sub[0] === "push") gitPush(sub.slice(1), add);
      shellSecrets(c, name, sub, here, add);
      continue;
    }
    shellSecrets(c, name, args, here, add);
    if (args.some((a) => a.toLowerCase() === "-whatif")) continue;
    // What is deleted, for good.
    if (DELETES.has(name)) {
      const recursive = name === "shred" || recursiveFlag(args);
      for (const p of pathArgs(args)) {
        const l = locate(p, here);
        if (l) deleteTarget(l, recursive, here, add, "deletes");
      }
      continue;
    }
    if (
      name === "find" &&
      (args.includes("-delete") || /-exec(dir)?\s+(rm|shred)\b/.test(args.join(" ")))
    ) {
      // find's folders come before its first test (-name, -type, !, ().
      const firstTest = args.findIndex((a) => /^[-(!]/.test(a));
      const from = firstTest < 0 ? args : args.slice(0, firstTest);
      for (const p of from.length ? from : ["."]) {
        const l = locate(p, here);
        // What is inside, not the folder itself (find . -name '*.pyc' -delete keeps the project).
        if (l)
          deleteTarget(
            l.kind === "path" ? { ...l, glob: true } : l,
            true,
            here,
            add,
            "deletes everything in",
            true,
          );
      }
      continue;
    }
    if (name === "rsync" && args.some((a) => a.startsWith("--delete"))) {
      const dest = pathArgs(args).at(-1);
      const l = dest && !/^[\w.-]+@?[\w.-]*:/.test(dest) ? locate(dest, here) : undefined;
      if (l) deleteTarget(l, true, here, add, "deletes what is not in the source from", true);
    }
    if (name === "dd") {
      for (const a of args)
        if (a.startsWith("of=")) {
          const l = locate(a.slice(3), here);
          if (l?.kind === "path" && /^\/dev\/(sd|nvme|hd|xvd|vd|mmcblk|disk)/.test(l.path))
            add("critical-delete", `writes straight onto a disk: ${l.path}`, {
              action: "disk-write",
              target: l.path,
            });
          else writeTarget(l, here, add);
        }
      continue;
    }
    // Everything else that writes: only the system's and RedGiant's own folders matter here.
    const paths = pathArgs(args);
    const targets = WRITES_ALL.has(name)
      ? paths
      : WRITES_LAST.has(name)
        ? paths.slice(-1)
        : (name === "sed" || name === "perl") && args.some((a) => /^-[a-zA-Z]*i/.test(a))
          ? paths.slice(1)
          : [];
    for (const p of targets) writeTarget(locate(p, here), here, add);
  }
}

// -------------------------------------------------------------------------------------------
// Files, the browser, connected services

function fileRules(input: Record<string, unknown>, name: string, w: Where, add: Add) {
  const p = typeof input.path === "string" ? input.path : undefined;
  if (!p) return;
  const l = locate(p, w);
  writeTarget(l, w, add, "writes into");
  const text = name === "write_file" ? String(input.content ?? "") : String(input.new_string ?? "");
  const before = name === "edit_file" ? String(input.old_string ?? "") : "";
  if (knownIn(text, w).some((v) => !before.includes(v)))
    return add("critical-secret", `writes a value of your keychain into ${p}`, {
      action: "secret-keychain-file",
      target: p,
    });
  if (LOCAL_SECRET_FILE.test(p) && !EXAMPLE_FILE.test(p)) return;
  if (TEST_FILE.test(p)) return;
  const keys = leakableSecrets(text).filter(
    (s) => (KEY_HOSTS[s.name] || s.name === "private-key") && !before.includes(s.value),
  );
  if (keys.length)
    add(
      "critical-secret",
      `writes ${describeSecret(keys[0] as LeakableSecret)} into ${p}, a file that can be committed and published`,
      { action: "secret-file", secret: (keys[0] as LeakableSecret).name, target: p },
    );
}

/**
 * canvas_edit (G37.1) writes like edit_file: into its path (a tab without one is in the agent's
 * workspace, the tool checks it), the text its operations write. Its catalog and dry runs write
 * nothing. Emptying a file is not a deletion for good: the log keeps the inverse and the panel
 * «Modifiche» undoes it. A re-export over a closed original (G37.3-4) needs the file's own switch
 * and keeps the version before: not critical either. A PDF's redaction (G37.8) is: it takes text
 * and pictures out of the file for good (that is its purpose), so the person always says yes.
 */
function editorRules(input: Record<string, unknown>, w: Where, add: Add) {
  if (input.help === true || input.dry_run === true) return;
  const ops = Array.isArray(input.ops) ? input.ops : [];
  const redacts = ops.some((o) => {
    const x = (o ?? {}) as Record<string, unknown>;
    return String(x.op ?? x.action ?? x.type ?? "").toLowerCase() === "redact";
  });
  if (redacts)
    add(
      "critical-delete",
      `redacts ${typeof input.path === "string" ? input.path : "a PDF"}: what is under the areas leaves the file for good`,
      { action: "redact", ...(typeof input.path === "string" && { target: input.path }) },
    );
  const text = ops
    .map((o) =>
      (o as { text?: unknown })?.text === undefined ? "" : String((o as { text: unknown }).text),
    )
    .join("\n");
  const before = ops
    .map((o) =>
      (o as { find?: unknown })?.find === undefined ? "" : String((o as { find: unknown }).find),
    )
    .join("\n");
  if (typeof input.path === "string")
    fileRules({ path: input.path, old_string: before, new_string: text }, "edit_file", w, add);
}

/** A tool's own name as snake_case words, without the `mcp__<server>__` prefix. */
const toolWords = (name: string) =>
  name
    .replace(/^mcp__[a-z0-9_-]+?__/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase()
    .split("_")
    .filter(Boolean);

const PAY_WORDS = new Set([
  "pay",
  "payment",
  "payments",
  "purchase",
  "buy",
  "checkout",
  "charge",
  "refund",
  "payout",
  "donate",
  "bonifico",
]);
const READ_WORDS = new Set([
  "list",
  "get",
  "search",
  "read",
  "find",
  "fetch",
  "retrieve",
  "describe",
  "show",
  "view",
  "count",
  "lookup",
]);
const DELETE_WORDS = new Set(["delete", "remove", "destroy", "drop", "purge", "wipe"]);
const REPO_WORDS = new Set([
  "repo",
  "repository",
  "repositories",
  "database",
  "db",
  "bucket",
  "branch",
  "project",
  "drive",
  "volume",
]);
const PAY_BUTTON =
  /\b(pay|paga|pagare|paga ora|pay now|buy|buy now|compra|acquista|purchase|checkout|place order|conferma (l')?ordine|conferma (il )?pagamento|ordina e paga|bonifico|donate|dona)\b/i;

/** Tools that send what they are given out of the computer. */
const OUTBOUND = (name: string) =>
  name.startsWith("mcp__") ||
  name.startsWith("browser_") ||
  name.startsWith("repo_") ||
  [
    "fetch",
    "web_search",
    "publish_board",
    "image_generation",
    "video_generation",
    "audio_generation",
    // Email (G38.1): what is sent, and a draft kept on the mail server.
    "mail_send",
    "mail_draft",
  ].includes(name);

/**
 * Email (G38.1): a file of secrets attached (a workspace path, or a draft's attachment by name),
 * and mail deleted for good (moving it to the bin is not).
 */
function mailRules(name: string, input: Record<string, unknown>, add: Add) {
  if (name === "mail_move" && input.action === "delete") {
    const ids = Array.isArray(input.ids) ? input.ids.length : 0;
    const where = [input.mailbox, input.folder].filter((x) => typeof x === "string").join(", ");
    return add(
      "critical-delete",
      `deletes ${ids || "some"} email(s) for good${where ? ` from ${where}` : ""}`,
      { action: "mail-delete", ...(where ? { target: where } : {}) },
    );
  }
  if (name !== "mail_send" && name !== "mail_draft") return;
  const prepared = (input.message && typeof input.message === "object" ? input.message : {}) as {
    attachments?: unknown;
  };
  const names = [
    ...(Array.isArray(input.attachments) ? input.attachments : []),
    ...(Array.isArray(prepared.attachments) ? prepared.attachments : []),
  ]
    .map((a) =>
      typeof a === "string"
        ? a
        : a && typeof a === "object" && typeof (a as { name?: unknown }).name === "string"
          ? (a as { name: string }).name
          : "",
    )
    .filter(Boolean);
  const secret = names.find((n) => SECRET_FILE_NAME.test(n));
  if (secret)
    add("critical-secret", `attaches a file of secrets to an email: ${secret}`, {
      action: "secret-attach",
      target: secret,
    });
}

function outboundRules(call: ToolCallInfo, input: unknown, w: Where, add: Add) {
  const text = JSON.stringify(input ?? "");
  if (knownIn(text, w).length)
    return add("critical-secret", `sends a value of your keychain through ${call.name}`, {
      action: "secret-keychain-send",
      target: call.name,
    });
  const found = leakableSecrets(text);
  if (!found.length) return;
  if (call.name === "fetch" || call.name === "browser_open") {
    // A key going to its own site is its normal use.
    const hosts = hostsIn(text);
    const foreign = found.find(
      (s) => !KEY_HOSTS[s.name] || !hosts.every((h) => KEY_HOSTS[s.name]?.test(h)),
    );
    if (!foreign) return;
    return add(
      "critical-secret",
      `sends ${describeSecret(foreign)} to ${hosts.join(", ") || "a site"}`,
      { action: "secret-send", secret: foreign.name, target: hosts.join(", ") || call.name },
    );
  }
  add(
    "critical-secret",
    `sends ${describeSecret(found[0] as LeakableSecret)} through ${call.name}`,
    { action: "secret-send", secret: (found[0] as LeakableSecret).name, target: call.name },
  );
}

/** The tools that change the platform's protections themselves. */
const PROTECTION_TOOLS: Record<string, [string, CriticalAction]> = {
  platform_policy: ["changes RedGiant's permission rules", "protect-policy"],
  platform_code_promote: [
    "puts new RedGiant code live: it could switch off its protections",
    "protect-code",
  ],
};

// -------------------------------------------------------------------------------------------

/**
 * The person's machines (G38.2): a command there is read with the same rules, its working folder
 * standing for the project (none: every deletion is outside), its user's home for `~`, and
 * RedGiant's own files left out (they are on this computer). Sudo, switching it off and its
 * system programs are critical there too. Each hit says which machine.
 */
function remoteRules(input: Record<string, unknown>, ctx: CriticalContext, add: Add) {
  const machine = typeof input.machine === "string" ? input.machine : "";
  const m = ctx.machines?.[machine];
  const home = m?.home ? posixKey(m.home) : "/__remote_home__";
  const folder = m?.folder ? posixKey(m.folder) : undefined;
  const base = folder ?? home;
  const cwd =
    typeof input.cwd === "string" && input.cwd.trim()
      ? posix.resolve(base, input.cwd.trim().replace(/^~(?=\/|$)/, home))
      : base;
  const w: Where = {
    roots: folder ? [folder] : [],
    home,
    cwd,
    ctx: { ...ctx, protectedPaths: [] },
    remote: true,
  };
  const there: Add = (id, why, say) =>
    add(id, `on the machine "${machine}": ${why}`, {
      ...say,
      // Not "your" home there: the home of the user it logs in as.
      action: say.action === "delete-your-home" ? "delete-home" : say.action,
      machine,
    });
  if (input.direction === undefined && typeof input.command === "string")
    shellRules(input.command, w, there);
  // An upload writes there: into its system folders is critical (a download writes here, inside
  // the agent's workspace, and the tool keeps it there).
  if (input.direction === "upload" && typeof input.remote === "string")
    writeTarget(locate(input.remote, w), w, there, "uploads into");
}

/** Whether a tool call is truly dangerous, and why: one hit per kind, in the order found. */
export function criticalOf(call: ToolCallInfo, ctx: CriticalContext = {}): CriticalHit[] {
  const hits: CriticalHit[] = [];
  const add: Add = (id, why, say) => {
    if (!hits.some((h) => h.id === id)) hits.push({ id, ...say, why });
  };
  const roots = [...(ctx.roots ?? [])];
  const w: Where = {
    roots: roots.length ? roots : ["/__project__"],
    home: ctx.home ?? "/root",
    cwd: roots[0] ?? "/__project__",
    ctx,
  };
  const input = (call.input && typeof call.input === "object" ? call.input : {}) as Record<
    string,
    unknown
  >;
  const name = call.name;
  const protection = PROTECTION_TOOLS[name];
  if (protection) add("critical-protections", protection[0], { action: protection[1] });
  if (name === "bash" && typeof input.command === "string") shellRules(input.command, w, add);
  else if (name.startsWith("ssh_")) remoteRules(input, ctx, add);
  else if (name === "write_file" || name === "edit_file") fileRules(input, name, w, add);
  else if (name === "canvas_edit") editorRules(input, w, add);
  else if (name === "run_script") textRules(JSON.stringify(call.input ?? ""), add);
  if (name.startsWith("mcp__")) {
    const words = toolWords(name);
    if (!words.some((x) => READ_WORDS.has(x))) {
      if (
        words.some((x) => PAY_WORDS.has(x)) ||
        /(place|create|submit)_order|(send|transfer)_(money|funds)|wire_transfer/.test(
          words.join("_"),
        )
      )
        add("critical-payment", `pays or buys through ${name}`, {
          action: "pay-tool",
          target: name,
        });
      if (words.some((x) => DELETE_WORDS.has(x)) && words.some((x) => REPO_WORDS.has(x)))
        add("critical-delete", `deletes for good through ${name}`, {
          action: "service-delete",
          target: name,
        });
    }
    textRules(JSON.stringify(call.input ?? ""), add);
  }
  if (name === "browser_click" && typeof input.name === "string" && PAY_BUTTON.test(input.name))
    add("critical-payment", `presses «${short(input.name)}» in the browser`, {
      action: "pay-button",
      target: short(input.name),
    });
  if (name.startsWith("mail_")) mailRules(name, input, add);
  if (OUTBOUND(name)) outboundRules(call, call.input, w, add);
  return hits;
}

// Finding the files of a source (G36.3): a folder walked in a stable order, the folders nobody
// wants searched left out (`KNOWLEDGE_SKIPPED_DIRS`, the `.open/` copies of conversions), the
// `.gitignore` files followed as git does, links leading outside the folder never followed, and
// files that usually hold secrets never read.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { KNOWLEDGE_SKIPPED_DIRS } from "@redgiant/protocol";
import type { FoundFile, ListOptions } from "./types.js";

/** What one ignore file says about a path: ignored, put back (`!`), or nothing. */
type Verdict = "ignored" | "included" | undefined;

interface Rule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

/** A gitignore glob (already without `!`, the trailing `/` and the anchoring `/`) as a RegExp. */
function globSource(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "\\" && i + 1 < glob.length) {
      re += escapeRe(glob[++i] as string);
    } else if (c === "*") {
      if (glob[i + 1] === "*") {
        const before = i === 0 || glob[i - 1] === "/";
        const after = i + 2 === glob.length || glob[i + 2] === "/";
        if (before && after) {
          i++;
          if (i + 1 === glob.length) {
            // `a/**`: everything inside.
            re += ".*";
          } else {
            // `**/` at the start or `/**/` inside: zero or more folders.
            i++;
            re += "(?:[^/]*/)*";
          }
          continue;
        }
      }
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end < 0) {
        re += "\\[";
        continue;
      }
      let body = glob.slice(i + 1, end);
      let neg = false;
      if (body.startsWith("!") || body.startsWith("^")) {
        neg = true;
        body = body.slice(1);
      }
      body = body.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
      re += `[${neg ? "^/" : ""}${body}]`;
      i = end;
    } else {
      re += escapeRe(c);
    }
  }
  return re;
}

function escapeRe(c: string): string {
  return c.replace(/[.+^${}()|[\]\\*?/]/g, "\\$&");
}

function compileRules(patterns: string[]): Rule[] {
  const rules: Rule[] = [];
  for (const raw of patterns) {
    let p = raw.replace(/\r$/, "");
    // Trailing spaces go, unless escaped.
    p = p.replace(/(?<!\\)\s+$/, "");
    if (!p || p.startsWith("#")) continue;
    let negate = false;
    if (p.startsWith("!")) {
      negate = true;
      p = p.slice(1);
    } else if (p.startsWith("\\!") || p.startsWith("\\#")) {
      p = p.slice(1);
    }
    let dirOnly = false;
    if (p.endsWith("/") && !p.endsWith("\\/")) {
      dirOnly = true;
      p = p.replace(/\/+$/, "");
    }
    if (!p) continue;
    // A slash at the start or in the middle ties the pattern to the folder of the file.
    const anchored = p.includes("/");
    if (p.startsWith("/")) p = p.slice(1);
    if (!p) continue;
    const body = globSource(p);
    const re = new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`);
    rules.push({ re, negate, dirOnly });
  }
  return rules;
}

/** The verdict of one list of rules on a path relative to their folder: the last match wins. */
function judge(rules: Rule[], rel: string, isDir: boolean): Verdict {
  let v: Verdict;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(rel)) v = r.negate ? "included" : "ignored";
  }
  return v;
}

function under(base: string | undefined, rel: string): string | undefined {
  const b = (base ?? "").replace(/^\/+|\/+$/g, "");
  if (!b) return rel;
  return rel.startsWith(`${b}/`) ? rel.slice(b.length + 1) : undefined;
}

/**
 * A `.gitignore` as a function: true when the path (relative to the root, with `/`) is left
 * out. `base` is the folder (relative to the root) the patterns were written in. As in git, a
 * file inside an ignored folder stays out even when a later `!` names it.
 */
export function compileIgnore(
  patterns: string[],
  base?: string,
): (rel: string, isDir: boolean) => boolean {
  const rules = compileRules(patterns);
  return (rel, isDir) => {
    const path = under(base, rel.replace(/\\/g, "/").replace(/^\.\/|\/+$/g, ""));
    if (path === undefined || !path) return false;
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      if (judge(rules, segments.slice(0, i).join("/"), true) === "ignored") return true;
    }
    return judge(rules, path, isDir) === "ignored";
  };
}

/**
 * Files that usually hold secrets or keys: never read, whatever the source and its patterns say
 * (an index is searched by agents; a key must never end up in it).
 */
const SECRET_PATTERNS = [
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "*.kdbx",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "*.rgkeychain",
  "keychain.enc",
  "master.dpapi",
  "secrets.json",
  "postgres.json",
  "credentials.json",
];
const secretRules = compileRules(SECRET_PATTERNS);

/** True for a file name that is kept out because it may hold a secret. */
export function isSecretFile(name: string): boolean {
  return judge(secretRules, name, false) === "ignored";
}

const SKIPPED = new Set<string>(KNOWLEDGE_SKIPPED_DIRS);

interface Layer {
  base: string;
  rules: Rule[];
}

function decide(layers: Layer[], user: Rule[], rel: string, isDir: boolean): boolean {
  // The person's own patterns first, then the deepest `.gitignore` up to the root.
  const own = judge(user, rel, isDir);
  if (own) return own === "ignored";
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i] as Layer;
    const path = under(l.base, rel);
    if (path === undefined) continue;
    const v = judge(l.rules, path, isDir);
    if (v) return v === "ignored";
  }
  return false;
}

function abortError(): Error {
  const e = new Error("The scan was stopped");
  e.name = "AbortError";
  return e;
}

/**
 * Every file of a folder worth reading, in a stable order (names compared as strings, folders
 * walked depth first). Symbolic links are followed only to files inside the folder; linked
 * folders are left out (they would repeat what is already walked, or leave the folder).
 */
export async function* listFiles(root: string, o: ListOptions = {}): AsyncGenerator<FoundFile> {
  const rootReal = await realpath(root);
  const user = compileRules(o.exclude ?? []);
  const maxFiles = o.maxFiles ?? 200_000;
  const gitignore = o.gitignore !== false;
  let count = 0;
  const inside = (p: string) =>
    p === rootReal || p.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep);

  async function* walk(dir: string, rel: string, layers: Layer[]): AsyncGenerator<FoundFile> {
    if (o.signal?.aborted) throw abortError();
    let here = layers;
    if (gitignore) {
      const text = await readFile(join(dir, ".gitignore"), "utf8").catch(() => undefined);
      if (text !== undefined)
        here = [...layers, { base: rel, rules: compileRules(text.split("\n")) }];
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (count >= maxFiles) return;
      if (o.signal?.aborted) throw abortError();
      const abs = join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIPPED.has(e.name) || e.name.endsWith(".open")) continue;
        if (decide(here, user, childRel, true)) continue;
        yield* walk(abs, childRel, here);
        continue;
      }
      let size: number;
      let mtimeMs: number;
      if (e.isSymbolicLink()) {
        const target = await realpath(abs).catch(() => undefined);
        if (!target || !inside(target)) continue;
        const s = await stat(target).catch(() => undefined);
        if (!s?.isFile()) continue;
        size = s.size;
        mtimeMs = s.mtimeMs;
      } else if (e.isFile()) {
        const s = await lstat(abs).catch(() => undefined);
        if (!s) continue;
        size = s.size;
        mtimeMs = s.mtimeMs;
      } else continue;
      if (e.name === ".gitignore" || isSecretFile(e.name)) continue;
      if (decide(here, user, childRel, false)) continue;
      count++;
      yield { rel: childRel, abs, size, mtimeMs };
    }
  }

  yield* walk(root, "", []);
}

/** sha256 of a file's bytes (hex), read as a stream. */
export async function hashFile(abs: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/**
 * True when the bytes look like a binary file: a NUL in the first 8 KB (text with a UTF-16
 * byte order mark excepted), or many control characters.
 */
export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  if (n >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)))
    return false;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i] as number;
    if (b === 0) return true;
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) control++;
  }
  return n > 0 && control / n > 0.1;
}

/** A path relative to a root with `/`, whatever the system. */
export function relPath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

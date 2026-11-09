/// <reference types="node" />
// The licences of what the page carries (G37.1, plan G37: «Licenze compatibili con MIT per tutto
// ciò che si incorpora»). Every package the web UI depends on at run time (and theirs, all the way
// down) may end up in the bundle: each must be MIT-compatible (MIT, Apache-2.0, BSD, ISC, Zlib,
// public domain). MPL-2.0 is file-level copyleft: only packages loaded apart (their own files,
// never mixed into ours) may be MPL-2.0 alone. GPL, AGPL and LGPL, or a licence nobody can read,
// fail. An expression with OR passes when one side does; with AND when both do.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Licences compatible with MIT for code carried in the bundle. */
const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "Apache-2.0",
  "BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Zlib",
  "CC0-1.0",
  "Unlicense",
  "BlueOak-1.0.0",
  "Python-2.0",
]);
/** Packages loaded apart from the bundle (an iframe, a download): MPL-2.0 is fine there. */
const LOADED_APART = new Set<string>([]);
const COPYLEFT = /^(A|L)?GPL/i;

type Verdict = { ok: true } | { ok: false; why: string };

/** Whether a package's `license` field lets it be carried in the bundle (pure, tested below). */
export function licenseVerdict(license: unknown, name: string): Verdict {
  if (typeof license !== "string" || !license.trim())
    return { ok: false, why: `${name}: no licence written` };
  const tokens = license.replace(/[()]/g, " $& ").trim().split(/\s+/);
  let i = 0;
  const single = (id: string): Verdict => {
    const clean = id.replace(/\+$/, "");
    if (COPYLEFT.test(clean)) return { ok: false, why: `${name}: ${clean} (copyleft)` };
    if (clean === "MPL-2.0")
      return LOADED_APART.has(name)
        ? { ok: true }
        : { ok: false, why: `${name}: MPL-2.0 must be loaded apart, not bundled` };
    return ALLOWED.has(clean)
      ? { ok: true }
      : { ok: false, why: `${name}: unknown licence ${clean}` };
  };
  const term = (): Verdict => {
    const tk = tokens[i++];
    if (tk === "(") {
      const v = or();
      i++; // ")"
      return v;
    }
    if (!tk || tk === ")") return { ok: false, why: `${name}: unreadable licence «${license}»` };
    return single(tk);
  };
  const and = (): Verdict => {
    let v = term();
    while (tokens[i]?.toUpperCase() === "AND") {
      i++;
      const w = term();
      if (v.ok && !w.ok) v = w;
    }
    return v;
  };
  function or(): Verdict {
    let v = and();
    while (tokens[i]?.toUpperCase() === "OR") {
      i++;
      const w = and();
      if (!v.ok && w.ok) v = w;
    }
    return v;
  }
  const v = or();
  return i < tokens.length ? { ok: false, why: `${name}: unreadable licence «${license}»` } : v;
}

/** A package's folder from another's, as Node resolves it (pnpm's links followed). */
function find(from: string, name: string): string | undefined {
  let d = from;
  for (;;) {
    const c = join(d, "node_modules", name, "package.json");
    if (existsSync(c)) return realpathSync(c);
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

/** Every package the web UI needs at run time, with its licence (devDependencies left out). */
function runtimePackages(): Map<string, unknown> {
  const seen = new Map<string, unknown>();
  const walk = (pj: string) => {
    const p = JSON.parse(readFileSync(pj, "utf8")) as {
      name: string;
      version: string;
      license?: unknown;
      licenses?: { type?: string }[];
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const key = `${p.name}@${p.version}`;
    if (seen.has(key)) return;
    seen.set(key, p.license ?? p.licenses?.map((l) => l.type).join(" OR "));
    for (const n of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) {
      const c = find(dirname(pj), n);
      // An optional dependency not installed here is not carried.
      if (c) walk(c);
      else if (!p.optionalDependencies?.[n]) throw new Error(`${p.name} needs ${n}, not found`);
    }
  };
  walk(realpathSync(fileURLToPath(new URL("../package.json", import.meta.url))));
  return seen;
}

describe("licenses of the web bundle (G37.1)", () => {
  it.each([
    ["MIT", true],
    ["(MPL-2.0 OR Apache-2.0)", true],
    ["(MIT OR GPL-3.0-or-later)", true],
    ["(MIT AND Zlib)", true],
    ["BSD", true],
    ["CC0-1.0", true],
    ["GPL-3.0", false],
    ["AGPL-3.0-only", false],
    ["LGPL-2.1+", false],
    ["MPL-2.0", false],
    ["(MIT AND LGPL-3.0)", false],
    ["SEE LICENSE IN LICENSE.txt", false],
    ["", false],
  ] as const)("%s → %s", (license, ok) => {
    expect(licenseVerdict(license, "pkg").ok).toBe(ok);
  });

  it("every package the page carries has a licence compatible with MIT", () => {
    const pkgs = runtimePackages();
    expect(pkgs.size).toBeGreaterThan(20);
    const bad = [...pkgs]
      .map(([name, license]) => licenseVerdict(license, name))
      .filter((v): v is { ok: false; why: string } => !v.ok)
      .map((v) => v.why);
    expect(bad).toEqual([]);
    // The editor's engine is among them (G37.1).
    expect([...pkgs.keys()].some((k) => k.startsWith("@codemirror/state@"))).toBe(true);
    // The sheet editor (G37.3): Univer's free packages only, never its paid ones.
    expect([...pkgs.keys()].some((k) => k.startsWith("@univerjs/sheets-ui@"))).toBe(true);
    expect([...pkgs.keys()].filter((k) => k.startsWith("@univerjs-pro/"))).toEqual([]);
  });

  it("the document editor's frame carries only zetajs (MIT) and our own scripts (G37.4)", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "zeta");
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["frame.html", "frame.js", "office-thread.js", "zeta.js"]);
    expect(readFileSync(join(dir, "zeta.js"), "utf8").slice(0, 200)).toContain(
      "SPDX-License-Identifier: MIT",
    );
    // LibreOffice itself (MPL-2.0, Qt LGPL-3.0) is never in the package: the server downloads it.
    expect(files.some((f) => /\.(wasm|data)$/.test(f))).toBe(false);
  });
});

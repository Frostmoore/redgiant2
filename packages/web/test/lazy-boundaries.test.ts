// What the first page load may hold (3.5.11): the page starts from main.tsx; editors, Settings and
// heavy libraries come only through `import()`. This walks the static imports (re-exports
// included, type-only ones not) and fails when a heavy module becomes part of the first load.
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("../src", import.meta.url));

/** Static (not type-only, not dynamic) import and re-export specifiers of a file. */
export function staticImports(code: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;
  for (const m of code.matchAll(re)) if (m[1]) out.push(m[1]);
  return out;
}

function resolveLocal(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec).replace(/\.js$/, "");
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"])
    if (existsSync(base + ext)) return base + ext;
  return undefined;
}

/** Every file and package the first load reaches, with the chain that reaches it. */
function firstLoad() {
  const parent = new Map<string, string | null>();
  const packages = new Map<string, string>();
  const queue: [string, string | null][] = [[resolve(src, "main.tsx"), null]];
  while (queue.length) {
    const [file, from] = queue.shift() as [string, string | null];
    if (parent.has(file)) continue;
    parent.set(file, from);
    for (const spec of staticImports(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) {
        const r = resolveLocal(file, spec);
        if (r) queue.push([r, file]);
      } else if (!packages.has(spec)) packages.set(spec, file);
    }
  }
  const chain = (file: string) => {
    const names: string[] = [];
    for (let f: string | null | undefined = file; f; f = parent.get(f))
      names.push(relative(src, f));
    return names.reverse().join(" -> ");
  };
  return { files: [...parent.keys()], packages, chain };
}

const HEAVY_PACKAGES =
  /^(@codemirror\/|codemirror$|@lezer\/|@univerjs\/|react$|react-dom|pdfjs-dist|three($|\/)|@svgedit\/|xlsx$|mammoth|@xterm\/|fflate|yaml$)/;
const HEAVY_FILES = [
  "components/Canvas.tsx",
  "components/Settings.tsx",
  "components/Setup.tsx",
  "components/TerminalView.tsx",
  "components/Hierarchy.tsx",
  "components/Board.tsx",
];

describe("first load (3.5.11)", () => {
  it("reads static imports and re-exports, not type-only or dynamic ones", () => {
    expect(
      staticImports(
        [
          'import { a } from "./a.js";',
          'import type { B } from "./b.js";',
          'export { c } from "./c.js";',
          'export type { D } from "./d.js";',
          'import "./e.css";',
          'const f = () => import("./f.js");',
          'import {\n  g,\n  h,\n} from "g-pkg";',
        ].join("\n"),
      ),
    ).toEqual(["./a.js", "./c.js", "./e.css", "g-pkg"]);
  });

  it("holds no editor library", () => {
    const { packages, chain } = firstLoad();
    const heavy = [...packages.entries()]
      .filter(([p]) => HEAVY_PACKAGES.test(p))
      .map(([p, f]) => `${p} via ${chain(f)}`);
    expect(heavy).toEqual([]);
  });

  it("holds neither the canvas and its editors nor Settings and the other pages", () => {
    const { files, chain } = firstLoad();
    const found = files
      .filter((f) => {
        const r = relative(src, f);
        return (
          HEAVY_FILES.includes(r) ||
          /^components\/viewers\/\w+(Editor|View)\.tsx$/.test(r) ||
          /-island\.ts$/.test(r)
        );
      })
      .map(chain);
    expect(found).toEqual([]);
  });

  it("still loads those through import()", () => {
    const app = readFileSync(resolve(src, "components/App.tsx"), "utf8");
    const side = readFileSync(resolve(src, "components/SideArea.tsx"), "utf8");
    expect(app).toMatch(/import\("\.\/Settings\.js"\)/);
    expect(side).toMatch(/import\("\.\/Canvas\.js"\)/);
    expect(side).toMatch(/import\("\.\/TerminalView\.js"\)/);
  });
});

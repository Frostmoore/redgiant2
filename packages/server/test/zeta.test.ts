// ZetaOffice's sources (3.5.2): tried in order (the administrator's mirror, our pre-release, the
// CDN), each file kept only when its sha256 is the known one; and the workflow's script reads the
// same list and licences from zeta.ts.
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { licensesFrom, versionFrom, zetaFilesFrom } from "../../../packaging/zetaoffice/fetch.mjs";
import {
  sourceRequest,
  ZETA_CDN,
  ZETA_FILES,
  ZETA_LICENSES,
  ZETA_RELEASE,
  ZETA_VERSION,
  type ZetaFetch,
  type ZetaFile,
  ZetaOffice,
  zetaSources,
} from "../src/editor/zeta.js";
import type { Jobs } from "../src/jobs.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const GOOD = Buffer.from("the build RedGiant knows");
const OTHER = Buffer.from("another build of the same file");
const WASM: ZetaFile = {
  name: "soffice.wasm",
  encoding: "br",
  sha256: sha(GOOD),
  size: GOOD.length,
  type: "application/wasm",
};

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("zetaSources", () => {
  it.each([
    [{}, ["redgiant", "zetaoffice"]],
    [
      { REDGIANT_ZETAOFFICE_MIRROR: "https://mirror.example/zeta/" },
      ["mirror", "redgiant", "zetaoffice"],
    ],
    [{ REDGIANT_ZETAOFFICE_MIRROR: "  " }, ["redgiant", "zetaoffice"]],
  ])("%j → %j", (env, names) => {
    const s = zetaSources(env as NodeJS.ProcessEnv);
    expect(s.map((x) => x.name)).toEqual(names);
    expect(s.at(-2)?.base).toBe(ZETA_RELEASE);
    expect(s.at(-1)?.base).toBe(ZETA_CDN);
    for (const x of s) expect(x.base.endsWith("/")).toBe(false);
  });

  it("asks our copy for the stored bytes and the CDN for the encoding", () => {
    const [ours, cdn] = zetaSources({});
    expect(sourceRequest(ours as never, WASM)).toEqual({
      url: `${ZETA_RELEASE}/soffice.wasm.br`,
      encoding: "identity",
    });
    expect(sourceRequest(cdn as never, WASM)).toEqual({
      url: `${ZETA_CDN}/soffice.wasm`,
      encoding: "br",
    });
    const js = ZETA_FILES.find((f) => f.name === "soffice.js") as ZetaFile;
    expect(sourceRequest(ours as never, js).url).toBe(`${ZETA_RELEASE}/soffice.js`);
  });
});

describe("ZetaOffice.fetchFile", () => {
  async function setup(answers: Record<string, Buffer | Error>) {
    const dir = await mkdtemp(join(tmpdir(), "rg-zeta-"));
    dirs.push(dir);
    const asked: string[] = [];
    const fetch: ZetaFetch = async (req, progress) => {
      asked.push(`${req.url} ${req.encoding}`);
      const a = answers[req.url];
      if (!a || a instanceof Error) throw a ?? new Error("404");
      progress(a.length);
      await writeFile(req.to, a);
    };
    const zeta = new ZetaOffice({
      dataDir: dir,
      jobs: {} as Jobs,
      fetch,
      files: [WASM],
      sources: zetaSources({ REDGIANT_ZETAOFFICE_MIRROR: "https://mirror.example" }),
    });
    let bar = 0;
    const target = join(dir, "soffice.wasm.br");
    const run = () => zeta.fetchFile(WASM, target, (n) => (bar += n), new AbortController().signal);
    return { dir, asked, run, target, bar: () => bar };
  }

  it("takes the first source that gives the known file", async () => {
    const t = await setup({ [`${ZETA_RELEASE}/soffice.wasm.br`]: GOOD });
    expect(await t.run()).toBe("redgiant");
    expect(t.asked).toEqual([
      "https://mirror.example/soffice.wasm br",
      `${ZETA_RELEASE}/soffice.wasm.br identity`,
    ]);
    expect(await readFile(t.target)).toEqual(GOOD);
    expect(t.bar()).toBe(GOOD.length);
  });

  it("skips a source with another build, its bytes taken off the bar and never kept", async () => {
    const t = await setup({
      "https://mirror.example/soffice.wasm": OTHER,
      [`${ZETA_RELEASE}/soffice.wasm.br`]: new Error("answered 404"),
      [`${ZETA_CDN}/soffice.wasm`]: GOOD,
    });
    expect(await t.run()).toBe("zetaoffice");
    expect(t.asked).toHaveLength(3);
    expect(t.bar()).toBe(GOOD.length);
    expect(await readdir(t.dir)).toEqual(["soffice.wasm.br"]);
  });

  it("fails when no source has the known file, keeping nothing", async () => {
    const t = await setup({
      "https://mirror.example/soffice.wasm": OTHER,
      [`${ZETA_CDN}/soffice.wasm`]: OTHER,
    });
    await expect(t.run()).rejects.toThrow(
      /no source gave it \(mirror: .*not the file RedGiant knows.*; redgiant: 404; zetaoffice: .*not the file/,
    );
    expect(await readdir(t.dir)).toEqual([]);
    expect(t.bar()).toBe(0);
  });
});

describe("packaging/zetaoffice/fetch.mjs", () => {
  it("reads the same files, version and licences as zeta.ts", async () => {
    const src = await readFile(new URL("../src/editor/zeta.ts", import.meta.url), "utf8");
    expect(versionFrom(src)).toBe(ZETA_VERSION);
    expect(licensesFrom(src)).toBe(ZETA_LICENSES);
    expect(zetaFilesFrom(src)).toEqual(
      ZETA_FILES.map(({ type: _type, ...f }) => ({
        ...f,
        stored: f.encoding === "br" ? `${f.name}.br` : f.name,
      })),
    );
    expect(ZETA_LICENSES).toMatch(/MPL-2\.0/);
    expect(ZETA_LICENSES).toMatch(/LGPL-3\.0/);
    expect(ZETA_LICENSES).toMatch(/zetaoffice-cache/);
  });

  it("refuses a list it cannot read", () => {
    expect(() => zetaFilesFrom('export const ZETA_FILES = [\n  { name: "x" },\n];')).toThrow(
      /cannot be read/,
    );
  });
});

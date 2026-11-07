// Differential updates (G36.18): the zip and manifest pack.mjs makes, the plan the launcher
// follows (the same rules as Delta.cs), and the manifest's signature.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript, no types
import { checkManifest, packTree, plan, readEntry, sha256 } from "../pack.mjs";
// @ts-expect-error plain JavaScript, no types
import { checkSignature, dotnetXml, signManifest } from "../sign.mjs";

type Entry = { path: string; sha256: string; offset: number; csize: number; size: number };
type Manifest = {
  version: string;
  files: Entry[];
  roots: string[];
  archive: { size: number; sha256: string };
};

function tree(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "rg-pack-"));
  for (const [p, data] of Object.entries(files)) {
    const full = join(root, ...p.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }
  return root;
}

function pack(files: Record<string, string | Buffer>, version: string) {
  const root = tree(files);
  const zip = join(root, "..", `${version}-${Math.random().toString(36).slice(2)}.zip`);
  const m: Manifest = packTree(root, zip, { version, platform: "win-x64" });
  return { m, zip, root };
}

// Bytes that do not compress, as node.exe and native modules mostly are (made once: the trees
// below share them).
const noise = (n: number) => randomBytes(n);

const v1 = {
  "RedGiant.exe": "launcher 1",
  "node/node.exe": noise(400_000),
  "server/dist/main.js": "console.log(1)",
  "server/dist/gone.js": "only in 1",
  "server/node_modules/big/index.js": noise(600_000),
  "web/index.html": "<html>1</html>",
};
const v2 = { ...v1, "server/dist/main.js": "console.log(2)", "web/index.html": "<html>2</html>" };
const v3 = {
  ...v2,
  "RedGiant.exe": "launcher 3",
  "server/dist/gone.js": undefined,
  "web/assets/new.js": "new in 3",
};
const clean = (o: Record<string, string | Buffer | undefined>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<
    string,
    string | Buffer
  >;

describe("pack.mjs", () => {
  it("writes a zip whose every entry reads back from its offset alone", () => {
    const { m, zip } = pack(v1, "1.0.0");
    checkManifest(m);
    expect(m.roots).toEqual(["RedGiant.exe", "node", "server", "web"]);
    expect(m.files.map((f) => f.path)).toEqual([...m.files.map((f) => f.path)].sort());
    for (const f of m.files) expect(sha256(readEntry(zip, f))).toBe(f.sha256);
    const bytes = readFileSync(zip);
    expect(bytes.length).toBe(m.archive.size);
    expect(sha256(bytes)).toBe(m.archive.sha256);
    // A real zip: its end record counts the entries and points at the central directory.
    const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(bytes.readUInt16LE(end + 10)).toBe(m.files.length);
    expect(bytes.readUInt32LE(bytes.readUInt32LE(end + 16))).toBe(0x02014b50);
  });

  it("is reproducible: the same files give the same bytes", () => {
    expect(pack(v1, "1.0.0").m.archive.sha256).toBe(pack(v1, "1.0.0").m.archive.sha256);
  });

  it("refuses manifests the launcher would refuse", () => {
    const { m } = pack(v1, "1.0.0");
    for (const bad of ["../x", "/x", "a\\b", "a//b", "C:/x", "web/./x"]) {
      const copy = structuredClone(m);
      copy.files[0].path = bad;
      expect(() => checkManifest(copy), bad).toThrow();
    }
    const twice = structuredClone(m);
    twice.files[1].path = twice.files[0].path.toUpperCase();
    expect(() => checkManifest(twice)).toThrow(/twice/);
    expect(() => checkManifest({ ...m, format: 2 })).toThrow(/format/);
  });
});

describe("plan", () => {
  it("downloads only what differs, in few requests", () => {
    const old = pack(v1, "1.0.0").m;
    const next = pack(v2, "2.0.0").m;
    const p = plan(next, new Map(old.files.map((f) => [f.path, f.sha256])));
    expect(p.fetch.map((f: Entry) => f.path).sort()).toEqual([
      "server/dist/main.js",
      "web/index.html",
    ]);
    expect(p.keep).toBe(4);
    // node.exe and the big module are untouched: a tiny part of the zip.
    expect(p.bytes).toBeLessThan(next.archive.size / 50);
    expect(p.runs.length).toBe(2);
  });

  it("joins runs closer than the gap and keeps far ones apart", () => {
    const m = {
      files: [
        { path: "a", sha256: "1", offset: 0, csize: 10 },
        { path: "b", sha256: "2", offset: 20, csize: 10 },
        { path: "c", sha256: "3", offset: 1000, csize: 10 },
      ],
    };
    expect(
      plan(m, new Map(), 16).runs.map((r: { start: number; end: number }) => [r.start, r.end]),
    ).toEqual([
      [0, 30],
      [1000, 1010],
    ]);
    expect(plan(m, new Map(), 5000).runs).toHaveLength(1);
  });

  it("skips versions: from 1 or 2 straight to 3, by the files there", () => {
    const one = pack(v1, "1.0.0").m;
    const two = pack(v2, "2.0.0").m;
    const three = pack(clean(v3), "3.0.0").m;
    const from = (m: Manifest) => plan(three, new Map(m.files.map((f) => [f.path, f.sha256])));
    expect(
      from(one)
        .fetch.map((f: Entry) => f.path)
        .sort(),
    ).toEqual(["RedGiant.exe", "server/dist/main.js", "web/assets/new.js", "web/index.html"]);
    expect(
      from(two)
        .fetch.map((f: Entry) => f.path)
        .sort(),
    ).toEqual(["RedGiant.exe", "web/assets/new.js"]);
    // Nothing installed: everything.
    expect(plan(three, new Map()).fetch).toHaveLength(three.files.length);
  });
});

describe("signature", () => {
  it("signs as the launcher checks, and gives .NET's XML of the public key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const data = Buffer.from('{"format":1}');
    const sig = signManifest(data, pem);
    expect(checkSignature(data, sig, publicKey.export({ type: "spki", format: "pem" }))).toBe(true);
    expect(
      checkSignature(
        Buffer.from('{"format":2}'),
        sig,
        publicKey.export({ type: "spki", format: "pem" }),
      ),
    ).toBe(false);
    expect(dotnetXml(pem)).toMatch(
      /^<RSAKeyValue><Modulus>[A-Za-z0-9+/]+=*<\/Modulus><Exponent>AQAB<\/Exponent><\/RSAKeyValue>$/,
    );
  });
});

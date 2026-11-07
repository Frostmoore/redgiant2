import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqlClient } from "@redgiant/events";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  downloadedPgvectorDir,
  downloadPgvector,
  enableVector,
  indexBuildSettings,
  indexBuildSql,
  PGVECTOR_VERSION,
  pgvectorAsset,
  pgvectorConf,
  pgvectorDir,
  writePgvectorConf,
} from "../src/knowledge/pgvector.js";
import { memoryDb } from "./pglite.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "rg-pgvector-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A pgvector folder for a system: the library and the control file. */
async function fakePgvector(dir: string, lib = "vector.so") {
  await mkdir(join(dir, "lib"), { recursive: true });
  await mkdir(join(dir, "share", "extension"), { recursive: true });
  await writeFile(join(dir, "lib", lib), "lib");
  await writeFile(join(dir, "share", "extension", "vector.control"), "default_version = '0.8.7'");
}

describe("pgvectorConf", () => {
  it("points Postgres to the folder with its own folders after, : on Linux and the Mac", () => {
    expect(pgvectorConf("/opt/rg/pgvector", "linux")).toContain(
      "extension_control_path = '/opt/rg/pgvector/share:$system'",
    );
    expect(pgvectorConf("/opt/rg/pgvector/", "darwin")).toContain(
      "dynamic_library_path = '/opt/rg/pgvector/lib:$libdir'",
    );
  });

  it("uses ; and forward slashes on Windows (a backslash would be an escape in the file)", () => {
    const c = pgvectorConf(
      "C:\\Users\\Mario Rossi\\AppData\\Local\\RedGiant\\server\\pgvector",
      "win32",
    );
    expect(c).toContain(
      "extension_control_path = 'C:/Users/Mario Rossi/AppData/Local/RedGiant/server/pgvector/share;$system'",
    );
    expect(c).toContain(
      "dynamic_library_path = 'C:/Users/Mario Rossi/AppData/Local/RedGiant/server/pgvector/lib;$libdir'",
    );
    expect(c).not.toContain("\\");
  });

  it("doubles quotes in the path", () => {
    expect(pgvectorConf("/home/o'brien/rg", "linux")).toContain(
      "'/home/o''brien/rg/share:$system'",
    );
  });
});

describe("writePgvectorConf", () => {
  it("adds the include once to an existing cluster and rewrites redgiant.conf each time", async () => {
    const cluster = join(tmp, "cluster");
    await mkdir(cluster, { recursive: true });
    const before = "# made by initdb\nmax_connections = 100\nshared_buffers = 128MB";
    await writeFile(join(cluster, "postgresql.conf"), before);
    await writePgvectorConf(cluster, undefined, "linux");
    expect(await readFile(join(cluster, "redgiant.conf"), "utf8")).not.toContain(
      "extension_control_path",
    );
    await writePgvectorConf(cluster, "/a/pgvector", "linux");
    await writePgvectorConf(cluster, "/b/pgvector", "linux");
    const main = await readFile(join(cluster, "postgresql.conf"), "utf8");
    expect(main.startsWith(before)).toBe(true);
    expect(main.match(/include_if_exists = 'redgiant.conf'/g)).toHaveLength(1);
    const ours = await readFile(join(cluster, "redgiant.conf"), "utf8");
    expect(ours).toContain("'/b/pgvector/share:$system'");
    expect(ours).not.toContain("/a/");
    expect(existsSync(join(cluster, "redgiant.conf.tmp"))).toBe(false);
  });
});

describe("pgvectorDir", () => {
  it("looks at REDGIANT_PGVECTOR_DIR, then next to the server, then the download", async () => {
    const root = join(tmp, "dirs");
    const own = join(root, "own");
    const server = join(root, "server");
    const data = join(root, "data");
    expect(pgvectorDir({ dataDir: data, env: {}, serverDir: server, platform: "linux" })).toBe(
      undefined,
    );
    await fakePgvector(downloadedPgvectorDir(data));
    expect(pgvectorDir({ dataDir: data, env: {}, serverDir: server, platform: "linux" })).toBe(
      downloadedPgvectorDir(data),
    );
    await fakePgvector(join(server, "pgvector"));
    expect(pgvectorDir({ dataDir: data, env: {}, serverDir: server, platform: "linux" })).toBe(
      join(server, "pgvector"),
    );
    await fakePgvector(own);
    const env = { REDGIANT_PGVECTOR_DIR: own };
    expect(pgvectorDir({ dataDir: data, env, serverDir: server, platform: "linux" })).toBe(own);
    // A folder without this system's library does not count.
    expect(pgvectorDir({ dataDir: data, env, serverDir: server, platform: "win32" })).toBe(
      undefined,
    );
    expect(downloadedPgvectorDir(data)).toBe(
      join(data, "tools", "pgvector", `${PGVECTOR_VERSION}-pg18`),
    );
  });
});

describe("pgvectorAsset", () => {
  it.each([
    ["linux", "x64", `pgvector-${PGVECTOR_VERSION}-pg18-linux-x64.zip`],
    ["linux", "arm64", `pgvector-${PGVECTOR_VERSION}-pg18-linux-arm64.zip`],
    ["win32", "x64", `pgvector-${PGVECTOR_VERSION}-pg18-windows-x64.zip`],
    ["darwin", "arm64", `pgvector-${PGVECTOR_VERSION}-pg18-macos-universal.zip`],
    ["darwin", "x64", `pgvector-${PGVECTOR_VERSION}-pg18-macos-universal.zip`],
    ["linux", "ia32", undefined],
    ["freebsd", "x64", undefined],
  ])("%s %s → %s", (platform, arch, want) => {
    expect(pgvectorAsset(platform, arch)).toBe(want);
  });
});

describe("indexBuildSettings", () => {
  it.each([
    // free memory, cores, shared memory → maintenance_work_mem, workers
    [1 * GB, 2, undefined, "256MB", 0],
    [128 * MB, 1, undefined, "64MB", 0],
    [8 * GB, 4, undefined, "2GB", 2],
    [32 * GB, 24, undefined, "4GB", 4],
    [64 * GB, 8, undefined, "4GB", 4],
    // Docker: the parallel build's graph must fit in the database's /dev/shm.
    [32 * GB, 8, 1 * GB, "768MB", 4],
    [32 * GB, 2, 64 * MB, "4GB", 0],
  ])("%d bytes free, %d cores, shm %s → %s, %d workers", (free, cores, shm, mem, workers) => {
    expect(
      indexBuildSettings({
        freeBytes: free,
        cores,
        ...(shm !== undefined && { sharedMemoryBytes: shm }),
      }),
    ).toEqual({ maintenanceWorkMem: mem, workers });
  });

  it("gives SQL for the building transaction, never anything but the size", () => {
    expect(indexBuildSql({ maintenanceWorkMem: "2GB'; DROP TABLE x; --", workers: 3.7 })).toEqual([
      "SET LOCAL maintenance_work_mem = '2GBDROPTABLEx'",
      "SET LOCAL max_parallel_maintenance_workers = 3",
    ]);
  });
});

describe("enableVector", () => {
  it("turns pgvector on in PGlite (0.8.7, the same as the native builds)", async () => {
    const { db } = await memoryDb();
    expect(await enableVector(db)).toEqual({ ok: true, version: "0.8.7" });
    // Twice is fine (every start does it).
    expect(await enableVector(db)).toEqual({ ok: true, version: "0.8.7" });
    const [row] = await db.query<{ d: number }>(
      "SELECT '[1,0,0]'::halfvec <=> '[0,1,0]'::halfvec AS d",
    );
    expect(row?.d).toBeCloseTo(1);
  });

  it("says why when the extension is missing, without throwing", async () => {
    const failing: SqlClient = {
      query: async () => {
        throw new Error('extension "vector" is not available');
      },
      transaction: (fn) => fn(failing),
    };
    expect(await enableVector(failing)).toEqual({
      ok: false,
      reason: 'extension "vector" is not available',
    });
  });
});

describe("downloadPgvector", () => {
  let server: Server;
  let base: string;
  const files = new Map<string, Buffer>();
  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = files.get(req.url ?? "");
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-length": body.length }).end(body);
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  const zipOf = (entries: Record<string, string>) =>
    Buffer.from(
      zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, Buffer.from(v)]))),
    );
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const asset = `/pgvector-${PGVECTOR_VERSION}-pg18-linux-x64.zip`;

  it("downloads with its bar, checks the sha256 and unpacks lib/ and share/extension/", async () => {
    const zip = zipOf({
      "lib/vector.so": "so",
      "share/extension/vector.control": "control",
      "share/extension/vector--0.8.7.sql": "sql",
    });
    files.set(asset, zip);
    const data = join(tmp, "dl1");
    const seen: [number, number | null][] = [];
    const dir = await downloadPgvector(
      data,
      (d, t) => seen.push([d, t]),
      new AbortController().signal,
      {
        platform: "linux",
        arch: "x64",
        base,
        sha256: { "linux-x64": sha(zip) },
      },
    );
    expect(dir).toBe(downloadedPgvectorDir(data));
    expect(await readFile(join(dir, "share", "extension", "vector--0.8.7.sql"), "utf8")).toBe(
      "sql",
    );
    expect(seen.at(-1)).toEqual([zip.length, zip.length]);
    expect(
      pgvectorDir({ dataDir: data, env: {}, serverDir: join(tmp, "none"), platform: "linux" }),
    ).toBe(dir);
  });

  it("refuses a zip whose sha256 is not the one in the code", async () => {
    files.set(asset, zipOf({ "lib/vector.so": "other", "share/extension/vector.control": "c" }));
    await expect(
      downloadPgvector(join(tmp, "dl2"), () => {}, new AbortController().signal, {
        platform: "linux",
        arch: "x64",
        base,
        sha256: { "linux-x64": "0".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "pgvector_checksum" });
    expect(existsSync(downloadedPgvectorDir(join(tmp, "dl2")))).toBe(false);
  });

  it("refuses files outside lib/ and share/extension/", async () => {
    const zip = zipOf({
      "lib/vector.so": "so",
      "share/extension/vector.control": "c",
      "../evil.sh": "x",
    });
    files.set(asset, zip);
    await expect(
      downloadPgvector(join(tmp, "dl3"), () => {}, new AbortController().signal, {
        platform: "linux",
        arch: "x64",
        base,
        sha256: { "linux-x64": sha(zip) },
      }),
    ).rejects.toMatchObject({ code: "pgvector_checksum" });
  });

  it("downloads nothing for a system whose hash is not known yet", async () => {
    await expect(
      downloadPgvector(join(tmp, "dl4"), () => {}, new AbortController().signal, {
        platform: "linux",
        arch: "arm64",
        base,
        sha256: {},
      }),
    ).rejects.toMatchObject({ code: "pgvector_unavailable" });
  });
});

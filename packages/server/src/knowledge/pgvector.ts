// pgvector for RedGiant's own Postgres (G36.1, study_g36_vector.md sections 4.7 and 8). The
// embedded Postgres 18 loads it from a folder of ours, never from inside `node_modules` or the
// installation: `extension_control_path` and `dynamic_library_path`, written into a small
// `redgiant.conf` the cluster's `postgresql.conf` includes. The folder comes with the installers
// (Windows, Mac: `server/pgvector`), or is downloaded once with its bar (Linux, a source install)
// from the `pgvector-cache` pre-release, its sha256 fixed here. Docker runs Postgres 17 from our
// image with pgvector inside (`docker/postgres.Dockerfile`); tests use PGlite's own pgvector.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism, freemem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlClient } from "@redgiant/events";
import { unzipSync } from "fflate";
import { JobFailure, type Jobs } from "../jobs.js";

export const PGVECTOR_VERSION = "0.8.7";
/** The major of the embedded Postgres (`embedded-postgres` 18.6): the library is built for it. */
export const PGVECTOR_PG_MAJOR = 18;

const RELEASE_BASE = "https://github.com/Frostmoore/redgiant2/releases/download/pgvector-cache";

/**
 * The published zips' sha256, by `<platform>-<arch>`. Filled in once the `pgvector` workflow has
 * published them (assets there are never replaced: a hash here stays true). A system missing
 * here gets no download: `pgvector_unavailable`.
 */
export const PGVECTOR_SHA256: Readonly<Record<string, string>> = {};

const LIB: Record<string, string> = { win32: "vector.dll", darwin: "vector.dylib" };
const libName = (platform: string) => LIB[platform] ?? "vector.so";

/** The zip's name for a system (`pgvector-0.8.7-pg18-linux-x64.zip`). */
export function pgvectorAsset(
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  const os = { win32: "windows", darwin: "macos", linux: "linux" }[platform];
  if (!os) return undefined;
  // One universal library on the Mac.
  const a = platform === "darwin" ? "universal" : arch;
  if (!["x64", "arm64", "universal"].includes(a)) return undefined;
  return `pgvector-${PGVECTOR_VERSION}-pg${PGVECTOR_PG_MAJOR}-${os}-${a}.zip`;
}

/** A folder that really holds pgvector for this system. */
function holds(dir: string, platform: string): boolean {
  return (
    existsSync(join(dir, "lib", libName(platform))) &&
    existsSync(join(dir, "share", "extension", "vector.control"))
  );
}

/** Where a download goes: one folder per pgvector version and Postgres major. */
export const downloadedPgvectorDir = (dataDir: string) =>
  join(dataDir, "tools", "pgvector", `${PGVECTOR_VERSION}-pg${PGVECTOR_PG_MAJOR}`);

/** Next to the installed server (`<server>/pgvector`, beside `dist/`). */
const besideServer = () => fileURLToPath(new URL("../../pgvector", import.meta.url));

/**
 * The folder with `lib/vector.{dll,so,dylib}` and `share/extension/vector.control`: the one
 * named by REDGIANT_PGVECTOR_DIR, the one next to the installed server, then the downloaded one.
 * Undefined when there is none yet (Postgres starts without it; `ensurePgvector` gets it).
 */
export function pgvectorDir(o: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  /** For tests: the server's own folder. */
  serverDir?: string;
}): string | undefined {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const candidates = [
    env.REDGIANT_PGVECTOR_DIR,
    o.serverDir ? join(o.serverDir, "pgvector") : besideServer(),
    downloadedPgvectorDir(o.dataDir),
  ];
  for (const c of candidates) if (c && holds(c, platform)) return c;
  return undefined;
}

/** A path as a postgresql.conf string: forward slashes (a backslash escapes), quotes doubled. */
function confString(s: string): string {
  return `'${s.replaceAll("\\", "/").replaceAll("'", "''")}'`;
}

/**
 * The lines that load pgvector from `dir`: control files from `<dir>/share/extension`, the
 * library from `<dir>/lib`, Postgres' own folders after them (`$system`, `$libdir`).
 */
export function pgvectorConf(dir: string, platform: string = process.platform): string {
  const sep = platform === "win32" ? ";" : ":";
  const d = dir.replaceAll("\\", "/").replace(/\/+$/, "");
  return [
    "# Written by RedGiant at every start: pgvector from a folder of its own (G36).",
    `extension_control_path = ${confString(`${d}/share${sep}$system`)}`,
    `dynamic_library_path = ${confString(`${d}/lib${sep}$libdir`)}`,
    "",
  ].join("\n");
}

const INCLUDE = "include_if_exists = 'redgiant.conf'";

/**
 * Writes `<cluster>/redgiant.conf` (empty without pgvector) and makes `postgresql.conf` include
 * it, once: a cluster made by an older RedGiant gains the line on its next start, nothing else in
 * it changes.
 */
export async function writePgvectorConf(
  clusterDir: string,
  dir: string | undefined,
  platform: string = process.platform,
): Promise<void> {
  const conf = join(clusterDir, "postgresql.conf");
  const text = await readFile(conf, "utf8");
  if (!text.split(/\r?\n/).some((l) => l.trim() === INCLUDE))
    await writeFile(
      conf,
      `${text.endsWith("\n") ? text : `${text}\n`}\n# RedGiant's own settings (G36)\n${INCLUDE}\n`,
    );
  const ours = join(clusterDir, "redgiant.conf");
  const tmp = `${ours}.tmp`;
  await writeFile(tmp, dir ? pgvectorConf(dir, platform) : "# No pgvector folder yet (G36).\n");
  await rename(tmp, ours);
}

/** Turns pgvector on in RedGiant's database (and updates it after a new version). Never throws. */
export async function enableVector(
  db: SqlClient,
): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
  try {
    await db.query("CREATE EXTENSION IF NOT EXISTS vector");
    await db.query("ALTER EXTENSION vector UPDATE");
    const rows = await db.query<{ extversion: string }>(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    );
    const version = rows[0]?.extversion;
    return version ? { ok: true, version } : { ok: false, reason: "vector extension not created" };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * Memory and workers for building an HNSW index (study 4.1: with Postgres' defaults the build is
 * twelve times slower). A quarter of the free memory, between 64 MB and 4 GB; half the cores, at
 * most 4, and none in parallel on small machines (2 cores or less). A parallel build keeps the
 * graph in Postgres' shared memory (/dev/shm: 64 MB by default in Docker, where compose.yaml gives
 * the database `shm_size: 1gb` and the server REDGIANT_PG_SHM_MB=1024): with workers the memory
 * stays below three quarters of it. If a parallel build still fails, build again with 0 workers.
 */
export function indexBuildSettings(
  o: { freeBytes?: number; cores?: number; sharedMemoryBytes?: number } = {},
): {
  maintenanceWorkMem: string;
  workers: number;
} {
  const free = o.freeBytes ?? freemem();
  const cores = o.cores ?? availableParallelism();
  const shmMb = Number(process.env.REDGIANT_PG_SHM_MB);
  const shm = o.sharedMemoryBytes ?? (shmMb > 0 ? shmMb * MB : undefined);
  const workers = cores <= 2 ? 0 : Math.min(Math.floor(cores / 2), 4);
  const cap = workers > 0 && shm ? Math.min(4 * GB, Math.floor((shm * 3) / 4)) : 4 * GB;
  const bytes = Math.max(64 * MB, Math.min(cap, Math.floor(free / 4)));
  const mb = Math.floor(bytes / MB);
  return { maintenanceWorkMem: mb % 1024 === 0 ? `${mb / 1024}GB` : `${mb}MB`, workers };
}

/** The SQL that applies `indexBuildSettings` inside the transaction that builds an index. */
export function indexBuildSql(s: { maintenanceWorkMem: string; workers: number }): string[] {
  return [
    `SET LOCAL maintenance_work_mem = '${s.maintenanceWorkMem.replace(/[^0-9A-Za-z]/g, "")}'`,
    `SET LOCAL max_parallel_maintenance_workers = ${Math.max(0, Math.floor(s.workers))}`,
  ];
}

/** Downloads and checks this system's pgvector into the data folder. Returns the folder. */
export async function downloadPgvector(
  dataDir: string,
  progress: (done: number, total: number | null) => void,
  signal: AbortSignal,
  o: { platform?: string; arch?: string; base?: string; sha256?: Record<string, string> } = {},
): Promise<string> {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const asset = pgvectorAsset(platform, arch);
  const key = `${platform}-${platform === "darwin" ? "universal" : arch}`;
  const want = (o.sha256 ?? PGVECTOR_SHA256)[key];
  if (!asset || !want)
    throw new JobFailure(
      "pgvector_unavailable",
      `There is no published pgvector ${PGVECTOR_VERSION} for ${platform} ${arch} yet`,
    );
  const base = o.base ?? process.env.REDGIANT_PGVECTOR_RELEASES ?? RELEASE_BASE;
  const r = await fetch(`${base}/${asset}`, { signal });
  if (!r.ok || !r.body) throw new Error(`GitHub answered ${r.status} for ${asset}`);
  const total = Number(r.headers.get("content-length")) || null;
  const chunks: Buffer[] = [];
  let done = 0;
  for await (const b of r.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(b));
    done += b.length;
    progress(done, total);
  }
  const zip = Buffer.concat(chunks);
  const got = createHash("sha256").update(zip).digest("hex");
  if (got !== want)
    throw new JobFailure("pgvector_checksum", `${asset}: sha256 ${got}, expected ${want}`);
  const dir = downloadedPgvectorDir(dataDir);
  const part = `${dir}.part`;
  await rm(part, { recursive: true, force: true });
  const files = unzipSync(new Uint8Array(zip));
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith("/")) continue;
    // Only lib/ and share/extension/ go in, and nothing may climb out.
    if (!/^(lib|share\/extension)\/[A-Za-z0-9._+-]+$/.test(name))
      throw new JobFailure("pgvector_checksum", `Unexpected file in ${asset}: ${name}`);
    const out = join(part, ...name.split("/"));
    await mkdir(join(out, ".."), { recursive: true });
    await writeFile(out, data);
  }
  if (!holds(part, platform))
    throw new JobFailure("pgvector_checksum", `${asset} does not hold pgvector`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, ".."), { recursive: true });
  await rename(part, dir);
  return dir;
}

/**
 * pgvector for the embedded Postgres: the folder already here, or downloaded now as a job with
 * its bar (`download_pgvector`). Calls at the same time share one download.
 */
let pending: Promise<string> | undefined;
export function ensurePgvector(jobs: Jobs, owner: string, dataDir: string): Promise<string> {
  const here = pgvectorDir({ dataDir });
  if (here) return Promise.resolve(here);
  pending ??= (async () => {
    const job = jobs.start(owner, "download_pgvector", ["tool_download"], async (h) => {
      h.step("tool_download");
      await downloadPgvector(dataDir, (d, t) => h.progress(d, t), h.signal);
    });
    const end = await jobs.settled(job.id, 500);
    if (end?.state !== "done")
      throw new JobFailure(
        end?.error?.code ?? "pgvector_unavailable",
        end?.error?.message ?? "pgvector did not download",
      );
    return downloadedPgvectorDir(dataDir);
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}

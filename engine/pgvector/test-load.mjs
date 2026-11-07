// Loads a built pgvector into the embedded Postgres exactly as RedGiant does (G36.1): a fresh
// cluster from npm's embedded-postgres, `redgiant.conf` included by `postgresql.conf` with
// extension_control_path and dynamic_library_path pointing outside the installation, then
// CREATE EXTENSION, a halfvec table, an HNSW index used by the planner, a restart and the same
// answers again. Run it from a folder where `embedded-postgres@18.6.0-beta.19` and `pg` are
// installed (npm i --no-save), with a work folder whose path has a space in it.
//
//   node test-load.mjs <pgvector dir with lib/ and share/> <work dir> [--modules <dir>] [--arch x86_64]
//
// --arch x86_64 (macOS): runs the universal postgres under Rosetta, to load the x86_64 slice.
// Prints one JSON line; exits 1 on any failure.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const modules = resolve(flag("--modules") ?? process.cwd());
const arch = flag("--arch");
const [vectorDirArg, workArg] = args;
if (!vectorDirArg || !workArg) {
  console.error(
    "usage: node test-load.mjs <pgvector dir> <work dir> [--modules <dir>] [--arch x86_64]",
  );
  process.exit(2);
}
const vectorDir = resolve(vectorDirArg);
const work = resolve(workArg);
const req = createRequire(join(modules, "package.json"));
const { default: EmbeddedPostgres } = await import(
  pathToFileURL(req.resolve("embedded-postgres")).href
);
const pg = (await import(pathToFileURL(req.resolve("pg")).href)).default;

const freePort = () =>
  new Promise((ok, ko) => {
    const s = createServer();
    s.once("error", ko);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

// The same lines as packages/server/src/knowledge/pgvector.ts (pgvectorConf).
const sep = process.platform === "win32" ? ";" : ":";
const q = (s) => `'${s.replaceAll("\\", "/").replaceAll("'", "''")}'`;
const d = vectorDir.replaceAll("\\", "/");
const conf = [
  `extension_control_path = ${q(`${d}/share${sep}$system`)}`,
  `dynamic_library_path = ${q(`${d}/lib${sep}$libdir`)}`,
  "",
].join("\n");

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const cluster = join(work, "postgres");
const port = await freePort();
const ep = new EmbeddedPostgres({
  databaseDir: cluster,
  port,
  user: "rg",
  password: "rg",
  persistent: true,
  autoRehydrateSymlinks: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
  onLog: () => {},
  onError: () => {},
});
await ep.initialise();
const main = join(cluster, "postgresql.conf");
writeFileSync(main, `${readFileSync(main, "utf8")}\ninclude_if_exists = 'redgiant.conf'\n`);
writeFileSync(join(cluster, "redgiant.conf"), conf);

const bins = await import(
  pathToFileURL(
    req.resolve(
      `@embedded-postgres/${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`,
    ),
  ).href
);
const log = join(work, "postgres.log");
let server;
const run = (file, a) =>
  new Promise((ok, ko) => {
    const c = spawn(file, a, { stdio: "ignore", windowsHide: true });
    c.once("error", ko);
    c.once("exit", (code) => (code === 0 ? ok() : ko(new Error(`${file} exited with ${code}`))));
  });
async function start() {
  if (process.platform === "win32") {
    await run(bins.pg_ctl, [
      "-D",
      cluster,
      "-l",
      log,
      "-o",
      `-p ${port}`,
      "-w",
      "-t",
      "120",
      "start",
    ]);
    return;
  }
  const cmd = arch ? "arch" : bins.postgres;
  const a = [
    ...(arch ? [`-${arch}`, bins.postgres] : []),
    "-D",
    cluster,
    "-p",
    String(port),
    "-c",
    "unix_socket_directories=",
  ];
  server = spawn(cmd, a, { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  server.stderr.on("data", (b) => {
    err += b;
  });
  for (let i = 0; i < 120; i++) {
    const c = new pg.Client({ connectionString: url("postgres") });
    try {
      await c.connect();
      await c.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (server.exitCode !== null) throw new Error(`postgres exited: ${err}`);
  }
  throw new Error(`postgres did not start: ${err}`);
}
async function stop() {
  if (process.platform === "win32")
    return run(bins.pg_ctl, ["-D", cluster, "-m", "fast", "-w", "stop"]);
  const done = new Promise((r) => server.once("exit", r));
  server.kill("SIGINT");
  await done;
}
const url = (db) => `postgres://rg:rg@127.0.0.1:${port}/${db}`;

const N = 2000;
const DIM = 64;
// Deterministic vectors: 20 clusters, so the nearest neighbours are well defined.
const vec = (i) => {
  const c = i % 20;
  const out = [];
  let s = (i * 2654435761) >>> 0;
  for (let k = 0; k < DIM; k++) {
    s = (s * 1103515245 + 12345) >>> 0;
    out.push((k % 20 === c ? 1 : 0) + (s / 2 ** 32 - 0.5) * 0.2);
  }
  return `[${out.map((x) => x.toFixed(4)).join(",")}]`;
};

async function check(load) {
  const c = new pg.Client({ connectionString: url("postgres") });
  await c.connect();
  try {
    const one = async (s, p) => (await c.query(s, p)).rows;
    if (load) {
      await c.query("CREATE EXTENSION vector");
      await c.query(`CREATE TABLE t (id int PRIMARY KEY, e halfvec(${DIM}))`);
      for (let b = 0; b < N; b += 500) {
        const ids = [];
        const es = [];
        for (let i = b; i < Math.min(N, b + 500); i++) {
          ids.push(i);
          es.push(vec(i));
        }
        await c.query("INSERT INTO t SELECT * FROM unnest($1::int[], $2::halfvec[])", [ids, es]);
      }
      await c.query("SET maintenance_work_mem = '128MB'");
      await c.query("CREATE INDEX t_hnsw ON t USING hnsw (e halfvec_cosine_ops)");
    }
    await c.query("SET enable_seqscan = off");
    await c.query("SET hnsw.iterative_scan = relaxed_order");
    const qv = vec(7);
    const plan = (await one("EXPLAIN SELECT id FROM t ORDER BY e <=> $1::halfvec LIMIT 10", [qv]))
      .map((r) => r["QUERY PLAN"])
      .join(" ");
    const ann = (await one("SELECT id FROM t ORDER BY e <=> $1::halfvec LIMIT 10", [qv])).map(
      (r) => r.id,
    );
    await c.query("RESET enable_seqscan");
    const exact = new Set(
      (await one("SELECT id FROM t ORDER BY (e <=> $1::halfvec) + 0 LIMIT 10", [qv])).map(
        (r) => r.id,
      ),
    );
    return {
      server: (await one("SHOW server_version"))[0].server_version,
      vector: (await one("SELECT extversion FROM pg_extension WHERE extname = 'vector'"))[0]
        ?.extversion,
      rows: Number((await one("SELECT count(*) AS n FROM t"))[0].n),
      hnsw: plan.includes("t_hnsw"),
      recall10: ann.filter((id) => exact.has(id)).length / 10,
      probin: (await one("SELECT probin FROM pg_proc WHERE proname = 'halfvec_in'"))[0]?.probin,
      contexts: Object.fromEntries(
        (
          await one(
            "SELECT name, context FROM pg_settings WHERE name IN ('extension_control_path', 'dynamic_library_path')",
          )
        ).map((r) => [r.name, r.context]),
      ),
    };
  } finally {
    await c.end();
  }
}

const result = { platform: process.platform, arch: arch ?? process.arch, work };
try {
  await start();
  result.first = await check(true);
  await stop();
  await start();
  result.restarted = await check(false);
  await stop();
  const ok = [result.first, result.restarted].every(
    (r) => r.vector && r.rows === N && r.hnsw && r.recall10 >= 0.9,
  );
  result.ok = ok;
  console.log(JSON.stringify(result));
  process.exit(ok ? 0 : 1);
} catch (err) {
  result.error = String(err?.stack ?? err);
  try {
    result.log = readFileSync(log, "utf8").slice(-2000);
  } catch {}
  console.log(JSON.stringify(result));
  try {
    await stop();
  } catch {}
  process.exit(1);
}

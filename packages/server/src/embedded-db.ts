// Postgres without installing anything (G30.1, RedGiant 3.0): on Windows RedGiant runs natively,
// with no WSL and no Docker, so the server starts a real Postgres itself, from the binaries the
// `embedded-postgres` package carries for each system, in a folder of the data directory. The
// same database as everywhere else, only started by us; it listens on 127.0.0.1 only, on a free
// port, with a password made the first time and kept next to it.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pgDriver from "pg";

export interface EmbeddedDatabase {
  url: string;
  stop(): Promise<void>;
}

export function freePort(): Promise<number> {
  return new Promise((ok, ko) => {
    const srv = createServer();
    srv.once("error", ko);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => ok(port));
    });
  });
}

/** Creates RedGiant's database when missing (a first start stopped halfway leaves none). */
async function ensureDatabase(adminUrl: string): Promise<void> {
  const c = new pgDriver.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    const { rowCount } = await c.query("SELECT 1 FROM pg_database WHERE datname = 'redgiant'");
    if (!rowCount) await c.query("CREATE DATABASE redgiant");
  } finally {
    await c.end();
  }
}

/** Starts (creating it the first time) the Postgres kept in `<dataDir>/postgres`. */
export async function startEmbeddedDatabase(
  dataDir: string,
  log: (line: string) => void = () => {},
): Promise<EmbeddedDatabase> {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dir = join(dataDir, "postgres");
  const secretFile = join(dataDir, "postgres.json");
  await mkdir(dataDir, { recursive: true });
  let password: string;
  try {
    password = (JSON.parse(await readFile(secretFile, "utf8")) as { password: string }).password;
  } catch {
    password = randomBytes(24).toString("hex");
    await writeFile(secretFile, JSON.stringify({ password }), { mode: 0o600 });
  }
  const fresh = !existsSync(join(dir, "PG_VERSION"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: "redgiant",
    password,
    persistent: true,
    autoRehydrateSymlinks: true,
    // Only this computer reaches it; UTF-8 whatever the system's language.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
    onLog: () => {},
    onError: (e) => log(`postgres: ${e instanceof Error ? e.message : String(e)}`),
  });
  if (fresh) await pg.initialise();
  const url = (db: string) =>
    `postgres://redgiant:${encodeURIComponent(password)}@127.0.0.1:${port}/${db}`;
  if (process.platform === "win32") {
    // Postgres refuses to run with an administrator's rights; pg_ctl drops them on Windows
    // (2026-11-05: started elevated, `postgres` itself just quit), so it starts the server.
    const req = createRequire(fileURLToPath(import.meta.resolve("embedded-postgres")));
    const { pg_ctl } = (await import(
      pathToFileURL(req.resolve("@embedded-postgres/windows-x64")).href
    )) as { pg_ctl: string };
    // Output not attached: the server pg_ctl leaves running would hold it open, and waiting on it
    // would never end. Its log goes to postgres.log.
    const ctl = (...args: string[]) =>
      new Promise<void>((ok, ko) => {
        const child = spawn(pg_ctl, ["-D", dir, ...args], { stdio: "ignore", windowsHide: true });
        child.once("error", ko);
        child.once("exit", (code) =>
          code === 0 ? ok() : ko(new Error(`pg_ctl ${args.at(-1)} exited with ${code}`)),
        );
      });
    // A server left running by a previous start (its port is chosen anew each time).
    if (
      await ctl("status").then(
        () => true,
        () => false,
      )
    )
      await ctl("-m", "fast", "-w", "stop").catch(() => {});
    await ctl(
      "-l",
      join(dataDir, "postgres.log"),
      "-o",
      `-p ${port} -c listen_addresses=127.0.0.1`,
      "-w",
      "-t",
      "120",
      "start",
    );
    await ensureDatabase(url("postgres"));
    return {
      url: url("redgiant"),
      stop: async () => {
        await ctl("-m", "fast", "-w", "stop");
      },
    };
  }
  await pg.start();
  await ensureDatabase(url("postgres"));
  return { url: url("redgiant"), stop: () => pg.stop() };
}

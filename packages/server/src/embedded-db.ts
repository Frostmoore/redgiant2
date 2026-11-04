// Postgres without installing anything (G30.1, RedGiant 3.0): on Windows RedGiant runs natively,
// with no WSL and no Docker, so the server starts a real Postgres itself, from the binaries the
// `embedded-postgres` package carries for each system, in a folder of the data directory. The
// same database as everywhere else, only started by us; it listens on 127.0.0.1 only, on a free
// port, with a password made the first time and kept next to it.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

export interface EmbeddedDatabase {
  url: string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((ok, ko) => {
    const srv = createServer();
    srv.once("error", ko);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => ok(port));
    });
  });
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
  await pg.start();
  if (fresh) await pg.createDatabase("redgiant");
  return {
    url: `postgres://redgiant:${encodeURIComponent(password)}@127.0.0.1:${port}/redgiant`,
    stop: () => pg.stop(),
  };
}

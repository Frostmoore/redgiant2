#!/usr/bin/env node
// Runs the RedGiant server under supervision: rebuilds it when God promotes a change and rolls
// back to the last good version when the new one does not come up (G14.2).
import { join, resolve } from "node:path";
import { Supervisor } from "./supervisor.js";

const env = process.env;
const sourceDir = resolve(env.REDGIANT_SOURCE_DIR ?? process.cwd());
const dataDir = resolve(env.REDGIANT_DATA_DIR ?? "./data");
const stateDir = resolve(env.REDGIANT_STATE_DIR ?? join(dataDir, "release"));
const port = env.REDGIANT_PORT ?? "7600";

const supervisor = new Supervisor({
  sourceDir,
  stateDir,
  build: env.REDGIANT_BUILD_COMMAND ?? "pnpm install --frozen-lockfile && pnpm build",
  start: { command: process.execPath, args: ["packages/server/dist/main.js"] },
  // The server knows it is supervised (it may ask for a restart) and where to leave requests.
  env: {
    ...env,
    REDGIANT_SUPERVISED: "1",
    REDGIANT_SOURCE_DIR: sourceDir,
    REDGIANT_STATE_DIR: stateDir,
  },
  healthUrl: `http://127.0.0.1:${port}/api/health`,
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void supervisor.stop().then(() => process.exit(0)));
}
await supervisor.run();

#!/usr/bin/env node
// The `redgiant` command line (packages/cli) inside an app's server folder (G36.15): the Windows
// installer and the Mac app carry it there, so it updates with the server (also differentially)
// and finds its modules (@redgiant/protocol, zod) in the server's node_modules.
//
//   node packaging/cli/stage.mjs <server folder>     after `pnpm build` and the server's deploy
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const server = process.argv[2];
if (!server) {
  console.error("usage: node packaging/cli/stage.mjs <server folder>");
  process.exit(2);
}
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "cli", "dist");
const out = join(server, "cli");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const files = readdirSync(dist).filter((f) => f.endsWith(".js"));
if (!files.includes("main.js")) {
  console.error(`no main.js in ${dist}: run pnpm build first`);
  process.exit(1);
}
for (const f of files) copyFileSync(join(dist, f), join(out, f));
writeFileSync(join(out, "package.json"), `${JSON.stringify({ type: "module", private: true })}\n`);
console.log(`redgiant command line: ${files.length} files in ${out}`);

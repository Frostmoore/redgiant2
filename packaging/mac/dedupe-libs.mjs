// The npm package of Postgres for macOS carries every library three times (libx.dylib,
// libx.77.dylib, libx.77.1.dylib: npm keeps no symbolic links). Identical copies become links to
// the most specific name again: about 170 MB less in RedGiant.app (2026-11-05).
//
//   node dedupe-libs.mjs <folder>
import { lstatSync, readdirSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: dedupe-libs.mjs <folder>");
const libs = readdirSync(dir).filter(
  (n) => n.endsWith(".dylib") && !lstatSync(join(dir, n)).isSymbolicLink(),
);
let saved = 0;
for (const name of libs) {
  const stem = name.slice(0, -".dylib".length);
  const target = libs
    .filter((m) => m !== name && m.startsWith(`${stem}.`))
    .sort((a, b) => b.length - a.length)[0];
  if (!target) continue;
  const a = readFileSync(join(dir, name));
  if (!a.equals(readFileSync(join(dir, target)))) continue;
  unlinkSync(join(dir, name));
  symlinkSync(target, join(dir, name));
  saved += a.length;
  console.log(`${name} -> ${target}`);
}
console.log(`${Math.round(saved / 1024 / 1024)} MB of copies made links`);

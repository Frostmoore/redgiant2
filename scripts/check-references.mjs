// Fails when a package is missing from the root tsconfig references: it would not be type-checked.
import { readdirSync, readFileSync } from "node:fs";

const root = JSON.parse(readFileSync("tsconfig.json", "utf8"));
const referenced = new Set(root.references.map((r) => r.path));
const missing = readdirSync("packages", { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => `packages/${d.name}`)
  .filter((p) => !referenced.has(p));
if (missing.length > 0) {
  console.error(`Not referenced in tsconfig.json (never type-checked): ${missing.join(", ")}`);
  process.exit(1);
}

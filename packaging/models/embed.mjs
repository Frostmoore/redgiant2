#!/usr/bin/env node
// Writes the copy of the models catalog built into RedGiant (packages/providers/src/catalog-data.ts)
// from packaging/models/catalog.json, the one published signed. The providers' tests fail when the
// two differ. Only Node's own modules.
//
//   node packaging/models/embed.mjs
import { readFileSync, writeFileSync } from "node:fs";

const src = new URL("./catalog.json", import.meta.url);
const out = new URL("../../packages/providers/src/catalog-data.ts", import.meta.url);
const { $comment: _comment, ...catalog } = JSON.parse(readFileSync(src, "utf8"));
if (catalog.format !== 1 || !Number.isInteger(catalog.version) || catalog.version < 1)
  throw new Error("catalog.json: format 1 and a positive integer version are needed");
writeFileSync(
  out,
  `// Written by packaging/models/embed.mjs from packaging/models/catalog.json: do not edit by hand.\n` +
    `// The catalog built into this RedGiant, used until a newer signed one is downloaded.\n` +
    `import type { ModelsCatalog } from "@redgiant/protocol";\n\n` +
    `export const BUILTIN_CATALOG: ModelsCatalog = ${JSON.stringify(catalog, null, 2)};\n`,
);
console.log(`catalog-data.ts: version ${catalog.version}`);

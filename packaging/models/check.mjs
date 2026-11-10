#!/usr/bin/env node
// Checks the models catalog before it is published (3.5.4) and writes the copy to publish (the
// same data without the editor's `$comment`). Stops on anything RedGiant would refuse, so a bad
// catalog never gets signed. With --newer-than <file|url>, also refuses a version that is not
// above the published one (an older catalog never replaces a newer one). Only Node's modules.
//
//   node packaging/models/check.mjs packaging/models/catalog.json out/models-catalog.json [--newer-than <file|url>]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: check.mjs <catalog.json> <out.json> [--newer-than <file|url>]");
  process.exit(2);
}
const fail = (m) => {
  console.error(`models catalog: ${m}`);
  process.exit(1);
};
const { $comment: _c, ...c } = JSON.parse(readFileSync(src, "utf8"));
if (c.format !== 1) fail("format must be 1");
if (!Number.isInteger(c.version) || c.version < 1) fail("version must be a positive integer");
if (!/^\d{4}-\d{2}-\d{2}$/.test(c.updatedAt ?? "")) fail("updatedAt must be YYYY-MM-DD");
const num = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const prices = (p, where) => {
  for (const k of ["input", "output", "cacheRead", "cacheWrite"])
    if (!num(p?.[k])) fail(`${where}: pricing.${k} must be a number`);
  if (p.cacheWrite1h !== undefined && !num(p.cacheWrite1h)) fail(`${where}: cacheWrite1h`);
};
for (const [pid, prov] of Object.entries(c.providers ?? {})) {
  for (const u of prov.sources ?? []) if (!/^https:\/\//.test(u)) fail(`${pid}: source ${u}`);
  for (const [id, m] of Object.entries(prov.models ?? {})) {
    const where = `${pid}/${id}`;
    if (typeof m.name !== "string" || !m.name) fail(`${where}: name`);
    for (const k of ["contextWindow", "maxOutputTokens"])
      if (!Number.isInteger(m[k]) || m[k] <= 0) fail(`${where}: ${k}`);
    for (const k of ["effort", "adaptiveThinking", "vision"])
      if (typeof m[k] !== "boolean") fail(`${where}: ${k} must be true or false`);
    if (!["current", "legacy"].includes(m.status)) fail(`${where}: status current or legacy`);
    if (m.released !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(m.released))
      fail(`${where}: released must be YYYY-MM-DD`);
    if (m.pricing) {
      prices(m.pricing, where);
      if (m.pricing.longPrompt) prices(m.pricing.longPrompt.prices, `${where} longPrompt`);
    }
  }
}
const i = process.argv.indexOf("--newer-than");
if (i > 0) {
  const from = process.argv[i + 1];
  let published;
  try {
    published = /^https?:/.test(from)
      ? await fetch(from).then((r) => (r.ok ? r.json() : undefined))
      : JSON.parse(readFileSync(from, "utf8"));
  } catch {
    published = undefined;
  }
  if (published && !(c.version > published.version))
    fail(`version ${c.version} is not above the published ${published.version}: raise it`);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(c, null, 2)}\n`);
console.log(`models catalog ${c.version} (${c.updatedAt}): checked, written to ${out}`);

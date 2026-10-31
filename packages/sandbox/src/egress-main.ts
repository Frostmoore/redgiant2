#!/usr/bin/env node
// Runs the egress proxy as its own process/container: `redgiant-egress <policy.json> [port]`.
import { readFile } from "node:fs/promises";
import { type EgressPolicy, EgressProxy } from "./egress.js";

const [file, portArg] = process.argv.slice(2);
if (!file) {
  console.error("usage: redgiant-egress <policy.json> [port]");
  process.exit(2);
}
const policy = JSON.parse(await readFile(file, "utf8")) as EgressPolicy;
const proxy = new EgressProxy(policy, (d) => {
  if (!d.allowed) console.log(JSON.stringify({ ts: new Date().toISOString(), ...d }));
});
// Last line of defence: one bad connection must not cut every sandbox off the network.
process.on("uncaughtException", (err) =>
  console.error(JSON.stringify({ ts: new Date().toISOString(), error: String(err) })),
);
const port = await proxy.listen(Number(portArg ?? 3128));
console.log(`redgiant-egress listening on ${port}`);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => void proxy.close().then(() => process.exit(0)));

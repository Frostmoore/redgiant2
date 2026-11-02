#!/usr/bin/env node
// Runs the egress proxy as its own process/container:
//   redgiant-egress <policy.json> [port] [routes.json]
// routes.json holds the credential routes the server writes while running (GitHub, Gitea); it is
// read again whenever it changes.
import { readFile, stat } from "node:fs/promises";
import { type CredentialRoute, type EgressPolicy, EgressProxy } from "./egress.js";

const [file, portArg, routesFile] = process.argv.slice(2);
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
if (routesFile) {
  let seen = "";
  const reload = async () => {
    const st = await stat(routesFile).catch(() => null);
    const mark = st ? `${st.mtimeMs}:${st.size}` : "";
    if (mark === seen) return;
    seen = mark;
    const routes = st
      ? ((await readFile(routesFile, "utf8")
          .then((t) => JSON.parse(t) as Record<string, CredentialRoute>)
          .catch(() => null)) ?? {})
      : {};
    proxy.setRoutes(routes);
    console.log(
      `redgiant-egress: ${Object.keys(routes).length} credential routes from ${routesFile}`,
    );
  };
  await reload();
  setInterval(() => void reload(), 2000).unref();
}
const port = await proxy.listen(Number(portArg ?? 3128));
console.log(`redgiant-egress listening on ${port}`);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => void proxy.close().then(() => process.exit(0)));

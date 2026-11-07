#!/usr/bin/env node
// Runs the egress proxy as its own process/container:
//   redgiant-egress <policy.json> [port] [routes.json]
// routes.json holds the credential routes the server writes while running (GitHub, Gitea) and,
// under "$vault", the keychain's credentials bound to tools (G33.4); it is read again whenever it
// changes.
import { readFile, stat } from "node:fs/promises";
import {
  type CredentialRoute,
  type EgressPolicy,
  EgressProxy,
  type VaultProxyRoute,
} from "./egress.js";

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
    const all = st
      ? ((await readFile(routesFile, "utf8")
          .then((t) => JSON.parse(t) as Record<string, unknown>)
          .catch(() => null)) ?? {})
      : {};
    const { $vault, ...routes } = all as Record<string, CredentialRoute> & {
      $vault?: VaultProxyRoute[];
    };
    proxy.setRoutes(routes);
    proxy.setVault(Array.isArray($vault) ? $vault : []);
    console.log(
      `redgiant-egress: ${Object.keys(routes).length} credential routes, ${Array.isArray($vault) ? $vault.length : 0} keychain credentials from ${routesFile}`,
    );
  };
  await reload();
  setInterval(() => void reload(), 2000).unref();
}
const port = await proxy.listen(Number(portArg ?? 3128));
console.log(`redgiant-egress listening on ${port}`);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => void proxy.close().then(() => process.exit(0)));

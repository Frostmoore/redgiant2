#!/usr/bin/env node
// Makes the key that signs the update manifests (G36.18), once, on the person's computer:
//
//   node packaging/update/keygen.mjs <where to write the private key, outside the repository>
//
// The private key (RSA 3072, PEM) goes to that file: its content becomes the repository's
// secret UPDATE_SIGNING_KEY (GitHub > Settings > Secrets and variables > Actions), then the file
// is deleted or kept somewhere safe. The public half is written into
// packaging/windows/launcher/UpdateKey.cs and packages/server/src/release-key.ts (G36.19): from the next release the launcher refuses manifests
// without a valid signature, and release.yml refuses to publish without the secret.
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dotnetXml } from "./sign.mjs";

const out = process.argv[2];
if (!out) {
  console.error("usage: keygen.mjs <private key file, outside the repository>");
  process.exit(2);
}
const repo = resolve(new URL("../..", import.meta.url).pathname);
if (resolve(out).startsWith(repo)) {
  console.error("the private key must not be written inside the repository");
  process.exit(1);
}
if (existsSync(out)) {
  console.error(`${out} exists already`);
  process.exit(1);
}
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
writeFileSync(out, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
const csPath = new URL("../windows/launcher/UpdateKey.cs", import.meta.url);
const cs = readFileSync(csPath, "utf8");
const next = cs.replace(/PublicKeyXml = "[^"]*"/, `PublicKeyXml = "${dotnetXml(privateKey)}"`);
if (next === cs) throw new Error("UpdateKey.cs: PublicKeyXml not found");
writeFileSync(csPath, next);
// The server checks release.json with the same key (G36.19).
const tsPath = new URL("../../packages/server/src/release-key.ts", import.meta.url);
const ts = readFileSync(tsPath, "utf8");
const pem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).trim();
const nextTs = ts.replace(/RELEASE_PUBLIC_KEY = `[^`]*`/, `RELEASE_PUBLIC_KEY = \`${pem}\``);
if (nextTs === ts && !ts.includes(pem))
  throw new Error("release-key.ts: RELEASE_PUBLIC_KEY not found");
writeFileSync(tsPath, nextTs);
console.log(`private key: ${out} (make it the UPDATE_SIGNING_KEY secret, then put it away)`);
console.log(
  "public key: written into UpdateKey.cs and packages/server/src/release-key.ts (commit both)",
);

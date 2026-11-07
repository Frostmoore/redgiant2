#!/usr/bin/env node
// Signs an update manifest (G36.18): RSA, SHA-256, PKCS #1 v1.5, as the launcher checks it
// (Delta.SignatureValid with UpdateKey.PublicKeyXml). The private key (PEM) comes from the
// UPDATE_SIGNING_KEY environment variable, the repository's secret; it is never written to disk.
//
//   UPDATE_SIGNING_KEY="$(cat key.pem)" node packaging/update/sign.mjs <manifest>   → <manifest>.sig
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/** The base64 signature of `data` with the PEM private key `pem`. */
export function signManifest(data, pem) {
  return sign("sha256", data, createPrivateKey(pem)).toString("base64");
}

/** True when `signature` (base64) is `data` signed by the key whose public half is `publicPem`. */
export function checkSignature(data, signature, publicPem) {
  return verify("sha256", data, createPublicKey(publicPem), Buffer.from(signature, "base64"));
}

/** The public half of an RSA key as .NET's <RSAKeyValue> XML (what UpdateKey.cs holds). */
export function dotnetXml(key) {
  const jwk = createPublicKey(key).export({ format: "jwk" });
  if (jwk.kty !== "RSA") throw new Error("an RSA key is needed");
  const b64 = (s) => Buffer.from(s, "base64url").toString("base64");
  return `<RSAKeyValue><Modulus>${b64(jwk.n)}</Modulus><Exponent>${b64(jwk.e)}</Exponent></RSAKeyValue>`;
}

if (process.argv[1]?.endsWith("sign.mjs")) {
  const file = process.argv[2];
  const pem = process.env.UPDATE_SIGNING_KEY;
  if (!file || !pem) {
    console.error("usage: UPDATE_SIGNING_KEY=<PEM> sign.mjs <manifest>");
    process.exit(2);
  }
  const data = readFileSync(file);
  const sig = signManifest(data, pem);
  // Checked against the key built into the launcher, so a wrong secret fails the release here.
  const cs = readFileSync(new URL("../windows/launcher/UpdateKey.cs", import.meta.url), "utf8");
  const built = /PublicKeyXml = "([^"]*)"/.exec(cs)?.[1] ?? "";
  if (built !== "" && built !== dotnetXml(pem)) {
    console.error("UPDATE_SIGNING_KEY is not the key whose public half is in UpdateKey.cs");
    process.exit(1);
  }
  writeFileSync(`${file}.sig`, `${sig}\n`);
  console.log(`signed ${file}`);
}

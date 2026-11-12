// RedGiant OS (G39.1): the pinned stack (stack.mjs), and the update gate of the OS's updater
// (redgiant-os-update, bash) checked against assessRelease, the rule it mirrors.
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assessRelease, type ReleaseInfo } from "../../../packages/protocol/src/release.js";
// @ts-expect-error plain JavaScript, no types
import { checkSignature, signManifest } from "../../update/sign.mjs";
// @ts-expect-error plain JavaScript, no types
import { checkStack, platformDigests, STACK_FILES, stackImages } from "../stack.mjs";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const image = (o: Record<string, unknown> = {}) => ({
  name: "redgiant",
  env: "REDGIANT_IMAGE",
  ref: "ghcr.io/frostmoore/redgiant2:3.7.0",
  digest: digest("a"),
  id: digest("b"),
  ...o,
});
const stack = (o: Record<string, unknown> = {}) => ({
  format: 1,
  version: "3.7.0",
  images: { amd64: [image()], arm64: [image({ digest: digest("c") })] },
  files: { "compose.yaml": "services: {}\n" },
  ...o,
});

describe("the stack of a release", () => {
  it("keeps one manifest per processor, without attestations", () => {
    const index = {
      manifests: [
        { digest: digest("1"), platform: { os: "linux", architecture: "amd64" } },
        { digest: digest("2"), platform: { os: "linux", architecture: "arm64" } },
        { digest: digest("3"), platform: { os: "unknown", architecture: "unknown" } },
      ],
    };
    expect(platformDigests(index)).toEqual({ amd64: digest("1"), arm64: digest("2") });
  });

  it("pins the server and its database, the others come down when chosen", () => {
    expect(stackImages("3.7.0").map((i: { env: string }) => i.env)).toEqual([
      "REDGIANT_IMAGE",
      "REDGIANT_POSTGRES_IMAGE",
    ]);
    expect(STACK_FILES).toContain("compose.yaml");
  });

  it.each([
    ["a good stack", stack(), null],
    ["another format", stack({ format: 2 }), "format"],
    ["no version", stack({ version: "latest" }), "version"],
    ["no arm64", stack({ images: { amd64: [image()] } }), "arm64"],
    [
      "a tag instead of a digest",
      stack({ images: { amd64: [image({ digest: "latest" })], arm64: [image()] } }),
      "digest",
    ],
    [
      "a strange reference",
      stack({ images: { amd64: [image({ ref: "evil; rm -rf /:x" })], arm64: [image()] } }),
      "reference",
    ],
    [
      "a strange variable",
      stack({ images: { amd64: [image({ env: "PATH=/x" })], arm64: [image()] } }),
      "env",
    ],
    ["a file it does not use", stack({ files: { "../../etc/passwd": "x" } }), "unexpected file"],
  ])("%s", (_name, s, error) => {
    if (error) expect(() => checkStack(s)).toThrow(error as string);
    else expect(checkStack(s)).toBe(s);
  });

  it("is signed and checked with the update key, as release.json", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
    const data = Buffer.from(JSON.stringify(stack()));
    expect(checkSignature(data, signManifest(data, pem), pub)).toBe(true);
  });
});

const updater = fileURLToPath(
  new URL("../rootfs/usr/lib/redgiant-os/redgiant-os-update", import.meta.url),
);
const tools = process.platform !== "win32" && spawnSync("jq", ["--version"]).status === 0;

describe("the OS's update gate is assessRelease's", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-os-gate-"));
  const info = (o: Partial<ReleaseInfo>): ReleaseInfo => ({
    format: 1,
    version: "3.8.0",
    kind: "normal",
    publishedAt: "2026-11-12T00:00:00Z",
    ...o,
  });
  const cases: Array<[string, ReleaseInfo]> = [
    ["3.8.0", info({})],
    ["3.7.0", info({})],
    ["3.7.0", info({ kind: "mandatory" })],
    ["3.7.0", info({ kind: "mandatory", minVersion: "3.6.0" })],
    ["3.5.0", info({ kind: "mandatory", minVersion: "3.6.0" })],
    ["3.7.0", info({ kind: "breaking" })],
    ["3.7.0", info({ kind: "breaking", minVersion: "3.7.0" })],
    ["3.6.9", info({ kind: "breaking", minVersion: "3.7.0" })],
    ["3.7.0", info({ requiredBelow: "3.7.5" })],
    ["3.7.9", info({ requiredBelow: "3.7.5" })],
    ["3.4.0", info({ cleanInstallBelow: "3.5.0" })],
    ["3.6.0", info({ cleanInstallBelow: "3.5.0", requiredBelow: "3.7.0" })],
    ["3.10.0", info({ version: "3.9.0" })],
  ];
  it.each(cases)("installed %s", { skip: !tools }, (installed, release) => {
    const file = join(dir, `${installed}-${JSON.stringify(release).length}.json`);
    writeFileSync(file, JSON.stringify(release));
    const out = execFileSync("bash", [updater, "gate", installed, file], { encoding: "utf8" });
    expect(out.trim()).toBe(assessRelease(release, installed));
  });
});

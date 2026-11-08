// release.json at release time (G36.19): what release-info.mjs writes from release-kind.json,
// signed with sign.mjs and checked by the server as it checks a real release.
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyReleaseInfo } from "../../../packages/server/src/updates.js";
// @ts-expect-error plain JavaScript, no types
import { checkKindFile, releaseInfo } from "../release-info.mjs";
// @ts-expect-error plain JavaScript, no types
import { signManifest } from "../sign.mjs";

const kind = (o: Record<string, unknown> = {}) => ({
  version: "3.5.0",
  kind: "normal",
  minVersion: null,
  note: { it: "", en: "" },
  requiredBelow: null,
  cleanInstallBelow: null,
  ...o,
});
const note = { it: "Il database cambia forma.", en: "The database changes shape." };
const at = "2026-11-08T00:00:00.000Z";

describe("release-info.mjs", () => {
  it("the repository's file is valid", () => {
    const file = JSON.parse(
      readFileSync(new URL("../../release-kind.json", import.meta.url), "utf8"),
    );
    expect(() => checkKindFile(file)).not.toThrow();
  });

  it("gives the tag its kind, and every later tag the carried bound", () => {
    const k = kind({ kind: "breaking", note });
    expect(releaseInfo(k, "3.5.0", at)).toEqual({
      format: 1,
      version: "3.5.0",
      kind: "breaking",
      note,
      cleanInstallBelow: "3.5.0",
      publishedAt: at,
    });
    // The next release, file untouched: normal, but whoever skipped 3.5.0 still meets it.
    expect(releaseInfo(k, "3.5.1", at)).toEqual({
      format: 1,
      version: "3.5.1",
      kind: "normal",
      cleanInstallBelow: "3.5.0",
      publishedAt: at,
    });
    const m = kind({ kind: "mandatory", minVersion: "3.4.0", note, cleanInstallBelow: "3.0.0" });
    expect(releaseInfo(m, "3.5.0", at)).toMatchObject({
      kind: "mandatory",
      minVersion: "3.4.0",
      requiredBelow: "3.4.0",
      cleanInstallBelow: "3.0.0",
    });
  });

  it("a file prepared for a later version does not touch this one", () => {
    expect(releaseInfo(kind({ version: "3.6.0", kind: "breaking", note }), "3.5.2", at)).toEqual({
      format: 1,
      version: "3.5.2",
      kind: "normal",
      publishedAt: at,
    });
  });

  it("refuses what a release must not carry", () => {
    expect(() => checkKindFile(kind({ kind: "mandatory" }))).toThrow(/note/);
    expect(() => checkKindFile(kind({ kind: "soon" }))).toThrow(/kind/);
    expect(() => checkKindFile(kind({ version: "3.5" }))).toThrow(/version/);
    expect(() => checkKindFile(kind({ minVersion: "3.6.0" }))).toThrow(/minVersion/);
    expect(() => releaseInfo(kind(), "3.5.0-rc1")).toThrow(/version/);
  });

  it("signed with sign.mjs, the server takes it; changed or with another key, it does not", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
    const bytes = Buffer.from(
      `${JSON.stringify(releaseInfo(kind({ kind: "mandatory", note }), "3.5.0", at), null, 2)}\n`,
    );
    const sig = signManifest(bytes, pem);
    expect(verifyReleaseInfo(bytes, sig, pub)?.kind).toBe("mandatory");
    const forged = Buffer.from(bytes.toString().replace("mandatory", "breaking"));
    expect(verifyReleaseInfo(forged, sig, pub)).toBeNull();
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
      type: "spki",
      format: "pem",
    });
    expect(verifyReleaseInfo(bytes, sig, other.toString())).toBeNull();
    expect(verifyReleaseInfo(bytes, sig, "")).toBeNull();
    expect(verifyReleaseInfo(bytes, "not base64 at all", pub)).toBeNull();
  });
});

// The rule of mandatory and breaking updates (G36.19), as a table.
import { describe, expect, it } from "vitest";
import { assessRelease, compareVersions, ReleaseInfo, type UpdateGate } from "../src/index.js";

const info = (o: Partial<ReleaseInfo>): ReleaseInfo => ({
  format: 1,
  version: "3.5.0",
  kind: "normal",
  ...o,
});

describe("compareVersions", () => {
  it("compares numbers, not text", () => {
    expect(compareVersions("3.4.0", "3.10.0")).toBe(-1);
    expect(compareVersions("v3.4.0", "3.4.0")).toBe(0);
    expect(compareVersions("3.4.1", "3.4.0")).toBe(1);
    expect(compareVersions("3.4", "3.4.0")).toBe(0);
  });
});

describe("assessRelease", () => {
  const rows: [string, ReleaseInfo | null, string, UpdateGate][] = [
    ["same version", info({ kind: "mandatory" }), "3.5.0", "none"],
    ["newer installed", info({ kind: "breaking" }), "3.6.0", "none"],
    ["no signed metadata", null, "3.4.0", "normal"],
    ["normal release", info({}), "3.4.0", "normal"],
    ["mandatory for every older", info({ kind: "mandatory" }), "3.4.9", "mandatory"],
    [
      "mandatory only below minVersion",
      info({ kind: "mandatory", minVersion: "3.3.0" }),
      "3.4.0",
      "normal",
    ],
    [
      "mandatory below minVersion",
      info({ kind: "mandatory", minVersion: "3.3.0" }),
      "3.2.9",
      "mandatory",
    ],
    ["breaking for every older", info({ kind: "breaking" }), "3.4.0", "breaking"],
    [
      "breaking only below minVersion",
      info({ kind: "breaking", minVersion: "3.4.0" }),
      "3.4.0",
      "normal",
    ],
    [
      "carried clean install",
      info({ cleanInstallBelow: "3.5.0", version: "3.5.2" }),
      "3.4.0",
      "breaking",
    ],
    [
      "carried bound passed",
      info({ cleanInstallBelow: "3.5.0", version: "3.5.2" }),
      "3.5.1",
      "normal",
    ],
    ["carried mandatory", info({ requiredBelow: "3.5.1", version: "3.5.2" }), "3.5.0", "mandatory"],
    [
      "breaking wins over mandatory",
      info({ kind: "mandatory", cleanInstallBelow: "3.5.0" }),
      "3.4.0",
      "breaking",
    ],
  ];
  for (const [name, i, installed, gate] of rows)
    it(name, () => expect(assessRelease(i, installed, i?.version ?? "3.5.0")).toBe(gate));

  it("metadata of another release say nothing", () => {
    expect(assessRelease(info({ kind: "mandatory", version: "3.5.0" }), "3.4.0", "3.5.1")).toBe(
      "normal",
    );
  });

  it("refuses malformed metadata", () => {
    expect(ReleaseInfo.safeParse({ format: 1, version: "3.5", kind: "normal" }).success).toBe(
      false,
    );
    expect(ReleaseInfo.safeParse({ format: 1, version: "3.5.0", kind: "urgent" }).success).toBe(
      false,
    );
    expect(ReleaseInfo.safeParse({ format: 2, version: "3.5.0", kind: "normal" }).success).toBe(
      false,
    );
  });
});

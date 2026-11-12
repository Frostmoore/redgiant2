import { describe, expect, it } from "vitest";
import {
  hostIn,
  hostsInCode,
  MagicManifest,
  vaultEnvName,
  vaultEnvsInCode,
} from "../src/magic-extensions.js";

describe("the hosts a package's code reaches (G38.3), as a table", () => {
  const rows: [string, string, string[]][] = [
    ["a plain URL", 'fetch("https://api.notion.com/v1/search")', ["api.notion.com"]],
    ["with a port", "http://localhost:8080/x", ["localhost"]],
    [
      "through the keychain (js)",
      "fetch(`${process.env.REDGIANT_VAULT_NOTION}/api.notion.com/v1`)",
      ["api.notion.com"],
    ],
    [
      "through the keychain (shell)",
      'curl "$REDGIANT_VAULT_GH/api.github.com/user"',
      ["api.github.com"],
    ],
    [
      "through the keychain (python)",
      'os.environ["REDGIANT_VAULT_X"] + "/api.x.test/v2"',
      ["api.x.test"],
    ],
    ["schemas are not hosts", '{"$schema": "http://json-schema.org/draft-07/schema#"}', []],
    ["upper case", "HTTPS://API.Example.COM/a", ["api.example.com"]],
    ["nothing", "console.log(1)", []],
  ];
  for (const [name, code, hosts] of rows)
    it(name, () => expect(hostsInCode([code])).toEqual(hosts));

  it("reads the keychain names the code uses", () => {
    expect(vaultEnvsInCode(["$REDGIANT_VAULT_NOTES_API/x", "REDGIANT_VAULT_GH"])).toEqual([
      "GH",
      "NOTES_API",
    ]);
    expect(vaultEnvName("notes-api")).toBe("NOTES_API");
  });

  it("matches hosts and their subdomains", () => {
    expect(hostIn("api.notion.com", ["*.notion.com"])).toBe(true);
    expect(hostIn("notion.com", ["*.notion.com"])).toBe(false);
    expect(hostIn("api.notion.com", ["api.notion.com"])).toBe(true);
  });

  it("a manifest without hosts or parts is read with its defaults; bad names are refused", () => {
    expect(MagicManifest.parse({ name: "notes", title: "N", summary: "S" })).toMatchObject({
      hosts: [],
      credentials: [],
      tools: [],
      skills: [],
    });
    expect(MagicManifest.safeParse({ name: "Notes!", title: "N", summary: "S" }).success).toBe(
      false,
    );
    expect(
      MagicManifest.safeParse({
        name: "notes",
        title: "N",
        summary: "S",
        credentials: [{ name: "Bad Name", service: "x" }],
      }).success,
    ).toBe(false);
  });
});

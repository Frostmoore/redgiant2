// RedGiant OS (G39.1): the pinned stack (stack.mjs), and the update gate of the OS's updater
// (redgiant-os-update, bash) checked against assessRelease, the rule it mirrors.
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const osLib = (name: string) =>
  fileURLToPath(new URL(`../rootfs/usr/lib/redgiant-os/${name}`, import.meta.url));
const bash = process.platform !== "win32" && spawnSync("bash", ["--version"]).status === 0;

describe("the local CA signs only private addresses (redgiant-tls private)", () => {
  it.each([
    ["10.0.2.15", true],
    ["192.168.1.20", true],
    ["172.16.0.1", true],
    ["172.31.255.1", true],
    ["172.32.0.1", false],
    ["172.15.0.1", false],
    ["100.64.0.1", true],
    ["100.128.0.1", false],
    ["169.254.10.1", true],
    ["127.0.0.1", true],
    ["8.8.8.8", false],
    ["::1", true],
    ["fd12:3456::1", true],
    ["[fe80::1]", true],
    ["2001:db8::1", false],
  ])("%s", { skip: !bash }, (address, yes) => {
    expect(spawnSync("bash", [osLib("redgiant-tls"), "private", address]).status === 0).toBe(yes);
  });
});

describe("redgiant-wifi.txt as people write it (redgiant-wifi-file parse)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-wifi-file-"));
  const b = (s: string) => Buffer.from(s).toString("base64");
  it.each([
    ["one network", "ssid=Casa\npassword=12345678\n", [`${b("Casa")} ${b("12345678")} visible`]],
    [
      "Notepad: BOM, CR LF, spaces around =",
      "﻿# mine\r\nSSID = Casa Rossi\r\nPassword = la mia password\r\n",
      [`${b("Casa Rossi")} ${b("la mia password")} visible`],
    ],
    [
      "quotes keep the spaces",
      'ssid="Bar "\npassword=" ab cd ef "\n',
      [`${b("Bar ")} ${b(" ab cd ef ")} visible`],
    ],
    ["an open network", "ssid=Libera\n", [`${b("Libera")} - visible`]],
    [
      "a hidden one",
      "ssid=Nascosta\npassword=12345678\nhidden=yes\n",
      [`${b("Nascosta")} ${b("12345678")} hidden`],
    ],
    [
      "two networks",
      "ssid=A\npassword=11111111\n\nssid=B\npsk=22222222\n",
      [`${b("A")} ${b("11111111")} visible`, `${b("B")} ${b("22222222")} visible`],
    ],
    ["the example left empty", "# comments\nssid=\npassword=\n", []],
    ["no last newline", "ssid=Casa\npassword=12345678", [`${b("Casa")} ${b("12345678")} visible`]],
    [
      "a password with = inside",
      "ssid=Casa\npassword=a=b=c=d=e\n",
      [`${b("Casa")} ${b("a=b=c=d=e")} visible`],
    ],
  ])("%s", { skip: !bash }, (name, text, lines) => {
    const file = join(dir, `${name.replace(/\W+/g, "-")}.txt`);
    writeFileSync(file, text);
    const out = execFileSync("bash", [osLib("redgiant-wifi-file"), "parse", file], {
      encoding: "utf8",
    });
    expect(out.split("\n").filter(Boolean)).toEqual(lines);
  });
});

describe("redgiant.local only on the real network cards (redgiant-mdns, p3.7.2)", () => {
  const sys = mkdtempSync(join(tmpdir(), "rg-mdns-sys-"));
  for (const n of [
    "lo",
    "eth0",
    "enp3s0",
    "wlan0",
    "docker0",
    "br-1a2b3c",
    "veth12ab",
    "tailscale0",
  ])
    mkdirSync(join(sys, "class/net", n), { recursive: true });
  const mdns = osLib("redgiant-mdns");

  it("lists the cards, never Docker's, loopback or a VPN", { skip: !bash }, () => {
    const out = execFileSync("bash", [mdns, "interfaces", sys], { encoding: "utf8" });
    expect(out.split("\n").filter(Boolean)).toEqual(["enp3s0", "eth0", "wlan0"]);
  });

  it("writes them and the IPv4 settings into avahi's [server], keeping the rest", {
    skip: !bash,
  }, () => {
    const conf = join(mkdtempSync(join(tmpdir(), "rg-mdns-conf-")), "avahi-daemon.conf");
    writeFileSync(
      conf,
      [
        "[server]",
        "#host-name=foo",
        "use-ipv4=yes",
        "use-ipv6=yes",
        "#allow-interfaces=eth0",
        "deny-interfaces=docker0",
        "ratelimit-interval-usec=1000000",
        "",
        "[publish]",
        "#publish-aaaa-on-ipv4=yes",
        "publish-hinfo=no",
        "",
      ].join("\n"),
    );
    execFileSync("bash", [mdns, "configure", conf, sys]);
    execFileSync("bash", [mdns, "configure", conf, sys]);
    const text = readFileSync(conf, "utf8");
    expect(text.split("\n").filter((l) => l.startsWith("allow-interfaces="))).toEqual([
      "allow-interfaces=enp3s0,eth0,wlan0",
    ]);
    expect(text).not.toMatch(/deny-interfaces/);
    expect(text).toContain("publish-a-on-ipv6=no");
    expect(text).toContain("#host-name=foo");
    expect(text).toContain("ratelimit-interval-usec=1000000");
    expect(text).toContain("publish-hinfo=no");
    expect(text.match(/^use-ipv4=yes$/gm)).toHaveLength(1);
    expect(text.indexOf("allow-interfaces")).toBeLessThan(text.indexOf("[publish]"));
    expect(text.indexOf("publish-aaaa-on-ipv4=no")).toBeGreaterThan(text.indexOf("[publish]"));
    expect(text).not.toContain("#publish-aaaa-on-ipv4=yes");
  });
});

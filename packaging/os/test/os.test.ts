// RedGiant OS (G39.1): the pinned stack (stack.mjs), and the update gate of the OS's updater
// (redgiant-os-update, bash) checked against assessRelease, the rule it mirrors.
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assessRelease, type ReleaseInfo } from "../../../packages/protocol/src/release.js";
// @ts-expect-error plain JavaScript, no types
import { checkSignature, signManifest } from "../../update/sign.mjs";
import {
  ALLOWED,
  actionsOf,
  buildFiles,
  checkFiles,
  collectFiles,
  enabledUnits,
  KEEP,
  // @ts-expect-error plain JavaScript, no types
} from "../files.mjs";
import {
  archiveDifferences,
  filesDifferences,
  stackDifferences,
  // @ts-expect-error plain JavaScript, no types
} from "../reuse.mjs";
// @ts-expect-error plain JavaScript, no types
import { checkStack, platformDigests, STACK_FILES, stackImages } from "../stack.mjs";

type FileEntry = { path: string; sha256: string; mode: string; board?: string; after?: string[] };
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

  it("reads a branch's images under their own tag, keeping the release's references (3.7.4)", () => {
    const images = stackImages("3.7.4", "ci-3.7.4-abc");
    expect(images.map((i: { source: string }) => i.source)).toEqual([
      "ci-3.7.4-abc",
      "ci-3.7.4-abc",
    ]);
    expect(images.map((i: { tag: string }) => i.tag)).toEqual(["3.7.4", "17-pgvector0.8.7"]);
    expect(stackImages("3.7.4").map((i: { source: string }) => i.source)).toEqual([
      "3.7.4",
      "17-pgvector0.8.7",
    ]);
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

// The release reuses an os.yml run's images only when they carry the release's own stack and files.
describe("reusing a branch's OS images (reuse.mjs, 3.7.4)", () => {
  it.each([
    ["the same stack", stack(), []],
    ["another version", stack({ version: "3.7.1" }), ["version 3.7.1 is not 3.7.0"]],
    [
      "another image",
      stack({
        images: {
          amd64: [image({ digest: digest("d") })],
          arm64: [image({ digest: digest("c") })],
        },
      }),
      [`amd64 redgiant: digest ${digest("d")} is not ${digest("a")}`],
    ],
    [
      "another image id",
      stack({
        images: { amd64: [image()], arm64: [image({ digest: digest("c"), id: digest("e") })] },
      }),
      [`arm64 redgiant: id ${digest("e")} is not ${digest("b")}`],
    ],
    [
      "a reference to another tag",
      stack({
        images: {
          amd64: [image({ ref: "ghcr.io/frostmoore/redgiant2:ci-3.7.0-abc" })],
          arm64: [image({ digest: digest("c") })],
        },
      }),
      [
        "amd64 redgiant: ref ghcr.io/frostmoore/redgiant2:ci-3.7.0-abc is not ghcr.io/frostmoore/redgiant2:3.7.0",
      ],
    ],
    [
      "no arm64 image",
      stack({ images: { amd64: [image()], arm64: [] } }),
      ["arm64: 0 images, not 1", "arm64: no redgiant"],
    ],
    [
      "another compose file",
      stack({ files: { "compose.yaml": "services: {x: {}}\n" } }),
      ["file compose.yaml differs"],
    ],
  ])("%s", (_name, got, problems) => {
    expect(stackDifferences(stack(), got)).toEqual(problems);
  });

  const files = (o: Record<string, unknown> = {}) => ({
    format: 1,
    version: "3.7.4",
    archive: { name: "redgiant-os-files-3.7.4.tar.zst", sha256: "a".repeat(64) },
    files: [
      { path: "/etc/caddy/Caddyfile", sha256: "1".repeat(64), mode: "0644" },
      {
        path: "/etc/systemd/network/70-c.network",
        sha256: "2".repeat(64),
        mode: "0644",
        board: "lxc",
      },
    ],
    ...o,
  });
  it("compares the system's files entry by entry, the archive's own sha256 left out", () => {
    expect(
      filesDifferences(
        files(),
        files({ archive: { name: "redgiant-os-files-3.7.4.tar.zst", sha256: "b".repeat(64) } }),
      ),
    ).toEqual([]);
    expect(filesDifferences(files(), files({ version: "3.7.3" }))).toContain(
      "files version 3.7.3 is not 3.7.4",
    );
    const changed = files();
    changed.files[0] = { ...changed.files[0], sha256: "3".repeat(64) };
    expect(filesDifferences(files(), changed)).toEqual([":/etc/caddy/Caddyfile differs"]);
    const more = files();
    more.files.push({ path: "/etc/iwd/main.conf", sha256: "4".repeat(64), mode: "0644" });
    expect(filesDifferences(files(), more)).toEqual([":/etc/iwd/main.conf is not the release's"]);
    expect(filesDifferences(files(), files({ files: [files().files[1]] }))).toEqual([
      "no :/etc/caddy/Caddyfile",
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "checks the archive against its manifest, blob by blob",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "rg-os-reuse-test-"));
      const m = buildFiles("3.7.4", dir);
      expect(archiveDifferences(m, dir)).toEqual([]);
      expect(
        archiveDifferences({ ...m, archive: { ...m.archive, sha256: "0".repeat(64) } }, dir),
      ).toEqual(["the archive is not its manifest's"]);
      const extra = {
        ...m,
        files: [...m.files, { path: "/etc/iwd/x", sha256: "5".repeat(64), mode: "0644" }],
      };
      expect(archiveDifferences(extra, dir)).toEqual([`no blob ${"5".repeat(64)}`]);
      expect(
        archiveDifferences({ ...m, archive: { ...m.archive, name: "nothing.tar.zst" } }, dir),
      ).toEqual(["no nothing.tar.zst"]);
    },
  );
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
  // The bonding driver's file sits among the cards: not one.
  writeFileSync(join(sys, "class/net", "bonding_masters"), "");
  const mdns = osLib("redgiant-mdns");

  // check with fake programs: the route, the card's addresses, avahi's name and its answer.
  const fakes = (o: { name: string; resolves: string }) => {
    const bin = mkdtempSync(join(tmpdir(), "rg-mdns-bin-"));
    const put = (n: string, text: string) => writeFileSync(join(bin, n), text, { mode: 0o755 });
    put(
      "ip",
      `#!/bin/sh\ncase "$*" in\n  *route*) echo "default via 10.0.2.2 dev enp0s2 proto dhcp src 10.0.2.15 metric 100" ;;\n  *addr*) echo "2: enp0s2    inet 10.0.2.15/24 brd 10.0.2.255 scope global dynamic enp0s2" ;;\nesac\n`,
    );
    put("busctl", `#!/bin/sh\necho 's "${o.name}"'\n`);
    put(
      "avahi-resolve",
      `#!/bin/sh\n[ "$3" = "${o.name}" ] && printf '%s\\t%s\\n' "$3" "${o.resolves}"\n`,
    );
    put("hostname", "#!/bin/sh\necho wrong\n");
    put("sleep", "#!/bin/sh\nexit 0\n");
    return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  };

  it("checks the name avahi publishes against the main card's IPv4, and says why not", {
    skip: !bash,
  }, () => {
    const ok = spawnSync("bash", [mdns, "check"], {
      env: fakes({ name: "redgiant-2.local", resolves: "10.0.2.15" }),
      encoding: "utf8",
    });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("redgiant-2.local is 10.0.2.15 on enp0s2");
    const bad = spawnSync("bash", [mdns, "check"], {
      env: fakes({ name: "redgiant.local", resolves: "172.17.0.1" }),
      encoding: "utf8",
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain(
      "redgiant.local resolves to '172.17.0.1', not an IPv4 of enp0s2 (10.0.2.15)",
    );
  });

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

describe("the system's files of a release (files.mjs, p3.7.3)", () => {
  const all = collectFiles();
  const entry = (path: string) =>
    all.map((f: { entry: FileEntry }) => f.entry).find((e: FileEntry) => e.path === path);

  it("lists every file of the system from the repository, never the machine's own", () => {
    const paths = all.map((f: { entry: FileEntry }) => f.entry.path);
    expect(paths).toContain("/usr/lib/redgiant-os/redgiant-os-update");
    expect(paths).toContain("/etc/systemd/system/caddy.service.d/redgiant.conf");
    expect(paths).toContain("/usr/lib/systemd/system/redgiant-helper.socket");
    expect(paths).not.toContain("/etc/issue.d/50-redgiant.issue");
    expect(paths).not.toContain("/etc/redgiant-os/os.conf");
    expect(entry("/usr/lib/redgiant/redgiant-helper")?.mode).toBe("0755");
    expect(entry("/usr/lib/redgiant-os/redgiant-selftest-wifi")?.mode).toBe("0755");
    expect(entry("/usr/lib/redgiant-os/common.sh")?.mode).toBe("0644");
    expect(entry("/etc/sudoers.d/redgiant")?.mode).toBe("0440");
    expect(entry("/etc/systemd/network/70-redgiant-container.network")?.board).toBe("lxc");
    expect(entry("/etc/caddy/Caddyfile")?.board).toBeUndefined();
  });

  it.each([
    [
      "/etc/systemd/system/caddy.service.d/redgiant.conf",
      ["daemon-reload", "reload caddy.service"],
    ],
    ["/etc/systemd/system/getty@.service.d/after-network.conf", ["daemon-reload"]],
    [
      "/usr/lib/systemd/system/redgiant-tls.timer",
      ["daemon-reload", "enable redgiant-tls.timer", "reload redgiant-tls.timer"],
    ],
    ["/usr/lib/systemd/system/redgiant.service", ["daemon-reload", "enable redgiant.service"]],
    ["/usr/lib/systemd/system/redgiant-os-update.service", ["daemon-reload"]],
    ["/usr/lib/systemd/system/redgiant-helper@.service", ["daemon-reload"]],
    ["/etc/systemd/network/80-redgiant-wired.network", ["network-reload"]],
    ["/etc/systemd/resolved.conf.d/redgiant.conf", ["restart systemd-resolved.service"]],
    ["/etc/avahi/services/redgiant.service", ["reload avahi-daemon.service"]],
    ["/etc/ssh/sshd_config.d/10-redgiant.conf", ["reload ssh.service"]],
    ["/etc/docker/daemon.json", []],
    ["/usr/lib/redgiant-os/redgiant-stack", []],
  ])("after %s", (path, after) => {
    expect(actionsOf(path, enabledUnits())).toEqual(after);
  });

  it("enables what the image enables", () => {
    const units = enabledUnits();
    expect(units.has("redgiant.service")).toBe(true);
    expect(units.has("redgiant-helper.socket")).toBe(true);
    expect(units.has("apt-daily-upgrade.timer")).toBe(true);
    expect(units.has("ssh.service")).toBe(false);
  });

  it("allows the same folders as the updater", () => {
    const text = readFileSync(updater, "utf8");
    const re = new RegExp(/^FILES_ALLOWED='([^']*)'/m.exec(text)?.[1] ?? "$^");
    const keep = new RegExp(/^FILES_KEEP='([^']*)'/m.exec(text)?.[1] ?? "$^");
    for (const a of ALLOWED) expect(re.test(`${a}x`), a).toBe(true);
    for (const k of KEEP) expect(keep.test(k), k).toBe(true);
    for (const p of [
      "/etc/passwd",
      "/usr/bin/sh",
      "/etc/systemd-evil/x",
      "/root/.ssh/authorized_keys",
    ])
      expect(re.test(p), p).toBe(false);
  });

  const manifest = (o: Record<string, unknown> = {}, file: Record<string, unknown> = {}) => ({
    format: 1,
    version: "3.7.3",
    archive: { name: "redgiant-os-files-3.7.3.tar.zst", sha256: "a".repeat(64) },
    files: [{ path: "/usr/lib/redgiant-os/x", sha256: "b".repeat(64), mode: "0755", ...file }],
    ...o,
  });
  it.each([
    ["a good manifest", manifest(), null],
    ["another format", manifest({ format: 2 }), "format"],
    [
      "another archive",
      manifest({ archive: { name: "x.tar", sha256: "a".repeat(64) } }),
      "archive",
    ],
    ["a climb out", manifest({}, { path: "/usr/lib/redgiant-os/../../../etc/shadow" }), "path"],
    ["outside the system's folders", manifest({}, { path: "/etc/passwd" }), "outside"],
    ["the login text", manifest({}, { path: "/etc/issue.d/50-redgiant.issue" }), "outside"],
    ["the administrator's settings", manifest({}, { path: "/etc/redgiant-os/os.conf" }), "outside"],
    ["a setuid mode", manifest({}, { mode: "4755" }), "mode"],
    ["a strange action", manifest({}, { after: ["reboot"] }), "action"],
    ["a command in a unit", manifest({}, { after: ["reload x.service; rm -rf /"] }), "action"],
    [
      "the same file twice",
      manifest({
        files: [
          { path: "/etc/caddy/Caddyfile", sha256: "b".repeat(64), mode: "0644" },
          { path: "/etc/caddy/Caddyfile", sha256: "c".repeat(64), mode: "0644" },
        ],
      }),
      "twice",
    ],
  ])("%s", (_name, m, error) => {
    if (error) expect(() => checkFiles(m)).toThrow(error as string);
    else expect(checkFiles(m)).toBe(m);
  });
});

// The updater's own install of the files, on a fake root with fake systemctl, networkctl and zstd
// (GNU tar, sha256sum, stat and tac: Linux only, as the OS).
const linuxTools = process.platform === "linux" && tools;
describe("redgiant-os-update files: signed, checked, put back on a failure", () => {
  type Machine = { root: string; dir: string; key: string; log: string; env: NodeJS.ProcessEnv };
  const repo = mkdtempSync(join(tmpdir(), "rg-os-files-repo-"));
  const put = (base: string, path: string, text: string, mode = 0o644) => {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), text, { mode });
  };
  put(repo, "packaging/os/setup-chroot.sh", "systemctl enable a.service \\\n  b.timer\n");
  put(repo, "packaging/os/rootfs/usr/lib/redgiant-os/redgiant-tool", "#!/bin/sh\necho new\n");
  put(
    repo,
    "packaging/os/rootfs/usr/lib/systemd/system/a.service",
    "[Service]\nExecStart=/bin/true\n",
  );
  put(repo, "packaging/os/rootfs/usr/lib/systemd/system/b.timer", "[Timer]\nOnCalendar=daily\n");
  put(repo, "packaging/os/rootfs/etc/caddy/Caddyfile", ":443 {}\n");
  put(repo, "packaging/os/rootfs/etc/issue.d/50-redgiant.issue", "from the repository\n");
  put(
    repo,
    "packaging/os/lxc/rootfs/etc/systemd/network/70-redgiant-container.network",
    "[Match]\n",
  );
  put(repo, "packages/server/helpers/redgiant-helper", "#!/bin/sh\necho helper\n", 0o755);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();

  const machine = (o: { failReload?: boolean; masked?: string } = {}): Machine => {
    const root = mkdtempSync(join(tmpdir(), "rg-os-files-root-"));
    const dir = mkdtempSync(join(tmpdir(), "rg-os-files-work-"));
    buildFiles("3.7.3", dir, repo);
    writeFileSync(
      join(dir, "redgiant-os-files.json.sig"),
      signManifest(readFileSync(join(dir, "redgiant-os-files.json")), pem),
    );
    const key = join(dir, "key.pem");
    writeFileSync(key, pub);
    // What the machine has: an old tool, the same Caddyfile, its own login text.
    put(root, "usr/lib/redgiant-os/redgiant-tool", "#!/bin/sh\necho old\n", 0o755);
    put(root, "etc/caddy/Caddyfile", ":443 {}\n");
    put(root, "etc/issue.d/50-redgiant.issue", "RedGiant: http://10.0.0.5:7600\n");
    const bin = mkdtempSync(join(tmpdir(), "rg-os-files-bin-"));
    const log = join(bin, "calls.log");
    const fake = (n: string, text: string) => writeFileSync(join(bin, n), text, { mode: 0o755 });
    fake(
      "systemctl",
      `#!/bin/sh\necho "systemctl $*" >>"${log}"\ncase "$1" in\n  is-enabled) [ "$2" = "${o.masked ?? "-"}" ] && echo masked || echo disabled ;;\n  try-reload-or-restart) ${o.failReload ? "exit 1" : "exit 0"} ;;\nesac\nexit 0\n`,
    );
    fake("networkctl", `#!/bin/sh\necho "networkctl $*" >>"${log}"\n`);
    writeFileSync(
      join(bin, "unzstd.cjs"),
      "process.stdout.write(require('node:zlib').zstdDecompressSync(require('node:fs').readFileSync(process.argv[2])));\n",
    );
    fake(
      "zstd",
      `#!/bin/sh\n[ "$1" = -dc ] || exit 2\nexec "${process.execPath}" "${bin}/unzstd.cjs" "$2"\n`,
    );
    return { root, dir, key, log, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
  };
  const run = (m: Machine) =>
    spawnSync("bash", [updater, "files", m.dir, m.root, m.key], { env: m.env, encoding: "utf8" });
  const read = (m: Machine, p: string) => readFileSync(join(m.root, p), "utf8");
  const calls = (m: Machine) =>
    existsSync(m.log) ? readFileSync(m.log, "utf8").trim().split("\n") : [];
  const modeOfFile = (m: Machine, p: string) =>
    (statSync(join(m.root, p)).mode & 0o777).toString(8);

  it("installs what changed with its mode, runs the actions once, leaves the rest", {
    skip: !linuxTools,
  }, () => {
    const m = machine();
    const r = run(m);
    expect(r.status, r.stderr).toBe(0);
    expect(read(m, "usr/lib/redgiant-os/redgiant-tool")).toContain("echo new");
    expect(modeOfFile(m, "usr/lib/redgiant-os/redgiant-tool")).toBe("755");
    expect(read(m, "usr/lib/redgiant/redgiant-helper")).toContain("helper");
    expect(modeOfFile(m, "usr/lib/redgiant/redgiant-helper")).toBe("755");
    expect(modeOfFile(m, "usr/lib/systemd/system/a.service")).toBe("644");
    expect(read(m, "etc/issue.d/50-redgiant.issue")).toBe("RedGiant: http://10.0.0.5:7600\n");
    // Not a container: the container's own file stays out.
    expect(existsSync(join(m.root, "etc/systemd/network/70-redgiant-container.network"))).toBe(
      false,
    );
    expect(r.stderr).not.toContain("Caddyfile");
    expect(calls(m)).toEqual([
      "systemctl daemon-reload",
      "systemctl is-enabled a.service",
      "systemctl enable a.service",
      "systemctl is-enabled b.timer",
      "systemctl enable b.timer",
      "systemctl try-reload-or-restart b.timer",
    ]);
    const again = run(m);
    expect(again.status).toBe(0);
    expect(again.stderr).toContain("up to date");
  });

  it("brings a container its own files, and leaves a masked unit masked", {
    skip: !linuxTools,
  }, () => {
    const m = machine({ masked: "a.service" });
    put(m.root, "usr/share/redgiant-os/board", "lxc\n");
    expect(run(m).status).toBe(0);
    expect(read(m, "etc/systemd/network/70-redgiant-container.network")).toBe("[Match]\n");
    expect(calls(m)).toContain("networkctl reload");
    expect(calls(m)).not.toContain("systemctl enable a.service");
  });

  it("applies nothing without the right signature", { skip: !linuxTools }, () => {
    const m = machine();
    writeFileSync(
      join(m.dir, "redgiant-os-files.json.sig"),
      signManifest(Buffer.from("other"), pem),
    );
    const r = run(m);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not signed");
    expect(read(m, "usr/lib/redgiant-os/redgiant-tool")).toContain("echo old");
    expect(calls(m)).toEqual([]);
  });

  it("applies nothing from an archive that is not the one signed", { skip: !linuxTools }, () => {
    const m = machine();
    const archive = join(m.dir, "redgiant-os-files-3.7.3.tar.zst");
    writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from("x")]));
    const r = run(m);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not the one signed");
    expect(read(m, "usr/lib/redgiant-os/redgiant-tool")).toContain("echo old");
  });

  it("refuses a signed manifest that writes outside the system's folders", {
    skip: !linuxTools,
  }, () => {
    const m = machine();
    const file = join(m.dir, "redgiant-os-files.json");
    const bad = JSON.parse(readFileSync(file, "utf8"));
    bad.files[0].path = "/etc/passwd";
    writeFileSync(file, JSON.stringify(bad));
    writeFileSync(`${file}.sig`, signManifest(readFileSync(file), pem));
    const r = run(m);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refused path /etc/passwd");
    expect(existsSync(join(m.root, "etc/passwd"))).toBe(false);
  });

  it("puts the old files back when the system does not take the new ones", {
    skip: !linuxTools,
  }, () => {
    const m = machine({ failReload: true });
    const r = run(m);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("previous system files are back");
    expect(read(m, "usr/lib/redgiant-os/redgiant-tool")).toBe("#!/bin/sh\necho old\n");
    expect(modeOfFile(m, "usr/lib/redgiant-os/redgiant-tool")).toBe("755");
    expect(existsSync(join(m.root, "usr/lib/redgiant/redgiant-helper"))).toBe(false);
    expect(existsSync(join(m.root, "usr/lib/systemd/system/a.service"))).toBe(false);
    const c = calls(m);
    expect(c).toContain("systemctl disable a.service");
    expect(c).toContain("systemctl disable b.timer");
    // systemd reads the old files again.
    expect(c.filter((l) => l === "systemctl daemon-reload")).toHaveLength(2);
  });
});

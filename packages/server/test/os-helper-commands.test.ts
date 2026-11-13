// The OS helper's Wi-Fi, HTTPS, update and restart commands (RedGiant OS), run for real with
// fake programs: busctl answers as iwd would, systemctl and systemd-run only write down what
// they were asked. Every program that could touch the machine is faked (the helper puts the
// fakes first in its PATH only when REDGIANT_HELPER_TEST_BIN is set, which sudo and the socket
// unit never pass).
import { execFile, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const helper = fileURLToPath(new URL("../helpers/redgiant-helper", import.meta.url));
const tls = fileURLToPath(
  new URL("../../../packaging/os/rootfs/usr/lib/redgiant-os/redgiant-tls", import.meta.url),
);
// RedGiant OS's helper is Linux's (GNU base64, ip…): macOS's tools differ.
const tools =
  process.platform === "linux" &&
  ["jq", "base64", "openssl"].every((c) => spawnSync("sh", ["-c", `command -v ${c}`]).status === 0);

const b64 = (s: string) => Buffer.from(s).toString("base64");

/** iwd's objects as `busctl --json=short call … GetManagedObjects` prints them. */
function objects(
  networks: { name: string; type?: string; connected?: boolean; known?: boolean }[],
) {
  const v = (type: string, data: unknown) => ({ type, data });
  const data: Record<string, Record<string, Record<string, unknown>>> = {
    "/net/connman/iwd/0": { "net.connman.iwd.Adapter": { Powered: v("b", true) } },
    "/net/connman/iwd/0/3": {
      "net.connman.iwd.Device": { Name: v("s", "wlan0"), Powered: v("b", true) },
      "net.connman.iwd.Station": { State: v("s", "disconnected"), Scanning: v("b", false) },
    },
  };
  networks.forEach((n, i) => {
    data[`/net/connman/iwd/0/3/${i}_${n.type ?? "psk"}`] = {
      "net.connman.iwd.Network": {
        Name: v("s", n.name),
        Type: v("s", n.type ?? "psk"),
        Connected: v("b", n.connected ?? false),
        Device: v("o", "/net/connman/iwd/0/3"),
      },
    };
    if (n.known)
      data[`/net/connman/iwd/known/${i}`] = {
        "net.connman.iwd.KnownNetwork": { Name: v("s", n.name), Type: v("s", n.type ?? "psk") },
      };
  });
  return JSON.stringify({ type: "a{oa{sa{sv}}}", data: [data] });
}

const FAKE_BUSCTL = `#!/bin/sh
D="$REDGIANT_HELPER_TEST_ROOT/fake"
echo "busctl $*" >>"$D/calls"
case "$*" in
  *GetManagedObjects*) cat "$D/objects.json" ;;
  *GetOrderedNetworks*) echo '{"type":"a(on)","data":[[["/net/connman/iwd/0/3/0_psk",-4500]]]}' ;;
  *get-property*Scanning*) echo '{"type":"b","data":false}' ;;
  *"Network Connect"* | *ConnectHiddenNetwork*)
    [ -e "$D/refuse" ] && { echo "Call failed: Operation failed" >&2; exit 1; }
    exit 0 ;;
  *) exit 0 ;;
esac
`;
const RECORD = (name: string) => `#!/bin/sh
echo "${name} $*" >>"$REDGIANT_HELPER_TEST_ROOT/fake/calls"
case "$*" in *is-active*caddy* | *is-enabled*caddy*) exit 0 ;; *is-active*) exit 3 ;; esac
case "$*" in *ExecMainExitTimestamp*) echo "@1762920000" ;; *"-P Result"*) echo success ;; esac
exit 0
`;

let root: string;
let bin: string;
const fake = (f: string) => join(root, "fake", f);
const calls = () => (existsSync(fake("calls")) ? readFileSync(fake("calls"), "utf8") : "");

function ask(line: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const p = execFile(
      "sh",
      [helper, "--stdin"],
      {
        env: {
          ...process.env,
          REDGIANT_HELPER_TEST_BIN: bin,
          REDGIANT_HELPER_TEST_ROOT: root,
        },
        timeout: 30_000,
      },
      (_err, out) => {
        try {
          resolve(JSON.parse(String(out).trim().split("\n").at(-1) ?? ""));
        } catch {
          reject(new Error(`not JSON: ${out}`));
        }
      },
    );
    p.stdin?.end(`${line}\n`);
  });
}

describe("the helper's Wi-Fi commands", { skip: !tools }, () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rg-helper-"));
    bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(join(root, "fake"));
    const put = (name: string, text: string) => {
      writeFileSync(join(bin, name), text);
      chmodSync(join(bin, name), 0o755);
    };
    put("busctl", FAKE_BUSCTL);
    for (const p of ["systemctl", "systemd-run", "rfkill", "shutdown", "reboot", "iwctl"])
      put(p, RECORD(p));
    put("ip", "#!/bin/sh\necho '[]'\n");
    put("sleep", "#!/bin/sh\nexit 0\n");
    writeFileSync(fake("objects.json"), objects([{ name: "Casa Rossi" }, { name: "Bar" }]));
  });
  const psk = (name: string) => join(root, "var/lib/iwd", `${name}.psk`);

  it("connects, keeping the password only in iwd's own file (0600)", async () => {
    const r = await ask(`wifi-connect ${b64("Casa Rossi")} ${b64("una password lunga")} visible`);
    expect(r).toEqual({ ok: true, state: "connected" });
    expect(readFileSync(psk("Casa Rossi"), "utf8")).toBe(
      "[Security]\nPassphrase=una password lunga\n",
    );
    expect(statSync(psk("Casa Rossi")).mode & 0o777).toBe(0o600);
    expect(calls()).toContain("Network Connect");
    // Never in any program's arguments.
    expect(calls()).not.toContain("una password lunga");
    expect(calls()).not.toContain(b64("una password lunga"));
  });

  it("names a network's file as iwd does: '=' and hex for other characters", async () => {
    writeFileSync(fake("objects.json"), objects([{ name: "Caffè & Co" }]));
    await ask(`wifi-connect ${b64("Caffè & Co")} ${b64("12345678")} visible`);
    const hex = Buffer.from("Caffè & Co").toString("hex");
    expect(existsSync(join(root, "var/lib/iwd", `=${hex}.psk`))).toBe(true);
  });

  it("stores a 64-digit key as the key itself", async () => {
    const key = "a".repeat(64);
    await ask(`wifi-connect ${b64("Bar")} ${b64(key)} visible`);
    expect(readFileSync(psk("Bar"), "utf8")).toBe(`[Security]\nPreSharedKey=${key}\n`);
  });

  it("leaves nothing saved when the network refuses the password", async () => {
    writeFileSync(fake("objects.json"), objects([{ name: "Casa Rossi", known: true }]));
    writeFileSync(fake("refuse"), "");
    const r = await ask(`wifi-connect ${b64("Casa Rossi")} ${b64("sbagliata!")} visible`);
    expect(r).toMatchObject({ ok: false, error: "connect_failed" });
    expect(calls()).toContain("KnownNetwork Forget");
    expect(existsSync(psk("Casa Rossi"))).toBe(false);
  });

  it("puts back the password that worked before when a new one is refused", async () => {
    await ask(`wifi-connect ${b64("Casa Rossi")} ${b64("quella buona")} visible`);
    writeFileSync(fake("refuse"), "");
    await ask(`wifi-connect ${b64("Casa Rossi")} ${b64("quella nuova")} visible`);
    expect(readFileSync(psk("Casa Rossi"), "utf8")).toContain("Passphrase=quella buona");
  });

  it("keeps a network from redgiant-wifi.txt even when it is not in reach yet", async () => {
    writeFileSync(fake("objects.json"), objects([]));
    const r = await ask(`wifi-connect ${b64("Lontana")} ${b64("12345678")} visible keep`);
    expect(r).toEqual({ ok: true, state: "saved" });
    expect(existsSync(psk("Lontana"))).toBe(true);
    // Without "keep" (the page), a network not in reach is an error and nothing stays.
    const r2 = await ask(`wifi-connect ${b64("Altra")} ${b64("12345678")} visible`);
    expect(r2).toEqual({ ok: false, error: "not_found" });
    expect(existsSync(psk("Altra"))).toBe(false);
  });

  it("joins a hidden network by name, and an open one without a password", async () => {
    await ask(`wifi-connect ${b64("Nascosta")} ${b64("12345678")} hidden`);
    expect(readFileSync(psk("Nascosta"), "utf8")).toBe(
      "[Settings]\nHidden=true\n\n[Security]\nPassphrase=12345678\n",
    );
    expect(calls()).toContain("ConnectHiddenNetwork s Nascosta");
    writeFileSync(fake("objects.json"), objects([{ name: "Libera", type: "open" }]));
    expect(await ask(`wifi-connect ${b64("Libera")} - visible`)).toEqual({
      ok: true,
      state: "connected",
    });
    expect(readFileSync(join(root, "var/lib/iwd/Libera.open"), "utf8")).toBe("");
  });

  it.each([
    [
      "a password too short",
      `wifi-connect ${b64("Bar")} ${b64("1234567")} visible`,
      "bad_password",
    ],
    [
      "a password too long",
      `wifi-connect ${b64("Bar")} ${b64("x".repeat(64))} visible`,
      "bad_password",
    ],
    [
      "a password with a newline",
      `wifi-connect ${b64("Bar")} ${b64("12345678\nx")} visible`,
      "bad_password",
    ],
    [
      "a name too long",
      `wifi-connect ${b64("n".repeat(33))} ${b64("12345678")} visible`,
      "bad_ssid",
    ],
    [
      "a name with a control character",
      `wifi-connect ${b64("a\tb")} ${b64("12345678")} visible`,
      "bad_ssid",
    ],
    ["not base64", "wifi-connect *** x visible", "bad_request"],
    ["no mode", `wifi-connect ${b64("Bar")} ${b64("12345678")}`, "bad_request"],
    ["another mode", `wifi-connect ${b64("Bar")} ${b64("12345678")} visible always`, "bad_request"],
    ["forget without a name", "wifi-forget", "bad_request"],
    ["status with words", "wifi-status now", "bad_request"],
  ])("refuses %s", async (_name, line, error) => {
    expect(await ask(line)).toEqual({ ok: false, error });
    expect(existsSync(join(root, "var/lib/iwd"))).toBe(false);
  });

  it("forgets a network (iwd, and its file), and says when there is none", async () => {
    await ask(`wifi-connect ${b64("Casa Rossi")} ${b64("una password")} visible`);
    writeFileSync(fake("objects.json"), objects([{ name: "Casa Rossi", known: true }]));
    expect(await ask(`wifi-forget ${b64("Casa Rossi")}`)).toEqual({ ok: true });
    expect(calls()).toContain("KnownNetwork Forget");
    expect(existsSync(psk("Casa Rossi"))).toBe(false);
    writeFileSync(fake("objects.json"), objects([]));
    expect(await ask(`wifi-forget ${b64("Mai vista")}`)).toEqual({ ok: false, error: "not_found" });
  });

  it("scans and gives iwd's objects, the networks by signal and the links", async () => {
    const r = await ask("wifi-scan");
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.objects)).toContain("Casa Rossi");
    expect(r.ordered).toEqual({ type: "a(on)", data: [[["/net/connman/iwd/0/3/0_psk", -4500]]] });
    expect(r.links).toEqual([]);
    expect(calls()).toContain("Station Scan");
    expect(calls()).toContain("rfkill unblock wifi");
  });
});

describe("the helper's HTTPS, update and restart commands", { skip: !tools }, () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rg-helper-"));
    bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(join(root, "fake"));
    for (const p of ["systemctl", "systemd-run", "busctl", "shutdown", "reboot", "timeout"]) {
      writeFileSync(join(bin, p), RECORD(p));
      chmodSync(join(bin, p), 0o755);
    }
  });

  it("gives the CA's certificate and fingerprint, never a key", async () => {
    const dir = join(root, "var/lib/redgiant/tls");
    const r = spawnSync("bash", [tls, "ensure"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REDGIANT_TLS_DIR: dir },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const s = await ask("https-status");
    expect(s.ok).toBe(true);
    expect(s.on).toBe(true);
    const pem = Buffer.from(String(s.ca), "base64").toString();
    expect(pem).toContain("BEGIN CERTIFICATE");
    expect(JSON.stringify(s)).not.toContain("PRIVATE KEY");
    expect(String(s.fingerprint)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(s.names).toContain("redgiant.local");
  });

  it("switches local HTTPS on and off through Caddy's unit", async () => {
    mkdirSync(join(root, "usr/lib/redgiant-os"), { recursive: true });
    writeFileSync(join(root, "usr/lib/redgiant-os/redgiant-tls"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(root, "usr/lib/redgiant-os/redgiant-tls"), 0o755);
    expect(await ask("https-local on")).toEqual({ ok: true });
    expect(await ask("https-local off")).toEqual({ ok: true });
    expect(calls()).toContain("systemctl enable --now caddy.service");
    expect(calls()).toContain("systemctl disable --now caddy.service");
    expect(await ask("https-local maybe")).toEqual({ ok: false, error: "bad_request" });
  });

  it("reads the update's state and the system's security updates", async () => {
    mkdirSync(join(root, "var/lib/redgiant"), { recursive: true });
    writeFileSync(
      join(root, "var/lib/redgiant/os-update.json"),
      JSON.stringify({
        state: "applying",
        installed: "3.7.0",
        latest: "3.7.1",
        gate: "normal",
        step: "download",
      }),
    );
    mkdirSync(join(root, "run"));
    writeFileSync(join(root, "run/reboot-required"), "*** System restart required ***\n");
    writeFileSync(
      join(root, "run/reboot-required.pkgs"),
      "linux-image-6.12.0-1-amd64\nlibc6\nlibc6\n",
    );
    mkdirSync(join(root, "var/log/unattended-upgrades"), { recursive: true });
    writeFileSync(
      join(root, "var/log/unattended-upgrades/unattended-upgrades.log"),
      "2026-11-12 06:00:01,000 INFO Packages that will be upgraded: libc6 openssl linux-image-amd64\n",
    );
    const s = await ask("os-update-status");
    expect(s).toEqual({
      ok: true,
      update: {
        state: "applying",
        installed: "3.7.0",
        latest: "3.7.1",
        gate: "normal",
        step: "download",
      },
      running: false,
      security: {
        lastRun: 1762920000,
        result: "success",
        upgraded: 3,
        rebootRequired: true,
        packages: ["libc6", "linux-image-6.12.0-1-amd64"],
      },
    });
  });

  it("starts the signed updater in the background, and schedules the restart", async () => {
    mkdirSync(join(root, "usr/lib/redgiant-os"), { recursive: true });
    writeFileSync(join(root, "usr/lib/redgiant-os/redgiant-os-update"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(root, "usr/lib/redgiant-os/redgiant-os-update"), 0o755);
    expect(await ask("os-update-apply")).toEqual({ ok: true });
    expect(calls()).toContain("systemctl start --no-block redgiant-os-update.service");
    expect(await ask("reboot")).toEqual({ ok: true, in: 5 });
    expect(calls()).toMatch(/systemd-run --on-active=5 .*\/usr\/bin\/systemctl reboot/);
    expect(await ask("reboot now")).toEqual({ ok: false, error: "bad_request" });
    const c = await ask("os-update-check");
    expect(c.ok).toBe(true);
    expect(calls()).toContain("timeout 50");
  });
});

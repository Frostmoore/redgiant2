// The OS helper (G39.3): the few things RedGiant may ask of the machine it runs on that need
// root, done by a tiny privileged program that checks every request again on its own
// (helpers/redgiant-helper). RedGiant reaches it one of two ways:
//   - REDGIANT_OS_HELPER_SOCKET: a unix socket (RedGiant OS: a systemd socket unit with
//     Accept=yes running `redgiant-helper --stdin` per connection, the socket bound into the
//     server's container);
//   - REDGIANT_OS_HELPER: a command, e.g. "sudo -n /usr/lib/redgiant/redgiant-helper" (an install
//     straight on Linux, with a sudoers line for that one program).
// Without either, nothing here is possible and the page says so (plain Docker, Windows, Mac).
//
// The protocol: one request line, one JSON reply line, `{"ok":true,...}` or
// `{"ok":false,"error":"<code>"}`:
//   list                     → {"container": "lxc"|"none"|…, "lsblk": <lsblk -J -b -o … output>}
//   mount <uuid> <label>     → {"path": "/var/lib/redgiant/backups/<label>"}
//   unmount <label>          → {}
//   place-prepare <name>     → {"path": "/var/lib/redgiant/backups/<name>/RedGiant"} (a folder
//                              the host mounted there: RedGiant's own folder in it)
//   ssh-status               → {"on": bool, "keys": n, "installed": bool, "container": "…"}
//   ssh-on <base64 key line> → {}      (keys only, never passwords)
//   ssh-off                  → {}
//   tailscale                → {"status": <tailscale status --json>}
// RedGiant OS (G39.1):
//   wifi-status, wifi-scan   → {"objects": <iwd's D-Bus objects>, "ordered": …, "links": <ip -j addr>}
//   wifi-connect <base64 ssid> <base64 password|-> <visible|hidden> → {"state": "connected"|"saved"}
//   wifi-forget <base64 ssid> → {}
//   https-status             → {"on", "enabled", "ca": <base64 PEM>|null, "fingerprint", "until", "names"}
//   https-local on|off       → {}
//   os-update-status, os-update-check → {"update": <os-update.json>|null, "running", "security": {…}}
//   os-update-apply          → {}      (redgiant-os-update.service, in the background)
//   reboot                   → {"in": 5}
// A Wi-Fi password travels only base64 in the request line (the line is never logged, here or
// by the helper) and ends in iwd's own file for that network.
import { execFile } from "node:child_process";
import { connect } from "node:net";

export type HelperOp =
  | { op: "list" }
  | { op: "mount"; uuid: string; label: string }
  | { op: "unmount"; label: string }
  | { op: "place-prepare"; name: string }
  | { op: "ssh-status" }
  | { op: "ssh-on"; key: string }
  | { op: "ssh-off" }
  | { op: "tailscale" }
  | { op: "wifi-status" }
  | { op: "wifi-scan" }
  | { op: "wifi-connect"; ssid: string; password: string; hidden?: boolean }
  | { op: "wifi-forget"; ssid: string }
  | { op: "https-status" }
  | { op: "https-local"; on: boolean }
  | { op: "os-update-status" }
  | { op: "os-update-check" }
  | { op: "os-update-apply" }
  | { op: "reboot" };

export class HelperError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

const UUID = /^[A-Fa-f0-9-]{4,36}$/;
const LABEL = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,39}$/;
/** An OpenSSH public key: type, base64 body, an optional comment without line breaks. */
const SSH_KEY =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n]{0,200})?$/;

/** A public key the person pasted, checked: one line, a known type. null when it is not one. */
export function sshPublicKey(text: string): string | null {
  const t = text.trim();
  // One key, one line: a second line would be a second key.
  if (/[\r\n]/.test(t)) return null;
  const k = t.replace(/\s+/g, " ");
  return SSH_KEY.test(k) ? k : null;
}

/** A Wi-Fi network's name: 1 to 32 bytes, no control characters. */
export function wifiSsidOk(ssid: string): boolean {
  const n = Buffer.byteLength(ssid);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  return n >= 1 && n <= 32 && !/[\u0000-\u001f\u007f]/.test(ssid);
}

/** A WPA password: 8 to 63 printable ASCII characters, or the 64 hexadecimal digits of the key. */
export function wifiPasswordOk(password: string): boolean {
  if (/^[0-9a-fA-F]{64}$/.test(password)) return true;
  return /^[\x20-\x7e]{8,63}$/.test(password);
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** The request line for an operation; anything that does not match the rules is refused here. */
export function helperRequest(o: HelperOp): string {
  switch (o.op) {
    case "wifi-connect":
      if (!wifiSsidOk(o.ssid)) throw new HelperError("bad_ssid");
      if (o.password !== "" && !wifiPasswordOk(o.password)) throw new HelperError("bad_password");
      return `wifi-connect ${b64(o.ssid)} ${o.password === "" ? "-" : b64(o.password)} ${o.hidden ? "hidden" : "visible"}`;
    case "wifi-forget":
      if (!wifiSsidOk(o.ssid)) throw new HelperError("bad_ssid");
      return `wifi-forget ${b64(o.ssid)}`;
    case "https-local":
      return `https-local ${o.on ? "on" : "off"}`;
    case "mount":
      if (!UUID.test(o.uuid) || !LABEL.test(o.label)) throw new HelperError("bad_request");
      return `mount ${o.uuid} ${o.label}`;
    case "unmount":
      if (!LABEL.test(o.label)) throw new HelperError("bad_request");
      return `unmount ${o.label}`;
    case "place-prepare":
      if (!LABEL.test(o.name)) throw new HelperError("bad_request");
      return `place-prepare ${o.name}`;
    case "ssh-on": {
      const k = sshPublicKey(o.key);
      if (!k) throw new HelperError("bad_key");
      return `ssh-on ${Buffer.from(k).toString("base64")}`;
    }
    default:
      return o.op;
  }
}

/** The helper's reply line. */
export function parseHelperReply(out: string): Record<string, unknown> {
  const line = out.trim().split("\n").at(-1) ?? "";
  let j: unknown;
  try {
    j = JSON.parse(line);
  } catch {
    throw new HelperError("bad_reply", `The helper answered: ${line.slice(0, 200)}`);
  }
  if (!j || typeof j !== "object") throw new HelperError("bad_reply");
  const r = j as Record<string, unknown>;
  if (r.ok !== true) throw new HelperError(typeof r.error === "string" ? r.error : "failed");
  return r;
}

export interface OsHelper {
  readonly how: "socket" | "command";
  call(o: HelperOp): Promise<Record<string, unknown>>;
}

/** The helper this installation has, from the environment; undefined when there is none. */
export function osHelperFrom(env: NodeJS.ProcessEnv = process.env): OsHelper | undefined {
  const socket = env.REDGIANT_OS_HELPER_SOCKET;
  if (socket) return { how: "socket", call: (o) => viaSocket(socket, helperRequest(o)) };
  const command = env.REDGIANT_OS_HELPER?.trim().split(/\s+/).filter(Boolean);
  if (command?.length) {
    const [file = "", ...args] = command;
    return { how: "command", call: (o) => viaCommand(file, args, helperRequest(o)) };
  }
  return undefined;
}

const TIMEOUT = 60_000;
/** Joining a network (scan, then iwd's 40 s) and the update check (50 s) wait a little longer. */
const LONG = new Set(["wifi-connect", "wifi-scan", "os-update-check"]);
const timeoutFor = (line: string) => (LONG.has(line.split(" ")[0] ?? "") ? 100_000 : TIMEOUT);

function viaSocket(path: string, line: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const s = connect(path);
    let out = "";
    const timer = setTimeout(() => {
      s.destroy();
      reject(new HelperError("timeout"));
    }, timeoutFor(line));
    s.on("connect", () => s.end(`${line}\n`));
    s.on("data", (d) => {
      out += d.toString();
    });
    s.on("error", (err) => {
      clearTimeout(timer);
      reject(new HelperError("unreachable", err.message));
    });
    s.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(parseHelperReply(out));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function viaCommand(file: string, pre: string[], line: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // The request's words as arguments: no shell, and the helper checks them again. A Wi-Fi
    // password is never an argument (any process may read those): that request goes on stdin.
    const secret = line.startsWith("wifi-connect ");
    const child = execFile(
      file,
      secret ? [...pre, "--stdin"] : [...pre, ...line.split(" ")],
      { timeout: timeoutFor(line) },
      (err, stdout) => {
        try {
          resolve(parseHelperReply(String(stdout)));
        } catch (e) {
          reject(err && !stdout ? new HelperError("unreachable", err.message) : e);
        }
      },
    );
    if (secret) child.stdin?.end(`${line}\n`);
    else child.stdin?.end();
  });
}

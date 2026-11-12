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
//   list                     → {"lsblk": <lsblk -J -b -o … output>}
//   mount <uuid> <label>     → {"path": "/var/lib/redgiant/backups/<label>"}
//   unmount <label>          → {}
//   ssh-status               → {"on": bool, "keys": n}
//   ssh-on <base64 key line> → {}      (keys only, never passwords)
//   ssh-off                  → {}
//   tailscale                → {"status": <tailscale status --json>}
import { execFile } from "node:child_process";
import { connect } from "node:net";

export type HelperOp =
  | { op: "list" }
  | { op: "mount"; uuid: string; label: string }
  | { op: "unmount"; label: string }
  | { op: "ssh-status" }
  | { op: "ssh-on"; key: string }
  | { op: "ssh-off" }
  | { op: "tailscale" };

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

/** The request line for an operation; anything that does not match the rules is refused here. */
export function helperRequest(o: HelperOp): string {
  switch (o.op) {
    case "mount":
      if (!UUID.test(o.uuid) || !LABEL.test(o.label)) throw new HelperError("bad_request");
      return `mount ${o.uuid} ${o.label}`;
    case "unmount":
      if (!LABEL.test(o.label)) throw new HelperError("bad_request");
      return `unmount ${o.label}`;
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

function viaSocket(path: string, line: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const s = connect(path);
    let out = "";
    const timer = setTimeout(() => {
      s.destroy();
      reject(new HelperError("timeout"));
    }, TIMEOUT);
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
    // The request's words as arguments: no shell, and the helper checks them again.
    execFile(file, [...pre, ...line.split(" ")], { timeout: TIMEOUT }, (err, stdout) => {
      try {
        resolve(parseHelperReply(String(stdout)));
      } catch (e) {
        reject(err && !stdout ? new HelperError("unreachable", err.message) : e);
      }
    });
  });
}

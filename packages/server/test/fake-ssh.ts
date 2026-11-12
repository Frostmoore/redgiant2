// A fake SSH server for the machines' tests (G38.2): ssh2's own server on 127.0.0.1, a test key,
// commands run by the local sh in a temporary folder that stands for the machine, SFTP on the same
// folders. Never the person's machines.
import { type ChildProcess, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type Stats,
  statSync,
  writeSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";

const { Server, utils } = ssh2;
const { STATUS_CODE, flagsToString } = utils.sftp;

export interface FakeSsh {
  port: number;
  /** The server's own key, and its public half's fingerprint as OpenSSH prints it. */
  hostKey: string;
  /** Logins tried, with what was offered (a password is recorded to prove it never came). */
  logins: { method: string; user: string; password?: string }[];
  commands: string[];
  /** Signals the server received (TERM, KILL) for running commands. */
  signals: string[];
  /** The public keys it accepts (authorized_keys), and the password. */
  allow: { keys: string[]; password?: string; user: string };
  close(): Promise<void>;
}

function attrsOf(st: Stats) {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

const sameKey = (pub: string, algo: string, data: Buffer) => {
  const k = utils.parseKey(pub);
  if (k instanceof Error) return false;
  const want = k.getPublicSSH();
  return k.type === algo && want.length === data.length && timingSafeEqual(want, data);
};

export async function fakeSsh(o: {
  home: string;
  user?: string;
  hostKey?: string;
  keys?: string[];
  password?: string;
}): Promise<FakeSsh> {
  const hostKey = o.hostKey ?? utils.generateKeyPairSync("ed25519").private;
  const state: FakeSsh = {
    port: 0,
    hostKey,
    logins: [],
    commands: [],
    signals: [],
    allow: {
      keys: o.keys ?? [],
      user: o.user ?? "deploy",
      ...(o.password && { password: o.password }),
    },
    close: async () => {},
  };
  const children = new Set<ChildProcess>();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      const user = ctx.username;
      if (ctx.method === "password") {
        state.logins.push({ method: "password", user, password: ctx.password });
        return user === state.allow.user && state.allow.password === ctx.password
          ? ctx.accept()
          : ctx.reject();
      }
      if (ctx.method === "publickey") {
        state.logins.push({ method: "publickey", user });
        const k = state.allow.keys.find((pub) => sameKey(pub, ctx.key.algo, ctx.key.data));
        if (!k || user !== state.allow.user) return ctx.reject();
        if (!ctx.signature) return ctx.accept();
        const parsed = utils.parseKey(k);
        if (!(parsed instanceof Error) && ctx.blob && parsed.verify(ctx.blob, ctx.signature))
          return ctx.accept();
        return ctx.reject();
      }
      state.logins.push({ method: ctx.method, user });
      ctx.reject(["publickey", "password"]);
    });
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        let child: ChildProcess | undefined;
        session.on("signal", (accept, _reject, info) => {
          state.signals.push(info.name);
          child?.kill(`SIG${info.name}` as NodeJS.Signals);
          accept?.();
        });
        session.on("env", (accept) => accept?.());
        session.on("exec", (accept, _reject, info) => {
          const stream = accept();
          state.commands.push(info.command);
          child = spawn("sh", ["-c", info.command], {
            cwd: o.home,
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: o.home },
            stdio: ["ignore", "pipe", "pipe"],
          });
          children.add(child);
          child.on("error", (err) => {
            stream.stderr.write(`${err.message}\n`);
            stream.exit(127);
            stream.end();
          });
          child.stdout?.on("data", (d) => stream.write(d));
          child.stderr?.on("data", (d) => stream.stderr.write(d));
          child.on("close", (code, signal) => {
            children.delete(child as ChildProcess);
            if (signal) stream.exit(signal.replace(/^SIG/, ""), false, "");
            else stream.exit(code ?? 0);
            stream.end();
          });
        });
        session.on("sftp", (accept) => {
          const sftp = accept();
          const handles = new Map<string, { fd?: number; dir?: string; listed?: boolean }>();
          let next = 0;
          const handle = (v: { fd?: number; dir?: string }) => {
            const h = Buffer.alloc(4);
            h.writeUInt32BE(next++);
            handles.set(h.toString("hex"), v);
            return h;
          };
          const fail = (id: number, err: unknown) =>
            sftp.status(
              id,
              (err as NodeJS.ErrnoException).code === "ENOENT"
                ? STATUS_CODE.NO_SUCH_FILE
                : (err as NodeJS.ErrnoException).code === "EACCES"
                  ? STATUS_CODE.PERMISSION_DENIED
                  : STATUS_CODE.FAILURE,
            );
          sftp.on("REALPATH", (id, p) => {
            const abs = p === "." || p === "" ? o.home : p;
            sftp.name(id, [{ filename: abs, longname: abs, attrs: {} as never }]);
          });
          for (const [ev, fn] of [
            ["STAT", statSync],
            ["LSTAT", lstatSync],
          ] as const)
            sftp.on(ev, (id, p) => {
              try {
                sftp.attrs(id, attrsOf(fn(p)));
              } catch (err) {
                fail(id, err);
              }
            });
          sftp.on("FSTAT", (id, h) => {
            const x = handles.get(h.toString("hex"));
            if (x?.fd === undefined) return sftp.status(id, STATUS_CODE.FAILURE);
            sftp.attrs(id, attrsOf(fstatSync(x.fd)));
          });
          sftp.on("SETSTAT", (id) => sftp.status(id, STATUS_CODE.OK));
          sftp.on("FSETSTAT", (id) => sftp.status(id, STATUS_CODE.OK));
          sftp.on("MKDIR", (id, p) => {
            try {
              mkdirSync(p);
              sftp.status(id, STATUS_CODE.OK);
            } catch (err) {
              fail(id, err);
            }
          });
          sftp.on("OPENDIR", (id, p) => {
            try {
              if (!statSync(p).isDirectory()) return sftp.status(id, STATUS_CODE.FAILURE);
              sftp.handle(id, handle({ dir: realpathSync(p) }));
            } catch (err) {
              fail(id, err);
            }
          });
          sftp.on("READDIR", (id, h) => {
            const x = handles.get(h.toString("hex"));
            if (!x?.dir) return sftp.status(id, STATUS_CODE.FAILURE);
            if (x.listed) return sftp.status(id, STATUS_CODE.EOF);
            x.listed = true;
            const dir = x.dir;
            sftp.name(
              id,
              readdirSync(dir).map((filename) => ({
                filename,
                longname: filename,
                attrs: attrsOf(lstatSync(`${dir}/${filename}`)),
              })),
            );
          });
          sftp.on("OPEN", (id, p, flags) => {
            try {
              const mode = flagsToString(flags) ?? "r";
              sftp.handle(id, handle({ fd: openSync(p, mode) }));
            } catch (err) {
              fail(id, err);
            }
          });
          sftp.on("READ", (id, h, offset, length) => {
            const x = handles.get(h.toString("hex"));
            if (x?.fd === undefined) return sftp.status(id, STATUS_CODE.FAILURE);
            const buf = Buffer.alloc(length);
            const n = readSync(x.fd, buf, 0, length, offset);
            if (n === 0) return sftp.status(id, STATUS_CODE.EOF);
            sftp.data(id, buf.subarray(0, n));
          });
          sftp.on("WRITE", (id, h, offset, data) => {
            const x = handles.get(h.toString("hex"));
            if (x?.fd === undefined) return sftp.status(id, STATUS_CODE.FAILURE);
            writeSync(x.fd, data, 0, data.length, offset);
            sftp.status(id, STATUS_CODE.OK);
          });
          sftp.on("CLOSE", (id, h) => {
            const k = h.toString("hex");
            const x = handles.get(k);
            if (x?.fd !== undefined) closeSync(x.fd);
            handles.delete(k);
            sftp.status(id, STATUS_CODE.OK);
          });
        });
      });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  state.port = (server.address() as AddressInfo).port;
  state.close = async () => {
    for (const c of children) c.kill("SIGKILL");
    await new Promise<void>((ok) => server.close(() => ok()));
  };
  return state;
}

// The channel between two RedGiant machines (G39.4): a WebSocket carrying an authenticated,
// encrypted link, with the keys of both ends pinned.
//
// Why not TLS with pinned certificates, and why not Noise: the link must work across a LAN,
// Tailscale and a reverse proxy (Caddy, Cloudflare, a company's), and a proxy ends TLS: pinned
// client certificates would never reach the other RedGiant. So security does not depend on the
// transport (ws:// or wss://, with or without a proxy) but on the link itself. Noise would do,
// but its static keys are X25519, while RedGiant's identities are ed25519 like SSH's (the 3.6
// machines): the handshake is SSH's (and TLS 1.3's) shape, built only from Node's own crypto:
//   1. the dialler sends a fresh X25519 key, its ed25519 identity and a nonce;
//   2. the listener answers with its own, and signs the transcript hash (th) with its identity;
//   3. the dialler checks the listener's identity against the pinned fingerprint (a different
//      one: refused, nothing else is sent) and signs th too; the listener checks it is pinned.
// Keys: HKDF-SHA256 of the X25519 secret, salted with th, one ChaCha20-Poly1305 key per direction;
// every frame carries a counter that must be exactly the next one (a replayed, reordered or
// changed frame closes the link). A recorded handshake replayed gets nowhere: the listener's
// fresh key and nonce are in th, so an old signature never matches.
//
// Pairing (nothing is pinned yet) adds the one-time code: both ends prove they know it with an
// HMAC of th under scrypt(code, th) — the dialler first, so a fake principal learns nothing; the
// scrypt makes guessing the code from a recorded proof cost far more than its ten minutes. The
// person then compares the fingerprints (and six digits from th) on both machines and confirms.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  scrypt,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import WebSocket from "ws";

const VERSION = "rg-node-v1";

/** A machine's long-term identity: an ed25519 pair. */
export interface NodeIdentity {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** The 32 bytes of the public key. */
  raw: Buffer;
  fingerprint: string;
}

/** `SHA256:` and the base64 of the public key's hash, as OpenSSH prints fingerprints. */
export function fingerprintOf(raw: Buffer): string {
  return `SHA256:${createHash("sha256").update(raw).digest("base64").replace(/=+$/, "")}`;
}

function rawOf(pub: KeyObject): Buffer {
  const jwk = pub.export({ format: "jwk" }) as { x?: string };
  return Buffer.from(jwk.x ?? "", "base64url");
}

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

export function newIdentity(): { identity: NodeIdentity; pem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const raw = rawOf(publicKey);
  return { identity: { privateKey, publicKey, raw, fingerprint: fingerprintOf(raw) }, pem };
}

export function identityFromPem(pem: string): NodeIdentity {
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);
  const raw = rawOf(publicKey);
  return { privateKey, publicKey, raw, fingerprint: fingerprintOf(raw) };
}

export function signWith(id: NodeIdentity, data: Buffer): Buffer {
  return sign(null, data, id.privateKey);
}

export function verifyWith(raw: Buffer, data: Buffer, sig: Buffer): boolean {
  try {
    return raw.length === 32 && verify(null, data, publicKeyFromRaw(raw), sig);
  } catch {
    return false;
  }
}

export type ChannelErrorCode =
  | "fingerprint-changed"
  | "unknown-peer"
  | "wrong-code"
  | "expired-code"
  | "too-many-tries"
  | "protocol"
  | "unreachable"
  | "timeout"
  | "closed";

export class NodeChannelError extends Error {
  constructor(
    readonly code: ChannelErrorCode,
    message: string,
    /** The fingerprint the other end showed (a changed or unknown one). */
    readonly seen?: string,
  ) {
    super(message);
  }
}

/** WebSocket close codes, so the dialler knows why it was refused. */
const CLOSE: Record<string, number> = {
  "unknown-peer": 4003,
  "wrong-code": 4004,
  "expired-code": 4005,
  protocol: 4006,
  "too-many-tries": 4007,
};
const CODE_OF = Object.fromEntries(
  Object.entries(CLOSE).map(([k, v]) => [v, k as ChannelErrorCode]),
);

/** Six digits from th: the same on both machines for the same pair, different with a man in the middle. */
export function sasOf(th: Buffer): string {
  const n = createHash("sha256").update("rg-node-sas").update(th).digest().readUInt32BE(0);
  const s = String(n % 1_000_000).padStart(6, "0");
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The key that proves knowledge of a pairing code for this handshake (slow on purpose). */
export function codeKey(code: string, th: Buffer): Promise<Buffer> {
  return new Promise((ok, no) =>
    scrypt(
      normalizeCode(code),
      th,
      32,
      { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (e, k) => (e ? no(e) : ok(k)),
    ),
  );
}

export const codeProof = (key: Buffer, side: "dialler" | "listener", th: Buffer) =>
  createHmac("sha256", key).update(side).update(th).digest();

const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

interface Hello {
  t: "hello";
  v: string;
  mode: "link" | "pair";
  eph: string;
  id: string;
  nonce: string;
}

function transcript(mode: string, h: Hello, w: { eph: string; id: string; nonce: string }): Buffer {
  const hash = createHash("sha256").update(VERSION).update(mode);
  for (const part of [h.eph, h.id, h.nonce, w.eph, w.id, w.nonce])
    hash.update(Buffer.from(part, "base64"));
  return hash.digest();
}

function x25519Pair() {
  const k = generateKeyPairSync("x25519");
  const jwk = k.publicKey.export({ format: "jwk" }) as { x?: string };
  return { priv: k.privateKey, pub: Buffer.from(jwk.x ?? "", "base64url") };
}

function sharedSecret(priv: KeyObject, peerRaw: Buffer): Buffer {
  const pub = createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: peerRaw.toString("base64url") },
    format: "jwk",
  });
  return diffieHellman({ privateKey: priv, publicKey: pub });
}

function keysOf(secret: Buffer, th: Buffer): { d2l: Buffer; l2d: Buffer } {
  const okm = Buffer.from(hkdfSync("sha256", secret, th, `${VERSION} keys`, 64));
  return { d2l: okm.subarray(0, 32), l2d: okm.subarray(32, 64) };
}

/** An open link: JSON messages in, JSON messages out, encrypted and in order. */
export class SecureLink {
  private sendCounter = 0n;
  private recvCounter = 0n;
  private readonly listeners = new Set<(m: unknown) => void>();
  private readonly closers = new Set<(code: number, reason: string) => void>();
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly sendKey: Buffer,
    private readonly recvKey: Buffer,
    /** The other end: its fingerprint and public key. */
    readonly peer: { fingerprint: string; raw: Buffer },
    readonly th: Buffer,
    pending: { data: Buffer; binary: boolean }[] = [],
  ) {
    const take = (data: Buffer, isBinary: boolean) => {
      if (this.closed) return;
      if (!isBinary) return this.close(4006, "plain frame on the link");
      const m = this.open(data);
      if (m === undefined)
        return this.close(4006, "a frame that does not decrypt or is out of order");
      for (const l of this.listeners) l(m);
    };
    this.backlog = pending;
    this.take = take;
    ws.on("message", (data: Buffer | string, isBinary: boolean) => {
      const b = Buffer.isBuffer(data) ? data : Buffer.from(data as string);
      if (this.backlog) this.backlog.push({ data: b, binary: isBinary });
      else take(b, isBinary);
    });
    ws.on("close", (code: number, reason: Buffer) => {
      this.closed = true;
      for (const c of this.closers) c(code, reason.toString());
    });
    ws.on("error", () => {});
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  private nonce(n: bigint): Buffer {
    const b = Buffer.alloc(12);
    b.writeBigUInt64BE(n, 4);
    return b;
  }

  private open(frame: Buffer): unknown {
    if (frame.length < 8 + 16) return undefined;
    const n = frame.readBigUInt64BE(0);
    // Exactly the next one: a replayed or reordered frame never passes.
    if (n !== this.recvCounter) return undefined;
    try {
      const d = createDecipheriv("chacha20-poly1305", this.recvKey, this.nonce(n), {
        authTagLength: 16,
      });
      d.setAAD(frame.subarray(0, 8));
      d.setAuthTag(frame.subarray(frame.length - 16));
      const plain = Buffer.concat([d.update(frame.subarray(8, frame.length - 16)), d.final()]);
      this.recvCounter += 1n;
      return JSON.parse(plain.toString("utf8"));
    } catch {
      return undefined;
    }
  }

  /** Encrypts and sends; false when the link is not open. */
  send(m: unknown): boolean {
    if (!this.isOpen) return false;
    const n = this.sendCounter;
    this.sendCounter += 1n;
    const head = Buffer.alloc(8);
    head.writeBigUInt64BE(n);
    const c = createCipheriv("chacha20-poly1305", this.sendKey, this.nonce(n), {
      authTagLength: 16,
    });
    c.setAAD(head);
    const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(m), "utf8")), c.final()]);
    this.ws.send(Buffer.concat([head, body, c.getAuthTag()]));
    return true;
  }

  private backlog: { data: Buffer; binary: boolean }[] | undefined;
  private readonly take: (data: Buffer, isBinary: boolean) => void;

  /** Starts delivering (what arrived before a listener was there comes first). */
  onMessage(l: (m: unknown) => void): () => void {
    this.listeners.add(l);
    const queued = this.backlog;
    this.backlog = undefined;
    for (const f of queued ?? []) this.take(f.data, f.binary);
    return () => this.listeners.delete(l);
  }

  onClose(l: (code: number, reason: string) => void): () => void {
    this.closers.add(l);
    return () => this.closers.delete(l);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close(code, reason);
    } catch {}
    for (const c of this.closers) c(code, reason);
  }

  /** Tests: the raw socket (to send a forged or replayed frame). */
  get socket(): WebSocket {
    return this.ws;
  }
}

/**
 * Everything a socket receives during the handshake, in order: frames that arrive right after the
 * last handshake message (in the same packet) wait here for the link instead of being lost.
 */
class Inbox {
  private readonly queue: { data: Buffer; binary: boolean }[] = [];
  private closedWith: { code: number; reason: string } | undefined;
  private wake: (() => void) | undefined;
  private readonly onMsg = (data: Buffer | string, isBinary: boolean) => {
    this.queue.push({
      data: Buffer.isBuffer(data) ? data : Buffer.from(data as string),
      binary: isBinary,
    });
    this.wake?.();
  };
  private readonly onClose = (code: number, reason: Buffer) => {
    this.closedWith = { code, reason: reason.toString() };
    this.wake?.();
  };

  constructor(private readonly ws: WebSocket) {
    ws.on("message", this.onMsg);
    ws.on("close", this.onClose);
  }

  async next(timeoutMs: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (!this.queue.length) {
      if (this.closedWith) {
        const c = CODE_OF[this.closedWith.code] ?? "closed";
        throw new NodeChannelError(
          c,
          this.closedWith.reason || `The other machine closed the link (${this.closedWith.code})`,
        );
      }
      const left = deadline - Date.now();
      if (left <= 0)
        throw new NodeChannelError("timeout", "The other machine did not answer in time");
      await new Promise<void>((ok) => {
        const t = setTimeout(ok, left);
        this.wake = () => {
          clearTimeout(t);
          ok();
        };
      });
      this.wake = undefined;
    }
    const m = this.queue.shift() as { data: Buffer; binary: boolean };
    if (m.binary) throw new NodeChannelError("protocol", "Unexpected frame in the handshake");
    try {
      return JSON.parse(m.data.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new NodeChannelError("protocol", "Unreadable handshake");
    }
  }

  /** Stops listening and hands over what came after the handshake. */
  rest(): { data: Buffer; binary: boolean }[] {
    this.ws.off("message", this.onMsg);
    this.ws.off("close", this.onClose);
    return this.queue.splice(0);
  }
}

const b64 = (b: Buffer) => b.toString("base64");
const str = (v: unknown) => (typeof v === "string" ? v : "");
const bytes = (v: unknown) => Buffer.from(str(v), "base64");

/** `http(s)://host[:port]`, `ws(s)://…` or `host:port` as the WebSocket URL of the node channel. */
export function channelUrl(address: string): string {
  let a = address.trim().replace(/\/+$/, "");
  if (!/^[a-z]+:\/\//i.test(a)) a = `http://${a}`;
  const u = new URL(a);
  u.protocol = u.protocol === "https:" || u.protocol === "wss:" ? "wss:" : "ws:";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/nodes`;
  return u.toString();
}

export interface DialOptions {
  url: string;
  identity: NodeIdentity;
  /** link: `expect` is the pinned fingerprint; pair: `code` is the one the person typed. */
  mode: "link" | "pair";
  expect?: string;
  code?: string;
  timeoutMs?: number;
  /** Tests: another WebSocket constructor. */
  socket?: (url: string) => WebSocket;
}

export interface Dialled {
  link: SecureLink;
  peer: { fingerprint: string; raw: Buffer };
  sas: string;
}

/** Dials the other machine and runs the handshake (the dialler's side). */
export async function dialNode(o: DialOptions): Promise<Dialled> {
  const timeoutMs = o.timeoutMs ?? 15_000;
  const ws = o.socket ? o.socket(o.url) : new WebSocket(o.url, { handshakeTimeout: timeoutMs });
  await new Promise<void>((ok, no) => {
    const timer = setTimeout(() => {
      ws.terminate();
      no(new NodeChannelError("timeout", "The other machine did not answer in time"));
    }, timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      ok();
    });
    ws.once("error", (e: Error & { code?: string }) => {
      clearTimeout(timer);
      no(new NodeChannelError("unreachable", `Cannot reach ${o.url}: ${e.code ?? e.message}`));
    });
  });
  const inbox = new Inbox(ws);
  try {
    const eph = x25519Pair();
    const hello: Hello = {
      t: "hello",
      v: VERSION,
      mode: o.mode,
      eph: b64(eph.pub),
      id: b64(o.identity.raw),
      nonce: b64(randomBytes(32)),
    };
    ws.send(JSON.stringify(hello));
    const w = await inbox.next(timeoutMs);
    if (w.t !== "welcome")
      throw new NodeChannelError("protocol", "The other machine is not a RedGiant node channel");
    const peerRaw = bytes(w.id);
    const peerFp = fingerprintOf(peerRaw);
    const th = transcript(o.mode, hello, { eph: str(w.eph), id: str(w.id), nonce: str(w.nonce) });
    if (!verifyWith(peerRaw, Buffer.concat([Buffer.from("listener"), th]), bytes(w.sig)))
      throw new NodeChannelError("protocol", "The other machine's signature is wrong");
    if (o.mode === "link" && peerFp !== o.expect)
      throw new NodeChannelError(
        "fingerprint-changed",
        `DANGER: the machine at ${o.url} answered with another key (${peerFp}, pinned: ${o.expect}). Another computer may be in its place: nothing was sent.`,
        peerFp,
      );
    const auth: Record<string, string> = {
      t: "auth",
      sig: b64(signWith(o.identity, Buffer.concat([Buffer.from("dialler"), th]))),
    };
    let key: Buffer | undefined;
    if (o.mode === "pair") {
      key = await codeKey(o.code ?? "", th);
      auth.proof = b64(codeProof(key, "dialler", th));
    }
    ws.send(JSON.stringify(auth));
    const r = await inbox.next(timeoutMs);
    if (r.t !== "ready") throw new NodeChannelError("protocol", "Unexpected answer");
    if (key && !sameBytes(bytes(r.proof), codeProof(key, "listener", th)))
      throw new NodeChannelError("wrong-code", "The other machine does not know this code");
    const k = keysOf(sharedSecret(eph.priv, bytes(w.eph)), th);
    const link = new SecureLink(
      ws,
      k.d2l,
      k.l2d,
      { fingerprint: peerFp, raw: peerRaw },
      th,
      inbox.rest(),
    );
    return { link, peer: { fingerprint: peerFp, raw: peerRaw }, sas: sasOf(th) };
  } catch (err) {
    try {
      ws.close(1000);
    } catch {}
    throw err;
  }
}

export interface AcceptOptions {
  identity: NodeIdentity;
  /** Link mode: whether this fingerprint is a pinned peer. */
  known: (fingerprint: string) => boolean;
  /**
   * Pair mode: checks the dialler's proof against the codes being shown; the key to answer with,
   * or why not.
   */
  pairProof?: (
    th: Buffer,
    proof: Buffer,
  ) => Promise<
    | { ok: true; key: Buffer }
    | { ok: false; code: "wrong-code" | "expired-code" | "too-many-tries" }
  >;
  timeoutMs?: number;
}

export interface Accepted extends Dialled {
  mode: "link" | "pair";
}

function refuse(ws: WebSocket, code: ChannelErrorCode, message: string): never {
  try {
    ws.close(CLOSE[code] ?? 4006, message.slice(0, 120));
  } catch {}
  throw new NodeChannelError(code, message);
}

/** The listener's side of the handshake, on a socket that just opened. */
export async function acceptNode(ws: WebSocket, o: AcceptOptions): Promise<Accepted> {
  const timeoutMs = o.timeoutMs ?? 15_000;
  const inbox = new Inbox(ws);
  const h = (await inbox.next(timeoutMs)) as unknown as Hello;
  if (h.t !== "hello" || h.v !== VERSION || (h.mode !== "link" && h.mode !== "pair"))
    refuse(ws, "protocol", "Not a RedGiant node handshake");
  const peerRaw = bytes(h.id);
  const peerFp = fingerprintOf(peerRaw);
  if (peerRaw.length !== 32 || bytes(h.eph).length !== 32 || bytes(h.nonce).length !== 32)
    refuse(ws, "protocol", "Malformed handshake");
  if (h.mode === "link" && !o.known(peerFp))
    refuse(ws, "unknown-peer", "This machine is not paired here");
  if (h.mode === "pair" && !o.pairProof)
    refuse(ws, "expired-code", "No pairing code is being shown");
  const eph = x25519Pair();
  const mine = { eph: b64(eph.pub), id: b64(o.identity.raw), nonce: b64(randomBytes(32)) };
  const th = transcript(h.mode, h, mine);
  ws.send(
    JSON.stringify({
      t: "welcome",
      ...mine,
      sig: b64(signWith(o.identity, Buffer.concat([Buffer.from("listener"), th]))),
    }),
  );
  const a = await inbox.next(timeoutMs);
  if (a.t !== "auth") refuse(ws, "protocol", "Unexpected message");
  if (!verifyWith(peerRaw, Buffer.concat([Buffer.from("dialler"), th]), bytes(a.sig)))
    refuse(ws, "protocol", "The dialler's signature is wrong");
  const ready: Record<string, string> = { t: "ready" };
  if (h.mode === "pair") {
    const r = await (o.pairProof as NonNullable<AcceptOptions["pairProof"]>)(th, bytes(a.proof));
    if (!r.ok)
      refuse(
        ws,
        r.code,
        r.code === "wrong-code"
          ? "Wrong pairing code"
          : r.code === "too-many-tries"
            ? "Too many wrong codes: ask for a new one"
            : "The pairing code expired: ask for a new one",
      );
    ready.proof = b64(codeProof(r.key, "listener", th));
  }
  ws.send(JSON.stringify(ready));
  const k = keysOf(sharedSecret(eph.priv, bytes(h.eph)), th);
  const link = new SecureLink(
    ws,
    k.l2d,
    k.d2l,
    { fingerprint: peerFp, raw: peerRaw },
    th,
    inbox.rest(),
  );
  return { link, peer: { fingerprint: peerFp, raw: peerRaw }, sas: sasOf(th), mode: h.mode };
}

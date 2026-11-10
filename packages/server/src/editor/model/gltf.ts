// glTF files as the 3D family keeps them (G37.7). A .gltf is JSON text; a .glb is a header, a JSON
// chunk, a binary chunk and maybe chunks of other kinds. The JSON is read by a reader of ours that
// remembers each container's own text: written back, a container no action touched is its very
// text (spaces, member order, number spellings, unknown extensions and extras), and a changed one
// keeps the layout of the one it came from. The binary chunk and other chunks are kept as bytes;
// nothing the editor does changes them (new data goes into small buffers of its own, as data:).

/** A container's text and layout, as the file had it. */
interface Layout {
  /** The container's own text, while it is unchanged (its identity is the original's). */
  raw?: string | undefined;
  /** Spaces before each member, the one before the closing bracket, after a colon. */
  indent: string;
  close: string;
  colon: string;
  /** Inline containers: what follows a comma (", " or ","). */
  comma: string;
  multiline: boolean;
  /** Each member's value text as the file wrote it (primitives are compared by value). */
  members: Map<string | number, { raw: string; value: unknown }>;
}

const layouts = new WeakMap<object, Layout>();

/** Keeps a copy's layout (copy on write in the protocol's actions): its text is not its own. */
export function copiedLayout(from: object, to: object): void {
  const l = layouts.get(from);
  if (l) layouts.set(to, { ...l, raw: undefined });
}

export interface JsonText {
  root: unknown;
  /** What came before and after the root value (a byte order mark, a last newline). */
  lead: string;
  tail: string;
  /** One level of indentation in this file ("" when it is written on one line). */
  unit: string;
}

class Reader {
  i = 0;
  constructor(readonly s: string) {}

  fail(what: string): never {
    throw new Error(`the glTF JSON is not readable: ${what} at ${this.i}`);
  }
  ws(): string {
    const from = this.i;
    while (this.i < this.s.length && " \t\r\n".includes(this.s[this.i] as string)) this.i++;
    return this.s.slice(from, this.i);
  }
  value(): unknown {
    const c = this.s[this.i];
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"') return this.string();
    const m = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
      this.s.slice(this.i, this.i + 400),
    );
    if (!m?.[1]) this.fail("a value expected");
    this.i += m[1].length;
    return m[1] === "true"
      ? true
      : m[1] === "false"
        ? false
        : m[1] === "null"
          ? null
          : Number(m[1]);
  }
  string(): string {
    const from = this.i;
    this.i++;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === "\\") this.i += 2;
      else if (c === '"') {
        this.i++;
        return JSON.parse(this.s.slice(from, this.i)) as string;
      } else this.i++;
    }
    return this.fail("a string not closed");
  }
  container<T extends object>(
    open: string,
    closeCh: string,
    make: T,
    member: (c: T, l: Layout) => void,
  ): T {
    const from = this.i;
    this.i++;
    const l: Layout = {
      indent: "",
      close: "",
      colon: ":",
      comma: ",",
      multiline: false,
      members: new Map(),
    };
    let first = true;
    for (;;) {
      const sp = this.ws();
      if (this.s[this.i] === closeCh) {
        l.close = sp;
        this.i++;
        break;
      }
      if (first) {
        l.indent = sp;
        l.multiline = sp.includes("\n");
        first = false;
      } else if (!l.multiline && l.members.size === 1) l.comma = `,${sp}`;
      member(make, l);
      const after = this.ws();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] === closeCh) {
        l.close = after;
        this.i++;
        break;
      } else this.fail(`"," or "${closeCh}" expected after ${open}`);
    }
    l.raw = this.s.slice(from, this.i);
    layouts.set(make, l);
    return make;
  }
  object(): Record<string, unknown> {
    return this.container("{", "}", {} as Record<string, unknown>, (o, l) => {
      if (this.s[this.i] !== '"') this.fail("a member's name expected");
      const k = this.string();
      const before = this.ws();
      if (this.s[this.i] !== ":") this.fail('":" expected');
      this.i++;
      const after = this.ws();
      if (l.members.size === 0) l.colon = `${before}:${after}`;
      const from = this.i;
      const v = this.value();
      l.members.set(k, { raw: this.s.slice(from, this.i), value: v });
      o[k] = v;
    });
  }
  array(): unknown[] {
    return this.container("[", "]", [] as unknown[], (a, l) => {
      const from = this.i;
      const v = this.value();
      l.members.set(a.length, { raw: this.s.slice(from, this.i), value: v });
      a.push(v);
    });
  }
}

/** Reads glTF JSON text, remembering its layout. */
export function readJson(text: string): JsonText {
  const r = new Reader(text);
  if (text.charCodeAt(0) === 0xfeff) r.i = 1;
  r.ws();
  const lead = text.slice(0, r.i);
  const root = r.value();
  const tailFrom = r.i;
  r.ws();
  if (r.i !== text.length) r.fail("text after the JSON");
  const l = root && typeof root === "object" ? layouts.get(root) : undefined;
  const unit =
    l?.multiline && l.indent.lastIndexOf("\n") >= 0
      ? l.indent
          .slice(l.indent.lastIndexOf("\n") + 1)
          .slice(l.close.slice(l.close.lastIndexOf("\n") + 1).length) || "  "
      : "";
  return { root, lead, tail: text.slice(tailFrom), unit };
}

const samePrimitive = (a: unknown, b: unknown) =>
  a === b || (typeof a === "number" && typeof b === "number" && Object.is(a, b));

/** The same JSON value (an undo's value comes back from the log as a new object). */
function sameJson(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || depth > 100) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i] as string;
    if (k !== kb[i]) return false;
    if (!sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth + 1))
      return false;
  }
  return true;
}

/** A new value (no layout of its own) in the file's style, at a depth's indentation. */
function fresh(v: unknown, unit: string, base: string): string {
  if (!v || typeof v !== "object") return JSON.stringify(v ?? null);
  const entries = Array.isArray(v)
    ? v.map((x) => [undefined, x] as const)
    : Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  const [open, close] = Array.isArray(v) ? ["[", "]"] : ["{", "}"];
  if (!entries.length) return `${open}${close}`;
  const flat = !unit || (Array.isArray(v) && entries.every(([, x]) => !x || typeof x !== "object"));
  const inner = base + unit;
  const parts = entries.map(
    ([k, x]) =>
      `${k === undefined ? "" : `${JSON.stringify(k)}:${unit ? " " : ""}`}${fresh(x, unit, inner)}`,
  );
  if (flat) return `${open}${parts.join(unit ? ", " : ",")}${close}`;
  return `${open}\n${parts.map((p) => inner + p).join(",\n")}\n${base}${close}`;
}

function print(v: unknown, unit: string, base: string): string {
  if (!v || typeof v !== "object") return JSON.stringify(v ?? null);
  const l = layouts.get(v);
  if (!l) return fresh(v, unit, base);
  if (l.raw !== undefined) return l.raw;
  const isArr = Array.isArray(v);
  const entries = isArr
    ? (v as unknown[]).map((x, i) => [i, x] as const)
    : Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  const [open, close] = isArr ? ["[", "]"] : ["{", "}"];
  if (!entries.length) return `${open}${l.multiline ? "" : l.close}${close}`;
  // Members of a container that had none take the file's indentation.
  const indent = l.members.size || !l.multiline ? l.indent : `\n${base}${unit}`;
  const inner = indent.slice(indent.lastIndexOf("\n") + 1);
  const parts = entries.map(([k, x]) => {
    const was = l.members.get(k);
    const text =
      x && typeof x === "object"
        ? print(
            // A value put back as it was (an undo) takes back its own text.
            !layouts.has(x) && was && sameJson(was.value, x) ? was.value : x,
            unit,
            inner,
          )
        : was && samePrimitive(was.value, x)
          ? was.raw
          : JSON.stringify(x);
    return isArr ? text : `${JSON.stringify(k)}${l.colon}${text}`;
  });
  if (l.multiline) {
    const close2 = l.close || `\n${base}`;
    return `${open}${indent}${parts.join(`,${indent}`)}${close2}${close}`;
  }
  return `${open}${l.indent}${parts.join(l.comma)}${l.close}${close}`;
}

/** The JSON as text: untouched containers as they were, changed ones in their own layout. */
export function writeJson(j: JsonText): string {
  return `${j.lead}${print(j.root, j.unit, "")}${j.tail}`;
}

// -------------------------------------------------------------------------------------------
// The container

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export interface GltfFile {
  container: "glb" | "gltf";
  json: JsonText;
  /** The binary chunk (a .glb's), as bytes. */
  bin?: Uint8Array | undefined;
  /** What saving needs to write the same bytes when nothing changed. */
  original: { text: string; bytes: Uint8Array };
  /** A .glb's chunks of other kinds, kept as they were, after the binary one. */
  extra: Uint8Array[];
}

export const isGlb = (bytes: Uint8Array) =>
  bytes.length >= 12 &&
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === GLB_MAGIC;

/** Reads a .glb or a .gltf. */
export function readGltf(bytes: Uint8Array): GltfFile {
  if (isGlb(bytes)) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = dv.getUint32(4, true);
    if (version !== 2) throw new Error(`it is glTF ${version}: only glTF 2.0 is edited`);
    const length = Math.min(dv.getUint32(8, true), bytes.length);
    let at = 12;
    let text: string | undefined;
    let bin: Uint8Array | undefined;
    const extra: Uint8Array[] = [];
    while (at + 8 <= length) {
      const len = dv.getUint32(at, true);
      const type = dv.getUint32(at + 4, true);
      const body = bytes.subarray(at + 8, at + 8 + len);
      if (type === CHUNK_JSON && text === undefined) {
        // The chunk's padding (spaces, or zeros from some writers) is not the text's.
        text = new TextDecoder("utf-8", { fatal: true }).decode(body).replace(/[ \0]+$/, "");
      } else if (type === CHUNK_BIN && bin === undefined) bin = body.slice();
      else extra.push(bytes.slice(at, at + 8 + len));
      at += 8 + len;
    }
    if (text === undefined) throw new Error("the GLB has no JSON chunk");
    const json = readJson(text);
    return {
      container: "glb",
      json,
      bin,
      original: { text, bytes },
      extra,
    };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("it is neither a GLB nor UTF-8 glTF text");
  }
  const json = readJson(text);
  return { container: "gltf", json, original: { text, bytes }, extra: [] };
}

/** The file's bytes: the same bytes when nothing changed. */
export function writeGltf(f: GltfFile): Uint8Array {
  const text = writeJson(f.json);
  if (f.container === "gltf")
    return text === f.original.text ? f.original.bytes : new TextEncoder().encode(text);
  // Unchanged: the very bytes (the binary chunk and the padding too).
  if (text === f.original.text) return f.original.bytes;
  return packGlb(text, f.bin, f.extra);
}

/** A GLB from JSON text and a binary chunk (both padded to 4 bytes, as the format asks). */
export function packGlb(text: string, bin?: Uint8Array, extra: Uint8Array[] = []): Uint8Array {
  let json = new TextEncoder().encode(text);
  if (json.length % 4) {
    const padded = new Uint8Array(Math.ceil(json.length / 4) * 4).fill(0x20);
    padded.set(json);
    json = padded;
  }
  const binLen = bin ? Math.ceil(bin.length / 4) * 4 : 0;
  const extraLen = extra.reduce((n, c) => n + c.length, 0);
  const total = 12 + 8 + json.length + (bin ? 8 + binLen : 0) + extraLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, json.length, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(json, 20);
  let at = 20 + json.length;
  if (bin) {
    dv.setUint32(at, binLen, true);
    dv.setUint32(at + 4, CHUNK_BIN, true);
    out.set(bin, at + 8);
    at += 8 + binLen;
  }
  for (const c of extra) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

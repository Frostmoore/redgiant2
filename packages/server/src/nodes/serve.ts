// What a RedGiant does for the machines that may use it (G39.4), on its own side: the request was
// already checked against this machine's control grants (`Nodes.serve`); here every command is
// read again by this machine's own guardian and `criticalOf`, as if one of its agents ran it:
//  - commands run in a sandbox of this machine kept for the asker (one folder per asker and
//    sandbox, through the server's `sandboxFor`), never with the server's environment;
//  - a write outside that folder is refused unless the asker manages this machine (`admin`);
//  - a truly dangerous command runs only if the asking side says its person said yes to exactly
//    that (its own critical check asked them), else it is refused here;
//  - models: this machine's providers answer with their own keys, which never leave;
//  - storage: files in a folder of this machine kept for the asker, nowhere else.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rm, stat, statfs } from "node:fs/promises";
import { arch, cpus, freemem, loadavg, type as osType, release, totalmem } from "node:os";
import { join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { bashOutsideWrites, criticalOf } from "@redgiant/hierarchy";
import type { NodeCapabilities } from "@redgiant/protocol";
import type { CompletionRequest, ProviderRegistry } from "@redgiant/providers";
import type { Workspace } from "@redgiant/tools";
import type { NodeCaller, NodeHandlers } from "./service.js";
import { NodeError } from "./service.js";

export interface NodeServeOptions {
  /** Where the askers' sandboxes and storage live (one folder each). */
  dataDir: string;
  /** A sandbox of this machine for `key`, in `dir` (the server's `sandboxFor`). */
  sandbox(ownerId: string, key: string, dir: string): Promise<Workspace>;
  providers: ProviderRegistry;
  /** Which sandbox runs commands here (docker, host). */
  sandboxKind: string;
  /** The person switched off lending (commands, models, storage) on this machine. */
  offers?: (ownerId: string) => { sandbox: boolean; models: boolean; storage: boolean };
  /** The models a node offers: its own providers, never another node's (no loops). */
  offersProvider?: (id: string) => boolean;
}

const safe = (fp: string) =>
  fp
    .replace(/^SHA256:/, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 24);
const SANDBOX_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const STORAGE_NAME =
  /^[A-Za-z0-9][A-Za-z0-9_. -]{0,119}(\/[A-Za-z0-9][A-Za-z0-9_. -]{0,119}){0,3}$/;
const CHUNK = 4 * 1024 * 1024;

const q = (a: string) => (/^[A-Za-z0-9_./=:-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

export function nodeHandlers(o: NodeServeOptions): NodeHandlers {
  const offers = (ownerId: string) =>
    o.offers?.(ownerId) ?? { sandbox: true, models: true, storage: true };
  const workspace = async (c: NodeCaller, sandbox: unknown) => {
    if (!offers(c.ownerId).sandbox)
      throw new NodeError("refused", "This machine does not lend its sandboxes now");
    const id = typeof sandbox === "string" && SANDBOX_ID.test(sandbox) ? sandbox : "default";
    const dir = join(o.dataDir, "work", safe(c.from), id);
    await mkdir(dir, { recursive: true });
    return o.sandbox(c.ownerId, `node-${safe(c.from).slice(0, 10)}-${id}`, dir);
  };
  const offered = (id: string) => !id.startsWith("node-") && (o.offersProvider?.(id) ?? true);

  return {
    async capabilities(ownerId) {
      const cores = cpus().length;
      let storage: NodeCapabilities["storage"] = { ok: false };
      try {
        await mkdir(o.dataDir, { recursive: true });
        const f = await statfs(o.dataDir);
        storage = {
          ok: offers(ownerId).storage,
          freeBytes: f.bavail * f.bsize,
          totalBytes: f.blocks * f.bsize,
        };
      } catch {}
      const models: NodeCapabilities["models"] = [];
      if (offers(ownerId).models)
        for (const p of o.providers.list().filter((x) => offered(x.id))) {
          const list = await p.models?.().catch(() => [] as string[]);
          if (list?.length) models.push({ provider: p.id, models: list.slice(0, 50) });
        }
      return {
        sandbox: {
          ok: offers(ownerId).sandbox,
          kind: o.sandboxKind,
          cpus: cores,
          memoryMb: Math.round(totalmem() / 2 ** 20),
        },
        models,
        storage,
        load: {
          cpu: Math.round(((loadavg()[0] ?? 0) / Math.max(1, cores)) * 100),
          memoryUsedPct: Math.round((1 - freemem() / totalmem()) * 100),
        },
        system: `${osType()} ${release()} ${arch()}`,
      };
    },

    async exec(c, raw) {
      const b = raw as {
        sandbox?: string;
        command?: string;
        file?: string;
        args?: string[];
        cwd?: string;
        timeoutMs?: number;
        approvedCritical?: string[];
      };
      const ws = await workspace(c, b.sandbox);
      const command =
        typeof b.command === "string"
          ? b.command
          : typeof b.file === "string"
            ? [b.file, ...(Array.isArray(b.args) ? b.args.map(String) : [])].map(q).join(" ")
            : "";
      if (!command.trim()) throw new NodeError("invalid", "No command");
      const start = b.cwd ? resolve(ws.root, b.cwd) : ws.root;
      if (start !== ws.root && !start.startsWith(ws.root + sep))
        throw new NodeError("refused", "The folder is outside this machine's sandbox for you");
      // This machine's own guardian: the asker's sandbox folder and the scratch space only.
      const outside = bashOutsideWrites(
        command,
        { roots: [ws.root, "/tmp"], home: ws.root },
        start,
      );
      if (outside.length && !c.rights.has("admin"))
        throw new NodeError(
          "refused",
          `The guardian of this machine refused: the command writes outside its sandbox (${outside.slice(0, 3).join(", ")}). Only a machine that manages this one may.`,
        );
      // Truly dangerous: only what the asker's person said yes to.
      // Read as a command of this machine (its real folders) and as one on a node (its
      // administrator, switching it off, its system programs), as the asking side read it.
      const local = criticalOf(
        { callId: "", name: "bash", input: { command } },
        {
          roots: [ws.root],
          home: ws.root,
        },
      );
      const asNode = criticalOf({ callId: "", name: "node_run", input: { node: "here", command } });
      const hits = [...local, ...asNode.filter((h) => !local.some((l) => l.id === h.id))];
      const approved = new Set(Array.isArray(b.approvedCritical) ? b.approvedCritical : []);
      const missing = hits.filter((h) => !approved.has(h.id));
      if (missing.length)
        throw new NodeError(
          "refused",
          `Truly dangerous here (${missing.map((h) => h.why).join("; ")}): refused, the person was not asked for it`,
        );
      const timeoutMs = Math.min(Math.max(1000, Number(b.timeoutMs) || 120_000), 3_600_000);
      const rel = start === ws.root ? undefined : start.slice(ws.root.length + 1);
      const r =
        typeof b.command === "string"
          ? await ws.exec(command, { timeoutMs, signal: c.signal, ...(rel && { cwd: rel }) })
          : await ws.execFile(b.file as string, (b.args ?? []).map(String), {
              timeoutMs,
              signal: c.signal,
              ...(rel && { cwd: rel }),
            });
      return { ...r, root: ws.root };
    },

    async fs(c, raw) {
      const b = raw as {
        sandbox?: string;
        action?: string;
        path?: string;
        content?: string;
        pattern?: string;
        under?: string;
      };
      const ws = await workspace(c, b.sandbox);
      const path = String(b.path ?? "");
      switch (b.action) {
        case "root":
          return { root: ws.root };
        case "read":
          return { text: await ws.readText(path) };
        case "write":
          if (typeof b.content !== "string") throw new NodeError("invalid", "No content");
          await ws.writeText(path, b.content);
          return { ok: true };
        case "exists":
          return { value: await ws.exists(path) };
        case "isFile":
          return { value: await ws.isFile(path) };
        case "glob":
          return { files: await ws.glob(String(b.pattern ?? "**/*"), b.under) };
        default:
          throw new NodeError("invalid", "Unknown file action");
      }
    },

    async models(c) {
      if (!offers(c.ownerId).models)
        throw new NodeError("refused", "This machine does not lend its models now");
      const out: {
        provider: string;
        models: {
          id: string;
          contextWindow: number;
          maxOutputTokens: number;
          supportsEffort: boolean;
          vision?: boolean;
          name?: string;
        }[];
      }[] = [];
      for (const p of o.providers.list().filter((x) => offered(x.id))) {
        const ids = (await p.models?.().catch(() => [] as string[])) ?? [];
        out.push({
          provider: p.id,
          models: ids.slice(0, 50).map((id) => {
            const i = p.modelInfo(id);
            return {
              id,
              contextWindow: i.contextWindow,
              maxOutputTokens: i.maxOutputTokens,
              supportsEffort: i.supportsEffort,
              ...(i.vision && { vision: true }),
              ...(i.name && { name: i.name }),
            };
          }),
        });
      }
      return out;
    },

    async complete(c, raw) {
      if (!offers(c.ownerId).models)
        throw new NodeError("refused", "This machine does not lend its models now");
      const b = raw as { provider?: string; request?: CompletionRequest };
      const id = String(b.provider ?? "");
      if (!offered(id) || !o.providers.has(id))
        throw new NodeError("not-found", `There is no model provider "${id}" here`);
      if (!b.request || typeof b.request.model !== "string")
        throw new NodeError("invalid", "No request");
      for await (const ev of o.providers.get(id).stream(b.request, c.signal)) {
        if (ev.type === "done") return ev.completion;
        c.chunk(ev);
      }
      throw new NodeError("lost", "The model ended without an answer");
    },

    async storage(c, raw) {
      if (!offers(c.ownerId).storage)
        throw new NodeError("refused", "This machine does not lend its storage now");
      const b = raw as {
        action?: string;
        name?: string;
        offset?: number;
        data?: string;
        last?: boolean;
      };
      const base = join(o.dataDir, "storage", safe(c.from));
      await mkdir(base, { recursive: true });
      const at = (name: unknown) => {
        if (typeof name !== "string" || !STORAGE_NAME.test(name) || name.split("/").includes(".."))
          throw new NodeError("invalid", "A file name here is letters, digits, dots and dashes");
        return join(base, ...name.split("/"));
      };
      switch (b.action) {
        case "put": {
          const file = at(b.name);
          const part = `${file}.part`;
          await mkdir(join(file, ".."), { recursive: true });
          const data = Buffer.from(String(b.data ?? ""), "base64");
          const offset = Number(b.offset) || 0;
          if (offset === 0) await rm(part, { force: true });
          const size = await stat(part).then(
            (s) => s.size,
            () => 0,
          );
          // Pieces in order: one asked again after a reconnect is not written twice.
          if (offset < size) return { size };
          if (offset > size)
            throw new NodeError("invalid", `Piece out of order (at ${offset}, have ${size})`);
          const h = await open(part, "a");
          try {
            await h.write(data);
          } finally {
            await h.close();
          }
          const now = size + data.length;
          // The whole file appears only once complete: never a half-written copy.
          if (b.last) await import("node:fs/promises").then((f) => f.rename(part, file));
          return { size: now };
        }
        case "get": {
          const file = at(b.name);
          const offset = Number(b.offset) || 0;
          const total = (await stat(file)).size;
          const buf = await new Promise<Buffer>((ok, no) => {
            const parts: Buffer[] = [];
            createReadStream(file, { start: offset, end: Math.min(total, offset + CHUNK) - 1 })
              .on("data", (d) => parts.push(d as Buffer))
              .on("end", () => ok(Buffer.concat(parts)))
              .on("error", no);
          });
          return { data: buf.toString("base64"), size: total, done: offset + buf.length >= total };
        }
        case "list": {
          const out: { name: string; size: number; at: string }[] = [];
          const walk = async (dir: string, prefix: string) => {
            for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
              const rel = prefix ? `${prefix}/${e.name}` : e.name;
              if (e.isDirectory()) await walk(join(dir, e.name), rel);
              else if (!e.name.endsWith(".part")) {
                const s = await stat(join(dir, e.name));
                out.push({ name: rel, size: s.size, at: s.mtime.toISOString() });
              }
            }
          };
          await walk(base, "");
          return out.sort((x, y) => x.name.localeCompare(y.name));
        }
        case "remove":
          await rm(at(b.name), { force: true });
          return { ok: true };
        // A file's SHA-256 (p3.7.2): the asker checks a backup arrived whole before keeping it.
        case "hash": {
          const h = createHash("sha256");
          await pipeline(createReadStream(at(b.name)), h);
          return { sha256: h.digest("hex"), size: (await stat(at(b.name))).size };
        }
        default:
          throw new NodeError("invalid", "Unknown storage action");
      }
    },
  };
}

// The routes of Settings › Nodes (G39.4) and of the role step (first boot, Settings › System):
//   GET  /api/nodes                       the tree, the pairs waiting, the grants, the placements
//   POST /api/nodes/code                  a one-time code for a new node (DELETE: stop showing it)
//   POST /api/nodes/pair      {address, code, name?}   on the node: pair with the principal
//   POST /api/nodes/confirm   {fingerprint, rights?, name?}   the person's yes after comparing
//   POST /api/nodes/reject    {fingerprint}            the person's no
//   POST /api/nodes/unpair    {fingerprint}
//   POST /api/nodes/grants    {controller, target, rights}   who may command whom (never implicit)
//   POST /api/nodes/grants/revoke {target, id}
//   PUT  /api/nodes/placements {scope, commands?, backups?}  where things run (default: here)
//   PUT  /api/nodes/name      {name}
//   PUT  /api/nodes/label     {fingerprint, name}  the person's name for a paired machine, here
//   POST /api/nodes/backup    {projectId, node?}   a copy of the project's files kept on the node
//   GET  /api/nodes/storage?node=<fingerprint>     what this machine keeps on a node
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  GrantBody,
  NodeLabelBody,
  PairBody,
  PairConfirmBody,
  PlacementBody,
} from "@redgiant/protocol";
import { zipSync } from "fflate";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { RedGiantCore } from "../core.js";
import { NodeError } from "./service.js";

const MAX_BACKUP = 512 * 1024 * 1024;
const PIECE = 4 * 1024 * 1024;

const statusOf = (e: NodeError) =>
  e.code === "not-found"
    ? 404
    : e.code === "vault"
      ? 409
      : e.code === "forbidden" || e.code === "refused"
        ? 403
        : e.code === "offline" ||
            e.code === "lost" ||
            e.code === "unreachable" ||
            e.code === "timeout"
          ? 503
          : 400;

/** The project's files, for a copy (dependencies that are rebuilt are left out). */
async function projectZip(dir: string): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".redgiant-worktrees") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        total += (await stat(p)).size;
        if (total > MAX_BACKUP)
          throw new NodeError(
            "invalid",
            "The project is over 512 MB: too big for a copy on a node",
          );
        files[relative(dir, p).split("\\").join("/")] = new Uint8Array(await readFile(p));
      }
    }
  };
  await walk(dir);
  return zipSync(files, { level: 6 });
}

export function nodeRoutes<E extends { Variables: any }>(
  app: Hono<E>,
  core: RedGiantCore,
  owner: (c: Context<E>) => string,
): void {
  const run = async (c: Context<E>, f: () => Promise<unknown>, status: 200 | 201 = 200) => {
    try {
      return c.json((await f()) ?? { ok: true }, status);
    } catch (err) {
      if (err instanceof NodeError)
        return c.json({ error: err.message, code: err.code }, statusOf(err));
      throw err;
    }
  };
  const body = async <T extends z.ZodTypeAny>(c: Context<E>, schema: T) => {
    const b = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) throw new NodeError("invalid", b.error.issues[0]?.message ?? "Bad request");
    return b.data as z.infer<T>;
  };
  const n = core.nodes;

  app.get("/api/nodes", (c) => run(c, () => n.state(owner(c))));
  app.post("/api/nodes/code", (c) => run(c, () => n.newCode(owner(c)), 201));
  app.delete("/api/nodes/code", (c) => run(c, async () => n.cancelCode(owner(c))));
  app.post("/api/nodes/pair", (c) =>
    run(c, async () => {
      const b = await body(c, PairBody);
      return n.pair(owner(c), b.address, b.code, b.name);
    }),
  );
  app.post("/api/nodes/confirm", (c) =>
    run(c, async () => {
      const b = await body(c, PairConfirmBody);
      await n.confirm(owner(c), b.fingerprint, b.rights ?? ["use", "admin"], b.name);
      return n.state(owner(c));
    }),
  );
  const Fp = z.object({ fingerprint: z.string().min(10).max(100) });
  app.post("/api/nodes/reject", (c) =>
    run(c, async () => n.reject(owner(c), (await body(c, Fp)).fingerprint)),
  );
  app.post("/api/nodes/unpair", (c) =>
    run(c, async () => n.unpair(owner(c), (await body(c, Fp)).fingerprint)),
  );
  app.post("/api/nodes/grants", (c) =>
    run(c, async () => {
      const b = await body(c, GrantBody);
      return n.grant(owner(c), b.controller, b.target, b.rights);
    }),
  );
  app.post("/api/nodes/grants/revoke", (c) =>
    run(c, async () => {
      const b = await body(
        c,
        z.object({ target: z.string().min(10), id: z.string().min(1).max(60) }),
      );
      await n.revoke(owner(c), b.target, b.id);
    }),
  );
  app.put("/api/nodes/placements", (c) =>
    run(c, async () => {
      const b = await body(c, PlacementBody);
      return { placements: await n.setPlacement(owner(c), b.scope, b) };
    }),
  );
  app.put("/api/nodes/name", (c) =>
    run(c, async () => {
      const b = await body(c, z.object({ name: z.string().trim().min(1).max(40) }));
      await n.setName(owner(c), b.name);
    }),
  );
  app.put("/api/nodes/label", (c) =>
    run(c, async () => {
      const b = await body(c, NodeLabelBody);
      await n.setLabel(owner(c), b.fingerprint, b.name);
    }),
  );
  app.post("/api/nodes/backup", (c) =>
    run(c, async () => {
      const b = await body(
        c,
        z.object({ projectId: z.string().min(1), node: z.string().optional() }),
      );
      const ownerId = owner(c);
      const project = await core.projects.get(ownerId, b.projectId);
      if (!project) throw new NodeError("not-found", "No such project");
      const to = b.node ?? (await n.placementFor(ownerId, "", b.projectId)).backups;
      if (!to) throw new NodeError("invalid", "Choose a node for this project's backups first");
      const zip = await projectZip(project.path);
      const day = new Date().toISOString().slice(0, 10);
      const name = `backups/${project.id}/${project.id}-${day}-${Date.now() % 100000}.zip`;
      // In pieces, in order; the node shows the file only once it is whole.
      for (let at = 0; at < zip.length || at === 0; at += PIECE) {
        const piece = zip.subarray(at, at + PIECE);
        await n.request(
          ownerId,
          to,
          "storage",
          {
            action: "put",
            name,
            offset: at,
            data: Buffer.from(piece).toString("base64"),
            last: at + PIECE >= zip.length,
          },
          {
            timeoutMs: 120_000,
            log: { projectId: project.id, what: `backup ${name} (piece at ${at})` },
          },
        );
        if (zip.length === 0) break;
      }
      return { name, bytes: zip.length };
    }),
  );
  app.get("/api/nodes/storage", (c) =>
    run(c, async () => {
      const to = c.req.query("node") ?? "";
      return {
        files: await n.request(owner(c), to, "storage", { action: "list" }, { timeoutMs: 30_000 }),
      };
    }),
  );
}

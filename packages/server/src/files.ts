import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import type { Readable } from "node:stream";
import { LocalWorkspace } from "@redgiant/tools";
import type { RedGiantCore } from "./core.js";
import { BadRequestError, NotFoundError } from "./core.js";

export type FileScope = { kind: "project"; projectId: string } | { kind: "platform" };

export function parseScope(scope: string): FileScope {
  if (scope === "platform") return { kind: "platform" };
  const m = scope.match(/^project:([a-z0-9-]+)$/);
  if (!m?.[1])
    throw new BadRequestError(`Invalid scope "${scope}" (use "platform" or "project:<id>")`);
  return { kind: "project", projectId: m[1] };
}

export interface Entry {
  name: string;
  path: string;
  type: "file" | "dir" | "link";
  size: number;
  modifiedAt: string;
}

/** Files are sent as text when they decode as UTF-8, as base64 otherwise; above this, download them. */
export const MAX_READ_BYTES = 5 * 1024 * 1024;

/**
 * The human's file explorer: a project's workspace, or God's platform directory. Every path
 * goes through the same confinement as the agents' tools; every change is logged.
 */
export class FileService {
  constructor(private readonly core: RedGiantCore) {}

  private async root(
    ownerId: string,
    scope: FileScope,
  ): Promise<{ ws: LocalWorkspace; projectId: string | null }> {
    if (scope.kind === "platform") {
      const dir = this.core.platformPath(ownerId);
      await mkdir(dir, { recursive: true });
      return { ws: new LocalWorkspace(dir), projectId: null };
    }
    const project = await this.core.projects.get(ownerId, scope.projectId);
    if (!project) throw new NotFoundError(`Project "${scope.projectId}" not found`);
    return { ws: new LocalWorkspace(project.path), projectId: project.id };
  }

  private async log(
    ownerId: string,
    projectId: string | null,
    scope: string,
    action: "write" | "mkdir" | "rename" | "delete",
    path: string,
    to?: string,
  ) {
    await this.core.store.append({
      ownerId,
      projectId,
      body: {
        type: "workspace.changed",
        payload: { scope, action, path, ...(to !== undefined && { to }), by: "human" },
      },
    });
  }

  async list(ownerId: string, scopeText: string, path = "."): Promise<Entry[]> {
    const { ws } = await this.root(ownerId, parseScope(scopeText));
    const abs = await ws.resolve(path);
    const out: Entry[] = [];
    for (const d of await readdir(abs, { withFileTypes: true })) {
      const full = `${abs}${sep}${d.name}`;
      const st = await lstat(full).catch(() => undefined);
      if (!st) continue;
      out.push({
        name: d.name,
        path: relative(ws.root, full).split(sep).join("/"),
        type: st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file",
        size: st.isFile() ? st.size : 0,
        modifiedAt: st.mtime.toISOString(),
      });
    }
    return out.sort((a, b) =>
      (a.type === "dir") !== (b.type === "dir")
        ? a.type === "dir"
          ? -1
          : 1
        : a.name.localeCompare(b.name),
    );
  }

  async read(
    ownerId: string,
    scopeText: string,
    path: string,
  ): Promise<{ path: string; encoding: "utf8" | "base64"; content: string; size: number }> {
    const { ws } = await this.root(ownerId, parseScope(scopeText));
    const abs = await ws.resolve(path);
    const st = await stat(abs);
    if (!st.isFile()) throw new BadRequestError(`${path} is not a file`);
    if (st.size > MAX_READ_BYTES)
      throw new BadRequestError(`${path} is larger than 5 MB: download it instead`);
    const bytes = await readFile(abs);
    const text = new TextDecoder("utf-8", { fatal: true });
    try {
      const content = text.decode(bytes);
      if (content.includes("\u0000")) throw new BadRequestError("binary");
      return { path, encoding: "utf8", content, size: st.size };
    } catch {
      return { path, encoding: "base64", content: bytes.toString("base64"), size: st.size };
    }
  }

  async write(
    ownerId: string,
    scopeText: string,
    path: string,
    content: string,
    encoding: "utf8" | "base64" = "utf8",
  ): Promise<void> {
    const { ws, projectId } = await this.root(ownerId, parseScope(scopeText));
    const abs = await ws.resolve(path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, encoding === "base64" ? Buffer.from(content, "base64") : content);
    await this.log(ownerId, projectId, scopeText, "write", path);
  }

  async mkdir(ownerId: string, scopeText: string, path: string): Promise<void> {
    const { ws, projectId } = await this.root(ownerId, parseScope(scopeText));
    await mkdir(await ws.resolve(path), { recursive: true });
    await this.log(ownerId, projectId, scopeText, "mkdir", path);
  }

  async rename(ownerId: string, scopeText: string, from: string, to: string): Promise<void> {
    const { ws, projectId } = await this.root(ownerId, parseScope(scopeText));
    const src = await ws.resolve(from);
    const dst = await ws.resolve(to);
    if (src === ws.root || dst === ws.root)
      throw new BadRequestError("The workspace root cannot be renamed");
    await mkdir(dirname(dst), { recursive: true });
    await rename(src, dst);
    await this.log(ownerId, projectId, scopeText, "rename", from, to);
  }

  async remove(ownerId: string, scopeText: string, path: string): Promise<void> {
    const { ws, projectId } = await this.root(ownerId, parseScope(scopeText));
    const abs = await ws.resolve(path);
    if (abs === ws.root) throw new BadRequestError("The workspace root cannot be deleted");
    await rm(abs, { recursive: true, force: false });
    await this.log(ownerId, projectId, scopeText, "delete", path);
  }

  /** A stream for downloads (any size). */
  async download(
    ownerId: string,
    scopeText: string,
    path: string,
  ): Promise<{ stream: Readable; size: number; name: string }> {
    const { ws } = await this.root(ownerId, parseScope(scopeText));
    const abs = await ws.resolve(path);
    const st = await stat(abs);
    if (!st.isFile()) throw new BadRequestError(`${path} is not a file`);
    return { stream: createReadStream(abs), size: st.size, name: abs.split(sep).pop() ?? "file" };
  }
}

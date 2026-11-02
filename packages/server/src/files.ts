import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, sep } from "node:path";
import type { Readable } from "node:stream";
import { LocalWorkspace } from "@redgiant/tools";
import type { RedGiantCore } from "./core.js";
import { BadRequestError, NotFoundError } from "./core.js";

export type FileScope =
  | { kind: "project"; projectId: string }
  | { kind: "platform" }
  /** The personal assistants' shared desk (G24.11). */
  | { kind: "assistants" };

export function parseScope(scope: string): FileScope {
  if (scope === "platform") return { kind: "platform" };
  if (scope === "assistants") return { kind: "assistants" };
  const m = scope.match(/^project:([a-z0-9-]+)$/);
  if (!m?.[1])
    throw new BadRequestError(
      `Invalid scope "${scope}" (use "platform", "assistants" or "project:<id>")`,
    );
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

/** Deleted files go here (G20.6); deleting inside it is for good. */
export const TRASH = ".trash";

/** Someone else changed the file since it was read: the human chooses what wins. */
export class ConflictError extends Error {
  constructor(
    message: string,
    readonly modifiedAt: string | null,
  ) {
    super(message);
  }
}

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
    if (scope.kind === "assistants") {
      const dir = this.core.assistantsPath(ownerId);
      await mkdir(dir, { recursive: true });
      return { ws: new LocalWorkspace(dir), projectId: null };
    }
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
  ): Promise<{
    path: string;
    encoding: "utf8" | "base64";
    content: string;
    size: number;
    modifiedAt: string;
  }> {
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
      return { path, encoding: "utf8", content, size: st.size, modifiedAt: st.mtime.toISOString() };
    } catch {
      return {
        path,
        encoding: "base64",
        content: bytes.toString("base64"),
        size: st.size,
        modifiedAt: st.mtime.toISOString(),
      };
    }
  }

  async write(
    ownerId: string,
    scopeText: string,
    path: string,
    content: string,
    encoding: "utf8" | "base64" = "utf8",
    opts: {
      /** The file's time when it was read: if it changed since, nothing is written (409). */
      expectedModifiedAt?: string | null | undefined;
      /** For uploads: what to do when the name is taken. */
      ifExists?: "replace" | "keep-both" | "fail" | undefined;
    } = {},
  ): Promise<{ path: string; modifiedAt: string }> {
    const { ws, projectId } = await this.root(ownerId, parseScope(scopeText));
    let target = path;
    let abs = await ws.resolve(target);
    const now = await stat(abs).catch(() => undefined);
    if (opts.expectedModifiedAt !== undefined) {
      const current = now?.mtime.toISOString() ?? null;
      if (current !== opts.expectedModifiedAt)
        throw new ConflictError(`${path} changed since it was opened`, current);
    }
    if (now && opts.ifExists === "fail")
      throw new ConflictError(`${path} already exists`, now.mtime.toISOString());
    if (now && opts.ifExists === "keep-both") {
      const dir = dirname(target);
      const ext = extname(target);
      const stem = basename(target, ext);
      for (let n = 2; ; n++) {
        const candidate = `${dir === "." ? "" : `${dir}/`}${stem} (${n})${ext}`;
        const candAbs = await ws.resolve(candidate);
        if (!(await stat(candAbs).catch(() => undefined))) {
          target = candidate;
          abs = candAbs;
          break;
        }
      }
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, encoding === "base64" ? Buffer.from(content, "base64") : content);
    await this.log(ownerId, projectId, scopeText, "write", target);
    return { path: target, modifiedAt: (await stat(abs)).mtime.toISOString() };
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
    const trashRoot = await ws.resolve(TRASH);
    if (abs === trashRoot || abs.startsWith(`${trashRoot}${sep}`)) {
      // Already in the trash: this time it is for good.
      await rm(abs, { recursive: true, force: false });
      await this.log(ownerId, projectId, scopeText, "delete", path);
      return;
    }
    await lstat(abs); // a missing path fails here, like rm would
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const to = `${TRASH}/${stamp}/${relative(ws.root, abs).split(sep).join("/")}`;
    const dst = await ws.resolve(to);
    await mkdir(dirname(dst), { recursive: true });
    await rename(abs, dst);
    await this.log(ownerId, projectId, scopeText, "delete", path, to);
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

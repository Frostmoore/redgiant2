// The person's artifacts (3.5.9, study_artifacts.md §5.1 and §5.4): every `artefatti/*.html` in
// the places they see (God's folder, the assistants' desk, every project), the `.rgartifact`
// export (a zip: artifact.html, manifest.json, data.json when there is a memory, from 3.6) and
// the import that checks everything before writing one file and never runs anything.
//
// «Imported, not yet run»: an import writes `artifact.imported` to the log; «Run» writes
// `artifact.run`. The pending set is rebuilt from the log (`pendingRun`), so the Canvas can open
// an imported artifact on its source with «Run» the first time, whatever restarted in between.
import { createHash } from "node:crypto";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ARTIFACT_DIR,
  ArtifactHeader,
  ArtifactManifest,
  artifactHeaderOf,
  withArtifactHeader,
} from "@redgiant/protocol";
import { LocalWorkspace } from "@redgiant/tools";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { BadRequestError, NotFoundError, type RedGiantCore } from "./core.js";
import { FileService } from "./files.js";
import { installedVersion } from "./updates.js";

/** One artifact in the collection. */
export interface ArtifactInfo {
  /** The place it lives in: "platform", "assistants" or "project:<id>". */
  scope: string;
  /** The place's name (a project's name; God's folder and the desk are named by the page). */
  place: string;
  projectId: string | null;
  /** Its path inside the place, `artefatti/<file>`. */
  path: string;
  file: string;
  /** The header's name, or the file's name without `.html` when it has none. */
  name: string;
  /** Whether the file starts with a valid header. */
  header: boolean;
  version: number | null;
  libs: string[];
  /** Capabilities it asks for (3.6); granted only by the person, never by the file. */
  wants: string[];
  /** Capabilities the person granted it: none before 3.6, and never carried by an import. */
  granted: string[];
  from: string | null;
  size: number;
  modifiedAt: string;
  /** The place is an archived project: read only (no delete, no import into it). */
  readOnly: boolean;
  /** Imported and never run: the Canvas opens it on its source with «Run». */
  pendingRun: boolean;
}

/** A `.rgartifact` above this is refused before it is opened. */
export const MAX_ARTIFACT_ZIP = 10 * 1024 * 1024;
/** Its files, once unpacked, may not be bigger than this together (a zip bomb stops here). */
export const MAX_ARTIFACT_UNPACKED = 20 * 1024 * 1024;
/** The only names a `.rgartifact` may hold. */
const ENTRIES = new Set(["artifact.html", "manifest.json", "data.json"]);

/** A name inside the zip that could leave the folder or hide something: refused. */
const unsafeEntry = (name: string) =>
  name === "" ||
  /[\\/:]/.test(name) ||
  name.split(/[\\/]/).includes("..") ||
  name.startsWith(".") ||
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
  /[\u0000-\u001f\u007f]/.test(name);

/** A file name from an artifact's name: letters, digits, spaces, dots, dashes; never a path. */
export function artifactFileName(name: string): string {
  const base = name
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} ._-]+/gu, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
  return `${base || "artefatto"}.html`;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const key = (scope: string, path: string) => `${scope}\n${path}`;

/** Why an import was refused, in words the page shows. */
export class ArtifactImportError extends BadRequestError {}

export class ArtifactService {
  private readonly files: FileService;

  constructor(
    private readonly core: RedGiantCore,
    files?: FileService,
  ) {
    this.files = files ?? new FileService(core);
  }

  /** The imported artifacts not run yet, per place and path, from the log. */
  async pendingRun(ownerId: string): Promise<Set<string>> {
    const out = new Set<string>();
    for (const e of await this.core.store.list({
      types: ["artifact.imported", "artifact.run", "workspace.changed"],
    })) {
      if (e.ownerId !== ownerId) continue;
      const p = e.payload as { scope: string; path: string; action?: string; to?: string };
      if (e.type === "artifact.imported") out.add(key(p.scope, p.path));
      else if (e.type === "artifact.run") out.delete(key(p.scope, p.path));
      // Deleted or moved by the person: whatever is written there next is another file.
      else if (p.action === "delete" || p.action === "rename") out.delete(key(p.scope, p.path));
    }
    return out;
  }

  /** Whether this artifact was imported and has not run yet. */
  async isPendingRun(ownerId: string, scope: string, path: string): Promise<boolean> {
    return (await this.pendingRun(ownerId)).has(key(scope, path));
  }

  /** «Run» on an imported artifact: it opens as an app from now on. */
  async markRun(ownerId: string, scope: string, path: string): Promise<{ pendingRun: false }> {
    if (await this.isPendingRun(ownerId, scope, path))
      await this.core.store.append({
        ownerId,
        projectId: scope.match(/^project:([a-z0-9-]+)$/)?.[1] ?? null,
        body: { type: "artifact.run", payload: { scope, path, by: "human" } },
      });
    return { pendingRun: false };
  }

  /** Every artifact the person sees, newest first. */
  async list(ownerId: string): Promise<ArtifactInfo[]> {
    const pending = await this.pendingRun(ownerId);
    const out: ArtifactInfo[] = [];
    for (const place of await this.core.knowledgePlaces(ownerId)) {
      const dir = join(place.root, ARTIFACT_DIR);
      const names = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const projectId = place.scope.match(/^project:([a-z0-9-]+)$/)?.[1] ?? null;
      const readOnly = this.core.readOnlyScope(ownerId, place.scope);
      for (const d of names) {
        if (!d.isFile() || !/\.html?$/i.test(d.name)) continue;
        const abs = join(dir, d.name);
        const st = await stat(abs).catch(() => undefined);
        if (!st) continue;
        // Only the start is read: the header is the first thing in the file.
        const head = await readStart(abs);
        const h = artifactHeaderOf(head);
        const path = `${ARTIFACT_DIR}/${d.name}`;
        out.push({
          scope: place.scope,
          place: place.name,
          projectId,
          path,
          file: d.name,
          name: h?.name ?? d.name.replace(/\.html?$/i, ""),
          header: h !== undefined,
          version: h?.version ?? null,
          libs: h?.libs ?? [],
          wants: h?.wants ?? [],
          granted: [],
          from: h?.from ?? null,
          size: st.size,
          modifiedAt: st.mtime.toISOString(),
          readOnly,
          pendingRun: pending.has(key(place.scope, path)),
        });
      }
    }
    return out.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  }

  /** The artifact's text, confined to its place like the file explorer's reads. */
  private async text(ownerId: string, scope: string, path: string): Promise<string> {
    if (!/^artefatti\/[^\\/]+\.html?$/i.test(path))
      throw new BadRequestError(`${path} is not an artifact (artefatti/<name>.html)`);
    const root = await this.core.scopeFolder(ownerId, scope).catch(() => {
      throw new NotFoundError(`No such place "${scope}"`);
    });
    const abs = await new LocalWorkspace(root).resolve(path);
    return readFile(abs, "utf8").catch(() => {
      throw new NotFoundError(`${path} not found`);
    });
  }

  /**
   * A `.rgartifact`: the HTML (with a header written when it had none, so the other RedGiant
   * knows its name), its manifest with the file's sha256, and no data (storage comes in 3.6).
   */
  async exportZip(
    ownerId: string,
    scope: string,
    path: string,
  ): Promise<{ bytes: Uint8Array; name: string }> {
    const raw = await this.text(ownerId, scope, path);
    const file = path.split("/").pop() ?? "artefatto.html";
    const header =
      artifactHeaderOf(raw) ?? ArtifactHeader.parse({ name: file.replace(/\.html?$/i, "") });
    const html = strToU8(artifactHeaderOf(raw) ? raw : withArtifactHeader(raw, header));
    const manifest: ArtifactManifest = {
      format: "rgartifact-1",
      header,
      sha256: sha256(html),
      redgiant: installedVersion() ?? "source",
      hasData: false,
    };
    const bytes = zipSync({
      "artifact.html": html,
      "manifest.json": strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
    });
    return { bytes, name: `${file.replace(/\.html?$/i, "")}.rgartifact` };
  }

  /** The bare HTML, to open outside RedGiant (without the isolated frame). */
  async exportHtml(
    ownerId: string,
    scope: string,
    path: string,
  ): Promise<{ text: string; name: string }> {
    return { text: await this.text(ownerId, scope, path), name: path.split("/").pop() ?? "" };
  }

  /**
   * A `.rgartifact` into a place's `artefatti/`: checked whole before anything is written (size,
   * names, exactly one HTML, manifest, sha256, header), written as a new file (a taken name
   * becomes «name (2).html»), with no capability granted, and marked «not run yet». Nothing in
   * it runs here.
   */
  async importZip(
    ownerId: string,
    scope: string,
    zip: Uint8Array,
  ): Promise<{ path: string; name: string; header: ArtifactHeader; dataIgnored: boolean }> {
    // The place first: an archived project or a place that is not theirs refuses before reading.
    this.core.assertWritable(ownerId, scope);
    await this.core.scopeFolder(ownerId, scope).catch(() => {
      throw new NotFoundError(`No such place "${scope}"`);
    });
    const files = readArtifactZip(zip);
    const html = files["artifact.html"] as Uint8Array;
    const manifestText = files["manifest.json"];
    if (!manifestText) throw new ArtifactImportError("The file has no manifest.json");
    let manifest: ArtifactManifest;
    try {
      const r = ArtifactManifest.safeParse(JSON.parse(strFromU8(manifestText)));
      if (!r.success) throw new Error(r.error.issues.map((i) => i.message).join("; "));
      manifest = r.data;
    } catch (err) {
      throw new ArtifactImportError(`manifest.json is not valid: ${(err as Error).message}`);
    }
    if (sha256(html) !== manifest.sha256)
      throw new ArtifactImportError(
        "artifact.html does not match its manifest (sha256): it was changed or damaged",
      );
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(html);
    } catch {
      throw new ArtifactImportError("artifact.html is not UTF-8 text");
    }
    const header = artifactHeaderOf(text);
    if (!header)
      throw new ArtifactImportError(
        "artifact.html has no valid header (<!-- redgiant-artifact {…} -->)",
      );
    const written = await this.files.write(
      ownerId,
      scope,
      `${ARTIFACT_DIR}/${artifactFileName(header.name)}`,
      text,
      "utf8",
      { ifExists: "keep-both" },
    );
    await this.core.store.append({
      ownerId,
      projectId: scope.match(/^project:([a-z0-9-]+)$/)?.[1] ?? null,
      body: {
        type: "artifact.imported",
        payload: { scope, path: written.path, name: header.name, by: "human" },
      },
    });
    return {
      path: written.path,
      name: header.name,
      header,
      dataIgnored: files["data.json"] !== undefined,
    };
  }
}

/** The first bytes of a file, enough for its header. */
async function readStart(abs: string): Promise<string> {
  const f = await open(abs, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await f.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await f.close();
  }
}

/**
 * The files of a `.rgartifact`, checked before any is unpacked: its size, safe names only,
 * exactly one HTML (`artifact.html`), nothing else but the manifest and the data, and sizes that
 * stay small once unpacked.
 */
export function readArtifactZip(zip: Uint8Array): Record<string, Uint8Array> {
  if (zip.byteLength > MAX_ARTIFACT_ZIP)
    throw new ArtifactImportError(
      `The file is larger than ${MAX_ARTIFACT_ZIP / 1024 / 1024} MB: not an artifact`,
    );
  const seen: string[] = [];
  let unpacked = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip, {
      filter: (f) => {
        seen.push(f.name);
        unpacked += f.originalSize;
        // Nothing is inflated while the list is being checked: the checks come after.
        return false;
      },
    });
  } catch {
    throw new ArtifactImportError("The file is not a valid .rgartifact (zip)");
  }
  const bad = seen.find(unsafeEntry);
  if (bad !== undefined) throw new ArtifactImportError(`Unsafe name inside the file: «${bad}»`);
  const htmls = seen.filter((n) => /\.html?$/i.test(n));
  if (htmls.length !== 1 || htmls[0] !== "artifact.html")
    throw new ArtifactImportError(
      `A .rgartifact holds exactly one HTML, artifact.html (found ${htmls.length})`,
    );
  const other = seen.find((n) => !ENTRIES.has(n));
  if (other !== undefined) throw new ArtifactImportError(`Unexpected file inside: «${other}»`);
  if (new Set(seen).size !== seen.length)
    throw new ArtifactImportError("The same name appears twice inside the file");
  if (unpacked > MAX_ARTIFACT_UNPACKED)
    throw new ArtifactImportError("The file unpacks to too much: not an artifact");
  try {
    files = unzipSync(zip);
  } catch {
    throw new ArtifactImportError("The file is not a valid .rgartifact (zip)");
  }
  // The sizes the zip declared could lie: what came out is measured again.
  const real = Object.values(files).reduce((a, b) => a + b.byteLength, 0);
  if (real > MAX_ARTIFACT_UNPACKED)
    throw new ArtifactImportError("The file unpacks to too much: not an artifact");
  return files;
}

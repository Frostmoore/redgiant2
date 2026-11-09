import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import type { SqlClient } from "@redgiant/events";

export interface Project {
  id: string;
  ownerId: string;
  name: string;
  /** Workspace directory as seen by the server. */
  path: string;
  createdAt: string;
  /** Archived (2026-11-09): out of every list and read only until it is restored. */
  archivedAt?: string;
}

/** What archiving a project paused, to put back exactly when it is restored. */
export interface ArchivedState {
  /** Automations that were on and were switched off by the archive. */
  paused: string[];
}

/**
 * A part of a project (G24.13): its own subfolder, agents, budget; the project's orchestrator
 * leads it, and the rest of the project folder is the shared part.
 */
export interface Subproject {
  id: string;
  projectId: string;
  name: string;
  /** The folder, relative to the project's ("apps/shop"). */
  dir: string;
  /** Its own sandbox image (different tools, e.g. Flutter); none: the project's sandbox. */
  image?: string;
  createdAt: string;
}

export class SubprojectError extends Error {}

/** A project that cannot be made as asked (the name, the folder). */
export class ProjectError extends Error {}

export async function migrateProjects(db: SqlClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_subprojects (
      id         text NOT NULL,
      owner_id   text NOT NULL,
      project_id text NOT NULL,
      name       text NOT NULL,
      dir        text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_id, id)
    )`);
  await db.query("ALTER TABLE rg_subprojects ADD COLUMN IF NOT EXISTS image text");
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_projects (
      id         text NOT NULL,
      owner_id   text NOT NULL,
      name       text NOT NULL,
      path       text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_id, id)
    )`);
  // A whole project archived (2026-11-09): when, and what the archive paused.
  await db.query("ALTER TABLE rg_projects ADD COLUMN IF NOT EXISTS archived_at timestamptz");
  await db.query("ALTER TABLE rg_projects ADD COLUMN IF NOT EXISTS archived_state jsonb");
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_sessions (
      id         text PRIMARY KEY,
      owner_id   text NOT NULL,
      agent_id   text NOT NULL,
      project_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  // A session can use its own model (automations); null = the agent's.
  await db.query("ALTER TABLE rg_sessions ADD COLUMN IF NOT EXISTS model jsonb");
  // For the list of conversations (the log itself is never touched): a title, pinned, archived.
  await db.query("ALTER TABLE rg_sessions ADD COLUMN IF NOT EXISTS title text");
  await db.query(
    "ALTER TABLE rg_sessions ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false",
  );
  await db.query(
    "ALTER TABLE rg_sessions ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false",
  );
  await db.query("ALTER TABLE rg_sessions ADD COLUMN IF NOT EXISTS last_at timestamptz");
  // Folders of conversations (2026-11-03): a name, or none.
  await db.query("ALTER TABLE rg_sessions ADD COLUMN IF NOT EXISTS folder text");
  // A conversation that goes on from another one (G36.23): the link the list shows.
  await db.query("ALTER TABLE rg_sessions ADD COLUMN IF NOT EXISTS forked_from text");
  // Work conversations once named after the task's id ("[Task task_… from God: title]"): the
  // readable name they have now ("God: title").
  await db.query(
    String.raw`UPDATE rg_sessions SET title = rtrim(regexp_replace(title, '^\[Task task_[0-9a-f]+ from ([^:]+): (.*)$', '\1: \2'), ']') WHERE title LIKE '[Task task\_%'`,
  );
}

export const slug = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

/** Where a project may live when it adopts a folder that already exists (G36.15). */
export interface FolderRules {
  /** RedGiant's data folder: never inside it (the keychain, the database), nor above it. */
  dataDir: string;
  /** The person's home folder: a folder in it is fine, the home itself is not. */
  home?: string | undefined;
  /**
   * Sandboxes that mount from the data volume (the Docker image) only reach folders under
   * this one: there the folder must be inside it, and the data-folder rule gives way to it.
   */
  inside?: string | undefined;
}

/** System folders: never a project, nor anything inside them. */
const SYSTEM_TREES = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib32",
  "/lib64",
  "/proc",
  "/run",
  "/sbin",
  "/sys",
  "/usr",
  "/System",
  "/Library",
  "/Applications",
  // On a Mac /etc lives here (/tmp and /var/folders under /private are fine).
  "/private/etc",
];
/** Folders that hold everyone's things: a folder inside them is fine, they themselves are not. */
const SHARED_ROOTS = [
  "/",
  "/home",
  "/Users",
  "/var",
  "/opt",
  "/mnt",
  "/media",
  "/srv",
  "/root",
  "/Volumes",
];
const WINDOWS_TREES = ["windows", "program files", "program files (x86)", "programdata"];
const WINDOWS_ROOTS = ["users"];

const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");

/**
 * Why a folder cannot become a project, or undefined when it can (pure: tested as a table).
 * `others` are the folders of the projects that exist: folders never overlap.
 */
export function folderProblem(
  path: string,
  rules: FolderRules,
  others: readonly string[],
): string | undefined {
  const win = isWindowsPath(path);
  if (!win && !posix.isAbsolute(path))
    return "The folder must be a full path (like /home/me/code/shop)";
  const lib = win ? win32 : posix;
  const key = (x: string) => {
    const n = lib.normalize(x).replace(/[\\/]+$/, "");
    return win ? n.toLowerCase() : n || "/";
  };
  const sep = win ? "\\" : "/";
  const p = key(path);
  const within = (a: string, root: string) =>
    a === root || a.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
  const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
  if (win) {
    const drive = p.slice(0, 2);
    if (p.length <= 3 || WINDOWS_ROOTS.some((r) => p === `${drive}\\${r}`))
      return "Not a whole drive or a shared folder: choose the project's own folder";
    if (WINDOWS_TREES.some((t) => within(p, `${drive}\\${t}`))) return "Not a system folder";
  } else {
    if (SHARED_ROOTS.includes(p)) return "Not a shared folder: choose the project's own folder";
    if (SYSTEM_TREES.some((t) => within(p, t))) return "Not a system folder";
  }
  if (rules.home && p === key(rules.home))
    return "Not the whole home folder: choose the project's own folder";
  if (rules.inside) {
    const inside = key(rules.inside);
    if (p === inside || !within(p, inside))
      return `Here projects live in the data volume: choose a folder inside ${rules.inside}`;
  } else if (overlaps(p, key(rules.dataDir))) return "Not RedGiant's own data folder";
  const clash = others.find((o) => overlaps(p, key(o)));
  if (clash) return `It overlaps the folder of another project (${clash})`;
  return undefined;
}

interface Row {
  id: string;
  owner_id: string;
  name: string;
  path: string;
  created_at: Date | string;
  archived_at?: Date | string | null;
}

const fromRow = (r: Row): Project => ({
  id: r.id,
  ownerId: r.owner_id,
  name: r.name,
  path: r.path,
  createdAt: new Date(r.created_at).toISOString(),
  ...(r.archived_at && { archivedAt: new Date(r.archived_at).toISOString() }),
});

interface SubRow {
  id: string;
  project_id: string;
  name: string;
  dir: string;
  image?: string | null;
  created_at: Date | string;
}

const fromSubRow = (r: SubRow): Subproject => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  dir: r.dir,
  ...(r.image && { image: r.image }),
  createdAt: new Date(r.created_at).toISOString(),
});

/** Projects: one workspace directory each, under `<workspacesDir>/<owner>/<id>`. */
export class ProjectStore {
  constructor(
    private readonly db: SqlClient,
    private readonly workspacesDir: string,
    /** Folders under this one only, for projects that adopt a folder (the Docker image). */
    private readonly foldersInside?: string,
  ) {}

  /** Called after a project is created (its repository, G24.5). */
  onCreate: ((project: Project) => Promise<void>) | undefined;

  /**
   * A new project: a new folder under the workspaces, or (`folder`, G36.15) one that already
   * exists, which the project adopts as it is (no repository is created or rewired for it).
   */
  async create(ownerId: string, name: string, folder?: string): Promise<Project> {
    const id = slug(name);
    if (!id) throw new ProjectError("The project name needs letters or digits");
    const path =
      folder === undefined
        ? join(this.workspacesDir, slug(ownerId) || "owner", id)
        : await this.adoptable(folder.trim());
    try {
      await this.db.query(
        "INSERT INTO rg_projects (id, owner_id, name, path) VALUES ($1, $2, $3, $4)",
        [id, ownerId, name, path],
      );
    } catch (err) {
      if (/unique|duplicate/i.test(String(err)))
        throw new ProjectError(`A project "${id}" already exists`);
      throw err;
    }
    const project = (await this.get(ownerId, id)) as Project;
    if (folder !== undefined) return project;
    await mkdir(path, { recursive: true });
    // Its repository on GitHub or Gitea (G24.5): a failure there does not undo the project.
    await this.onCreate?.(project).catch((err) =>
      console.warn(`project ${id}: no repository: ${(err as Error).message}`),
    );
    return project;
  }

  /** The folder as it really is (links followed), once every rule lets it be a project. */
  private async adoptable(folder: string): Promise<string> {
    const rules: FolderRules = {
      dataDir: dirname(this.workspacesDir),
      home: homedir(),
      inside: this.foldersInside,
    };
    const first = folderProblem(folder, rules, []);
    if (first) throw new ProjectError(first);
    let real: string;
    try {
      real = await realpath(folder);
      if (!(await stat(real)).isDirectory()) throw new Error("not a folder");
    } catch {
      throw new ProjectError(`No folder at ${folder}`);
    }
    const others = (await this.db.query<{ path: string }>("SELECT path FROM rg_projects")).map(
      (r) => r.path,
    );
    // Checked again where links lead: a link must not open a way into a forbidden folder.
    const real_ = async (x: string | undefined) => x && (await realpath(x).catch(() => x));
    const problem = folderProblem(
      real,
      {
        dataDir: (await real_(rules.dataDir)) as string,
        home: await real_(rules.home),
        inside: await real_(rules.inside),
      },
      others,
    );
    if (problem) throw new ProjectError(problem);
    return real;
  }

  async get(ownerId: string, id: string): Promise<Project | undefined> {
    const [r] = await this.db.query<Row>(
      "SELECT * FROM rg_projects WHERE owner_id = $1 AND id = $2",
      [ownerId, id],
    );
    return r ? fromRow(r) : undefined;
  }

  /**
   * A new subproject: a new folder, or one that already exists (for code already split so).
   * Folders never overlap: one subproject cannot sit inside another.
   */
  async createSubproject(
    ownerId: string,
    projectId: string,
    name: string,
    dir?: string,
  ): Promise<Subproject> {
    const project = await this.get(ownerId, projectId);
    if (!project) throw new SubprojectError(`No project "${projectId}"`);
    const key = slug(name);
    if (!key) throw new SubprojectError("The name needs letters or digits");
    const folder = posix
      .normalize((dir?.trim() || key).replaceAll("\\", "/"))
      .replace(/^(\.\/)+|\/+$/g, "");
    if (
      !folder ||
      folder === "." ||
      folder.startsWith("..") ||
      posix.isAbsolute(folder) ||
      folder.startsWith(".git")
    )
      throw new SubprojectError("The folder must be inside the project");
    const siblings = await this.subprojects(ownerId, projectId);
    const overlaps = (a: string, b: string) =>
      a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    const clash = siblings.find((s) => overlaps(s.dir, folder));
    if (clash) throw new SubprojectError(`"${folder}" overlaps the subproject ${clash.name}`);
    const id = `${projectId}--${key}`;
    if (siblings.some((s) => s.id === id))
      throw new SubprojectError(`A subproject "${name}" already exists`);
    await mkdir(join(project.path, folder), { recursive: true });
    await this.db.query(
      "INSERT INTO rg_subprojects (id, owner_id, project_id, name, dir) VALUES ($1, $2, $3, $4, $5)",
      [id, ownerId, projectId, name, folder],
    );
    return (await this.subproject(ownerId, id)) as Subproject;
  }

  /** A project that went into another (G24.14c): its row goes, its code lives on there. */
  async forget(ownerId: string, id: string): Promise<void> {
    await this.db.query("DELETE FROM rg_projects WHERE owner_id = $1 AND id = $2", [ownerId, id]);
  }

  /** Its own sandbox image, or the project's again (null). Takes effect for new sessions. */
  async setSubprojectImage(ownerId: string, id: string, image: string | null): Promise<void> {
    if (image !== null && !/^[\w.\-/:@]+$/.test(image))
      throw new SubprojectError("Not an image name (like ghcr.io/cirruslabs/flutter:stable)");
    await this.db.query("UPDATE rg_subprojects SET image = $3 WHERE owner_id = $1 AND id = $2", [
      ownerId,
      id,
      image,
    ]);
  }

  async subprojects(ownerId: string, projectId?: string): Promise<Subproject[]> {
    const rows = await this.db.query<SubRow>(
      projectId === undefined
        ? "SELECT * FROM rg_subprojects WHERE owner_id = $1 ORDER BY created_at"
        : "SELECT * FROM rg_subprojects WHERE owner_id = $1 AND project_id = $2 ORDER BY created_at",
      projectId === undefined ? [ownerId] : [ownerId, projectId],
    );
    return rows.map(fromSubRow);
  }

  async subproject(ownerId: string, id: string): Promise<Subproject | undefined> {
    const [r] = await this.db.query<SubRow>(
      "SELECT * FROM rg_subprojects WHERE owner_id = $1 AND id = $2",
      [ownerId, id],
    );
    return r ? fromSubRow(r) : undefined;
  }

  /**
   * Archives a project (`state`: what the archive paused) or restores it (null). Only the row's
   * mark changes: the folder, the agents, the conversations and the tasks stay as they are.
   */
  async setArchived(ownerId: string, id: string, state: ArchivedState | null): Promise<void> {
    await this.db.query(
      state
        ? "UPDATE rg_projects SET archived_at = now(), archived_state = $3 WHERE owner_id = $1 AND id = $2"
        : "UPDATE rg_projects SET archived_at = NULL, archived_state = NULL WHERE owner_id = $1 AND id = $2",
      state ? [ownerId, id, JSON.stringify(state)] : [ownerId, id],
    );
  }

  /** What the archive of this project paused (none when it is not archived). */
  async archivedState(ownerId: string, id: string): Promise<ArchivedState | undefined> {
    const [r] = await this.db.query<{ archived_state: ArchivedState | string | null }>(
      "SELECT archived_state FROM rg_projects WHERE owner_id = $1 AND id = $2 AND archived_at IS NOT NULL",
      [ownerId, id],
    );
    if (!r?.archived_state) return undefined;
    return typeof r.archived_state === "string"
      ? (JSON.parse(r.archived_state) as ArchivedState)
      : r.archived_state;
  }

  /** Every archived project of every owner (the registry learns them at start). */
  async archived(): Promise<{ ownerId: string; id: string }[]> {
    return (
      await this.db.query<{ owner_id: string; id: string }>(
        "SELECT owner_id, id FROM rg_projects WHERE archived_at IS NOT NULL",
      )
    ).map((r) => ({ ownerId: r.owner_id, id: r.id }));
  }

  async list(ownerId: string): Promise<Project[]> {
    return (
      await this.db.query<Row>(
        "SELECT * FROM rg_projects WHERE owner_id = $1 ORDER BY created_at",
        [ownerId],
      )
    ).map(fromRow);
  }
}

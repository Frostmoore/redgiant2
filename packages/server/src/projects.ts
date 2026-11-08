import { mkdir } from "node:fs/promises";
import { join, posix } from "node:path";
import type { SqlClient } from "@redgiant/events";

export interface Project {
  id: string;
  ownerId: string;
  name: string;
  /** Workspace directory as seen by the server. */
  path: string;
  createdAt: string;
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

interface Row {
  id: string;
  owner_id: string;
  name: string;
  path: string;
  created_at: Date | string;
}

const fromRow = (r: Row): Project => ({
  id: r.id,
  ownerId: r.owner_id,
  name: r.name,
  path: r.path,
  createdAt: new Date(r.created_at).toISOString(),
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
  ) {}

  /** Called after a project is created (its repository, G24.5). */
  onCreate: ((project: Project) => Promise<void>) | undefined;

  async create(ownerId: string, name: string): Promise<Project> {
    const id = slug(name);
    if (!id) throw new Error("The project name needs letters or digits");
    const path = join(this.workspacesDir, slug(ownerId) || "owner", id);
    try {
      await this.db.query(
        "INSERT INTO rg_projects (id, owner_id, name, path) VALUES ($1, $2, $3, $4)",
        [id, ownerId, name, path],
      );
    } catch (err) {
      if (/unique|duplicate/i.test(String(err)))
        throw new Error(`A project "${id}" already exists`);
      throw err;
    }
    await mkdir(path, { recursive: true });
    const project = (await this.get(ownerId, id)) as Project;
    // Its repository on GitHub or Gitea (G24.5): a failure there does not undo the project.
    await this.onCreate?.(project).catch((err) =>
      console.warn(`project ${id}: no repository: ${(err as Error).message}`),
    );
    return project;
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

  async list(ownerId: string): Promise<Project[]> {
    return (
      await this.db.query<Row>(
        "SELECT * FROM rg_projects WHERE owner_id = $1 ORDER BY created_at",
        [ownerId],
      )
    ).map(fromRow);
  }
}

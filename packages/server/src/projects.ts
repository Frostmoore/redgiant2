import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SqlClient } from "@redgiant/events";

export interface Project {
  id: string;
  ownerId: string;
  name: string;
  /** Workspace directory as seen by the server. */
  path: string;
  createdAt: string;
}

export async function migrateProjects(db: SqlClient): Promise<void> {
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

/** Projects: one workspace directory each, under `<workspacesDir>/<owner>/<id>`. */
export class ProjectStore {
  constructor(
    private readonly db: SqlClient,
    private readonly workspacesDir: string,
  ) {}

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
    return (await this.get(ownerId, id)) as Project;
  }

  async get(ownerId: string, id: string): Promise<Project | undefined> {
    const [r] = await this.db.query<Row>(
      "SELECT * FROM rg_projects WHERE owner_id = $1 AND id = $2",
      [ownerId, id],
    );
    return r ? fromRow(r) : undefined;
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

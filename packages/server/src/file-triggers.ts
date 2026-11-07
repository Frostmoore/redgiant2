// Routines on files (G33.3): a folder of a project, looked at every minute. The first look only
// remembers what is there; then what was added, changed or removed starts the routine once, the
// list of files given to the agent as data. Only folders inside the project are watched.
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { AutomationService, FileChange } from "@redgiant/automations";

/** Folders never looked into. */
const SKIP = new Set([".git", "node_modules", ".redgiant", "dist", ".cache", "__pycache__"]);
/** The most files remembered for one folder. */
const MAX_FILES = 5000;

/** A glob as a regular expression: `*` within a name, `**` across folders, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A pattern without a folder matches the name anywhere.
  return glob.includes("/") ? new RegExp(`^${re}$`, "i") : new RegExp(`(^|/)${re}$`, "i");
}

/** What a folder holds: each file's path (relative to the project) and its size and time. */
async function snapshot(root: string, dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string): Promise<void> => {
    if (out.size >= MAX_FILES) return;
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (out.size >= MAX_FILES) return;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(full);
      } else if (e.isFile()) {
        const s = await stat(full).catch(() => undefined);
        if (s) out.set(relative(root, full).split(sep).join("/"), `${s.size}:${s.mtimeMs}`);
      }
    }
  };
  await walk(dir);
  return out;
}

export class FileTriggers {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  /** What each automation saw last time, by its id and folder. */
  private readonly seen = new Map<string, { key: string; files: Map<string, string> }>();

  constructor(
    private readonly o: {
      automations: AutomationService;
      /** The folder of a project, or undefined when it does not exist. */
      projectPath(ownerId: string, projectId: string): Promise<string | undefined>;
    },
  ) {}

  /** One look at every watched folder; returns how many runs started. */
  async check(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let started = 0;
    try {
      const watching = await this.o.automations.watchingFiles();
      const ids = new Set(watching.map((w) => w.id));
      for (const id of this.seen.keys()) if (!ids.has(id)) this.seen.delete(id);
      for (const w of watching) {
        const f = w.recipe.on.files;
        const project = f?.project ?? w.recipe.project;
        if (!f || !project) continue;
        const root = await this.o.projectPath(w.ownerId, project);
        if (!root) continue;
        const dir = resolve(root, f.path);
        // Never outside the project.
        if (dir !== resolve(root) && !dir.startsWith(resolve(root) + sep)) continue;
        const key = `${dir}|${f.pattern ?? ""}`;
        const match = f.pattern ? globToRegExp(f.pattern) : undefined;
        const all = await snapshot(root, dir);
        const files = new Map([...all].filter(([p]) => !match || match.test(p)));
        const before = this.seen.get(w.id);
        this.seen.set(w.id, { key, files });
        // The first look (or a new folder) only remembers.
        if (!before || before.key !== key) continue;
        const changes: FileChange[] = [];
        for (const [p, v] of files) {
          const old = before.files.get(p);
          if (old === undefined) changes.push({ path: p, change: "added" });
          else if (old !== v) changes.push({ path: p, change: "changed" });
        }
        for (const p of before.files.keys())
          if (!files.has(p)) changes.push({ path: p, change: "removed" });
        if (changes.length === 0) continue;
        const run = await this.o.automations
          .filesChanged(w.ownerId, w.id, changes)
          .catch(() => null);
        if (run) {
          started++;
          run.done.catch(() => {});
        }
      }
    } finally {
      this.running = false;
    }
    return started;
  }

  start(everyMs = 60_000): void {
    void this.check().catch(() => {});
    this.timer = setInterval(() => void this.check().catch(() => {}), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

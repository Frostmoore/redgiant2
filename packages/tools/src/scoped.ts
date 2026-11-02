// A subproject's view of its project (G24.13): the whole folder is there, but an agent writes
// only in its own subfolder, reads the shared parts, and does not see the other subprojects.
// Commands start in its subfolder. What a command writes elsewhere is caught when the work is
// merged (the orchestrator decides), since a shell cannot be fenced file by file.
import { posix } from "node:path";
import {
  type ExecOptions,
  type ExecResult,
  ReadOnlyWorkspaceError,
  type Terminal,
  type TerminalOptions,
  type Workspace,
} from "./workspace.js";

export class OutsideSubprojectError extends Error {}

/** A relative, normalised, forward-slash path; leading "./" and "/" removed. */
const norm = (path: string) =>
  posix.normalize(path.replaceAll("\\", "/")).replace(/^(\.\/|\/)+/, "");
const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/** Single-quoted for a POSIX shell. */
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export class SubprojectWorkspace implements Workspace {
  readonly root: string;
  readonly readOnly: boolean;

  constructor(
    private readonly inner: Workspace,
    /** Its own folder, relative to the root ("apps/shop"). */
    readonly own: string,
    /** The other subprojects' folders: hidden. */
    readonly hidden: string[],
    readOnly = inner.readOnly,
  ) {
    this.root = inner.root;
    this.readOnly = readOnly;
    this.own = norm(own);
    this.hidden = hidden.map(norm).filter((h) => h && !within(this.own, h));
  }

  /** Relative to the root; an absolute path outside it is left as is (the workspace refuses it). */
  private rel(path: string): string | null {
    const p = path.replaceAll("\\", "/");
    if (!posix.isAbsolute(p)) return norm(p);
    const root = this.root.replaceAll("\\", "/").replace(/\/+$/, "");
    return p === root || p.startsWith(`${root}/`) ? norm(p.slice(root.length)) : null;
  }

  private visible(path: string): string {
    const p = this.rel(path);
    if (p === null) return path;
    if (this.hidden.some((h) => within(p, h)))
      throw new OutsideSubprojectError(
        `"${path}" belongs to another subproject: ask the project's orchestrator`,
      );
    return p;
  }

  async readText(path: string): Promise<string> {
    return this.inner.readText(this.visible(path));
  }

  async writeText(path: string, content: string): Promise<void> {
    if (this.readOnly) throw new ReadOnlyWorkspaceError();
    const p = this.visible(path);
    if (!within(p, this.own))
      throw new OutsideSubprojectError(
        `"${path}" is outside your subproject (${this.own}/): shared parts are changed by the project's orchestrator; ask it`,
      );
    return this.inner.writeText(p, content);
  }

  async exists(path: string): Promise<boolean> {
    const p = this.rel(path);
    return p !== null && this.hidden.some((h) => within(p, h))
      ? false
      : this.inner.exists(p ?? path);
  }

  async isFile(path: string): Promise<boolean> {
    const p = this.rel(path);
    return p !== null && this.hidden.some((h) => within(p, h))
      ? false
      : this.inner.isFile(p ?? path);
  }

  async glob(pattern: string, under?: string): Promise<string[]> {
    if (under) this.visible(under);
    const all = await this.inner.glob(pattern, under);
    return all.filter((f) => !this.hidden.some((h) => within(norm(f), h)));
  }

  exec(command: string, options: ExecOptions): Promise<ExecResult> {
    return this.inner.exec(`cd ${quote(this.own)} && ${command}`, options);
  }

  execFile(file: string, args: string[], options: ExecOptions): Promise<ExecResult> {
    return this.inner.execFile(file, args, options);
  }

  openTerminal(options: TerminalOptions): Promise<Terminal> {
    return this.inner.openTerminal(options);
  }
}

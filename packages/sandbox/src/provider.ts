import type { Workspace } from "@redgiant/tools";

export interface SandboxLimits {
  /** CPUs (fractions allowed). */
  cpus?: number;
  memoryMb?: number;
  pids?: number;
}

export interface SandboxSpec {
  /** Stable id, e.g. the project id; also names the container. */
  id: string;
  /** The workspace directory as seen by this (core) process. */
  localPath: string;
  /** How the container mounts the same directory. */
  mount: { type: "bind"; source: string } | { type: "volume"; name: string; subpath?: string };
  readOnly?: boolean;
  limits?: SandboxLimits;
  /** Extra environment; never put secrets here (they belong to egress routes). */
  env?: Record<string, string>;
  /** Another image than the provider's (a subproject with its own tools, G24.14c). */
  image?: string;
}

export interface Sandbox {
  readonly id: string;
  /** A workspace rooted at `subdir` (e.g. an agent's worktree). */
  workspace(subdir?: string): Workspace;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  readonly kind: "docker" | "host";
  create(spec: SandboxSpec): Promise<Sandbox>;
}

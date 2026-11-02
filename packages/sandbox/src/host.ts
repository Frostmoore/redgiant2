import { join } from "node:path";
import { LocalWorkspace } from "@redgiant/tools";
import type { Sandbox, SandboxProvider, SandboxSpec } from "./provider.js";

/**
 * "Metal" mode: commands run directly on the machine RedGiant runs on, with no isolation.
 * Only for users who enable it knowingly; paths are still confined to the workspace.
 */
export class HostSandboxProvider implements SandboxProvider {
  readonly kind = "host" as const;

  async create(spec: SandboxSpec): Promise<Sandbox> {
    return {
      id: spec.id,
      host: "127.0.0.1",
      workspace: (subdir = ".") =>
        new LocalWorkspace(join(spec.localPath, subdir), spec.readOnly ?? false),
      destroy: async () => {},
    };
  }
}

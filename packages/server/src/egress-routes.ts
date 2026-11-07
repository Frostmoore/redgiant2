// The egress proxy's routes file (G24.5, G33.4): GitHub's and Gitea's routes and the keychain's
// credentials bound to tools ("$vault") live in one file the proxy reads again when it changes.
// Each part is set on its own; the file is always written whole, then renamed, one write at a time.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type CredentialRoute, EgressProxy, type VaultProxyRoute } from "@redgiant/sandbox";
import type { VaultEgress } from "./vault.js";

const files = new Map<string, RoutesFile>();

export class RoutesFile {
  /** One writer per file, shared by GitHosts and the keychain. */
  static for(path: string): RoutesFile {
    let f = files.get(path);
    if (!f) {
      f = new RoutesFile(path);
      files.set(path, f);
    }
    return f;
  }

  private git: Record<string, CredentialRoute> = {};
  private vault: VaultProxyRoute[] = [];
  private writing: Promise<void> = Promise.resolve();

  private constructor(readonly path: string) {}

  setGit(routes: Record<string, CredentialRoute>): Promise<void> {
    this.git = routes;
    return this.write();
  }

  setVault(routes: VaultProxyRoute[]): Promise<void> {
    this.vault = routes;
    return this.write();
  }

  private write(): Promise<void> {
    const body = JSON.stringify({ ...this.git, ...(this.vault.length && { $vault: this.vault }) });
    const job = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, this.path);
    });
    this.writing = job.catch(() => {});
    return job;
  }
}

/** The keychain's credentials for sandboxes behind the Docker egress proxy (its routes file). */
export function routesFileEgress(path: string, url: string): VaultEgress {
  return { url, publish: (routes) => RoutesFile.for(path).setVault(routes) };
}

/**
 * Without Docker (commands run on this computer, RedGiant 3 on Windows and the Mac): a proxy of
 * the server's own on 127.0.0.1, only for the keychain's credentials bound to tools.
 */
export async function localVaultEgress(): Promise<{
  egress: VaultEgress;
  close: () => Promise<void>;
}> {
  const proxy = new EgressProxy({ allow: [] });
  const port = await proxy.listen(0, "127.0.0.1");
  return {
    egress: { url: `http://127.0.0.1:${port}`, publish: async (r) => proxy.setVault(r) },
    close: () => proxy.close(),
  };
}

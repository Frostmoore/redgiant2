import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tool, ToolContext } from "@redgiant/agent";
import { LocalWorkspace, truncateMiddle, type Workspace } from "@redgiant/tools";
import { z } from "zod";
import { NAME_RE } from "./skills.js";

/**
 * A tool written by an agent (or by hand): `tool.json` plus its files. The command runs in
 * the caller's sandbox with the path of a JSON file holding the arguments as its last
 * argument; what it prints is the result, a non-zero exit is an error.
 */
export const CustomToolSpec = z.object({
  name: z.string().regex(NAME_RE),
  description: z.string().min(10),
  inputSchema: z.record(z.string(), z.unknown()),
  command: z.string().min(1),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
});
export type CustomToolSpec = z.infer<typeof CustomToolSpec>;

export const ToolTest = z.object({
  input: z.record(z.string(), z.unknown()),
  expectExitCode: z.number().int().default(0),
  expectStdoutContains: z.string().optional(),
});
export type ToolTest = z.infer<typeof ToolTest>;

/** Names a custom tool may not take (base tools and RedGiant's own). */
export const RESERVED = new Set([
  "bash",
  "edit_file",
  "fetch",
  "glob",
  "grep",
  "find_files",
  "read_file",
  "web_search",
  "write_file",
  "list_agents",
  "create_project",
  "create_agent",
  "delegate",
  "read_agent",
  "merge_work",
  "stop_agent",
  "run_subagent",
  "complete_task",
  "board_list",
  "board_read",
  "board_search",
  "board_post",
  "board_status",
  "skill_load",
  "skill_file",
  "propose_extension",
  "propose_magic_extension",
  "propose_automation",
]);

export interface InstalledTool {
  spec: CustomToolSpec;
  dir: string;
  scope: "platform" | "project";
}

export async function loadCustomTools(
  roots: { dir: string; scope: InstalledTool["scope"] }[],
): Promise<InstalledTool[]> {
  const byName = new Map<string, InstalledTool>();
  for (const root of roots) {
    const base = join(root.dir, "tools");
    for (const name of await readdir(base).catch(() => [] as string[])) {
      try {
        const spec = CustomToolSpec.parse(
          JSON.parse(await readFile(join(base, name, "tool.json"), "utf8")),
        );
        if (spec.name === name && !RESERVED.has(name))
          byName.set(name, { spec, dir: join(base, name), scope: root.scope });
      } catch {
        // an unreadable tool is skipped, never half-loaded
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.spec.name.localeCompare(b.spec.name));
}

/** Copies the tool's files into the workspace (`.redgiant/tools/<name>`) and runs it there. */
export async function runCustomTool(
  t: { spec: CustomToolSpec; files: Record<string, string> },
  ws: Workspace,
  input: unknown,
  signal?: AbortSignal,
  env?: Record<string, string>,
) {
  // The name matches NAME_RE (letters, digits, dashes): safe unquoted in every shell (cmd.exe has no '…').
  const base = `.redgiant/tools/${t.spec.name}`;
  for (const [path, content] of Object.entries(t.files))
    await ws.writeText(`${base}/${path}`, content);
  const inputFile = `.input-${randomUUID().slice(0, 8)}.json`;
  await ws.writeText(`${base}/${inputFile}`, JSON.stringify(input ?? {}));
  return ws.exec(`cd ${base} && ${t.spec.command} ${inputFile}`, {
    timeoutMs: t.spec.timeoutMs ?? 120_000,
    signal,
    ...(env && Object.keys(env).length > 0 && { env }),
  });
}

/** Every file of an installed tool, as path → text. */
export async function toolFiles(dir: string): Promise<Record<string, string>> {
  const ws = new LocalWorkspace(dir, true);
  const out: Record<string, string> = {};
  for (const f of await ws.glob("**/*")) out[f] = await ws.readText(f);
  return out;
}

export function customTools(
  installed: InstalledTool[],
  ws: Workspace | undefined,
  /** The keychain's addresses for this run (G33.4): credentials the person bound to the tool. */
  envFor?: (tool: string, ctx: ToolContext) => Promise<Record<string, string>>,
): Tool[] {
  if (!ws) return [];
  return installed.map(
    (t): Tool => ({
      def: { name: t.spec.name, description: t.spec.description, inputSchema: t.spec.inputSchema },
      async run(input, ctx) {
        const r = await runCustomTool(
          { spec: t.spec, files: await toolFiles(t.dir) },
          ws,
          input,
          ctx.signal,
          envFor ? await envFor(t.spec.name, ctx) : undefined,
        );
        const out = truncateMiddle(r.stdout || r.stderr, 30_000);
        return r.exitCode === 0 && !r.timedOut
          ? out
          : {
              content: `Exit ${r.timedOut ? "timeout" : r.exitCode}\n${truncateMiddle(`${r.stdout}\n${r.stderr}`, 30_000)}`,
              isError: true,
            };
      },
    }),
  );
}

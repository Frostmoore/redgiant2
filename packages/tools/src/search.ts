import type { Tool } from "@redgiant/agent";
import { z } from "zod";
import { describe, type ModelProfile } from "./profiles.js";
import { looksBinary } from "./text.js";
import type { Workspace } from "./workspace.js";

const GlobInput = z.object({ pattern: z.string().min(1), path: z.string().optional() });

export function globTool(ws: Workspace, profile: ModelProfile): Tool<z.infer<typeof GlobInput>> {
  return {
    def: {
      name: "glob",
      description: describe(profile, {
        full: 'Find files by glob pattern (e.g. "src/**/*.ts"), relative to the workspace or to path. Skips .git, node_modules and build output.',
        compact: 'Find files by pattern, e.g. "**/*.py".',
      }),
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
      },
    },
    schema: GlobInput,
    async run({ pattern, path }) {
      const files = await ws.glob(pattern, path);
      if (files.length === 0) return "No files found.";
      const shown = files.slice(0, 500);
      return (
        shown.join("\n") +
        (files.length > shown.length ? `\n[${files.length - shown.length} more]` : "")
      );
    },
  };
}

const GrepInput = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  ignore_case: z.boolean().optional(),
  max_results: z.number().int().min(1).max(2000).optional(),
});

export function grepTool(ws: Workspace, profile: ModelProfile): Tool<z.infer<typeof GrepInput>> {
  return {
    def: {
      name: "grep",
      description: describe(profile, {
        full:
          "Search file contents with a JavaScript regular expression. Returns path:line: text. " +
          "Narrow with path and glob (default **/*).",
        compact: "Search text in files (regex). Returns file:line: text.",
      }),
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
          ignore_case: { type: "boolean" },
          max_results: { type: "integer" },
        },
        required: ["pattern"],
      },
    },
    schema: GrepInput,
    async run({ pattern, path, glob = "**/*", ignore_case, max_results = 200 }) {
      let re: RegExp;
      try {
        re = new RegExp(pattern, ignore_case ? "i" : "");
      } catch (err) {
        return { content: `Invalid regular expression: ${(err as Error).message}`, isError: true };
      }
      const hits: string[] = [];
      let more = 0;
      for (const file of await ws.glob(glob, path)) {
        let text: string;
        try {
          text = await ws.readText(file);
        } catch {
          continue;
        }
        if (looksBinary(text) || text.length > 5_000_000) continue;
        for (const [i, line] of text.split(/\r?\n/).entries()) {
          if (!re.test(line)) continue;
          if (hits.length < max_results)
            hits.push(`${file}:${i + 1}: ${line.length > 500 ? `${line.slice(0, 500)}…` : line}`);
          else more++;
        }
      }
      if (hits.length === 0) return "No matches.";
      return hits.join("\n") + (more > 0 ? `\n[${more} more matches]` : "");
    },
  };
}

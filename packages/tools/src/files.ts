import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Tool } from "@redgiant/agent";
import { z } from "zod";
import { applyEdit } from "./edit.js";
import { describe, type ModelProfile } from "./profiles.js";
import { looksBinary } from "./text.js";
import type { Workspace } from "./workspace.js";

/**
 * The files a write or edit touches (2026-11-04, RedGiant 2.0): inside the workspace through it
 * (its checks on links and read-only folders), outside it directly on the computer. Outside is
 * reached only when the guardian let the call through (it asks the person first, unless they
 * chose "let it be"); the permission is checked before the tool runs.
 */
function reach(ws: Workspace) {
  const out = (path: string): string | undefined => {
    const abs = isAbsolute(path) ? path : resolve(ws.root, path);
    const rel = relative(ws.root, abs);
    return rel.startsWith("..") || isAbsolute(rel) ? abs : undefined;
  };
  return {
    exists: async (p: string) => {
      const o = out(p);
      return o
        ? stat(o).then(
            () => true,
            () => false,
          )
        : ws.exists(p);
    },
    isFile: async (p: string) => {
      const o = out(p);
      return o
        ? stat(o).then(
            (x) => x.isFile(),
            () => false,
          )
        : ws.isFile(p);
    },
    readText: async (p: string) => {
      const o = out(p);
      return o ? readFile(o, "utf8") : ws.readText(p);
    },
    writeText: async (p: string, text: string) => {
      const o = out(p);
      if (!o) return ws.writeText(p, text);
      await mkdir(dirname(o), { recursive: true });
      await writeFile(o, text);
    },
  };
}

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;

const ReadInput = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional(),
});

export function readFileTool(
  ws: Workspace,
  profile: ModelProfile,
): Tool<z.infer<typeof ReadInput>> {
  return {
    def: {
      name: "read_file",
      description: describe(profile, {
        full:
          "Read a text file from the workspace. Lines are numbered (line number, tab, text). " +
          `Returns at most ${MAX_LINES} lines; use offset (1-based) and limit for longer files.`,
        compact: "Read a file (plain text). Optional offset/limit in lines.",
      }),
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the workspace root" },
          offset: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1 },
        },
        required: ["path"],
      },
    },
    schema: ReadInput,
    async run({ path, offset = 1, limit = MAX_LINES }) {
      if (!(await ws.isFile(path))) return { content: `No such file: ${path}`, isError: true };
      const text = await ws.readText(path);
      if (looksBinary(text)) return { content: `${path} looks like a binary file.`, isError: true };
      const lines = text.split(/\r?\n/);
      const slice = lines.slice(offset - 1, offset - 1 + Math.min(limit, MAX_LINES));
      if (slice.length === 0)
        return `${path} has ${lines.length} lines; offset ${offset} is past the end.`;
      const rest = lines.length - (offset - 1 + slice.length);
      // Small models copy line numbers into the files they write: give them the plain text.
      if (profile === "compact") {
        const plain = slice.join("\n");
        return rest > 0
          ? `${plain}\n[${rest} more lines; continue with offset ${offset + slice.length}]`
          : plain;
      }
      const body = slice
        .map((l, i) => {
          const shown =
            l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)} [line truncated]` : l;
          return `${String(offset + i).padStart(6)}\t${shown}`;
        })
        .join("\n");
      return rest > 0
        ? `${body}\n[${rest} more lines; continue with offset ${offset + slice.length}]`
        : body;
    },
  };
}

const WriteInput = z.object({ path: z.string().min(1), content: z.string() });

export function writeFileTool(
  ws: Workspace,
  profile: ModelProfile,
): Tool<z.infer<typeof WriteInput>> {
  return {
    def: {
      name: "write_file",
      description: describe(profile, {
        full:
          "Create or overwrite a file with the given content. Parent directories are created. " +
          "Prefer edit_file for small changes to existing files.",
        compact:
          "Write the complete content of a file (creates or overwrites). Use it also for big changes.",
      }),
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    schema: WriteInput,
    async run({ path, content }) {
      const f = reach(ws);
      const existed = await f.exists(path);
      await f.writeText(path, content);
      const lines = content === "" ? 0 : content.split("\n").length;
      return `${existed ? "Overwrote" : "Created"} ${path} (${lines} lines).`;
    },
  };
}

const EditInput = z.object({
  path: z.string().min(1),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

export function editFileTool(
  ws: Workspace,
  profile: ModelProfile,
): Tool<z.infer<typeof EditInput>> {
  return {
    def: {
      name: "edit_file",
      description: describe(profile, {
        full:
          "Replace old_string with new_string in a file. old_string must match the file " +
          "(differences in trailing whitespace and overall indentation are tolerated) and be " +
          "unique unless replace_all is true. An empty old_string creates a new file.",
        compact:
          "Replace old_string with new_string in a file. For big changes use write_file instead.",
      }),
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    schema: EditInput,
    async run({ path, old_string, new_string, replace_all }) {
      const f = reach(ws);
      if (old_string === "") {
        if (await f.exists(path)) {
          return {
            content: `${path} already exists; give old_string, or use write_file.`,
            isError: true,
          };
        }
        await f.writeText(path, new_string);
        return `Created ${path}.`;
      }
      if (!(await f.isFile(path))) return { content: `No such file: ${path}`, isError: true };
      const r = applyEdit(await f.readText(path), old_string, new_string, replace_all ?? false);
      if (!r.ok) return { content: r.error, isError: true };
      await f.writeText(path, r.content);
      const how =
        r.strategy === "exact"
          ? ""
          : ` (matched ignoring ${r.strategy === "indentation" ? "indentation" : "trailing whitespace"})`;
      return `Edited ${path}: ${r.replacements} replacement${r.replacements === 1 ? "" : "s"}${how}.`;
    },
  };
}

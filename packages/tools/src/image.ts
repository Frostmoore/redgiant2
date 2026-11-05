import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Tool, ToolOutput } from "@redgiant/agent";
import { z } from "zod";
import { describe, type ModelProfile } from "./profiles.js";
import { PathOutsideWorkspaceError, type Workspace } from "./workspace.js";

/** A picture for the model (the protocol's ImagePart). */
type ImagePart = NonNullable<Exclude<ToolOutput, string>["images"]>[number];

/** Pictures larger than this are refused (providers take about 5 MB per image). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The kind of picture, from its first bytes (the name's extension may lie). */
export function imageType(bytes: Uint8Array): ImagePart["mediaType"] | undefined {
  const at = (i: number, ...b: number[]) => b.every((x, j) => bytes[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return undefined;
}

const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const ViewInput = z.object({ path: z.string().min(1) });

/**
 * Shows the model a picture from the workspace (PNG, JPEG, GIF, WebP). Every agent has it (the
 * tool set never changes with the model); only models that see get anything out of it.
 */
export function viewImageTool(
  ws: Workspace,
  profile: ModelProfile,
): Tool<z.infer<typeof ViewInput>> {
  return {
    def: {
      name: "view_image",
      description: describe(profile, {
        full:
          "Look at an image file from the workspace (PNG, JPEG, GIF or WebP, up to 5 MB): it is shown to you as a picture. " +
          "Only useful if you can see images; otherwise describe the file with other tools.",
        compact: "Look at an image file (PNG, JPEG, GIF, WebP). Only for models that see images.",
      }),
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the workspace root" },
        },
        required: ["path"],
      },
    },
    schema: ViewInput,
    async run({ path }) {
      // The workspace's own checks first (outside the root, links, hidden subprojects).
      if (!(await ws.isFile(path))) return { content: `No such file: ${path}`, isError: true };
      const abs = resolve(ws.root, path);
      const real = await realpath(abs);
      if (!inside(ws.root, abs) || !inside(await realpath(ws.root), real))
        throw new PathOutsideWorkspaceError(path);
      const size = (await stat(real)).size;
      if (size > MAX_IMAGE_BYTES)
        return {
          content: `${path} is ${(size / 1024 / 1024).toFixed(1)} MB: images up to 5 MB can be viewed.`,
          isError: true,
        };
      const bytes = await readFile(real);
      const mediaType = imageType(bytes);
      if (!mediaType)
        return {
          content: `${path} is not a PNG, JPEG, GIF or WebP image.`,
          isError: true,
        };
      const name = path.split(/[\\/]/).pop() ?? path;
      return {
        content: `Image ${path} (${mediaType}, ${Math.ceil(size / 1024)} KB).`,
        images: [{ type: "image", mediaType, data: bytes.toString("base64"), name }],
      };
    },
  };
}

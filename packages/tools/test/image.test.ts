import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@redgiant/agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LocalWorkspace,
  MAX_IMAGE_BYTES,
  SubprojectWorkspace,
  viewImageTool,
} from "../src/index.js";

const ctx: ToolContext = { ownerId: "local", projectId: "p", agentId: "a", sessionId: "s" };
// The smallest PNG: 1x1, transparent.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rg-image-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const view = (path: string, ws = new LocalWorkspace(dir)) =>
  viewImageTool(ws, "full").run({ path }, ctx) as Promise<{
    content: string;
    isError?: boolean;
    images?: { type: string; mediaType: string; data: string; name?: string }[];
  }>;

describe("view_image", () => {
  it("shows a picture of the workspace to the model", async () => {
    await writeFile(join(dir, "shot.png"), PNG);
    // The kind comes from the bytes, not the name.
    await writeFile(join(dir, "photo.dat"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    const out = await view("shot.png");
    expect(out.isError).toBeUndefined();
    expect(out.content).toMatch(/^Image shot\.png \(image\/png/);
    expect(out.images).toEqual([
      { type: "image", mediaType: "image/png", data: PNG.toString("base64"), name: "shot.png" },
    ]);
    expect((await view("photo.dat")).images?.[0]?.mediaType).toBe("image/jpeg");
  });

  it("refuses what is not an image, too big, missing or outside", async () => {
    await writeFile(join(dir, "notes.png"), "just text");
    const text = await view("notes.png");
    expect(text.isError).toBe(true);
    expect(text.content).toMatch(/not a PNG, JPEG, GIF or WebP/);
    expect(text.images).toBeUndefined();

    await writeFile(join(dir, "huge.png"), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
    const huge = await view("huge.png");
    expect(huge.isError).toBe(true);
    expect(huge.content).toMatch(/up to 5 MB/);

    expect((await view("missing.png")).isError).toBe(true);
    await expect(view("../outside.png")).rejects.toThrow(/outside the workspace/);

    const other = await mkdtemp(join(tmpdir(), "rg-image-out-"));
    try {
      await writeFile(join(other, "secret.png"), PNG);
      await symlink(join(other, "secret.png"), join(dir, "link.png"));
      await expect(view("link.png")).rejects.toThrow(/outside the workspace/);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("does not show another subproject's pictures", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "apps/shop"), { recursive: true });
    await mkdir(join(dir, "apps/blog"), { recursive: true });
    await writeFile(join(dir, "apps/blog/logo.png"), PNG);
    const sub = new SubprojectWorkspace(new LocalWorkspace(dir), "apps/shop", ["apps/blog"]);
    const out = await view("apps/blog/logo.png", sub);
    expect(out.isError).toBe(true);
    expect(out.images).toBeUndefined();
  });

  it("says it helps only models that see", () => {
    const def = viewImageTool(new LocalWorkspace(dir), "full").def;
    expect(def.name).toBe("view_image");
    expect(def.description).toMatch(/Only useful if you can see images/);
  });
});

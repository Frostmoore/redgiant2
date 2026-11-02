import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalWorkspace, SubprojectWorkspace } from "../src/index.js";

async function project() {
  const root = await mkdtemp(join(tmpdir(), "rg-sub-"));
  await mkdir(join(root, "apps/shop"), { recursive: true });
  await mkdir(join(root, "apps/blog"), { recursive: true });
  await mkdir(join(root, "shared"), { recursive: true });
  await writeFile(join(root, "shared/theme.css"), "body{}");
  await writeFile(join(root, "apps/blog/post.md"), "secret");
  await writeFile(join(root, "apps/shop/cart.ts"), "cart");
  return new SubprojectWorkspace(new LocalWorkspace(root), "apps/shop", ["apps/shop", "apps/blog"]);
}

describe("a subproject's view of its project (G24.13)", () => {
  it("writes only in its folder, reads the shared parts, does not see its siblings", async () => {
    const ws = await project();
    await ws.writeText("apps/shop/new.ts", "x");
    expect(await ws.readText("./apps/shop/new.ts")).toBe("x");
    expect(await ws.readText("shared/theme.css")).toBe("body{}");
    await expect(ws.writeText("shared/theme.css", "")).rejects.toThrow(/orchestrator/);
    await expect(ws.writeText("apps/shop/../blog/x", "")).rejects.toThrow(/another subproject/);
    await expect(ws.readText("apps/blog/post.md")).rejects.toThrow(/another subproject/);
    expect(await ws.exists("apps/blog/post.md")).toBe(false);
    // Absolute paths too.
    await expect(ws.readText(join(ws.root, "apps/blog/post.md"))).rejects.toThrow(/another/);
    await expect(ws.writeText(join(ws.root, "shared/x"), "")).rejects.toThrow(/outside/);
    expect(await ws.readText(join(ws.root, "apps/shop/cart.ts"))).toBe("cart");
    expect(await ws.glob("**/*")).not.toContain("apps/blog/post.md");
    expect(await ws.glob("**/*")).toContain("shared/theme.css");
  });

  it("runs commands in its folder", async () => {
    const ws = await project();
    if (process.platform === "win32") return;
    const r = await ws.exec("ls", { timeoutMs: 5000 });
    expect(r.stdout.trim().split("\n")).toContain("cart.ts");
  });

  it("can be read-only (a subproject's inspector)", async () => {
    const root = (await project()).root;
    const ro = new SubprojectWorkspace(new LocalWorkspace(root), "apps/shop", ["apps/blog"], true);
    await expect(ro.writeText("apps/shop/a", "")).rejects.toThrow(/read-only/);
  });
});

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, TOKEN } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const md = "---\nname: tone\ndescription: 'Use when: writing to customers'\n---\n\nFriendly.\n";

describe("sharing skills over the API", () => {
  it("downloads a skill as a .zip and imports it into a project", async () => {
    s = await startServer(() => ({ text: "ok" }));
    const platform = s.core.platformPath("me");
    await mkdir(join(platform, "skills", "tone"), { recursive: true });
    await writeFile(join(platform, "skills", "tone", "SKILL.md"), md);
    await writeFile(join(platform, "skills", "tone", "examples.md"), "Hi!\n");
    const auth = { authorization: `Bearer ${TOKEN}` };

    const r = await fetch(`${s.url}/api/extensions/skills/tone/export?scope=platform`, {
      headers: auth,
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="tone.zip"');
    const zip = new Uint8Array(await r.arrayBuffer());
    expect(Buffer.from(zip.subarray(0, 2)).toString()).toBe("PK");
    expect(
      (await fetch(`${s.url}/api/extensions/skills/nope/export?scope=platform`, { headers: auth }))
        .status,
    ).toBe(404);

    const project = await s.api<{ id: string; path: string }>("POST", "/api/projects", {
      name: "X",
    });
    const post = (body: Uint8Array, query: string) =>
      fetch(`${s?.url}/api/extensions/skills/import?${query}`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/zip" },
        body,
      });
    const imported = await post(zip, `scope=project:${project.body.id}`);
    expect(imported.status).toBe(201);
    expect(await imported.json()).toEqual({
      name: "tone",
      description: "Use when: writing to customers",
      replaced: false,
    });
    expect(
      await readFile(join(project.body.path, ".redgiant", "skills", "tone", "SKILL.md"), "utf8"),
    ).toBe(md);
    const installed = await s.api<{ name: string; scope: string }[]>(
      "GET",
      "/api/extensions/installed",
    );
    expect(installed.body.filter((x) => x.name === "tone").map((x) => x.scope)).toEqual([
      "platform",
      `project:${project.body.id}`,
    ]);

    expect((await post(zip, `scope=project:${project.body.id}`)).status).toBe(409);
    expect((await post(zip, `scope=project:${project.body.id}&replace=1`)).status).toBe(201);
    // The same archive with a file renamed to climb out (same length: the zip stays valid).
    const evil = Buffer.from(
      Buffer.from(zip).toString("latin1").replaceAll("tone/examples.md", "../../examples.m"),
      "latin1",
    );
    const bad = await post(evil, "scope=platform");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/leaves/);
    expect((await post(zip, "scope=project:missing")).status).toBe(404);
  });
});

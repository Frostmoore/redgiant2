// The person's artifacts (3.5.9): the collection across places, the `.rgartifact` round trip
// (byte-identical HTML, nothing granted, «not run yet» until «Run»), and the imports refused.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withArtifactHeader } from "@redgiant/protocol";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { ARTIFACT_GUIDANCE } from "../src/artifact-guidance.js";
import { artifactFileName, MAX_ARTIFACT_ZIP, readArtifactZip } from "../src/artifacts.js";
import { OTHER, startServer, TOKEN } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const HTML = withArtifactHeader(
  '<!doctype html><html><body><h1>Preventivi</h1><script>document.title="x"</script></body></html>\n',
  { name: "Calcolo preventivi", version: 3, libs: ["chartjs"], wants: [], from: "agent_shop" },
);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const manifestFor = (html: Uint8Array, extra: Record<string, unknown> = {}) =>
  strToU8(
    JSON.stringify({
      format: "rgartifact-1",
      header: { name: "Calcolo preventivi", version: 3, libs: ["chartjs"], wants: [] },
      sha256: sha(html),
      redgiant: "3.5.9",
      hasData: false,
      ...extra,
    }),
  );

async function raw(srv: Server, method: string, path: string, body?: Uint8Array) {
  const r = await fetch(`${srv.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream" },
    ...(body && { body }),
  });
  return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()), headers: r.headers };
}

async function withShop() {
  const srv = await startServer([]);
  await srv.api("POST", "/api/projects", { name: "Shop" });
  await srv.api("POST", "/api/projects", { name: "Other" });
  const put = (scope: string, path: string, content: string) =>
    srv.api("PUT", "/api/files/content", { scope, path, content });
  await put("project:shop", "artefatti/preventivi.html", HTML);
  await put("project:shop", "artefatti/vecchio.html", "<p>no header</p>");
  await put("project:shop", "artefatti/note.txt", "not an artifact");
  await put("project:shop", "src/index.html", "<p>a site, not an artifact</p>");
  await put(
    "platform",
    "artefatti/torneo.html",
    withArtifactHeader("<p>torneo</p>", { name: "Torneo", version: 1, libs: [], wants: [] }),
  );
  return srv;
}

interface Info {
  scope: string;
  path: string;
  name: string;
  header: boolean;
  version: number | null;
  libs: string[];
  from: string | null;
  granted: string[];
  size: number;
  readOnly: boolean;
  pendingRun: boolean;
  place: string;
}

describe("the collection (3.5.9)", () => {
  it("lists every artefatti/*.html in every place, with the header's facts or the file's name", async () => {
    s = await withShop();
    const list = (await s.api<Info[]>("GET", "/api/artifacts")).body;
    expect(list.map((a) => `${a.scope} ${a.path}`).sort()).toEqual([
      "platform artefatti/torneo.html",
      "project:shop artefatti/preventivi.html",
      "project:shop artefatti/vecchio.html",
    ]);
    const quote = list.find((a) => a.path === "artefatti/preventivi.html");
    expect(quote).toMatchObject({
      name: "Calcolo preventivi",
      header: true,
      version: 3,
      libs: ["chartjs"],
      from: "agent_shop",
      granted: [],
      place: "Shop",
      readOnly: false,
      pendingRun: false,
      size: Buffer.byteLength(HTML),
    });
    expect(list.find((a) => a.path === "artefatti/vecchio.html")).toMatchObject({
      name: "vecchio",
      header: false,
      version: null,
    });
  });

  it("marks an archived project's artifacts read only and refuses imports into it", async () => {
    s = await withShop();
    expect((await s.api("POST", "/api/projects/shop/archive")).status).toBe(200);
    const list = (await s.api<Info[]>("GET", "/api/artifacts")).body;
    expect(list.filter((a) => a.scope === "project:shop").every((a) => a.readOnly)).toBe(true);
    const zip = (
      await raw(s, "GET", "/api/artifacts/export?scope=platform&path=artefatti/torneo.html")
    ).bytes;
    expect((await raw(s, "POST", "/api/artifacts/import?scope=project:shop", zip)).status).toBe(
      423,
    );
    // Deleting goes through the explorer's path, which refuses too.
    expect(
      (
        await s.api("POST", "/api/files/op", {
          op: "delete",
          scope: "project:shop",
          path: "artefatti/preventivi.html",
        })
      ).status,
    ).toBe(423);
  });
});

describe("export and import (.rgartifact)", () => {
  it("round-trips byte for byte, grants nothing, and waits for «Run» before it runs", async () => {
    s = await withShop();
    const exp = await raw(
      s,
      "GET",
      "/api/artifacts/export?scope=project:shop&path=artefatti/preventivi.html",
    );
    expect(exp.status).toBe(200);
    expect(exp.headers.get("content-disposition")).toMatch(/preventivi\.rgartifact/);
    const inside = unzipSync(exp.bytes);
    expect(Object.keys(inside).sort()).toEqual(["artifact.html", "manifest.json"]);
    const manifest = JSON.parse(Buffer.from(inside["manifest.json"] as Uint8Array).toString());
    expect(manifest).toMatchObject({
      format: "rgartifact-1",
      header: { name: "Calcolo preventivi", version: 3, libs: ["chartjs"] },
      sha256: sha(strToU8(HTML)),
      hasData: false,
    });
    expect(typeof manifest.redgiant).toBe("string");

    const imp = await raw(s, "POST", "/api/artifacts/import?scope=project:other", exp.bytes);
    expect(imp.status).toBe(200);
    const done = JSON.parse(Buffer.from(imp.bytes).toString()) as { path: string; name: string };
    expect(done).toMatchObject({
      path: "artefatti/Calcolo preventivi.html",
      name: "Calcolo preventivi",
    });
    const other = (await s.core.projects.get("me", "other"))?.path ?? "";
    const back = await readFile(join(other, done.path));
    expect(Buffer.compare(back, Buffer.from(HTML))).toBe(0);

    // Imported: not run yet, nothing granted, in the list and in the state the Canvas reads.
    const listed = (await s.api<Info[]>("GET", "/api/artifacts")).body.find(
      (a) => a.scope === "project:other",
    );
    expect(listed).toMatchObject({ pendingRun: true, granted: [] });
    const state = (p: string) =>
      s?.api<{ pendingRun: boolean }>(
        "GET",
        `/api/artifacts/state?scope=project:other&path=${encodeURIComponent(p)}`,
      );
    expect((await state(done.path))?.body).toEqual({ pendingRun: true });
    const types = (await s.core.store.list({ projectId: "other" })).map((e) => e.type);
    expect(types).toContain("artifact.imported");

    // A second import of the same file keeps both: «name (2).html».
    const again = await raw(s, "POST", "/api/artifacts/import?scope=project:other", exp.bytes);
    expect(JSON.parse(Buffer.from(again.bytes).toString()).path).toBe(
      "artefatti/Calcolo preventivi (2).html",
    );

    // «Run»: from now on it opens as an app.
    expect(
      (await s.api("POST", "/api/artifacts/run", { scope: "project:other", path: done.path }))
        .status,
    ).toBe(200);
    expect((await state(done.path))?.body).toEqual({ pendingRun: false });
    expect((await state("artefatti/Calcolo preventivi (2).html"))?.body).toEqual({
      pendingRun: true,
    });
  });

  it("writes a header into an exported file that had none, and gives the bare HTML too", async () => {
    s = await withShop();
    const exp = await raw(
      s,
      "GET",
      "/api/artifacts/export?scope=project:shop&path=artefatti/vecchio.html",
    );
    const html = Buffer.from(unzipSync(exp.bytes)["artifact.html"] as Uint8Array).toString();
    expect(html).toMatch(/^<!-- redgiant-artifact \{"name":"vecchio"/);
    const bare = await raw(
      s,
      "GET",
      "/api/artifacts/export?scope=project:shop&path=artefatti/vecchio.html&as=html",
    );
    expect(Buffer.from(bare.bytes).toString()).toBe("<p>no header</p>");
    // Only artifacts: nothing else leaves through this door.
    expect(
      (await raw(s, "GET", "/api/artifacts/export?scope=project:shop&path=src/index.html")).status,
    ).toBe(400);
    expect(
      (await raw(s, "GET", "/api/artifacts/export?scope=project:shop&path=artefatti/../../x.html"))
        .status,
    ).toBe(400);
  });

  it("refuses two HTMLs, a wrong sha256, a bad manifest, unsafe names and oversized files", async () => {
    s = await withShop();
    const html = strToU8(HTML);
    const refuse = async (zip: Uint8Array, why: RegExp) => {
      const r = await raw(s as Server, "POST", "/api/artifacts/import?scope=project:other", zip);
      expect(r.status).toBe(400);
      expect(Buffer.from(r.bytes).toString()).toMatch(why);
    };
    await refuse(
      zipSync({ "artifact.html": html, "other.html": html, "manifest.json": manifestFor(html) }),
      /exactly one HTML/,
    );
    await refuse(zipSync({ "manifest.json": manifestFor(html) }), /exactly one HTML/);
    await refuse(
      zipSync({ "artifact.html": html, "manifest.json": manifestFor(strToU8("other")) }),
      /sha256/,
    );
    await refuse(
      zipSync({ "artifact.html": html, "manifest.json": manifestFor(html, { format: "zip" }) }),
      /manifest\.json is not valid/,
    );
    await refuse(zipSync({ "artifact.html": html }), /no manifest/);
    await refuse(
      zipSync({
        "artifact.html": html,
        "manifest.json": manifestFor(html),
        "../../evil.sh": strToU8("rm -rf /"),
      }),
      /Unsafe name/,
    );
    await refuse(
      zipSync({ "artifact.html": html, "manifest.json": manifestFor(html), "run.js": html }),
      /Unexpected file/,
    );
    const noHeader = strToU8("<p>no header</p>");
    await refuse(
      zipSync({ "artifact.html": noHeader, "manifest.json": manifestFor(noHeader) }),
      /no valid header/,
    );
    await refuse(strToU8("not a zip at all"), /not a valid \.rgartifact/);
    const big = new Uint8Array(MAX_ARTIFACT_ZIP + 1);
    await refuse(big, /larger than 10 MB/);
    // Nothing of the refused ones was written.
    const list = (await s.api<Info[]>("GET", "/api/artifacts")).body;
    expect(list.filter((a) => a.scope === "project:other")).toEqual([]);
  });

  it("stops a zip bomb before inflating it, and a traversal name in any form", () => {
    const html = strToU8(HTML);
    const bomb = zipSync(
      {
        "artifact.html": html,
        "manifest.json": manifestFor(html),
        "data.json": new Uint8Array(25 * 1024 * 1024),
      },
      { level: 9 },
    );
    expect(bomb.byteLength).toBeLessThan(MAX_ARTIFACT_ZIP);
    expect(() => readArtifactZip(bomb)).toThrow(/unpacks to too much/);
    for (const name of ["/abs.html", "a/artifact.html", "..\\x", ".hidden", "c:x"])
      expect(() =>
        readArtifactZip(zipSync({ [name]: html, "manifest.json": manifestFor(html) })),
      ).toThrow(/Unsafe name/);
  });

  it("names the file from the artifact's name, never a path", () => {
    expect(artifactFileName("Calcolo preventivi")).toBe("Calcolo preventivi.html");
    expect(artifactFileName("../../etc/passwd")).toBe("etc-passwd.html");
    expect(artifactFileName("a/b\\c:d")).toBe("a-b-c-d.html");
    expect(artifactFileName("...")).toBe("artefatto.html");
    expect(artifactFileName("Città è bella!")).toBe("Città è bella.html");
  });
});

describe("files written straight to disk show up too", () => {
  it("lists an agent's file in the assistants' desk", async () => {
    s = await startServer([]);
    const desk = s.core.assistantsPath("me");
    await mkdir(join(desk, "artefatti"), { recursive: true });
    await writeFile(join(desk, "artefatti", "conto.html"), "<p>dividi il conto</p>");
    const list = (await s.api<Info[]>("GET", "/api/artifacts")).body;
    expect(list.map((a) => `${a.scope} ${a.name}`)).toEqual(["assistants conto"]);
    // Someone else sees none of the person's artifacts.
    const theirs = await s.api<Info[]>("GET", "/api/artifacts", undefined, OTHER);
    expect(theirs.body).toEqual([]);
  });
});

describe("the rule for the form of an answer (3.5.9)", () => {
  it("is in the base instructions of an agent that can show files, once", async () => {
    const systems: string[] = [];
    s = await startServer((req) => {
      systems.push(req.system ?? "");
      return { text: "Two lines." };
    });
    const g = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const sid = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: g.body.id })
    ).body.sessionId;
    await (await s.core.send("me", sid, "How long should the window stay open?")).done;
    const sys = systems[0] ?? "";
    expect(sys).toContain(ARTIFACT_GUIDANCE);
    expect(sys.split("## Choosing the form of an answer").length).toBe(2);
    expect(ARTIFACT_GUIDANCE).toMatch(/```widget/);
    expect(ARTIFACT_GUIDANCE).toMatch(/artefatti\/<name>\.html/);
    expect(ARTIFACT_GUIDANCE).toMatch(/text to tell, widget to try on the spot, artifact to use/);
  });
});

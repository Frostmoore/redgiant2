import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { Jobs } from "../src/jobs.js";
import { fstWords, tar, tarEntry, WakeModels, wakeFile, zipToTarGz } from "../src/wake-models.js";
import { startServer, TOKEN } from "./helpers.js";

const run = promisify(execFile);

/** A zip shaped like alphacephei's: one folder on top, the acoustic model inside. */
function fakeModel(top: string): Uint8Array {
  return zipSync({
    [`${top}/`]: new Uint8Array(),
    [`${top}/am/`]: new Uint8Array(),
    [`${top}/am/final.mdl`]: new Uint8Array(3000).fill(7),
    [`${top}/conf/model.conf`]: new TextEncoder().encode("--min-active=200\n"),
  });
}

/** The head of an OpenFst binary file with its symbol tables, as Vosk's small models have. */
function fakeFst(words: string[]): Uint8Array {
  const parts: Buffer[] = [];
  const i32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(n);
    parts.push(b);
  };
  const i64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(n));
    parts.push(b);
  };
  const str = (s: string) => {
    const b = Buffer.from(s, "utf8");
    i32(b.length);
    parts.push(b);
  };
  i32(2125659606);
  str("ngram");
  str("standard");
  i32(4);
  i32(3);
  i64(0);
  i64(1);
  i64(10);
  i64(0);
  const table = ["<eps>", "!SIL", "[unk]", ...words];
  i32(2125658996);
  str("words.txt");
  i64(table.length);
  i64(table.length);
  table.forEach((w, k) => {
    str(w);
    i64(k);
  });
  parts.push(Buffer.alloc(64, 9));
  return new Uint8Array(Buffer.concat(parts));
}

const dirs: string[] = [];
const temp = async () => {
  const d = await mkdtemp(join(tmpdir(), "rg-wake-"));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("wake-word models (G38.4)", () => {
  it("writes a tar the system's tar reads, long names included", async () => {
    const dir = await temp();
    const long = `${"a".repeat(60)}/${"b".repeat(60)}/c.txt`;
    await writeFile(
      join(dir, "x.tar"),
      tar([
        ["m/", null],
        ["m/one.txt", new TextEncoder().encode("hello")],
        [long, new Uint8Array(513).fill(65)],
      ]),
    );
    const { stdout } = await run("tar", ["-tvf", join(dir, "x.tar")]);
    expect(stdout).toContain("m/one.txt");
    expect(stdout).toContain(long);
    await run("tar", ["-xf", join(dir, "x.tar"), "-C", dir]);
    expect(await readFile(join(dir, "m/one.txt"), "utf8")).toBe("hello");
    expect((await readFile(join(dir, long))).length).toBe(513);
  });

  it("turns the published zip into the tar.gz the page unpacks", async () => {
    const out = zipToTarGz(fakeModel("vosk-model-small-it-0.22"));
    const raw = gunzipSync(out);
    expect(new TextDecoder().decode(raw.subarray(257, 262))).toBe("ustar");
    const dir = await temp();
    await writeFile(join(dir, "m.tar.gz"), out);
    const { stdout } = await run("tar", ["-tzf", join(dir, "m.tar.gz")]);
    expect(stdout.split(/\r?\n/).filter(Boolean)).toEqual([
      "vosk-model-small-it-0.22/",
      "vosk-model-small-it-0.22/am/",
      "vosk-model-small-it-0.22/am/final.mdl",
      "vosk-model-small-it-0.22/conf/model.conf",
    ]);
    expect(() => zipToTarGz(zipSync({ "x/readme": new Uint8Array(1) }))).toThrow(/not a Vosk/);
  });

  it("downloads once, as a job with its progress, then has nothing to do", async () => {
    const dir = await temp();
    const zip = fakeModel("vosk-model-small-en-us-0.15");
    const asked: string[] = [];
    const models = new WakeModels(dir, {
      baseUrl: "https://models.example/vosk/",
      fetch: (async (url: string) => {
        asked.push(String(url));
        return new Response(zip, { headers: { "content-length": String(zip.length) } });
      }) as typeof fetch,
    });
    const jobs = new Jobs();
    expect((await models.state("en")).ready).toBe(false);
    const job = models.ensure(jobs, "me", "en");
    expect(job?.kind).toBe("download_wake_model");
    // Asked again while it runs: the same job, not a second download.
    expect(models.ensure(jobs, "me", "en")?.id).toBe(job?.id);
    const end = await jobs.settled(job?.id ?? "");
    expect(end?.state).toBe("done");
    expect(end?.steps.map((s) => [s.id, s.state])).toEqual([
      ["model_download", "done"],
      ["model_prepare", "done"],
    ]);
    expect(asked).toEqual(["https://models.example/vosk/vosk-model-small-en-us-0.15.zip"]);
    expect(await models.state("en")).toMatchObject({ ready: true, file: wakeFile("en") });
    expect(models.ensure(jobs, "me", "en")).toBeUndefined();
  });

  it("serves the prepared file without the sign-in, and nothing else", async () => {
    const s = await startServer([]);
    try {
      expect((await s.api("GET", "/api/voice/wake-model?lang=it")).body).toMatchObject({
        ready: false,
        file: "vosk-model-small-it-0.22.tar.gz",
      });
      expect((await s.api("GET", "/api/voice/wake-model?lang=xx")).status).toBe(400);
      // Not downloaded yet: not found (no token needed to ask).
      expect((await fetch(`${s.url}/api/voice/wake-models/${wakeFile("it")}`)).status).toBe(404);
      await mkdir(join(s.dir, "tools", "vosk"), { recursive: true });
      await writeFile(join(s.dir, "tools", "vosk", wakeFile("it")), "model");
      const r = await fetch(`${s.url}/api/voice/wake-models/${wakeFile("it")}`);
      expect([r.status, await r.text(), r.headers.get("cache-control")]).toEqual([
        200,
        "model",
        "public, max-age=31536000, immutable",
      ]);
      // Other names, other routes: the sign-in still guards them.
      expect((await fetch(`${s.url}/api/voice/wake-models/..%2Fredgiant.yaml`)).status).toBe(404);
      expect((await fetch(`${s.url}/api/voice/wake-model?lang=it`)).status).toBe(401);
      const posted = await s.api("POST", "/api/voice/wake-model", { lang: "it" });
      expect(posted.body).toMatchObject({ ready: true });
      expect((posted.body as { job?: unknown }).job).toBeUndefined();
      expect(TOKEN).toBeTruthy();
    } finally {
      await s.close();
    }
  });

  it("knows the model's words, read from the grammar's FST (a wake word of one's own)", async () => {
    const top = "vosk-model-small-it-0.22";
    const fst = fakeFst(["ciao", "computer", "ehi", "giant", "red"]);
    expect(fstWords(fst)).toEqual([
      "<eps>",
      "!SIL",
      "[unk]",
      "ciao",
      "computer",
      "ehi",
      "giant",
      "red",
    ]);
    const archive = tar([
      [`${top}/`, null],
      [`${top}/am/final.mdl`, new Uint8Array(700).fill(1)],
      [`${top}/graph/Gr.fst`, fst],
    ]);
    expect(tarEntry(archive, "/graph/Gr.fst")).toEqual(fst);
    expect(tarEntry(archive, "/graph/words.txt")).toBeUndefined();
    const dir = await temp();
    const models = new WakeModels(dir);
    expect(await models.missing("it", ["ciao"])).toBeUndefined();
    await mkdir(join(dir, "tools", "vosk"), { recursive: true });
    await writeFile(models.path("it"), gzipSync(archive));
    expect(await models.missing("it", ["ciao", "computer", "zzxq"])).toEqual(["zzxq"]);
    // Read once, then kept beside the model.
    expect(await readFile(`${models.path("it")}.words`, "utf8")).toContain("computer");
    expect(await new WakeModels(dir).missing("it", ["red", "giant", "!sil"])).toEqual(["!sil"]);
    expect(() => fstWords(new Uint8Array(40))).toThrow();

    const s = await startServer([]);
    try {
      expect((await s.api("GET", "/api/voice/wake-words?lang=it&words=ciao")).body).toEqual({
        ready: false,
        missing: [],
      });
      await mkdir(join(s.dir, "tools", "vosk"), { recursive: true });
      await writeFile(join(s.dir, "tools", "vosk", wakeFile("it")), gzipSync(archive));
      const r = await s.api("GET", "/api/voice/wake-words?lang=it&words=Ciao,zzxq");
      expect(r.body).toEqual({ ready: true, missing: ["zzxq"] });
      expect((await s.api("GET", "/api/voice/wake-words?lang=xx&words=a")).status).toBe(400);
    } finally {
      await s.close();
    }
  });
});

import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { Jobs } from "../src/jobs.js";
import { backgroundPuller, layerSizes, splitImage } from "../src/runtime.js";

describe("downloads with a true bar (decision 2026-11-02)", () => {
  it("reads registry, repository and tag from an image reference", () => {
    expect(splitImage("postgres:17-alpine")).toEqual({
      registry: "registry-1.docker.io",
      repo: "library/postgres",
      tag: "17-alpine",
    });
    expect(splitImage("ghcr.io/frostmoore/redgiant2:latest")).toEqual({
      registry: "ghcr.io",
      repo: "frostmoore/redgiant2",
      tag: "latest",
    });
    expect(splitImage("searxng/searxng")).toEqual({
      registry: "registry-1.docker.io",
      repo: "searxng/searxng",
      tag: "latest",
    });
    expect(splitImage("localhost:5000/x/y:1")).toEqual({
      registry: "localhost:5000",
      repo: "x/y",
      tag: "1",
    });
  });

  it("gets the layers' sizes for this machine from the registry, and nothing on failure", async () => {
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const asked: string[] = [];
    const fetcher = (async (url: string) => {
      asked.push(url);
      const body = url.includes("/token")
        ? { token: "t" }
        : url.endsWith("/latest")
          ? {
              manifests: [
                { digest: "sha256:other", platform: { os: "linux", architecture: "s390x" } },
                { digest: "sha256:mine", platform: { os: "linux", architecture: arch } },
              ],
            }
          : { layers: [{ digest: `sha256:${"a".repeat(64)}`, size: 1000 }] };
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    const sizes = await layerSizes("ghcr.io/frostmoore/redgiant2:latest", fetcher);
    expect([...sizes]).toEqual([["a".repeat(12), 1000]]);
    expect(asked.at(-1)).toBe("https://ghcr.io/v2/frostmoore/redgiant2/manifests/sha256:mine");
    const none = await layerSizes("x:1", (async () => {
      throw new Error("offline");
    }) as typeof fetch);
    expect(none.size).toBe(0);
  });

  it("pulls a missing image as a job with its progress, once, and skips one already there", async () => {
    const jobs = new Jobs();
    let pulls = 0;
    const seen: (number | null)[] = [];
    const present = new Set(["have:1"]);
    const docker = {
      getImage: (name: string) => ({
        inspect: async () => {
          if (!present.has(name)) throw new Error("no such image");
          return {};
        },
      }),
      pull: async () => {
        pulls++;
        const s = new PassThrough();
        setTimeout(() => s.end(), 30);
        return s;
      },
      modem: {
        followProgress: (
          _s: unknown,
          done: (err: Error | null) => void,
          on: (ev: object) => void,
        ) => {
          // Before Docker says a single byte, the bar already knows the total.
          on({ id: "l1", status: "Pulling fs layer", progressDetail: {} });
          seen.push(jobs.list("me")[0]?.steps[0]?.progress?.total ?? null);
          on({ id: "l1", status: "Downloading", progressDetail: { current: 50, total: 500 } });
          seen.push(jobs.list("me")[0]?.steps[0]?.progress?.done ?? null);
          on({ id: "l1", status: "Download complete" });
          present.add("want:1");
          setTimeout(() => done(null), 10);
        },
      },
    } as unknown as Docker;
    // The registry says the true total before Docker does.
    const pull = backgroundPuller(
      docker,
      jobs,
      () => "me",
      async () => new Map([["l1", 500]]),
    );
    await Promise.all([pull("want:1", "sandbox"), pull("want:1", "sandbox")]);
    expect(pulls).toBe(1);
    const [job] = jobs.list("me");
    expect(job).toMatchObject({
      kind: "download_sandbox",
      state: "done",
      vars: { image: "want:1" },
    });
    expect(seen).toEqual([500, 50]);
    await pull("have:1", "browser");
    expect(pulls).toBe(1);
    expect(jobs.list("me")).toHaveLength(1);
  });
});

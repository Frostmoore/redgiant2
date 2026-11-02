import type { Job } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { JobFailure, Jobs } from "../src/index.js";
import { startServer } from "./helpers.js";

let cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

/** A promise to resolve from outside: the action waits on it. */
function gate() {
  let open = () => {};
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
}

describe("jobs", () => {
  it("reports steps, progress with rate and time left, and the result", async () => {
    let t = 1_000_000;
    const jobs = new Jobs(() => t);
    const g = gate();
    const job = jobs.start(
      "me",
      "engine",
      ["image", "start", "load"],
      async (h) => {
        h.skip("image");
        h.step("start");
        h.progress(0, 1000);
        t += 2000;
        h.progress(400, 1000);
        await g.p;
        h.step("load");
        return { ready: true };
      },
      { model: "gemma.gguf" },
    );
    expect(job.state).toBe("running");
    expect(job.vars).toEqual({ model: "gemma.gguf" });
    const mid = jobs.get("me", job.id);
    expect(mid?.steps.map((s) => s.state)).toEqual(["skipped", "running", "waiting"]);
    // 400 units in 2 s: 200/s, 600 left: 3 s.
    expect(mid?.steps[1]?.progress).toEqual({
      done: 400,
      total: 1000,
      rate: 200,
      secondsLeft: 3,
    });
    g.open();
    const end = await jobs.settled(job.id);
    expect(end?.state).toBe("done");
    expect(end?.steps.map((s) => s.state)).toEqual(["skipped", "done", "done"]);
    expect(end?.result).toEqual({ ready: true });
    expect(end?.steps.some((s) => s.progress)).toBe(false);
  });

  it("does not guess a rate from too little time", () => {
    let t = 0;
    const jobs = new Jobs(() => t);
    const job = jobs.start("me", "download", ["get"], async (h) => {
      h.step("get");
      h.progress(0, null);
      t += 500;
      h.progress(100, null);
      await new Promise(() => {});
    });
    expect(jobs.get("me", job.id)?.steps[0]?.progress).toEqual({
      done: 100,
      total: null,
      rate: null,
      secondsLeft: null,
    });
  });

  it("keeps the error's code and message, and marks the step that failed", async () => {
    const jobs = new Jobs();
    const job = jobs.start("me", "engine", ["start", "load"], async (h) => {
      h.step("start");
      h.step("load");
      throw new JobFailure("out_of_memory", "failed to allocate 9 GB");
    });
    const end = await jobs.settled(job.id);
    expect(end?.state).toBe("failed");
    expect(end?.error).toEqual({ code: "out_of_memory", message: "failed to allocate 9 GB" });
    expect(end?.steps.map((s) => s.state)).toEqual(["done", "failed"]);
  });

  it("cancels through the signal, only for its owner and only while running", async () => {
    const jobs = new Jobs();
    const job = jobs.start("me", "download", ["get"], async (h) => {
      h.step("get");
      await new Promise((_, reject) =>
        h.signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    });
    expect(jobs.cancel("someone-else", job.id)).toBe(false);
    expect(jobs.get("someone-else", job.id)).toBeUndefined();
    expect(jobs.list("someone-else")).toEqual([]);
    expect(jobs.cancel("me", job.id)).toBe(true);
    const end = await jobs.settled(job.id);
    expect(end?.state).toBe("cancelled");
    expect(end?.error).toBeUndefined();
    expect(jobs.cancel("me", job.id)).toBe(false);
  });

  it("forgets finished jobs after an hour, never running ones", async () => {
    let t = 0;
    const jobs = new Jobs(() => t);
    const done = jobs.start("me", "a", [], async () => {});
    await jobs.settled(done.id);
    const running = jobs.start("me", "b", [], () => new Promise(() => {}));
    t += 61 * 60_000;
    expect(jobs.list("me").map((j) => j.id)).toEqual([running.id]);
  });

  it("is followed and cancelled over HTTP", async () => {
    const s = await startServer(() => ({ text: "ok" }));
    cleanup.push(s.close);
    const job = s.core.jobs.start("me", "download", ["get"], async (h) => {
      h.step("get");
      await new Promise((_, reject) =>
        h.signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    });
    expect((await s.api<Job[]>("GET", "/api/jobs")).body.map((j) => j.id)).toEqual([job.id]);
    expect((await s.api<Job>("GET", `/api/jobs/${job.id}`)).body.state).toBe("running");
    expect((await s.api("GET", "/api/jobs/nope")).status).toBe(404);
    expect((await s.api("POST", `/api/jobs/${job.id}/cancel`)).status).toBe(200);
    await s.core.jobs.settled(job.id);
    expect((await s.api<Job>("GET", `/api/jobs/${job.id}`)).body.state).toBe("cancelled");
    expect((await s.api("POST", `/api/jobs/${job.id}/cancel`)).status).toBe(409);
  });
});

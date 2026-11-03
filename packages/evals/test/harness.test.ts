import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@redgiant/protocol";
import { FakeProvider, ProviderRegistry } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import {
  harnessMetrics,
  harnessReport,
  isProgramError,
  ordersCsv,
  runHarness,
  SCENARIOS,
} from "../src/index.js";

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs)
    await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  dirs = [];
});

const ev = (type: string, payload: unknown, sessionId = "s1"): Event =>
  ({
    seq: 0,
    id: "x",
    ts: new Date().toISOString(),
    ownerId: "eval",
    projectId: null,
    agentId: "a",
    sessionId,
    type,
    payload,
    payloadHash: "",
    prevHash: null,
    hash: "",
    erased: false,
  }) as Event;
const call = (input: number, cached: number) =>
  ev("message.assistant", {
    parts: [],
    stopReason: "end_turn",
    provider: "p",
    model: "m",
    costUsd: 0.01,
    metrics: {
      startedAt: new Date().toISOString(),
      inputTokens: input,
      cachedReadTokens: cached,
      cacheWriteTokens: 0,
      outputTokens: 10,
      contextUsed: input,
      contextWindow: 200000,
      source: "server",
    },
  });

describe("harness suite", () => {
  it("reads the harness out of a log: cache, orphan calls, program errors, parallel tasks", () => {
    const m = harnessMetrics([
      call(1000, 0),
      call(2000, 1800),
      ev("tool.call", { callId: "c1", tool: "bash", input: {} }),
      ev("tool.result", {
        callId: "c1",
        ok: false,
        output: "TypeError: engine.turn is not a function",
      }),
      ev("tool.call", { callId: "c2", tool: "read_file", input: {} }),
      ev("tool.call", { callId: "c3", tool: "edit_file", input: {} }),
      ev("tool.result", { callId: "c3", ok: false, output: "old_string not found in the file" }),
      ev("task.opened", { taskId: "t1", title: "a" }),
      ev("task.opened", { taskId: "t2", title: "b" }),
      ev("task.closed", { taskId: "t1", outcome: "verified" }),
      ev("task.closed", { taskId: "t2", outcome: "abandoned", reason: "x" }),
    ]);
    expect(m).toMatchObject({
      calls: 2,
      toolErrors: 2,
      orphanCalls: 1,
      tasksOpened: 2,
      tasksAbandoned: 1,
      tasksOpen: 0,
      maxParallelTasks: 2,
    });
    expect(m.cacheReuse).toBeCloseTo(0.9);
    expect(m.harnessErrors).toHaveLength(1);
    expect(isProgramError("old_string not found")).toBe(false);
  });

  it("makes the same orders every time, with answers computed here", () => {
    const a = ordersCsv(1000);
    const b = ordersCsv(1000);
    expect(a.csv).toBe(b.csv);
    expect(a.answer.top_customers).toHaveLength(3);
    const sum = Object.values(a.answer.revenue_by_region as Record<string, number>).reduce(
      (x, y) => x + y,
      0,
    );
    const lines = a.csv
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => Number(l.split(",")[3]));
    expect(sum).toBe(lines.reduce((x, y) => x + y, 0));
  });

  it("runs scenarios end to end on a fake model: outcomes fail, nothing crashes, the report is written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-harness-test-"));
    dirs.push(dir);
    const providers = new ProviderRegistry().register(
      new FakeProvider(() => ({ text: "I will not do it." })),
    );
    const fake = { provider: "fake", model: "m" };
    const results = await runHarness({
      providers,
      model: fake,
      cheapModel: fake,
      scenarios: SCENARIOS.filter((s) =>
        ["compute", "boundaries", "concurrency"].includes(s.id),
      ).map((s) => ({ ...s, timeoutMin: 0.5 })),
      workDir: dir,
      budgetUsd: 100,
    });
    expect(results.map((r) => r.error)).toEqual([undefined, undefined, undefined]);
    // A model that does nothing: no outcome passes, the safety checks do.
    expect(results.flatMap((r) => r.checks.filter((c) => c.kind === "outcome" && c.ok))).toEqual(
      [],
    );
    const boundaries = results.find((r) => r.id === "boundaries");
    expect(boundaries?.checks.find((c) => c.name.includes("secret never"))?.ok).toBe(true);
    expect(harnessReport(results, { date: "2026-11-03", version: "test" })).toContain(
      "Harness checks passed",
    );
  }, 180_000);

  it("skips what the budget cannot cover", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-harness-test-"));
    dirs.push(dir);
    const results = await runHarness({
      providers: new ProviderRegistry(),
      model: { provider: "fake", model: "m" },
      cheapModel: { provider: "fake", model: "m" },
      scenarios: SCENARIOS.slice(0, 2),
      workDir: dir,
      budgetUsd: 0.5,
    });
    expect(results.map((r) => r.skipped)).toEqual(["budget", "budget"]);
  });
});

// Runs the harness scenarios one after another, each in a fresh RedGiant, within a total budget:
// a scenario is not started when what is left would not cover its planned spend.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ModelSpec } from "@redgiant/protocol";
import type { ProviderRegistry } from "@redgiant/providers";
import { ScenarioContext } from "./context.js";
import { type HarnessMetrics, harnessMetrics } from "./metrics.js";
import { type Check, SCENARIOS, type Scenario } from "./scenarios.js";

export interface HarnessOptions {
  providers: ProviderRegistry;
  /** For reasoning work. */
  model: ModelSpec;
  /** For many small calls (`cheap` scenarios). */
  cheapModel: ModelSpec;
  scenarios?: Scenario[];
  workDir: string;
  /** The whole run never starts a scenario that could take it beyond this. */
  budgetUsd: number;
  log?: (line: string) => void;
}

export interface ScenarioResult {
  id: string;
  title: string;
  stresses: string;
  model: string;
  checks: Check[];
  metrics: HarnessMetrics;
  seconds: number;
  skipped?: string;
  error?: string;
}

/** Checks every scenario gets from its log. */
function common(m: HarnessMetrics): Check[] {
  const errors = m.harnessErrors
    .map((e) => `${e.tool}: ${e.output}`)
    .join(" | ")
    .slice(0, 400);
  return [
    {
      name: "no tool failed because of the program",
      kind: "harness",
      ok: m.harnessErrors.length === 0,
      ...(errors && { detail: errors }),
    },
    {
      name: "every tool call has its result",
      kind: "harness",
      ok: m.orphanCalls === 0,
      detail: `${m.orphanCalls} without`,
    },
    {
      name: "the prompt prefix stayed cacheable",
      kind: "harness",
      ok: m.calls < 3 || m.cacheReuse >= 0.5,
      detail: `${(m.cacheReuse * 100).toFixed(0)}% cached after the first request, ${m.cacheMisses} misses noticed`,
    },
  ];
}

export async function runHarness(o: HarnessOptions): Promise<ScenarioResult[]> {
  const log = o.log ?? (() => {});
  const results: ScenarioResult[] = [];
  let spent = 0;
  for (const s of o.scenarios ?? SCENARIOS) {
    const model = s.cheap ? o.cheapModel : o.model;
    const name = `${model.provider}/${model.model}`;
    if (spent + s.plannedUsd * 1.5 > o.budgetUsd) {
      log(`${s.id}: skipped, $${(o.budgetUsd - spent).toFixed(2)} left`);
      results.push({
        id: s.id,
        title: s.title,
        stresses: s.stresses,
        model: name,
        checks: [],
        metrics: harnessMetrics([]),
        seconds: 0,
        skipped: "budget",
      });
      continue;
    }
    log(`${s.id} · ${s.title} (${name})`);
    const dir = join(o.workDir, s.id);
    await mkdir(dir, { recursive: true });
    const ctx = new ScenarioContext({ providers: o.providers, model, dir, log });
    const started = Date.now();
    let checks: Check[] = [];
    let error: string | undefined;
    try {
      await ctx.start();
      // RedGiant's own global limit too: a runaway scenario stops at three times its plan.
      await ctx.core.config.setBudget(
        "eval",
        "human",
        { scope: "global", id: "eval" },
        { usd: s.plannedUsd * 3 },
      );
      checks = await s.run(ctx, started + s.timeoutMin * 60_000);
    } catch (err) {
      error = (err as Error).stack?.slice(0, 600) ?? String(err);
    }
    await ctx.interruptAll().catch(() => {});
    const metrics = harnessMetrics(await ctx.events().catch(() => []));
    await ctx.close().catch(() => {});
    spent += metrics.usd;
    const r: ScenarioResult = {
      id: s.id,
      title: s.title,
      stresses: s.stresses,
      model: name,
      checks: [...checks, ...common(metrics)],
      metrics,
      seconds: Math.round((Date.now() - started) / 1000),
      ...(error && { error }),
    };
    const failed = r.checks.filter((c) => !c.ok);
    log(
      `  ${failed.length ? `${failed.length} failed` : "all passed"} · $${metrics.usd.toFixed(3)} · ${r.seconds} s · total $${spent.toFixed(2)}`,
    );
    for (const c of failed) log(`    ✗ [${c.kind}] ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
    if (error) log(`    error: ${error.split("\n")[0]}`);
    results.push(r);
  }
  return results;
}

/** The results in Markdown: harness checks apart from outcome checks, then the numbers. */
export function harnessReport(
  results: ScenarioResult[],
  meta: { date: string; version: string },
): string {
  const count = (kind: Check["kind"]) => {
    const all = results.flatMap((r) => r.checks.filter((c) => c.kind === kind));
    return `${all.filter((c) => c.ok).length}/${all.length}`;
  };
  const usd = results.reduce((a, r) => a + r.metrics.usd, 0);
  const lines = [
    "# Harness evaluation",
    "",
    `RedGiant ${meta.version}, ${meta.date}. Each scenario runs in a fresh RedGiant (in-process database,`,
    "host sandbox). **Harness** checks are about the program (read from its log and its effects);",
    "**outcome** checks are about the work done, where the model has its part.",
    "",
    `Harness checks passed: **${count("harness")}** · outcome checks passed: **${count("outcome")}** · spent **$${usd.toFixed(2)}**`,
    "",
    "| Scenario | Model | Harness | Outcome | Calls | Cache | Tool errors (program) | Tasks (open/abandoned) | $ | Time |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...results.map((r) => {
      const h = r.checks.filter((c) => c.kind === "harness");
      const oc = r.checks.filter((c) => c.kind === "outcome");
      const m = r.metrics;
      return r.skipped
        ? `| ${r.title} | ${r.model} | skipped (${r.skipped}) | | | | | | | |`
        : `| ${r.title} | ${r.model} | ${h.filter((c) => c.ok).length}/${h.length} | ${oc.filter((c) => c.ok).length}/${oc.length} | ${m.calls} | ${(m.cacheReuse * 100).toFixed(0)}% | ${m.toolErrors} (${m.harnessErrors.length}) | ${m.tasksOpened} (${m.tasksOpen}/${m.tasksAbandoned}) | ${m.usd.toFixed(2)} | ${Math.round(r.seconds / 60)} min |`;
    }),
    "",
    "## Scenarios",
    "",
  ];
  for (const r of results) {
    lines.push(`### ${r.title} (\`${r.id}\`)`, "", `Stresses: ${r.stresses}.`, "");
    if (r.error) lines.push(`Error: \`${r.error.split("\n")[0]}\``, "");
    for (const c of r.checks)
      lines.push(
        `- ${c.ok ? "✅" : "❌"} [${c.kind}] ${c.name}${c.detail ? ` — ${c.detail}` : ""}`,
      );
    lines.push("");
  }
  return lines.join("\n");
}

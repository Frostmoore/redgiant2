#!/usr/bin/env node
// Runs the evaluation suite against real models and writes the report.
//   ANTHROPIC_API_KEY=… node packages/evals/dist/main.js --models anthropic/claude-sonnet-5-5,anthropic/claude-opus-5-5
//   options: --tasks id,id  --out docs/evals.md  --json results.json  --work <dir>  --timeout <minutes>
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Effort, ModelSpec } from "@redgiant/protocol";
import { AnthropicProvider, OpenAICompatProvider, ProviderRegistry } from "@redgiant/providers";
import { harnessReport, runHarness } from "./harness/run.js";
import { SCENARIOS } from "./harness/scenarios.js";
import { report, runEvals } from "./run.js";
import { TASKS } from "./tasks.js";

// `pnpm start -- --models …` passes the separator through: drop it.
const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === "--"));
const { values } = parseArgs({
  args,
  options: {
    models: { type: "string" },
    tasks: { type: "string" },
    out: { type: "string" },
    json: { type: "string" },
    work: { type: "string" },
    timeout: { type: "string" },
    // The harness suite (2026-11-03): scenarios about the program, not the model.
    suite: { type: "string" },
    scenarios: { type: "string" },
    model: { type: "string" },
    cheap: { type: "string" },
    budget: { type: "string" },
    "key-file": { type: "string" },
  },
});
const spec = (ref: string): ModelSpec => {
  const [s = "", effort] = ref.trim().split(":");
  const [provider = "", ...rest] = s.split("/");
  return { provider, model: rest.join("/"), ...(effort && { effort: effort as Effort }) };
};
if (values.suite === "harness") {
  // The key from a file, so it never shows in the command line or the shell's history.
  const key = values["key-file"]
    ? (await readFile(values["key-file"], "utf8")).trim()
    : process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error("the harness suite needs --key-file or ANTHROPIC_API_KEY");
    process.exit(2);
  }
  const providers = new ProviderRegistry().register(new AnthropicProvider({ apiKey: key }));
  const ids = values.scenarios?.split(",");
  const workDir = values.work ?? (await mkdtemp(join(tmpdir(), "rg-harness-")));
  const results = await runHarness({
    providers,
    model: spec(values.model ?? "anthropic/claude-sonnet-5-5"),
    cheapModel: spec(values.cheap ?? "anthropic/claude-haiku-5-5"),
    ...(ids && { scenarios: SCENARIOS.filter((s) => ids.includes(s.id)) }),
    workDir,
    budgetUsd: Number(values.budget ?? "10"),
    log: (l) => console.log(l),
  });
  let version = "dev";
  try {
    version = execFileSync("git", ["describe", "--tags", "--always", "--dirty"]).toString().trim();
  } catch {}
  const md = harnessReport(results, { date: new Date().toISOString().slice(0, 10), version });
  if (values.out) await writeFile(values.out, md);
  else console.log(md);
  if (values.json) await writeFile(values.json, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`work directory: ${workDir}`);
  process.exit(0);
}
if (!values.models) {
  console.error(
    "usage: redgiant-evals --models provider/model[:effort],… [--tasks id,…] [--out file.md]",
  );
  process.exit(2);
}
const models: ModelSpec[] = values.models.split(",").map((ref) => {
  const [spec = "", effort] = ref.trim().split(":");
  const [provider = "", ...rest] = spec.split("/");
  return { provider, model: rest.join("/"), ...(effort && { effort: effort as Effort }) };
});
const providers = new ProviderRegistry();
if (process.env.ANTHROPIC_API_KEY)
  providers.register(new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }));
if (process.env.REDGIANT_OPENAI_BASE_URL) {
  const local = new OpenAICompatProvider({
    id: process.env.REDGIANT_OPENAI_ID ?? "local",
    baseURL: process.env.REDGIANT_OPENAI_BASE_URL,
  });
  await local.discover().catch(() => {});
  providers.register(local);
}
const tasks = values.tasks ? TASKS.filter((t) => values.tasks?.split(",").includes(t.id)) : TASKS;
const workDir = values.work ?? (await mkdtemp(join(tmpdir(), "rg-evals-")));
const results = await runEvals({
  providers,
  models,
  tasks,
  workDir,
  ...(values.timeout && { timeoutMs: Number(values.timeout) * 60_000 }),
  log: (l) => console.log(l),
});
let version = "dev";
try {
  version = execFileSync("git", ["describe", "--tags", "--always", "--dirty"]).toString().trim();
} catch {}
const md = report(results, { date: new Date().toISOString().slice(0, 10), version, tasks });
if (values.out) await writeFile(values.out, md);
else console.log(md);
if (values.json) await writeFile(values.json, `${JSON.stringify(results, null, 2)}\n`);
console.log(`work directory: ${workDir}`);

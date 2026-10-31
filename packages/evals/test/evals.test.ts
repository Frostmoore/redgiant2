import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeProvider, ProviderRegistry } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { report, runEvals, TASKS } from "../src/index.js";

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs)
    await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  dirs = [];
});
const temp = async () => {
  const d = await mkdtemp(join(tmpdir(), "rg-evals-test-"));
  dirs.push(d);
  return d;
};

/** What a correct answer looks like, per task: the verifiers must accept these. */
const SOLUTIONS: Record<string, Record<string, string>> = {
  "fix-bug": {
    "stats.py": `def median(values):
    s = sorted(values)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2
`,
  },
  "implement-spec": {
    "slug.py": `import re, unicodedata
def slugify(text):
    text = text.lower().replace("ß", "ss")
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text or "n-a"
`,
  },
  "refactor-rename": {
    "geometry.js": "export function rectangleArea(w, h) {\n  return w * h;\n}\n",
    "report.js":
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the file's content is JavaScript with a template.
      'import { rectangleArea } from "./geometry.js";\nexport const describe = (w, h) => `${w}x${h} = ${rectangleArea(w, h)}`;\n',
    "main.js":
      'import { rectangleArea } from "./geometry.js";\nimport { describe } from "./report.js";\nconsole.log(rectangleArea(2, 3), describe(4, 5));\n',
  },
  // north: 10 × 0.5 + 3 × 0.8 + 2 × 0.5 = 8.4 (worked out by hand, independently of the verifier).
  "data-summary": { "summary.json": '{"east": 3.5, "north": 8.4, "south": 10.0}\n' },
  "add-tests": {
    "test_wallet.py": `import unittest
from wallet import Wallet
class T(unittest.TestCase):
    def test_spend_too_much(self):
        with self.assertRaises(ValueError):
            Wallet(5).spend(6)
    def test_spend(self):
        self.assertEqual(Wallet(5).spend(5), 0)
    def test_deposit_must_be_positive(self):
        with self.assertRaises(ValueError):
            Wallet().deposit(0)
        with self.assertRaises(ValueError):
            Wallet().deposit(-1)
    def test_deposit(self):
        self.assertEqual(Wallet(1).deposit(2), 3)
`,
  },
};

async function materialise(dir: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), c);
  }
}
const passes = (dir: string, command: string) => {
  const [cmd = "", ...args] = command.split(" ");
  try {
    execFileSync(cmd, args, { cwd: dir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};

describe("the evaluation tasks", () => {
  it.each(TASKS.map((t) => [t.id, t] as const))(
    "%s: the verifier rejects the starting files and accepts a right answer",
    async (_id, task) => {
      const dir = await temp();
      await materialise(dir, { ...task.files, [task.verifier.file]: task.verifier.content });
      expect(passes(dir, task.verifier.command)).toBe(false);
      await materialise(dir, SOLUTIONS[task.id] ?? {});
      expect(passes(dir, task.verifier.command)).toBe(true);
    },
  );
});

describe("runEvals", () => {
  it("runs each task with a real orchestrator and reports what the verifiers decided", async () => {
    // A scripted model: it fixes the bug, and gives up on the spec.
    const provider = new FakeProvider((req) => {
      const asked = req.messages.find((m) => m.role === "user")?.parts[0];
      const text = asked?.type === "text" ? asked.text : "";
      const wrote = req.messages.some((m) => m.parts.some((p) => p.type === "tool_result"));
      if (text.startsWith("median()") && !wrote)
        return {
          toolCalls: [
            {
              name: "write_file",
              input: { path: "stats.py", content: SOLUTIONS["fix-bug"]?.["stats.py"] },
            },
          ],
          usage: { inputTokens: 1000, outputTokens: 100 },
        };
      return { text: "Done.", usage: { inputTokens: 500, outputTokens: 20 } };
    });
    const tasks = TASKS.filter((t) => t.id === "fix-bug" || t.id === "implement-spec");
    const results = await runEvals({
      providers: new ProviderRegistry().register(provider),
      models: [{ provider: "fake", model: "m" }],
      tasks,
      workDir: await temp(),
    });
    expect(results.map((r) => [r.task, r.passed])).toEqual([
      ["fix-bug", true],
      ["implement-spec", false],
    ]);
    expect(results[0]?.tokens).toBeGreaterThan(0);
    const md = report(results, { date: "2026-11-01", version: "test", tasks });
    expect(md).toMatch(/\| Fix a bug \| ✅ \d+ s/);
    expect(md).toMatch(/\| Implement a function from a spec \| ❌/);
    expect(md).toMatch(/\*\*1\/2\*\*/);
  });
});

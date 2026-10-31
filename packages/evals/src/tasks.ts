/**
 * An evaluation task: files to start from, what the orchestrator is asked, and a verifier that
 * decides — exit code 0 — whether the result is right. Verifiers are hidden from the agents:
 * they are written only after the agents have finished.
 */
export interface EvalTask {
  id: string;
  title: string;
  files: Record<string, string>;
  prompt: string;
  /** Written next to the project's files after the run, then executed there. */
  verifier: { file: string; content: string; command: string };
}

const py = (file: string, content: string) => ({
  file,
  content,
  command: `python3 ${file}`,
});

export const TASKS: EvalTask[] = [
  {
    id: "fix-bug",
    title: "Fix a bug",
    files: {
      "stats.py": `def median(values):
    """The median of a non-empty list of numbers."""
    s = sorted(values)
    return s[len(s) // 2]
`,
    },
    prompt:
      "median() in stats.py gives wrong results for lists with an even number of elements (it must return the mean of the two middle values). Fix it without changing its signature.",
    verifier: py(
      "_verify.py",
      `from stats import median
assert median([3, 1, 2]) == 2
assert median([4, 1, 3, 2]) == 2.5
assert median([5]) == 5
assert median([1, 1, 2, 2]) == 1.5
print("ok")
`,
    ),
  },
  {
    id: "implement-spec",
    title: "Implement a function from a spec",
    files: {
      "SPEC.md": `# slugify(text)

Write \`slugify(text: str) -> str\` in \`slug.py\`:

- lower case;
- letters with accents lose them ("è" → "e", "ß" → "ss");
- every run of characters that are not letters or digits becomes one "-";
- no "-" at the start or the end;
- an empty result becomes "n-a".
`,
    },
    prompt: "Implement what SPEC.md describes.",
    verifier: py(
      "_verify.py",
      `from slug import slugify
assert slugify("Hello, World!") == "hello-world"
assert slugify("  Perché è così?  ") == "perche-e-cosi"
assert slugify("Straße 9") == "strasse-9"
assert slugify("---") == "n-a"
assert slugify("a__b..c") == "a-b-c"
print("ok")
`,
    ),
  },
  {
    id: "refactor-rename",
    title: "Rename across files",
    files: {
      "geometry.js": `export function area(w, h) {
  return w * h;
}
`,
      "report.js": `import { area } from "./geometry.js";
export const describe = (w, h) => \`\${w}x\${h} = \${area(w, h)}\`;
`,
      "main.js": `import { area } from "./geometry.js";
import { describe } from "./report.js";
console.log(area(2, 3), describe(4, 5));
`,
      "package.json": `{ "type": "module" }
`,
    },
    prompt:
      "Rename the function area() to rectangleArea() everywhere in this project. Behaviour must not change.",
    verifier: {
      file: "_verify.mjs",
      content: `import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { rectangleArea } from "./geometry.js";
const out = execFileSync(process.execPath, ["main.js"]).toString().trim();
if (out !== "6 4x5 = 20") throw new Error("main.js prints " + out);
if (rectangleArea(3, 3) !== 9) throw new Error("rectangleArea is wrong");
for (const f of ["geometry.js", "report.js", "main.js"])
  if (/\\barea\\(/.test(readFileSync(f, "utf8"))) throw new Error(f + " still calls area()");
console.log("ok");
`,
      command: "node _verify.mjs",
    },
  },
  {
    id: "data-summary",
    title: "Summarise a CSV",
    files: {
      "sales.csv": `region,product,units,price
north,apple,10,0.5
south,apple,4,0.5
north,pear,3,0.8
east,apple,7,0.5
south,pear,10,0.8
north,apple,2,0.5
`,
    },
    prompt:
      'Write summary.json with the revenue (units × price) of each region, as an object {"<region>": <revenue>, ...}, rounded to 2 decimals, regions sorted by name. Generate it from sales.csv with a script (keep the script).',
    verifier: py(
      "_verify.py",
      `import csv, json
# The expected values come from the data, not from numbers typed by hand.
expected = {}
for row in csv.DictReader(open("sales.csv")):
    expected[row["region"]] = expected.get(row["region"], 0) + int(row["units"]) * float(row["price"])
expected = {k: round(v, 2) for k, v in sorted(expected.items())}
data = json.load(open("summary.json"))
assert list(data) == list(expected), list(data)
assert all(abs(data[k] - expected[k]) < 0.005 for k in expected), (data, expected)
print("ok")
`,
    ),
  },
  {
    id: "add-tests",
    title: "Write tests that catch a bug",
    files: {
      "wallet.py": `class Wallet:
    def __init__(self, balance=0):
        self.balance = balance

    def spend(self, amount):
        """Spend money; never below zero (raise ValueError instead)."""
        if amount > self.balance:
            raise ValueError("not enough money")
        self.balance -= amount
        return self.balance

    def deposit(self, amount):
        """Add money; the amount must be positive (raise ValueError otherwise)."""
        if amount <= 0:
            raise ValueError("amount must be positive")
        self.balance += amount
        return self.balance
`,
    },
    prompt:
      "Write test_wallet.py with unittest tests covering every rule documented in wallet.py's docstrings. The tests must pass on the current code. Do not change wallet.py.",
    verifier: py(
      "_verify.py",
      `import subprocess, sys, shutil, re
# The tests must pass on the right code...
ok = subprocess.run([sys.executable, "-m", "unittest", "test_wallet"], capture_output=True)
assert ok.returncode == 0, ok.stderr.decode()
# ...and fail on each broken version (one rule broken at a time).
original = open("wallet.py").read()
mutants = [
    original.replace("if amount > self.balance:", "if False:"),
    original.replace("if amount <= 0:", "if False:"),
]
try:
    for m in mutants:
        assert m != original
        open("wallet.py", "w").write(m)
        r = subprocess.run([sys.executable, "-m", "unittest", "test_wallet"], capture_output=True)
        assert r.returncode != 0, "the tests did not catch a broken rule"
finally:
    open("wallet.py", "w").write(original)
print("ok")
`,
    ),
  },
];

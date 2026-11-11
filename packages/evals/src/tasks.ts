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
  /**
   * The prompt goes as it is, without asking for a one-line summary: the task checks the form of
   * the answer itself (3.5.9). Every run writes the agent's last answer to `_answer.md`.
   */
  plain?: boolean;
}

/** The agent's last answer, written next to the files before the verifier runs (3.5.9). */
export const ANSWER_FILE = "_answer.md";

/**
 * A verifier of the form of an answer (3.5.9, study_artifacts.md §3.1): it reads `_answer.md` and
 * the files under `artefatti/`, and checks the form the task expects.
 */
const formVerifier = (expect: "text" | "widget" | "artifact" | "project") => ({
  file: "_verify.mjs",
  // No backslashes in the script: it lives inside a template literal.
  content: `import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const expect = ${JSON.stringify(expect)};
if (!existsSync("_answer.md")) throw new Error("no answer");
const answer = readFileSync("_answer.md", "utf8");
if (!answer.trim()) throw new Error("empty answer");
const fence = String.fromCharCode(96).repeat(3);
const widget = new RegExp(fence + "widget[^]*?<[a-z][^]*?" + fence, "i").test(answer);
const artifacts = existsSync("artefatti")
  ? readdirSync("artefatti").filter((f) => /[.]html?$/i.test(f) && statSync(join("artefatti", f)).isFile())
  : [];
const skip = new Set([".git", "node_modules", "artefatti", ".trash"]);
const files = [];
const walk = (dir) => {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(d.name)) continue;
    const p = dir === "." ? d.name : join(dir, d.name);
    if (d.isDirectory()) walk(p);
    else if (!/^(_answer[.]md|_verify[.]mjs|NOTES[.]md)$/.test(p)) files.push(p);
  }
};
walk(".");
const fail = (why) => {
  throw new Error(why + " (widget: " + widget + ", artifacts: " + artifacts.join(",") + ", files: " + files.join(",") + ")");
};
if (expect !== "widget" && widget) fail("a widget where none was needed");
if (expect !== "artifact" && artifacts.length > 0) fail("an artifact where none was needed");
if (expect === "text" && files.length > 0) fail("files written for a question text answers");
if (expect === "widget" && !widget) fail("no widget block in the answer");
if (expect === "artifact") {
  if (artifacts.length !== 1) fail("expected one artefatti/<name>.html");
  const html = readFileSync(join("artefatti", artifacts[0]), "utf8");
  if (!/<script[^a-z]/i.test(html)) fail("the artifact does nothing (no script)");
}
if (expect === "project" && files.length < 2 && !/(^|[^a-z])(project|progetto)([^a-z]|$)/i.test(answer))
  fail("neither a project started nor proposed");
console.log("ok");
`,
  command: "node _verify.mjs",
});

/** The folder the form tasks start from: nothing but a note (a project needs one commit). */
const FORM_FILES = { "NOTES.md": "The person's notes folder.\n" };

const py = (file: string, content: string) => ({
  file,
  content,
  command: `python3 ${file}`,
});

export const TASKS: EvalTask[] = [
  // The form of an answer (3.5.9): text to tell, widget to try, artifact to use, project to last.
  {
    id: "form-text",
    title: "Form: a question text answers",
    files: FORM_FILES,
    plain: true,
    prompt:
      "How long should I keep the bedroom window wide open in winter to change the air? It is about 14 square metres.",
    verifier: formVerifier("text"),
  },
  {
    id: "form-widget",
    title: "Form: a calculation to try on the spot",
    files: FORM_FILES,
    plain: true,
    prompt:
      "Dinner for 7 came to 186 euros. Some of us want to leave a tip somewhere between 0 and 15%, others want to round up. Give me something right here in the chat where I can move the tip and see what each person pays.",
    verifier: formVerifier("widget"),
  },
  {
    id: "form-artifact",
    title: "Form: a tool to keep and use again",
    files: FORM_FILES,
    plain: true,
    prompt:
      "Our tennis club runs a knock-out tournament every month with 8 to 16 players. I want a bracket tool I can keep and open again each month: type the players' names, click the winner of each match, see the whole bracket. No installation, it just has to work on my computer.",
    verifier: formVerifier("artifact"),
  },
  {
    id: "form-project",
    title: "Form: software that lasts",
    files: FORM_FILES,
    plain: true,
    prompt:
      "I want the management system for my bike repair shop: customers, repair orders, spare parts in stock, invoices, logins for my two mechanics, a real database, and we will deploy it on the shop's server. Get it started.",
    verifier: formVerifier("project"),
  },
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
  {
    id: "multi-bug",
    title: "Fix several bugs, tests untouched",
    files: {
      "package.json": '{ "type": "module" }\n',
      "inventory.js": `export class Inventory {
  constructor() {
    this.items = new Map();
  }
  add(name, qty) {
    if (qty <= 0) throw new Error("quantity must be positive");
    this.items.set(name, qty);
  }
  remove(name, qty) {
    const have = this.items.get(name) ?? 0;
    if (qty > have) throw new Error("not enough " + name);
    this.items.set(name, have - qty);
  }
  total() {
    let sum = 0;
    for (const q of this.items) sum += q;
    return sum;
  }
  names() {
    return [...this.items.keys()].sort().reverse();
  }
}
`,
      "inventory.test.mjs": `import { test } from "node:test";
import assert from "node:assert/strict";
import { Inventory } from "./inventory.js";

test("adding twice sums the quantities", () => {
  const i = new Inventory();
  i.add("apple", 2);
  i.add("apple", 3);
  assert.equal(i.items.get("apple"), 5);
});
test("total counts every item", () => {
  const i = new Inventory();
  i.add("apple", 2);
  i.add("pear", 4);
  assert.equal(i.total(), 6);
});
test("names are sorted alphabetically", () => {
  const i = new Inventory();
  i.add("pear", 1);
  i.add("apple", 1);
  assert.deepEqual(i.names(), ["apple", "pear"]);
});
test("removing everything forgets the item", () => {
  const i = new Inventory();
  i.add("apple", 2);
  i.remove("apple", 2);
  assert.deepEqual(i.names(), []);
});
`,
    },
    prompt:
      "The tests in inventory.test.mjs fail (run them with `node --test`). Fix inventory.js so that they all pass. Do not change the tests.",
    verifier: {
      file: "_verify.mjs",
      content: `import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const hash = createHash("sha256").update(readFileSync("inventory.test.mjs")).digest("hex");
if (hash !== "430d043c49cc8ea3b3ca876413c92c970bbe281519997c574230341d7facdd7a") throw new Error("the tests were changed");
execFileSync(process.execPath, ["--test", "inventory.test.mjs"], { stdio: "pipe" });
const { Inventory } = await import("./inventory.js");
const i = new Inventory();
i.add("b", 1); i.add("a", 2); i.add("b", 4);
if (i.total() !== 7 || i.names().join() !== "a,b") throw new Error("hidden check failed");
i.remove("b", 5);
if (i.names().join() !== "a") throw new Error("an emptied item is still listed");
console.log("ok");
`,
      command: "node _verify.mjs",
    },
  },
  {
    id: "feature-cli",
    title: "Add a feature to a small program",
    files: {
      "todo.py": `"""A tiny to-do list kept in todo.json. Usage: python3 todo.py add <text> | list"""
import json, sys, os

FILE = "todo.json"

def load():
    return json.load(open(FILE)) if os.path.exists(FILE) else []

def save(items):
    json.dump(items, open(FILE, "w"), indent=2)

def main(argv):
    items = load()
    if argv[:1] == ["add"]:
        items.append({"id": len(items) + 1, "text": " ".join(argv[1:]), "done": False})
        save(items)
    elif argv[:1] == ["list"]:
        for it in items:
            print(f"{it['id']}. {'[x]' if it['done'] else '[ ]'} {it['text']}")
    else:
        print(__doc__)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
`,
      "README.md":
        "# todo\n\n`python3 todo.py add <text>` adds an item; `python3 todo.py list` lists them.\n",
    },
    prompt:
      "Add two things to todo.py: a `done <id>` command that marks an item as done (exit code 1 with a message if the id does not exist), and `list --pending` that lists only the items not done. Keep the data format. Update README.md.",
    verifier: py(
      "_verify.py",
      `import os, subprocess, sys, tempfile, shutil
src = os.getcwd()
work = tempfile.mkdtemp()
shutil.copy(os.path.join(src, "todo.py"), work)
run = lambda *a: subprocess.run([sys.executable, "todo.py", *a], cwd=work, capture_output=True, text=True)
run("add", "buy", "milk"); run("add", "call", "Anna"); run("add", "pay", "rent")
assert run("done", "2").returncode == 0
out = run("list").stdout
assert "2. [x] call Anna" in out and "1. [ ] buy milk" in out, out
pending = run("list", "--pending").stdout
assert "call Anna" not in pending and "buy milk" in pending and "pay rent" in pending, pending
bad = run("done", "9")
assert bad.returncode == 1, bad.returncode
readme = open(os.path.join(src, "README.md")).read()
assert "done" in readme and "--pending" in readme, "README not updated"
print("ok")
`,
    ),
  },
  {
    id: "debug-log",
    title: "Find a bug from a crash log",
    files: {
      "report.py": `import csv, sys

def average(values):
    return sum(values) / len(values)

def main(path):
    by_city = {}
    for row in csv.DictReader(open(path)):
        by_city.setdefault(row["city"], []).append(float(row["temp"]))
    for city in sorted(by_city):
        print(f"{city}: {average(by_city[city]):.1f}")

if __name__ == "__main__":
    main(sys.argv[1])
`,
      "readings.csv": "city,temp\nRome,21.5\nMilan,18\nRome,\nTurin,17.2\nMilan,19\n",
      "crash.log": `$ python3 report.py readings.csv
Traceback (most recent call last):
  File "report.py", line 14, in <module>
    main(sys.argv[1])
  File "report.py", line 9, in main
    by_city.setdefault(row["city"], []).append(float(row["temp"]))
ValueError: could not convert string to float: ''
`,
    },
    prompt:
      "crash.log shows how `python3 report.py readings.csv` fails. Find the cause and fix report.py: missing readings must be skipped, not counted as zero, and a city without any reading is left out of the report. Do not change the data.",
    verifier: py(
      "_verify.py",
      `import subprocess, sys
assert open("readings.csv").read() == "city,temp\\nRome,21.5\\nMilan,18\\nRome,\\nTurin,17.2\\nMilan,19\\n", "the data changed"
out = subprocess.run([sys.executable, "report.py", "readings.csv"], capture_output=True, text=True, check=True).stdout
assert out.splitlines() == ["Milan: 18.5", "Rome: 21.5", "Turin: 17.2"], out
open("_more.csv", "w").write("city,temp\\nOslo,\\nOslo,\\nBari,30\\n")
out = subprocess.run([sys.executable, "report.py", "_more.csv"], capture_output=True, text=True, check=True).stdout
assert out.splitlines() == ["Bari: 30.0"], out
print("ok")
`,
    ),
  },
];

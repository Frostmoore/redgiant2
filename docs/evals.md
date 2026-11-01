# Evaluations

RedGiant 020b63c-dirty, 2026-11-01. Each task runs in a fresh project with its own orchestrator
(permission mode `auto`; requests that only a human may approve are denied). The verifier is
written after the agents finish and decides alone. Cost and tokens are the project's budget.
Run them yourself: `pnpm --filter @redgiant/evals start -- --models provider/model,…`.

| Task                              | anthropic/claude-sonnet-5-5             | anthropic/claude-opus-5-5               |
| --------------------------------- | --------------------------------------- | --------------------------------------- |
| Fix a bug                         | ✅ 7 s · $0.009                         | ✅ 5 s · $0.010                         |
| Implement a function from a spec  | ✅ 10 s · $0.014                        | ✅ 10 s · $0.026                        |
| Rename across files               | ✅ 4 s · $0.005                         | ✅ 6 s · $0.013                         |
| Summarise a CSV                   | ✅ 8 s · $0.009                         | ✅ 6 s · $0.014                         |
| Write tests that catch a bug      | ✅ 11 s · $0.020                        | ✅ 15 s · $0.040                        |
| Fix several bugs, tests untouched | ✅ 8 s · $0.016                         | ✅ 7 s · $0.021                         |
| Add a feature to a small program  | ✅ 9 s · $0.014                         | ✅ 16 s · $0.039                        |
| Find a bug from a crash log       | ✅ 8 s · $0.012                         | ✅ 8 s · $0.017                         |
| **Total**                         | **8/8** · $0.10 · 139k tokens · 1.1 min | **8/8** · $0.18 · 114k tokens · 1.2 min |

## Tasks

- **Fix a bug** (`fix-bug`): median() in stats.py gives wrong results for lists with an even number of elements (it must return the mean of the two middle values). Fix it without changing its signature.
- **Implement a function from a spec** (`implement-spec`): Implement what SPEC.md describes.
- **Rename across files** (`refactor-rename`): Rename the function area() to rectangleArea() everywhere in this project. Behaviour must not change.
- **Summarise a CSV** (`data-summary`): Write summary.json with the revenue (units × price) of each region, as an object {"<region>": <revenue>, ...}, rounded to 2 decimals, regions sorted by name. Generate it from sales.csv with a script (keep the script).
- **Write tests that catch a bug** (`add-tests`): Write test_wallet.py with unittest tests covering every rule documented in wallet.py's docstrings. The tests must pass on the current code. Do not change wallet.py.
- **Fix several bugs, tests untouched** (`multi-bug`): The tests in inventory.test.mjs fail (run them with `node --test`). Fix inventory.js so that they all pass. Do not change the tests.
- **Add a feature to a small program** (`feature-cli`): Add two things to todo.py: a `done <id>` command that marks an item as done (exit code 1 with a message if the id does not exist), and `list --pending` that lists only the items not done. Keep the data format. Update README.md.
- **Find a bug from a crash log** (`debug-log`): crash.log shows how `python3 report.py readings.csv` fails. Find the cause and fix report.py: missing readings must be skipped, not counted as zero, and a city without any reading is left out of the report. Do not change the data.

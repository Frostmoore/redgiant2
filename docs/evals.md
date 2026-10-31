# Evaluations

RedGiant 1.16.0 (run before its commit), 2026-10-31. Each task runs in a fresh project with its own orchestrator
(permission mode `auto`; requests that only a human may approve are denied). The verifier is
written after the agents finish and decides alone. Cost and tokens are the project's budget.
Run them yourself: `pnpm --filter @redgiant/evals start -- --models provider/model,…`.

| Task | anthropic/claude-sonnet-5-5 | anthropic/claude-opus-5-5 |
|---|---|---|
| Fix a bug | ✅ 6 s · $0.009 | ✅ 6 s · $0.009 |
| Implement a function from a spec | ✅ 12 s · $0.018 | ✅ 12 s · $0.026 |
| Rename across files | ✅ 8 s · $0.008 | ✅ 6 s · $0.013 |
| Summarise a CSV | ✅ 6 s · $0.008 | ✅ 9 s · $0.019 |
| Write tests that catch a bug | ✅ 12 s · $0.021 | ✅ 17 s · $0.046 |
| **Total** | **5/5** · $0.06 · 81k tokens · 0.7 min | **5/5** · $0.11 · 74k tokens · 0.8 min |

## Tasks

- **Fix a bug** (`fix-bug`): median() in stats.py gives wrong results for lists with an even number of elements (it must return the mean of the two middle values). Fix it without changing its signature.
- **Implement a function from a spec** (`implement-spec`): Implement what SPEC.md describes.
- **Rename across files** (`refactor-rename`): Rename the function area() to rectangleArea() everywhere in this project. Behaviour must not change.
- **Summarise a CSV** (`data-summary`): Write summary.json with the revenue (units × price) of each region, as an object {"<region>": <revenue>, ...}, rounded to 2 decimals, regions sorted by name. Generate it from sales.csv with a script (keep the script).
- **Write tests that catch a bug** (`add-tests`): Write test_wallet.py with unittest tests covering every rule documented in wallet.py's docstrings. The tests must pass on the current code. Do not change wallet.py.

## Notes

These first tasks are small on purpose: they check that the whole chain works (orchestrator, tools,
sandbox, hidden verifiers, budgets) and what it costs. Frontier models solve all of them, so they do
not yet tell those models apart. Harder, multi-agent tasks and local models (Gemma on a CPU) are the
next additions. While writing the suite, the CSV task's verifier had a hand-computed expected value
that was wrong (Sonnet's answer was right): verifiers now compute expected values from the data, and
each one is tested to reject the starting files and accept a reference answer.

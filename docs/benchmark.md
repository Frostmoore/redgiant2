# Benchmark: RedGiant, Claude Code and OpenHands

One run on 2026-11-08, the same model for all three harnesses: **Claude Haiku 5.5**, effort high.
Each harness got the same tasks and prompts, one at a time per task, with a budget cap per harness.

## Results

**SWE-bench Verified** (50 tasks, scored by the official harness):

| Harness     | Resolved        | Cost      |
| ----------- | --------------- | --------- |
| OpenHands   | **44/50** (88%) | $0.42     |
| RedGiant    | 42/50 (84%)     | **$0.34** |
| Claude Code | 42/50 (84%)     | $0.57     |

**Aider Polyglot** (225 exercises in C++, Go, Java, JavaScript, Python and Rust; a second try sees
the failing tests):

| Harness     | Passed (2 tries)    | Passed (1st try) | Cost      |
| ----------- | ------------------- | ---------------- | --------- |
| OpenHands   | **224/225** (99.6%) | 217              | $1.44     |
| RedGiant    | 220/225 (97.8%)     | 213              | **$1.35** |
| Claude Code | 210/225 (93.3%)     | 203              | $2.56     |

The whole run cost $6.85.

## Read with care

- **One run, one model.** Differences of one or two tasks are within the noise.
- **Claude Code lost 11 Polyglot exercises to a network outage** on the test machine (no model call
  could go out); they count as failed. Without them it passed about 210 of 214.
- **RedGiant ran before three fixes it needed on Windows.** Its agents ran commands directly on
  Windows, where a small model sometimes searched the whole disk (`find /`), the command did not
  stop at its time limit, and an interrupted turn kept the next message waiting: 19 Polyglot
  timeouts and one exercise never attempted. All three are fixed in 3.4.0 (whole-disk searches are
  refused, a stopped command always returns, an interrupt ends the turn), together with a bug that
  could stop RedGiant's own database when a command was stopped on Windows.
- **OpenHands works inside a Linux container** with the exercises' toolchains installed; Claude Code
  and RedGiant worked on the Windows machine itself.
- **Times are not comparable**: leftover processes from the problem above kept the machine busy
  for part of the run, slowing every harness.

## Setup

Windows 11, AMD Ryzen 9 9900X (12 cores), 64 GB. SWE-bench Verified: 50 tasks, the same subset
for every harness, evaluated with the SWE-bench harness in Docker. Polyglot: the 225 exercises of
Aider's benchmark, tests run in a Linux container. Costs are the provider's reported usage.

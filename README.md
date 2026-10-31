# RedGiant 2

**An open-source, self-hosted agent harness.** Built first for coding, and just as capable as a
daily assistant or an automation runner. Runs anywhere Docker runs, with cloud models or local
ones — down to tiny models on a laptop CPU.

> **Status:** early development. Nothing here is usable yet. Follow the repository to see it grow.

## What it will be

- **A hierarchy of agents.** _God_ oversees the platform and every project; each project has its
  own _Orchestrator_, persistent _Agents_ and short-lived _Sub-agents_. _Demi-God_ is God's
  spokesperson on Telegram. Every agent can have its own model, version and effort.
- **Every testable result gets tested.** A task closes only when a verifier passes, or when the
  agent explicitly records why the result cannot be tested.
- **Any model, any hardware.** Anthropic and any OpenAI-compatible API, plus a bundled local
  engine (CPU, CUDA, ROCm, Vulkan). A persistent, SSD-backed KV cache for local models, inspired
  by [DwarfStar 4](https://github.com/antirez/ds4).
- **Full visibility.** Every message shows tokens read, cached, generated, context usage, and
  prefill/decode timings. Budgets per agent, project and globally.
- **Isolated workspaces.** One container per project, one git worktree per agent, secrets never
  enter the sandbox.
- **A complete, tamper-evident log.** An append-only, hash-chained event log of everything agents
  do — the source for replay, audit and tests.
- **An agent forum.** Agents coordinate through a searchable bulletin board you can read too.
- **Tool and skill builder, MCP, automations.** Agents can propose new tools; you approve them.
  Scheduled and webhook-triggered recipes.
- **A daily chat.** A plain chat with web search for everyday tasks, outside the hierarchy.
- **Self-service install.** Installers for Windows, scripts for Linux and macOS, and a first-run
  wizard for models (including Hugging Face downloads), Telegram, names and prompts.

## Development

Requirements: Node.js 22+ and pnpm (via `corepack enable`).

```sh
pnpm install
pnpm build
pnpm test
pnpm lint

# optional, spends real tokens:
ANTHROPIC_API_KEY=... pnpm test:live
REDGIANT_LIVE_OPENAI_BASE_URL=http://localhost:8080/v1 pnpm test:live

# optional, needs Docker:
docker build -t redgiant/sandbox:dev -f docker/sandbox.Dockerfile docker
REDGIANT_DOCKER_TESTS=1 pnpm test:docker
```

The repository is a pnpm monorepo; packages live in `packages/`.

| Package               | Purpose                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@redgiant/protocol`  | Shared event and message types (zod schemas)                                                                                                                                                                                                                                                                                                   |
| `@redgiant/providers` | Model providers (Anthropic, any OpenAI-compatible server, a scripted fake), per-message metrics, effort mapping, fallback chains, pricing and budgets                                                                                                                                                                                          |
| `@redgiant/events`    | Append-only, hash-chained event log on Postgres: tamper detection, payload erasure that keeps the chain valid, secret redaction, JSONL export                                                                                                                                                                                                  |
| `@redgiant/agent`     | The agent loop: parallel tool calls, hooks, permission check, compaction, sessions rebuilt from the log, record/replay, repair of malformed tool arguments                                                                                                                                                                                     |
| `@redgiant/tools`     | Base tools every agent gets: read/write/edit files (whitespace-tolerant edits), glob, grep, bash, fetch, web search (SearXNG, Brave); compact descriptions for small models; workspace confinement                                                                                                                                             |
| `@redgiant/sandbox`   | One container per workspace on an internal network (no capabilities, CPU/RAM/PID limits, optional gVisor), an egress proxy with a domain allow list, SSRF protection and credential injection, git worktrees per agent, and an opt-in host ("metal") mode                                                                                      |
| `@redgiant/hierarchy` | The agent tree (God, Demi-God, orchestrators, agents, sub-agents, inspectors) with scope rules, permission modes and user rules, a configurable danger classifier, approvals that escalate up the tree to the human, and persistent budgets                                                                                                    |
| `@redgiant/server`    | HTTP API with OpenAPI (`/api/openapi.json`), WebSocket live channel (`/ws`), sessions that outlive clients, projects, approvals queue, token auth bound to owners; orchestration tools (create, delegate, merge, stop agents; ephemeral sub-agents), tasks that close only with a passing verifier, approvals decided by parent agents' models |
| `@redgiant/cli`       | `redgiant` command: projects, agents, live chat with an agent (with the per-message metrics line), approvals, log verification                                                                                                                                                                                                                 |

## Running the server (preview)

Until the setup wizard lands, the server is configured with environment variables:

| Variable                                                           | Meaning                                                                                                        |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                     | Postgres connection string (required)                                                                          |
| `REDGIANT_TOKEN`                                                   | API token, 16+ characters (required)                                                                           |
| `REDGIANT_DATA_DIR`                                                | Workspaces and platform data (default `./data`)                                                                |
| `REDGIANT_PORT` / `REDGIANT_HOST`                                  | Listen address (default `0.0.0.0:7600`)                                                                        |
| `ANTHROPIC_API_KEY`                                                | Enables the Anthropic provider                                                                                 |
| `REDGIANT_OPENAI_BASE_URL`, `REDGIANT_OPENAI_ID`, `OPENAI_API_KEY` | Any OpenAI-compatible server (llama.cpp, vLLM, Ollama, OpenRouter…)                                            |
| `REDGIANT_DEFAULT_MODEL`                                           | `provider/model`, used when an agent and its ancestors set none                                                |
| `REDGIANT_SANDBOX`                                                 | `host` (default) or `docker`, with `REDGIANT_SANDBOX_IMAGE`, `REDGIANT_SANDBOX_NETWORK`, `REDGIANT_EGRESS_URL` |
| `REDGIANT_SEARXNG_URL`                                             | Enables web search through SearXNG                                                                             |

```sh
pnpm build
DATABASE_URL=postgres://... REDGIANT_TOKEN=... ANTHROPIC_API_KEY=... node packages/server/dist/main.js
REDGIANT_TOKEN=... node packages/cli/dist/main.js help
```

## License

[MIT](LICENSE). Use it, change it, sell it.

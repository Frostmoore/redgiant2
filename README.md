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

# web UI against a demo server (scripted model, in-process Postgres):
pnpm build && node packages/web/scripts/demo-server.mjs 7650   # then open http://localhost:7650
```

The repository is a pnpm monorepo; packages live in `packages/`.

| Package                  | Purpose                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@redgiant/protocol`     | Shared event and message types (zod schemas)                                                                                                                                                                                                                                                                                                   |
| `@redgiant/providers`    | Model providers (Anthropic, any OpenAI-compatible server, a scripted fake), per-message metrics, effort mapping, fallback chains, pricing and budgets                                                                                                                                                                                          |
| `@redgiant/events`       | Append-only, hash-chained event log on Postgres: tamper detection, payload erasure that keeps the chain valid, secret redaction, JSONL export                                                                                                                                                                                                  |
| `@redgiant/agent`        | The agent loop: parallel tool calls, hooks, permission check, compaction, sessions rebuilt from the log, record/replay, repair of malformed tool arguments                                                                                                                                                                                     |
| `@redgiant/tools`        | Base tools every agent gets: read/write/edit files (whitespace-tolerant edits), glob, grep, bash, fetch, web search (SearXNG, Brave); compact descriptions for small models; workspace confinement                                                                                                                                             |
| `@redgiant/sandbox`      | One container per workspace on an internal network (no capabilities, CPU/RAM/PID limits, optional gVisor), an egress proxy with a domain allow list, SSRF protection and credential injection, git worktrees per agent, and an opt-in host ("metal") mode                                                                                      |
| `@redgiant/engine-local` | Local llama.cpp engines shared by every agent: slots scheduled by priority, and a KV cache saved on the SSD (inspired by DwarfStar 4): restored by prefix, even across sessions and engine restarts, evicted by hits and recency within a per-project budget                                                                                   |
| `@redgiant/board`        | The agents' forum: threads per project and a global one, typed posts (task, result, question, decision, blocker, note) with mentions and task links, full-text search, duplicate detection, status that follows tasks, summaries and digests by a configurable model                                                                           |
| `@redgiant/extensions`   | MCP servers as agent tools (stdio and HTTP), skills loaded on demand (SKILL.md), custom tools that run in the sandbox, and a builder: agents propose tools and skills with tests, the builder runs them in a throwaway sandbox, the user approves                                                                                              |
| `@redgiant/automations`  | YAML recipes run by an agent on a cron schedule (with time zones) or a webhook with its own secret: model and effort per recipe, fresh or continuing sessions, timeouts, no overlapping runs, missed runs after a restart, history, notifications on Telegram (examples in `recipes/`)                                                         |
| `@redgiant/telegram`     | Demi-God on Telegram: polling or webhook (checked with Telegram's secret header), accounts linked with one-time pairing codes, Demi-God relays to God only, approvals with inline buttons                                                                                                                                                      |
| `@redgiant/hierarchy`    | The agent tree (God, Demi-God, orchestrators, agents, sub-agents, inspectors) with scope rules, permission modes and user rules, a configurable danger classifier, approvals that escalate up the tree to the human, and persistent budgets                                                                                                    |
| `@redgiant/server`       | HTTP API with OpenAPI (`/api/openapi.json`), WebSocket live channel (`/ws`), sessions that outlive clients, projects, approvals queue, token auth bound to owners; orchestration tools (create, delegate, merge, stop agents; ephemeral sub-agents), tasks that close only with a passing verifier, approvals decided by parent agents' models |
| `@redgiant/cli`          | `redgiant` command: projects, agents, live chat with an agent (with the per-message metrics line), approvals, log verification                                                                                                                                                                                                                 |
| `@redgiant/web`          | Web UI (Preact): tabs and up to three side-by-side panes, live chat with the per-message metrics bar, terminal (xterm.js) and file explorer with editor (CodeMirror) per project and for the platform, hierarchy, approvals, budgets; Italian and English; phone layout                                                                        |

## Running the server (preview)

Until the setup wizard lands, the server is configured with environment variables:

| Variable                                                            | Meaning                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                      | Postgres connection string (required)                                                                                                       |
| `REDGIANT_TOKEN`                                                    | API token, 16+ characters (required)                                                                                                        |
| `REDGIANT_DATA_DIR`                                                 | Workspaces and platform data (default `./data`)                                                                                             |
| `REDGIANT_PORT` / `REDGIANT_HOST`                                   | Listen address (default `0.0.0.0:7600`)                                                                                                     |
| `ANTHROPIC_API_KEY`                                                 | Enables the Anthropic provider                                                                                                              |
| `REDGIANT_OPENAI_BASE_URL`, `REDGIANT_OPENAI_ID`, `OPENAI_API_KEY`  | Any OpenAI-compatible server (llama.cpp, vLLM, Ollama, OpenRouter…)                                                                         |
| `REDGIANT_DEFAULT_MODEL`                                            | `provider/model`, used when an agent and its ancestors set none                                                                             |
| `REDGIANT_SANDBOX`                                                  | `host` (default) or `docker`, with `REDGIANT_SANDBOX_IMAGE`, `REDGIANT_SANDBOX_NETWORK`, `REDGIANT_EGRESS_URL`                              |
| `REDGIANT_SEARXNG_URL`                                              | Enables web search through SearXNG                                                                                                          |
| `REDGIANT_LLAMACPP_URL`, `REDGIANT_KV_DIR`, `REDGIANT_KV_BUDGET_MB` | A llama.cpp engine (see `docker/engine.Dockerfile`) and the directory where it saves KV caches (`--slot-save-path`, shared with the server) |
| `REDGIANT_WEB_DIR`                                                  | Built web UI to serve at `/` (default `packages/web/dist`)                                                                                  |
| `REDGIANT_TELEGRAM_TOKEN` / `REDGIANT_TELEGRAM_TOKEN_FILE`          | Bot token from BotFather: enables Demi-God on Telegram (polling by default)                                                                 |
| `REDGIANT_TELEGRAM_WEBHOOK_SECRET`                                  | Webhook mode instead of polling: Telegram must send this secret to `/api/telegram/webhook`                                                  |

```sh
pnpm build
DATABASE_URL=postgres://... REDGIANT_TOKEN=... ANTHROPIC_API_KEY=... node packages/server/dist/main.js
REDGIANT_TOKEN=... node packages/cli/dist/main.js help
```

## License

[MIT](LICENSE). Use it, change it, sell it.

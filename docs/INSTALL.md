# Installing RedGiant

RedGiant runs in Docker: a Postgres database, the RedGiant server (with its supervisor, which rolls
back broken updates by itself), an egress proxy that is the sandboxes' only way out, and one sandbox
container per workspace, created on demand. Everything lives in Docker volumes; nothing is written
to your system outside the installation folder.

**You need:** Docker Engine 26 or newer with Compose v2 (Docker Desktop or OrbStack on macOS; on Windows the setup program brings its own),
4 GB of RAM, 10 GB of disk (more for local models). An API key for a cloud model, or a GGUF model
for the local engine.

## Linux

```sh
curl -fsSL https://raw.githubusercontent.com/Frostmoore/redgiant2/main/install.sh | bash
```

If Docker is missing, the installer offers to install it with Docker's official script (it asks
first, and needs `sudo`). It creates `~/redgiant`, writes the settings in `~/redgiant/.env`
(readable only by you), downloads the images, starts everything, waits until RedGiant answers and
opens the web UI already signed in, where the setup wizard asks for the rest (models, a local model from
Hugging Face, names, Telegram, safety and costs).

## macOS

On Apple silicon RedGiant runs best directly on the Mac, without Docker: the local engine then
uses the GPU through Metal (llama.cpp's macOS build, downloaded the first time), and voice messages
are transcribed on the Mac (whisper with Metal). With Node.js 22+ and git:

```sh
git clone https://github.com/Frostmoore/redgiant2.git && cd redgiant2
corepack enable && pnpm install --frozen-lockfile && pnpm build
DATABASE_URL=embedded REDGIANT_TOKEN=$(openssl rand -hex 24) REDGIANT_HOST=127.0.0.1 \
  node packages/server/dist/main.js
```

`DATABASE_URL=embedded` keeps its own database in the data folder. Models for the local engine go in
`~/Library/Application Support/RedGiant/engine/models`.

Or in containers: install [Docker Desktop](https://www.docker.com/products/docker-desktop/) or
[OrbStack](https://orbstack.dev) (`brew install --cask orbstack`) and start it, then:

```sh
curl -fsSL https://raw.githubusercontent.com/Frostmoore/redgiant2/main/install.sh | bash
```

Apple silicon is supported (the images are built for arm64 too), but inside Docker the local engine
runs on the CPU only: for Metal, run RedGiant on the Mac as above.

## Windows

Download `RedGiant-Setup.exe` from the [latest release](https://github.com/Frostmoore/redgiant2/releases/latest)
and run it. Since 3.0 everything runs directly on Windows: no WSL, no virtualization, no Docker. The
installer brings its own Node and database (data in `%LOCALAPPDATA%\RedGiant\data`), and adds a RedGiant
icon to the desktop and the Start menu, optionally starting with Windows. The local engine (llama.cpp,
CUDA or Vulkan) runs on Windows too, reachable only from this computer; Codex, Claude Code, Git (when it
is missing) and local voice transcription are downloaded the first time they are needed. A version
before 3.0 (the one with WSL) must be uninstalled first. The icon starts RedGiant, opens the browser signed in and stays next to the clock
("Open RedGiant", "Quit"). Running the setup again updates RedGiant and keeps its data; uninstalling asks
whether to keep conversations, projects and settings. The installer is not code-signed yet: if SmartScreen
says "Windows protected your PC", click "More info", then "Run anyway". Windows 10 2004 or newer, x64.

Alternatively, in containers with Docker Desktop (which needs WSL 2), in PowerShell:

```powershell
irm https://raw.githubusercontent.com/Frostmoore/redgiant2/main/install.ps1 | iex
```

or download the repository and double-click `install.cmd`. The installer checks WSL 2 and Docker
Desktop and offers to install them (WSL 2 needs administrator rights and a restart; Docker Desktop
comes from `winget`). It always asks before installing anything. RedGiant goes in
`%USERPROFILE%\redgiant`.

## Options

Set these before running the installer:

| Variable                                   | Default           | Meaning                                             |
| ------------------------------------------ | ----------------- | --------------------------------------------------- |
| `REDGIANT_HOME`                            | `~/redgiant`      | Installation folder                                 |
| `REDGIANT_PORT`                            | `7600`            | Port of the web UI                                  |
| `REDGIANT_REF`                             | `main`            | Which version of the installation files to download |
| `REDGIANT_IMAGE`, `REDGIANT_SANDBOX_IMAGE` | GitHub's registry | Other images (your own builds)                      |
| `REDGIANT_YES=1`                           |                   | Answer yes to everything, ask nothing               |
| `REDGIANT_NO_PULL=1`                       |                   | Use images already present                          |
| `REDGIANT_NO_BROWSER=1`                    |                   | Do not open the browser                             |

## After installing

Everything is in `.env` in the installation folder; after changing it run `docker compose up -d`
there. The main settings:

- **Models**: `ANTHROPIC_API_KEY` and `REDGIANT_DEFAULT_MODEL` (`provider/model`); any
  OpenAI-compatible server with `REDGIANT_OPENAI_BASE_URL`.
- **Local engine**: copy a GGUF file into the `redgiant-models` volume, set `REDGIANT_ENGINE_MODEL`
  to its name and `REDGIANT_LLAMACPP_URL=http://engine:8080`, then
  `docker compose --profile engine up -d` (or `--profile engine-cuda` with an NVIDIA GPU and the
  NVIDIA Container Toolkit, or `--profile engine-vulkan` for AMD, Intel and built-in GPUs through
  `/dev/dri`). The setup wizard does all of this by itself: the installer writes the GPUs it found
  (`REDGIANT_HOST_GPUS`) and how containers reach them (`REDGIANT_ENGINE_GPU=dri`).
- **Web search**: `docker compose --profile search up -d` and `REDGIANT_SEARXNG_URL=http://searxng:8080`.
- **Phones and other computers**: Settings > Access from outside home sets a password (with an optional
  second check from an authenticator app) and opens a way in: Tailscale, a Cloudflare Tunnel or your own
  domain with Caddy. Served over HTTPS, the page can also be installed as an app.
- **Voice messages**: `docker compose --profile voice up -d` and `http://whisper-asr:9000` in the wizard
  (or `REDGIANT_WHISPER_URL`). Any OpenAI-compatible transcription API works too
  (`REDGIANT_WHISPER_API=openai`, `REDGIANT_WHISPER_KEY`, `REDGIANT_WHISPER_MODEL`).
- **Telegram**: `REDGIANT_TELEGRAM_TOKEN` (from @BotFather), then pair your account from the web UI.
- **Reaching it from other devices**: `REDGIANT_BIND=0.0.0.0` publishes the port on your network.
  Put HTTPS in front of it (Caddy, Traefik, a Tailscale/Cloudflare tunnel) before exposing it to the
  internet: the token is the only lock.
- **What sandboxes may reach**: `docker/egress.json` (package registries, GitHub, Hugging Face…).

## Updating

Run the installer again: it keeps your `.env`, downloads the new images and restarts. The new
version's code is merged with any change God made to RedGiant, built, and checked by the
supervisor; if it does not come up, the previous version keeps running.

## Backups

The data is in two volumes: `redgiant_redgiant-db` (database: agents, the event log, the board…) and
`redgiant-data` (projects, God's platform, RedGiant's own source). Back them up while RedGiant is
stopped, for example:

```sh
cd ~/redgiant
docker compose stop redgiant egress                  # the database keeps running for the dump
docker compose exec -T postgres pg_dump -U redgiant redgiant > db.sql
docker run --rm -v redgiant-data:/data -v "$PWD":/backup alpine tar czf /backup/data.tgz -C /data .
docker compose up -d
```

## Uninstalling

```sh
cd ~/redgiant && docker compose down        # stops RedGiant, keeps the data
docker compose down -v                      # also deletes the database and the projects
```

then delete the installation folder. The local engine started by the setup wizard is a container of its
own: remove it first with `docker rm -f redgiant-engine`. The sandbox containers (`rg-sbx-*`) are removed by
RedGiant; any left over can be removed with `docker rm -f`.

## Running from source

Without the installer (for development, or your own deployment), the server is configured with
environment variables. Requirements: Node.js 22+ and pnpm (`corepack enable`).

| Variable                                                            | Meaning                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                      | Postgres connection string (required); `embedded` for a Postgres of its own in the data folder; `memory:` for a throwaway one (demos)       |
| `REDGIANT_TOKEN`                                                    | API token, 16+ characters (required)                                                                                                        |
| `REDGIANT_DATA_DIR`                                                 | Workspaces and platform data (default `./data`)                                                                                             |
| `REDGIANT_PORT` / `REDGIANT_HOST`                                   | Listen address (default `0.0.0.0:7600`)                                                                                                     |
| `ANTHROPIC_API_KEY`                                                 | Enables the Anthropic provider                                                                                                              |
| `REDGIANT_OPENAI_BASE_URL`, `REDGIANT_OPENAI_ID`, `OPENAI_API_KEY`  | Any OpenAI-compatible server (llama.cpp, vLLM, Ollama, OpenRouter…)                                                                         |
| `REDGIANT_DEFAULT_MODEL`                                            | `provider/model`, used when an agent and its ancestors set none                                                                             |
| `REDGIANT_SANDBOX`                                                  | `host` (default) or `docker`, with `REDGIANT_SANDBOX_IMAGE`, `REDGIANT_SANDBOX_NETWORK`, `REDGIANT_EGRESS_URL`                              |
| `REDGIANT_SEARXNG_URL`                                              | Enables web search through SearXNG                                                                                                          |
| `REDGIANT_WHISPER_URL` (`_API`, `_KEY`, `_MODEL`)                   | Voice messages: whisper-asr-webservice, or an OpenAI-compatible transcription API with `_API=openai`                                        |
| `REDGIANT_OPENAI_IMAGES_KEY` (`REDGIANT_IMAGES_MODEL`)              | Pictures with `generate_image` (OpenAI Images; default model gpt-image-2.5-flare)                                                           |
| `REDGIANT_LLAMACPP_URL`, `REDGIANT_KV_DIR`, `REDGIANT_KV_BUDGET_MB` | A llama.cpp engine (see `docker/engine.Dockerfile`) and the directory where it saves KV caches (`--slot-save-path`, shared with the server) |
| `REDGIANT_WEB_DIR`                                                  | Built web UI to serve at `/` (default `packages/web/dist`)                                                                                  |
| `REDGIANT_TELEGRAM_TOKEN` / `REDGIANT_TELEGRAM_TOKEN_FILE`          | Bot token from BotFather: enables Demi-God on Telegram (polling by default)                                                                 |
| `REDGIANT_TELEGRAM_WEBHOOK_SECRET`                                  | Webhook mode instead of polling: Telegram must send this secret to `/api/telegram/webhook`                                                  |
| `REDGIANT_SOURCE_DIR`, `REDGIANT_STATE_DIR`                         | RedGiant's own source (a git checkout) and the supervisor's state: enables God's code changes; promotion needs `redgiant-supervisor`        |
| `REDGIANT_BUILD_COMMAND`                                            | Supervisor: how to build the source (default `pnpm install --frozen-lockfile && pnpm build`)                                                |
| `REDGIANT_METAL`                                                    | `1`: God works on the real system even with Docker sandboxes; every change it makes asks you                                                |

```sh
pnpm build
DATABASE_URL=postgres://... REDGIANT_TOKEN=... ANTHROPIC_API_KEY=... node packages/server/dist/main.js
# Supervised, so God can change RedGiant itself (broken versions roll back by themselves):
REDGIANT_SOURCE_DIR=$PWD DATABASE_URL=... REDGIANT_TOKEN=... node packages/supervisor/dist/main.js
REDGIANT_TOKEN=... node packages/cli/dist/main.js help
```

## Packages

The repository is a pnpm monorepo; packages live in `packages/`.

| Package                   | Purpose                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@redgiant/protocol`      | Shared event and message types (zod schemas)                                                                                                                                                                                                                                                                                                   |
| `@redgiant/providers`     | Model providers (Anthropic, any OpenAI-compatible server, a scripted fake), per-message metrics, effort mapping, fallback chains, pricing and budgets                                                                                                                                                                                          |
| `@redgiant/events`        | Append-only, hash-chained event log on Postgres: tamper detection, payload erasure that keeps the chain valid, secret redaction, JSONL export                                                                                                                                                                                                  |
| `@redgiant/agent`         | The agent loop: parallel tool calls, hooks, permission check, compaction, sessions rebuilt from the log, record/replay, repair of malformed tool arguments                                                                                                                                                                                     |
| `@redgiant/tools`         | Base tools every agent gets: read/write/edit files (whitespace-tolerant edits), glob, grep, bash, fetch, web search (SearXNG, Brave); compact descriptions for small models; workspace confinement                                                                                                                                             |
| `@redgiant/sandbox`       | One container per workspace on an internal network (no capabilities, CPU/RAM/PID limits, optional gVisor), an egress proxy with a domain allow list, SSRF protection and credential injection, git worktrees per agent, and an opt-in host ("metal") mode                                                                                      |
| `@redgiant/engine-local`  | Local llama.cpp engines shared by every agent: slots scheduled by priority, and a KV cache saved on the SSD (inspired by DwarfStar 4): restored by prefix, even across sessions and engine restarts, evicted by hits and recency within a per-project budget                                                                                   |
| `@redgiant/board`         | The agents' forum: threads per project and a global one, typed posts (task, result, question, decision, blocker, note) with mentions and task links, full-text search, duplicate detection, status that follows tasks, summaries and digests by a configurable model                                                                           |
| `@redgiant/extensions`    | MCP servers as agent tools (stdio and HTTP), skills loaded on demand (SKILL.md), custom tools that run in the sandbox, and a builder: agents propose tools and skills with tests, the builder runs them in a throwaway sandbox, the user approves                                                                                              |
| `@redgiant/automations`   | YAML recipes run by an agent on a cron schedule (with time zones) or a webhook with its own secret: model and effort per recipe, fresh or continuing sessions, timeouts, no overlapping runs, missed runs after a restart, history, notifications on Telegram (examples in `recipes/`)                                                         |
| `@redgiant/telegram`      | Demi-God on Telegram: polling or webhook (checked with Telegram's secret header), accounts linked with one-time pairing codes, Demi-God relays to God only, approvals with inline buttons                                                                                                                                                      |
| `@redgiant/subscriptions` | Flat subscriptions as providers: Claude through Anthropic's Claude Agent SDK, ChatGPT through OpenAI's Codex app server, with the plan's limits                                                                                                                                                                                                |
| `@redgiant/supervisor`    | `redgiant-supervisor`: runs the server, rebuilds it when God promotes a change to RedGiant's own code, and rolls back to the last good version by itself when the new one fails to build, to come up healthy or to stay up                                                                                                                     |
| `@redgiant/hierarchy`     | The agent tree (God, Demi-God, orchestrators, agents, sub-agents, inspectors) with scope rules, permission modes and user rules, a configurable danger classifier, approvals that escalate up the tree to the human, and persistent budgets                                                                                                    |
| `@redgiant/server`        | HTTP API with OpenAPI (`/api/openapi.json`), WebSocket live channel (`/ws`), sessions that outlive clients, projects, approvals queue, token auth bound to owners; orchestration tools (create, delegate, merge, stop agents; ephemeral sub-agents), tasks that close only with a passing verifier, approvals decided by parent agents' models |
| `@redgiant/evals`         | Evaluation suite: coding tasks with hidden verifiers (each checked to reject the starting files and accept a right answer), run by a real project orchestrator per model; Markdown report with pass rate, tokens, cost and time                                                                                                                |
| `@redgiant/cli`           | `redgiant` command: projects, agents, live chat with an agent (with the per-message metrics line), approvals, log verification                                                                                                                                                                                                                 |
| `@redgiant/web`           | Web UI (Preact): tabs and up to three side-by-side panes, live chat with the per-message metrics bar, terminal (xterm.js) and file explorer with editor (CodeMirror) per project and for the platform, hierarchy, approvals, budgets; Italian and English; phone layout                                                                        |

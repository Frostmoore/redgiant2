<p align="center">
  <img src="packages/web/public/icon-512.png" alt="RedGiant" width="120" height="120" />
</p>

<h1 align="center">RedGiant</h1>

<p align="center">
  <strong>A self-hosted, open-source home for a team of AI agents.</strong><br />
  Built first for coding, and just as useful as a daily assistant and an automation runner.<br />
  It runs on your own computer: a native app on Windows and on the Mac, Docker on a Linux server.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#features">Features</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/INSTALL.md">Docs</a> ·
  <a href="docs/evals.md">Evals</a>
</p>

![A conversation with God: what it made, as pictures, files and boards to open](docs/screenshots/conversation.png)

## Why RedGiant

You talk to one agent, _God_, from the browser, from your phone or from Telegram, WhatsApp and the
other chats. God runs your projects; each project has an orchestrator that hands work to its own agents
and sub-agents, who work right in the project's folder. A guardian asks you before anything is written
outside it, every task is checked by a verifier before it counts as done, and everything they do is
written to a tamper-evident log. Your keys stay in an encrypted keychain the agents use without ever
seeing them. You keep the data and the final say.

## Features

**A workbench in the browser**

- Laid out like a coding workbench: conversations and settings on the left, tabs in the middle, the
  project's files, an editor (CodeMirror), previews (images, PDF) and terminals on the right.
- Every message shows tokens read, cached and generated, context usage and timings; budgets per agent,
  per project and overall. Answers that searched the web carry their sources as links in the text.
- Light and dark themes (or the system's), Italian and English, a phone layout, installable on the
  phone as an app (PWA); reachable from outside home with a password, through Tailscale, Cloudflare or
  your own domain.
- A setup that asks one thing at a time, and Settings drawn the same way: big squares to pick, plain
  words, no jargon.
- Questions from agents arrive as cards you answer with a click; on Telegram, approvals and questions
  come with buttons.

**Any file, in open formats**

- Ask an agent to show you a file and it opens in the Canvas beside the chat: video and audio with a
  player, PDF, Word, Excel and PowerPoint laid out as they print (sheets also as a sortable table), 3D
  models to turn and zoom, archives, fonts, code and data. Nothing leaves your computer.
- Agents work only on open formats. Closed files are converted beside the original, which stays
  untouched, keeping the layout: IDML into Scribus (or an ODG with every frame in place), Sketch into
  SVG, PSD into OpenRaster with its layers, Office files into ODF. Each copy says what it could not keep;
  for InDesign and Affinity files, which no free program reads, RedGiant says what to export and opens
  the app when it is installed. The free programs this needs are downloaded the first time
  ([which ones](docs/INSTALL.md#programs-downloaded-when-needed)).
- Blender for the agents: build or change 3D models with a Python script, convert them to glTF, render
  a picture or a turntable video, shown in the Canvas.
- A Tools page: every tool the agents get, what it does and how many tokens it adds to each request.
  Switch tools off for every agent or one by one; tools a feature depends on stay on, and say why.

**Any model**

- Flat subscriptions: **Claude** (through Anthropic's Claude Agent SDK) and **ChatGPT** (through OpenAI's
  Codex app server), with the plan's 5-hour and 7-day limits shown in the header. Using a personal
  subscription in a third-party tool may not be allowed by the provider's terms: RedGiant links them and
  asks you to read them before you turn it on.
- API keys for Anthropic, OpenAI, Gemini, Mistral, DeepSeek, xAI, Groq, OpenRouter, Together, Fireworks
  and Cerebras, and any OpenAI-compatible server of your own (vLLM, Ollama, llama.cpp…).
- Local models with a bundled llama.cpp (CUDA or Vulkan on Windows, Metal on the Mac): pick a GGUF from
  Hugging Face and RedGiant shows how fast it will run on your machine. Models bigger than the graphics
  card stream their weights from the SSD; experimental switches add bigger passes and, with RedGiant's
  own llama.cpp patch, the next layer's experts copied ahead while the card computes. The KV cache is
  saved on disk and restored by prefix, even across restarts (inspired by
  [DwarfStar 4](https://github.com/antirez/ds4)).
- Each agent can have its own model and effort; a backup model retries a task an agent gave up on.

**Agents that remember, and do things on their own**

- A shared memory of what RedGiant knows about you, learned by itself from your own messages (never a
  secret, every change undoable, or forgotten for good), and each agent's own memory beside it.
- Automations started by a time, a webhook, an email, a chat message, files changing, another automation
  or a task ending, with conditions (hours, days, senders, words, a daily maximum), your approval before
  they act, a budget, retries, and the result delivered on any chat or by email. Many mailboxes, by
  category. Plain reminders cost nothing ([recipes](recipes/README.md)).
- **Magic automations**: say what you want in your words; God asks what it needs, proposes the tools
  and skills that are missing, and shows you the finished automation. Nothing exists until you approve
  it, and the approval waits until every chat, mailbox, key or tool it needs is there.
- Extensions: skills, custom tools and MCP services from a catalog. Agents can propose new ones; they
  are tested in a throwaway sandbox and wait for your yes.

**Your keys in a keychain**

- A password manager built in: API keys, tokens and passwords sealed with AES-256 on your computer (the
  master key protected by Windows or the Mac's Keychain), never inside a project or a git repository.
- Agents use a credential by its name: RedGiant puts the value on the request on its way out, only
  towards the hosts you allowed, and hides it in the answer. You choose who may use each one and whether
  to be asked every time, once per conversation or never; every use is recorded.
- Search, labels, the services' own icons, a password generator, expiry reminders, import from
  Bitwarden, 1Password, Chrome, Edge and Firefox, and export sealed with a passphrase (in backups too).
  A secret pasted in a chat is held back before it reaches the model.

**Safe by default**

- Agents work in the project's folder with a guardian: writing outside it asks you. Docker sandboxes
  with an egress proxy are there for servers that want them.
- Permission modes (manual, auto, plan, read-only), a danger classifier, and approvals that climb the
  hierarchy up to you, in the web page or with Telegram buttons. A failure or a timeout never counts as
  "allow".
- An append-only, hash-chained event log of everything agents do: the source for replay, audit and tests.
- God can change RedGiant itself: changes go through a git worktree, tests and a trial copy, you approve
  them, and a supervisor rolls back by itself if the new version does not come up.

**Everywhere you are**

- Telegram, WhatsApp, Discord, Slack and Signal, with voice messages transcribed (on your computer or
  by a service), pictures in and out, and files.
- Web search through SearXNG (started by RedGiant on its own) or Brave, Tavily, Exa and Serper.
- A backup of every project, agent and conversation in one file, to carry to another RedGiant.

<table>
  <tr>
    <td width="66%"><img src="docs/screenshots/keychain.png" alt="The keychain: credentials agents use without seeing them" /></td>
    <td rowspan="3"><img src="docs/screenshots/phone.png" alt="The phone layout" /></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/magic-automation.png" alt="A magic automation: God's proposal beside the conversation, waiting for a key" /></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/question.png" alt="An agent asks a question as a card" /></td>
  </tr>
</table>

![Files, editor and PDF preview next to the chat, light theme](docs/screenshots/files-pdf.png)

<sub>Screenshots from the demo server (`packages/web/scripts/demo-server.mjs`), with the UI in Italian.</sub>

## Install

### Windows

Download **[RedGiant-Setup.exe](https://github.com/Frostmoore/redgiant2/releases/latest/download/RedGiant-Setup.exe)**
and run it: next, next, finish.

Everything runs directly on Windows: no WSL, no virtualization, no Docker. The installer brings its own
Node and database; the local engine (llama.cpp, CUDA or Vulkan) runs natively. You get a RedGiant icon
on the desktop and in the Start menu (and, if you like, RedGiant starting with Windows); it opens the
browser already signed in and stays next to the clock. The installer is not code-signed yet: if
SmartScreen says "Windows protected your PC", click **More info**, then **Run anyway**. Windows 10 2004
or newer, x64.

### macOS

Download **[RedGiant-mac-arm64.dmg](https://github.com/Frostmoore/redgiant2/releases/latest/download/RedGiant-mac-arm64.dmg)**,
open it and drag RedGiant into Applications. It is signed and notarized by Apple. RedGiant lives in the
menu bar; local models run on the GPU through Metal. Apple silicon, macOS 13 or newer.

### Linux and servers

```sh
curl -fsSL https://raw.githubusercontent.com/Frostmoore/redgiant2/main/install.sh | bash
```

It runs RedGiant in Docker (Docker Engine 26+; the script offers to install it), everything in
`~/redgiant`, and opens the browser already signed in.

### First run

The setup in the browser asks one thing at a time: models (a subscription, API keys, your own server or
a local model from Hugging Face), names, Telegram and the other chats, safety and costs.

Options, updates, backups, uninstalling and every environment variable are in
[docs/INSTALL.md](docs/INSTALL.md).

## How it works

```
Telegram, WhatsApp… → Demi-God → God → projects → orchestrator → agents → sub-agents
                                  └── Chat, personal assistants
```

_Demi-God_ is God's spokesperson on the chats: it relays to God and nothing else. _God_ is the platform
agent: it creates projects, configures RedGiant and answers to you. Each project has an _orchestrator_
that creates persistent _agents_ (each in its own git worktree) and short-lived _sub-agents_, delegates
tasks to them and merges their work. Each project also has a read-only _Inspector_ you can ask about it
without touching anything. Beside the hierarchy there is the _Chat_, the everyday assistant with every
tool, and personal assistants with the services you give them. Agents only see what their scope allows,
and requests they cannot decide go up the tree until they reach you.

Under the hood: a TypeScript server (HTTP + WebSocket, OpenAPI at `/api/openapi.json`), Postgres for the
event log, the board and the state (its own, embedded, on Windows and the Mac), and a supervisor that
rebuilds and rolls back. There is also a `redgiant` command-line client.

## How well it works

RedGiant ships an evaluation suite: coding tasks with hidden verifiers, each run by a real project
orchestrator. On the current eight tasks, Claude Sonnet 5.5 and Claude Opus 5.5 both pass **8/8**
(costs, tokens and times in [docs/evals.md](docs/evals.md)). Run it on your own models with
`pnpm --filter @redgiant/evals start -- --models provider/model`.

Against other harnesses, with the same model (Claude Haiku 5.5) on the same tasks:

| Harness     | SWE-bench Verified (50) | Aider Polyglot (225) | Cost      |
| ----------- | ----------------------- | -------------------- | --------- |
| RedGiant    | 42/50                   | 220/225              | **$1.69** |
| OpenHands   | 44/50                   | 224/225              | $1.85     |
| Claude Code | 42/50                   | 210/225              | $3.13     |

RedGiant costs the least. One run, with caveats that matter (a network outage, three Windows fixes
that came after it): [docs/benchmark.md](docs/benchmark.md).

## Documentation

- [docs/INSTALL.md](docs/INSTALL.md): installing, options, environment variables, updates, backups,
  running from source, the packages
- [docs/evals.md](docs/evals.md): evaluation results and tasks
- [docs/benchmark.md](docs/benchmark.md): RedGiant, Claude Code and OpenHands on SWE-bench Verified and
  Aider Polyglot
- [recipes/README.md](recipes/README.md): writing automations

## Contributing

Issues and pull requests are welcome. Requirements: Node.js 22+ and pnpm (`corepack enable`).

```sh
pnpm install
pnpm build    # tsc -b, then the web page
pnpm test     # vitest; tests never call a real model
pnpm lint     # Biome (pnpm format to fix formatting)

# optional, spends real tokens:
ANTHROPIC_API_KEY=... pnpm test:live
REDGIANT_LIVE_OPENAI_BASE_URL=http://localhost:8080/v1 pnpm test:live

# optional, needs Docker:
docker build -t redgiant/sandbox:dev -f docker/sandbox.Dockerfile docker
REDGIANT_DOCKER_TESTS=1 pnpm test:docker

# web UI against a demo server (scripted model, in-process Postgres):
pnpm build && node packages/web/scripts/demo-server.mjs 7650   # then open http://localhost:7650
```

The repository is a pnpm monorepo with its packages in `packages/`; what each one does is in
[docs/INSTALL.md](docs/INSTALL.md#packages). Notes for coding agents (and humans) are in
[CLAUDE.md](CLAUDE.md).

## License

[MIT](LICENSE). Use it, change it, sell it.

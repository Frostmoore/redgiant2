# Installing RedGiant

On Windows and on the Mac RedGiant is a native app with its own database: download it, run it, done
(see [macOS](#macos) and [Windows](#windows)). On Linux and on servers it runs in Docker: a Postgres
database, the RedGiant server (with its supervisor, which rolls back broken updates by itself), an
egress proxy that is the sandboxes' only way out, and one sandbox container per workspace, created on
demand. Everything lives in Docker volumes; nothing is written to your system outside the installation
folder.

**You need (Docker):** Docker Engine 26 or newer with Compose v2, 4 GB of RAM, 10 GB of disk (more for
local models). A subscription, an API key for a cloud model, or a GGUF model for the local engine.

## Every way to install RedGiant

Pick the line that matches what you have. Every download is on the
[latest release](https://github.com/Frostmoore/redgiant2/releases/latest); the RedGiant OS files are
listed in `SHA256SUMS-os`, signed with RedGiant's update key.

| You have                                             | Use                                                                  | How                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| A Windows PC                                         | `RedGiant-Setup.exe` (or `winget install Frostmoore.RedGiant`)       | [Windows](#windows)                                              |
| A Mac (Apple silicon)                                | `RedGiant-mac-arm64.dmg` (or Homebrew)                               | [macOS](#macos)                                                  |
| A Linux machine or a server with Docker              | `install.sh` (Docker Compose)                                        | [Linux](#linux)                                                  |
| A spare PC or mini PC to dedicate to RedGiant        | RedGiant OS on a USB stick: `redgiant-os-<version>-x86_64.iso`       | [From a USB stick](INSTALL-OS.md#on-a-pc-from-a-usb-stick)       |
| Proxmox VE                                           | the helper script (a VM or a container), or the qcow2 / LXC template | [Proxmox](INSTALL-OS.md#on-proxmox)                              |
| Hyper-V (Windows Pro, Server)                        | `redgiant-os-<version>-x86_64.vhdx.zip`                              | [Hyper-V](INSTALL-OS.md#on-hyper-v)                              |
| VirtualBox, VMware Workstation, Fusion, ESXi         | `redgiant-os-<version>-x86_64.ova`                                   | [VirtualBox and VMware](INSTALL-OS.md#on-virtualbox-and-vmware)  |
| KVM/libvirt, UTM, OpenStack and other clouds         | `redgiant-os-<version>-<x86_64 or arm64>.qcow2` (or `.raw.zst`)      | [KVM, UTM, clouds](INSTALL-OS.md#on-kvm--libvirt-utm-and-clouds) |
| LXC or Incus                                         | `redgiant-os-<version>-x86_64-lxc.tar.zst`                           | [A container](INSTALL-OS.md#by-hand-a-container)                 |
| A Raspberry Pi 4, 400 or CM4                         | `redgiant-os-<version>-arm64-raspi.img.xz`                           | [Raspberry Pi](INSTALL-OS.md#on-a-raspberry-pi)                  |
| A Raspberry Pi 5 (or another arm64 board with Linux) | Docker on its own Linux (Raspberry Pi OS 64-bit)                     | [Linux](#linux)                                                  |

**RedGiant OS** ([INSTALL-OS.md](INSTALL-OS.md)) is a small Debian 13 system that only runs
RedGiant: nothing to set up, it updates itself, its screen shows the address. The **apps** (Windows,
macOS) and **Docker** (Linux) put RedGiant on a computer you already use for other things.

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

Download `RedGiant-mac-arm64.dmg` from the [latest release](https://github.com/Frostmoore/redgiant2/releases/latest)
(Apple silicon, macOS 13 or newer), open it and drag RedGiant into Applications. It is signed and
notarized by Apple: it opens without warnings. RedGiant lives in the menu bar (next to the clock):
it starts its server, opens the browser already signed in, and offers "Open RedGiant", "Start at
login", "Uninstall RedGiant…" (keeping or deleting the data) and "Quit". Everything it keeps is in
`~/Library/Application Support/RedGiant`, its logs in `~/Library/Logs/RedGiant`. The local engine
uses the GPU through Metal (llama.cpp's macOS build, downloaded the first time) and voice messages
are transcribed on the Mac (whisper with Metal).

With [Homebrew](https://brew.sh), from RedGiant's tap:

```sh
brew install --cask frostmoore/redgiant/redgiant
```

`brew upgrade` brings new versions; `brew uninstall --cask redgiant` removes the app and keeps the
data, `--zap` deletes `~/Library/Application Support/RedGiant` and the logs too.

The `redgiant` command line is inside the app, in `RedGiant.app/Contents/Resources/bin/redgiant`
(Homebrew links it by itself). With the app from the disk image, to type just `redgiant` in the
Terminal, link it once (nothing is installed outside the app unless you do this):

```sh
sudo mkdir -p /usr/local/bin && sudo ln -s /Applications/RedGiant.app/Contents/Resources/bin/redgiant /usr/local/bin/redgiant
```

It finds the RedGiant running for you by itself (see [The command line](#the-command-line)).

From source instead, with Node.js 22+ and git:

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

With winget (once RedGiant is in the winget catalog):

```powershell
winget install Frostmoore.RedGiant
```

It installs for your user only, silently, with the setup's usual choices; `winget upgrade
Frostmoore.RedGiant` updates it and keeps the data.

The `redgiant` command line comes with it, in `%LOCALAPPDATA%\RedGiant\bin\redgiant.cmd`. The setup
offers "Add the «redgiant» command to the terminal" (off unless you tick it): it adds that folder to
your user's PATH only, and uninstalling takes it out again. Nothing else outside RedGiant's folder
changes.

Alternatively, in containers with Docker Desktop (which needs WSL 2), in PowerShell:

```powershell
irm https://raw.githubusercontent.com/Frostmoore/redgiant2/main/install.ps1 | iex
```

or download the repository and double-click `install.cmd`. The installer checks WSL 2 and Docker
Desktop and offers to install them (WSL 2 needs administrator rights and a restart; Docker Desktop
comes from `winget`). It always asks before installing anything. RedGiant goes in
`%USERPROFILE%\redgiant`.

## The command line

`redgiant` talks to a running RedGiant: projects, agents, a live chat with an agent, approvals.

```sh
redgiant projects                                  # list
redgiant projects create "Shop"                    # a new folder under RedGiant's workspaces
redgiant projects create "Shop" --path ~/code/shop # a project on a folder that already exists
redgiant chat <agentId>                            # talk to an agent
redgiant help
```

With the Windows or Mac app it needs nothing: the app keeps its token (`token.txt`) and the server
its address (`address.txt`) in the data folder, and the command reads them. Elsewhere, or for
another RedGiant, set `REDGIANT_URL` (default `http://127.0.0.1:7600`) and `REDGIANT_TOKEN`, or
`REDGIANT_DATA_DIR` to the data folder. The same works over HTTP: `POST /api/projects` with
`{"name": "Shop", "path": "/home/me/code/shop"}` adopts the folder as it is (no repository is
created or rewired). The folder must exist and may not be a whole drive, the home folder itself, a
system folder, RedGiant's own data, or overlap another project's folder; in the Docker image it must
be inside the data volume's `workspaces`, the only place the sandboxes can see.

**Steps in one turn.** In a conversation with the person (a turn started by their message) an agent
has no step limit, as in Claude Code. A turn nobody started (automations, delegated tasks, reminders,
webhooks) makes at most 200 model calls, then stops and says where it got to; the page then offers
«Continue». Settings > Commands > Steps in one turn sets one number for every turn (or "No limit";
the budgets still hold); `REDGIANT_MAX_TURNS` sets the server's default for unattended turns. The WebSocket's `session.state` message with
`state: "idle"` carries `stopReason` (`end_turn`, `max_turns`, `budget`, `aborted`, `error`…).

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

## Programs downloaded when needed

Some file conversions need a free program. RedGiant never bundles them: each one is downloaded the
first time a conversion asks for it, with a progress bar, and only unpacked into RedGiant's data folder
(`tools/`), never installed system-wide. If the program is already on the computer, RedGiant uses it.
The Docker image for Linux carries the system libraries they need.

| Program                     | Licence                        | Download size                                                      | Used for                                                       |
| --------------------------- | ------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| LibreOffice                 | MPL-2.0                        | Linux AppImage ~290 MB; Windows MSI ~360-380 MB; macOS DMG ~300 MB | Office files laid out in the Canvas, conversions into ODF, PDF |
| Scribus 1.6                 | GPL-2.0-or-later               | Linux AppImage ~135 MB; Windows ~125 MB; macOS DMG ~180-190 MB     | IDML (InDesign) into Scribus `.sla` with its layout, and PDF   |
| 7-Zip 25 (Windows only)     | LGPL-2.1 (+ BSD, unRAR clause) | ~2 MB                                                              | Unpacking Scribus's Windows installer without installing it    |
| Blender 5.2 (Intel Mac 4.5) | GPL-2.0-or-later               | Linux ~385 MB; Windows ~275-405 MB; macOS DMG ~340-350 MB          | 3D formats into glTF, the agents' `blender` tool, renders      |
| ffmpeg (static build)       | GPL-3.0                        | ~30-80 MB                                                          | Voice messages, video and audio the browser cannot play        |

Unpacked, LibreOffice takes about 1 GB and Blender about 1.2 GB. On a Linux server without a display,
Scribus runs under Xvfb (`sudo apt install xvfb xauth fonts-dejavu-core`, already in the Docker image).

**Ghostscript** (AGPL-3.0, 20-65 MB) is never downloaded by RedGiant: install it yourself if you want EPS
files converted (`winget install ArtifexSoftware.GhostScript` on Windows, `brew install ghostscript` on
the Mac, `sudo apt install ghostscript` on Linux; the Docker image has it). Without it an EPS does not
become a PDF; LibreOffice can still make an SVG of its first page.

### pgvector (the knowledge's vectors)

The knowledge (search by meaning in your files) keeps its vectors in RedGiant's own Postgres with
**pgvector** 0.8.7 (PostgreSQL licence, about 120-300 KB). It comes inside the Windows installer and
the Mac app, and inside RedGiant's Postgres image for Docker
(`ghcr.io/frostmoore/redgiant2-postgres:17-pgvector0.8.7`: `postgres:17-alpine` with pgvector, so an
existing database volume opens as it is). Running from source with `DATABASE_URL=embedded`, it is
downloaded the first time it is needed (about 120 KB, checked against its sha256) into `tools/pgvector`;
`REDGIANT_PGVECTOR_DIR` points to a folder of your own (`lib/` and `share/extension/`). It is never
written into Postgres' own installation: the embedded Postgres loads it through `redgiant.conf` in its
data folder. With your own Postgres (`DATABASE_URL=postgres://...`), install pgvector there
(`CREATE EXTENSION vector` must work for RedGiant's user).

## Updating

Run the installer again: it keeps your `.env`, downloads the new images and restarts. The new
version's code is merged with any change God made to RedGiant, built, and checked by the
supervisor; if it does not come up, the previous version keeps running.

## The keychain in your browser

The keychain's extension fills sign-in forms in Opera, Chrome, Edge, Brave and Firefox, also outside
RedGiant, and saves the passwords you type there into the keychain. Every RedGiant serves it
(`/redgiant-keychain-chromium.zip`, `/redgiant-keychain-firefox.zip`) and every release carries both zips.

1. In RedGiant open Settings > Keychain > «Link a browser» and download the extension.
2. Load it:
   - **Opera**: unzip it into a folder you keep, open `opera://extensions`, switch on «Developer mode» (top
     right), press «Load unpacked» and choose the folder (or drag the zip onto the page).
   - **Chrome, Edge, Brave**: the same from `chrome://extensions`, `edge://extensions`, `brave://extensions`.
   - **Firefox**: `about:debugging#/runtime/this-firefox` > «Load Temporary Add-on…» > the Firefox zip. Firefox
     keeps it until it closes; to keep it for good it must be signed by Mozilla (see below).
3. In the same window press «Make a code»; in the extension (the key in the browser's bar) write RedGiant's
   address and the code. The code works ten minutes for one browser. Away from home the address must be
   `https://` (remote access): `http://` is accepted only at home (this computer, the local network).

What it may do, and what not:

- The browser gets a device token of its own that opens only the extension's routes (`/api/browser-ext/*`),
  never the rest of RedGiant; the server keeps only its hash. Settings > Keychain lists the linked browsers;
  «Unlink» stops a token at once.
- The token stays in the browser's session memory; with «Stay linked» a copy is kept encrypted (AES-GCM, under
  a non-extractable key of the browser). Passwords are never stored in the extension.
- A credential is offered only on its own site: its hosts and the host of its address, compared in ASCII
  (punycode), exactly (`*.example.com` for the subdomains, never over a public suffix), on the same port, and on
  https unless the credential itself is for http (a home router). Look-alike names, other subdomains, other ports
  and http pages get nothing; the server checks again on every request.
- The value reaches the extension only when you click «Fill» or «Copy» (the clipboard is emptied after 30 s).
  Every fill, copy, save and refusal is in the keychain's «Who used them», with the browser's name.
- After a form with a new or changed password the page shows «Save in the keychain?» or «Update?»: nothing is
  saved until you press it. Saved credentials are for you only (agents need your permission in the keychain).

The Chrome Web Store (later) needs: a developer account (one-off fee), the zip with a privacy policy (the
extension sends page addresses and the passwords you save only to your own RedGiant), screenshots, and the
reasons for each permission (`storage`, `alarms`, `scripting`, `clipboardWrite`, `offscreen`, and access to every
site because RedGiant's address and the sign-in pages can be any). Firefox's add-ons site signs the Firefox zip
for a permanent install (it can stay unlisted). Opera's add-ons site and Edge's accept the same Chromium zip.

## Backups

Settings > Backup makes one file with every project, agent and conversation, to import into another
RedGiant (new or already in use). Keys and sign-ins stay out of it, except the keychain when you choose
to include it, sealed with a passphrase of yours.

With Docker, the data is in two volumes: `redgiant_redgiant-db` (database: agents, the event log, the board…) and
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

## Homebrew and winget (for maintainers)

Each release makes the files for both stores from its own installers (`packaging/stores/stores.mjs`,
job `stores` in `release.yml`): `redgiant.rb` (the cask) and `RedGiant-winget-<version>.zip` (the
three winget manifest files, schema 1.12.0) are attached to the release.

- **Homebrew tap.** Create the public repository `Frostmoore/homebrew-redgiant` (empty, with a
  `Casks/` folder) and a fine-grained token that can push to it only, saved as the repository secret
  `HOMEBREW_TAP_TOKEN`: from then on every release updates `Casks/redgiant.rb` there. Until then the
  cask is attached to the release and can be copied in by hand. (The official homebrew-cask catalog
  wants a well-known project first; the tap needs no approval.)
- **winget, first time.** It needs a pull request to
  [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs), made by the person: fork it, copy
  the zip's `manifests/f/Frostmoore/RedGiant/<version>` folder into the fork, check it on Windows
  with `winget validate --manifest <folder>` and `winget install --manifest <folder>`, then open the
  pull request ("New package: Frostmoore.RedGiant version <version>"). A moderator reviews it; the
  installer is not code-signed yet, so the automatic scan may ask for a look by hand.
- **winget, later.** Once the package is in the catalog, set the repository variable
  `WINGET_AUTO_SUBMIT` to `true` and the secret `WINGET_TOKEN` (a classic token with `public_repo`):
  the `winget-submit` job then opens each release's pull request with `wingetcreate`. Without the
  variable it never runs.

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
| `REDGIANT_PGVECTOR_DIR`                                             | pgvector for the embedded Postgres (`lib/`, `share/extension/`); otherwise the one next to the server, then `tools/pgvector`                |
| `REDGIANT_WEB_DIR`                                                  | Built web UI to serve at `/` (default `packages/web/dist`)                                                                                  |
| `REDGIANT_TELEGRAM_TOKEN` / `REDGIANT_TELEGRAM_TOKEN_FILE`          | Bot token from BotFather: enables Demi-God on Telegram (polling by default)                                                                 |
| `REDGIANT_TELEGRAM_WEBHOOK_SECRET`                                  | Webhook mode instead of polling: Telegram must send this secret to `/api/telegram/webhook`                                                  |
| `REDGIANT_SOURCE_DIR`, `REDGIANT_STATE_DIR`                         | RedGiant's own source (a git checkout) and the supervisor's state: enables God's code changes; promotion needs `redgiant-supervisor`        |
| `REDGIANT_BUILD_COMMAND`                                            | Supervisor: how to build the source (default `pnpm install --frozen-lockfile && pnpm build`)                                                |
| `REDGIANT_METAL`                                                    | `1`: God works on the real system even with Docker sandboxes; every change it makes asks you                                                |
| `REDGIANT_VAULT_DIR`                                                | The keychain's folder (default `keychain` in the data folder); it refuses to open inside a git repository                                   |
| `REDGIANT_VAULT_KEY`                                                | The keychain's master key (base64 of 32 bytes) for servers; otherwise Windows, the Mac's Keychain or a 0600 file beside it keep it          |
| `REDGIANT_EGRESS_ROUTES`                                            | The file where the server writes the egress proxy's credential routes (GitHub, Gitea, keychain credentials bound to tools)                  |

```sh
pnpm build
DATABASE_URL=postgres://... REDGIANT_TOKEN=... ANTHROPIC_API_KEY=... node packages/server/dist/main.js
# Supervised, so God can change RedGiant itself (broken versions roll back by themselves):
REDGIANT_SOURCE_DIR=$PWD DATABASE_URL=... REDGIANT_TOKEN=... node packages/supervisor/dist/main.js
REDGIANT_TOKEN=... node packages/cli/dist/main.js help
```

## Packages

The repository is a pnpm monorepo; packages live in `packages/`.

| Package                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@redgiant/protocol`          | Shared event and message types (zod schemas)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `@redgiant/providers`         | Model providers (Anthropic, any OpenAI-compatible server, a scripted fake), per-message metrics, effort mapping, fallback chains, pricing and budgets                                                                                                                                                                                                                                                                                                                                                         |
| `@redgiant/events`            | Append-only, hash-chained event log on Postgres: tamper detection, payload erasure that keeps the chain valid, secret redaction, JSONL export                                                                                                                                                                                                                                                                                                                                                                 |
| `@redgiant/agent`             | The agent loop: parallel tool calls, hooks, permission check, compaction, sessions rebuilt from the log, record/replay, repair of malformed tool arguments                                                                                                                                                                                                                                                                                                                                                    |
| `@redgiant/tools`             | Base tools every agent gets: read/write/edit files (whitespace-tolerant edits), glob, grep, bash, fetch, web search (SearXNG, Brave); compact descriptions for small models; workspace confinement                                                                                                                                                                                                                                                                                                            |
| `@redgiant/sandbox`           | One container per workspace on an internal network (no capabilities, CPU/RAM/PID limits, optional gVisor), an egress proxy with a domain allow list, SSRF protection and credential injection, git worktrees per agent, and an opt-in host ("metal") mode                                                                                                                                                                                                                                                     |
| `@redgiant/engine-local`      | Local llama.cpp engines shared by every agent: slots scheduled by priority, and a KV cache saved on the SSD (inspired by DwarfStar 4): restored by prefix, even across sessions and engine restarts, evicted by hits and recency within a per-project budget                                                                                                                                                                                                                                                  |
| `@redgiant/board`             | The agents' forum: threads per project and a global one, typed posts (task, result, question, decision, blocker, note) with mentions and task links, full-text search, duplicate detection, status that follows tasks, summaries and digests by a configurable model                                                                                                                                                                                                                                          |
| `@redgiant/extensions`        | MCP servers as agent tools (stdio and HTTP), skills loaded on demand (SKILL.md), custom tools that run in the sandbox, and a builder: agents propose tools and skills with tests, the builder runs them in a throwaway sandbox, the user approves                                                                                                                                                                                                                                                             |
| `@redgiant/automations`       | YAML recipes run by an agent: a schedule (with time zones), a webhook, an email, a chat message, files changing, another automation or a task ending; conditions, approval, budget, retries, no overlapping runs, missed runs after a restart, history, results on any chat or by email (examples in `recipes/`)                                                                                                                                                                                              |
| `@redgiant/gateway`           | WhatsApp, Discord, Slack and Signal: one bridge for the chats beside Telegram, accounts linked with pairing codes, messages that can start automations                                                                                                                                                                                                                                                                                                                                                        |
| `@redgiant/telegram`          | Demi-God on Telegram: polling or webhook (checked with Telegram's secret header), accounts linked with one-time pairing codes, Demi-God relays to God only, approvals with inline buttons                                                                                                                                                                                                                                                                                                                     |
| `@redgiant/subscriptions`     | Flat subscriptions as providers: Claude through Anthropic's Claude Agent SDK, ChatGPT through OpenAI's Codex app server, with the plan's limits                                                                                                                                                                                                                                                                                                                                                               |
| `@redgiant/supervisor`        | `redgiant-supervisor`: runs the server, rebuilds it when God promotes a change to RedGiant's own code, and rolls back to the last good version by itself when the new one fails to build, to come up healthy or to stay up                                                                                                                                                                                                                                                                                    |
| `@redgiant/hierarchy`         | The agent tree (God, Demi-God, orchestrators, agents, sub-agents, inspectors) with scope rules, permission modes and user rules, a configurable danger classifier, approvals that escalate up the tree to the human, and persistent budgets                                                                                                                                                                                                                                                                   |
| `@redgiant/server`            | The keychain (AES-256, credentials used by name through `use_credential` or the egress proxy), the shared memory, magic automations, the setup, local engines; HTTP API with OpenAPI (`/api/openapi.json`), WebSocket live channel (`/ws`), sessions that outlive clients, projects, approvals queue, token auth bound to owners; orchestration tools (create, delegate, merge, stop agents; ephemeral sub-agents), tasks that close only with a passing verifier, approvals decided by parent agents' models |
| `@redgiant/evals`             | Evaluation suite: coding tasks with hidden verifiers (each checked to reject the starting files and accept a right answer), run by a real project orchestrator per model; Markdown report with pass rate, tokens, cost and time                                                                                                                                                                                                                                                                               |
| `@redgiant/cli`               | `redgiant` command: projects, agents, live chat with an agent (with the per-message metrics line), approvals, log verification                                                                                                                                                                                                                                                                                                                                                                                |
| `@redgiant/web`               | Web UI (Preact): tabs and up to three side-by-side panes, live chat with the per-message metrics bar, terminal (xterm.js) and file explorer with editor (CodeMirror) per project and for the platform, hierarchy, approvals, budgets; Italian and English; phone layout                                                                                                                                                                                                                                       |
| `@redgiant/browser-extension` | The keychain in Opera, Chrome, Edge, Brave and Firefox (Manifest V3): sign-in forms filled only on their own site, new passwords saved, a generator; linked to RedGiant with a code                                                                                                                                                                                                                                                                                                                           |

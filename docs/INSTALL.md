# Installing RedGiant

RedGiant runs in Docker: a Postgres database, the RedGiant server (with its supervisor, which rolls
back broken updates by itself), an egress proxy that is the sandboxes' only way out, and one sandbox
container per workspace, created on demand. Everything lives in Docker volumes; nothing is written
to your system outside the installation folder.

**You need:** Docker Engine 26 or newer with Compose v2 (Docker Desktop on Windows and macOS),
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

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) or
[OrbStack](https://orbstack.dev) (`brew install --cask orbstack`) and start it, then:

```sh
curl -fsSL https://raw.githubusercontent.com/Frostmoore/redgiant2/main/install.sh | bash
```

Apple silicon is supported (the images are built for arm64 too). The local engine runs on the CPU
inside Docker; Metal acceleration needs llama.cpp running natively (point `REDGIANT_LLAMACPP_URL`
at it).

## Windows

In PowerShell:

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
  NVIDIA Container Toolkit).
- **Web search**: `docker compose --profile search up -d` and `REDGIANT_SEARXNG_URL=http://searxng:8080`.
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

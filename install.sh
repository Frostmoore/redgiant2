#!/usr/bin/env bash
# RedGiant installer for Linux and macOS.
#   curl -fsSL https://raw.githubusercontent.com/Frostmoore/redgiant2/main/install.sh | bash
# Environment: REDGIANT_HOME (default ~/redgiant), REDGIANT_REF (git ref of the files, default main),
# REDGIANT_IMAGE / REDGIANT_SANDBOX_IMAGE (images to use), REDGIANT_PORT (default 7600),
# REDGIANT_YES=1 (answer yes, ask nothing), REDGIANT_NO_PULL=1 (use local images), REDGIANT_NO_BROWSER=1.
set -euo pipefail

HOME_DIR=${REDGIANT_HOME:-$HOME/redgiant}
REF=${REDGIANT_REF:-main}
RAW="https://raw.githubusercontent.com/Frostmoore/redgiant2/$REF"
PORT=${REDGIANT_PORT:-7600}
FILES=(compose.yaml docker/egress.json docker/searxng/settings.yml .env.example)

say() { printf '\033[1;31m▶\033[0m %s\n' "$*"; }
die() {
  printf '\033[1;31m✗\033[0m %s\n' "$*" >&2
  exit 1
}
# Questions read the terminal even when the script comes through a pipe.
ask() {
  local prompt=$1 default=${2:-n} answer
  if [ "${REDGIANT_YES:-}" = 1 ]; then return 0; fi
  if [ ! -r /dev/tty ]; then [ "$default" = y ]; return; fi
  read -r -p "$prompt [$([ "$default" = y ] && echo Y/n || echo y/N)] " answer </dev/tty || answer=""
  answer=${answer:-$default}
  [[ $answer =~ ^[YySs] ]]
}
secret() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "${1:-40}"; }

# 1. Docker -------------------------------------------------------------------------------------
os=$(uname -s)
if ! command -v docker >/dev/null 2>&1; then
  if [ "$os" = Linux ]; then
    say "Docker is not installed."
    ask "Install it now with Docker's official script (get.docker.com, needs sudo)?" ||
      die "RedGiant needs Docker: https://docs.docker.com/engine/install/"
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER" 2>/dev/null || true
  else
    die "RedGiant needs Docker. On macOS install Docker Desktop (https://www.docker.com/products/docker-desktop/) or OrbStack (brew install --cask orbstack), start it, then run this again."
  fi
fi
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  if [ "$os" = Linux ] && sudo -n docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
  elif [ "$os" = Linux ] && command -v sudo >/dev/null && sudo docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
  else
    die "Docker is installed but not running (or you may not use it). Start Docker and run this again."
  fi
fi
"${DOCKER[@]}" compose version >/dev/null 2>&1 ||
  die "Docker Compose v2 is missing: https://docs.docker.com/compose/install/"
api=$("${DOCKER[@]}" version --format '{{.Server.APIVersion}}')
# Sandboxes mount their folders with volume subpaths (Docker Engine 26 / API 1.45).
awk -v v="$api" 'BEGIN { split(v, a, "."); exit !(a[1] > 1 || (a[1] == 1 && a[2] >= 45)) }' ||
  die "Docker is too old (API $api): RedGiant needs Docker Engine 26 or newer."

# 2. Files --------------------------------------------------------------------------------------
say "Installing RedGiant in $HOME_DIR"
mkdir -p "$HOME_DIR/docker/searxng"
here=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")
for f in "${FILES[@]}"; do
  if [ -n "$here" ] && [ -f "$here/$f" ] && [ "$here" != "$HOME_DIR" ]; then
    cp "$here/$f" "$HOME_DIR/$f" # run from a checkout of the repository
  else
    curl -fsSL "$RAW/$f" -o "$HOME_DIR/$f" || die "Cannot download $f from $RAW"
  fi
done
cd "$HOME_DIR"

# 3. Settings -----------------------------------------------------------------------------------
if [ ! -f .env ]; then
  umask 077
  cp .env.example .env
  set_env() { # key value: replaces the line or appends it
    if grep -q "^$1=" .env; then
      local tmp
      tmp=$(mktemp)
      awk -v k="$1" -v v="$2" 'BEGIN { FS = OFS = "=" } $1 == k { print k, v; next } { print }' .env >"$tmp"
      mv "$tmp" .env
    else
      echo "$1=$2" >>.env
    fi
  }
  set_env REDGIANT_TOKEN "$(secret 40)"
  set_env POSTGRES_PASSWORD "$(secret 32)"
  set_env REDGIANT_PORT "$PORT"
  [ -n "${REDGIANT_IMAGE:-}" ] && set_env REDGIANT_IMAGE "$REDGIANT_IMAGE"
  [ -n "${REDGIANT_SANDBOX_IMAGE:-}" ] && set_env REDGIANT_SANDBOX_IMAGE "$REDGIANT_SANDBOX_IMAGE"
  chmod 600 .env
  say "Settings written to $HOME_DIR/.env (keep it private: it holds your token)"
else
  say "Keeping the existing settings in $HOME_DIR/.env"
fi
token=$(grep '^REDGIANT_TOKEN=' .env | cut -d= -f2-)
PORT=$(grep '^REDGIANT_PORT=' .env | cut -d= -f2- || echo "$PORT")
PORT=${PORT:-7600}

# 4. Start --------------------------------------------------------------------------------------
if [ "${REDGIANT_NO_PULL:-}" != 1 ]; then
  say "Downloading the images (the first time takes a few minutes)"
  "${DOCKER[@]}" compose pull --quiet redgiant egress postgres
  sandbox=$(grep '^REDGIANT_SANDBOX_IMAGE=' .env | cut -d= -f2- || true)
  "${DOCKER[@]}" pull --quiet "${sandbox:-ghcr.io/frostmoore/redgiant2-sandbox:latest}" >/dev/null
fi
say "Starting RedGiant"
"${DOCKER[@]}" compose up -d

url="http://127.0.0.1:$PORT"
for _ in $(seq 1 120); do
  curl -fsS "$url/api/health" >/dev/null 2>&1 && break
  sleep 3
done
curl -fsS "$url/api/health" >/dev/null 2>&1 ||
  die "RedGiant did not come up. See: cd $HOME_DIR && docker compose logs redgiant"

say "RedGiant is running: $url"
echo "   Your token (also in $HOME_DIR/.env): $token"
echo "   Stop: cd $HOME_DIR && docker compose down    Update: run this installer again"
if [ "${REDGIANT_NO_BROWSER:-}" != 1 ]; then
  # The token travels after '#': it never reaches any server, only the page.
  open_url="$url/#token=$token"
  if command -v open >/dev/null 2>&1 && [ "$os" = Darwin ]; then
    open "$open_url"
  elif command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    xdg-open "$open_url" >/dev/null 2>&1 &
  fi
fi

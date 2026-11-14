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
FILES=(compose.yaml docker/egress.json docker/searxng/settings.yml docker/postgres.Dockerfile .env.example)

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
set_env() { # key value: replaces the line or appends it
  if grep -q "^$1=" .env; then
    local tmp
    tmp=$(mktemp)
    awk -v k="$1" -v v="$2" 'BEGIN { FS = OFS = "=" } $1 == k { print k, v; next } { print }' .env >"$tmp"
    cat "$tmp" >.env
    rm -f "$tmp"
  else
    echo "$1=$2" >>.env
  fi
}
if [ ! -f .env ]; then
  umask 077
  cp .env.example .env
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
# The GPUs, for the local engine (G24.3): RedGiant runs in a container and cannot see them.
# "name:GB;…" (0 GB: memory unknown or shared), and how containers reach a GPU that is not
# NVIDIA's (Vulkan): /dev/dri on Linux. (In Windows' WSL there is no such way yet.)
gpu_names() {
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null |
      awk -F', *' '{ printf "%s:%.1f;", $1, $2 / 1024 }'
  fi
  for card in /sys/class/drm/card[0-9]; do
    [ -r "$card/device/vendor" ] || continue
    vendor=$(cat "$card/device/vendor")
    [ "$vendor" = 0x10de ] && continue # NVIDIA: nvidia-smi above
    slot=$(basename "$(readlink -f "$card/device")")
    name=$(lspci -s "$slot" 2>/dev/null | sed 's/^[^:]*: *//; s/^[^:]*: *//' || true)
    case "$vendor" in 0x1002) name=${name:-AMD Radeon GPU} ;; 0x8086) name=${name:-Intel GPU} ;; *) name=${name:-GPU} ;; esac
    vram=0
    [ -r "$card/device/mem_info_vram_total" ] && vram=$(awk '{ printf "%.1f", $1 / 1073741824 }' "$card/device/mem_info_vram_total")
    printf "%s:%s;" "${name//[:;]/ }" "$vram"
  done
}
# The disk Docker keeps its volumes on (the models among them): solid state or not, its bus,
# free and total GB ("/|ssd|nvme|120.0|500.0"), for models streamed from an SSD (2026-11-03).
disk_info() {
  local dir src dev rota tran free total
  dir=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
  [ -d "$dir" ] || dir=/
  src=$(df --output=source "$dir" 2>/dev/null | tail -1)
  dev=$(lsblk -no PKNAME "$src" 2>/dev/null | head -1)
  [ -n "$dev" ] || dev=$(basename "$src")
  rota=$(cat "/sys/block/$dev/queue/rotational" 2>/dev/null || echo "")
  tran=$(lsblk -dno TRAN "/dev/$dev" 2>/dev/null | head -1)
  case "$rota" in 0) rota=ssd ;; 1) rota=hdd ;; *) rota="?" ;; esac
  case "$dev" in nvme*) rota=ssd; tran=${tran:-nvme} ;; esac
  free=$(df -BG --output=avail "$dir" 2>/dev/null | tail -1 | tr -dc 0-9)
  total=$(df -BG --output=size "$dir" 2>/dev/null | tail -1 | tr -dc 0-9)
  printf "/|%s|%s|%s.0|%s.0" "$rota" "${tran:-other}" "${free:-0}" "${total:-0}"
}
if [ "$os" = Linux ] && [ "${REDGIANT_SKIP_GPU:-}" != 1 ]; then
  set_env REDGIANT_HOST_DISKS "$(disk_info)"
  set_env REDGIANT_HOST_GPUS "$(gpu_names | sed 's/;$//')"
  if [ ! -e /dev/dxg ] && ls /dev/dri/renderD* >/dev/null 2>&1; then
    set_env REDGIANT_ENGINE_GPU dri
  else
    set_env REDGIANT_ENGINE_GPU ""
  fi
fi
token=$(grep '^REDGIANT_TOKEN=' .env | cut -d= -f2-)
PORT=$(grep '^REDGIANT_PORT=' .env | cut -d= -f2- || echo "$PORT")
PORT=${PORT:-7600}

# 4. Download ------------------------------------------------------------------------------------
# Every download shows a bar with the amount, the speed and the time left. The sizes come from the
# registries, the bytes from Docker's API (jq and the Docker socket); without them, Docker's own
# per-layer progress.
arch() { case $(uname -m) in aarch64 | arm64) echo arm64 ;; *) echo amd64 ;; esac; }
split_ref() { # image -> "registry repository tag"
  local ref=$1 reg repo tag
  tag=${ref##*:}
  ref=${ref%:*}
  case "$ref" in
    *.*/*) reg=${ref%%/*} repo=${ref#*/} ;;
    */*) reg=registry-1.docker.io repo=$ref ;;
    *) reg=registry-1.docker.io repo=library/$ref ;;
  esac
  echo "$reg $repo $tag"
}
layer_sizes() { # image -> "<12-char layer id> <bytes>" per layer
  local reg repo tag token accept index digest
  read -r reg repo tag < <(split_ref "$1")
  if [ "$reg" = registry-1.docker.io ]; then
    token=$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$repo:pull" | jq -r .token)
  else
    token=$(curl -fsS "https://$reg/token?scope=repository:$repo:pull" | jq -r .token)
  fi
  accept="application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json"
  index=$(curl -fsS -H "Authorization: Bearer $token" -H "Accept: $accept" "https://$reg/v2/$repo/manifests/$tag") || return 1
  digest=$(echo "$index" | jq -r --arg a "$(arch)" '[.manifests[]? | select(.platform.os=="linux" and .platform.architecture==$a) | .digest][0] // empty')
  if [ -n "$digest" ]; then
    index=$(curl -fsS -H "Authorization: Bearer $token" -H "Accept: $accept" "https://$reg/v2/$repo/manifests/$digest") || return 1
  fi
  echo "$index" | jq -r '.layers[] | "\(.digest[7:19]) \(.size)"'
}
mb() { awk -v b="$1" 'BEGIN { printf "%.0f MB", b / 1048576 }'; }
bar() { # done total started-at: one line, redrawn in a terminal
  local done=$1 total=$2 now pct width=24 full speed left line
  now=$(date +%s)
  pct=$((done * 100 / total))
  full=$((pct * width / 100))
  speed=$(((done - SKIPPED) / (now - $3 > 0 ? now - $3 : 1)))
  line=$(printf '[%s%s] %3d%%  %s of %s' "$(printf '%*s' "$full" '' | tr ' ' '#')" \
    "$(printf '%*s' $((width - full)) '' | tr ' ' '-')" "$pct" "$(mb "$done")" "$(mb "$total")")
  if [ "$speed" -gt 0 ] && [ "$done" -lt "$total" ]; then
    left=$(((total - done) / speed))
    line+=$(printf '  ·  %s/s  ·  %d:%02d left' "$(mb "$speed")" $((left / 60)) $((left % 60)))
  fi
  [ "$done" -ge "$total" ] && [ "${4:-}" != end ] && line+="  ·  unpacking"
  if [ -t 1 ]; then printf '\r\033[K   %s' "$line"; else echo "   $line"; fi
}
pull_images() {
  local sock prefix=() img id bytes total=0 status current err now last=0 done_bytes start
  sock=$("${DOCKER[@]}" context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)
  sock=${sock#unix://}
  [ "${DOCKER[0]}" = sudo ] && prefix=(sudo)
  if ! command -v jq >/dev/null 2>&1 || [ -z "$sock" ] || ! "${prefix[@]}" test -S "$sock"; then
    for img in "$@"; do "${DOCKER[@]}" pull "$img" || return 1; done
    return 0
  fi
  declare -A size=() got=()
  for img in "$@"; do
    while read -r id bytes; do
      [ -n "$id" ] && [ -z "${size[$id]:-}" ] || continue
      size[$id]=$bytes
      total=$((total + bytes))
    done < <(layer_sizes "$img" 2>/dev/null)
  done
  start=$(date +%s)
  SKIPPED=0 # layers already here: not part of the speed
  for img in "$@"; do
    while IFS=$'\t' read -r id status current err; do
      [ -z "$err" ] || { echo; die "Download failed: $err"; }
      [ -n "$id" ] || continue
      case "$status" in
        Downloading) got[$id]=$current ;;
        "Already exists") got[$id]=${size[$id]:-0} SKIPPED=$((SKIPPED + ${size[$id]:-0})) ;;
        "Download complete" | "Pull complete" | Extracting | "Verifying Checksum") got[$id]=${size[$id]:-${got[$id]:-0}} ;;
      esac
      now=$(date +%s)
      if [ "$total" -gt 0 ] && [ "$now" != "$last" ] && { [ -t 1 ] || [ $((now - last)) -ge 5 ]; }; then
        last=$now done_bytes=0
        for id in "${!got[@]}"; do done_bytes=$((done_bytes + got[$id])); done
        [ "$done_bytes" -gt "$total" ] && done_bytes=$total
        bar "$done_bytes" "$total" "$start"
      fi
    done < <("${prefix[@]}" curl -sS --unix-socket "$sock" -X POST \
      "http://localhost/images/create?fromImage=${img%:*}&tag=${img##*:}" |
      jq --unbuffered -r '[.id // "", .status // "", ((.progressDetail.current // 0) | tostring), (.error // "")] | @tsv')
    "${DOCKER[@]}" image inspect "$img" >/dev/null 2>&1 || { echo; die "Download failed: $img"; }
  done
  [ "$total" -gt 0 ] && bar "$total" "$total" "$start" end && echo
  return 0
}
compose_image() { grep "^$1=" .env | cut -d= -f2- || true; }

# 5. Start --------------------------------------------------------------------------------------
if [ "${REDGIANT_NO_PULL:-}" != 1 ]; then
  say "Downloading RedGiant (the first time takes a few minutes)"
  image=$(compose_image REDGIANT_IMAGE)
  sandbox=$(compose_image REDGIANT_SANDBOX_IMAGE)
  postgres=$(compose_image REDGIANT_POSTGRES_IMAGE)
  pull_images "${image:-ghcr.io/frostmoore/redgiant2:latest}" \
    "${postgres:-ghcr.io/frostmoore/redgiant2-postgres:17-pgvector0.8.7}" \
    "${sandbox:-ghcr.io/frostmoore/redgiant2-sandbox:latest}"
fi
if [ "${REDGIANT_NO_START:-}" = 1 ]; then
  say "Files updated; RedGiant starts with the new version next time"
  exit 0
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
echo "   Open it and create your access (a password). For apps and the command line: the token in $HOME_DIR/.env"
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

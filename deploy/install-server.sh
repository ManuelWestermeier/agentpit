#!/usr/bin/env bash
# agentpit on a Linux server (Debian / Ubuntu / Jetson, x64 or arm64) – one command:
#
#   curl -fsSL https://raw.githubusercontent.com/ManuelWestermeier/agentpit/main/deploy/install-server.sh | bash
#   … | TUNNEL=on bash        # plus remote access through Cloudflare (https://….trycloudflare.com)
#
# Run as a normal user with sudo rights – or as root (typical VPS). Idempotent: run it again to update or repair.
#   1. system packages: Node.js 22+, ffmpeg, Xvfb (visible browsers without a monitor), PulseAudio
#      (own sound card + microphone per browser identity), fonts, build tools
#   2. agentpit from npm, Chromium + its system libraries
#   3. systemd service "agentpit" (starts at boot, restarts on failure), lingering for the
#      user's audio session
#   4. prints the address and the setup code for the first sign-in
set -euo pipefail

step() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
SUDO=sudo; [[ "$(id -u)" == 0 ]] && SUDO="" # root (VPS): no sudo needed; the browsers then run with --no-sandbox
have apt-get || { echo "Dieses Skript braucht Debian/Ubuntu (apt)." >&2; exit 1; }

USER_NAME="$(id -un)"
USER_ID="$(id -u)"
PORT="${PORT:-4317}"
AGENTPIT_HOME="${AGENTPIT_HOME:-$HOME/.agentpit}"

step "Systempakete"
$SUDO apt-get update -y
$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg git build-essential python3 \
  ffmpeg xvfb pulseaudio pulseaudio-utils fonts-liberation fonts-noto-color-emoji

if ! have node || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  step "Node.js 22 LTS (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
  $SUDO apt-get install -y nodejs
fi
echo "Node $(node -v)"

step "agentpit (npm, global)"
$SUDO npm install -g "${AGENTPIT_PKG:-agentpit@latest}" --no-fund --no-audit   # AGENTPIT_PKG=./agentpit-x.y.z.tgz to try a build
BIN="$(command -v agentpit)"
PKG="$(npm root -g)/agentpit"

step "Chromium + Systembibliotheken"
PW_CLI="$(node -e "const p = require('path'); console.log(p.join(p.dirname(require.resolve('playwright-core/package.json', { paths: [p.dirname(require.resolve('@playwright/mcp/package.json', { paths: ['$PKG'] }))] })), 'cli.js'))")"
$SUDO node "$PW_CLI" install-deps chromium
AGENTPIT_HOME="$AGENTPIT_HOME" "$BIN" install-browser

step "Dienst einrichten"
$SUDO loginctl enable-linger "$USER_NAME" # /run/user/<id> stays → PulseAudio works without a login
mkdir -p "$AGENTPIT_HOME"
ENV_FILE="$AGENTPIT_HOME/.env"
touch "$ENV_FILE"
set_env() { grep -q "^$1=" "$ENV_FILE" && sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE" || echo "$1=$2" >> "$ENV_FILE"; }
set_env OPEN_BROWSER false
set_env PORT "$PORT"
[[ "${TUNNEL:-}" =~ ^(on|1|true|yes|quick|token)$ ]] && set_env TUNNEL on
$SUDO tee /etc/systemd/system/agentpit.service >/dev/null <<UNIT
[Unit]
Description=agentpit – web cockpit for Claude Code
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
Environment=HOME=$HOME
Environment=AGENTPIT_HOME=$AGENTPIT_HOME
Environment=XDG_RUNTIME_DIR=/run/user/$USER_ID
WorkingDirectory=$HOME
ExecStart=$BIN --no-open
Restart=always
RestartSec=3
KillSignal=SIGINT
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
UNIT
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now agentpit
$SUDO systemctl restart agentpit

step "Fertig"
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
AGENTPIT_HOME="$AGENTPIT_HOME" "$BIN" link || true
if grep -q '^TUNNEL=on' "$ENV_FILE"; then
  echo; echo "Fernzugriff: Adresse steht in einigen Sekunden hier:"; echo "  journalctl -u agentpit -n 50 | grep trycloudflare"
else
  echo; echo "Lokal: http://127.0.0.1:$PORT  ·  von außen: TUNNEL=on in $ENV_FILE und  $SUDO systemctl restart agentpit"
fi
echo "Logs: journalctl -u agentpit -f   ·   Update: dieses Skript erneut ausführen"

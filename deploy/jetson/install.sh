#!/usr/bin/env bash
# Agent Cockpit auf einem Jetson Orin Nano (JetPack 6 / Ubuntu 22.04, arm64) – oder jedem
# anderen Debian/Ubuntu-Server – einrichten. Als normaler Nutzer mit sudo-Rechten ausführen:
#
#   cd ~/agent-cockpit && bash deploy/jetson/install.sh
#
# Idempotent: kann erneut ausgeführt werden (Update, Reparatur).
# Was passiert:
#   1. Systempakete: Build-Tools (node-pty), git, ffmpeg, Xvfb, Node.js 24 (NodeSource), GitHub CLI, Tailscale
#   2. npm install, Weboberfläche, mitgelieferter Chromium (arm64) inkl. Systembibliotheken
#   3. .env für Fernzugriff über Tailscale (nur im eigenen Tailnet, nicht öffentlich)
#   4. systemd-Dienst, tailscale serve (HTTPS 443 → 4317, 8443 → 4318)
#   Das Login-Passwort legst du beim ersten Öffnen im Browser fest (Einrichtungscode siehe Ende).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
USER_NAME="$(id -un)"
step() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

if [[ "$(id -u)" == 0 ]]; then
  echo "Bitte als normaler Nutzer starten (nicht root) – sudo wird bei Bedarf benutzt." >&2
  exit 1
fi
[[ "$(uname -m)" == "aarch64" ]] || echo "Hinweis: kein arm64-System ($(uname -m)) – das Skript funktioniert trotzdem auf Ubuntu/Debian."

step "Systempakete"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg git build-essential python3 ffmpeg xvfb jq

if ! have node || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  step "Node.js 24 LTS (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node $(node -v), npm $(npm -v)"

if ! have gh; then
  step "GitHub CLI"
  sudo mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -y && sudo apt-get install -y gh
fi

if ! have tailscale; then
  step "Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
fi

step "Abhängigkeiten (npm)"
npm install --no-fund --no-audit
[[ -f web/dist/index.html ]] || npm run build:web

step "Chromium für Browser-Identitäten (arm64) + Systembibliotheken"
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/browsers"
sudo env "PATH=$PATH" "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH" node node_modules/playwright-core/cli.js install-deps chromium
npm run install:browser

step "Tailscale-Verbindung"
if ! tailscale status >/dev/null 2>&1; then
  echo "Melde dieses Gerät im Tailnet an (Link öffnen und bestätigen):"
  sudo tailscale up
fi
TS_NAME="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
if [[ -z "$TS_NAME" || "$TS_NAME" == "null" ]]; then
  echo "Tailscale-Name nicht ermittelbar – ist MagicDNS im Admin-Panel aktiv?" >&2
  exit 1
fi
echo "Adresse im Tailnet: https://$TS_NAME"

step ".env"
if [[ ! -f .env ]]; then
  cat > .env <<EOF
# Erzeugt von deploy/jetson/install.sh – Werte siehe .env.example
HOST=127.0.0.1
PORT=4317
PREVIEW_PORT=4318
OPEN_BROWSER=false
PUBLIC_URL=https://$TS_NAME
PREVIEW_PUBLIC_URL=https://$TS_NAME:8443
# 8 GB geteilter RAM (CPU+GPU): je Claude-Code-Prozess ~0,3–0,5 GB, je Browser ~0,3–0,6 GB
MAX_RUNNERS=3
MAX_BROWSERS=2
IDLE_TIMEOUT_MIN=15
EOF
  echo ".env angelegt."
else
  echo ".env existiert – unverändert. Prüfe PUBLIC_URL=https://$TS_NAME und PREVIEW_PUBLIC_URL=https://$TS_NAME:8443"
fi

step "systemd-Dienst"
NODE_BIN="$(command -v node)"
sudo tee /etc/systemd/system/agent-cockpit.service >/dev/null <<EOF
[Unit]
Description=Agent Cockpit (Claude Code Fernsteuerung)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$ROOT
Environment=NODE_ENV=production
Environment=PLAYWRIGHT_BROWSERS_PATH=$ROOT/browsers
ExecStart=$NODE_BIN $ROOT/server/index.js
Restart=on-failure
RestartSec=5
# Claude Code, Dienste und Browser sind Kindprozesse – beim Stoppen alle beenden
KillMode=control-group
TimeoutStopSec=20
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=false

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now agent-cockpit
sudo systemctl restart agent-cockpit

step "tailscale serve (nur im Tailnet erreichbar, HTTPS mit echtem Zertifikat)"
sudo tailscale serve --bg --https=443 http://127.0.0.1:4317
sudo tailscale serve --bg --https=8443 http://127.0.0.1:4318
sudo tailscale serve status || true

sleep 4
SETUP_CODE="$(cat data/.setup-code 2>/dev/null || true)"
cat <<EOF

Fertig.
  Cockpit:        https://$TS_NAME
$( [[ -n "$SETUP_CODE" ]] && echo "  Ersteinrichtung: Seite öffnen, Code $SETUP_CODE eingeben und Passwort festlegen" || echo "  Login mit deinem Passwort (vergessen: npm run set-password)" )
  Logs:           journalctl -u agent-cockpit -f
  Neustart:       sudo systemctl restart agent-cockpit
  Update:         git pull bzw. neues ZIP entpacken, dann dieses Skript erneut ausführen

Auf Handy/Laptop die Tailscale-App installieren und im selben Tailnet anmelden.
Claude- und GitHub-Login erledigst du danach im Cockpit unter „Konten“ (unten links).
EOF

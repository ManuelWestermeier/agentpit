#!/usr/bin/env bash
# Agent Cockpit starten (macOS / Linux) – Gegenstück zu start.cmd.
# Installiert beim ersten Mal die Abhängigkeiten, baut die Oberfläche und startet den Server.
set -euo pipefail
cd "$(dirname "$0")"

os="$(uname -s)"
hint() { # hint <mac-cmd> <linux-cmd>
  if [ "$os" = "Darwin" ]; then echo "$1"; else echo "$2"; fi
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js fehlt. Installieren: $(hint 'brew install node@24' 'https://nodejs.org (oder: curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs)')"
  exit 1
fi

major="$(node -p "process.versions.node.split('.')[0]")"
minor="$(node -p "process.versions.node.split('.')[1]")"
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 13 ]; }; then
  echo "Node.js $(node -v) ist zu alt (mindestens 22.13, empfohlen 24 LTS): $(hint 'brew install node@24' 'https://nodejs.org')"
  exit 1
fi

if [ ! -f node_modules/@anthropic-ai/claude-agent-sdk/package.json ]; then
  echo "Installiere Abhängigkeiten (einmalig, ca. 150 MB inkl. Claude Code) ..."
  npm install --no-fund --no-audit
fi

if [ ! -f web/dist/index.html ]; then
  echo "Baue die Weboberfläche ..."
  npm run build:web
fi

command -v ffmpeg >/dev/null 2>&1 || echo "Hinweis: ffmpeg fehlt – für Videos: $(hint 'brew install ffmpeg' 'sudo apt install ffmpeg')"
command -v gh >/dev/null 2>&1 || echo "Hinweis: GitHub CLI fehlt – für GitHub-Login: $(hint 'brew install gh' 'https://cli.github.com (sudo apt install gh)')"
command -v git >/dev/null 2>&1 || echo "Hinweis: git fehlt – $(hint 'xcode-select --install' 'sudo apt install git')"
if [ "$os" = "Linux" ] && [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && ! command -v Xvfb >/dev/null 2>&1; then
  echo "Hinweis: kein Bildschirm und kein Xvfb – Browser laufen unsichtbar (headless). Besser für Logins: sudo apt install xvfb"
fi

exec node server/index.js

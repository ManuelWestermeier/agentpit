# Agent Cockpit

Lokale Weboberfläche (Express + WebSocket) für mehrere parallele Claude-Code-Sessions. Jede Session arbeitet in `projects/<id>/`, Befehle und Ausgaben bleiben dauerhaft nachlesbar, Freigaben laufen über die UI, Verbrauch und Plan-Limits werden live angezeigt und prognostiziert. Browser-Steuerung (Playwright MCP) und eine Video-Pipeline (ffmpeg, HTML → MP4) sind pro Projekt vorkonfiguriert.

Technik: offizielles **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, bringt sein eigenes Claude-Code-Binary mit), Streaming-Input-Modus, React/Vite-Frontend (vorgebaut in `web/dist`).

## Start (Windows)

```
start.cmd            # Doppelklick – installiert beim ersten Mal, startet, öffnet den Browser
```
oder `npm install` + `npm start`. PowerShell-Variante: `powershell -ExecutionPolicy Bypass -File .\start.ps1` (bietet ffmpeg-Installation per winget an).

Voraussetzungen: Node.js ≥ 20.12 (aktuelle LTS empfohlen), Chrome oder Edge, für Videos `winget install --id Gyan.FFmpeg -e`, für Claudes Bash-Tool Git for Windows. Erstinstallation lädt ca. 150 MB (das Claude-Code-Binary für deine Plattform).

Beim Start gibt der Server einen Link `http://localhost:4317/?token=…` aus und öffnet ihn. Der Link setzt ein Cookie; danach reicht `http://localhost:4317`.

## Login

Links unten **„Bei Claude anmelden“** → startet `claude auth login` des mitgelieferten Claude Code. Der Browser öffnet die Anmeldung; erscheint dort ein Code, ins Feld im Dialog einfügen. Der Login liegt in `~/.claude` und gilt auch für eine eventuell installierte CLI. Alternativ `ANTHROPIC_API_KEY` oder `CLAUDE_CODE_OAUTH_TOKEN` (aus `claude setup-token`) in `.env`.

## Bedienung

| Bereich | Funktion |
|---|---|
| Sidebar | Projekte mit Status-Lampe (gelb = arbeitet, rot = wartet auf Freigabe, grün = bereit). Sessions des Projekts – auch im Terminal gestartete –, fortsetzen, abzweigen, neue Session. |
| Kopfzeile | Modell, Berechtigungsmodus, Effort (wirken sofort auf laufende Sessions), Prozess beenden. |
| Verlauf | Prompts, Antworten (live gestreamt), jeder Tool-Aufruf als Karte: Befehle mit stdout/stderr, Edits als Diff, Browser-Aktionen mit Screenshot, Subagenten verschachtelt, Turn-Abschluss mit Dauer/Calls/Kosten. Filter „Befehle & Ausgaben“ zeigt nur Shell-Befehle. Der Verlauf wird pro Session in `data/logs/` gespeichert und überlebt `/compact`. |
| Freigaben | Erlauben, Immer erlauben (schreibt Regel in `.claude/settings.local.json`), Ablehnen mit Begründung, Befehl vor dem Ausführen ändern. Rückfragen (AskUserQuestion) und Plan-Freigaben als Formular. |
| Befehlsleiste | `/compact`, `/context`, `/usage`, `/init`, `/clear`, alle weiteren über „Befehle …“ oder `/` im Eingabefeld. Esc bricht den laufenden Schritt ab. Während Claude arbeitet, werden Nachrichten eingereiht. |
| Dateien | Neueste Ausgaben als Vorschau-Kacheln, Dateibaum, Vorschau für Video/Audio/Bild/PDF/HTML/Text. Dateien per Drag & Drop oder Einfügen nach `input/` hochladen. |
| Terminal | PowerShell im Projektordner oder die interaktive Claude-Oberfläche der Session (braucht node-pty; fehlt es, ist der Tab ausgeblendet). |
| ↺ am Prompt | Setzt Dateien auf den Stand vor diesem Prompt zurück (File-Checkpoints des SDK; Änderungen per Shell werden nicht erfasst). |

## Verbrauch und Prognose

- **Plan-Limits** (5-Stunden-Fenster, Woche, pro Modell) kommen aus der Usage-Abfrage des SDK (`usage_EXPERIMENTAL…` – laut Anthropic instabil, bei Wegfall bleiben die Rate-Limit-Ereignisse aus dem Stream). Der „Fahrplan“ zeigt das 5-h-Fenster: gemessener Verlauf, Prognoselinie aus der Steigung der letzten 90 Minuten, roter Punkt, falls das Limit vor dem Reset erreicht wird.
- **Session**: Kosten aus `total_cost_usd`/`modelUsage` des SDK. Bei Abo-Login ist das der API-Gegenwert, keine Rechnung.
- **Nächster Prompt**: Listenpreis des Modells (aus der Modellliste von Claude Code) × aktueller Kontext. Annahmen: Cache-Lesen 0,1×, Cache-Schreiben 1,25× (5 min) bzw. 2× (1 h) des Eingabepreises; Kalibrierung auf die tatsächlichen Kosten der Session. „Ø Turn“ ist der Median der bisherigen Turns, auf den aktuellen Kontext skaliert. „% vom 5-h-Limit“ stammt aus gemessenem Limit-Zuwachs pro Dollar auf diesem Rechner – andere Geräte und claude.ai zählen ins selbe Limit und verfälschen den Wert nach oben.
- **Cache warm/kalt**: Nach Ablauf der Cache-Zeit schreibt der nächste Call den gesamten Kontext neu – der angezeigte Aufschlag ist der Grund, warum lange Pausen in großen Sessions teuer werden. Dann lohnt `/compact` oder `/clear`.

## Projekte

`projects/<id>/` bekommt aus `templates/default/`:
- `CLAUDE.md` mit Konventionen (`input/`, `output/`, `work/`)
- `.claude/skills/video` – Video-Pipeline inkl. `render-frames.mjs` (HTML-Szene mit `window.renderFrame(t)` → Frames direkt in ffmpeg → MP4)
- `.claude/skills/browser` – Arbeitsweise mit Playwright, Bildschirmvideos (`browser_start_video`)
- `.claude/settings.json` – erlaubt `ffmpeg`, `ffprobe`, `mkdir`, `ls` ohne Nachfrage

Playwright MCP wird pro Session mit eigenem Browserprofil (`data/browser/<id>`) gestartet; Screenshots und Videos landen in `output/browser/`. Ohne Nachfrage erlaubt sind die Browser-Aktionen außer `browser_run_code_unsafe` (führt beliebigen Code aus) sowie Datei-Uploads auf Websites.

Projekt entfernen verschiebt Ordner und Daten nach `trash/` – gelöscht wird nichts.

## Sicherheit

- Server bindet nur an 127.0.0.1. Zugriff nur mit dem Token-Cookie (HttpOnly, SameSite=Strict); Host- und Origin-Prüfung gegen DNS-Rebinding und Cross-Site-WebSockets.
- Projektdateien werden auf einem zweiten Origin (`127.0.0.1:4318`, eigener Token) ausgeliefert, damit von Claude erzeugtes HTML in der Vorschau weder das Cookie noch die API erreicht.
- Claude führt Befehle mit deinen Benutzerrechten aus. Freigaben ernst nehmen; der Modus „Ohne Nachfrage“ ist gesperrt, bis `ALLOW_BYPASS_PERMISSIONS=true` gesetzt ist. Für autonome Läufe ist „Auto (Klassifikator)“ die sicherere Wahl.
- Rechtlich: Für deinen eigenen Rechner ist das Cockpit eine Oberfläche für dein eigenes Claude Code. Anthropic erlaubt Drittanbietern ohne Genehmigung nicht, claude.ai-Login in ihren Produkten anzubieten – stellst du das Tool Kunden bereit (z. B. über ChiemWeb), auf API-Key-Authentifizierung umstellen.

## Konfiguration

Siehe `.env.example` (nach `.env` kopieren). Wichtig: `IDLE_TIMEOUT_MIN` (Prozess endet nach Leerlauf, Session bleibt fortsetzbar), `MAX_RUNNERS` (je Prozess ca. 300–500 MB RAM), `DEFAULT_PERMISSION_MODE`.

## Aufbau

```
server/
  index.js        Start, Express, WebSocket, Vorschau-Server, Shutdown
  runner.js       eine Claude-Code-Session pro Projekt (SDK query, Freigaben, Stream, Usage)
  catalog.js      Modelle/Preise/Konto, Probe-Prozess, Usage-Polling
  limits.js       Plan-Limits, Stichproben, Prognose
  sessions.js     Session-Liste (SDK-Transkripte + eigene Logs), Verlauf
  actions.js      WebSocket-Aktionen
  auth.js         claude auth status/login/logout
  files.js, media.js, projects.js, store.js, security.js, terminals.js, hub.js
web/src/          React-UI (lib/timeline.ts setzt SDK-Nachrichten in Verlaufseinträge um)
templates/default Projektvorlage
test/             Unit-Tests (npm test), Mock-SDK für UI-Entwicklung
```

Entwicklung: `COCKPIT_MOCK=1 npm start` startet mit simulierten Sessions (kein Login, keine Kosten). UI mit Hot Reload: Server mit `DEV_ORIGINS=http://localhost:5173` starten, einmal den Token-Link öffnen, dann `npm run dev:web` und `http://localhost:5173`. Nach UI-Änderungen `npm run build:web`.

## Probleme

| Symptom | Lösung |
|---|---|
| „Kein Zugang“ | Token-Link aus der Konsole öffnen (Cookie fehlt, z. B. anderer Browser). |
| Terminal-Tab fehlt | node-pty nicht installiert – `npm install` erneut, Rest funktioniert ohne. |
| „Claude Code wurde unerwartet beendet“ | stderr steht im roten Banner. Häufig: ungültige `.claude/settings.json`, fehlendes Git Bash. |
| Browser-Tools fehlen | Chrome oder Edge installieren oder `BROWSER_CHANNEL` setzen; MCP-Status steht in der Init-Zeile jeder Session. |
| Erster Start langsam | Windows Defender scannt einmalig das Claude-Code-Binary. |
| SDK aktualisieren | `npm update @anthropic-ai/claude-agent-sdk` |

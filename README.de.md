# agentpit (Agent Cockpit)

Weboberfläche (Express + WebSocket) für mehrere parallele Claude-Code-Sessions – lokal unter Windows oder als Dauerdienst auf einem Server (z. B. Jetson Orin Nano) mit Fernzugriff vom Handy/Laptop. Jedes Projekt ist ein Ordner `projects/<id>/` mit eigenem Git-Repository.

Pro Projekt fünf Bereiche:

| Tab | Inhalt |
|---|---|
| Session | Verlauf mit allen Befehlen und Ausgaben, Freigaben, Befehlsleiste (`/compact`, `/context`, …), Modell/Modus/Effort, Kosten-Vorschau. Mit verknüpftem Browser daneben die Live-Ansicht. |
| Browser | Welche Browser-Identität Claude nutzt; Live-Bild + Fernsteuerung (Maus, Tastatur, Touch, Einfügen, Tabs). |
| Dateien | Dateibaum, neueste Ausgaben, Vorschau (Video, Bild, PDF, HTML, Text), Upload nach `input/`. |
| Git | Änderungen, Commit, Verlauf, Diff, Revert, Push/Pull, „Auf GitHub veröffentlichen“. Auto-Commit nach jeder Aufgabe (abschaltbar). |
| Dienste | Start/Stopp von Dev-Servern & Skripten (`cockpit.services.json`), Live-Logs, „An Claude“, Terminal. Dienste können per Hook Prompts in die Session schicken. |
| Daten | SQLite/PostgreSQL/MySQL-Verbindungen, Schema, Abfragekonsole. Claude nutzt dieselben Verbindungen. |

Links: Projekte mit Sessions, Browser-Identitäten, Konten (Claude, GitHub). Oben rechts: Verbrauch & Limit-Prognose.

Neues Projekt: „+“ – sofort losschreiben, ohne Namen oder Einstellungen. Titel und Beschreibung des Projekts sowie kurze Session-Titel schreibt Claude Haiku aus dem ersten und den weiteren Prompts (im Hintergrund, nach den ersten beiden Prompts einer Session und dann jeden fünften); sie stehen in der Oberfläche und in `META.md` im Projektordner. Benennst du ein Projekt in den Einstellungen selbst um, bleibt dein Name.

Technik: offizielles Claude Agent SDK (bringt sein Claude-Code-Binary für Windows/macOS/Linux x64+arm64 mit), Playwright MCP, playwright-core (CDP), React/Vite (vorgebaut in `web/dist`).

## Schnellstart über npm

```bash
npx agentpit                 # startet und öffnet den Browser
npx agentpit --help          # Optionen: --port, --home, --no-open, --public-url
npx agentpit link            # Login-Link und Einrichtungscode
npx agentpit set-password    # Passwort zurücksetzen
```
Über npm installiert liegen Daten, Projekte und `.env` in `~/.agentpit` (änderbar mit `--home` bzw. `AGENTPIT_HOME`). Aus einem Git-Checkout gestartet bleibt alles im Repo-Ordner.

## Start unter Windows

```
start.cmd        # Doppelklick: installiert beim ersten Mal, startet, öffnet den Browser
```
Voraussetzungen: Node.js ≥ 22.13 (24 LTS empfohlen: `winget install OpenJS.NodeJS.LTS`), Git for Windows, optional `winget install --id Gyan.FFmpeg -e` (Videos) und `winget install GitHub.cli` (GitHub-Login). Browser-Identitäten nutzen Chrome/Edge oder den mitgelieferten Chromium (`npm run install:browser` bzw. Button in der UI).

Der Server gibt `http://localhost:4317/?token=…` aus und öffnet ihn. Beim ersten Öffnen legst du das Passwort fest – ab dann schützt es jeden Zugriff (siehe „Zugriffsschutz“).

## Start unter macOS und Linux (Desktop)

```bash
./start.sh       # oder unter macOS: Doppelklick auf start.command
```
Gleiches Verhalten wie `start.cmd`: prüft Node (≥ 22.13), installiert beim ersten Mal, baut die Oberfläche, startet. Voraussetzungen macOS: `brew install node@24 ffmpeg gh` (git über `xcode-select --install`). Linux: Node 24 von nodejs.org/NodeSource, `sudo apt install git ffmpeg` (optional `xvfb` für sichtbare Browser ohne Bildschirm). Browser-Identitäten nutzen Chrome/Edge oder den mitgelieferten Chromium. Ohne Bildschirm (Server) siehe nächster Abschnitt.

## Jetson Orin Nano (oder anderer Linux-Server) mit Fernzugriff

```bash
# ZIP entpacken oder Repo klonen, dann:
cd ~/agent-cockpit
bash deploy/jetson/install.sh
```
Das Skript (JetPack 6 / Ubuntu 22.04 arm64, idempotent) installiert Node 24, Build-Tools, git, ffmpeg, Xvfb, GitHub CLI, Tailscale, den arm64-Chromium samt Bibliotheken, legt `.env` an, richtet den systemd-Dienst `agent-cockpit` ein, veröffentlicht ihn per `tailscale serve` und zeigt am Ende den Einrichtungscode für das erste Öffnen:

| Adresse | Ziel |
|---|---|
| `https://<jetson>.<tailnet>.ts.net` | Cockpit (127.0.0.1:4317) |
| `https://<jetson>.<tailnet>.ts.net:8443` | Datei-Vorschau, eigener Origin (127.0.0.1:4318) |

Auf Handy/Laptop die Tailscale-App ins selbe Tailnet, Adresse öffnen, Einrichtungscode + neues Passwort eingeben. Danach unter „Konten“: **Mit Claude-Abo anmelden** (Link öffnen, Code einfügen – funktioniert vom Handy aus) und **Mit GitHub anmelden** (Gerätecode auf github.com/login/device eingeben; alternativ Fine-grained Token).

Ressourcen (8 GB, mit der GPU geteilt): pro Claude-Code-Prozess ca. 0,3–0,5 GB, pro Browser ca. 0,3–0,6 GB. Das Skript setzt `MAX_RUNNERS=3`, `MAX_BROWSERS=2`, `IDLE_TIMEOUT_MIN=15`. Daten auf NVMe statt SD-Karte legen. Betrieb: `journalctl -u agent-cockpit -f`, `sudo systemctl restart agent-cockpit`.

Manuell statt Skript: beliebiger HTTPS-Tunnel oder Reverse-Proxy auf 127.0.0.1:4317 (siehe nächster Abschnitt).

## Zugriffsschutz, Domain und Tunnel

**Erstes Öffnen:** Solange kein Passwort existiert, zeigt jede Seite nur die Einrichtung.
- Lokal (Link aus der Konsole, öffnet sich beim Start automatisch): Passwort direkt in der Oberfläche festlegen.
- Über Domain/Tunnel: Einrichtungscode aus der Server-Konsole bzw. `npm run link` eingeben, dann Passwort. Ohne Code kann niemand das Passwort setzen, auch wenn der Tunnel schon öffentlich ist.

**Danach:** Jede Adresse verlangt das Passwort (min. 4 Zeichen, scrypt – über Domain/Tunnel ein längeres wählen). Sitzungen sind einzeln widerrufbar (Konten → Zugriff → Angemeldete Geräte), laufen nach 30 Tagen Inaktivität ab, und ein Passwortwechsel meldet alle anderen Geräte ab. Neue Adressen (z. B. die Tunnel-Domain) werden automatisch freigegeben, sobald du dich dort mit dem Passwort anmeldest; vorher bekommen sie nur die Login-Seite. Passwort vergessen: `npm run set-password` auf dem Server.

**Tunnel/Proxy** – immer auf `http://127.0.0.1:4317` zeigen lassen, der Server bleibt auf loopback:

| Variante | Befehl / Einstellung |
|---|---|
| Cloudflare Tunnel (eigene Domain) | siehe Beispiel unten |
| Cloudflare Quick Tunnel (Test) | `cloudflared tunnel --url http://127.0.0.1:4317` – zufällige `*.trycloudflare.com`-Adresse, ändert sich bei jedem Start |
| Microsoft Dev Tunnels | `devtunnel host -p 4317` (standardmäßig nur nach Microsoft/GitHub-Login erreichbar – gut als zweite Schicht; `--allow-anonymous` nur, wenn nötig) |
| Tailscale | `tailscale serve --bg --https=443 http://127.0.0.1:4317` (nur im Tailnet) |

Cloudflare Tunnel mit eigener Domain:
```bash
cloudflared tunnel login
cloudflared tunnel create cockpit
cloudflared tunnel route dns cockpit cockpit.deine-domain.de
# ~/.cloudflared/config.yml
#   tunnel: cockpit
#   credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json
#   ingress:
#     - hostname: cockpit.deine-domain.de
#       service: http://127.0.0.1:4317
#     - service: http_status:404
cloudflared tunnel run cockpit          # dauerhaft: sudo cloudflared service install
```

Das Cockpit liest `X-Forwarded-Host/-Proto/-For` nur von Verbindungen über loopback, also vom Tunnel-Client auf demselben Rechner. Dev Tunnels schreiben Host und Origin standardmäßig auf `localhost` um; das wird über `X-Forwarded-Host` erkannt.

Datei-Vorschauen laufen über die Hauptadresse unter `/p/…` mit `Content-Security-Policy: sandbox` (eigener, undurchsichtiger Origin: kein Cookie- oder API-Zugriff für erzeugtes HTML). Ein zweiter Tunnel ist nicht nötig. Wer ihn trotzdem will: Port 4318 tunneln und `PREVIEW_PUBLIC_URL` setzen.

Empfehlung bei öffentlicher Domain: zusätzlich **Cloudflare Access** (Zero Trust, im Free-Plan enthalten) vor den Tunnel – E-Mail-Code oder Google/GitHub-Login, bevor überhaupt die Cockpit-Seite erreichbar ist. Dann ist das Passwort die zweite Schicht.

## Browser-Identitäten

- Jede Identität ist ein eigenes Chromium-Profil (`data/browsers/<id>`): Cookies, localStorage, IndexedDB, Logins komplett getrennt. „Temporär“ löscht das Profil beim Beenden.
- Pro Identität einstellbar: Sprache (Standard Deutsch, `de-DE`), bevorzugte Sprachen (Accept-Language), Zeitzone (Standard: System), Farbschema der Seiten, Proxy. Zeitzone und Farbschema wirken sofort, Sprache/Proxy/Browser nach Neustart des Browsers. Gegen Bot-Erkennung: Sprache und Zeitzone passend zur IP lassen, Identitäten als echtes Fenster starten (Standard, sobald ein Bildschirm da ist).
- Live-Bild per CDP-Screencast, Eingaben (Maus, Rad, Tastatur, Touch, Einfügen) gehen direkt an die Seite. „An Fenster anpassen“ setzt die Viewport-Größe. Auf dem Handy öffnet das Tastatur-Symbol die Bildschirmtastatur.
- **Stream-Qualität** (Tacho-Symbol in der Browser-Ansicht, live mit Bildrate, Datenrate, Bildgröße): Standard **Auto** – Qualität, Auflösung und Bildrate folgen der gemessenen Verbindung (bei Stau in ~3 s herunter, bei freier Leitung schrittweise wieder hoch). **Manuell**: JPEG-Qualität, max. Breite, max. Bildrate, JPEG/PNG, Voreinstellungen von „Beste Qualität“ bis „Mobilfunk“. Es wird nie ein Bildstau aufgebaut: ist die Leitung belegt, kommt nur das jeweils neueste Bild an.
- Startet ein sichtbares Fenster nicht (macOS ohne Anmeldung am Desktop, Linux ohne Grafik-Bibliotheken), fällt das Cockpit automatisch auf headless zurück; blockiert AppArmor (Ubuntu ≥ 23.10) die Sandbox des mitgelieferten Chromium, wird ohne Sandbox gestartet.
- **Mit Claude verknüpfen** (Tab Browser oder Projekteinstellungen): Claude steuert dann genau diesen Browser über Playwright MCP – du siehst jede Aktion live und kannst jederzeit eingreifen, z. B. Logins/2FA selbst erledigen. Ohne Verknüpfung bekommt jede Session einen eigenen, isolierten Browser.
- **Mehrere Identitäten pro Session:** Claude sieht mit `browser_info` alle Identitäten und wechselt mit `browser_use` sofort – auch mitten in einer Aufgabe (z. B. LinkedIn in Identität A lesen, auf X in Identität B schreiben). Technisch läuft Playwright über ein festes CDP-Relay des Cockpits, das auf die gerade aktive Identität zeigt und sie bei Bedarf startet. Wechselst du die Identität in der Oberfläche, folgt die laufende Session ebenfalls sofort.
- **Beständigkeit:** Jede Identität ist ein Profilordner unter `data/browsers/<id>` und hat einen festen, nur ihr gehörenden Debug-Port. Logins und Cookies bleiben über Browser-, Cockpit- und Rechner-Neustarts erhalten (wie lange eine Anmeldung gilt, bestimmt die jeweilige Website). Browser laufen unabhängig vom Cockpit-Prozess: Ein normal beendetes Cockpit schließt sie sauber, nach einem Absturz laufen sie weiter und werden beim nächsten Start übernommen – geprüft über ein Markierungs-Cookie im Profil, sodass eine Identität nie den Browser einer anderen übernimmt. Browser-Sync ist abgeschaltet, damit Edge/Chrome Identitäten nicht mit deinem Microsoft-/Google-Konto verbinden und Daten zwischen ihnen abgleichen.
- Google-Login: In headless Chromium wird er oft abgelehnt. Auf Linux-Servern ohne Bildschirm laufen Identitäten deshalb standardmäßig als echtes Fenster auf einem virtuellen Display (Xvfb, wird automatisch gestartet); im Headless-Modus wird zumindest der „HeadlessChrome“-User-Agent ersetzt. `navigator.webdriver` ist in beiden Fällen `false`. Garantien gibt es bei Googles Risikoprüfung nicht – Anmeldung immer selbst durchführen, nie Passwörter an Claude geben.
- „Claude in Chrome“ (die Erweiterung) ist ein eigenes Produkt, das an deinen Desktop-Chrome gebunden ist. Hier übernimmt Playwright MCP über CDP dieselbe Rolle auf der Identität (gleiche Cookies und Logins). Die Erweiterung lässt sich per Fernsteuerung in einem Chrome-Profil installieren; Claude Codes `--chrome`-Anbindung daran ist nicht getestet.

## Sub-Sessions, Zeitpläne und gemeinsamer Ordner

- **Gemeinsamer Ordner `projects/shared-claude/`** (aus jedem Projekt `../shared-claude/`): alle Sessions dürfen dort lesen und schreiben – für Wissen, Datensätze und Übergaben zwischen Sessions. Wird beim ersten Start mit einer `README.md` angelegt und nie als Projekt angezeigt. Keine Zugangsdaten dort ablegen.
- **Sub-Sessions:** Claude startet mit `session_create` weitere Sessions (eigenes Projekt, erbt Modell und Berechtigungsmodus, optional eigene Browser-Identität) und steuert sie mit `session_send`, `session_status`, `session_wait`, `session_stop`, `session_list`. In der Seitenleiste sind sie mit „↳“ markiert. Beispiel-Pipeline: Session 1 recherchiert Videos → legt die Liste in `shared-claude/pipelines/…` ab → Session 2 schneidet Clips → Sessions 3 und 4 veröffentlichen je in einer eigenen Identität/einem eigenen Account. Grenzen: höchstens 3 Ebenen, 12 neue Sessions pro Stunde und Session, gleichzeitig `MAX_RUNNERS`.
- **Zeitpläne** (Tab Microservices → Zeitpläne, oder Claude mit `schedule_create`): ein Prompt einmalig, alle n Minuten oder per Cron (`0 9 * * 1-5`, Ortszeit) an eine Session. Gespeichert in `data/schedules.json`; während das Cockpit aus war, verpasste Läufe werden nicht nachgeholt (einmalige bis 6 h verspätet schon). Ist `MAX_RUNNERS` erreicht, wird jede Minute erneut versucht.
- Claude richtet Einrichtbares selbst ein, statt dich darum zu bitten: Datenbankverbindungen (`db_connect`, SQLite oder mit von dir genannten Zugangsdaten), Dienste, Zeitpläne, Identitäten, Sub-Sessions. `browser_info` zeigt je Identität, bei welchen Diensten sie angemeldet ist (aus den Login-Cookies, ohne Seitenaufruf). Nur Logins, Passwörter und 2FA erledigst immer du.
- Freigaben: Lesende Werkzeuge und der Identitätswechsel laufen ohne Rückfrage; neue Sessions starten, Prompts senden und Zeitpläne anlegen fragen im Modus „default“ nach (mit „Immer erlauben“ dauerhaft freigebbar). Freigaben einer Sub-Session erteilst du in deren Projekt.
- **Zugriff auf Fremdes fragt immer – auch im Auto-Modus:** Datenbanken anderer Projekte (lesen/schreiben getrennt), Sessions, die nicht die eigenen Sub-Sessions sind, und Browser-Identitäten, die nicht mit dem Projekt verknüpft sind. „Immer erlauben“ merkt sich die Freigabe im Projekt; die Liste steht in den Projekteinstellungen unter „Dauerhafte Freigaben“ und lässt sich dort entziehen.

## Automatisches Aufräumen

Läuft 2 Minuten nach dem Start und dann alle 6 Stunden (abschaltbar mit `CLEANUP=false`, Fristen in `.env`, siehe `.env.example`):

| Was | Wann gelöscht |
|---|---|
| `output/browser/` – Seiten-Snapshots, Logs, Traces von Playwright | nach 2 Tagen |
| `output/browser/` – Aufnahmen, Screenshots von Playwright | nach 7 Tagen |
| `work/` – Zwischenstände (nicht, solange die Session gerade arbeitet) | nach 14 Tagen |
| `trash/` – gelöschte Projekte und Identitäten | 30 Tage nach dem Löschen |
| Browser-Caches einer Identität (HTTP-, Code-, GPU-, Komponenten-Cache) | sobald über 200 MB, wenn ihr Browser nicht läuft |

Nie angefasst: Ergebnisse in `output/` (außer mit `OUTPUT_DAYS` > 0), `input/`, Projektdateien, `.git`/`.claude`, `shared-claude/`, sowie Logins, Cookies, Verlauf, Passwörter und Erweiterungen der Identitäten. Zusätzlich ist der HTTP-Cache jeder Identität auf 256 MB begrenzt.

## Git & GitHub

Neue Projekte starten als Repository (`main`, `.gitignore` für `node_modules/`, `work/`, Videos, `.env*`, Browser-Ausgaben). Nach jedem abgeschlossenen Turn committet das Cockpit Änderungen als `Claude: <erste Promptzeile>` (abschaltbar); Claude selbst darf `git status/diff/log/show/add/commit` ohne Nachfrage, `push` nur mit Freigabe. Push/Pull und „Veröffentlichen“ (`gh repo create --private --source --push`) nutzen den GitHub-Login des Servers (`gh auth setup-git`).

## Dienste & Hooks

`cockpit.services.json` im Projekt (versioniert, Claude kann es per Tool `service_define` pflegen):
```json
{ "services": [{ "id": "web", "name": "Dev-Server", "command": "npm run dev -- --port 5173", "url": "http://localhost:5173", "autostart": false }] }
```
Start/Stopp beenden den ganzen Prozessbaum. URLs werden aus den Logs erkannt; der Globus öffnet sie im verknüpften Browser. Jeder Dienst bekommt `COCKPIT_HOOK_URL` und `COCKPIT_HOOK_TOKEN`:
```js
await fetch(process.env.COCKPIT_HOOK_URL, { method: 'POST',
  headers: { Authorization: `Bearer ${process.env.COCKPIT_HOOK_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ from: 'Test-UI', text: 'Checkout wirft 500 – bitte prüfen' }) });
```
Der Text landet als Prompt in der Session (läuft sie, wird er eingereiht). Limit: 1 Nachricht / 2 s. Token erneuern: Projekteinstellungen.

Unter „Erweitert“ (bzw. als Felder in `cockpit.services.json`): `port` (als `PORT` übergeben, URL daraus abgeleitet), `health` (Pfad oder URL, alle 10 s geprüft), `restart` (`no`, `on-failure`, `always`; Wartezeit 1–16 s, höchstens 5 Neustarts in 10 min), `dependsOn` (IDs, die vorher gestartet werden). Der Tab **Microservices** zeigt mit „Alle Projekte“ die Dienste sämtlicher Projekte samt Logs.

## Datenbanken

Verbindungen liegen in `data/db/<projekt>.json` (nicht im Repo). Lesen läuft in Read-only-Transaktionen bzw. mit Read-only-Handle, max. 500 Zeilen, 30 s. Schreiben nur, wenn an der Verbindung erlaubt – und Claudes `db_execute` fragt trotzdem jedes Mal. Empfehlung: eigener DB-Nutzer mit minimalen Rechten, für Produktion nur Lesezugriff oder eine Kopie.

- Claude legt mit `db_create` selbst SQLite-Datenbanken im Projekt an (`data/<name>.db`, beschreibbar) und kann mit dem Parameter `project` Verbindungen anderer Projekte nutzen (fragt vorher, siehe Freigaben).
- **Diagramme:** `db_chart` (direkt aus einer SQL-Abfrage) und `chart_create` (aus eigenen Werten) schreiben eigenständige HTML-Seiten nach `output/charts/` – Balken, Linie, Fläche, Streuung, hell/dunkel, Werte beim Überfahren, Tabellenansicht. Ohne Skripte, daher sicher in der Dateivorschau.

## Limits pro Antwort

„Limit“ unter dem Eingabefeld setzt Obergrenzen für jede einzelne Antwort: Kosten in $, Anteil am 5-h-Limit in %, Dauer in Minuten, Anzahl Schritte (API-Aufrufe). Wird eine erreicht, bricht das Cockpit die Antwort ab und vermerkt es im Verlauf. Kosten und Anteil sind Schätzungen aus Token × Listenpreis; während der Antwort zeigt der Button den laufenden Stand.

## Kontext und Verlauf

Jede Session schreibt nach `context/<datum>-<session>.md` im Projekt: Prompts, Antworten, Zusammenfassungen und Abbrüche. Erreicht der Kontext `AUTO_COMPACT_PCT` (Standard 75 %, pro Projekt in den Einstellungen), lässt das Cockpit ihn nach der Antwort zusammenfassen (`/compact`); die Zusammenfassung landet ebenfalls dort. Claude kennt den Ordner und liest bei Bedarf darin nach.

## Fehlende Programme

Fehlt ffmpeg, Git oder die GitHub CLI, steht unten in der Seitenleiste ein kurzer Hinweis mit „Installieren“ (Windows: winget, macOS: Homebrew, ohne Administratorrechte, wo das Paket es erlaubt). Der Fortschritt erscheint im Hinweis; danach wird `PATH` neu gelesen, ein Neustart ist meist nicht nötig. Auf Linux steht der passende Befehl da.

## Verbrauch und Prognose

- Plan-Limits (5 h, Woche, pro Modell) aus der Usage-Abfrage des SDK (experimentelle API, Fallback: Rate-Limit-Ereignisse). Der „Fahrplan“ zeigt Verlauf und Prognose bis zum Reset.
- Session-Kosten aus `total_cost_usd`/`modelUsage` (bei Abo der API-Gegenwert). Vorschau des nächsten Prompts: Listenpreis × Kontext, Cache-Lesen 0,1×, Cache-Schreiben 1,25× (5 min) / 2× (1 h), kalibriert auf die echten Kosten; „Ø Turn“ = Median; „% 5-h-Limit“ aus gemessenem Zuwachs pro Dollar.

## Sicherheit

- Server bindet nur an 127.0.0.1; erreichbar von außen nur über einen Tunnel/Proxy auf demselben Rechner. Zugang nur mit Sitzung (zufällige ID, HttpOnly, SameSite=Strict, Secure hinter HTTPS, gespeichert nur als Hash) aus Passwort-Login oder Konsolen-Link. Fehlversuche: 5 pro Adresse und Minute plus globale Bremse (30 in 5 min → 1 min Pause für alle).
- Host-Freigabe gegen DNS-Rebinding, Origin-Prüfung für WebSocket und jeden schreibenden Request, `X-Cockpit`-Header, HSTS hinter HTTPS.
- Nicht ohne Passwortschutz und nicht ohne Not anonym öffentlich machen: wer das Cockpit erreicht, hat eine Shell auf dem Rechner. Konsolen-Link (`npm run link`) nie teilen – er umgeht das Passwort.
- Projektdateien kommen von einem zweiten Origin (lokal) bzw. sandboxed von `/p/…` (remote) mit eigenem Token – von Claude erzeugtes HTML erreicht weder Cookie noch API.
- Claude, Dienste und Browser laufen mit den Rechten des Server-Nutzers. Freigaben ernst nehmen; „Ohne Nachfrage“ ist gesperrt, bis `ALLOW_BYPASS_PERMISSIONS=true`. DB-Passwörter liegen im Klartext in `data/` (Dateirechte des Nutzers) – `data/` nie committen oder teilen.
- Rechtlich: Für dich selbst ist das Cockpit eine Oberfläche für dein eigenes Claude Code mit deinem Abo. Anthropic erlaubt Drittanbietern nicht, claude.ai-Login in eigenen Produkten anzubieten – stellst du es Kunden bereit, auf API-Key umstellen (`ANTHROPIC_API_KEY`). Automatisierte Logins/Scraping auf fremden Websites können deren AGB verletzen.

## Konfiguration

`.env.example` → `.env`. Wichtig: `MAX_RUNNERS`, `MAX_BROWSERS`, `IDLE_TIMEOUT_MIN`, `DEFAULT_PERMISSION_MODE`.

Skripte: `npm run set-password` (Passwort zurücksetzen, meldet alle ab), `npm run link` (Konsolen-Link und ggf. Einrichtungscode), `npm run install:browser` (Chromium + ffmpeg für Playwright nach `./browsers`).

## Aufbau

```
server/
  index.js          Start, Express, WebSocket, Vorschau-Server, Hook-API, Shutdown
  runner.js         eine Claude-Code-Session pro Projekt (SDK, Freigaben, Stream, Auto-Commit)
  browsers.js       Browser-Identitäten: Prozesse, CDP, Screencast, Eingaben, Xvfb
  cockpit-mcp.js    Cockpit-Tools für Claude (Datenbanken, Diagramme, Dienste, Sessions, Browser)
  charts.js         SVG-Diagramme als eigenständige HTML-Seiten
  installer.js      Ein-Klick-Installation fehlender Programme (winget/Homebrew)
  git.js github.js  Versionskontrolle, GitHub CLI
  databases.js services.js
  catalog.js limits.js sessions.js actions.js auth.js security.js files.js terminals.js …
web/src/            React-UI
templates/default/  Projektvorlage (CLAUDE.md, Skills video/browser, Rechte)
deploy/jetson/      Installationsskript Linux/Jetson
test/               Unit-Tests (npm test), Mock-SDK
```
Tests: `npm test` (Unit), `npm run test:browser` (echter Browser: Identität, Stream, Auto-Regelung; Linux ohne Bildschirm mit `xvfb-run -a`). Die GitHub-Actions-CI führt beides bei jedem Push auf Windows, macOS und Linux aus (Node 22 und 24; macOS nur Node 24).

Entwicklung: `COCKPIT_MOCK=1 npm start` (simulierte Sessions, keine Kosten); UI mit Hot Reload: Server mit `DEV_ORIGINS=http://localhost:5173`, Token-Link öffnen, `npm run dev:web`.

## Probleme

| Symptom | Lösung |
|---|---|
| Login-Seite statt App | Normal bei neuer Adresse oder abgelaufener Sitzung – Passwort eingeben. Einrichtungscode/Konsolen-Link: `npm run link`. |
| Passwort vergessen | Auf dem Server `npm run set-password`. |
| Tunnel: Login klappt, App verbindet nicht | Tunnel muss WebSockets durchlassen (cloudflared, devtunnel, tailscale tun das). |
| Browser startet nicht | „Browser installieren“ bzw. `npm run install:browser`; Linux zusätzlich Bibliotheken (`node node_modules/playwright-core/cli.js install-deps chromium` als root). |
| Google lehnt Login ab | Identität als echtes Fenster (Xvfb) statt headless; Engine Chrome, wo verfügbar; selbst anmelden. |
| Terminal-Tab fehlt | node-pty nicht gebaut (Linux: `build-essential`, `python3`, dann `npm install`). |
| GitHub-Login hängt | `gh` installieren; alternativ Token-Login im Dialog. |
| Claude Code beendet sich | stderr steht im roten Banner; häufig ungültige `.claude/settings.json`. |

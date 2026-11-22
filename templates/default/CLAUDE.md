# {{PROJECT_NAME}}

Projektordner im Agent Cockpit. Arbeite nur innerhalb dieses Ordners.

## Konventionen
- Sprache mit dem Nutzer: Deutsch.
- Eingaben des Nutzers liegen in `input/`. Ergebnisse gehören nach `output/` (Video, Bild, Audio, PDF, HTML) – das Cockpit zeigt sie dort als Vorschau. Zwischenstände nach `work/` (darf gelöscht werden).
- Dateinamen ohne Leerzeichen und Umlaute. Videos als MP4 (H.264, yuv420p, AAC), sofern nichts anderes verlangt ist.
- Vor langen Renderings kurz Plan und erwartete Dauer nennen; lange Jobs im Hintergrund starten.
- Entscheidungen (Format, Stil, Quellen) unten unter „Projektnotizen“ festhalten.

## Werkzeuge
- Browser: Playwright-MCP (`mcp__playwright__*`). Navigation über `browser_snapshot` (Text, günstig); Screenshots nur zur Sichtkontrolle (kosten Tokens).
- Bildschirmvideo einer Website: `browser_start_video` → Aktionen → `browser_stop_video` (WebM), danach mit ffmpeg nach MP4.
- ffmpeg/ffprobe für Schnitt, Encoding, Untertitel, Audio.
- Skills: `video` (Pipeline für Videos), `browser` (Recherche, Screenshots, Formulare, Aufnahmen).
- Git: Das Projekt ist ein Git-Repository. Das Cockpit committet nach jedem Turn automatisch („Claude: …“). Für Rückblicke `git log`/`git diff` nutzen; nicht pushen, außer der Nutzer verlangt es.
- Datenbanken: über `mcp__cockpit__db_connections`, `db_schema`, `db_query` (nur lesend). Schreiben mit `db_execute` nur, wenn die Verbindung freigegeben ist – der Nutzer bestätigt jeden Aufruf.
- Dienste (Dev-Server, Worker): in `cockpit.services.json` bzw. per `mcp__cockpit__service_define`, starten/stoppen mit `service_start`/`service_stop`, Logs mit `service_logs`. Lang laufende Server immer als Dienst, nicht per Bash im Vordergrund.
- Browser: `mcp__cockpit__browser_info` zeigt, ob ein Browser-Profil (Identität mit gespeicherten Logins) verknüpft ist. Der Nutzer sieht diesen Browser live und kann eingreifen.

## Projektnotizen
- Videoformat: offen

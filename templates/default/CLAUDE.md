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

## Projektnotizen
- Videoformat: offen

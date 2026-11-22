---
name: browser
description: Websites im echten Browser steuern – öffnen, klicken, Formulare ausfüllen, Inhalte lesen, Screenshots und Bildschirmvideos aufnehmen. Nutzen, wenn eine Aufgabe eine Website bedienen, prüfen oder abfilmen muss.
---

# Browser über Playwright-MCP

## Arbeitsweise
- Navigieren mit `browser_navigate`, danach `browser_snapshot` lesen (Accessibility-Baum, günstig) und Elemente über dessen Referenzen ansprechen.
- `browser_take_screenshot` nur zur Sichtkontrolle oder als Ergebnis. Jedes Bild kostet Kontext; ablegen mit `filename: "output/browser/<name>.png"`.
- Warten auf Inhalte mit `browser_wait_for` statt festen Pausen.
- Das Browserprofil (Cookies, Logins) bleibt pro Projekt erhalten. Melde dich nie selbst irgendwo an und tippe keine Zugangsdaten ein, die der Nutzer nicht ausdrücklich für diese Aufgabe genannt hat. Bei Login-Seiten: Nutzer bitten, sich im geöffneten Fenster selbst anzumelden.
- `browser_file_upload` und `browser_run_code_unsafe` brauchen immer eine Freigabe – nur nutzen, wenn nötig.

## Bildschirmvideo einer Website
1. `browser_resize` auf die Zielgröße (z. B. 1920×1080), Seite laden, kurz warten.
2. `browser_start_video` mit `size` = Zielgröße, `cursor: true`, `filename: "work/aufnahme.webm"`.
3. Optional `browser_video_show_actions` (Aktionen werden eingeblendet) und `browser_video_chapter` für Kapitel-Karten.
4. Aktionen langsam und bewusst ausführen; zwischen Abschnitten `browser_wait_for` mit 1–2 s.
5. `browser_stop_video`, dann umwandeln:
   `ffmpeg -y -i work/aufnahme.webm -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -r 30 -movflags +faststart output/aufnahme.mp4`

## Recherche
Fakten mit Quelle (URL) festhalten. Bei widersprüchlichen Angaben beide nennen.

---
name: video
description: Videos erstellen und schneiden – aus HTML/CSS-Animationen, Screenshots, Browser-Aufnahmen, Bildern und Audio. Nutzen bei jeder Anfrage nach Video, Clip, Reel, Promo, Animation, Bildschirmaufnahme, Untertiteln oder Schnitt.
---

# Video-Pipeline

Ziel: eine fertige Datei in `output/`, mit möglichst nur einem vollständigen Render.

## 1. Rahmen festlegen
Format (16:9 = 1920×1080, 9:16 = 1080×1920, 1:1 = 1080×1080), Länge, Ton (Musik, Sprecher, ohne), Untertitel.
Fehlt etwas: sinnvolle Annahme treffen, nennen und in `CLAUDE.md` unter „Projektnotizen“ eintragen. Nur bei echten Weichen nachfragen (AskUserQuestion).

## 2. Bauweise wählen
| Quelle | Weg |
|---|---|
| Website oder Web-App zeigen | Playwright-MCP: `browser_start_video` (size = Zielgröße, `cursor: true`), Kapitel mit `browser_video_chapter`, Aktions-Overlays mit `browser_video_show_actions`, dann `browser_stop_video`. WebM → MP4 mit ffmpeg. |
| Motion-Graphics, Typo, Produkt-Promo | HTML/CSS/JS-Szene mit eigener Zeitachse → `render-frames.mjs` (siehe 4) |
| Fotos, Screenshots | Halte-Szenen oder Ken-Burns (`zoompan`) mit ffmpeg |
| Vorhandenes Material | ffmpeg schneiden, zusammenfügen, Ton anlegen |

## 3. Regeln für schnelles, sauberes Rendern
- In Zielgröße zeichnen, 30 fps, sofern nichts anderes verlangt ist.
- Eine Datei pro Szene, alle mit identischen Einstellungen: `-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -r 30`.
- Szenen ohne Neukodierung verbinden: `ffmpeg -f concat -safe 0 -i work/list.txt -c copy work/video.mp4`; Ton zum Schluss mit `-c:v copy` (bei neuem Ton zusätzlich `-map 0:v -map 1:a -shortest`).
- Überblendungen innerhalb der Szenendatei rendern, nicht zwischen fertigen Dateien – sonst wird alles doppelt kodiert.
- Erst nach `work/<name>.tmp.mp4` rendern und nach Exit-Code 0 umbenennen. Ein abgebrochener Lauf hinterlässt sonst eine abspielbare, aber unvollständige Datei.
- Standbild halten: `ffmpeg -framerate 30 -i bild.png -vf "format=yuv420p,loop=-1:1,trim=duration=4" -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p szene.mp4` (schneller als `-loop 1`).
- Seiten abfilmen: Screenshots als JPEG mit Qualität 92, nicht als PNG.
- Vor dem vollen Render 2–3 Einzelbilder der vollsten Momente in Zielgröße erzeugen und ansehen (Read auf das Bild). Erst dann rendern.
- Nachträgliche Änderungen: nur die betroffene Szene neu rendern; neuer Ton oder kürzeres Ende mit `-c:v copy`; eingebrannte Untertitel oder kleinere Kopie durch Neukodierung der fertigen Datei.

## 4. HTML-Szene → MP4
Die Szene (`work/scene.html`) definiert `window.renderFrame = (t) => { … }` und setzt damit alles auf den Zeitpunkt `t` (Sekunden): eigene Tweens, oder CSS-Animationen pausieren und per `animation-delay: -${t}s` positionieren. Keine Zufallswerte ohne festen Seed, keine Netzwerk-Ressourcen.

Rendern (pipet die Bilder direkt in ffmpeg, kein Ordner voller PNGs):
```
node .claude/skills/video/render-frames.mjs work/scene.html output/promo.mp4 --duration 12 --fps 30 --size 1920x1080
```
Braucht `playwright-core` im Projekt (`npm i -D playwright-core`, lädt keinen Browser – genutzt wird Chrome oder Edge) und ffmpeg im PATH.

## 5. Ton
- Musik: nur Material mit klarer Lizenz aus `input/`, nichts aus dem Netz ohne Freigabe des Nutzers.
- Sprecher unter Windows ohne Zusatzsoftware:
  `powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('work/vo.wav'); $s.Speak('Text'); $s.Dispose()"`
- Lautheit für Web: `-af loudnorm=I=-16:TP=-1.5:LRA=11`.

## 6. Abschluss
`ffprobe -v error -show_entries format=duration:stream=codec_name,width,height,r_frame_rate -of compact output/<datei>.mp4` prüfen und Dauer, Auflösung, Größe nennen.

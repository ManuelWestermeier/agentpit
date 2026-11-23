// Ready-made tasks for an empty session. Each one is a prompt that makes Claude set the workflow up with the
// cockpit tools (schedules, sub-sessions, databases, charts, browser identities). «…» marks what to fill in.
import { lang } from './i18n';

export interface Template { id: string; icon: string; title: string; desc: string; prompt: string }

const T: { id: string; icon: string; de: [string, string, string]; en: [string, string, string] }[] = [
  {
    id: 'monitor', icon: 'radar',
    de: ['Website überwachen', 'Prüft regelmäßig eine Seite und meldet Änderungen',
      `Überwache «URL» auf Änderungen bei «was dich interessiert, z. B. Preis, neue Stellenanzeigen, Verfügbarkeit».
- Öffne die Seite im Browser und lege fest, woran du die relevante Stelle erkennst.
- Speichere den aktuellen Stand in einer SQLite-Datenbank (db_create), mit Zeitstempel.
- Lege mit schedule_create einen Zeitplan an, der das «stündlich» wiederholt und nur dann eine kurze Meldung mit altem und neuem Wert schreibt, wenn sich etwas geändert hat.
- Zeichne den Verlauf mit db_chart, sobald es mehr als drei Messpunkte gibt.`],
    en: ['Monitor a website', 'Checks a page on a schedule and reports changes',
      `Monitor «URL» for changes in «what you care about, e.g. price, new job posts, availability».
- Open the page in the browser and decide how you recognise the relevant part.
- Store the current state with a timestamp in a SQLite database (db_create).
- Use schedule_create to repeat this «every hour» and only write a short note with old and new value when something changed.
- Chart the history with db_chart once there are more than three data points.`],
  },
  {
    id: 'pipeline', icon: 'workflow',
    de: ['Recherche → Video → Posten', 'Drei Sub-Sessions arbeiten nacheinander',
      `Baue eine Pipeline zum Thema «Thema» aus Sub-Sessions (session_create) und dem gemeinsamen Ordner ../shared-claude/pipelines/«name»/:
1. Recherche: die 5 relevantesten Quellen/Videos finden, Links und Kernaussagen als research.md ablegen.
2. Schnitt: daraus «Anzahl» kurze Clips bzw. ein Skript plus Video (ffmpeg) erzeugen, nach output/ und in den gemeinsamen Ordner.
3. Veröffentlichen: in der Browser-Identität «Identität» auf «Plattform» als Entwurf hochladen – nicht final posten, ich prüfe vorher.
Warte jeweils mit session_wait auf das Ergebnis der vorigen Stufe und fasse am Ende zusammen, was wo liegt.`],
    en: ['Research → video → post', 'Three sub-sessions work in sequence',
      `Build a pipeline on «topic» from sub-sessions (session_create) and the shared folder ../shared-claude/pipelines/«name»/:
1. Research: find the 5 most relevant sources/videos, save links and key points as research.md.
2. Edit: turn them into «number» short clips or a script plus video (ffmpeg), into output/ and the shared folder.
3. Publish: upload as a draft on «platform» using the browser identity «identity» – do not post for real, I review first.
Use session_wait for each stage's result and finish with a summary of what is where.`],
  },
  {
    id: 'briefing', icon: 'newspaper',
    de: ['Tägliches Briefing', 'Jeden Morgen eine Zusammenfassung als Datei',
      `Richte ein tägliches Briefing zu «Themen» ein:
- Lege mit schedule_create einen Cron-Zeitplan «0 8 * * 1-5» an.
- Bei jedem Lauf: aktuelle Meldungen aus «Quellen, z. B. Hacker News, bestimmte Blogs» im Browser lesen, Doppeltes zusammenführen und output/briefing-JJJJ-MM-TT.md mit höchstens 8 Punkten und Links schreiben.
- Führe den ersten Lauf jetzt sofort aus, damit ich das Format sehe.`],
    en: ['Daily briefing', 'A summary file every morning',
      `Set up a daily briefing on «topics»:
- Create a cron schedule «0 8 * * 1-5» with schedule_create.
- On every run: read current news from «sources, e.g. Hacker News, specific blogs» in the browser, merge duplicates and write output/briefing-YYYY-MM-DD.md with at most 8 points and links.
- Do the first run right now so I can see the format.`],
  },
  {
    id: 'data', icon: 'chart',
    de: ['Daten sammeln & auswerten', 'Tabelle aufbauen, abfragen, Diagramm',
      `Sammle «welche Daten, z. B. die Preise von 10 Grafikkarten bei 3 Shops» von «Quelle» und lege sie in einer SQLite-Datenbank ab (db_create, Tabellen mit db_execute).
Werte sie danach mit SQL aus (db_query) und erstelle «Diagrammtyp, z. B. ein Balkendiagramm» mit db_chart. Fasse die drei wichtigsten Erkenntnisse in einem Absatz zusammen.`],
    en: ['Collect & analyse data', 'Build a table, query it, chart it',
      `Collect «what data, e.g. the prices of 10 graphics cards at 3 shops» from «source» and store it in a SQLite database (db_create, tables via db_execute).
Then analyse it with SQL (db_query) and create «chart type, e.g. a bar chart» with db_chart. Summarise the three most important findings in one paragraph.`],
  },
  {
    id: 'app', icon: 'code',
    de: ['App bauen & laufen lassen', 'Projekt anlegen, Dev-Server als Dienst',
      `Baue «was, z. B. eine kleine Todo-App mit React und einer SQLite-API».
- Lege das Projekt hier an, installiere die Abhängigkeiten und schreibe Tests.
- Richte Frontend und API mit service_define als Dienste ein (Port, Health-Check, Neustart bei Absturz, das Frontend startet nach der API) und starte sie.
- Öffne die App im Browser, prüfe die Hauptfunktionen selbst und behebe, was nicht geht.`],
    en: ['Build & run an app', 'Create the project, dev server as a service',
      `Build «what, e.g. a small todo app with React and a SQLite API».
- Create the project here, install dependencies and write tests.
- Set up frontend and API as services with service_define (port, health check, restart on crash, frontend starts after the API) and start them.
- Open the app in the browser, check the main features yourself and fix what does not work.`],
  },
  {
    id: 'inbox', icon: 'mail',
    de: ['Postfach sichten', 'In deiner eingeloggten Identität, nur lesen',
      `Öffne in der Browser-Identität «Identität» «Webmail, z. B. Gmail» und sichte die ungelesenen Nachrichten der letzten «2 Tage».
Sortiere sie nach Dringlichkeit, fasse jede in einem Satz zusammen und schlage für die wichtigsten eine Antwort vor – nichts senden, löschen oder verschieben.`],
    en: ['Triage your inbox', 'In your logged-in identity, read-only',
      `In the browser identity «identity» open «webmail, e.g. Gmail» and go through the unread messages of the last «2 days».
Sort them by urgency, summarise each in one sentence and suggest replies for the important ones – do not send, delete or move anything.`],
  },
];

export const TEMPLATES: Template[] = T.map((x) => {
  const [title, desc, prompt] = lang === 'de' ? x.de : x.en;
  return { id: x.id, icon: x.icon, title, desc, prompt };
});

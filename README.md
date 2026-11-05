# Otterdeck

Ein Zuhause für deine Claude-Code-Sitzungen unter Windows. Projekte links, Claude und Shells in Tabs, und du siehst auf einen Blick, wo Claude arbeitet, wo es auf dich wartet und wo es fertig ist.

## Starten

- **Startmenü:** „Otterdeck“ (einmalig anlegen mit `powershell -ExecutionPolicy Bypass -File bin\install-shortcut.ps1`)
- **Terminal:** `npm start` (oder `node bin/otter.mjs`), beenden mit `node bin/otter.mjs stop`

Der Server läuft unsichtbar im Hintergrund auf `http://127.0.0.1:4747`, das Fenster ist ein Edge-App-Fenster. Fenster schließen beendet keine Sitzung; erst `otter stop` beendet alles. Beim nächsten Start setzen die Claude-Tabs ihr Gespräch fort.

## Entwickeln

```
npm install
npm run dev        # Server mit Neustart bei Änderungen + Vite auf http://127.0.0.1:5173
npm run build      # Oberfläche nach dist/web
npm run typecheck
```

## Wie es funktioniert

- **Terminals:** `node-pty` (ConPTY) startet `claude` bzw. PowerShell. Ein unsichtbares Spiegel-Terminal (`@xterm/headless`) hält den Bildschirmstand, damit ein neu geöffnetes Fenster sofort alles zeigt.
- **Status:** Jeder Claude-Tab startet mit `--settings <Hooks>`. Die Hooks (`hook/otter-hook.mjs`) melden `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Stop` usw. an den Server. Deine eigenen Claude-Einstellungen bleiben unberührt.
- **Konten:** Jedes Projekt kann ein eigenes Claude-Konto nutzen (`CLAUDE_CONFIG_DIR`, erkannt werden `~/.claude` und `~/.claude-*`). Rechtsklick auf das Projekt.
- **Sicherheit:** Der Server hört nur auf `127.0.0.1` und nimmt nur Anfragen von seiner eigenen Seite an. Hook-Meldungen tragen ein Token, das bei jedem Start neu erzeugt wird.
- **Daten:** `%APPDATA%\Otterdeck\state.json` (Projekte, Tabs), `server.log`.

## Änderungen und Dateien

Rechts neben den Tabs (ein- und ausblenden mit dem Leisten-Knopf oben rechts):

- **Änderungen:** jede geänderte Datei live, nach Ordnern, mit `+/−`. Oben der Branch mit „voraus/hinterher“ gegenüber dem Remote. Vergleich „Seit letztem Commit“ oder „Gegenüber main“ (alles, was der Branch insgesamt ändert).
- **Diff:** Klick auf eine Datei öffnet ihre Änderungen als Tab. Über der Zeilennummer erscheint beim Darüberfahren ein Sprechblasen-Knopf für eine Anmerkung. „N Anmerkungen an Claude“ schickt alle als eine Nachricht in den zuletzt benutzten Claude-Tab des Projekts (oder startet einen neuen).
- **Dateien:** der Projektordner als Baum, Klick öffnet eine Datei zum Lesen (Bilder als Vorschau).

Git liest dabei mit `--no-optional-locks`, sonst würde jede Abfrage `.git/index` neu schreiben und der Datei-Beobachter eine Endlosschleife auslösen.

## Chat-Ansicht

Jeder Claude-Tab lässt sich zwischen **Terminal** und **Chat** umschalten (Kopfzeile oder Strg+Umschalt+Leertaste). Es ist dieselbe Sitzung: Der Chat liest Claudes Transkript live mit, und was du dort schreibst, tippt Otterdeck ins Terminal.

- Deine Nachricht erscheint sofort, Claudes Antworten als formatierter Text.
- Dateiänderungen stehen als Diff im Gespräch, kleine Schritte (Lesen, Suchen, Befehle) als kompakte Zeilen mit Details beim Anklicken.
- Die aktuelle Aufgabenliste steht als Karte da.
- Fragt Claude um Erlaubnis, gibt es „Erlauben“ und „Ablehnen“; für alles andere „Im Terminal antworten“.
- Nachrichten werden getippt, nicht eingefügt: Eingefügter Text käme bei Claude als fremdes Material an.

Zum Testen von Rückfragen: Testserver mit `OTTER_CLAUDE_ARGS="--permission-mode default"` starten.

## Neue Versionen

Ändert sich Otterdecks Code, zeigt die Seitenleiste „Neue Version bereit“. Der Neustart wartet, bis kein Claude mehr arbeitet; danach setzen alle Tabs ihr Gespräch fort und das Fenster lädt sich neu. Im Terminal: `node bin/otter.mjs restart`.

## Tastenkürzel

| | |
|---|---|
| Strg+Umschalt+Enter | neuer Claude-Tab |
| Strg+Umschalt+^ | neue Shell |
| Strg+Umschalt+J | nächste Sitzung, die auf dich wartet |
| Strg+Umschalt+Leertaste | Claude-Tab: Terminal ↔ Chat |
| Strg+Umschalt+↑ / ↓ | Projekt wechseln |
| Strg+Umschalt+← / → oder 1–9 | Tab wechseln |
| Strg+C / Strg+V | kopieren (bei Auswahl) / einfügen |

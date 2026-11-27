# Otterdeck

Ein Zuhause für deine Claude-Code-Sitzungen, unter Windows und Linux. Projekte links, Claude und Shells in Tabs, und du siehst auf einen Blick, wo Claude arbeitet, wo es auf dich wartet und wo es fertig ist.

## Installieren

Windows (PowerShell, ohne Adminrechte):

```
irm https://raw.githubusercontent.com/trpwrmusic/otterdeck/master/install.ps1 | iex
```

Linux (läuft als systemd-Benutzerdienst, ohne root):

```
curl -fsSL https://raw.githubusercontent.com/trpwrmusic/otterdeck/master/install.sh | bash
```

Der Installer bringt ein eigenes Node.js mit und legt alles in einen Ordner (`%LOCALAPPDATA%\Programs\Otterdeck` bzw. `~/.local/lib/otterdeck`): `node`, `versions\<version>` und `current` (die Version, die startet). Unter Windows kommen ein Startmenü-Eintrag und der Befehl `otter` dazu. Nochmal ausführen aktualisiert. Beim ersten Start führt eine Einrichtung durch Rolle, Claude Code und Zugriff von anderen Geräten.

Optionen als Umgebungsvariablen vor dem Aufruf: `OTTER_VERSION`, `OTTER_INSTALL_DIR`, `OTTER_BUNDLE` (lokales Paket), unter Linux `OTTER_ROLE=server|desktop` (Standard: Server, wenn kein Desktop läuft).

## Starten

- **Startmenü:** „Otterdeck“
- **Terminal:** `otter` öffnet, `otter stop` beendet alles, `otter status`, `otter restart`, `otter background` (nur der Server, ohne Fenster)

Der Server läuft unsichtbar im Hintergrund auf `http://127.0.0.1:4747`, das Fenster ist ein Edge-App-Fenster. Fenster schließen beendet keine Sitzung; erst `otter stop` beendet alles. Beim nächsten Start setzen die Claude-Tabs ihr Gespräch fort.

## Einstellungen

In der Seitenleiste unter **Einstellungen**, gespeichert in `<Datenordner>/settings.json` (`%APPDATA%\Otterdeck` bzw. `~/.local/share/otterdeck`):

- **Rolle:** Arbeitsplatz (mit Fenster) oder Server (ohne Fenster, über Tailscale geöffnet, Claude meldet sich mit einem langlebigen Token an)
- **Andere Geräte:** Zugang über `tailscale serve`, nur im eigenen Tailnet und nur für das eigene Tailscale-Konto
- **Claude Code:** Programm, zusätzliche Startargumente, gemeinsames Gedächtnis aller Projekte
- **Updates:** Version, nach Updates suchen, mit einem Klick aktualisieren
- **Erweitert:** Shell, Antigravity, Tailscale-Socket und -Proxy (Userspace), NOLA, Datenordner

Umgebungsvariablen gehen weiter vor (`OTTER_SERVER`, `OTTER_PORT`, `OTTER_SERVE_PORT`, `OTTER_TAILSCALE`, `OTTER_TAILSCALE_SOCKET`, `OTTER_TAILNET_PROXY`, `OTTER_CLAUDE`, `OTTER_CLAUDE_ARGS`, `OTTER_SHELL`, `OTTER_AGY`, `OTTER_TASK_DIR`, `OTTER_NOLA_*`, `OTTER_NO_WINDOW`); die Einstellungsseite zeigt solche Felder als festgelegt. Was erst nach einem Neustart gilt, sagt die Seite selbst.

## Veröffentlichen

Ein Tag baut auf GitHub ein Paket pro System (`otterdeck-win-x64.tar.gz`, `otterdeck-linux-x64.tar.gz`) und legt ein Release an (`.github/workflows/release.yml`). Die Tag-Nachricht wird zu den Versionshinweisen in den Einstellungen.

```
# Version in package.json erhöhen, committen, dann:
git tag -a v0.3.0 -m "Was neu ist"
git push origin v0.3.0
```

Installierte Otterdecks suchen alle paar Stunden nach einem neuen Release. „Jetzt aktualisieren“ lädt das Paket, entpackt es neben die laufende Version, stellt `current` um und startet neu, sobald kein Claude mehr arbeitet. Die vorige Version bleibt liegen; zurück geht es, indem man ihren Namen in `current` schreibt. Lokal bauen: `npm run build && node bin/pack.mjs`.

Ein Git-Checkout (Entwicklung) aktualisiert sich nicht selbst: `git pull`, `npm run build`, dann meldet Otterdeck „Neue Version bereit“.

## Entwickeln

```
npm install
npm start          # aus dem Checkout starten (Startmenü-Eintrag dafür: bin\install-shortcut.ps1)
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

# Tom & Gerry Open

Tennis auf dem Centre Court im Stil von Mario Tennis: Tom (Chibi-Junge, hellblaues Polo) gegen Gerry
(Chibi-Tigerkatze mit Stirnband). Arcade-Tempo mit großen Ballbögen, gut sichtbarer Ball.
Alles entsteht beim Start aus Code: eigene WebGL2-Engine, modellierte und animierte Figuren, Fell,
Stadion mit Publikum, Ballphysik mit Spin, Ton. Keine Bibliotheken, keine Asset-Dateien, kein Netz.

## Spielen

- `tom-gerry-open.html` doppelklicken (Chrome empfohlen, Safari geht auch). Läuft ohne Server.
- Entwicklerstart mit Quellcode: `node serve.mjs`, dann http://localhost:8123 öffnen.

## Steuerung

| Aktion | Tastatur | Gamepad |
|---|---|---|
| Laufen | WASD oder Pfeiltasten | linker Stick |
| Topspin | J oder Leertaste | A |
| Slice | K | B |
| Lob | L | Y |
| Stopp | I | X |
| Pause | Esc oder P | Start |

- Schlagtaste früh drücken = mehr Kraft und Präzision. Richtung beim Schlag halten = zielen.
- Aufschlag: Taste = Ballwurf, nochmal drücken = Schlag (Timing-Anzeige).
- Spieltempo im Menü (und in der Pause): Gemütlich, Normal, Flott.

## URL-Optionen

`?demo=1` CPU gegen CPU · `?skip=1` direkt ins Match · `?player=gerry` · `?difficulty=easy|normal|hard` ·
`?pace=relaxed|normal|brisk` · `?quality=low|medium|high|ultra`

## Aufbau

- `src/gfx` Engine (Renderer, Schatten, Nachbearbeitung, Himmel, SDF-Modellierung)
- `src/chars` Tom, Gerry, Schläger, Skelett, Animation
- `src/sim` Ballphysik, Schlaglöser, Tennisregeln
- `src/game` Spiellogik, KI, Eingabe, Kamera, Regie, Wiederholungen, Spielablauf
- `src/world` Platz, Netz, Stadion, Publikum, Ball-Effekte
- `src/audio`, `src/ui` Ton und Oberfläche
- `test/` Node-Tests und Testszenen (`dev.html?scene=…`), `tools/` Build und Testwerkzeuge
- `ARCHITECTURE.md` technische Verträge zwischen den Modulen

Neu bauen: `node tools/build.mjs tom-gerry-open.html` (ohne Argument: `dist/tom-gerry-open.html`). Tests: `node tools/smoke.mjs`.

## Versionierung

- Öffentlich auf GitHub: https://github.com/thomas44999-ctrl/tom-gerry-open
- Die Git-Historie liegt außerhalb des Drive unter `~/.git-repos/tom-gerry-open.git`. Im Projektordner steht nur die
  Verweisdatei `.git`. Nicht löschen und nicht durch einen `.git`-Ordner ersetzen.
- Die gebaute `tom-gerry-open.html` ist nicht im Repo (`.gitignore`), sie entsteht aus dem Code.
- Commit-Adresse ist die GitHub-noreply-Adresse, keine private Mail. Push nur nach Toms Okay.

## Stand

- Prototyp 2 (10.10.2026): Chibi-Figuren, Cartoon-Animation (Squash & Stretch, wippender Kopf), Arcade-Tempo,
  größerer Ball, tiefere TV-Kamera, Spieler stehen zum neuen Punkt sofort bereit, Seitenwechsel ohne Gang zur Bank,
  Zeitlupen-Kameras zeigen den ganzen Kopf.

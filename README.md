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

- **Laden:** Schlagtaste drücken, der Balken neben dir füllt sich (voll nach knapp 1 s), die Figur holt dabei aus.
  Beim Treffer friert der Balken ein: Kraft = Balkenwert, danach steht das Tempo in km/h daneben. Laden bremst dich
  auf knapp die Hälfte. Leer = langsamer, sicherer Bogenball, voll = harter, flacher Ball.
- **Zielen und Risiko:** Der Kreis auf der Gegnerseite zeigt, wo der Ball landet (irgendwo darin). Richtung vor = härter,
  flacher, tiefer und riskanter, zurück = kürzer und sicherer, seitlich = Winkel. Mehr Kraft, Laufen und schlechte
  Stellung machen den Kreis größer. Rot = der Kreis reicht über eine Linie. Tiefe Bälle nicht voll durchziehen
  („Netz!“ am Balken).
- **Laufen:** Stell dich selbst zum Ball. Der Ausfallschritt im Schwung reicht nur ein Stück; ist der Ball weiter weg,
  gibt es einen Rettungsschlag (Hechtsprung, schwach) oder einen sichtbaren Fehlschlag.
- Aufschlag: Taste = Ballwurf, nochmal drücken = Schlag (Timing-Anzeige).
- Im Menü (und in der Pause): Spieltempo (Gemütlich, Normal, Flott) und Laufhilfe (Aus, Leicht, Stark; Standard Leicht).

## URL-Optionen

`?demo=1` CPU gegen CPU · `?skip=1` direkt ins Match · `?player=gerry` · `?difficulty=easy|normal|hard` ·
`?pace=relaxed|normal|brisk` · `?quality=low|medium|high|ultra` · `?seed=N`

## Aufbau

- `src/gfx` Engine (Renderer, Schatten, Nachbearbeitung, Himmel, SDF-Modellierung)
- `src/chars` Tom, Gerry, Schläger, Skelett, Animation
- `src/sim` Ballphysik, Schlaglöser, Tennisregeln
- `src/game` Spiellogik, KI, Eingabe, Kopplung Spiellogik–Figuren (`charsync.js`), Kamera, Regie, Wiederholungen, Spielablauf
- `src/world` Platz, Netz, Stadion, Publikum, Ball-Effekte
- `src/audio`, `src/ui` Ton und Oberfläche
- `test/` Node-Tests und Testszenen (`dev.html?scene=…`), `tools/` Build und Testwerkzeuge
- `ARCHITECTURE.md` technische Verträge zwischen den Modulen

Neu bauen: `node tools/build.mjs tom-gerry-open.html` (ohne Argument: `dist/tom-gerry-open.html`). Tests: `node tools/smoke.mjs`
(alle Node-Tests und Dev-Szenen headless; Chrome/Chromium wird unter macOS und Linux gefunden, `CHROME=…` überschreibt),
Balance: `node test/match.test.mjs`, Schlagkern: `node test/stroke.test.mjs`.

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
- Prototyp 3 „Schlaggefühl“, Teil A (10.10.2026): Powerbalken (Kraft = Balken, Laden bremst, km/h nach dem Treffer),
  Ausholen ab Tastendruck und kurzer schneller Schwung, echte Treffer (enger Trefferradius nach dem Ausfallschritt,
  sichtbarer Fehlschlag, Rettungsschlag), Schläger trifft den Ball sichtbar (Test: ≤ 5 cm), Treffer-Stopp, Blitz und
  kräftiger Ton bei starken Schlägen, Zielkreis statt verdecktem Würfel (Risiko über Richtung, Kraft, Stellung),
  Netzfehler nur bei tiefem Ball mit voller Kraft, Laufhilfe als Einstellung (Standard Leicht). Die KI nutzt dasselbe
  System. Teil B (Landepunkt-Markierung, Sichtbarkeit am fernen Ende, Format „Satz bis 3“, KI-Feinschliff) folgt nach
  Toms Rückmeldung.

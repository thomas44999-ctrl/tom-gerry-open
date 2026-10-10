// Einstieg "Tom & Gerry Open" (ARCHITECTURE §11): Renderer, UI, Audio, Welt, Figuren, Regie -> Game.
// URL: ?skip=1 ?demo=1 ?player=tom|gerry ?difficulty=easy|normal|hard ?format=tiebreak|short|set|bo3
//      ?quality=auto|low|medium|high|ultra ?seed=N ?dynres=0
import { Renderer } from './gfx/renderer.js';
import { params, nextFrame } from './core/util.js';
import { UI, loadSettings } from './ui/ui.js';
import { AudioSystem } from './audio/audio.js';
import { buildWorld } from './world/world.js';
import { buildTom } from './chars/tom.js';
import { buildGerry } from './chars/gerry.js';
import { buildRacket } from './chars/racket.js';
import { Character } from './chars/character.js';
import { Director } from './game/director.js';
import { Game } from './game/game.js';

const QUALITIES = ['low', 'medium', 'high', 'ultra'];

/** Vollbild-Fehlermeldung (z. B. ohne WebGL2). */
function fatal(title, msg, err) {
  const el = document.getElementById('tg-fatal');
  if (!el) return;
  el.querySelector('h1').textContent = title;
  el.querySelector('.msg').textContent = msg;
  el.querySelector('pre').textContent = err ? String((err && (err.stack || err.message)) || err).split('\n').slice(0, 6).join('\n') : '';
  if (!err) el.querySelector('pre').style.display = 'none';
  el.style.display = 'flex';
}

function hasWebGL2() {
  try { const c = document.createElement('canvas'); return !!(window.WebGL2RenderingContext && c.getContext('webgl2')); } catch { return false; }
}

async function boot() {
  const canvas = document.getElementById('c');
  if (!hasWebGL2()) {
    fatal('WebGL 2 wird benötigt', 'Dein Browser oder deine Grafikkarte unterstützt kein WebGL 2. Bitte nutze einen aktuellen Chrome, Edge, Firefox oder Safari mit aktivierter Hardwarebeschleunigung.');
    return;
  }
  const ui = new UI(document.body);
  ui.loader.set(0.01, 'Grafik');
  await nextFrame();

  // Qualität: URL > Einstellungen; 'auto' = hoch mit dynamischer Auflösung
  const saved = loadSettings();
  const qWish = params.get('quality', saved.quality || 'auto');
  const qName = QUALITIES.includes(qWish) ? qWish : 'high';
  let renderer;
  try {
    renderer = new Renderer(canvas, { quality: qName, dynamicResolution: params.bool('dynres', true), minScale: 0.6, maxScale: 1.0 });
  } catch (e) {
    fatal('Grafik konnte nicht gestartet werden', 'WebGL 2 ließ sich nicht initialisieren.', e);
    return;
  }
  const audio = new AudioSystem({ titleMusic: true });

  // Welt (0.03 .. 0.62)
  const world = await buildWorld(renderer, { onProgress: (p, label) => ui.loader.set(0.03 + p * 0.59, label ? `Stadion · ${label}` : 'Stadion') });

  // Figuren (0.62 .. 0.97)
  ui.loader.set(0.63, 'Tom');
  await nextFrame();
  const tomAsset = buildTom(renderer, renderer.q);
  ui.loader.set(0.76, 'Gerry');
  await nextFrame();
  const gerryAsset = buildGerry(renderer, renderer.q);
  ui.loader.set(0.9, 'Schläger');
  await nextFrame();
  const chars = [
    new Character(renderer, tomAsset, buildRacket(renderer, tomAsset.racketStyle)),
    new Character(renderer, gerryAsset, buildRacket(renderer, gerryAsset.racketStyle)),
  ];
  for (const c of chars) c.update(0);
  ui.loader.set(0.92, 'Shader');
  await renderer.precompile([...chars[0].drawables, ...chars[1].drawables], (p) => ui.loader.set(0.92 + p * 0.06, 'Shader'));

  const director = new Director({ renderer, world });
  const game = new Game({ renderer, ui, audio, world, chars, director, canvas, quality: qWish });
  ui.loader.set(1, 'Anpfiff');
  await nextFrame();
  game.start();
  ui.loader.hide();
}

window.addEventListener('error', (ev) => { if (!document.querySelector('.tg-ui')) fatal('Fehler beim Start', 'Das Spiel konnte nicht geladen werden.', ev.error || ev.message); });
boot().catch((e) => {
  console.error(e);
  fatal('Fehler beim Start', 'Beim Laden des Spiels ist ein Fehler aufgetreten.', e);
});

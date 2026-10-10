// SCHLAGKERN-Test (Prototyp 3): KI gegen KI mit echten Figuren (ohne GPU), gekoppelt wie im Spiel (CharSync).
// Prüft: Im Kontaktbild liegt der gezeichnete Schläger-Sweet-Spot höchstens 5 cm vom gezeichneten Ball entfernt;
// Fehlschläge bleiben sichtbar daneben; Powerbalken = ausgeführte Kraft; Ausholpose sichtbar vor dem Schwung.
//   node test/stroke.test.mjs [--points N] [--verbose]
import { Match } from '../src/game/match.js';
import { CharSync } from '../src/game/charsync.js';
import { Character } from '../src/chars/character.js';
import { buildTom } from '../src/chars/tom.js';
import { buildGerry } from '../src/chars/gerry.js';
import { buildRacket } from '../src/chars/racket.js';
import { HIT, CHARGE } from '../src/sim/strokes.js';

const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const NPTS = args.includes('--points') ? +args[args.indexOf('--points') + 1] : 40;

let failures = 0, passes = 0;
const ok = (cond, msg) => { if (cond) passes++; else { failures++; console.log('  FAIL: ' + msg); } };

const fake = { q: { name: 'low', furShells: 4 }, createMesh: (m) => ({ data: m }), createMaterial: (o) => ({ ...o }), createTexture: () => ({}) };
const t0 = performance.now();
const tomA = buildTom(fake), gerryA = buildGerry(fake, fake.q);
const chars = [
  new Character(null, tomA, buildRacket(fake, tomA.racketStyle)),
  new Character(null, gerryA, buildRacket(fake, gerryA.racketStyle)),
];
console.log(`Figuren gebaut (${((performance.now() - t0) / 1000).toFixed(1)} s)`);

function run(diffs, seed) {
  const m = new Match({ humans: [], difficulty: diffs, seed, format: { sets: 1 }, breakOnHit: true });
  const sync = new CharSync(m, chars);
  sync.placeAll();
  const ball = new Float32Array(3), sw = new Float32Array(3);
  const res = { points: 0, missMin: [], chargeShown: 0, chargeChecks: 0, powerOk: 0, powerN: 0, hits: 0, maxCharge: [0, 0] };
  const pendingMiss = [];
  const DT = 1 / 60;
  for (let f = 0; f < 60 * 60 * 20 && res.points < NPTS && !m.state.over; f++) {
    m.step(DT);
    const ev = m.drainEvents();
    for (const e of ev) {
      sync.event(e);
      if (e.type === 'point') res.points++;
      if (e.type === 'phase' && e.phase === 'pre_serve') sync.placeAll();
      if (e.type === 'stroke_start' && e.miss) pendingMiss.push({ player: e.player, t: e.contactTime, min: 1e9 });
      if (e.type === 'hit' && !e.serve) {
        res.powerN++;
        // Kraft = Balkenwert beim Treffer (Balken = Zeit seit Tastendruck / CHARGE.fill; Rettung: gedeckelt)
        const bar = Math.min(1, Math.max(0, (e.time - e.pressTime) / CHARGE.fill));
        const cap = e.rescue ? HIT.rescuePower : 1;
        if (Math.abs(e.bar - bar) < 1e-9 && Math.abs(e.power - Math.min(cap, bar)) < 1e-9) res.powerOk++;
      }
    }
    sync.advance();
    sync.ballPos(ball);
    // Ausholpose sichtbar: während des Ladens dreht die Figur auf (Aktion 'charge' mit Gewicht)
    for (let i = 0; i < 2; i++) {
      const p = m.players[i], c = chars[i];
      if (p.pending && !p.stroke && p.charge > 0.5 && m.state.phase === 'rally') {
        res.chargeChecks++;
        if (c.action && c.action.kind === 'charge' && c.action.w > 0.5) res.chargeShown++;
      }
    }
    // Fehlschläge: kleinster Abstand Sweet-Spot <-> Ball um den Schwungzeitpunkt
    for (const pm of pendingMiss) {
      if (Math.abs(m.time - pm.t) < 0.05) { chars[pm.player].getRacketSweetSpot(sw); pm.min = Math.min(pm.min, Math.hypot(sw[0] - ball[0], sw[1] - ball[1], sw[2] - ball[2])); }
    }
    while (pendingMiss.length && m.time > pendingMiss[0].t + 0.06) { res.missMin.push(pendingMiss.shift().min); }
  }
  res.stats = sync.stats;
  return res;
}

const all = { list: [], raw: [], max: 0, missMin: [], chargeShown: 0, chargeChecks: 0, powerOk: 0, powerN: 0 };
for (const [diffs, seed] of [[['normal', 'normal'], 3], [['hard', 'easy'], 4]]) {
  const r = run(diffs, seed);
  all.list.push(...r.stats.list); all.raw.push(...r.stats.raw); all.max = Math.max(all.max, r.stats.max);
  all.missMin.push(...r.missMin);
  all.chargeShown += r.chargeShown; all.chargeChecks += r.chargeChecks; all.powerOk += r.powerOk; all.powerN += r.powerN;
  if (VERBOSE) console.log(`  ${diffs}: ${r.points} Punkte, ${r.stats.hits} Kontaktbilder, max ${(r.stats.max * 100).toFixed(1)} cm`);
}
const sorted = all.list.slice().sort((a, b) => a - b);
const pc = (f) => (sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))] * 100).toFixed(1) : '–');
console.log(`  Kontaktbilder: ${sorted.length}, Abstand Sweet-Spot–Ball Median ${pc(0.5)} cm, 95 % ${pc(0.95)} cm, max ${(all.max * 100).toFixed(1)} cm`);
const raw = all.raw.slice().sort((a, b) => a - b);
const rq = (f) => (raw.length ? (raw[Math.min(raw.length - 1, Math.floor(raw.length * f))] * 100).toFixed(1) : '–');
console.log(`  ohne Ballmagnet (nur Arm-IK): Median ${rq(0.5)} cm, 95 % ${rq(0.95)} cm, max ${rq(1)} cm (Magnet schließt höchstens ${HIT.magnet * 100} cm)`);
console.log(`  Fehlschläge: ${all.missMin.length}, kleinster Abstand Schläger–Ball ${all.missMin.length ? (Math.min(...all.missMin) * 100).toFixed(0) : '–'} cm`);
console.log(`  Ausholpose beim Laden sichtbar: ${all.chargeShown}/${all.chargeChecks} Bilder; Kraft = Balken: ${all.powerOk}/${all.powerN}`);
ok(sorted.length > 100, `genug Kontaktbilder (${sorted.length})`);
ok(all.max <= 0.05, `Schlägermitte beim Kontakt <= 5 cm vom Ball (max ${(all.max * 100).toFixed(1)} cm)`);
ok(raw.length && raw[raw.length - 1] <= HIT.magnet + 0.05, `ohne Magnet höchstens ${HIT.magnet * 100} cm + 5 cm Lücke (max ${rq(1)} cm)`);
ok(all.missMin.every((d) => d > 0.2), 'Fehlschläge: Schläger bleibt sichtbar > 20 cm vom Ball');
ok(all.chargeChecks > 50 && all.chargeShown / all.chargeChecks > 0.95, 'Ausholpose während des Ladens');
ok(all.powerN > 50 && all.powerOk === all.powerN, 'ausgeführte Kraft = Balkenwert');
console.log(`\nstroke.test: ${passes} bestanden, ${failures} fehlgeschlagen`);
process.exit(failures ? 1 : 0);

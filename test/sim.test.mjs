// Tests + Plausibilitätsbericht für src/sim/court.js, ball.js, shot.js.
// Aufruf: node test/sim.test.mjs   (Bericht auf stdout, Exit 1 bei Fehlern)
import { COURT, SURFACES, netHeightAt, isInSingles, inServiceBox, courtHalf, describeMiss, describeServeMiss, lineDistance, serviceBoxRect } from '../src/sim/court.js';
import { BALL, Ball, predict, RPM, toRpm, spinFromLocal, spinToLocal, Trajectory, findBounces, timeToHeight, positionAt, simulateFlight, aeroAt } from '../src/sim/ball.js';
import { solveShot, checkShot, presetParams, SHOT_PRESETS, maxSpeedFor, aimTarget, serveTarget } from '../src/sim/shot.js';
import { PLAYER_STATS } from '../src/sim/strokes.js';
import { makeRng } from '../src/core/math.js';

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.stack.split('\n').slice(0, 2).join('\n    ')}`); }
}
function ok(c, msg = 'Bedingung verletzt') { if (!c) throw new Error(msg); }
function near(a, b, tol, msg = '') { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg} ${a} ≉ ${b} (±${tol})`); }
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
const kmh = (v) => v * 3.6;
const deg = (r) => (r * 180) / Math.PI;
const R = BALL.radius;
const report = [];
const line = (s = '') => report.push(s);
line('═══ Ballphysik – Plausibilität (Rasen, 120 Hz, RK4, Drag + Magnus + Cross/Brody-Absprung) ═══════════');

/** Schlag simulieren und Kennzahlen messen (mit Ball.step – echte Spielphysik). */
function measure(from, vel, spin, opts = {}) {
  const b = new Ball();
  if (opts.surface) b.surface = opts.surface;
  b.launch(from, vel, spin);
  const tr = predict(b, opts.tMax ?? 6, BALL.dt, { out: new Trajectory(900) });
  const b0 = tr.bounce(0), b1 = tr.bounce(1);
  const m = { tr, b0, b1, clr: tr.netClearance, apex: tr.apexY, netHit: tr.netHit, netCord: tr.netCord };
  if (b0) {
    m.land = b0.pos; m.t = b0.t;
    m.vIn = Math.hypot(b0.velIn[0], b0.velIn[1], b0.velIn[2]);
    m.vOut = Math.hypot(b0.vel[0], b0.vel[1], b0.vel[2]);
    m.hIn = Math.hypot(b0.velIn[0], b0.velIn[2]); m.hOut = Math.hypot(b0.vel[0], b0.vel[2]);
    m.angIn = deg(Math.atan2(-b0.velIn[1], m.hIn)); m.angOut = deg(Math.atan2(b0.vel[1], m.hOut));
    const mh = tr.maxHeightBetween(b0.t + 1e-6, b1 ? b1.t : tr.duration);
    m.apex2 = mh.y; m.apex2T = mh.t;
    m.b1z = b1 ? b1.pos[2] : NaN;
  }
  return m;
}
const launchVel = (speed, elevDeg, dirX, dirZ) => {
  const l = Math.hypot(dirX, dirZ), th = elevDeg * Math.PI / 180;
  return [speed * Math.cos(th) * dirX / l, speed * Math.sin(th), speed * Math.cos(th) * dirZ / l];
};

// =================================================================== Court
test('Netzhöhe: 0.914 Mitte, 1.07 an Einzelstützen und Pfosten, Durchhang dazwischen', () => {
  near(netHeightAt(0), 0.914, 1e-9); near(netHeightAt(5.029), 1.07, 1e-9); near(netHeightAt(-5.029), 1.07, 1e-9);
  near(netHeightAt(6.0), 1.07, 1e-9); eq0(netHeightAt(7)); ok(netHeightAt(2.5) > 0.914 && netHeightAt(2.5) < 1.07);
  near(netHeightAt(2.5), 0.914 + 0.156 * (2.5 / 5.029) ** 2, 1e-9);
});
function eq0(x) { ok(x === 0, 'erwartet 0, erhalten ' + x); }

test('Einzelfeld: Linie berührt = gut (Abdruck-Radius)', () => {
  ok(isInSingles(0, 0)); ok(isInSingles(4.115, 11.885)); ok(isInSingles(4.13, 0), 'Abdruck überlappt Linie');
  ok(!isInSingles(4.14, 0)); ok(!isInSingles(0, 11.91)); ok(isInSingles(-4.12, -11.89));
  ok(isInSingles(4.14, 0, 0.03), 'größerer Abdruck');
  ok(courtHalf(3) === 1 && courtHalf(-0.1) === -1);
});

test('Aufschlagfelder: alle vier Kombinationen (Seite × deuce/ad) inkl. Mittellinie', () => {
  // Aufschläger Seite +1 (z>0, blickt nach -Z, rechts = +X). Deuce = rechts vom Aufschläger -> Ziel diagonal bei x<0.
  ok(inServiceBox(-2, -4, 1, 'deuce')); ok(!inServiceBox(2, -4, 1, 'deuce')); ok(inServiceBox(2, -4, 1, 'ad'));
  ok(inServiceBox(2, 4, -1, 'deuce')); ok(inServiceBox(-2, 4, -1, 'ad')); ok(!inServiceBox(-2, 4, -1, 'deuce'));
  ok(!inServiceBox(-2, 4, 1, 'deuce'), 'eigene Hälfte');
  ok(inServiceBox(0.03, -3, 1, 'deuce'), 'auf der Mittellinie = gut');
  ok(!inServiceBox(0.08, -3, 1, 'deuce'));
  ok(inServiceBox(-2, -6.41, 1, 'deuce'), 'Aufschlaglinie berührt');
  ok(!inServiceBox(-2, -6.45, 1, 'deuce'));
  ok(!inServiceBox(-4.2, -3, 1, 'deuce'));
  const r = serviceBoxRect(1, 'deuce');
  ok(r.xMax <= 0.03 && r.xMin < -4 && r.zMin < -6 && r.zMax === 0);
  // Positionen aus serveTarget liegen im Feld
  for (const side of [1, -1]) for (const box of ['deuce', 'ad']) for (const lr of [-1, 0, 1]) {
    const t = serveTarget(side, box, lr, 0.5);
    ok(inServiceBox(t.x, t.z, side, box), `serveTarget ${side} ${box} ${lr}`);
  }
});

test('describeMiss / lineDistance (Hawk-Eye)', () => {
  const m = describeMiss(0, -12.0);
  near(m.long, 12.0 - 0.02 - 11.885, 1e-9); ok(!m.in && m.wide === 0);
  const w = describeMiss(4.3, 5); near(w.wide, 4.3 - 0.02 - 4.115, 1e-9);
  ok(describeMiss(4.1, 11).in);
  const ld = lineDistance(1, -11.9);
  ok(ld.line === 'baseline' && ld.in && ld.dist > 0 && ld.dist < 0.01, 'knapp drin: ' + JSON.stringify(ld));
  const lo = lineDistance(1, -11.95); ok(lo.line === 'baseline' && !lo.in);
  near(lo.dist, -(11.95 - 0.02 - 11.885), 1e-9);
  const ls = lineDistance(-4.2, 3); ok(ls.line === 'sideline' && !ls.in && ls.lineX === -4.115);
  const sv = lineDistance(-1, -6.43, { serverSide: 1, box: 'deuce' }); ok(sv.line === 'service' && !sv.in);
  const sc = lineDistance(0.04, -3, { serverSide: 1, box: 'deuce' }); ok(sc.line === 'centre' && sc.in === true, JSON.stringify(sc));
  const so = lineDistance(0.05, -3, { serverSide: 1, box: 'deuce' }); ok(so.line === 'centre' && !so.in && Math.abs(so.dist + 0.005) < 1e-9, JSON.stringify(so));
  const sm = describeServeMiss(2, -3, 1, 'deuce'); ok(!sm.in && sm.centre > 1.9);
});

// =================================================================== Ball: Grundlagen
test('Aerodynamik: Cd ~0.55, C_L = 1/(2 + v/(rω)), Magnus-Richtung ω×v', () => {
  const a = aeroAt([0, 0, -40], [0, 0, 0]); near(a.cd, 0.55, 1e-9); ok(a.cl === 0);
  const w = spinFromLocal([0, 0, 0], 0, -1, 2500 * RPM);
  const b = aeroAt([0, 0, -30], w);
  near(b.cl, 1 / (2 + 30 / (R * 2500 * RPM)), 1e-9);
  ok(b.cd > 0.55 && b.cd < 0.8, 'Spin erhöht Widerstand leicht: ' + b.cd);
  // Topspin -> Magnus nach unten; Unterschnitt -> nach oben; Seitwärts +side -> Kurve nach rechts
  const top = measure([0, 1, 11], launchVel(28, 8, 0, -1), spinFromLocal([0, 0, 0], 0, -1, 2500 * RPM));
  const flat = measure([0, 1, 11], launchVel(28, 8, 0, -1), [0, 0, 0]);
  const back = measure([0, 1, 11], launchVel(28, 8, 0, -1), spinFromLocal([0, 0, 0], 0, -1, -1500 * RPM));
  ok(top.land[2] > flat.land[2] && flat.land[2] > back.land[2], `Topspin kürzer, Slice länger: ${f(top.land[2])} ${f(flat.land[2])} ${f(back.land[2])}`);
  // Spieler auf Seite +1 blickt nach -Z, seine rechte Seite ist +X
  const side = measure([0, 1, 11], launchVel(28, 8, 0, -1), spinFromLocal([0, 0, 0], 0, -1, 0, 1500 * RPM));
  ok(side.land[0] > 0.3, 'side > 0 krümmt nach rechts (+X für Seite +1): ' + f(side.land[0]));
  const l = spinToLocal(spinFromLocal([0, 0, 0], 0.3, -1, 100, 50, 20), 0.3, -1);
  near(l.top, 100, 1e-9); near(l.side, 50, 1e-9); near(l.rifle, 20, 1e-9);
  near(toRpm(2500 * RPM), 2500, 1e-9);
});

test('Determinismus: predict() == Ball.step() bitgenau; step(1/60) == 2×step(1/120)', () => {
  const v = launchVel(31, 9, -0.1, -1), w = spinFromLocal([0, 0, 0], -0.1, -1, 2600 * RPM);
  const b = new Ball(); b.launch([0.5, 1, 11.5], v, w);
  const tr = predict(b, 2.0, BALL.dt, { out: new Trajectory(600) });
  const c = new Ball(); c.launch([0.5, 1, 11.5], v, w);
  let maxD = 0;
  for (let i = 1; i <= 240; i++) {
    c.step();
    const p = tr.positionAt(i * BALL.dt);
    maxD = Math.max(maxD, Math.hypot(p[0] - c.pos[0], p[1] - c.pos[1], p[2] - c.pos[2]));
  }
  ok(maxD < 1e-9, 'Abweichung predict/step ' + maxD);
  const d = new Ball(); d.launch([0.5, 1, 11.5], v, w);
  const e = new Ball(); e.launch([0.5, 1, 11.5], v, w);
  for (let i = 0; i < 120; i++) { d.step(1 / 60); e.step(); e.step(); }
  ok(Math.hypot(d.pos[0] - e.pos[0], d.pos[1] - e.pos[1], d.pos[2] - e.pos[2]) < 1e-12, 'Teilschritte');
  ok(d.bounces === e.bounces);
  // grobe Samples (dt = 1/60) liefern dieselbe Bahn wie Ball.step(1/60)
  const tr60 = predict(b, 2.0, 1 / 60, { out: new Trajectory(200) });
  const g = new Ball(); g.launch([0.5, 1, 11.5], v, w);
  let maxD60 = 0;
  for (let i = 1; i <= 120; i++) { g.step(1 / 60); const p = tr60.positionAt(i / 60); maxD60 = Math.max(maxD60, Math.hypot(p[0] - g.pos[0], p[1] - g.pos[1], p[2] - g.pos[2])); }
  ok(maxD60 < 1e-9, 'predict(dt=1/60) vs step(1/60): ' + maxD60);
});

test('Kein Tunneln: 45–70 m/s ins Netz (Masche und Band)', () => {
  for (const sp of [45, 55, 62, 70]) for (const y of [0.3, 0.6, 0.85, 0.9]) {
    const b = new Ball(); b.launch([0.2, y, 11.8], [0, 0.02, -sp], [0, 0, 0]);
    let net = false;
    for (let i = 0; i < 120 && !net; i++) for (const e of b.step()) if (e.type === 'net') net = true;
    ok(net, `Netz bei ${sp} m/s, y=${y}`);
    for (let i = 0; i < 240; i++) b.step();
    ok(b.pos[2] > 0, `Ball bleibt auf der Seite des Schlagenden (${sp} m/s, y=${y}): z=${f(b.pos[2])}`);
  }
});

test('Pfosten/Einzelstütze: Kollision und Abprall', () => {
  const b = new Ball(); b.launch([5.029, 0.6, 3], [0, 0.5, -20], [0, 0, 0]);
  let post = null;
  for (let i = 0; i < 60 && !post; i++) for (const e of b.step()) if (e.type === 'post') post = e;
  ok(post && post.which === 'stick', 'Einzelstütze getroffen');
  ok(b.vel[2] > 0, 'prallt zurück');
});

test('Ball kommt zur Ruhe (Rollen mit Reibung), Ereignis rest, inPlay=false', () => {
  const b = new Ball();
  b.launch([1, 1, 8], [0.4, 2.5, -9], spinFromLocal([0, 0, 0], 0.04, -1, 1200 * RPM));
  let t = 0, rest = null, bounces = 0;
  while (t < 20 && !rest) { for (const e of b.step()) { if (e.type === 'rest') rest = e; if (e.type === 'bounce') bounces++; } t += BALL.dt; }
  ok(rest, 'rest-Ereignis'); ok(b.mode === 'rest' && !b.inPlay);
  ok(t < 12, 'liegt nach < 12 s: ' + f(t));
  ok(bounces >= 4, 'mehrere Aufsprünge vor dem Rollen');
  line(`Ruhe:       Ball (9.7 m/s) liegt nach ${f(t, 2)} s, ${bounces} Aufsprüngen bei (${f(b.pos[0])}, ${f(b.pos[2])})`);
});

test('Trajectory-Helfer: Aufsprünge, Höhen, Positionen', () => {
  const b = new Ball(); b.launch([0, 1, 11.5], launchVel(30, 10, 0, -1), spinFromLocal([0, 0, 0], 0, -1, 2500 * RPM));
  const tr = predict(b, 3);
  const bs = findBounces(tr);
  ok(bs.length >= 2 && bs[0].t > 0.5 && Math.abs(bs[0].pos[1] - R) < 1e-9);
  const t1 = timeToHeight(tr, 1.0, bs[0].t, true);
  ok(t1 > bs[0].t || t1 === -1);
  const p = positionAt(tr, bs[0].t);
  near(p[1], R, 1e-6); near(p[2], bs[0].pos[2], 1e-6);
  const tz = tr.timeToZ(0);
  ok(tz > 0 && tz < bs[0].t);
  const s = tr.sample(3);
  ok(s.t > 0 && s.pos[1] > 1);
  // Netzdurchgang-Messung stimmt mit Positionen überein
  near(positionAt(tr, tr.netT)[2], 0, 2e-3);
});

// =================================================================== Plausibilitätsbericht
test('Referenz: 30 m/s Topspin-Vorhand, 2500 U/min, Abflug (0.5, 1.0, 11.5)', () => {
  // Abflugwinkel so gewählt, dass der Ball ~1.5 m vor der Grundlinie landet (Löser), dann mit Ball.step gemessen.
  const sol = solveShot({ from: [0.5, 1.0, 11.5], target: { x: -0.5, z: -10.4 }, spin: { top: 2500 }, speed: 30 });
  ok(sol.ok);
  const m = measure([0.5, 1.0, 11.5], sol.vel, sol.spin);
  line(`Topspin 30:  Abflug ${f(deg(sol.elevation), 1)}°, Flug ${f(m.t)} s, Weite ${f(Math.hypot(m.land[0] - 0.5, m.land[2] - 11.5), 1)} m, ` +
    `Netz +${f(m.clr)} m, Scheitel ${f(m.apex)} m, Aufprall ${f(kmh(m.vIn), 0)} km/h @${f(m.angIn, 1)}° → ` +
    `${f(kmh(m.vOut), 0)} km/h @${f(m.angOut, 1)}°, Absprunghöhe ${f(m.apex2)} m`);
  ok(m.clr > 0.5 && m.clr < 2.0, 'Netzabstand typisch 0.5–2 m');
  ok(m.apex > 1.4 && m.apex < 3.0, 'Scheitel');
  ok(m.vIn > 14 && m.vIn < 22, 'Ankunftstempo ~50–70 % des Abflugtempos');
  ok(m.apex2 > 0.7 && m.apex2 < 1.4, 'Absprunghöhe Rasen ~0.7–1.4 m');
  ok(m.t > 0.8 && m.t < 1.3);
});

test('Absprung: gleicher Einfall (19 m/s @ 18°) – Topspin / flach / Slice', () => {
  const rows = [];
  for (const [name, rpm] of [['Topspin', 2500], ['flach', 0], ['Slice', -1500]]) {
    const v = [0, -19 * Math.sin(18 * Math.PI / 180), -19 * Math.cos(18 * Math.PI / 180)];
    const b = new Ball(); b.launch([0, R + 1e-4, -2], v, spinFromLocal([0, 0, 0], 0, -1, rpm * RPM));
    let ev = null; for (let i = 0; i < 4 && !ev; i++) for (const e of b.step()) if (e.type === 'bounce') ev = e;
    const hOut = Math.hypot(ev.vel[0], ev.vel[2]);
    const spinOut = spinToLocal(b.spin, ev.vel[0], ev.vel[2]).top;
    rows.push({ name, hOut, ang: deg(Math.atan2(ev.vel[1], hOut)), grip: ev.grip, spinOut: toRpm(spinOut) });
  }
  for (const r of rows) line(`Absprung:    ${r.name.padEnd(8)} raus ${f(kmh(r.hOut), 0)} km/h horizontal @${f(r.ang, 1)}°  ${r.grip ? 'haftet' : 'rutscht'}, Drall danach ${f(r.spinOut, 0)} U/min`);
  ok(rows[0].hOut > rows[1].hOut, 'Topspin springt schneller nach vorn ab ("kickt")');
  ok(rows[0].ang < rows[1].ang + 0.01, 'Topspin flacher/schneller');
  ok(rows[2].hOut <= rows[1].hOut + 0.05, 'Slice verliert mindestens so viel Tempo (Gleiten: gleicher Reibstoß)');
  ok(rows.every((r) => r.spinOut > 0), 'nach dem Aufsprung immer Vorwärtsdrall');
});

test('Absprung im Spiel: Topspin kickt hoch, Slice rutscht flach (gleiches Ziel, gleiche Kraft)', () => {
  const from = [0.5, 1.0, 11.5], target = { x: -1, z: -9.6 };
  const res = {};
  for (const type of ['topspin', 'flat', 'slice']) {
    const s = solveShot({ from, target, spin: type, power: 0.7 });
    ok(s.ok, type);
    const m = measure(from, s.vel, s.spin);
    const tz = m.tr.timeToZ(-12.5, m.b0.t);
    res[type] = { s, m, hBase: tz > 0 ? m.tr.positionAt(tz)[1] : NaN };
    line(`Im Spiel:    ${type.padEnd(8)} ${f(kmh(s.speed), 0)} km/h, ${f(presetParams(type, 0.7).topRpm, 0).padStart(5)} U/min → Einfall ${f(m.angIn, 1)}°, ` +
      `Absprung @${f(m.angOut, 1)}° auf ${f(m.apex2)} m, Höhe an der Grundlinie+0.6 m: ${f(res[type].hBase)} m`);
  }
  ok(res.topspin.m.apex2 > res.flat.m.apex2 + 0.1, 'Topspin springt höher als flach');
  ok(res.flat.m.apex2 > res.slice.m.apex2, 'Slice bleibt am flachsten');
  ok(res.slice.m.apex2 < 0.65, 'Slice bleibt unter Kniehöhe+');
});

test('Rasen vs. Hartplatz vs. Sand: CPR, Absprunghöhe', () => {
  const out = {};
  for (const name of ['grass', 'hard', 'clay']) {
    const b = new Ball(); b.surface = SURFACES[name]; b.walls = null;
    const th = 16 * Math.PI / 180;
    b.launch([0, 0.1, 5], [0, -30 * Math.sin(th), -30 * Math.cos(th)], [0, 0, 0]);
    let ev = null; for (let i = 0; i < 60 && !ev; i++) for (const e of b.step()) if (e.type === 'bounce') ev = e;
    const e = ev.vel[1] / -ev.velIn[1];
    const mu = (Math.abs(ev.velIn[2]) - Math.abs(ev.vel[2])) / ((1 + e) * -ev.velIn[1]);
    const cpr = 100 * (1 - mu) + 150 * (0.81 - e);
    const m = measure([0.5, 1.0, 11.5], ...(() => { const s = solveShot({ from: [0.5, 1, 11.5], target: { x: 0, z: -9.6 }, spin: 'topspin', power: 0.7 }); return [s.vel, s.spin]; })(), { surface: SURFACES[name] });
    out[name] = { cpr, apex2: m.apex2, hOut: m.hOut };
    line(`Belag:       ${name.padEnd(6)} ITF-CPR ${f(cpr, 1)} (e=${f(e, 3)}, μ=${f(mu, 3)}), Topspin-Absprung ${f(m.apex2)} m, raus ${f(kmh(m.hOut), 0)} km/h`);
  }
  ok(out.grass.cpr > 45, 'Rasen = schnell (CPR ≥ 45)');
  ok(out.hard.cpr > 30 && out.hard.cpr < 45, 'Hartplatz = mittel');
  ok(out.clay.cpr < 30, 'Sand = langsam');
  ok(out.grass.apex2 < out.hard.apex2 && out.grass.hOut > out.hard.hOut, 'Rasen: flacher & schneller');
});

test('Aufschlag 55 m/s (198 km/h) ins Feld', () => {
  const from = [0.5, 2.7, 12.1];
  for (const [label, tgt] of [['T', { x: -0.3, z: -5.8 }], ['außen', { x: -3.6, z: -5.6 }]]) {
    const s = solveShot({ from, target: tgt, spin: 'serve_flat', speed: 55 });
    ok(s.ok && !s.adjusted, 'Aufschlag lösbar ' + label + ' ' + s.reason);
    const m = measure(from, s.vel, s.spin);
    ok(inServiceBox(m.land[0], m.land[2], 1, 'deuce'), 'im Deuce-Feld');
    const tz = m.tr.timeToZ(-12.5);
    const vR = Math.hypot(...m.tr.velocityAt(tz));
    line(`Aufschlag:   flach 198 km/h (${label}) aus 2.70 m: Abflug ${f(deg(s.elevation), 1)}°, Netz +${f(m.clr)} m, Aufsprung nach ${f(m.t)} s mit ${f(kmh(m.vIn), 0)} km/h, ` +
      `Absprung ${f(m.apex2)} m, beim Rückschläger (z=-12.5) nach ${f(tz)} s mit ${f(kmh(vR), 0)} km/h`);
    ok(m.clr > 0.02 && m.clr < 0.6);
    ok(tz > 0.5 && tz < 0.85, 'Reaktionszeit Rückschläger');
  }
  const k = solveShot({ from, target: { x: -2.5, z: -5.5 }, spin: 'serve_kick', power: 0.7 });
  const mk = measure(from, k.vel, k.spin);
  const flat = solveShot({ from, target: { x: -2.5, z: -5.5 }, spin: 'serve_flat', power: 0.7 });
  const mf = measure(from, flat.vel, flat.spin);
  line(`Aufschlag:   Kick ${f(kmh(k.speed), 0)} km/h: Netz +${f(mk.clr)} m, Absprung ${f(mk.apex2)} m, Seitwärts-Kick ${f(mk.b0.vel[0] - mf.b0.vel[0])} m/s (vs. flach ${f(kmh(flat.speed), 0)} km/h, Absprung ${f(mf.apex2)} m)`);
  ok(mk.apex2 > mf.apex2, 'Kick springt höher');
  ok(mk.b0.vel[0] - mf.b0.vel[0] > 1, 'Kick springt nach rechts (aus Sicht des Aufschlägers, +X)');
  ok(mk.clr > mf.clr, 'Kick mit mehr Netzabstand');
});

test('Lob über einen Netzspieler', () => {
  const from = [0.3, 0.8, 11.5];
  const s = solveShot({ from, target: { x: -2, z: -10.3 }, spin: 'lob', power: 0.6 });
  ok(s.ok);
  const m = measure(from, s.vel, s.spin);
  const tNet = m.tr.timeToZ(-2.5);
  const hNet = m.tr.positionAt(tNet)[1];
  line(`Lob:         ${f(kmh(s.speed), 0)} km/h @${f(deg(s.elevation), 1)}°, Scheitel ${f(m.apex)} m, über Netzspieler (z=-2.5) in ${f(hNet)} m Höhe, Flug ${f(m.t)} s, Absprung ${f(m.apex2)} m`);
  ok(hNet > 3.3, 'unerreichbar für Netzspieler (Reichweite ~3.1 m)');
  ok(isInSingles(m.land[0], m.land[2]));
  ok(m.apex > 5.5 && m.apex < 9);
});

test('Stoppball: kurz mit Unterschnitt, zweiter Aufsprung nahe am Netz', () => {
  const from = [0.3, 0.9, 7.5];
  const s = solveShot({ from, target: { x: 2, z: -2.0 }, spin: 'drop', power: 0.5 });
  ok(s.ok);
  const m = measure(from, s.vel, s.spin);
  line(`Stopp:       ${f(kmh(s.speed), 0)} km/h, ${f(presetParams('drop', 0.5).topRpm, 0)} U/min, Netz +${f(m.clr)} m, Aufsprung z=${f(m.land[2])} m, Absprung ${f(m.apex2)} m, 2. Aufsprung z=${f(m.b1z)} m`);
  ok(m.b1z > -6.4, '2. Aufsprung vor der Aufschlaglinie');
  ok(m.apex2 < 1.0);
});

test('Volley, Schmetterball', () => {
  const v = solveShot({ from: [0.5, 1.1, 2.5], target: { x: 3, z: -9 }, spin: 'volley', power: 0.6 });
  ok(v.ok && !v.adjusted);
  const sm = solveShot({ from: [0.3, 2.8, 6], target: { x: -3, z: -8 }, spin: 'smash', power: 0.8 });
  ok(sm.ok && sm.elevation < 0, 'Schmetterball nach unten');
  const ms = measure([0.3, 2.8, 6], sm.vel, sm.spin);
  line(`Volley:      ${f(kmh(v.speed), 0)} km/h @${f(deg(v.elevation), 1)}°, Netz +${f(v.netClearance)} m · Smash ${f(kmh(sm.speed), 0)} km/h @${f(deg(sm.elevation), 1)}° → Absprung ${f(ms.apex2)} m`);
  ok(ms.apex2 > 1.0, 'Schmetterball springt hoch ab');
});

test('Netzroller: deterministische Fälle (drüber tröpfeln / zurückfallen / hängen)', () => {
  const outcomes = [];
  const run = (speed, q, x = 0.4) => {
    // Ball fliegt nahezu waagerecht auf das Netzband zu; q = Mittelpunkthöhe über Bandoberkante in Radien beim Durchgang
    const b = new Ball(); b.walls = null;
    const tt = 2 / speed, h = netHeightAt(x) + q * R;
    b.launch([x, h + 0.5 * 9.81 * tt * tt * 0, 2], [0, 0.5 * 9.81 * tt, -speed], spinFromLocal([0, 0, 0], 0, -1, 1500 * RPM));
    let net = null, bounce = null;
    for (let i = 0; i < 600 && !bounce; i++) for (const e of b.step()) { if (e.type === 'net' && !net) net = e; if (e.type === 'bounce' && !bounce) bounce = e; }
    return { net, side: bounce ? (bounce.pos[2] < 0 ? 'drüber' : 'zurück') : 'liegt', z: bounce ? bounce.pos[2] : NaN };
  };
  const cases = [[30, 0.2], [30, 0.5], [30, 0.8], [12, 0.25], [12, 0.6], [6, 0.45], [20, -0.6], [45, 0.6]];
  for (const [sp, q] of cases) {
    const a = run(sp, q), b = run(sp, q);
    ok(a.side === b.side && (a.z === b.z || (isNaN(a.z) && isNaN(b.z))), 'deterministisch');
    outcomes.push(`${sp}m/s q=${q}: ${a.net ? (a.net.cord ? 'Band' : 'Netz') : 'frei'} → ${a.side}${isNaN(a.z) ? '' : ' (' + f(a.z) + ')'}`);
    a.case = [sp, q];
    outcomes.push(a);
  }
  const res = outcomes.filter((o) => typeof o === 'object');
  line('Netzroller:  ' + outcomes.filter((o) => typeof o === 'string').join(' · '));
  ok(res.some((o) => o.net && o.net.cord && o.side === 'drüber'), 'mind. ein Netzroller tröpfelt drüber');
  ok(res.some((o) => o.net && o.side === 'zurück'), 'mind. einer fällt zurück');
  ok(res.find((o) => o.case[1] === -0.6).net.cord === false, 'tief = Masche');
  // Drüber-Tröpfler landen kurz hinter dem Netz
  ok(res.filter((o) => o.net && o.net.cord && o.side === 'drüber').some((o) => o.z > -3), 'kurzer Tröpfler');
});

// =================================================================== Löser
test('Löser: 500 zufällige machbare Ziele (alle Schlagarten) – Genauigkeit mit Ball.step nachgeprüft', () => {
  const rng = makeRng(4242);
  const kinds = ['topspin', 'flat', 'slice', 'lob', 'drop', 'volley', 'smash', 'serve_flat', 'serve_kick', 'serve_slice'];
  const N = 500;
  let okN = 0, adjusted = 0, maxErr = 0, maxErrStep = 0, sims = 0;
  const times = [];
  const stats = [PLAYER_STATS.tom, PLAYER_STATS.gerry];
  for (let i = 0; i < N; i++) {
    const kind = kinds[i % kinds.length];
    const side = rng() < 0.5 ? 1 : -1;
    let from, target;
    if (kind.startsWith('serve')) {
      const box = rng() < 0.5 ? 'deuce' : 'ad';
      const xs = box === 'deuce' ? side : -side;
      from = [xs * (0.2 + rng() * 1.8), 2.3 + rng() * 0.5, side * (11.95 + rng() * 0.4)];
      const t = serveTarget(side, box, rng() * 2 - 1, rng()); target = { x: t.x, z: t.z };
    } else if (kind === 'volley') {
      from = [rng() * 6 - 3, 0.5 + rng() * 1.2, side * (1.8 + rng() * 4)];
      target = { x: rng() * 7.6 - 3.8, z: -side * (4 + rng() * 7.5) };
    } else if (kind === 'smash') {
      from = [rng() * 6 - 3, 2.4 + rng() * 0.7, side * (2 + rng() * 8)];
      target = { x: rng() * 7.6 - 3.8, z: -side * (4 + rng() * 7.5) };
    } else if (kind === 'drop') {
      from = [rng() * 7 - 3.5, 0.5 + rng() * 0.8, side * (5 + rng() * 7)];
      target = { x: rng() * 7.2 - 3.6, z: -side * (1.2 + rng() * 2.8) };
    } else {
      from = [rng() * 9 - 4.5, 0.4 + rng() * 1.2, side * (9.5 + rng() * 4)];
      target = { x: rng() * 7.8 - 3.9, z: -side * ((kind === 'lob' ? 7 : 4.5) + rng() * (kind === 'lob' ? 4.6 : 7.1)) };
    }
    const r = solveShot({ from, target, spin: kind, power: rng(), stats: stats[i & 1] });
    times.push(r.ms); sims += r.iterations;
    if (r.adjusted) adjusted++;
    if (!r.ok) continue;
    // Nachprüfung mit der echten Spielphysik (Ball.step inkl. Netz)
    const b = new Ball(); b.launch(from, r.vel, r.spin);
    let land = null, netTouch = false;
    for (let k = 0; k < 1200 && !land; k++) for (const e of b.step()) { if (e.type === 'bounce' && !land) land = e.pos; if (e.type === 'net') netTouch = true; }
    const errStep = land ? Math.hypot(land[0] - target.x, land[2] - target.z) : Infinity;
    maxErr = Math.max(maxErr, r.landingError); maxErrStep = Math.max(maxErrStep, errStep);
    if (errStep < 0.03 && !netTouch) okN++;
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / N;
  line(`Löser:       ${okN}/${N} Ziele exakt getroffen (${f(100 * okN / N, 1)} %), davon ${adjusted} angepasst (zu schnell fürs Netz → nächstbeste machbare Variante); ` +
    `max. Fehler ${f(maxErr * 100, 2)} cm (Ball.step: ${f(maxErrStep * 100, 2)} cm); Zeit Ø ${f(avg, 3)} ms, p95 ${f(times[Math.floor(N * 0.95)], 3)} ms, ` +
    `max ${f(times[N - 1], 2)} ms; Ø ${f(sims / N, 1)} Flugsimulationen`);
  ok(okN >= N * 0.995, 'Erfolgsquote ≥ 99.5 %: ' + okN);
  ok(maxErrStep < 0.03, 'Fehler < 3 cm');
  ok(avg < 1.0, 'Ø < 1 ms');
});

test('Machbarkeit: zu schnell für kurzes Ziel → langsamere Alternative; zu langsam → höherer Ball', () => {
  const c = checkShot({ from: [0.3, 0.9, 11.5], target: { x: -2, z: -1.5 }, spin: 'topspin', speed: 38 });
  ok(!c.feasible && c.reason === 'net' && c.alternative && c.alternative.speed < 25, JSON.stringify(c.alternative));
  ok(c.solution.netClearance >= SHOT_PRESETS.topspin.minClearance - 0.005);
  const d = checkShot({ from: [0.3, 0.9, 11.5], target: { x: -2, z: -11 }, spin: 'topspin', speed: 9 });
  ok(!d.feasible && d.reason === 'too_slow' && d.alternative.speed > 9 && d.solution.ok);
  const e = checkShot({ from: [0.3, 0.9, 11.5], target: { x: -2, z: -9 }, spin: 'topspin', speed: 28 });
  ok(e.feasible && e.alternative === null);
  line(`Machbarkeit: 137 km/h Topspin auf z=-1.5 → ${f(kmh(c.alternative.speed), 0)} km/h (Netz +${f(c.solution.netClearance)} m); ` +
    `32 km/h zur Grundlinie → ${f(kmh(d.alternative.speed), 0)} km/h hoher Ball`);
  const vmax = maxSpeedFor([0.5, 2.55, 12.0], [-0.3, -5.0], 'serve_flat', 0.05, 1);
  ok(vmax > 50 && vmax < 65, 'max. Aufschlagtempo auf z=-5 aus 2.55 m: ' + vmax);
  line(`Machbarkeit: schnellster flacher Aufschlag aus 2.55 m auf z=-5.0 (T): ${f(kmh(vmax), 0)} km/h`);
});

test('Presets: Werte skalieren mit power und Spielerwerten', () => {
  const lo = presetParams('topspin', 0, PLAYER_STATS.tom), hi = presetParams('topspin', 1, PLAYER_STATS.tom);
  ok(hi.speed > lo.speed && hi.topRpm > lo.topRpm);
  const g = presetParams('topspin', 1, PLAYER_STATS.gerry);
  ok(g.topRpm > hi.topRpm, 'Gerry mehr Spin'); ok(g.speed < hi.speed, 'Tom mehr Tempo');
  for (const k of Object.keys(SHOT_PRESETS)) { const p = presetParams(k, 0.5); ok(p.mode && Number.isFinite(p.topRpm)); }
  const a = aimTarget(1, 1, 1, 'topspin'); ok(a.x > 3 && a.z < -10, 'rechts/lang aus Sicht Seite +1');
  const b = aimTarget(-1, 1, -1, 'topspin'); ok(b.x < -3 && b.z > 6, 'rechts/kurz aus Sicht Seite -1');
});

// =================================================================== Leistung
test('Leistung: predict() 3 s, Ball.step()', () => {
  const b = new Ball();
  const s = solveShot({ from: [0.5, 1, 11.5], target: { x: -2, z: -10 }, spin: 'topspin', power: 0.7 });
  b.launch([0.5, 1, 11.5], s.vel, s.spin);
  for (let i = 0; i < 300; i++) predict(b, 3);
  let t0 = performance.now();
  for (let i = 0; i < 2000; i++) predict(b, 3);
  const tp = (performance.now() - t0) / 2000;
  t0 = performance.now();
  const opts = { maxBounces: 2 };
  for (let i = 0; i < 2000; i++) predict(b, 3, BALL.dt, opts);
  const tp2 = (performance.now() - t0) / 2000;
  line(`Leistung:    predict(3 s) ${f(tp * 1000, 0)} µs, bis 2. Aufsprung ${f(tp2 * 1000, 0)} µs (allokationsfrei, geteilter Puffer)`);
  ok(tp < 0.5, 'predict < 0.5 ms');
});

// =================================================================== Ausgabe
console.log(report.join('\n'));
console.log('═'.repeat(90));
for (const x of failures) console.log(x);
console.log(`\nsim.test: ${passed} bestanden, ${failed} fehlgeschlagen`);
process.exit(failed ? 1 : 0);

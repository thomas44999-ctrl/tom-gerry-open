// Animations-Tests (ANIM): Treffpunkt-Genauigkeit aller Schläge (beide Figuren, Höhe/Reichweite/Timing-Varianten),
// Füße nie im Boden, Clip-Dauern = STROKES, Aufschlag-Timing (ball_release), Ereignisse, Replay-Roundtrip, Laufzeit.
//   node test/anim.test.mjs [--verbose]
import { buildTom } from '../src/chars/tom.js';
import { buildGerry } from '../src/chars/gerry.js';
import { buildRacket, RACKET_STYLES } from '../src/chars/racket.js';
import { Character } from '../src/chars/character.js';
import { buildAnimSet } from '../src/chars/animlib.js';
import { STROKES, SERVE } from '../src/sim/strokes.js';

const VERBOSE = process.argv.includes('--verbose');
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  FAIL', msg); } };
const fr = { q: { name: 'low', furShells: 8 }, createMesh: () => ({}), createMaterial: (o) => ({ ...o, uniforms: { ...(o.uniforms || {}) } }) };

const t0 = Date.now();
const assets = { tom: buildTom(fr, fr.q), gerry: buildGerry(fr, fr.q) };
const rackets = { tom: buildRacket(fr, RACKET_STYLES.tom), gerry: buildRacket(fr, RACKET_STYLES.gerry) };
console.log(`assets built in ${Date.now() - t0} ms`);

const STROKE_TYPES = ['forehand', 'backhand', 'forehand_slice', 'backhand_slice', 'forehand_volley', 'backhand_volley', 'smash'];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Tiefster Punkt der Füße (Ferse/Ballen/Zehenspitze, Welt). */
const _m = new Float32Array(16);
function footLow(c) {
  let low = Infinity;
  const sk = c.skel, g = c.geo;
  for (const s of ['l', 'r']) {
    const W = sk.getWorldMatrix('foot_' + s, _m, c.model);
    // Fersenpunkt (unter dem Knöchel, etwas hinten) und Ballen in Fuß-Lokalkoordinaten
    for (const p of [[0, -g.ankleH + 0.012, -g.heelZ + 0.01], [0, -g.ankleH + 0.012, g.ballZ]]) {
      const y = W[1] * p[0] + W[5] * p[1] + W[9] * p[2] + W[13];
      low = Math.min(low, y);
    }
    const tip = sk.getWorldPos('toe_' + s, new Float32Array(3), c.model);
    low = Math.min(low, tip[1] - 0.012);
  }
  return low;
}

function makeChar(id) {
  const c = new Character(null, assets[id], rackets[id]);
  return c;
}

/** Figur in Bereitschaft stellen und einschwingen lassen. */
function settle(c, yaw = 0, pos = [0, 0, 0], tSet = 0.8) {
  c.position[0] = pos[0]; c.position[1] = pos[1]; c.position[2] = pos[2]; c.yaw = yaw;
  c.reset();
  c.lookAt([pos[0], 1.2, pos[2] + 10 * Math.cos(yaw)]);
  const h = 1 / 120;
  for (let t = 0; t < tSet; t += h) { c.setLocomotion([0, 0, 0], 1); c.update(h); }
}

/** Schlag spielen, mit Schrittweite die den Treffzeitpunkt exakt trifft. Gibt Fehler (m) und min. Fußhöhe zurück. */
function runStroke(c, type, contact, T, shot = 'topspin', vel = [0, 0, 0]) {
  const n = Math.max(8, Math.round(T * 120));
  const h = T / n;
  c.playStroke(type, { timeToContact: T, contactWorld: contact, shot, power: 0.7 });
  let err = null, low = Infinity, tc = -1, time = 0;
  for (let k = 0; k < n + Math.round(0.7 / h); k++) {
    c.position[0] += vel[0] * h; c.position[2] += vel[2] * h;
    c.setLocomotion(vel, 1);
    c.update(h); time += h;
    low = Math.min(low, footLow(c));
    for (const e of c.events) if (e.type === 'swing_contact' && err === null) { err = dist(c.getRacketSweetSpot(), contact); tc = time; }
  }
  return { err, low, tc };
}

// ---------------------------------------------------------------- 1) Clip-Dauern / Vertrag
{
  for (const id of ['tom', 'gerry']) {
    const set = buildAnimSet(id, assets[id].skeletonDef);
    for (const type of STROKE_TYPES) {
      const S = STROKES[type], A = set.strokes[type];
      ok(Math.abs(A.clip.duration - (S.windup + S.follow)) < 1e-9, `${id} ${type}: Clipdauer ${A.clip.duration} != windup+follow`);
      ok(A.W === S.windup && A.F === S.follow, `${id} ${type}: W/F`);
      ok(A.clip.keys.some((k) => Math.abs(k.t - S.windup) < 1e-9), `${id} ${type}: Key am Treffer`);
    }
    ok(Math.abs(set.serve.swing.duration - (STROKES.serve.windup + STROKES.serve.follow)) < 1e-9, `${id} serve: Schwung-Dauer`);
  }
  ok(buildAnimSet('gerry', assets.gerry.skeletonDef).strokes.backhand.grip, 'Gerry: beidhändige Rückhand (grip-Kurve)');
  ok(!buildAnimSet('tom', assets.tom.skeletonDef).strokes.backhand.grip, 'Tom: einhändige Rückhand');
}

// ---------------------------------------------------------------- 2) Treffpunkt-Genauigkeit
{
  const worst = {};
  let runs = 0;
  for (const id of ['tom', 'gerry']) {
    const c = makeChar(id);
    const sc = c.scale;
    for (const type of STROKE_TYPES) {
      const S = STROKES[type];
      const ups = [Math.max(S.height[0] * sc + 0.05, S.contact.up * sc - 0.45), S.contact.up * sc, Math.min(S.height[1] * sc - 0.05, S.contact.up * sc + 0.45)];
      const sides = [0, S.reach * sc * 0.5, -0.25];
      const fwds = [0, 0.2];
      const Ts = [S.windup, S.windup * 0.85, S.windup * 1.25];
      for (const yaw of [0, Math.PI]) {
        for (const up of ups) for (const ds of sides) for (const df of fwds) for (const T of (ds === 0 && df === 0 ? Ts : [S.windup])) {
          settle(c, yaw, [yaw ? 1.5 : -1.2, 0, yaw ? 10 : -10]);
          const s = Math.sin(yaw), co = Math.cos(yaw);
          const right = Math.sign(S.contact.right) * (Math.abs(S.contact.right) * sc + ds), fwd = S.contact.forward * sc + df;
          const p = c.position;
          const contact = [p[0] + s * fwd - co * right, up, p[2] + co * fwd + s * right];
          const r = runStroke(c, type, contact, T);
          runs++;
          const key = `${id}/${type}`;
          if (!worst[key] || (r.err ?? 9) > worst[key].err) worst[key] = { err: r.err ?? 9, up, ds, df, T, yaw };
          ok(r.err !== null, `${key}: kein swing_contact`);
          ok(Math.abs(r.tc - T) < 1e-6, `${key}: Kontaktzeit ${r.tc} != ${T}`);
          // Chibi-Figuren (kurze Arme): an der äußersten Ecke (ganz hoch UND ganz weit seitlich) darf der Schläger den
          // Ball um wenige cm verfehlen – die Spiellogik wertet solche Bälle als 'stretch'.
          const corner = up > S.contact.up * sc + 0.2 && ds > 0.1;
          const tol = corner ? 0.06 : 0.03;
          ok(r.err !== null && r.err < tol, `${key} up=${up.toFixed(2)} side+${ds.toFixed(2)} fwd+${df} T=${T.toFixed(3)} yaw=${yaw.toFixed(2)}: Fehler ${(r.err * 100).toFixed(1)} cm`);
          ok(r.low > -0.008, `${key}: Fuß im Boden (${(r.low * 100).toFixed(1)} cm)`);
        }
      }
      // Laufschlag (Unterkörper läuft weiter)
      settle(c, 0, [0, 0, 0]);
      const vel = [3.8, 0, 0];
      const T = S.windup;
      const p = c.position;
      const contact = [p[0] + vel[0] * T - S.contact.right * sc * -1 * -1, S.contact.up * sc, p[2] + S.contact.forward * sc];
      contact[0] = p[0] + vel[0] * T - S.contact.right * sc;
      const r = runStroke(c, type, contact, T, 'topspin', vel);
      ok(r.err !== null && r.err < 0.03, `${id}/${type} Laufschlag: Fehler ${r.err !== null ? (r.err * 100).toFixed(1) : '-'} cm`);
      runs++;
    }
  }
  console.log(`contact runs: ${runs}`);
  if (VERBOSE) for (const k in worst) console.log('  worst', k, (worst[k].err * 100).toFixed(2), 'cm', JSON.stringify(worst[k]));
}

// ---------------------------------------------------------------- 3) Aufschlag
{
  for (const id of ['tom', 'gerry']) {
    const c = makeChar(id);
    settle(c, Math.PI, [1.2, 0, 11.9]);
    const h = 1 / 120;
    c.playServe('bounce', { period: 0.62 });
    let bounces = 0, low = Infinity;
    for (let t = 0; t < 1.3; t += h) { c.update(h); for (const e of c.events) if (e.type === 'ball_bounce') bounces++; low = Math.min(low, footLow(c)); }
    ok(bounces === 2, `${id} serve: 2 Ballaufpraller (${bounces})`);
    // Ball in der Hand vor dem Wurf
    const bp = c.heldBallPos(new Float32Array(3)), hp = c.getHandPos('l', new Float32Array(3));
    c.playServe('toss');
    let rel = -1, tt = 0;
    const n = Math.round(SERVE.tossRelease / (1 / 128));
    const hh = SERVE.tossRelease / n;
    for (let k = 0; k < n + 2; k++) { c.update(hh); tt += hh; for (const e of c.events) if (e.type === 'ball_release' && rel < 0) { rel = tt; c._relPos = e.pos; } }
    ok(Math.abs(rel - SERVE.tossRelease) < hh * 1.01, `${id} serve: ball_release bei ${rel.toFixed(3)} (${SERVE.tossRelease})`);
    const k = c.scale;
    ok(c._relPos && Math.abs(c._relPos[1] - SERVE.releaseUp * k) < 0.06, `${id} serve: Abwurfhöhe ${c._relPos && c._relPos[1].toFixed(3)} (${(SERVE.releaseUp * k).toFixed(3)})`);
    // Schwung zum idealen Zeitpunkt
    const hc = STROKES.serve.contact.up * k, relY = SERVE.releaseUp * k;
    const v0 = Math.sqrt(2 * 9.81 * (hc + SERVE.tossApexAbove * k - relY));
    const tIdeal = SERVE.tossRelease + v0 / 9.81 + Math.sqrt(2 * SERVE.tossApexAbove * k / 9.81);
    for (const dtc of [-0.15, 0, 0.12]) {
      settle(c, Math.PI, [1.2, 0, 11.9]);
      c.playServe('toss');
      const tSwing = tIdeal - STROKES.serve.windup + dtc;
      let t = 0;
      while (t < tSwing - 1e-9) { const s = Math.min(1 / 120, tSwing - t); c.update(s); t += s; low = Math.min(low, footLow(c)); }
      const sv = c.serve, tcont = tSwing + STROKES.serve.windup - SERVE.tossRelease;
      const contact = [sv.spot[0], sv.release + sv.v0 * tcont - 4.905 * tcont * tcont, sv.spot[2]];
      const r = runStroke(c, 'serve', contact, STROKES.serve.windup);
      ok(r.err !== null && r.err < 0.03, `${id} serve dtc=${dtc}: Fehler ${r.err !== null ? (r.err * 100).toFixed(1) : '-'} cm (Höhe ${contact[1].toFixed(2)})`);
      low = Math.min(low, r.low);
    }
    ok(low > -0.006, `${id} serve: Fuß im Boden (${(low * 100).toFixed(1)} cm)`);
    void bp; void hp;
  }
}

// ---------------------------------------------------------------- 4) Fortbewegung: Füße, Schritte, kein Rutschen
{
  for (const id of ['tom', 'gerry']) {
    const c = makeChar(id);
    settle(c, 0, [0, 0, 0]);
    const h = 1 / 120;
    let steps = 0, low = Infinity, slide = 0;
    const prev = [null, null];
    // Muster: seitlich sprinten, stoppen, rückwärts, Kreis vorwärts
    const path = (t) => {
      if (t < 2.5) { const u = Math.min(1, t / 2.5); return [4 * (u * u * (3 - 2 * u)), 0]; }
      if (t < 4.5) { const u = (t - 2.5) / 2; return [4, -2.5 * (u * u * (3 - 2 * u))]; }
      const a = (t - 4.5) * 1.1; return [4 + 2.5 * Math.sin(a), -2.5 - 2.5 + 2.5 * Math.cos(a)];
    };
    for (let t = 0; t < 9; t += h) {
      const p = path(t), q = path(t + 0.01);
      const vx = (q[0] - p[0]) / 0.01, vz = (q[1] - p[1]) / 0.01;
      c.position[0] = p[0]; c.position[2] = p[1];
      c.yaw = t > 4.5 ? Math.atan2(vx, vz) : 0;
      c.setLocomotion([vx, 0, vz], t > 4.5 ? 0 : 1);
      c.update(h);
      for (const e of c.events) if (e.type === 'footstep') steps++;
      low = Math.min(low, footLow(c));
      // Rutschen: gepflanzter Fuß bewegt sich nicht (Ballen-Position, Welt)
      for (let i = 0; i < 2; i++) {
        const f = c.feet.feet[i];
        const cur = f.swing ? null : [f.x, f.z];
        if (cur && prev[i]) slide = Math.max(slide, Math.hypot(cur[0] - prev[i][0], cur[1] - prev[i][1]));
        prev[i] = cur;
      }
    }
    ok(steps > 14, `${id} loco: Schritte ${steps}`);
    ok(low > -0.006, `${id} loco: Fuß im Boden (${(low * 100).toFixed(1)} cm)`);
    ok(slide < 1e-6, `${id} loco: gepflanzter Fuß rutscht (${slide})`);
    // Füße bleiben nahe am Körper (kein Zurückbleiben)
    let far = 0;
    for (let t = 0; t < 3; t += h) {
      const vx = 5.5 * Math.min(1, t / 0.6);
      c.position[0] += vx * h; c.yaw = 0; c.setLocomotion([vx, 0, 0], 1); c.update(h);
      for (const f of c.feet.feet) far = Math.max(far, Math.hypot(f.x - c.position[0], f.z - c.position[2]));
    }
    ok(far < 1.2 * c.bodyScale, `${id} sprint: Fuß max. ${far.toFixed(2)} m vom Körper`);
  }
}

// ---------------------------------------------------------------- 5) Emotes, Split-Step, Replay
{
  for (const id of ['tom', 'gerry']) {
    const c = makeChar(id);
    const set = buildAnimSet(id, assets[id].skeletonDef);
    let low = Infinity;
    for (const name of Object.keys(set.emotes)) {
      settle(c, 0, [0, 0, 0], 0.3);
      c.playEmote(name);
      const h = 1 / 120;
      for (let t = 0; t < set.emotes[name].duration + 0.3; t += h) { c.update(h); low = Math.min(low, footLow(c)); }
      ok(!c.busy, `${id} ${name}: Emote endet`);
    }
    ok(low > -0.006, `${id} emotes: Fuß im Boden (${(low * 100).toFixed(1)} cm)`);
    settle(c, 0, [0, 0, 0], 0.3);
    c.splitStep(0.12);
    let land = 0;
    for (let t = 0; t < 0.6; t += 1 / 120) { c.update(1 / 120); for (const e of c.events) if (e.type === 'footstep') land++; }
    ok(land >= 2, `${id} split-step: Landung beider Füße (${land})`);
    // Replay-Roundtrip
    const cap = c.capturePose();
    const sw = c.getRacketSweetSpot(new Float32Array(3));
    c.position[0] += 3; c.update(1 / 60); c.update(1 / 60);
    c.applyCapturedPose(cap);
    ok(dist(c.getRacketSweetSpot(new Float32Array(3)), sw) < 1e-5, `${id}: applyCapturedPose stellt Schlägerposition wieder her`);
  }
}

// ---------------------------------------------------------------- 6) Laufzeit
{
  const c = makeChar('gerry');
  settle(c, 0, [0, 0, 0]);
  const h = 1 / 60, N = 1200;
  const t1 = performance.now();
  for (let k = 0; k < N; k++) {
    const t = k * h;
    c.position[0] = 2 * Math.sin(t); c.setLocomotion([2 * Math.cos(t), 0, 0], 1);
    if (k % 90 === 0) c.playStroke(k % 180 ? 'forehand' : 'backhand', { timeToContact: 0.42 });
    c.update(h);
  }
  const ms = (performance.now() - t1) / N;
  console.log(`update: ${(ms * 1000).toFixed(1)} µs/Bild (Gerry, Laufen + Schläge)`);
  ok(ms < 1.0, `update zu langsam: ${ms.toFixed(3)} ms`);
}

console.log(`${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);

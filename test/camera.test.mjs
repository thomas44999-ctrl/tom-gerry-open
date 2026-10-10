// Node-Tests für Kamera, Regie und Wiederholung: node test/camera.test.mjs
import assert from 'node:assert/strict';
import { mat4, vec3, vec4, DEG } from '../src/core/math.js';
import { Recorder, ReplayPlayer, lerpPoseArray } from '../src/game/replay.js';
import { BroadcastCamera, CamPose, applyPose, createCamera, minCameraY, safeCameraPos } from '../src/game/camera.js';
import { Director } from '../src/game/director.js';
import { Match } from '../src/game/match.js';
import { createAnchors } from '../src/world/world.js';

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
};

/** NDC eines Weltpunkts für eine Kamera (aspect). */
const view = mat4.create(), proj = mat4.create(), vp = mat4.create(), v4 = vec4.create();
function ndc(cam, p, aspect = 16 / 9) {
  mat4.lookAt(view, cam.position, cam.target, cam.up || [0, 1, 0]);
  mat4.perspective(proj, cam.fov, aspect, 0.1, 900);
  mat4.multiply(vp, proj, view);
  vec4.set(v4, p[0], p[1], p[2], 1);
  vec4.transformMat4(v4, v4, vp);
  return [v4[0] / v4[3], v4[1] / v4[3], v4[3]];
}

class FakeChar {
  constructor(n) { this.position = vec3.create(); this.yaw = 0; this.p = new Float32Array(n * 4 + 3); this.capturePoseLayout = { quats: n }; this.applied = null; }
  capturePose(out) { if (!out) out = new Float32Array(this.p.length); out.set(this.p); return out; }
  applyCapturedPose(a) { this.applied = Float32Array.from(a); }
}

console.log('camera/director/replay');

test('Recorder: Ringpuffer, clip, Marker', () => {
  const rec = new Recorder({ seconds: 2, hz: 60 });
  const c = [new FakeChar(2), new FakeChar(2)];
  const ball = { pos: [0, 1, 0], vel: [0, 0, 0], spin: [0, 0, 0], visible: true };
  for (let k = 0; k < 300; k++) {
    const t = k / 60;
    ball.pos[2] = t; c[0].position[0] = t; c[0].yaw = t * 0.1;
    c[0].p[3] = 1; c[0].p[7] = 1;
    rec.record(t, ball, c);
    if (k === 250) rec.mark('hit', t, { pos: [0, 1, t], player: 0 });
  }
  assert.ok(rec.count <= rec.cap);
  assert.ok(Math.abs(rec.t1 - 299 / 60) < 1e-9);
  assert.ok(rec.duration > 1.9 && rec.duration < 2.1);
  const R = rec.clip(4.0, 4.5);
  assert.ok(R.t0 <= 4.0 + 1e-6 && R.t1 >= 4.5 - 1e-6, 'Rand mitgenommen');
  assert.equal(R.markers.length, 1);
  assert.equal(R.chars[0].poseSize, 11);
  const P = new ReplayPlayer(R);
  P.seek(4.25, { characters: c, ball: {} });
  assert.ok(Math.abs(c[0].position[0] - 4.25) < 1e-4);
  assert.ok(c[0].applied && c[0].applied.length === 11);
});

test('ReplayPlayer: Ball-Hermite trifft Parabel', () => {
  const rec = new Recorder({ seconds: 3, hz: 60 });
  const p0 = [0, 1, 10], v0 = [1, 6, -20];
  const at = (t, out) => { out[0] = p0[0] + v0[0] * t; out[1] = p0[1] + v0[1] * t - 4.905 * t * t; out[2] = p0[2] + v0[2] * t; return out; };
  const ball = { pos: [0, 0, 0], vel: [0, 0, 0], visible: true };
  for (let k = 0; k <= 60; k++) { const t = k / 60; at(t, ball.pos); ball.vel[0] = v0[0]; ball.vel[1] = v0[1] - 9.81 * t; ball.vel[2] = v0[2]; rec.record(t, ball, []); }
  const P = new ReplayPlayer(rec.clip());
  let maxErr = 0; const ref = [0, 0, 0];
  for (let t = 0.01; t < 0.99; t += 0.0037) { P.sampleBall(t); at(t, ref); maxErr = Math.max(maxErr, vec3.distance(ref, P.ballState.pos)); }
  assert.ok(maxErr < 1e-3, 'maxErr ' + maxErr);
});

test('lerpPoseArray: Quaternionen hemisphärenrichtig', () => {
  const a = new Float32Array([0, 0, 0, 1, 5]), b = new Float32Array([0, 0, 0, -1, 7]), o = new Float32Array(5);
  lerpPoseArray(o, a, 0, b, 0, 5, 0.5, 1);
  assert.ok(Math.abs(o[3] - 1) < 1e-6 && Math.abs(o[4] - 6) < 1e-6);
});

test('Geometrie-Schutz', () => {
  assert.ok(minCameraY(0, 0) > 1.2, 'Netz');
  assert.ok(minCameraY(0, 25) > 5, 'Pavillon');
  assert.ok(minCameraY(20, 0) > 6, 'Tribüne');
  const p = [0, 17, 33];   // im Dachring
  safeCameraPos(p);
  assert.ok(p[1] < 16.2 || p[1] > 19, 'Dach ' + p[1]);
});

test('applyPose: Roll erzeugt geneigten up-Vektor, DoF', () => {
  const cam = createCamera(), pose = new CamPose();
  pose.set([0, 2, 10], [0, 1, 0], 0.6); pose.roll = 0.1; pose.aperture = 0.5; pose.focus = 9;
  applyPose(cam, pose);
  assert.ok(Math.abs(Math.hypot(...cam.up) - 1) < 1e-4 && Math.abs(cam.up[0]) > 0.05);
  assert.ok(cam.dof && cam.dof.focus === 9);
});

// ---- Match-basierte Prüfungen
function runMatch(seconds, seed, fn) {
  const m = new Match({ players: ['tom', 'gerry'], humans: [], seed, difficulty: 'normal' });
  const dt = 1 / 60;
  for (let k = 0; k < seconds * 60; k++) { m.step(dt); fn(m, m.drainEvents(), dt); }
  return m;
}

test('BroadcastCamera: beide Spieler + Grundlinien im Bild, ruhig, Seitenwechsel = Schnitt', () => {
  const bc = new BroadcastCamera();
  const cam = createCamera();
  let frames = 0, out = 0, flips = 0, side = 0, maxJerk = 0, maxRoll = 0;
  let prev = null, prevV = null;
  runMatch(240, 11, (m, ev, dt) => {
    const S = m.state, P = S.players;
    const hs = P[0].side;
    if (S.phase !== 'change_ends') { if (side && hs !== side) flips++; side = hs; bc.setSide(hs); }
    const snap = bc._snap;
    const pose = bc.update(dt, { phase: S.phase, ball: S.ball, players: P, humanIndex: 0, server: S.server });
    applyPose(cam, pose);
    maxRoll = Math.max(maxRoll, Math.abs(cam.up[0]) + Math.abs(cam.up[2]));
    if (S.phase === 'change_ends') return;
    frames++;
    const inRally = S.phase === 'rally';
    for (const p of P) {
      for (const h of [0, 1.7]) {
        const [x, y, w] = ndc(cam, [p.pos[0], h, p.pos[2]]);
        if (w <= 0 || Math.abs(x) > 1.0 || Math.abs(y) > 1.0) { out++; break; }
      }
    }
    // Ruhe: Änderung der Zielgeschwindigkeit (ohne Schnitte)
    const tg = Array.from(cam.target);
    if (prev && !snap && inRally) {
      const v = [(tg[0] - prev[0]) / dt, (tg[1] - prev[1]) / dt, (tg[2] - prev[2]) / dt];
      if (prevV) maxJerk = Math.max(maxJerk, Math.hypot(v[0] - prevV[0], v[1] - prevV[1], v[2] - prevV[2]) / dt);
      prevV = v;
    } else prevV = null;
    prev = tg;
  });
  console.log(`       frames ${frames}, player out-of-frame ${out} (${(100 * out / frames).toFixed(2)} %), side flips ${flips}, max target accel ${maxJerk.toFixed(1)} m/s²`);
  assert.ok(out / frames < 0.01, 'Spieler außerhalb: ' + out);
  assert.ok(maxRoll < 1e-6, 'Horizont waagerecht');
  assert.ok(maxJerk < 25, 'zu ruckartig: ' + maxJerk);
});

test('Director: alle Sequenzen laufen, Kamera nie in Geometrie, Promise wird erfüllt', () => {
  const world = { anchors: createAnchors(), marks: { hawkeye() { this.on = true; }, clearHawkeye() { this.on = false; } }, ball: { update() {} } };
  const d = new Director({ world, aspect: 16 / 9 });
  const m = new Match({ players: ['tom', 'gerry'], humans: [], seed: 5, difficulty: 'normal' });
  const S = m.state;
  const vw = { phase: S.phase, ball: S.ball, players: S.players, humanIndex: 0, humanSide: 1, events: null, time: 0 };
  const dt = 1 / 60;
  let lastPoint = null;
  const tick = (step = true) => {
    if (step && d.timeScale > 0) m.step(dt * d.timeScale);
    vw.events = m.drainEvents(); vw.phase = S.phase; vw.time = m.time; vw.humanSide = S.players[0].side;
    for (const e of vw.events) if (e.type === 'point') lastPoint = e;
    d.update(dt, vw);
    for (const v of [...d.camera.position, ...d.camera.target, d.camera.fov]) assert.ok(Number.isFinite(v), 'NaN');
  };
  for (let k = 0; k < 60 * 40 && !(lastPoint && lastPoint.rally >= 3); k++) tick();
  for (let k = 0; k < 60; k++) tick();
  const results = {};
  const cues = [];
  d.on('cue', (c) => cues.push(c.name));
  for (const name of ['title_flyover', 'intro', 'closeup', 'change_ends', 'replay', 'hawkeye', 'match_end']) {
    const opts = name === 'hawkeye' ? { pos: [3.0, 0, -11.9], verdict: 'out', distanceMm: 6 } : name === 'closeup' ? { player: 1, emote: 'fistpump' } : {};
    let res = null;
    if (name === 'change_ends') m.setPhase('change_ends');
    else if (name === 'closeup' || name === 'hawkeye') m.setPhase('point_over');
    d.play(name, opts).then((r) => { res = r; });
    const mode = d.mode;
    let minClear = Infinity, frames = 0; const c0 = d.stats.clamped;
    for (let k = 0; k < 60 * 20 && d.playing === name; k++) {
      tick(name === 'change_ends' || name === 'replay');
      frames++;
      const p = d.camera.position;
      minClear = Math.min(minClear, p[1] - minCameraY(p[0], p[2]) + 1e-6);
      if (name === 'title_flyover' && frames > 60 * 12) d.skip();
    }
    results[name] = { mode, sec: +(frames / 60).toFixed(1), minClear: +minClear.toFixed(2), clamped: d.stats.clamped - c0 };
    assert.ok(minClear >= -1e-3, name + ' in Geometrie: ' + minClear);
  }
  console.log('       ' + JSON.stringify(results));
  console.log('       cues: ' + cues.join(' '));
  console.log('       clamps: ' + JSON.stringify(d.stats.clampShots));
  assert.equal(results.replay.mode, 'replay');
  assert.ok(results.intro.sec >= 8 && results.intro.sec <= 20);
  assert.ok(cues.includes('player') && cues.includes('verdict') && cues.includes('replay_start'));
});

setTimeout(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 50);

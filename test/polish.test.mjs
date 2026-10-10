// Feinschliff Prototyp 2: Aufstellung ohne Laufwege, Seitenwechsel ohne Gang zur Bank, Spieltempo, Ball-Lesbarkeit.
// Aufruf: node test/polish.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Match, MATCH_DT } from '../src/game/match.js';
import { BALL } from '../src/sim/ball.js';
import { buildBallFx } from '../src/world/ballfx.js';
import { DEFAULT_SETTINGS, GAME_PACE, sanitizeSettings } from '../src/ui/menus.js';

function assertPlaced(m) {
  for (const p of m.players) {
    assert.deepEqual(Array.from(p.pos), Array.from(p.walkTarget));
    assert.equal(Math.hypot(...p.vel), 0);
    assert.equal(p.yaw, p.netYaw);
    assert.equal(p.side, m.score.sides[p.index]);
  }
}

test('Neuer Punkt: beide Spieler stehen sofort auf ihren Positionen (kein Zurücklaufen)', () => {
  const m = new Match({ humans: [0, 1], seed: 23 });
  assertPlaced(m);
  for (const p of m.players) { p.pos[0] = 4; p.pos[2] = p.side; p.vel[0] = 0; p.vel[2] = 0; }
  m.setPhase('between_points');
  const before = m.players.map((p) => [p.pos[0], p.pos[2]]);
  for (let i = 0; i < 50; i++) m.step(MATCH_DT);
  // zwischen den Punkten bleiben sie stehen (kein Gang Richtung Grundlinie)
  m.players.forEach((p, i) => assert.ok(Math.hypot(p.pos[0] - before[i][0], p.pos[2] - before[i][1]) < 0.05, 'kein Gang zur nächsten Position'));
  m.setPhase('pre_serve');
  assertPlaced(m);
});

test('Seitenwechsel: kein Gang zur Bank, danach direkt auf der neuen Seite', () => {
  const m = new Match({ humans: [], seed: 11, format: { sets: 1 } });
  const before = m.players.map((p) => p.side);
  let changed = false;
  for (let i = 0; i < 120 * 900; i++) {
    m.step(MATCH_DT);
    if (m.state.phase === 'change_ends') { changed = true; break; }
  }
  assert.ok(changed, 'kein Seitenwechsel erreicht');
  const start = m.players.map((p) => [p.pos[0], p.pos[2]]);
  let maxMove = 0;
  for (let i = 0; i < 600 && m.state.phase === 'change_ends'; i++) {
    m.step(MATCH_DT);
    m.players.forEach((p, k) => { if (m.state.phase === 'change_ends') maxMove = Math.max(maxMove, Math.hypot(p.pos[0] - start[k][0], p.pos[2] - start[k][1])); });
  }
  assert.ok(maxMove < 1.0, `Spieler laufen beim Seitenwechsel (${maxMove.toFixed(2)} m)`);
  assert.equal(m.state.phase, 'pre_serve');
  assert.deepEqual(m.players.map((p) => p.side), before.map((s) => -s));
  assertPlaced(m);
});

test('Spieltempo: Standard ist das Arcade-Tempo, ungültige Werte fallen zurück', () => {
  assert.equal(GAME_PACE[DEFAULT_SETTINGS.pace], 1);
  assert.ok(GAME_PACE.relaxed < 1 && GAME_PACE.brisk > 1);
  assert.equal(sanitizeSettings({ player: 'gerry', sound: false }).pace, 'normal');
  assert.equal(sanitizeSettings({ pace: 'unbekannt' }).pace, 'normal');
  assert.equal(sanitizeSettings({ pace: 'relaxed' }).pace, 'relaxed');
});

test('Ball bleibt am fernen Platzende lesbar, ohne die Physik zu ändern', () => {
  const r = { createMesh: (d) => d, createMaterial: (d) => d, createInstances: () => ({ set() {} }), updateMesh() {} };
  const { ball } = buildBallFx(r, {});
  const camera = { position: [0, 5.2, 18.3], fov: 0.75 };
  ball.setView(camera, 720);
  const state = { pos: [0, BALL.radius, -12], vel: [0, 0, 0], visible: true };
  ball.update(1 / 60, state);
  const model = ball.drawables[0].model;
  const radius = ball.drawRadius;
  const distance = Math.hypot(camera.position[1] - state.pos[1], camera.position[2] - state.pos[2]);
  const pixelDiameter = radius * 720 / (distance * Math.tan(camera.fov / 2));
  assert.ok(pixelDiameter >= 7.99, `Ball nur ${pixelDiameter.toFixed(1)} px`);
  assert.ok(model[13] >= radius - 1e-6, 'sichtbarer Ball darf nicht im Rasen versinken');
  assert.equal(state.pos[1], BALL.radius, 'Darstellung darf die Simulationskoordinaten nicht ändern');
  assert.ok(ball.radius > BALL.radius * 2, 'Ball optisch deutlich größer als der echte');
});

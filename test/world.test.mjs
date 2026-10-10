// Node-Tests für die Welt-Geometrie (ohne WebGL): Layout-Pfad, Blöcke, Sonnen-/Dachschatten-Helfer.
//   node test/world.test.mjs
import assert from 'node:assert/strict';
import { LAYOUT, BASE, BLOCKS, RoundRect, blockAt, standFloorY, sdRoundRect, roofUnderY, SUN_DIR } from '../src/world/layout.js';
import { roofShadowAt, skyVisAt } from '../src/world/envlib.js';
import { COURT } from '../src/sim/court.js';

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test('Mauer = Ballphysik-Wände (sim/ball.js)', () => {
  near(LAYOUT.wallX, COURT.doublesHalfWidth + COURT.runoffSide, 1e-9, 'wallX');
  near(LAYOUT.wallZ, COURT.halfLength + COURT.runoffBack, 1e-9, 'wallZ');
});

test('RoundRect: Umfang und Stetigkeit', () => {
  const rr = new RoundRect(9, 18, 3);
  near(rr.length, 4 * (Math.PI / 2) * 3 + 2 * 2 * (18 - 3) + 2 * 2 * (9 - 3), 1e-9, 'Umfang');
  let prev = rr.at(0, 0, {});
  for (let s = 0.05; s <= rr.length; s += 0.05) {
    const p = rr.at(s, 0, {});
    assert.ok(Math.hypot(p.x - prev.x, p.z - prev.z) < 0.051, `Sprung bei s=${s}`);
    near(Math.hypot(p.nx, p.nz), 1, 1e-9, 'Normale normiert');
    near(sdRoundRect(p.x, p.z, 9, 18, 3), 0, 1e-6, 'auf dem Rand');
    prev = p;
  }
});

test('RoundRect: Normale zeigt nach außen, Tangente = Laufrichtung', () => {
  for (let s = 0.3; s < BASE.length; s += 1.7) {
    const p = BASE.at(s, 0, {}), q = BASE.at(s, 0.5, {});
    assert.ok(sdRoundRect(q.x, q.z, LAYOUT.wallX, LAYOUT.wallZ, LAYOUT.cornerR) > 0.49, 'Versatz nach außen');
    const n2 = BASE.at(s + 0.01, 0, {});
    const dx = n2.x - p.x, dz = n2.z - p.z;
    assert.ok(dx * p.tx + dz * p.tz > 0, 'Tangente in Laufrichtung');
  }
});

test('lengthAt / sAtLength sind invers', () => {
  for (const d of [0, 3, 10]) {
    for (const [s0, len] of [[0, 2], [1, 20], [40, 30]]) {
      const s1 = BASE.sAtLength(s0, len, d);
      near(BASE.lengthAt(s0, s1, d), len, 1e-6, `d=${d}`);
    }
  }
});

test('Blöcke decken den Umfang lückenlos ab', () => {
  let sum = 0;
  for (const b of BLOCKS) sum += b.s1 - b.s0;
  near(sum, BASE.length, 1e-9, 'Summe');
  assert.equal(blockAt(BASE.range('E')[0] + 1).name, 'E');
  assert.equal(blockAt(BASE.range('S')[0] + 1).name, 'S');
  assert.equal(blockAt(BASE.range('N')[0] + 1).name, 'N');
});

test('Profile: Reihen enden auf Konkursenhöhe', () => {
  for (const P of [LAYOUT.grand, LAYOUT.end]) {
    near(P.floor0 + P.rows * P.rise, LAYOUT.concourseY, 1e-9, 'Konkurse');
    assert.ok(P.rise / LAYOUT.rowDepth > 0.5, 'steil genug (> 26°)');
    assert.equal(standFloorY(P, P.depthC + 0.1), LAYOUT.concourseY);
  }
  assert.equal(LAYOUT.grand.rows, 18);
  assert.equal(LAYOUT.end.rows, 12);
});

test('Dach: Unterkante zwischen yIn und yOut, Innenkante außerhalb der Tribünenfront', () => {
  const R = LAYOUT.roof;
  near(roofUnderY(R.innerX, 0), R.yIn, 0.05, 'innen');
  near(roofUnderY(R.outerX, 0), R.yOut, 0.05, 'außen');
  assert.ok(R.innerX > LAYOUT.wallX + 8 && R.innerZ > LAYOUT.wallZ + LAYOUT.end.depthC, 'Innenkante');
});

test('Sonne: Elevation ~33°, aus West-Nordwest', () => {
  const el = Math.asin(SUN_DIR[1]) * 180 / Math.PI;
  assert.ok(el > 30 && el < 36, `el=${el}`);
  assert.ok(SUN_DIR[0] < 0 && SUN_DIR[2] < 0, 'Richtung');
});

test('Dachschatten: Platz immer sonnig, Weststribüne oben im Schatten, Osttribüne sonnig', () => {
  for (let x = -9; x <= 9; x += 1.5) for (let z = -18; z <= 18; z += 1.5) {
    if (sdRoundRect(x, z, LAYOUT.wallX, LAYOUT.wallZ, LAYOUT.cornerR) > 0) continue;
    assert.equal(roofShadowAt(x, 0.5, z), 1, `Platz ${x},${z}`);
  }
  assert.ok(roofShadowAt(-20, 8, 0) < 0.2, 'West oben');
  assert.ok(roofShadowAt(15, 5, 0) > 0.9, 'Ost');
});

test('Himmelssicht in [0.15, 1], Mitte heller als Mauerfuß', () => {
  const c = skyVisAt(0, 0.3, 0, 0, 1, 0), w = skyVisAt(-9, 0.3, 0, 0, 1, 0);
  assert.ok(c <= 1 && c >= 0.15 && w >= 0.15, 'Bereich');
  assert.ok(c > w, `Mitte ${c} > Rand ${w}`);
  assert.equal(skyVisAt(80, 1, 0, 0, 1, 0), 1, 'außerhalb');
});

console.log(`\nworld: ${passed} ok, ${failed} fehlgeschlagen`);
if (failed) process.exit(1);

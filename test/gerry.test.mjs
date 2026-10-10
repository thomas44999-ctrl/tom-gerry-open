// Tests für src/chars/gerry.js: Skelett (Extras), Meshes (Gültigkeit, Budget), Asset-Vertrag (ARCHITECTURE §5.4)
// mit einem Attrappen-Renderer, Griff-Sockel, Gesicht (Blinzeln/Stimmung), Skinning-Sanity.
// Aufruf: node test/gerry.test.mjs
import { buildGerry, buildGerryMeshes, buildGerrySkeletonDef, GERRY_HEIGHT, GERRY_JOINTS } from '../src/chars/gerry.js';
import { createSkeleton } from '../src/chars/skeleton.js';
import { poseFromEuler } from '../src/chars/pose.js';
import { checkMesh } from '../src/gfx/sdf.js';
import { mat4, vec3 } from '../src/core/math.js';

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.stack.split('\n').slice(0, 3).join('\n    ')}`); }
}
function ok(c, msg = 'Bedingung verletzt') { if (!c) throw new Error(msg); }

const def = buildGerrySkeletonDef();
const t0 = performance.now();
const cpu = buildGerryMeshes({ furShells: 20 });
const buildMs = performance.now() - t0;

test('Skelett: Humanoid + Extras tail_0..5 (Becken-Kette), ear_l/ear_r (Kopf)', () => {
  ok(def.count <= 64, 'max 64 Knochen');
  for (let i = 0; i < 6; i++) {
    const b = def.index['tail_' + i]; ok(b !== undefined, 'tail_' + i + ' fehlt');
    ok(def.names[def.parents[b]] === (i ? 'tail_' + (i - 1) : 'pelvis'), 'tail_' + i + ' Elter falsch');
  }
  for (const e of ['ear_l', 'ear_r']) ok(def.names[def.parents[def.index[e]]] === 'head', e + ' Elter falsch');
  ok(def.names.slice(0, 22).join() === 'root,pelvis,spine,chest,neck,head,shoulder_l,arm_l,forearm_l,hand_l,shoulder_r,arm_r,forearm_r,hand_r,thigh_l,shin_l,foot_l,toe_l,thigh_r,shin_r,foot_r,toe_r', 'Humanoid-Reihenfolge');
});

test('Skelett: links = +X, Füße auf y≈0, Blick +Z', () => {
  ok(GERRY_JOINTS.arm_l[0] > 0 && GERRY_JOINTS.arm_r[0] < 0, 'Seiten');
  ok(GERRY_JOINTS.toe_l[2] > GERRY_JOINTS.foot_l[2], 'Zehen vorn');
  ok(GERRY_JOINTS.foot_l[1] < 0.12, 'Fuß nahe Boden');
});

test('Basis-Mesh: geschlossen, keine NaN, Gewichte normiert', () => {
  const c = checkMesh(cpu.body);
  ok(c.nan === 0, 'NaN ' + c.nan);
  ok(c.boundaryEdges === 0, 'offene Kanten ' + c.boundaryEdges);
  ok(c.weightErr === 0, 'Gewichtsfehler ' + c.weightErr);
  ok(c.nonManifoldEdges < 60, 'nicht-mannigfaltig ' + c.nonManifoldEdges);
});

test('Mesh-Bounds: Höhe ≈ heightM (inkl. Ohren), steht auf dem Boden', () => {
  const p = cpu.body.positions; let ymin = 1e9, ymax = -1e9;
  for (let i = 1; i < p.length; i += 3) { ymin = Math.min(ymin, p[i]); ymax = Math.max(ymax, p[i]); }
  ok(Math.abs(ymin) < 0.01, 'ymin ' + ymin.toFixed(3));
  ok(Math.abs(ymax - GERRY_HEIGHT) < 0.04, 'ymax ' + ymax.toFixed(3));
});

test('Fell: lange + kurze Schalen-Meshes vorhanden, Indizes gültig, keine Kleidung', () => {
  for (const m of [cpu.furLong, cpu.furShort]) {
    const n = m.positions.length / 3;
    ok(m.indices.length > 300, 'zu wenige Dreiecke');
    for (let i = 0; i < m.indices.length; i++) if (m.indices[i] >= n) throw new Error('Index außerhalb');
    for (let v = 0; v < n; v++) ok(m.colors[4 * v + 3] > 0.03, 'Fell ohne Länge');
    ok(m.joints && m.weights && m.uvs, 'Skin/Flow-Attribute fehlen');
  }
});

test('Budget: ≤ ~460k Dreiecke bei furShells=20, Bauzeit gemeldet', () => {
  const s = cpu.stats;
  ok(s.totalTris <= 460000, 'zu viele Dreiecke: ' + s.totalTris);
  ok(s.shellsLong === 20 && s.shellsShort >= 8, 'Schalenzahl');
  const low = buildGerryMeshes({ furShells: 8 });
  ok(low.stats.totalTris < s.totalTris * 0.6, 'low nicht günstiger');
});

// Attrappen-Renderer für den Asset-Vertrag
const mockR = {
  q: { furShells: 14 },
  meshes: 0, materials: [],
  createMesh(m) { this.meshes++; ok(m.positions && m.normals && m.indices, 'Meshdaten'); return { data: m }; },
  createMaterial(d) { ok(typeof d.name === 'string', 'Materialname'); const mat = { ...d, uniforms: { ...d.uniforms } }; this.materials.push(mat); return mat; },
};
const asset = buildGerry(mockR, mockR.q);

test('Asset-Vertrag §5.4', () => {
  ok(asset.id === 'gerry' && asset.name === 'Gerry', 'id/name');
  ok(asset.heightM === GERRY_HEIGHT && GERRY_HEIGHT < 1.45, 'heightM (Chibi)');
  ok(asset.skeletonDef && asset.skeletonDef.index.tail_5 !== undefined, 'skeletonDef');
  ok(asset.parts.length >= 3 && asset.parts.every((p) => p.mesh && p.material && p.skinned === true), 'parts');
  ok(asset.parts.some((p) => p.shells === 14), 'Schalenzahl aus q.furShells');
  ok(asset.attachments.length >= 10, 'attachments');
  for (const a of asset.attachments) {
    ok(asset.skeletonDef.index[a.bone] !== undefined, 'unbekannter Knochen ' + a.bone);
    ok(a.mesh && a.material && a.offset && a.offset.length === 16 && a.name, 'Anbauteil unvollständig');
  }
  ok(JSON.stringify(asset.secondary) === JSON.stringify({ tail: ['tail_0', 'tail_1', 'tail_2', 'tail_3', 'tail_4', 'tail_5'], ears: ['ear_l', 'ear_r'] }), 'secondary');
  for (const k of ['frame', 'accent', 'grip']) ok(asset.racketStyle[k].length === 3, 'racketStyle.' + k);
});

test('Griff-Sockel: in der Faust, Rahmen orthonormal, Daumen zeigt nach vorn', () => {
  for (const g of [asset.gripSocket, asset.leftHandGrip]) {
    ok(g.bone === 'hand_r' || g.bone === 'hand_l', 'bone');
    const L = Math.hypot(...g.offset);
    ok(L > 0.02 && L < 0.09, 'Offset ' + L.toFixed(3));
    ok(g.matrix.length === 16 && g.rotation.length === 4, 'matrix/rotation');
    const y = [g.matrix[4], g.matrix[5], g.matrix[6]], z = [g.matrix[8], g.matrix[9], g.matrix[10]];
    ok(Math.abs(vec3.dot(y, z)) < 1e-4 && Math.abs(vec3.length(y) - 1) < 1e-4, 'orthonormal');
    ok(y[2] > 0.8, 'Schaft (+Y) zeigt in Ruhe nach vorn');
  }
  // Spiegelbildlich
  const a = asset.gripSocket.offset, b = asset.leftHandGrip.offset;
  ok(Math.abs(a[0] + b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4, 'Griffe spiegelbildlich');
});

test('Gesicht: Blinzeln (manuell + automatisch), Stimmungen, Blick ohne NaN', () => {
  const lid = asset.attachments.find((a) => a.name === 'lidUp_l');
  const before = Array.from(lid.offset);
  asset.face.update(0, { blink: 1 });
  const closed = Array.from(lid.offset);
  ok(before.some((v, i) => Math.abs(v - closed[i]) > 1e-3), 'Lid bewegt sich nicht');
  asset.face.update(0, { blink: 0 });
  let blinked = false;
  for (let t = 0; t < 8; t += 1 / 60) {
    asset.face.update(1 / 60, { mood: 'focused', lookDir: [0.3, 0.1, 1] });
    if (asset.face.state.blink > 0.5) blinked = true;
  }
  ok(blinked, 'kein automatisches Blinzeln in 8 s');
  for (const mood of ['neutral', 'happy', 'focused', 'sad']) {
    asset.face.update(0, { blink: 0, mood, lookDir: [0, -0.2, 1] });
    for (const a of asset.attachments) ok(a.offset.every(Number.isFinite), 'NaN in ' + a.name + ' (' + mood + ')');
  }
});

test('Skinning: Schwanz-Pose hebt die Spitze (Euler x > 0), Ohren drehen', () => {
  const sk = createSkeleton(def);
  const p = poseFromEuler(def, { tail_0: [40, 0, 0], tail_1: [20, 0, 0], tail_2: [20, 0, 0], ear_l: [0, 0, 20] });
  const tip0 = sk.restPos('tail_5').slice();
  sk.update(p);
  const tip1 = sk.getWorldPos('tail_5', vec3.create());
  ok(tip1[1] > tip0[1] + 0.15, 'Schwanzspitze nicht gehoben: ' + tip0[1].toFixed(3) + ' -> ' + tip1[1].toFixed(3));
  const bi = def.index.tail_5, m = sk.skin.subarray(16 * bi, 16 * bi + 16);
  ok(Array.from(m).every(Number.isFinite), 'Skin-Matrix NaN');
});

test('Skinning: jeder Fell-/Basis-Vertex hat Gewichte auf existierenden Knochen', () => {
  for (const m of [cpu.body, cpu.furLong, cpu.furShort]) {
    const n = m.positions.length / 3;
    for (let v = 0; v < n; v += 7) {
      let s = 0;
      for (let k = 0; k < 4; k++) { s += m.weights[4 * v + k]; ok(m.joints[4 * v + k] < def.count, 'Knochenindex'); }
      ok(Math.abs(s - 1) < 1e-3, 'Gewichtssumme ' + s);
    }
  }
});

void mat4;
const st = cpu.stats;
console.log(`gerry: build ${buildMs.toFixed(0)} ms (body ${st.bodyTris} tris, fur ${st.furLongTris}×${st.shellsLong} + ${st.furShortTris}×${st.shellsShort}, total ${st.totalTris})`);
if (failures.length) console.log(failures.join('\n'));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

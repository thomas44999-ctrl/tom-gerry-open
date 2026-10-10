// Tests für src/chars/tom.js + src/chars/racket.js (CPU-Teil, ohne GPU): Asset-Vertrag (§5.4), Mesh-Gültigkeit,
// Skin-Gewichte, Budget, Griff-Sockel, Mimik, Schläger-Maße. Aufruf: node test/tom.test.mjs
import { buildTom, buildTomGeometry, TOM_MAT, TOM_HEIGHT } from '../src/chars/tom.js';
import { buildRacket, buildRacketGeometry, RACKET_STYLES } from '../src/chars/racket.js';
import { checkMesh } from '../src/gfx/sdf.js';
import { mat4 } from '../src/core/math.js';

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); }
}
function ok(c, msg = 'Bedingung verletzt') { if (!c) throw new Error(msg); }
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}: ${a} statt ${b} ± ${tol}`);

// Renderer-Attrappe: buildTom/buildRacket brauchen nur createMesh/createMaterial
const fakeRenderer = { q: { name: 'high' }, createMesh: (m) => ({ data: m }), createMaterial: (o) => ({ ...o }) };

buildTomGeometry({ name: 'high' });                      // JIT aufwärmen
const t0 = performance.now();
const G = buildTomGeometry({ name: 'high' });
const ms = performance.now() - t0;
const asset = buildTom(fakeRenderer);
const nb = G.skeletonDef.names.length;
const bi = (n) => G.skeletonDef.index[n];

test('Budget: <= 120k Dreiecke (high)', () => ok(G.stats.triangles <= 120000, `${G.stats.triangles} Dreiecke`));
test('Bauzeit (Node, warm) unter 2.5 s (Ziel ~1 s, Last-tolerant)', () => ok(ms < 2500, `${Math.round(ms)} ms`));
test('low-Qualität ist deutlich kleiner', () => {
  const L = buildTomGeometry({ name: 'low' });
  ok(L.stats.triangles < G.stats.triangles * 0.8, `low ${L.stats.triangles} vs high ${G.stats.triangles}`);
});

for (const [name, m] of Object.entries(G.meshes)) {
  test(`Mesh ${name}: endlich, Normalen, Gewichte, kaum gekippte Dreiecke`, () => {
    const c = checkMesh(m);
    ok(c.triangles > 0, 'leer');
    ok(c.nan === 0, `${c.nan} NaN`);
    ok(c.badNormals <= c.vertices * 0.001, `${c.badNormals} schlechte Normalen`);
    if (m.weights) ok(c.weightErr === 0, `${c.weightErr} Gewichtssummen != 1`);
    ok(c.flipped <= c.triangles * 0.01, `${c.flipped} gekippte Dreiecke von ${c.triangles}`);
  });
}

test('Skin: Gelenk-Indizes gültig, Kopf/Bein-Bereiche sauber getrennt', () => {
  const legs = new Set(['thigh_l', 'shin_l', 'foot_l', 'toe_l', 'thigh_r', 'shin_r', 'foot_r', 'toe_r'].map(bi));
  const arms = new Set(['arm_l', 'forearm_l', 'hand_l', 'arm_r', 'forearm_r', 'hand_r'].map(bi));
  for (const key of ['body', 'head']) {
    const m = G.meshes[key], P = m.positions, J = m.joints, W = m.weights;
    for (let v = 0; v < P.length / 3; v++) {
      for (let k = 0; k < 4; k++) {
        const j = J[4 * v + k], w = W[4 * v + k];
        ok(j >= 0 && j < nb, `${key}: Gelenk ${j} ungültig`);
        if (w < 0.02) continue;
        if (P[3 * v + 1] > 0.85) ok(!legs.has(j), `${key}: Kopfbereich hängt an Bein-Knochen ${j}`);
        if (P[3 * v + 1] < 0.3) ok(!arms.has(j), `${key}: Unterschenkel hängt an Arm-Knochen ${j}`);
      }
    }
  }
});

test('Material-IDs: Haut, Polo, Shorts, Kragen, Schuh, Socke, Haare, Mund vorhanden', () => {
  const ids = new Set();
  for (const key of ['body', 'head']) { const D = G.meshes[key].data; for (let i = 0; i < D.length; i += 4) ids.add(D[i]); }
  for (const k of ['SKIN', 'SHIRT', 'SHORTS', 'COLLAR', 'SHOE', 'SOCK', 'HAIR', 'MOUTH', 'TEETH']) ok(ids.has(TOM_MAT[k]), `${k} fehlt`);
});

test('Proportionen (Chibi): Höhe ~TOM_HEIGHT, Kopf ~1/3 der Größe, Füße auf y=0', () => {
  let ymax = -1, ymin = 1, xmin = 1, xmax = -1, hmin = 9;
  for (const key of ['body', 'head']) {
    const P = G.meshes[key].positions;
    for (let i = 0; i < P.length; i += 3) {
      ymax = Math.max(ymax, P[i + 1]); ymin = Math.min(ymin, P[i + 1]);
      if (key === 'head' && P[i + 1] > 0.86) { xmin = Math.min(xmin, P[i]); xmax = Math.max(xmax, P[i]); }
    }
  }
  near(ymax, TOM_HEIGHT, 0.03, 'Scheitel');
  near(ymin, 0, 0.012, 'Sohle');
  near(xmax, -xmin, 0.012, 'Symmetrie (Kopf)');
  ok((ymax - 0.86) / ymax > 0.3, `Kopf zu klein für Chibi: ${((ymax - 0.86) / ymax).toFixed(2)}`);
});

test('Asset-Vertrag §5.4', () => {
  ok(asset.id === 'tom' && asset.name === 'Tom', 'id/name');
  ok(asset.heightM === TOM_HEIGHT, 'heightM');
  ok(asset.skeletonDef && asset.skeletonDef.names.length >= 22, 'skeletonDef');
  ok(asset.parts.length >= 2 && asset.parts.every((p) => p.mesh && p.material && p.skinned), 'parts');
  const names = asset.attachments.map((a) => a.name);
  for (const n of ['eye_l', 'eye_r', 'lid_l', 'lid_r', 'brow_l', 'brow_r']) ok(names.includes(n), `Attachment ${n} fehlt`);
  ok(asset.attachments.every((a) => a.bone === 'head' && a.offset && a.offset.length === 16), 'Attachment-Offsets');
  ok(asset.gripSocket.bone === 'hand_r' && asset.gripSocket.offset.length === 3, 'gripSocket');
  ok(asset.gripSocket.matrix && asset.gripSocket.matrix.length === 16, 'gripSocket.matrix');
  ok(asset.leftHandGrip && asset.leftHandGrip.bone === 'hand_l', 'leftHandGrip');
  for (const k of ['frame', 'accent', 'grip']) ok(asset.racketStyle[k].length === 3, `racketStyle.${k}`);
});

test('Griff-Sockel: Faustmitte nahe der Hand, Schläger zeigt nach vorn-oben', () => {
  const o = asset.gripSocket.offset;
  const d = Math.hypot(o[0], o[1], o[2]);
  ok(d > 0.05 && d < 0.12, `Abstand Handgelenk -> Faust ${d.toFixed(3)}`);
  // Faustmitte liegt innerhalb der Hand-Hülle (Abstand zur Handoberfläche < 2.5 cm)
  const W = G.J.hand_r, p = [W[0] + o[0], W[1] + o[1], W[2] + o[2]];
  const e = G.sculpts.handsS.eval(p[0], p[1], p[2]);
  ok(e < 0 && e > -0.07, `Griffpunkt nicht in der Faust (${e.toFixed(3)})`);
  // Schaftachse (+Y des Sockels) in Ruhe: nach vorn (+Z) und eher aufwärts als abwärts
  const m = asset.gripSocket.matrix, y = [m[4], m[5], m[6]];
  ok(y[2] > 0.3, `Schaft zeigt nicht nach vorn: ${y.map((v) => v.toFixed(2))}`);
  ok(y[1] > -0.2, `Schaft zeigt nach unten: ${y.map((v) => v.toFixed(2))}`);
});

test('Mimik: Blinzeln schließt die Lider, Stimmung bewegt die Brauen', () => {
  const lid = asset.attachments.find((a) => a.name === 'lid_l'), brow = asset.attachments.find((a) => a.name === 'brow_l');
  asset.face.update(0, { blink: 0, mood: 'neutral' });
  const open = Array.from(lid.offset), b0 = Array.from(brow.offset);
  asset.face.update(0, { blink: 1, mood: 'focused' });
  ok(open.some((v, i) => Math.abs(v - lid.offset[i]) > 1e-3), 'Lid unverändert');
  ok(b0.some((v, i) => Math.abs(v - brow.offset[i]) > 1e-4), 'Braue unverändert');
  asset.face.update(0.016, { mood: 'happy', lookDir: [0.3, 0.1, 1] });      // Auto-Blinzeln + Blick: keine Fehler
  ok(asset.attachments.every((a) => a.offset.every(Number.isFinite)), 'NaN in Offsets');
});

test('Schläger: Maße gemäß §5.4, beide Stile', () => {
  for (const s of ['tom', 'gerry']) {
    const rk = buildRacket(fakeRenderer, RACKET_STYLES[s]);
    near(rk.length, 0.685, 0.012, `${s} Länge`);
    near(rk.sweetSpot[1], 0.48, 0.04, `${s} Sweet-Spot`);
    near(rk.headSize[0], 0.25, 0.02, `${s} Kopfbreite`);
    near(rk.headSize[1], 0.31, 0.03, `${s} Kopfhöhe`);
    ok(rk.parts.length >= 2 && rk.parts.every((p) => p.mesh && p.material), 'parts');
    const g = buildRacketGeometry(RACKET_STYLES[s]);
    let zmax = 0;
    for (let i = 2; i < g.body.positions.length; i += 3) zmax = Math.max(zmax, Math.abs(g.body.positions[i]));
    ok(zmax < 0.03, `Rahmen zu dick: ${zmax}`);
  }
});

test('Schläger am Sockel: Kopf liegt vor/über der Faust, nicht im Körper', () => {
  const m = mat4.multiply(mat4.create(), mat4.fromTranslation(mat4.create(), G.J.hand_r), asset.gripSocket.matrix);
  const p = [0, 0.48, 0], w = [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
  ok(G.sculpts.bodyS.eval(w[0], w[1], w[2]) > 0.05, `Schlägerkopf im Körper: ${w.map((v) => v.toFixed(2))}`);
});

console.log(`tom.test: ${passed} bestanden, ${failed} fehlgeschlagen  (Bauzeit ${Math.round(ms)} ms, ${G.stats.triangles} Dreiecke, Phasen ${JSON.stringify(G.stats.polyMs)})`);
if (failures.length) { console.log(failures.join('\n')); process.exit(1); }

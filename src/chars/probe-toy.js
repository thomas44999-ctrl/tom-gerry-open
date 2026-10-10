// Figuren-Probe, Variante B: einfache 3D-Spielzeugfiguren aus wenigen Grundformen.
// Großer Kopf, Knopfaugen, Toon-Schattierung mit harter Licht/Schatten-Kante, dunkle Kontur (invertierte
// Hülle mit bildschirmkonstanter Breite), kein Fell, großer Schläger. Jedes Körperteil ist starr an einen
// Knoten gebunden (kein Skinning). Gesicht mit Stimmungen: Augen, Brauen und Mund wechseln mit der Pose.
// Animation: wenige gehaltene Schlüsselposen mit kurzem, überschwingendem Übergang (probe-toy-poses.js),
// dazu Squash & Stretch, nachfedernder Kopf und ein kleines Stolpern im Laufzyklus.
//
//   const fig = buildToyFigure(renderer, 'tom' | 'gerry');
//   fig.position, fig.yaw; fig.setPose('treffer') | fig.play('laufen'); fig.update(dt); fig.drawables
import { mat4, quat, hexToLinear } from '../core/math.js';
import { sphere, capsule, cylinder, torus, transform, merge, setColor, setData } from '../gfx/geometry.js';
import { TOY_POSES, TOY_CLIPS, TOY_STILL, MOODS } from './probe-toy-poses.js';

// ---------------------------------------------------------------- Farben (Paletten der Flutlicht-Pixelfiguren)
const C = (h) => hexToLinear(h);
const PAL = {
  skin: C('#EFB48F'), hair: C('#4A3226'), shirt: C('#A7D8F5'), shorts: C('#2C3F75'), shoe: C('#F3F1EA'), sole: C('#B9B6C4'),
  cheek: C('#F59A8E'), mouth: C('#7A1F26'), tongue: C('#F0727E'), eye: C('#231B1E'), white: C('#FFFFFF'), brow: C('#3A261D'),
  fur: C('#E8913C'), stripe: C('#C9761F'), cream: C('#FFF3E2'), pink: C('#F19BB0'), band: C('#E0402F'),
  rTom: C('#E0402F'), rGerry: C('#3AC8C4'), strings: C('#EFE6C8'), grip: C('#464654'), whisker: C('#3B2A22'),
};

// ---------------------------------------------------------------- Materialien
const TOON = `
void surface(in SurfaceInput i, inout Surface s) {
  vec3 base = i.color.rgb;
  s.albedo = base;
#ifndef SHADOW_PASS
  vec3 N = normalize(i.normal);
  float NoL = dot(N, u_sunDir);
  float sh = tg_sunShadow(i.worldPos, N, NoL);
  float lit = smoothstep(0.0, 0.06, NoL) * sh;
  vec3 amb = mix(tg_shIrradiance(vec3(0.0, 1.0, 0.0)), tg_shIrradiance(N), 0.4);
  vec3 sun = u_sunColor * TG_INV_PI;
  vec3 col = base * (amb * u_toon.x + sun * mix(u_toon.y, u_toon.z, lit));
  float fres = pow(1.0 - saturate(dot(N, i.viewDir)), 3.0);
  col += base * sun * fres * u_toon.w * (0.35 + 0.65 * lit);
  vec3 H = normalize(u_sunDir + i.viewDir);
  col += vec3(step(0.975, dot(N, H)) * i.data.x * (0.25 + 0.75 * lit)) * 1.6;
  if (i.data.z > 0.5) {
    vec2 g = abs(fract(i.objPos.xy / 0.028) - 0.5);
    col *= mix(1.0, 0.5, step(0.36, max(g.x, g.y)));
  }
  if (i.data.y > 0.5) col = base * 1.3;
  s.albedo = col;
#endif
}`;

const OUTLINE_VS = `
void vertexWorld(inout vec3 wp, inout vec3 wn) {
  float d = length(wp - u_cameraPos);
  wp += wn * min(u_ol.x + u_ol.y * d, u_ol.z);
}`;

let _mats = null;
function materials(r) {
  if (_mats && _mats.r === r) return _mats;
  _mats = {
    r,
    toon: r.createMaterial({ name: 'probe-toy-toon', unlit: true, uniforms: { u_toon: [1.0, 0.16, 0.86, 0.55] }, surface: TOON }),
    outline: r.createMaterial({
      name: 'probe-toy-outline', unlit: true, cull: 'front', castShadow: false,
      uniforms: { u_ol: [0.0035, 0.0017, 0.045], u_olColor: C('#1B1420') },
      vertex: OUTLINE_VS, surface: 'void surface(in SurfaceInput i, inout Surface s) { s.albedo = u_olColor; }',
    }),
  };
  return _mats;
}

// ---------------------------------------------------------------- Grundformen
const _m = mat4.create(), _q = quat.create();
const UNIT_SPHERE = sphere(1, 22, 14);
/** Gefärbte Grundform; o: { ol: Kontur (Standard ja), gloss, bright, strings }. */
function paint(mesh, col, o = {}) {
  setColor(mesh, [col[0], col[1], col[2], 1]);
  setData(mesh, [o.gloss || 0, o.bright ? 1 : 0, o.strings ? 1 : 0, 0]);
  return { mesh, ol: o.ol !== false };
}
function rotQ(rot) { return Array.isArray(rot) && rot.length === 4 ? rot : quat.fromEuler(quat.create(), ...(rot || [0, 0, 0])); }
/** Ellipsoid mit Halbachsen rad, Mitte c, Drehung rot (Euler-Grad oder Quaternion). */
function ell(rad, c, col, rot, o) {
  return paint(transform(UNIT_SPHERE, mat4.fromRotationTranslationScale(_m, rotQ(rot), c, rad)), col, o);
}
/** Kapsel von a nach b (Radius rad). */
function cap(a, b, rad, col, o) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0], d[1], d[2]) || 1e-4;
  quat.rotationTo(_q, [0, 1, 0], [d[0] / L, d[1] / L, d[2] / L]);
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  return paint(transform(capsule(rad, L, 6, 14), mat4.fromRotationTranslation(_m, _q, mid)), col, o);
}
/** Kegelstumpf von a (Radius r0) nach b (Radius r1). */
function cyl(a, b, r0, r1, col, o) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0], d[1], d[2]) || 1e-4;
  quat.rotationTo(_q, [0, 1, 0], [d[0] / L, d[1] / L, d[2] / L]);
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  return paint(transform(cylinder(r1, r0, L, 14), mat4.fromRotationTranslation(_m, _q, mid)), col, o);
}
/** Bogen (Mund, frohe Augen) in der XY-Ebene: Halbkreis nach unten (up=false) oder oben. */
function arc(R, r, c, col, up, o, span = Math.PI) {
  const m = transform(torus(R, r, 6, 16, span, 'z'), mat4.fromRotationTranslation(_m, quat.fromEuler(_q, 0, 0, up ? 90 - span / Math.PI * 90 : 270 - span / Math.PI * 90), c));
  return paint(m, col, o);
}
/** Punkt und Normale auf einem Ellipsoid (Mitte c, Halbachsen rad) in Richtung dir. */
function onEll(c, rad, dir, k = 1) {
  const l = Math.hypot(dir[0], dir[1], dir[2]);
  const d = [dir[0] / l, dir[1] / l, dir[2] / l];
  const n = [d[0] / rad[0], d[1] / rad[1], d[2] / rad[2]], nl = Math.hypot(n[0], n[1], n[2]);
  return { p: [c[0] + d[0] * rad[0] * k, c[1] + d[1] * rad[1] * k, c[2] + d[2] * rad[2] * k], n: [n[0] / nl, n[1] / nl, n[2] / nl] };
}
const faceQ = (n) => quat.rotationTo(quat.create(), [0, 0, 1], n);

// ---------------------------------------------------------------- Rig
class Node {
  constructor(name, parent, pos) {
    this.name = name; this.parent = parent; this.base = pos.slice();
    this.pos = pos.slice(); this.rot = quat.create(); this.baseRot = quat.create(); this.scale = [1, 1, 1];
    this.local = mat4.create(); this.world = mat4.create(); this.parts = []; this.visible = true; this.drawables = [];
  }
}

function makeRig(def) {
  const nodes = {}, order = [];
  for (const [name, parent, pos] of def) { nodes[name] = new Node(name, parent ? nodes[parent] : null, pos); order.push(nodes[name]); }
  return { nodes, order };
}

// Knoten: Name, Eltern, Position relativ zum Eltern-Knoten (Ruhepose, Blick +Z, links = +X)
function humanoid(o) {
  const def = [
    ['root', null, [0, 0, 0]], ['hips', 'root', [0, o.hipY, 0]], ['body', 'hips', [0, 0.06, 0]],
    ['head', 'body', [0, o.neckY, 0]],
    ['armL', 'body', [o.shX, o.shY, 0]], ['foreL', 'armL', [0, -o.upper, 0]], ['handL', 'foreL', [0, -o.lower, 0]],
    ['armR', 'body', [-o.shX, o.shY, 0]], ['foreR', 'armR', [0, -o.upper, 0]], ['handR', 'foreR', [0, -o.lower, 0]],
    ['racket', 'handR', [0, -0.01, 0.0]],
    ['legL', 'hips', [o.hipX, -0.02, 0]], ['footL', 'legL', [0, -o.leg, 0]],
    ['legR', 'hips', [-o.hipX, -0.02, 0]], ['footR', 'legR', [0, -o.leg, 0]],
  ];
  return def;
}

// ---------------------------------------------------------------- Gesicht (Knoten je Stimmungsvariante)
function addFace(rig, add, F) {
  const { c, rad } = F;
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    const e = onEll(c, rad, [s * F.eyeX, F.eyeY, 1], 0.985);
    const q = faceQ(e.n);
    rig.extra.push(['eye' + side, 'head', e.p], ['eyeHappy' + side, 'head', e.p]);
    add('eye' + side, ell(F.eyeR, [0, 0, 0], PAL.eye, q, { gloss: 1, ol: false }));
    add('eye' + side, ell([F.eyeR[0] * 0.3, F.eyeR[0] * 0.3, 0.01], [s * F.eyeR[0] * 0.25, F.eyeR[1] * 0.42, F.eyeR[2] * 0.75], PAL.white, q, { bright: 1, ol: false }));
    add('eyeHappy' + side, arc(F.eyeR[0] * 0.95, 0.011, [0, -F.eyeR[1] * 0.25, 0.012], PAL.eye, true, { ol: false }));
    const b = onEll(c, rad, [s * F.eyeX, F.eyeY + F.browUp, 1], 1.0);
    rig.extra.push(['brow' + side, 'head', b.p]);
    add('brow' + side, cap([-F.browW / 2, 0, 0.004], [F.browW / 2, 0, 0.004], 0.011, PAL.brow, { ol: false }));
    const k = onEll(c, rad, [s * F.cheekX, F.cheekY, 1], 0.99);
    add('head', ell([0.045, 0.026, 0.012], k.p, PAL.cheek, faceQ(k.n), { ol: false }));
  }
  const m = F.mouthAt;
  for (const v of ['smile', 'grin', 'open', 'oh', 'grit', 'frown']) rig.extra.push(['mouth_' + v, 'head', m.p]);
  const W = F.mouthW, Mo = { ol: false };
  add('mouth_smile', arc(W * 0.55, 0.01, [0, 0.012, 0.004], PAL.mouth, false, Mo));
  add('mouth_grin', ell([W * 0.9, W * 0.55, 0.012], [0, -W * 0.15, 0], PAL.mouth, null, Mo));
  add('mouth_grin', ell([W * 0.75, W * 0.18, 0.012], [0, W * 0.2, 0.004], PAL.white, null, Mo));
  add('mouth_open', ell([W * 0.95, W * 0.72, 0.014], [0, -W * 0.2, 0], PAL.mouth, null, Mo));
  add('mouth_open', ell([W * 0.55, W * 0.3, 0.012], [0, -W * 0.52, 0.006], PAL.tongue, null, Mo));
  add('mouth_oh', ell([W * 0.36, W * 0.48, 0.014], [0, -W * 0.1, 0], PAL.mouth, null, Mo));
  add('mouth_grit', ell([W * 0.78, W * 0.3, 0.012], [0, 0, 0], PAL.white, null, { ol: false }));
  add('mouth_grit', cap([-W * 0.78, 0, 0.012], [W * 0.78, 0, 0.012], 0.006, PAL.mouth, Mo));
  add('mouth_grit', ell([W * 0.8, W * 0.33, 0.008], [0, 0, -0.002], PAL.mouth, null, Mo));
  add('mouth_frown', arc(W * 0.5, 0.01, [0, -0.02, 0.004], PAL.mouth, true, Mo));
  rig.faceQ = faceQ(m.n);
  rig.eyeQ = {};
}

// ---------------------------------------------------------------- Schläger (Griff im Ursprung, +Y zum Kopf)
function addRacket(add, frameCol, neckCol) {
  const hy = 0.47, ha = 0.165, hb = 0.2;
  add('racket', cyl([0, -0.06, 0], [0, 0.17, 0], 0.024, 0.021, PAL.grip));
  add('racket', cyl([0, 0.16, 0], [-0.05, 0.29, 0], 0.014, 0.014, neckCol));
  add('racket', cyl([0, 0.16, 0], [0.05, 0.29, 0], 0.014, 0.014, neckCol));
  add('racket', paint(transform(torus(1, 0.1, 8, 40, Math.PI * 2, 'z'), mat4.fromRotationTranslationScale(_m, [0, 0, 0, 1], [0, hy, 0], [ha, hb, 0.18])), frameCol, { gloss: 0.6 }));
  add('racket', ell([ha * 0.95, hb * 0.95, 0.004], [0, hy, 0], PAL.strings, null, { strings: true, ol: false }));
}

// ---------------------------------------------------------------- Tom
function buildTomParts(rig, add) {
  const F = { c: [0, 0.27, 0.01], rad: [0.27, 0.265, 0.265], eyeX: 0.34, eyeY: 0.06, eyeR: [0.042, 0.064, 0.024], browUp: 0.3, browW: 0.07, cheekX: 0.6, cheekY: -0.18, mouthW: 0.06 };
  F.mouthAt = onEll(F.c, F.rad, [0, -0.38, 1], 0.99);
  add('hips', ell([0.19, 0.12, 0.15], [0, 0.03, 0], PAL.shorts));
  add('body', ell([0.205, 0.205, 0.165], [0, 0.15, 0], PAL.shirt));
  add('body', ell([0.1, 0.035, 0.08], [0, 0.31, 0.03], PAL.shirt));
  add('head', ell(F.rad, F.c, PAL.skin));
  add('head', ell([0.035, 0.03, 0.03], onEll(F.c, F.rad, [0, -0.12, 1], 0.98).p, PAL.skin));
  for (const s of [1, -1]) add('head', ell([0.035, 0.055, 0.04], [s * 0.265, 0.26, -0.01], PAL.skin));
  // Haare: Kappe hinten/oben, Pony aus drei Strähnen, Wirbel
  add('head', ell([0.285, 0.24, 0.28], [0, 0.33, -0.035], PAL.hair, [-12, 0, 0]));
  for (const [x, rz] of [[-0.12, 25], [0.0, 0], [0.12, -25]]) add('head', ell([0.09, 0.06, 0.06], [x, 0.47, 0.17], PAL.hair, [20, 0, rz]));
  add('head', cyl([0.0, 0.52, -0.02], [0.05, 0.63, 0.02], 0.035, 0.006, PAL.hair));
  addFace(rig, add, F);
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    add('arm' + side, ell([0.075, 0.075, 0.075], [0, -0.01, 0], PAL.shirt));
    add('arm' + side, cap([0, -0.04, 0], [0, -0.13, 0], 0.046, PAL.skin));
    add('fore' + side, cap([0, 0, 0], [0, -0.1, 0], 0.044, PAL.skin));
    add('hand' + side, ell([0.062, 0.068, 0.062], [0, -0.035, 0.0], PAL.skin));
    add('hand' + side, ell([0.025, 0.035, 0.025], [s * -0.05, -0.02, 0.03], PAL.skin));
    add('leg' + side, cap([0, -0.05, 0], [0, -0.25, 0], 0.056, PAL.skin));
    add('leg' + side, cyl([0, -0.2, 0], [0, -0.27, 0], 0.062, 0.062, PAL.shoe));
    add('foot' + side, ell([0.088, 0.066, 0.135], [0, -0.03, 0.04], PAL.shoe));
    add('foot' + side, ell([0.09, 0.025, 0.138], [0, -0.075, 0.04], PAL.sole));
  }
  addRacket(add, PAL.rTom, PAL.rTom);
}

// ---------------------------------------------------------------- Gerry
function buildGerryParts(rig, add) {
  const F = { c: [0, 0.24, 0.0], rad: [0.3, 0.25, 0.26], eyeX: 0.36, eyeY: 0.12, eyeR: [0.046, 0.068, 0.024], browUp: 0.32, browW: 0.07, cheekX: 0.66, cheekY: -0.12, mouthW: 0.05 };
  const muz = onEll(F.c, F.rad, [0, -0.42, 1], 0.86).p;
  F.mouthAt = { p: [0, muz[1] - 0.045, muz[2] + 0.07], n: [0, -0.15, 1] };
  add('hips', ell([0.17, 0.12, 0.15], [0, 0.04, 0], PAL.fur));
  add('body', ell([0.2, 0.2, 0.17], [0, 0.12, 0], PAL.fur));
  add('body', ell([0.14, 0.16, 0.08], [0, 0.11, 0.105], PAL.cream, null, { ol: false }));
  for (const y of [0.18, 0.08]) for (const s of [1, -1]) add('body', ell([0.05, 0.018, 0.06], [s * 0.18, y, -0.04], PAL.stripe, [0, 0, s * 20], { ol: false }));
  add('head', ell(F.rad, F.c, PAL.fur));
  add('head', ell([0.13, 0.085, 0.09], muz, PAL.cream));
  add('head', ell([0.035, 0.024, 0.02], [0, muz[1] + 0.045, muz[2] + 0.075], PAL.pink, null, { gloss: 0.5 }));
  for (const [x, rz] of [[-0.06, 12], [0, 0], [0.06, -12]]) add('head', ell([0.018, 0.05, 0.02], onEll(F.c, F.rad, [x * 3, 0.62, 0.75], 0.99).p, PAL.stripe, [-40, 0, rz], { ol: false }));
  for (const s of [1, -1]) {
    // Ohren: Kegel nach außen geneigt, innen rosa
    add('head', cyl([s * 0.16, 0.36, 0], [s * 0.21, 0.56, 0.0], 0.1, 0.012, PAL.fur));
    add('head', cyl([s * 0.16, 0.38, 0.045], [s * 0.2, 0.52, 0.035], 0.06, 0.008, PAL.pink, { ol: false }));
    for (const k of [-1, 0, 1]) add('head', cyl([s * 0.1, muz[1] + 0.01 * k, muz[2] + 0.04], [s * 0.3, muz[1] + 0.035 * k + 0.01, muz[2] + 0.02], 0.004, 0.003, PAL.whisker, { ol: false }));
  }
  addFace(rig, add, F);
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    add('arm' + side, cap([0, 0, 0], [0, -0.12, 0], 0.05, PAL.fur));
    add('fore' + side, cap([0, 0, 0], [0, -0.09, 0], 0.047, PAL.fur));
    if (s < 0) add('fore' + side, cyl([0, -0.06, 0], [0, -0.11, 0], 0.056, 0.056, PAL.band));
    add('hand' + side, ell([0.062, 0.062, 0.062], [0, -0.03, 0], PAL.cream));
    add('leg' + side, cap([0, -0.03, 0], [0, -0.2, 0], 0.072, PAL.fur));
    add('foot' + side, ell([0.085, 0.06, 0.115], [0, -0.03, 0.035], PAL.cream));
  }
  // Schwanz: fünf Glieder, geringelt, weiße Spitze
  const cols = [PAL.fur, PAL.stripe, PAL.fur, PAL.stripe, PAL.cream];
  for (let i = 0; i < 5; i++) {
    rig.extra.push(['tail' + i, i ? 'tail' + (i - 1) : 'hips', i ? [0, 0.1, 0] : [0, 0.05, -0.14]]);
    add('tail' + i, cap([0, 0, 0], [0, 0.1, 0], 0.042 - i * 0.003, cols[i]));
  }
  addRacket(add, PAL.rGerry, C('#18767C'));
}

const SPECS = {
  tom: { hipY: 0.42, neckY: 0.33, shX: 0.2, shY: 0.25, upper: 0.14, lower: 0.12, hipX: 0.1, leg: 0.3, build: buildTomParts },
  gerry: { hipY: 0.33, neckY: 0.27, shX: 0.19, shY: 0.2, upper: 0.13, lower: 0.11, hipX: 0.095, leg: 0.24, build: buildGerryParts },
};

// ---------------------------------------------------------------- Figur
export function buildToyFigure(r, id) {
  const S = SPECS[id];
  const M = materials(r);
  const pending = {};
  const rigDef = { extra: [] };
  const add = (node, part) => { (pending[node] || (pending[node] = [])).push(part); };
  S.build(rigDef, add);
  const rig = makeRig([...humanoid(S), ...rigDef.extra]);
  for (const n of rig.order) {
    const list = pending[n.name];
    if (!list) continue;
    const fill = r.createMesh(merge(list.map((p) => p.mesh)));
    n.drawables.push({ mesh: fill, material: M.toon, model: n.world, castShadow: true });
    const ol = list.filter((p) => p.ol);
    if (ol.length) n.drawables.push({ mesh: r.createMesh(merge(ol.map((p) => p.mesh))), material: M.outline, model: n.world, castShadow: false });
  }
  // Gesichtsteile zeigen nach außen
  for (const k of Object.keys(rig.nodes)) if (k.startsWith('mouth_')) quat.copy(rig.nodes[k].baseRot, rigDef.faceQ);
  return new ToyFigure(id, rig);
}

const _qa = quat.create(), _qb = quat.create();
const lerp = (a, b, t) => a + (b - a) * t;
/** Überschwingendes Ausklingen (easeOutBack). */
function backOut(t, k = 1.9) { const u = t - 1; return 1 + (k + 1) * u * u * u + k * u * u; }

class ToyFigure {
  constructor(id, rig) {
    this.id = id; this.rig = rig; this.N = rig.nodes;
    this.position = new Float32Array(3); this.yaw = 0;
    this.drawables = rig.order.flatMap((n) => n.drawables);
    this.clip = null; this.time = 0; this.keyIdx = 0; this.cycle = 0;
    this.cur = null; this.from = null; this.to = null; this.tween = 1;
    this.sq = 1; this.sqV = 0; this.bob = 0; this.bobV = 0; this.lastY = 0;
    this.setPose('bereit');
  }

  /** Gehaltene Schlüsselpose für Standbilder (Probe-Posen: bereit, laufen, aus, treffer, jubel, enttaeuscht). */
  setPose(name) {
    this.clip = null;
    const P = TOY_POSES[TOY_STILL[name] || name] || TOY_POSES.ready;
    this.cur = P; this.from = P; this.to = P; this.tween = 1;
    this.sq = P.sq || 1; this.sqV = 0; this.bob = P.bob || 0; this.bobV = 0;
    this._apply(P, P, 1);
  }

  /** Clip abspielen: Schlüsselposen halten, kurz und überschwingend wechseln. */
  play(name) {
    this.clip = TOY_CLIPS[name] || TOY_CLIPS.bereit;
    this.time = 0; this.keyIdx = 0; this.cycle = 0;
    const k = this._key(0);
    this.from = this.to = TOY_POSES[k.pose]; this.tween = 1;
  }

  _key(i) {
    const keys = this.clip.keys;
    let k = keys[i % keys.length];
    // kleines Stolpern: jeder dritte Laufzyklus ersetzt eine Schlüsselpose
    if (this.clip.stumble && this.cycle % 3 === 2 && k.pose === this.clip.stumble.at) k = this.clip.stumble;
    return k;
  }

  update(dt) {
    if (this.clip && dt > 0) {
      const keys = this.clip.keys;
      this.time += dt;
      let k = this._key(this.keyIdx);
      while (this.time >= k.hold) {
        this.time -= k.hold;
        let next = this.keyIdx + 1;
        if (next >= keys.length) { if (this.clip.loop) { next = 0; this.cycle++; } else { next = keys.length - 1; this.time = 0; break; } }
        this.from = this._blendSnapshot();
        this.keyIdx = next;
        k = this._key(next);
        this.to = TOY_POSES[k.pose];
        this.tween = 0; this.tweenDur = k.tween ?? Math.min(0.07, k.hold * 0.45);
      }
      if (this.tween < 1) this.tween = Math.min(1, this.tween + dt / Math.max(1e-3, this.tweenDur));
      // Squash & Stretch und Kopf-Nachfedern als gedämpfte Federn auf das Ziel der Schlüsselpose
      const target = this.to.sq || 1;
      const w = 34, z = 0.32;
      this.sqV += (-w * w * (this.sq - target) - 2 * z * w * this.sqV) * dt; this.sq += this.sqV * dt;
      const bT = this.to.bob || 0;
      this.bobV += (-26 * 26 * (this.bob - bT) - 2 * 0.25 * 26 * this.bobV) * dt; this.bob += this.bobV * dt;
      this._apply(this.from, this.to, backOut(this.tween));
    } else if (!this.clip) this._apply(this.cur, this.cur, 1);
    this._matrices();
  }

  _blendSnapshot() { return this.tween >= 1 ? this.to : { ...this.to, _blend: [this.from, this.to, backOut(this.tween)] }; }

  /** Pose (Euler-Grad je Knoten) anwenden; zwischen a und b linear mit Gewicht t (darf überschwingen). */
  _apply(a, b, t) {
    if (a && a._blend) a = a._blend[1];
    const N = this.N;
    for (const n of this.rig.order) { vec3copy(n.pos, n.base); quat.copy(n.rot, n.baseRot); n.scale[0] = n.scale[1] = n.scale[2] = 1; }
    const names = new Set([...Object.keys(a.rot || {}), ...Object.keys(b.rot || {})]);
    for (const name of names) {
      const n = N[name];
      const ea = (a.rot && a.rot[name]) || ZERO, eb = (b.rot && b.rot[name]) || ZERO;
      const e = [lerp(ea[0], eb[0], t), lerp(ea[1], eb[1], t), lerp(ea[2], eb[2], t)];
      if (name === 'tail') { for (let i = 0; i < 5; i++) if (N['tail' + i]) quat.fromEuler(N['tail' + i].rot, ...(i ? e : [e[0] + (b.tailBase || -60), e[1], e[2]])); continue; }
      if (n) quat.fromEuler(n.rot, e[0], e[1], e[2]);
    }
    const oa = a.hips || ZERO, ob = b.hips || ZERO;
    N.hips.pos[0] += lerp(oa[0], ob[0], t); N.hips.pos[1] += lerp(oa[1], ob[1], t); N.hips.pos[2] += lerp(oa[2], ob[2], t);
    // Stimmung: wechselt in der Mitte des Übergangs
    this._mood(t < 0.5 ? a.mood : b.mood);
    // Squash & Stretch (volumenerhaltend) am Wurzelknoten, Kopf federt nach
    const sq = this.clip ? this.sq : (b.sq || 1);
    const sx = 1 / Math.sqrt(sq);
    N.root.scale[0] = sx; N.root.scale[1] = sq; N.root.scale[2] = sx;
    const bob = this.clip ? this.bob : (b.bob || 0);
    quat.multiply(N.head.rot, N.head.rot, quat.fromEuler(_qa, bob * 40, 0, 0));
    N.head.scale[1] = 1 + bob * 0.3; N.head.scale[0] = N.head.scale[2] = 1 - bob * 0.15;
  }

  _mood(m) {
    const M = MOODS[m] || MOODS.neutral, N = this.N;
    for (const k of Object.keys(N)) if (k.startsWith('mouth_')) N[k].visible = k === 'mouth_' + M.mouth;
    for (const s of ['L', 'R']) {
      const sg = s === 'L' ? 1 : -1;
      N['eye' + s].visible = !M.happyEyes; N['eyeHappy' + s].visible = !!M.happyEyes;
      N['eye' + s].scale[1] = M.eyeY || 1;
      N['eye' + s].pos[1] += M.eyeDrop || 0;
      quat.fromEuler(N['brow' + s].rot, 0, 0, sg * (M.brow || 0));
      N['brow' + s].pos[1] += M.browLift || 0;
      quat.multiply(N['brow' + s].rot, quat.fromEuler(_qb, -12, sg * 18, 0), N['brow' + s].rot);
    }
  }

  _matrices() {
    const N = this.N;
    mat4.fromYawTranslation(N.root.local, this.yaw, this.position);
    mat4.scale(N.root.local, N.root.local, N.root.scale);
    for (const n of this.rig.order) {
      if (n !== N.root) {
        mat4.fromRotationTranslationScale(n.local, n.rot, n.pos, n.scale);
        mat4.multiply(n.world, n.parent.world, n.local);
      } else mat4.copy(n.world, n.local);
      let vis = n.visible, p = n.parent;
      while (p) { vis = vis && p.visible; p = p.parent; }
      for (const d of n.drawables) d.visible = vis;
    }
  }
}

const ZERO = [0, 0, 0];
function vec3copy(o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; }

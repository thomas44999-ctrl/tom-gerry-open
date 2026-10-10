// SDF-Modellierung + Polygonisierung (Surface Nets) + Skin-Gewichte + AO-Bake.
// Damit werden Tom und Gerry zur Laufzeit aus Code "modelliert".
//
// ============================================================================ KURZANLEITUNG
//
//   import { createSculpt, P, polygonize } from '../gfx/sdf.js';
//
//   const s = createSculpt({ blend: 0.02, skinBlend: 0.04 });          // Standardwerte für alle Knoten
//   s.add(P.ellipsoid([0, 1.65, 0], [0.09, 0.11, 0.1]), { bone: 'head', mat: 1, color: '#e8b896' });
//   s.add(P.capsule([0.19, 1.43, 0], [0.39, 1.21, 0], 0.045), { bone: 'arm_l', mirror: true });  // + gespiegelt (arm_r)
//   s.subtract(P.sphere([0.03, 1.66, 0.1], 0.015), { blend: 0.006, color: '#40201a' });         // Augenhöhle
//   s.group({ blend: 0.01, bone: 'foot_l', mat: 3, color: '#ffffff', mirror: true }, (g) => {   // Schuh als Gruppe
//     g.add(P.roundBox([0.1, 0.04, 0.05], [0.05, 0.04, 0.13], 0.02));
//     g.intersect(P.plane([0, 0.0, 0], [0, -1, 0]));                    // unten flach abschneiden (lokal!)
//   });
//   s.with({ bone: 'chest', color: '#9fd3ff', mat: 2 }, () => { s.add(...); s.add(...); });   // temporäre Defaults
//
//   const mesh = polygonize(s, { cell: 0.008, skeleton: skelDef });     // -> Mesh-Daten gemäß ARCHITECTURE §4.1
//
// KNOTEN-OPTIONEN (add/subtract/intersect/weight/group; alles optional, erbt Defaults von with()/group()/createSculpt):
//   op          'union' | 'subtract' | 'intersect' | 'weight' | 'paint'
//               (add() = union; weight = nur Skin-Gewichts-Volumen; paint = färbt die bisherige Oberfläche innerhalb
//               des Primitivs um (Farbe/mat/tag, weicher Rand = colorBlend), ohne die Form zu ändern)
//   blend       Glättungsradius k (m) der weichen Verknüpfung (polynomielles smin/smax). 0 = harte Kante.
//   colorBlend  Breite des Farb-/Materialübergangs (m). Standard: 0.35 * blend. 0 = harte Farbkante.
//   color       '#rrggbb' (sRGB, wird linearisiert) oder [r,g,b(,a)] linear. Subtract/Intersect: nur wenn
//               angegeben, färbt die Schnittfläche (z.B. dunkles Mundinneres).
//   mat         Material-ID (ganzzahlig, landet in data[0]). Wechselt dort, wo die Farbe > 50 % wechselt.
//   tag         freier Skalar, wird wie Farbe weich gemischt -> data[3] (z.B. Fell-Maske 0..1).
//   bone        'arm_l' oder { chest: 0.6, arm_l: 0.4 } (Mischbindung). Ohne bone kein Skin-Einfluss.
//   skinBlend   Übergangsbreite σ (m) der Skin-Gewichte dieses Primitivs (Standard 0.04). Zwischen zwei
//               Primitiven gilt min(σ_a, σ_b). 0 = starr (z.B. Schuhe, Uhr).
//   skin        false = Primitiv zählt nicht für Skin-Gewichte (Standard: union/weight true, sonst false).
//   displace    (x, y, z, d) => d'  Verschiebungs-Hook im Modellraum (Rauschen, Falten, Haarbüschel).
//   displaceAmp maximale |d' - d| (m), nötig für korrektes Culling. Standard 0.01 wenn displace gesetzt.
//   mirror      true = zusätzlich an der Ebene X=0 gespiegelte Kopie (Knochen _l <-> _r werden getauscht).
//   name        Debug-Name.
//
// PRIMITIVE (alle Positionen im Modellraum der Figur, Meter; rot = [xDeg,yDeg,zDeg] (quat.fromEuler, d.h.
// R = Rz*Ry*Rx) oder Quaternion [x,y,z,w]; scale = Zahl oder [sx,sy,sz] – nicht-uniform ist eine Näherung):
//   P.sphere(c, r)                          P.ellipsoid(c, [rx,ry,rz], rot?)
//   P.capsule(a, b, r)                      P.roundCone(a, b, ra, rb)     (Kegelstumpf mit Kugelenden, exakt)
//   P.roundBox(c, [hx,hy,hz], round, rot?, scale?)   (Halbe Außenmaße inkl. Rundung)
//   P.box(c, half, rot?)                    P.cylinder(a, b, r, round = 0)
//   P.torus(c, R, r, rot?, scale?)          (Ring in der lokalen XZ-Ebene, Achse = lokal Y)
//   P.arc(c, R, r, halfAngleDeg, rot?, scale?)  (gekappter Torus/Bogen in lokaler XY-Ebene, symmetrisch um +Y)
//   P.plane(point, normal)                  (Halbraum; "innen" = gegen die Normale) – für intersect/subtract
//   P.bezier(a, b, c, r0, r1 = r0)          (quadratische Bézier-Röhre mit variablem Radius: Haare, Schwanz, Brauen)
//   P.custom((x,y,z) => d, bboxMin, bboxMax)
//
// POLYGONIZE-OPTIONEN: siehe polygonize() unten. Ergebnis: { positions, normals, colors, data, joints, weights,
//   indices, vertexCount, triangleCount, stats }. data = [matId, bakedAO, curvature|thickness, tag].
//
// Hilfen: raycast(sculpt, origin, dir) (Oberflächenpunkt finden, z.B. für Augen), sculpt.eval(x,y,z),
//   sculpt.sample(x,y,z) -> {d,color,mat,tag}, extractSubmesh(mesh, keep), checkMesh(mesh), meshBounds(mesh).

import { quat, mat3, hexToLinear, clamp } from '../core/math.js';

const BIG = 1e10;
const OP = { union: 0, subtract: 1, intersect: 2, weight: 3, paint: 4 };
const OP_UNION = 0, OP_SUB = 1, OP_INTER = 2, OP_WEIGHT = 3, OP_PAINT = 4;
const I_PRIM = 0, I_BEGIN = 1, I_END = 2;

// Primitiv-Typen (gepackte Parameter, siehe primDist)
const T_SPHERE = 0, T_ELLIPSOID = 1, T_CAPSULE = 2, T_ROUNDCONE = 3, T_ROUNDBOX = 4, T_CYLINDER = 5;
const T_TORUS = 6, T_ARC = 7, T_PLANE = 8, T_BEZIER = 9, T_CUSTOM = 10;

// ============================================================================ Primitive

const mirrorPt = (p) => [-p[0], p[1], p[2]];
function toQuat(rot) {
  if (!rot) return [0, 0, 0, 1];
  if (rot.length === 4) { const q = quat.normalize(quat.create(), rot); return [q[0], q[1], q[2], q[3]]; }
  const q = quat.fromEuler(quat.create(), rot[0], rot[1], rot[2]); return [q[0], q[1], q[2], q[3]];
}
const mirrorQuat = (q) => [q[0], -q[1], -q[2], q[3]];
const toScale = (s) => (s == null ? [1, 1, 1] : typeof s === 'number' ? [s, s, s] : [s[0], s[1], s[2]]);

/** Lokaler Rahmen: Zentrum, Rotation (quat), Skalierung. Gepackt: c(3), m(9: diag(1/s)*R^T, zeilenweise), smin. */
class Frame {
  constructor(c, rot, scale) { this.c = [c[0], c[1], c[2]]; this.q = toQuat(rot); this.s = toScale(scale); }
  mirror() { const f = Object.create(Frame.prototype); f.c = mirrorPt(this.c); f.q = mirrorQuat(this.q); f.s = this.s.slice(); return f; }
  pack(P) {
    const R = mat3.fromQuat(new Float32Array(9), this.q); // spaltenweise: Spalte j = lokale Achse j
    const s = this.s;
    P.push(this.c[0], this.c[1], this.c[2]);
    for (let j = 0; j < 3; j++) P.push(R[3 * j] / s[j], R[3 * j + 1] / s[j], R[3 * j + 2] / s[j]);
    P.push(Math.min(s[0], s[1], s[2]));
  }
  /** AABB eines lokalen Quaders [-e, e] (Achsen-Halbmaße e) nach Transformation. */
  bbox(e) {
    const R = mat3.fromQuat(new Float32Array(9), this.q), s = this.s;
    const out = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 3; i++) {
      // |R| * (s*e) für Achse i
      let ext = 0;
      for (let j = 0; j < 3; j++) ext += Math.abs(R[3 * j + i]) * s[j] * e[j];
      out[i] = this.c[i] - ext; out[i + 3] = this.c[i] + ext;
    }
    return out;
  }
}

class Prim {
  constructor(type, spec) { this.type = type; this.spec = spec; }
  /** Abstand (langsamer Pfad, für API/Tests). */
  dist(x, y, z) { if (!this._p) { const a = []; this.pack(a); this._p = Float64Array.from(a); } return primDist(this.type, this._p, 0, x, y, z, this.spec.fn); }
}

class Sphere extends Prim {
  constructor(c, r) { super(T_SPHERE, { c: [...c], r }); }
  pack(P) { const { c, r } = this.spec; P.push(c[0], c[1], c[2], r); }
  bbox() { const { c, r } = this.spec; return [c[0] - r, c[1] - r, c[2] - r, c[0] + r, c[1] + r, c[2] + r]; }
  mirror() { return new Sphere(mirrorPt(this.spec.c), this.spec.r); }
}
class Ellipsoid extends Prim {
  constructor(c, radii, rot, frame) { super(T_ELLIPSOID, { radii: [...radii], frame: frame || new Frame(c, rot, null) }); }
  pack(P) { this.spec.frame.pack(P); const r = this.spec.radii; P.push(r[0], r[1], r[2]); }
  bbox() { return this.spec.frame.bbox(this.spec.radii); }
  mirror() { return new Ellipsoid(null, this.spec.radii, null, this.spec.frame.mirror()); }
}
class Capsule extends Prim {
  constructor(a, b, r) { super(T_CAPSULE, { a: [...a], b: [...b], r }); }
  pack(P) {
    const { a, b, r } = this.spec; const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
    P.push(a[0], a[1], a[2], bx, by, bz, 1 / Math.max(1e-12, bx * bx + by * by + bz * bz), r);
  }
  bbox() { const { a, b, r } = this.spec; return [Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.min(a[2], b[2]) - r, Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, Math.max(a[2], b[2]) + r]; }
  mirror() { return new Capsule(mirrorPt(this.spec.a), mirrorPt(this.spec.b), this.spec.r); }
}
class RoundCone extends Prim {
  constructor(a, b, ra, rb) {
    super(T_ROUNDCONE, { a: [...a], b: [...b], ra, rb });
    // Entartung (eine Kugel enthält die andere) -> Kugel
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (l < Math.abs(ra - rb) + 1e-5) this.type = T_SPHERE;
  }
  pack(P) {
    const { a, b, ra, rb } = this.spec;
    if (this.type === T_SPHERE) { const c = ra >= rb ? a : b; P.push(c[0], c[1], c[2], Math.max(ra, rb)); return; }
    const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
    const l2 = bx * bx + by * by + bz * bz, rr = ra - rb, a2 = l2 - rr * rr;
    P.push(a[0], a[1], a[2], bx, by, bz, ra, rb, l2, rr, a2, 1 / l2);
  }
  bbox() { const { a, b, ra, rb } = this.spec; return [Math.min(a[0] - ra, b[0] - rb), Math.min(a[1] - ra, b[1] - rb), Math.min(a[2] - ra, b[2] - rb), Math.max(a[0] + ra, b[0] + rb), Math.max(a[1] + ra, b[1] + rb), Math.max(a[2] + ra, b[2] + rb)]; }
  mirror() { return new RoundCone(mirrorPt(this.spec.a), mirrorPt(this.spec.b), this.spec.ra, this.spec.rb); }
}
class RoundBox extends Prim {
  constructor(c, half, round = 0, rot, scale, frame) { super(T_ROUNDBOX, { half: [...half], round: Math.min(round, half[0], half[1], half[2]), frame: frame || new Frame(c, rot, scale) }); }
  pack(P) { this.spec.frame.pack(P); const { half, round } = this.spec; P.push(half[0] - round, half[1] - round, half[2] - round, round); }
  bbox() { return this.spec.frame.bbox(this.spec.half); }
  mirror() { return new RoundBox(null, this.spec.half, this.spec.round, null, null, this.spec.frame.mirror()); }
}
class Cylinder extends Prim {
  constructor(a, b, r, round = 0) { super(T_CYLINDER, { a: [...a], b: [...b], r, round }); }
  pack(P) {
    const { a, b, r } = this.spec; let round = this.spec.round;
    let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]; const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
    round = Math.min(round, r * 0.999, l * 0.499);
    dx /= l; dy /= l; dz /= l;
    const a2 = [a[0] + dx * round, a[1] + dy * round, a[2] + dz * round], b2 = [b[0] - dx * round, b[1] - dy * round, b[2] - dz * round];
    const bx = b2[0] - a2[0], by = b2[1] - a2[1], bz = b2[2] - a2[2];
    P.push(a2[0], a2[1], a2[2], bx, by, bz, bx * bx + by * by + bz * bz, r - round, round);
  }
  bbox() { const { a, b, r } = this.spec; return [Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.min(a[2], b[2]) - r, Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, Math.max(a[2], b[2]) + r]; }
  mirror() { return new Cylinder(mirrorPt(this.spec.a), mirrorPt(this.spec.b), this.spec.r, this.spec.round); }
}
class Torus extends Prim {
  constructor(c, R, r, rot, scale, frame) { super(T_TORUS, { R, r, frame: frame || new Frame(c, rot, scale) }); }
  pack(P) { this.spec.frame.pack(P); P.push(this.spec.R, this.spec.r); }
  bbox() { const { R, r } = this.spec; return this.spec.frame.bbox([R + r, r, R + r]); }
  mirror() { return new Torus(null, this.spec.R, this.spec.r, null, null, this.spec.frame.mirror()); }
}
class Arc extends Prim {
  constructor(c, R, r, halfAngleDeg, rot, scale, frame) { super(T_ARC, { R, r, an: halfAngleDeg, frame: frame || new Frame(c, rot, scale) }); }
  pack(P) { this.spec.frame.pack(P); const an = this.spec.an * Math.PI / 180; P.push(this.spec.R, this.spec.r, Math.sin(an), Math.cos(an)); }
  bbox() { const { R, r } = this.spec; return this.spec.frame.bbox([R + r, R + r, r]); }
  mirror() { return new Arc(null, this.spec.R, this.spec.r, this.spec.an, null, null, this.spec.frame.mirror()); }
}
class Plane extends Prim {
  constructor(p, n) { const l = Math.hypot(n[0], n[1], n[2]) || 1; super(T_PLANE, { p: [...p], n: [n[0] / l, n[1] / l, n[2] / l] }); }
  pack(P) { const { p, n } = this.spec; P.push(n[0], n[1], n[2], n[0] * p[0] + n[1] * p[1] + n[2] * p[2]); }
  bbox() { return [-BIG, -BIG, -BIG, BIG, BIG, BIG]; }
  mirror() { return new Plane(mirrorPt(this.spec.p), mirrorPt(this.spec.n)); }
}
class Bezier extends Prim {
  constructor(a, b, c, r0, r1 = r0) { super(T_BEZIER, { a: [...a], b: [...b], c: [...c], r0, r1 }); }
  pack(P) { const { a, b, c, r0, r1 } = this.spec; P.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], r0, r1); }
  bbox() {
    const { a, b, c, r0, r1 } = this.spec; const r = Math.max(r0, r1);
    return [0, 1, 2].map((i) => Math.min(a[i], b[i], c[i]) - r).concat([0, 1, 2].map((i) => Math.max(a[i], b[i], c[i]) + r));
  }
  mirror() { return new Bezier(mirrorPt(this.spec.a), mirrorPt(this.spec.b), mirrorPt(this.spec.c), this.spec.r0, this.spec.r1); }
}
class Custom extends Prim {
  constructor(fn, bmin, bmax) { super(T_CUSTOM, { fn, bmin: [...bmin], bmax: [...bmax] }); }
  pack(P) { P.push(0); }
  bbox() { return [...this.spec.bmin, ...this.spec.bmax]; }
  mirror() { const f = this.spec.fn; return new Custom((x, y, z) => f(-x, y, z), [-this.spec.bmax[0], this.spec.bmin[1], this.spec.bmin[2]], [-this.spec.bmin[0], this.spec.bmax[1], this.spec.bmax[2]]); }
}

/** Primitiv-Fabrik (siehe Kopfkommentar). */
export const P = {
  sphere: (c, r) => new Sphere(c, r),
  ellipsoid: (c, radii, rot) => new Ellipsoid(c, radii, rot),
  capsule: (a, b, r) => new Capsule(a, b, r),
  roundCone: (a, b, ra, rb) => new RoundCone(a, b, ra, rb),
  roundBox: (c, half, round = 0, rot = null, scale = null) => new RoundBox(c, half, round, rot, scale),
  box: (c, half, rot = null) => new RoundBox(c, half, 0, rot, null),
  cylinder: (a, b, r, round = 0) => new Cylinder(a, b, r, round),
  torus: (c, R, r, rot = null, scale = null) => new Torus(c, R, r, rot, scale),
  arc: (c, R, r, halfAngleDeg, rot = null, scale = null) => new Arc(c, R, r, halfAngleDeg, rot, scale),
  cappedTorus: (c, R, r, halfAngleDeg, rot = null, scale = null) => new Arc(c, R, r, halfAngleDeg, rot, scale),
  plane: (point, normal) => new Plane(point, normal),
  bezier: (a, b, c, r0, r1 = r0) => {
    // (fast) gerade Kurve -> exakter roundCone (die kubische Lösung wird dort numerisch instabil)
    const ex = a[0] - 2 * b[0] + c[0], ey = a[1] - 2 * b[1] + c[1], ez = a[2] - 2 * b[2] + c[2];
    const l = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    if (Math.hypot(ex, ey, ez) < 2e-3 * Math.max(l, 1e-3)) return new RoundCone(a, c, r0, r1);
    return new Bezier(a, b, c, r0, r1);
  },
  custom: (fn, bmin, bmax) => new Custom(fn, bmin, bmax),
};

/**
 * Quaternion, dessen lokale Y-Achse auf `yAxis` zeigt und dessen lokale Z-Achse möglichst nah an `zHint` liegt.
 * Praktisch, um Ellipsoide/Boxen entlang von Knochen auszurichten: P.ellipsoid(c, r, alignQuat(dir, [0,0,1])).
 */
export function alignQuat(yAxis, zHint = [0, 0, 1]) {
  const l = Math.hypot(yAxis[0], yAxis[1], yAxis[2]) || 1;
  const y = [yAxis[0] / l, yAxis[1] / l, yAxis[2] / l];
  let hz = zHint;
  let dp = hz[0] * y[0] + hz[1] * y[1] + hz[2] * y[2];
  if (Math.abs(dp) > 0.999) { hz = Math.abs(y[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1]; dp = hz[0] * y[0] + hz[1] * y[1] + hz[2] * y[2]; }
  const z = [hz[0] - y[0] * dp, hz[1] - y[1] * dp, hz[2] - y[2] * dp];
  const zl = Math.hypot(z[0], z[1], z[2]); z[0] /= zl; z[1] /= zl; z[2] /= zl;
  const x = [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]];
  const q = quat.fromMat3(quat.create(), [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]]);
  quat.normalize(q, q);
  return [q[0], q[1], q[2], q[3]];
}
/** Punkt auf der Strecke a->b (t in [0,1]), plus optionalem Versatz. */
export function along(a, b, t, off = null) {
  const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  if (off) { p[0] += off[0]; p[1] += off[1]; p[2] += off[2]; }
  return p;
}

// ---------------------------------------------------------------------------- Distanzfunktionen (heißer Pfad)

function primDist(t, P, o, x, y, z, fn) {
  switch (t) {
    case T_SPHERE: {
      const dx = x - P[o], dy = y - P[o + 1], dz = z - P[o + 2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz) - P[o + 3];
    }
    case T_ELLIPSOID: {
      const dx = x - P[o], dy = y - P[o + 1], dz = z - P[o + 2];
      const lx = P[o + 3] * dx + P[o + 4] * dy + P[o + 5] * dz;
      const ly = P[o + 6] * dx + P[o + 7] * dy + P[o + 8] * dz;
      const lz = P[o + 9] * dx + P[o + 10] * dy + P[o + 11] * dz;
      const rx = P[o + 13], ry = P[o + 14], rz = P[o + 15];
      const ax = lx / rx, ay = ly / ry, az = lz / rz;
      const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
      const bx = ax / rx, by = ay / ry, bz = az / rz;
      const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
      const rmin = rx < ry ? (rx < rz ? rx : rz) : (ry < rz ? ry : rz);
      if (k1 < 1e-12) return -rmin * P[o + 12];
      if (k0 >= 1) return (k0 * (k0 - 1) / k1) * P[o + 12];
      // innen: iq-Näherung überschätzt |d| tief im Inneren flacher Ellipsoide -> zur sicheren Schranke
      // (k0-1)*rmin überblenden (an der Oberfläche stetig, tief innen konservativ fürs Culling)
      const f = k0 / k1;
      let tt = (1 - k0) * 2.5; tt = tt > 1 ? 1 : tt;
      const sm = tt * tt * (3 - 2 * tt);
      return (k0 - 1) * (f + (rmin - f) * sm) * P[o + 12];
    }
    case T_CAPSULE: {
      const px = x - P[o], py = y - P[o + 1], pz = z - P[o + 2];
      const bx = P[o + 3], by = P[o + 4], bz = P[o + 5];
      let h = (px * bx + py * by + pz * bz) * P[o + 6];
      h = h < 0 ? 0 : h > 1 ? 1 : h;
      const qx = px - bx * h, qy = py - by * h, qz = pz - bz * h;
      return Math.sqrt(qx * qx + qy * qy + qz * qz) - P[o + 7];
    }
    case T_ROUNDCONE: {
      // iq: exakter Abstand zum "round cone"
      const pax = x - P[o], pay = y - P[o + 1], paz = z - P[o + 2];
      const bax = P[o + 3], bay = P[o + 4], baz = P[o + 5];
      const r1 = P[o + 6], r2 = P[o + 7], l2 = P[o + 8], rr = P[o + 9], a2 = P[o + 10], il2 = P[o + 11];
      const yv = pax * bax + pay * bay + paz * baz;
      const zv = yv - l2;
      const wx = pax * l2 - bax * yv, wy = pay * l2 - bay * yv, wz = paz * l2 - baz * yv;
      const x2 = wx * wx + wy * wy + wz * wz;
      const y2 = yv * yv * l2, z2 = zv * zv * l2;
      const k = (rr > 0 ? 1 : rr < 0 ? -1 : 0) * rr * rr * x2;
      if ((zv > 0 ? 1 : zv < 0 ? -1 : 0) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
      if ((yv > 0 ? 1 : yv < 0 ? -1 : 0) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
      return (Math.sqrt(x2 * a2 * il2) + yv * rr) * il2 - r1;
    }
    case T_ROUNDBOX: {
      const dx = x - P[o], dy = y - P[o + 1], dz = z - P[o + 2];
      const lx = Math.abs(P[o + 3] * dx + P[o + 4] * dy + P[o + 5] * dz) - P[o + 13];
      const ly = Math.abs(P[o + 6] * dx + P[o + 7] * dy + P[o + 8] * dz) - P[o + 14];
      const lz = Math.abs(P[o + 9] * dx + P[o + 10] * dy + P[o + 11] * dz) - P[o + 15];
      const mx = lx > 0 ? lx : 0, my = ly > 0 ? ly : 0, mz = lz > 0 ? lz : 0;
      const inner = Math.max(lx, ly, lz);
      return (Math.sqrt(mx * mx + my * my + mz * mz) + (inner < 0 ? inner : 0) - P[o + 16]) * P[o + 12];
    }
    case T_CYLINDER: {
      // iq: sdCappedCylinder(p, a, b, r) + Rundung
      const pax = x - P[o], pay = y - P[o + 1], paz = z - P[o + 2];
      const bax = P[o + 3], bay = P[o + 4], baz = P[o + 5], baba = P[o + 6], r = P[o + 7];
      const paba = pax * bax + pay * bay + paz * baz;
      const qx = pax * baba - bax * paba, qy = pay * baba - bay * paba, qz = paz * baba - baz * paba;
      const xx = Math.sqrt(qx * qx + qy * qy + qz * qz) - r * baba;
      const yy = Math.abs(paba - baba * 0.5) - baba * 0.5;
      const x2 = xx * xx, y2 = yy * yy * baba;
      const d = Math.max(xx, yy) < 0 ? -Math.min(x2, y2) : (xx > 0 ? x2 : 0) + (yy > 0 ? y2 : 0);
      return (d < 0 ? -Math.sqrt(-d) : Math.sqrt(d)) / baba - P[o + 8];
    }
    case T_TORUS: {
      const dx = x - P[o], dy = y - P[o + 1], dz = z - P[o + 2];
      const lx = P[o + 3] * dx + P[o + 4] * dy + P[o + 5] * dz;
      const ly = P[o + 6] * dx + P[o + 7] * dy + P[o + 8] * dz;
      const lz = P[o + 9] * dx + P[o + 10] * dy + P[o + 11] * dz;
      const qx = Math.sqrt(lx * lx + lz * lz) - P[o + 13];
      return (Math.sqrt(qx * qx + ly * ly) - P[o + 14]) * P[o + 12];
    }
    case T_ARC: {
      const dx = x - P[o], dy = y - P[o + 1], dz = z - P[o + 2];
      const lx = Math.abs(P[o + 3] * dx + P[o + 4] * dy + P[o + 5] * dz);
      const ly = P[o + 6] * dx + P[o + 7] * dy + P[o + 8] * dz;
      const lz = P[o + 9] * dx + P[o + 10] * dy + P[o + 11] * dz;
      const ra = P[o + 13], rb = P[o + 14], sx = P[o + 15], sy = P[o + 16];
      const k = sy * lx > sx * ly ? lx * sx + ly * sy : Math.sqrt(lx * lx + ly * ly);
      const v = lx * lx + ly * ly + lz * lz + ra * ra - 2 * ra * k;
      return (Math.sqrt(v > 0 ? v : 0) - rb) * P[o + 12];
    }
    case T_PLANE: return x * P[o] + y * P[o + 1] + z * P[o + 2] - P[o + 3];
    case T_BEZIER: return bezierDist(P, o, x, y, z);
    case T_CUSTOM: return fn(x, y, z);
  }
  return BIG;
}

function bezierDist(P, o, px, py, pz) {
  // iq: exakter Abstand zur quadratischen Bézierkurve (kubische Lösung), Radius linear über t
  const Ax = P[o], Ay = P[o + 1], Az = P[o + 2], Bx = P[o + 3], By = P[o + 4], Bz = P[o + 5], Cx = P[o + 6], Cy = P[o + 7], Cz = P[o + 8];
  const ax = Bx - Ax, ay = By - Ay, az = Bz - Az;
  const bx = Ax - 2 * Bx + Cx, by = Ay - 2 * By + Cy, bz = Az - 2 * Bz + Cz;
  const cx = ax * 2, cy = ay * 2, cz = az * 2;
  const dx = Ax - px, dy = Ay - py, dz = Az - pz;
  const kk = 1 / (bx * bx + by * by + bz * bz);
  const kx = kk * (ax * bx + ay * by + az * bz);
  const ky = kk * (2 * (ax * ax + ay * ay + az * az) + (dx * bx + dy * by + dz * bz)) / 3;
  const kz = kk * (dx * ax + dy * ay + dz * az);
  const p = ky - kx * kx, p3 = p * p * p;
  const q = kx * (2 * kx * kx - 3 * ky) + kz;
  let h = q * q + 4 * p3, res, tt;
  if (h >= 0) {
    h = Math.sqrt(h);
    const x0 = (h - q) / 2, x1 = (-h - q) / 2;
    const u = Math.sign(x0) * Math.cbrt(Math.abs(x0)), v = Math.sign(x1) * Math.cbrt(Math.abs(x1));
    let t = u + v - kx; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = dx + (cx + bx * t) * t, ey = dy + (cy + by * t) * t, ez = dz + (cz + bz * t) * t;
    res = ex * ex + ey * ey + ez * ez; tt = t;
  } else {
    const zz = Math.sqrt(-p);
    const vv = Math.acos(clamp(q / (p * zz * 2), -1, 1)) / 3;
    const m = Math.cos(vv), n = Math.sin(vv) * 1.732050808;
    let t0 = (m + m) * zz - kx, t1 = (-n - m) * zz - kx;
    t0 = t0 < 0 ? 0 : t0 > 1 ? 1 : t0; t1 = t1 < 0 ? 0 : t1 > 1 ? 1 : t1;
    let ex = dx + (cx + bx * t0) * t0, ey = dy + (cy + by * t0) * t0, ez = dz + (cz + bz * t0) * t0;
    res = ex * ex + ey * ey + ez * ez; tt = t0;
    ex = dx + (cx + bx * t1) * t1; ey = dy + (cy + by * t1) * t1; ez = dz + (cz + bz * t1) * t1;
    const r2 = ex * ex + ey * ey + ez * ez;
    if (r2 < res) { res = r2; tt = t1; }
  }
  return Math.sqrt(res) - (P[o + 9] + (P[o + 10] - P[o + 9]) * tt);
}

// ============================================================================ Sculpt (Szenengraph)

const ATTR_KEYS = ['blend', 'colorBlend', 'color', 'mat', 'tag', 'bone', 'skinBlend', 'skin'];

function mirrorBone(b) {
  const mn = (s) => s.replace(/_l$/, '_\u0001').replace(/_r$/, '_l').replace(/_\u0001$/, '_r')
    .replace(/_l_/g, '_\u0002_').replace(/_r_/g, '_l_').replace(/_\u0002_/g, '_r_');
  if (b == null) return b;
  if (typeof b === 'string') return mn(b);
  const o = {}; for (const k in b) o[mn(k)] = b[k]; return o;
}
function parseColor(c) {
  if (c == null) return null;
  if (typeof c === 'string') { const l = hexToLinear(c); return [l[0], l[1], l[2], 1]; }
  return [c[0], c[1], c[2], c.length > 3 ? c[3] : 1];
}

class Builder {
  constructor(sculpt, group, defaults, mirrored) {
    this.sculpt = sculpt; this.node = group; this._defaults = defaults; this._mirrored = mirrored;
  }
  /** Weiche Vereinigung (Standard). */
  add(prim, opts = {}) { return this._push(prim, opts, opts.op || 'union'); }
  /** Weiche Subtraktion (prim wird ausgeschnitten). */
  subtract(prim, opts = {}) { return this._push(prim, opts, 'subtract'); }
  /** Weiche Schnittmenge (alles bisher Hinzugefügte wird auf prim begrenzt). */
  intersect(prim, opts = {}) { return this._push(prim, opts, 'intersect'); }
  /** Bemalen: Oberfläche innerhalb von prim bekommt color/mat/tag (Form bleibt). colorBlend = weicher Rand. */
  paint(prim, opts = {}) { return this._push(prim, opts, 'paint'); }
  /** Unsichtbares Skin-Gewichts-Volumen (beeinflusst nur joints/weights). */
  weight(prim, opts = {}) { return this._push(prim, opts, 'weight'); }
  /** Temporäre Standardwerte für alle in fn hinzugefügten Knoten. */
  with(defaults, fn) {
    const prev = this._defaults; this._defaults = { ...prev, ...defaults };
    try { fn(this); } finally { this._defaults = prev; }
    return this;
  }
  /** Alles in fn gespiegelt hinzufügen (X -> -X, _l <-> _r). */
  mirrored(fn) {
    const b = new Builder(this.sculpt, this.node, this._defaults, !this._mirrored);
    fn(b); return this;
  }
  /**
   * Untergruppe: Kinder werden zuerst untereinander verknüpft, das Ergebnis dann mit opts.op/opts.blend in die
   * Eltern-Ebene. Alle Attribut-Optionen wirken als Defaults für die Kinder. opts.mirror: Gruppe zusätzlich gespiegelt.
   */
  group(opts = {}, fn) {
    if (typeof opts === 'function') { fn = opts; opts = {}; }
    const make = (mirrored) => {
      const node = this._makeNode(null, opts, opts.op || 'union', mirrored);
      node.children = [];
      this.node.children.push(node);
      const defaults = { ...this._defaults };
      for (const k of ATTR_KEYS) if (opts[k] !== undefined && k !== 'blend') defaults[k] = opts[k];
      if (opts.childBlend !== undefined) defaults.blend = opts.childBlend;
      fn(new Builder(this.sculpt, node, defaults, mirrored));
      this.sculpt._dirty = true;
      return node;
    };
    const n = make(this._mirrored);
    if (opts.mirror) make(!this._mirrored);
    return n;
  }
  _makeNode(prim, opts, opName, mirrored) {
    const d = this._defaults;
    const pick = (k, def) => (opts[k] !== undefined ? opts[k] : d[k] !== undefined ? d[k] : def);
    const op = OP[opName];
    if (op === undefined) throw new Error(`sdf: unbekannte op "${opName}"`);
    const blend = Math.max(0, pick('blend', 0));
    let bone = pick('bone', null);
    let displace = opts.displace || null;
    if (mirrored) {
      if (prim) prim = prim.mirror();
      bone = mirrorBone(bone);
      if (displace) { const f = displace; displace = (x, y, z, dd) => f(-x, y, z, dd); }
    }
    const explicitColor = opts.color !== undefined;
    return {
      kind: prim ? 'prim' : 'group', prim, op, name: opts.name || '',
      blend, colorBlend: Math.max(0, op === OP_PAINT ? (opts.colorBlend !== undefined ? opts.colorBlend : 0.002) : pick('colorBlend', blend * 0.35)),
      color: parseColor(pick('color', null)) || [0.75, 0.75, 0.75, 1],
      hasColor: op === OP_UNION || op === OP_WEIGHT || op === OP_PAINT || explicitColor,
      mat: pick('mat', 0) | 0, tag: pick('tag', 0),
      bone, skinBlend: Math.max(0, pick('skinBlend', 0.04)),
      skin: opts.skin !== undefined ? !!opts.skin : (op === OP_UNION || op === OP_WEIGHT) && (d.skin !== false),
      displace, displaceAmp: displace ? (opts.displaceAmp !== undefined ? opts.displaceAmp : 0.01) : 0,
    };
  }
  _push(prim, opts, opName) {
    if (!(prim instanceof Prim)) throw new Error('sdf: add() erwartet ein Primitiv aus P.*');
    const node = this._makeNode(prim, opts, opName, this._mirrored);
    this.node.children.push(node);
    this.sculpt._dirty = true;
    if (opts.mirror) this.node.children.push(this._makeNode(prim, opts, opName, !this._mirrored));
    return node;
  }
}

/** Neuer Sculpt. defaults: { blend, colorBlend, color, mat, tag, bone, skinBlend }. */
export function createSculpt(defaults = {}) { return new Sculpt(defaults); }

export class Sculpt extends Builder {
  constructor(defaults = {}) {
    const root = { kind: 'group', op: OP_UNION, blend: 0, children: [], color: [0.75, 0.75, 0.75, 1], hasColor: true, mat: 0, tag: 0, displace: null, displaceAmp: 0, colorBlend: 0 };
    super(null, root, { skinBlend: 0.04, ...defaults }, false);
    this.sculpt = this; this.root = root; this._dirty = true; this._c = null;
  }
  /** Kompilierte Programmform (intern, gecacht). */
  compile() { if (this._dirty || !this._c) { this._c = compileSculpt(this.root); this._dirty = false; } return this._c; }
  /** Abstand an einem Punkt (alle Primitive). */
  eval(x, y, z) { const C = this.compile(); return evalDist(C, C.rootList, C.rootList.length, x, y, z); }
  /** Abstand + Farbe/Material/Tag. */
  sample(x, y, z) { const C = this.compile(); const o = new Float64Array(8); evalFull(C, C.rootList, C.rootList.length, x, y, z, o); return { d: o[0], color: [o[1], o[2], o[3], o[4]], mat: o[5], tag: o[6] }; }
  /** Begrenzungsbox aller sichtbaren Primitive [[min],[max]] (inkl. Blend-/Displace-Rand). */
  bounds() { const C = this.compile(); return [[C.bounds[0], C.bounds[1], C.bounds[2]], [C.bounds[3], C.bounds[4], C.bounds[5]]]; }
  get primitiveCount() { return this.compile().primCount; }
}

// ---------------------------------------------------------------------------- Kompilieren

function compileSculpt(root) {
  const nodes = [], itype = [], iop = [], ik = [], ikc = [], match = [], always = [], ipad = [];
  const ptype = [], poff = [], P = [], fns = [], disp = [], boxes = [];
  const flat = (node) => {
    for (const ch of node.children) {
      const i = nodes.length;
      if (ch.kind === 'prim') {
        nodes.push(ch); itype.push(I_PRIM); iop.push(ch.op); ik.push(ch.blend); ikc.push(ch.colorBlend); match.push(-1);
        ptype.push(ch.prim.type); poff.push(P.length); ch.prim.pack(P); fns.push(ch.prim.type === T_CUSTOM ? ch.prim.spec.fn : null);
        disp.push(ch.displace); ipad.push(ch.displaceAmp);
        const bb = ch.prim.bbox();
        boxes.push(bb);
        always.push(ch.op === OP_INTER || ch.prim.type === T_PLANE ? 1 : 0);
      } else {
        nodes.push(ch); itype.push(I_BEGIN); iop.push(ch.op); ik.push(ch.blend); ikc.push(ch.colorBlend); match.push(-1);
        ptype.push(-1); poff.push(0); fns.push(null); disp.push(null); ipad.push(ch.displaceAmp); boxes.push(null);
        always.push(ch.op === OP_INTER ? 1 : 0);
        flat(ch);
        const e = nodes.length;
        nodes.push(ch); itype.push(I_END); iop.push(ch.op); ik.push(ch.blend); ikc.push(ch.colorBlend); match.push(i);
        ptype.push(-1); poff.push(0); fns.push(null); disp.push(ch.displace); ipad.push(ch.displaceAmp); boxes.push(null); always.push(1);
        match[i] = e;
      }
    }
  };
  flat(root);
  const n = nodes.length;
  // Gruppen-Boxen: Vereinigung der union-Kinder (inkl. deren Blend + Displace)
  const groupBox = (bi) => {
    const out = [BIG, BIG, BIG, -BIG, -BIG, -BIG];
    for (let i = bi + 1; i < match[bi]; i++) {
      if (itype[i] === I_END) continue;
      if (iop[i] !== OP_UNION) { if (itype[i] === I_BEGIN) i = match[i]; continue; }
      let b = boxes[i];
      if (itype[i] === I_BEGIN) { b = groupBox(i); boxes[i] = b; }
      if (!b) continue;
      const g = ik[i] + ipad[i];
      for (let k = 0; k < 3; k++) { out[k] = Math.min(out[k], b[k] - g); out[k + 3] = Math.max(out[k + 3], b[k + 3] + g); }
      if (itype[i] === I_BEGIN) i = match[i];
    }
    return out;
  };
  for (let i = 0; i < n; i++) if (itype[i] === I_BEGIN && !boxes[i]) boxes[i] = groupBox(i);
  const ibox = new Float64Array(6 * n);
  for (let i = 0; i < n; i++) { const b = boxes[i] || [-BIG, -BIG, -BIG, BIG, BIG, BIG]; for (let k = 0; k < 6; k++) ibox[6 * i + k] = b[k]; }
  // Gesamtbox: union-Knoten der obersten Ebene
  const bounds = [BIG, BIG, BIG, -BIG, -BIG, -BIG];
  let primCount = 0, maxK = 0, maxSkin = 0;
  for (let i = 0; i < n; i++) {
    if (itype[i] === I_PRIM) primCount++;
    if (itype[i] !== I_END) maxK = Math.max(maxK, ik[i]);
    if (nodes[i].skin && itype[i] === I_PRIM) maxSkin = Math.max(maxSkin, nodes[i].skinBlend);
  }
  for (let i = 0; i < n; i++) {
    if (iop[i] === OP_UNION && itype[i] !== I_END) {
      const g = ik[i] + ipad[i];
      for (let k = 0; k < 3; k++) { bounds[k] = Math.min(bounds[k], ibox[6 * i + k] - g); bounds[k + 3] = Math.max(bounds[k + 3], ibox[6 * i + k + 3] + g); }
    }
    if (itype[i] === I_BEGIN) i = match[i];
  }
  // Root-Listen: Distanz (ohne weight-Knoten) und vollständig
  const rootList = [], allList = [];
  for (let i = 0; i < n; i++) { allList.push(i); if (!(itype[i] === I_PRIM && iop[i] === OP_WEIGHT)) rootList.push(i); }
  return {
    n, nodes, itype: Int8Array.from(itype), iop: Int8Array.from(iop), ik: Float64Array.from(ik), ikc: Float64Array.from(ikc),
    match: Int32Array.from(match), always: Uint8Array.from(always), ipad: Float64Array.from(ipad), ibox,
    ptype: Int32Array.from(ptype), poff: Int32Array.from(poff), P: Float64Array.from(P), fns, disp,
    hasDisp: disp.some((f) => f), bounds, primCount, maxK, maxSkin,
    rootList: Int32Array.from(rootList), allList: Int32Array.from(allList),
    stack: new Float64Array(8 * 64), fstack: new Float64Array(8 * 64),
  };
}

// ---------------------------------------------------------------------------- Auswertung

/** Reiner Abstand für eine Kandidatenliste (heißer Pfad, allokationsfrei). */
function evalDist(C, list, n, x, y, z) {
  const itype = C.itype, iop = C.iop, ik = C.ik, ptype = C.ptype, poff = C.poff, P = C.P, disp = C.disp, fns = C.fns, stack = C.stack;
  let d = BIG, sp = 0;
  for (let li = 0; li < n; li++) {
    const i = list[li];
    const it = itype[i];
    let di;
    if (it === I_PRIM) {
      if (iop[i] >= OP_WEIGHT) continue; // weight/paint ändern die Form nicht
      di = primDist(ptype[i], P, poff[i], x, y, z, fns[i]);
      const f = disp[i]; if (f !== null) di = f(x, y, z, di);
    } else if (it === I_BEGIN) { stack[sp++] = d; d = BIG; continue; }
    else {
      di = d; d = stack[--sp];
      const f = disp[i]; if (f !== null && di < BIG * 0.5) di = f(x, y, z, di);
    }
    const k = ik[i];
    switch (iop[i]) {
      case OP_UNION:
        if (k > 0) { const h = k - Math.abs(d - di); d = (d < di ? d : di) - (h > 0 ? h * h * 0.25 / k : 0); } else if (di < d) d = di;
        break;
      case OP_SUB: {
        const nd = -di;
        if (k > 0) { const h = k - Math.abs(d - nd); d = (d > nd ? d : nd) + (h > 0 ? h * h * 0.25 / k : 0); } else if (nd > d) d = nd;
        break;
      }
      case OP_INTER:
        if (k > 0) { const h = k - Math.abs(d - di); d = (d > di ? d : di) + (h > 0 ? h * h * 0.25 / k : 0); } else if (di > d) d = di;
        break;
      default: break;
    }
  }
  return d;
}

/** Abstand + Attribute. out: [d, r, g, b, a, mat, tag, dominantNode]. */
function evalFull(C, list, n, x, y, z, out) {
  const itype = C.itype, iop = C.iop, ik = C.ik, ikc = C.ikc, nodes = C.nodes;
  const st = C.fstack;
  let d = BIG, r = 0.75, g = 0.75, b = 0.75, a = 1, mat = 0, tag = 0, dom = -1, sp = 0;
  for (let li = 0; li < n; li++) {
    const i = list[li];
    const it = itype[i];
    if (it === I_PRIM && iop[i] === OP_WEIGHT) continue;
    let di, cr, cg, cb, ca, cm, ct, cd, has;
    if (it === I_PRIM) {
      di = primDist(C.ptype[i], C.P, C.poff[i], x, y, z, C.fns[i]);
      const f = C.disp[i]; if (f !== null) di = f(x, y, z, di);
      const nd = nodes[i]; cr = nd.color[0]; cg = nd.color[1]; cb = nd.color[2]; ca = nd.color[3]; cm = nd.mat; ct = nd.tag; cd = i; has = nd.hasColor;
    } else if (it === I_BEGIN) {
      const o = 8 * sp++; st[o] = d; st[o + 1] = r; st[o + 2] = g; st[o + 3] = b; st[o + 4] = a; st[o + 5] = mat; st[o + 6] = tag; st[o + 7] = dom;
      d = BIG; continue;
    } else {
      di = d; cr = r; cg = g; cb = b; ca = a; cm = mat; ct = tag; cd = dom; has = true;
      const o = 8 * --sp; d = st[o]; r = st[o + 1]; g = st[o + 2]; b = st[o + 3]; a = st[o + 4]; mat = st[o + 5]; tag = st[o + 6]; dom = st[o + 7];
      const f = C.disp[i]; if (f !== null && di < BIG * 0.5) di = f(x, y, z, di);
      if (iop[i] !== OP_UNION && !nodes[i].hasColor) has = false;
    }
    const k = ik[i], kc = ikc[i];
    let hc = 0;
    switch (iop[i]) {
      case OP_UNION: {
        hc = kc > 0 ? clamp(0.5 + 0.5 * (d - di) / kc, 0, 1) : (di < d ? 1 : 0);
        if (d >= BIG * 0.5) hc = 1;
        if (k > 0) { const h = k - Math.abs(d - di); d = (d < di ? d : di) - (h > 0 ? h * h * 0.25 / k : 0); } else if (di < d) d = di;
        break;
      }
      case OP_SUB: {
        const nd = -di;
        hc = kc > 0 ? clamp(0.5 + 0.5 * (nd - d) / kc, 0, 1) : (nd > d ? 1 : 0);
        if (k > 0) { const h = k - Math.abs(d - nd); d = (d > nd ? d : nd) + (h > 0 ? h * h * 0.25 / k : 0); } else if (nd > d) d = nd;
        break;
      }
      case OP_INTER: {
        hc = kc > 0 ? clamp(0.5 + 0.5 * (di - d) / kc, 0, 1) : (di > d ? 1 : 0);
        if (k > 0) { const h = k - Math.abs(d - di); d = (d > di ? d : di) + (h > 0 ? h * h * 0.25 / k : 0); } else if (di > d) d = di;
        break;
      }
      case OP_PAINT:
        hc = kc > 0 ? clamp(0.5 - 0.5 * di / kc, 0, 1) : (di < 0 ? 1 : 0);
        break;
    }
    if (has && hc > 0) {
      r += (cr - r) * hc; g += (cg - g) * hc; b += (cb - b) * hc; a += (ca - a) * hc; tag += (ct - tag) * hc;
      if (hc >= 0.5) { mat = cm; dom = cd; }
    }
  }
  out[0] = d; out[1] = r; out[2] = g; out[3] = b; out[4] = a; out[5] = mat; out[6] = tag; out[7] = dom;
  return out;
}

// Abstand Box <-> Box (Box als [minx,miny,minz,maxx,maxy,maxz])
function boxDist(B, o, x0, y0, z0, x1, y1, z1) {
  const dx = Math.max(0, B[o] - x1, x0 - B[o + 3]);
  const dy = Math.max(0, B[o + 1] - y1, y0 - B[o + 4]);
  const dz = Math.max(0, B[o + 2] - z1, z0 - B[o + 5]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Kandidatenliste für eine Box filtern. Gibt Anzahl zurück. Gruppen, die außerhalb liegen, werden samt Kindern
 * übersprungen; leere union/subtract-Gruppen entfernt.
 */
function filterList(C, src, n, x0, y0, z0, x1, y1, z1, pad, out, mode) {
  const itype = C.itype, iop = C.iop, ik = C.ik, ipad = C.ipad, always = C.always, ibox = C.ibox, match = C.match;
  let w = 0;
  for (let li = 0; li < n; li++) {
    const i = src[li];
    const it = itype[i];
    if (it === I_END) {
      // leere Gruppe entfernen (nicht bei intersect: leere Schnittmenge = leer)
      if (w > 0 && out[w - 1] === match[i] && iop[i] !== OP_INTER) { w--; continue; }
      out[w++] = i; continue;
    }
    if (it === I_PRIM) {
      if (mode === 0 && iop[i] === OP_WEIGHT) continue;
      if (mode === 2 && !C.nodes[i].skinIdx) continue;
    }
    if (always[i] || (mode === 2 && it === I_BEGIN) || boxDist(ibox, 6 * i, x0, y0, z0, x1, y1, z1) < ik[i] + ipad[i] + pad) { out[w++] = i; continue; }
    if (it === I_BEGIN) { const e = match[i]; while (li < n && src[li] !== e) li++; }
  }
  return w;
}

// ============================================================================ Raycast / Hilfen

/**
 * Sphere-Tracing gegen den Sculpt. Gibt { t, pos, normal } oder null zurück. Nützlich um Augen, Nase,
 * Schnurrhaare etc. exakt auf der Oberfläche zu platzieren.
 */
export function raycast(sculpt, origin, dir, maxDist = 2, eps = 1e-4) {
  const C = sculpt.compile();
  const l = Math.hypot(dir[0], dir[1], dir[2]); const dx = dir[0] / l, dy = dir[1] / l, dz = dir[2] / l;
  let t = 0;
  for (let it = 0; it < 512 && t < maxDist; it++) {
    const x = origin[0] + dx * t, y = origin[1] + dy * t, z = origin[2] + dz * t;
    const d = evalDist(C, C.rootList, C.rootList.length, x, y, z);
    if (Math.abs(d) < eps) {
      const pos = [x, y, z];
      return { t, pos, normal: gradientAt(C, C.rootList, C.rootList.length, x, y, z, 1e-4, [0, 0, 0]) };
    }
    t += Math.max(Math.abs(d) * 0.8, eps * 0.5);
  }
  return null;
}

function gradientAt(C, list, n, x, y, z, e, out) {
  const gx = evalDist(C, list, n, x + e, y, z) - evalDist(C, list, n, x - e, y, z);
  const gy = evalDist(C, list, n, x, y + e, z) - evalDist(C, list, n, x, y - e, z);
  const gz = evalDist(C, list, n, x, y, z + e) - evalDist(C, list, n, x, y, z - e);
  const l = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
  out[0] = gx / l; out[1] = gy / l; out[2] = gz / l; return out;
}

// ============================================================================ Polygonisierung

/**
 * Sculpt -> Mesh (Surface Nets, schmalbandig/sparse ausgewertet).
 * @param {Sculpt} sculpt
 * @param {object} [o]
 *   cell        Zellgröße (m), Standard 0.008
 *   bounds      [[minx,miny,minz],[maxx,maxy,maxz]] (Standard: automatisch aus den Primitiven)
 *   skeleton    SkeletonDef (defineSkeleton) oder { names, parents } – nötig für joints/weights
 *   skin        true (Standard, wenn skeleton gegeben): joints/weights erzeugen
 *   weightSmooth  Glättungsiterationen der Gewichte über Mesh-Nachbarn (Standard 2)
 *   allowSiblings Gewichtsmischung auch zwischen Geschwisterknochen (Standard false)
 *   project     Newton-Projektionen der Vertices auf die Fläche (Standard 2)
 *   relax       Tangentiale Glättungsiterationen für gleichmäßigere Dreiecke (Standard 1)
 *   ao          true (Standard): AO-Bake in data[1]; aoDist (0.09 m), aoSamples (5), aoDirs (1 | 5, Standard 5),
 *               aoStrength (1.0)
 *   data2       'curvature' (Standard; mittlere Krümmung/100 in 1/m, geklemmt [-1,1]) | 'thickness'
 *               (lokale Dicke / thicknessRange (0.1 m), [0,1]) | 'none'
 *   paint       (p, n, info) => ({ color?, mat?, tag? } | void)  info = { color, mat, tag, ao, curvature, node }
 *   colors      true (Standard) – Vertexfarben (linear RGBA)
 */
export function polygonize(sculpt, o = {}) {
  const t0 = now();
  const C = sculpt.compile();
  const h = o.cell || 0.008;
  const projectIters = o.project !== undefined ? o.project : 2;
  const relaxIters = o.relax !== undefined ? o.relax : 1;
  const doAO = o.ao !== false;
  const aoDist = o.aoDist || 0.09, aoSamples = o.aoSamples || 5, aoDirs = o.aoDirs || 5, aoStrength = o.aoStrength !== undefined ? o.aoStrength : 1;
  const data2 = o.data2 || 'curvature';
  const skel = o.skeleton || null;
  const doSkin = !!skel && o.skin !== false;

  // Skin-Bindungen auflösen
  let boneNames = null, boneParents = null;
  if (doSkin) {
    boneNames = skel.names; boneParents = skel.parents;
    const idx = Object.create(null); boneNames.forEach((n, i) => (idx[n] = i));
    for (let i = 0; i < C.n; i++) {
      const nd = C.nodes[i]; nd.skinIdx = null;
      if (C.itype[i] !== I_PRIM || !nd.skin || nd.bone == null) continue;
      const list = [];
      if (typeof nd.bone === 'string') list.push([nd.bone, 1]); else for (const k in nd.bone) list.push([k, nd.bone[k]]);
      nd.skinIdx = list.map(([name, w]) => {
        const bi = idx[name]; if (bi === undefined) throw new Error(`polygonize: unbekannter Knochen "${name}"`);
        return [bi, w];
      });
      const mx = Math.max(...nd.skinIdx.map((e) => e[1])) || 1;
      nd.skinIdx.forEach((e) => (e[1] /= mx));
    }
  } else for (let i = 0; i < C.n; i++) C.nodes[i].skinIdx = null;

  // Gitter
  let bmin, bmax;
  if (o.bounds) { bmin = o.bounds[0]; bmax = o.bounds[1]; }
  else { bmin = [C.bounds[0], C.bounds[1], C.bounds[2]]; bmax = [C.bounds[3], C.bounds[4], C.bounds[5]]; }
  const ox = bmin[0] - 2 * h, oy = bmin[1] - 2 * h, oz = bmin[2] - 2 * h;
  const nx = Math.ceil((bmax[0] - bmin[0]) / h) + 5, ny = Math.ceil((bmax[1] - bmin[1]) / h) + 5, nz = Math.ceil((bmax[2] - bmin[2]) / h) + 5;
  if (nx * ny * nz > 40e6) throw new Error(`polygonize: Gitter zu groß (${nx}x${ny}x${nz}), Zelle vergrößern`);
  const vals = new Float32Array(nx * ny * nz).fill(NaN);
  const sxy = nx * ny;

  // --- Phase 1: hierarchische Schmalband-Auswertung
  const LEAF = 4, TOP = 32;
  const lists = []; for (let dpt = 0; dpt < 8; dpt++) lists.push(new Int32Array(C.n));
  let leafPool = new Int32Array(1 << 16), leafPoolLen = 0;
  const leaves = []; // [x0, y0, z0, listOff, listLen]
  let evals = 0;
  const SQ3 = Math.sqrt(3);
  const visit = (x0, y0, z0, s, src, srcN, depth) => {
    const x1 = Math.min(x0 + s, nx - 1), y1 = Math.min(y0 + s, ny - 1), z1 = Math.min(z0 + s, nz - 1);
    if (x1 <= x0 || y1 <= y0 || z1 <= z0) return;
    const wx0 = ox + x0 * h, wy0 = oy + y0 * h, wz0 = oz + z0 * h, wx1 = ox + x1 * h, wy1 = oy + y1 * h, wz1 = oz + z1 * h;
    const out = lists[depth];
    const cnt = filterList(C, src, srcN, wx0, wy0, wz0, wx1, wy1, wz1, 2 * h, out, 0);
    if (cnt === 0) return;
    const cx = (wx0 + wx1) * 0.5, cy = (wy0 + wy1) * 0.5, cz = (wz0 + wz1) * 0.5;
    const half = 0.5 * Math.sqrt((wx1 - wx0) ** 2 + (wy1 - wy0) ** 2 + (wz1 - wz0) ** 2);
    const d = evalDist(C, out, cnt, cx, cy, cz); evals++;
    if (Math.abs(d) > half * 1.15 + 2 * h) return;
    if (s <= LEAF) {
      if (leafPoolLen + cnt > leafPool.length) { const np = new Int32Array(leafPool.length * 2); np.set(leafPool); leafPool = np; }
      leafPool.set(out.subarray(0, cnt), leafPoolLen);
      leaves.push(x0, y0, z0, leafPoolLen, cnt); leafPoolLen += cnt;
      for (let k = z0; k <= z1; k++) for (let j = y0; j <= y1; j++) {
        let idx = x0 + j * nx + k * sxy;
        for (let i = x0; i <= x1; i++, idx++) {
          if (vals[idx] === vals[idx]) continue; // bereits berechnet (NaN != NaN)
          vals[idx] = evalDist(C, out, cnt, ox + i * h, oy + j * h, oz + k * h); evals++;
        }
      }
      return;
    }
    const hs = s >> 1;
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++)
      visit(x0 + dx * hs, y0 + dy * hs, z0 + dz * hs, hs, out, cnt, depth + 1);
  };
  for (let z = 0; z < nz - 1; z += TOP) for (let y = 0; y < ny - 1; y += TOP) for (let x = 0; x < nx - 1; x += TOP)
    visit(x, y, z, TOP, C.rootList, C.rootList.length, 0);
  const t1 = now();

  // --- Phase 2: Surface Nets – Vertices
  const ncx = nx - 1, ncy = ny - 1;
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  let cap = 1 << 15;
  let pos = new Float64Array(cap * 3), vLeaf = new Int32Array(cap), vCell = new Int32Array(cap * 3);
  let nv = 0;
  const cv = new Float64Array(8);
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const CO = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const nLeaves = leaves.length / 5;
  for (let L = 0; L < nLeaves; L++) {
    const x0 = leaves[5 * L], y0 = leaves[5 * L + 1], z0 = leaves[5 * L + 2];
    const x1 = Math.min(x0 + LEAF, nx - 1), y1 = Math.min(y0 + LEAF, ny - 1), z1 = Math.min(z0 + LEAF, nz - 1);
    for (let k = z0; k < z1; k++) for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) {
      const base = i + j * nx + k * sxy;
      let mask = 0, bad = false;
      for (let c = 0; c < 8; c++) {
        const v = vals[base + CO[c][0] + CO[c][1] * nx + CO[c][2] * sxy];
        if (v !== v) { bad = true; break; }
        cv[c] = v; if (v < 0) mask |= 1 << c;
      }
      if (bad || mask === 0 || mask === 255) continue;
      let sx = 0, sy = 0, sz = 0, cnt = 0;
      for (let e = 0; e < 12; e++) {
        const a = EDGES[e][0], b = EDGES[e][1];
        const va = cv[a], vb = cv[b];
        if ((va < 0) === (vb < 0)) continue;
        const t = va / (va - vb);
        sx += CO[a][0] + (CO[b][0] - CO[a][0]) * t; sy += CO[a][1] + (CO[b][1] - CO[a][1]) * t; sz += CO[a][2] + (CO[b][2] - CO[a][2]) * t;
        cnt++;
      }
      if (nv >= cap) {
        cap *= 2;
        const p2 = new Float64Array(cap * 3); p2.set(pos); pos = p2;
        const l2 = new Int32Array(cap); l2.set(vLeaf); vLeaf = l2;
        const c2 = new Int32Array(cap * 3); c2.set(vCell); vCell = c2;
      }
      pos[3 * nv] = ox + (i + sx / cnt) * h; pos[3 * nv + 1] = oy + (j + sy / cnt) * h; pos[3 * nv + 2] = oz + (k + sz / cnt) * h;
      vLeaf[nv] = L; vCell[3 * nv] = i; vCell[3 * nv + 1] = j; vCell[3 * nv + 2] = k;
      cellVert[i + j * ncx + k * ncx * ncy] = nv;
      nv++;
    }
  }

  // --- Phase 3: Quads -> Dreiecke (CCW von außen)
  let idxCap = nv * 6 + 64, tris = new Uint32Array(idxCap), nt = 0, holes = 0;
  const cvAt = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= ncx || j >= ncy || k >= nz - 1 ? -1 : cellVert[i + j * ncx + k * ncx * ncy]);
  const quad = (a, b, c, d) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) { holes++; return; }
    if (nt + 6 > idxCap) { idxCap *= 2; const t2 = new Uint32Array(idxCap); t2.set(tris); tris = t2; }
    // kürzere Diagonale wählen
    const d02 = dist2(pos, a, c), d13 = dist2(pos, b, d);
    if (d02 <= d13) { tris[nt++] = a; tris[nt++] = b; tris[nt++] = c; tris[nt++] = a; tris[nt++] = c; tris[nt++] = d; }
    else { tris[nt++] = a; tris[nt++] = b; tris[nt++] = d; tris[nt++] = b; tris[nt++] = c; tris[nt++] = d; }
  };
  for (let v = 0; v < nv; v++) {
    const i = vCell[3 * v], j = vCell[3 * v + 1], k = vCell[3 * v + 2];
    const v0 = vals[i + j * nx + k * sxy];
    const in0 = v0 < 0;
    // Kante entlang +X
    if (j > 0 && k > 0) {
      const v1 = vals[i + 1 + j * nx + k * sxy];
      if (in0 !== (v1 < 0)) {
        const a = cvAt(i, j - 1, k - 1), b = cvAt(i, j, k - 1), c = cvAt(i, j, k), d = cvAt(i, j - 1, k);
        if (in0) quad(a, b, c, d); else quad(d, c, b, a);
      }
    }
    // Kante entlang +Y  (Ebene z,x)
    if (i > 0 && k > 0) {
      const v1 = vals[i + (j + 1) * nx + k * sxy];
      if (in0 !== (v1 < 0)) {
        const a = cvAt(i - 1, j, k - 1), b = cvAt(i - 1, j, k), c = cvAt(i, j, k), d = cvAt(i, j, k - 1);
        if (in0) quad(a, b, c, d); else quad(d, c, b, a);
      }
    }
    // Kante entlang +Z  (Ebene x,y)
    if (i > 0 && j > 0) {
      const v1 = vals[i + j * nx + (k + 1) * sxy];
      if (in0 !== (v1 < 0)) {
        const a = cvAt(i - 1, j - 1, k), b = cvAt(i, j - 1, k), c = cvAt(i, j, k), d = cvAt(i - 1, j, k);
        if (in0) quad(a, b, c, d); else quad(d, c, b, a);
      }
    }
  }
  const t2 = now();

  // Leaf-Kandidatenlisten für erweiterte Radien (AO, Gewichte) – lazy je Leaf
  const wLists = new Array(nLeaves);
  const tmpList = new Int32Array(C.n);
  const listFor = (store, L, pad, mode) => {
    let l = store[L];
    if (l) return l;
    const x0 = leaves[5 * L], y0 = leaves[5 * L + 1], z0 = leaves[5 * L + 2];
    const src = mode === 2 ? C.allList : C.rootList;
    const cnt = filterList(C, src, src.length, ox + x0 * h, oy + y0 * h, oz + z0 * h, ox + (x0 + LEAF) * h, oy + (y0 + LEAF) * h, oz + (z0 + LEAF) * h, pad, tmpList, mode);
    l = store[L] = tmpList.slice(0, cnt);
    return l;
  };
  const leafList = (L) => leafPool.subarray(leaves[5 * L + 3], leaves[5 * L + 3] + leaves[5 * L + 4]);

  // --- Phase 4: Projektion auf die Fläche (Newton), Relaxation
  const g = new Float64Array(3);
  const project = (v, iters) => {
    const ll = leafList(vLeaf[v]); const cnt = ll.length;
    let x = pos[3 * v], y = pos[3 * v + 1], z = pos[3 * v + 2];
    const cx = ox + (vCell[3 * v] + 0.5) * h, cy = oy + (vCell[3 * v + 1] + 0.5) * h, cz = oz + (vCell[3 * v + 2] + 0.5) * h;
    const e = h * 0.3;
    for (let it = 0; it < iters; it++) {
      // Tetraeder-Gradient + Mittelwert als d
      const a = evalDist(C, ll, cnt, x + e, y - e, z - e), b = evalDist(C, ll, cnt, x - e, y - e, z + e);
      const c = evalDist(C, ll, cnt, x - e, y + e, z - e), dd = evalDist(C, ll, cnt, x + e, y + e, z + e);
      evals += 4;
      const gx = a - b - c + dd, gy = -a - b + c + dd, gz = -a + b - c + dd;
      const d = (a + b + c + dd) * 0.25;
      const gl2 = gx * gx + gy * gy + gz * gz;
      if (gl2 < 1e-20) break;
      // Newton: p -= d * grad / |grad|^2 , grad = G / (4e); Schritt auf h begrenzt
      let s = d * 4 * e / gl2;
      const step = Math.abs(s) * Math.sqrt(gl2);
      if (step > h) s *= h / step;
      x -= gx * s; y -= gy * s; z -= gz * s;
      // nicht zu weit von der Zelle entfernen (dünne Strukturen)
      const lim = h * 0.9;
      x = clamp(x, cx - lim, cx + lim); y = clamp(y, cy - lim, cy + lim); z = clamp(z, cz - lim, cz + lim);
      if (Math.abs(d) < h * 1e-3) break;
    }
    pos[3 * v] = x; pos[3 * v + 1] = y; pos[3 * v + 2] = z;
  };
  if (projectIters > 0) for (let v = 0; v < nv; v++) project(v, projectIters);

  // Adjazenz (CSR) – für Relaxation und Gewichtsglättung
  const adj = buildAdjacency(nv, tris, nt);
  if (relaxIters > 0) {
    const tmp = new Float64Array(nv * 3);
    for (let it = 0; it < relaxIters; it++) {
      for (let v = 0; v < nv; v++) {
        const s0 = adj.off[v], s1 = adj.off[v + 1];
        if (s1 === s0) { tmp[3 * v] = pos[3 * v]; tmp[3 * v + 1] = pos[3 * v + 1]; tmp[3 * v + 2] = pos[3 * v + 2]; continue; }
        let ax = 0, ay = 0, az = 0;
        for (let s = s0; s < s1; s++) { const u = adj.nb[s]; ax += pos[3 * u]; ay += pos[3 * u + 1]; az += pos[3 * u + 2]; }
        const inv = 1 / (s1 - s0);
        tmp[3 * v] = pos[3 * v] * 0.5 + ax * inv * 0.5; tmp[3 * v + 1] = pos[3 * v + 1] * 0.5 + ay * inv * 0.5; tmp[3 * v + 2] = pos[3 * v + 2] * 0.5 + az * inv * 0.5;
      }
      pos.set(tmp.subarray(0, nv * 3));
      for (let v = 0; v < nv; v++) project(v, 2);
    }
  }
  const t3 = now();

  // --- Phase 5: Normalen, Krümmung, AO, Attribute
  const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3);
  const colors = o.colors === false ? null : new Float32Array(nv * 4);
  const data = new Float32Array(nv * 4);
  const full = new Float64Array(8);
  const aoDirVec = new Float64Array(15);
  const nodeIdxOfVert = new Int32Array(nv);
  const thicknessRange = o.thicknessRange || 0.1, curvScale = o.curvatureScale || 0.01;
  const info = { color: [0, 0, 0, 1], mat: 0, tag: 0, ao: 1, curvature: 0, node: null, index: 0 };
  const pArr = [0, 0, 0], nArr = [0, 0, 0];
  const needField = doAO || data2 === 'thickness';
  const fieldBand = Math.max(doAO ? aoDist : 0, data2 === 'thickness' ? thicknessRange * 0.5 : 0) + 2 * h;
  const field = needField ? buildCoarseField(C, bmin, bmax, o.fieldCell || Math.max(1.5 * h, 0.012), fieldBand) : null;
  for (let v = 0; v < nv; v++) {
    const ll = leafList(vLeaf[v]); const cnt = ll.length;
    const x = pos[3 * v], y = pos[3 * v + 1], z = pos[3 * v + 2];
    const e = h * 0.5;
    const dxp = evalDist(C, ll, cnt, x + e, y, z), dxm = evalDist(C, ll, cnt, x - e, y, z);
    const dyp = evalDist(C, ll, cnt, x, y + e, z), dym = evalDist(C, ll, cnt, x, y - e, z);
    const dzp = evalDist(C, ll, cnt, x, y, z + e), dzm = evalDist(C, ll, cnt, x, y, z - e);
    evalFull(C, ll, cnt, x, y, z, full);
    evals += 7;
    let gx = dxp - dxm, gy = dyp - dym, gz = dzp - dzm;
    let gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (gl < 1e-12) { gx = 0; gy = 1; gz = 0; gl = 1; }
    gx /= gl; gy /= gl; gz /= gl;
    positions[3 * v] = x; positions[3 * v + 1] = y; positions[3 * v + 2] = z;
    normals[3 * v] = gx; normals[3 * v + 1] = gy; normals[3 * v + 2] = gz;
    const lap = (dxp + dxm + dyp + dym + dzp + dzm - 6 * full[0]) / (e * e);
    // AO: nächster Sample exakt (Leaf-Liste gilt bis 2h Abstand), weitere über das grobe Distanzfeld
    let ao = 1;
    if (doAO) {
      let ndirs = 1;
      aoDirVec[0] = gx; aoDirVec[1] = gy; aoDirVec[2] = gz;
      if (aoDirs > 1) {
        let tx, ty, tz;
        if (Math.abs(gy) < 0.9) { tx = gz; ty = 0; tz = -gx; } else { tx = 0; ty = -gz; tz = gy; }
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz); tx /= tl; ty /= tl; tz /= tl;
        const bx = gy * tz - gz * ty, by = gz * tx - gx * tz, bz = gx * ty - gy * tx;
        const sp = 0.8;
        for (let q = 0; q < 4; q++) {
          const sa = q === 0 ? 1 : q === 1 ? -1 : 0, sb = q === 2 ? 1 : q === 3 ? -1 : 0;
          let ux = gx + (tx * sa + bx * sb) * sp, uy = gy + (ty * sa + by * sb) * sp, uz = gz + (tz * sa + bz * sb) * sp;
          const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
          aoDirVec[3 * (q + 1)] = ux / ul; aoDirVec[3 * (q + 1) + 1] = uy / ul; aoDirVec[3 * (q + 1) + 2] = uz / ul;
        }
        ndirs = 5;
      }
      let occ = 0, wsum = 0;
      for (let q = 0; q < ndirs; q++) {
        const ux = aoDirVec[3 * q], uy = aoDirVec[3 * q + 1], uz = aoDirVec[3 * q + 2];
        const wq = q === 0 ? 1.5 : 1;
        const ns = q === 0 ? aoSamples : Math.max(2, aoSamples - 2);
        for (let s = 1; s <= ns; s++) {
          const f = s / ns, dist = aoDist * f * f + h * 0.6;
          const sx = x + ux * dist, sy = y + uy * dist, sz = z + uz * dist;
          const dd = dist < 1.5 * h ? evalDist(C, ll, cnt, sx, sy, sz) : field(sx, sy, sz);
          const w = wq * (1 - 0.5 * f);
          occ += w * clamp((dist - dd) / dist, 0, 1); wsum += w;
        }
      }
      ao = clamp(1 - aoStrength * occ / wsum * 1.6, 0, 1);
    }
    let d2 = 0;
    if (data2 === 'curvature') d2 = clamp(lap * curvScale, -1, 1);
    else if (data2 === 'thickness') {
      let mx = 0;
      for (let s = 1; s <= 6; s++) {
        const dist = thicknessRange * 0.5 * (s / 6);
        const sx = x - gx * dist, sy = y - gy * dist, sz = z - gz * dist;
        const dd = -(dist < 1.5 * h ? evalDist(C, ll, cnt, sx, sy, sz) : field(sx, sy, sz));
        if (dd > mx) mx = dd;
        if (dd < mx * 0.5) break;
      }
      d2 = clamp((2 * mx) / thicknessRange, 0, 1);
    }
    let cr = full[1], cg = full[2], cb = full[3], ca = full[4], mat = full[5], tag = full[6];
    nodeIdxOfVert[v] = full[7];
    if (o.paint) {
      pArr[0] = x; pArr[1] = y; pArr[2] = z; nArr[0] = gx; nArr[1] = gy; nArr[2] = gz;
      info.color[0] = cr; info.color[1] = cg; info.color[2] = cb; info.color[3] = ca;
      info.mat = mat; info.tag = tag; info.ao = ao; info.curvature = lap; info.node = full[7] >= 0 ? C.nodes[full[7]] : null; info.index = v;
      const r = o.paint(pArr, nArr, info);
      if (r) {
        if (r.color) { const c = parseColor(r.color); cr = c[0]; cg = c[1]; cb = c[2]; ca = c[3]; }
        if (r.mat !== undefined) mat = r.mat;
        if (r.tag !== undefined) tag = r.tag;
        if (r.ao !== undefined) ao = r.ao;
      }
    }
    if (colors) { colors[4 * v] = cr; colors[4 * v + 1] = cg; colors[4 * v + 2] = cb; colors[4 * v + 3] = ca; }
    data[4 * v] = mat; data[4 * v + 1] = ao; data[4 * v + 2] = d2; data[4 * v + 3] = tag;
  }
  const t4 = now();

  // --- Phase 6: Skin-Gewichte
  let joints = null, weights = null;
  if (doSkin) {
    const sk = computeSkinWeights(C, positions, nv, adj, {
      nb: boneNames.length, parents: boneParents, leafOf: vLeaf, listFor: (L) => listFor(wLists, L, C.maxSkin + C.maxK + 2 * h, 2),
      smooth: o.weightSmooth !== undefined ? o.weightSmooth : 2, allowSiblings: !!o.allowSiblings,
    });
    joints = sk.joints; weights = sk.weights;
  }
  const t5 = now();

  const indices = tris.slice(0, nt);
  const mesh = {
    positions, normals, data, indices, vertexCount: nv, triangleCount: nt / 3,
    stats: {
      ms: t5 - t0, evalMs: t1 - t0, netsMs: t2 - t1, projectMs: t3 - t2, attrMs: t4 - t3, skinMs: t5 - t4,
      leaves: nLeaves, evals, grid: [nx, ny, nz], holes, cell: h,
    },
  };
  if (colors) mesh.colors = colors;
  if (joints) { mesh.joints = joints; mesh.weights = weights; mesh.boneNames = boneNames.slice(); }
  return mesh;
}

/**
 * Grobes Distanzfeld (Schmalband um die Oberfläche, Breite `band`) mit trilinearer Abfrage – für AO-/Dicken-Samples
 * in einigen Zentimetern Abstand, wo die exakte Auswertung teuer wäre (viele Kandidaten-Primitive).
 */
function buildCoarseField(C, bmin, bmax, hc, band) {
  const ox = bmin[0] - band - hc, oy = bmin[1] - band - hc, oz = bmin[2] - band - hc;
  const nx = Math.ceil((bmax[0] - bmin[0] + 2 * band) / hc) + 3, ny = Math.ceil((bmax[1] - bmin[1] + 2 * band) / hc) + 3, nz = Math.ceil((bmax[2] - bmin[2] + 2 * band) / hc) + 3;
  const vals = new Float32Array(nx * ny * nz).fill(NaN);
  const sxy = nx * ny, B = 8;
  const lists = []; for (let dpt = 0; dpt < 4; dpt++) lists.push(new Int32Array(C.n));
  const visit = (x0, y0, z0, s, src, srcN, depth) => {
    const x1 = Math.min(x0 + s, nx - 1), y1 = Math.min(y0 + s, ny - 1), z1 = Math.min(z0 + s, nz - 1);
    if (x1 <= x0 || y1 <= y0 || z1 <= z0) return;
    const wx0 = ox + x0 * hc, wy0 = oy + y0 * hc, wz0 = oz + z0 * hc, wx1 = ox + x1 * hc, wy1 = oy + y1 * hc, wz1 = oz + z1 * hc;
    const out = lists[depth];
    const cnt = filterList(C, src, srcN, wx0, wy0, wz0, wx1, wy1, wz1, band + 2 * hc, out, 0);
    if (cnt === 0) return;
    const half = 0.5 * Math.sqrt((wx1 - wx0) ** 2 + (wy1 - wy0) ** 2 + (wz1 - wz0) ** 2);
    const d = evalDist(C, out, cnt, (wx0 + wx1) * 0.5, (wy0 + wy1) * 0.5, (wz0 + wz1) * 0.5);
    if (Math.abs(d) > half * 1.15 + band + 2 * hc) return;
    if (s <= B) {
      for (let k = z0; k <= z1; k++) for (let j = y0; j <= y1; j++) {
        let idx = x0 + j * nx + k * sxy;
        for (let i = x0; i <= x1; i++, idx++) if (vals[idx] !== vals[idx]) vals[idx] = evalDist(C, out, cnt, ox + i * hc, oy + j * hc, oz + k * hc);
      }
      return;
    }
    const hs = s >> 1;
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) visit(x0 + dx * hs, y0 + dy * hs, z0 + dz * hs, hs, out, cnt, depth + 1);
  };
  for (let z = 0; z < nz - 1; z += 32) for (let y = 0; y < ny - 1; y += 32) for (let x = 0; x < nx - 1; x += 32) visit(x, y, z, 32, C.rootList, C.rootList.length, 0);
  const inv = 1 / hc;
  return (x, y, z) => {
    const fx = (x - ox) * inv, fy = (y - oy) * inv, fz = (z - oz) * inv;
    let i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    if (i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) return band;
    const u = fx - i, v = fy - j, w = fz - k, b = i + j * nx + k * sxy;
    const c000 = vals[b], c100 = vals[b + 1], c010 = vals[b + nx], c110 = vals[b + nx + 1];
    const c001 = vals[b + sxy], c101 = vals[b + sxy + 1], c011 = vals[b + sxy + nx], c111 = vals[b + sxy + nx + 1];
    const r = (c000 * (1 - u) + c100 * u) * (1 - v) * (1 - w) + (c010 * (1 - u) + c110 * u) * v * (1 - w)
      + (c001 * (1 - u) + c101 * u) * (1 - v) * w + (c011 * (1 - u) + c111 * u) * v * w;
    return r === r ? r : band; // NaN (außerhalb des Bandes) -> frei
  };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function dist2(p, a, b) { const x = p[3 * a] - p[3 * b], y = p[3 * a + 1] - p[3 * b + 1], z = p[3 * a + 2] - p[3 * b + 2]; return x * x + y * y + z * z; }

function buildAdjacency(nv, tris, nt) {
  // Kantenliste (beide Richtungen), dann CSR mit Duplikat-Entfernung
  const deg = new Int32Array(nv + 1);
  for (let t = 0; t < nt; t += 3) for (let e = 0; e < 3; e++) { deg[tris[t + e]]++; deg[tris[t + (e + 1) % 3]]++; }
  const off = new Int32Array(nv + 1);
  for (let v = 0; v < nv; v++) off[v + 1] = off[v] + deg[v];
  const fill = off.slice(0, nv), nbAll = new Int32Array(off[nv]);
  for (let t = 0; t < nt; t += 3) for (let e = 0; e < 3; e++) {
    const a = tris[t + e], b = tris[t + (e + 1) % 3];
    nbAll[fill[a]++] = b; nbAll[fill[b]++] = a;
  }
  // deduplizieren
  const off2 = new Int32Array(nv + 1), nb = new Int32Array(off[nv]);
  let w = 0;
  for (let v = 0; v < nv; v++) {
    off2[v] = w;
    const s0 = off[v], s1 = off[v + 1];
    for (let s = s0; s < s1; s++) {
      const u = nbAll[s]; let dup = false;
      for (let q = off2[v]; q < w; q++) if (nb[q] === u) { dup = true; break; }
      if (!dup) nb[w++] = u;
    }
  }
  off2[nv] = w;
  return { off: off2, nb: nb.subarray(0, w) };
}

// ---------------------------------------------------------------------------- Skin-Gewichte

function computeSkinWeights(C, positions, nv, adj, o) {
  const nb = o.nb, parents = o.parents;
  // erlaubte Paare (Hierarchie-Abstand <= 2, ohne Geschwister)
  const allowed = new Uint8Array(nb * nb);
  const par = (b) => (b >= 0 ? parents[b] : -1);
  for (let c = 0; c < nb; c++) for (let b = 0; b < nb; b++) {
    let ok = b === c || par(b) === c || par(c) === b || (par(b) >= 0 && par(par(b)) === c) || (par(c) >= 0 && par(par(c)) === b);
    if (!ok && o.allowSiblings && par(b) === par(c)) ok = true;
    allowed[c * nb + b] = ok ? 1 : 0;
  }
  const W = new Float32Array(nv * nb);
  const dists = new Float64Array(C.n);
  for (let v = 0; v < nv; v++) {
    const ll = o.listFor(o.leafOf[v]);
    const x = positions[3 * v], y = positions[3 * v + 1], z = positions[3 * v + 2];
    let dmin = BIG, imin = -1;
    for (let li = 0; li < ll.length; li++) {
      const i = ll[li];
      if (C.itype[i] !== I_PRIM || !C.nodes[i].skinIdx) continue;
      const d = primDist(C.ptype[i], C.P, C.poff[i], x, y, z, C.fns[i]);
      dists[i] = d;
      if (d < dmin) { dmin = d; imin = i; }
    }
    if (imin < 0) { W[v * nb] = 1; continue; } // kein Knochen in Reichweite -> root
    // dominanter Knochen
    const si = C.nodes[imin].skinIdx; let cb = si[0][0], cw = si[0][1];
    for (const [b, w] of si) if (w > cw) { cb = b; cw = w; }
    const sigC = C.nodes[imin].skinBlend;
    const row = v * nb;
    for (let li = 0; li < ll.length; li++) {
      const i = ll[li];
      const nd = C.nodes[i];
      if (C.itype[i] !== I_PRIM || !nd.skinIdx) continue;
      const sig = Math.min(nd.skinBlend, sigC);
      let k;
      const dd = dists[i] - dmin;
      if (i === imin || dd <= 0) k = 1;
      else if (sig <= 1e-6) k = 0;
      else { const xx = dd / sig; k = xx >= 1 ? 0 : (1 - xx * xx) * (1 - xx * xx) * (1 - xx * xx); }
      if (k <= 0) continue;
      for (const [b, w] of nd.skinIdx) {
        if (!allowed[cb * nb + b]) continue;
        const val = k * w;
        if (val > W[row + b]) W[row + b] = val;
      }
    }
  }
  // Zeilen normieren, dann über Mesh-Nachbarn glätten (konvexe Kombination -> bleibt normiert)
  for (let v = 0; v < nv; v++) {
    const row = v * nb; const s = rowSum(W, row, nb);
    if (s > 0) for (let b = 0; b < nb; b++) W[row + b] /= s;
  }
  if (o.smooth > 0) {
    const T = new Float32Array(nv * nb);
    for (let it = 0; it < o.smooth; it++) {
      for (let v = 0; v < nv; v++) {
        const s0 = adj.off[v], s1 = adj.off[v + 1], row = v * nb;
        if (s1 === s0) { for (let b = 0; b < nb; b++) T[row + b] = W[row + b]; continue; }
        const inv = 0.5 / (s1 - s0);
        for (let b = 0; b < nb; b++) T[row + b] = 0.5 * W[row + b];
        for (let s = s0; s < s1; s++) {
          const r2 = adj.nb[s] * nb;
          for (let b = 0; b < nb; b++) { const w = W[r2 + b]; if (w !== 0) T[row + b] += w * inv; }
        }
      }
      W.set(T);
    }
  }
  // Top-4, normiert
  const joints = new Uint8Array(nv * 4), weights = new Float32Array(nv * 4);
  const bi = [0, 0, 0, 0], bw = [0, 0, 0, 0];
  for (let v = 0; v < nv; v++) {
    const row = v * nb;
    bw[0] = bw[1] = bw[2] = bw[3] = -1; bi[0] = bi[1] = bi[2] = bi[3] = 0;
    for (let b = 0; b < nb; b++) {
      const w = W[row + b];
      if (w <= bw[3]) continue;
      let p = 3;
      while (p > 0 && w > bw[p - 1]) { bw[p] = bw[p - 1]; bi[p] = bi[p - 1]; p--; }
      bw[p] = w; bi[p] = b;
    }
    let s = 0;
    for (let q = 0; q < 4; q++) { if (bw[q] < 0.01) bw[q] = 0; s += bw[q]; }
    if (s <= 0) { bw[0] = 1; s = 1; }
    for (let q = 0; q < 4; q++) { joints[4 * v + q] = bi[q]; weights[4 * v + q] = bw[q] / s; }
  }
  return { joints, weights };
}
function rowSum(W, row, nb) { let s = 0; for (let b = 0; b < nb; b++) s += W[row + b]; return s; }

// ============================================================================ Mesh-Hilfen

/**
 * Teilmesh extrahieren: keep(vertexIndex) -> bool, oder Array/Set von Material-IDs (data[0]).
 * Dreiecke bleiben, wenn alle drei Vertices behalten werden. Gibt neue Mesh-Daten zurück (offene Ränder möglich).
 */
export function extractSubmesh(mesh, keep) {
  const n = mesh.positions.length / 3;
  let pred = keep;
  if (Array.isArray(keep) || keep instanceof Set) {
    const set = new Set(keep); pred = (v) => set.has(Math.round(mesh.data[4 * v]));
  }
  const map = new Int32Array(n).fill(-1);
  const idx = mesh.indices, outIdx = [];
  let cnt = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (!pred(a) || !pred(b) || !pred(c)) continue;
    for (const v of [a, b, c]) { if (map[v] < 0) map[v] = cnt++; outIdx.push(map[v]); }
  }
  const out = { indices: Uint32Array.from(outIdx), vertexCount: cnt, triangleCount: outIdx.length / 3 };
  for (const key of ['positions', 'normals', 'colors', 'data', 'uvs', 'joints', 'weights']) {
    const src = mesh[key]; if (!src) continue;
    const stride = src.length / n;
    const dst = new src.constructor(cnt * stride);
    for (let v = 0; v < n; v++) if (map[v] >= 0) for (let k = 0; k < stride; k++) dst[map[v] * stride + k] = src[v * stride + k];
    out[key] = dst;
  }
  if (mesh.boneNames) out.boneNames = mesh.boneNames;
  return out;
}

/** AABB eines Meshes. */
export function meshBounds(mesh) {
  const p = mesh.positions; const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { if (p[i + k] < mn[k]) mn[k] = p[i + k]; if (p[i + k] > mx[k]) mx[k] = p[i + k]; }
  return { min: mn, max: mx, center: mn.map((v, k) => (v + mx[k]) / 2), radius: Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2 };
}

/**
 * Qualitätsprüfung: { vertices, triangles, boundaryEdges, nonManifoldEdges, nan, badNormals, weightErr,
 *   flipped (Dreiecksnormale gegen Vertexnormalen), degenerate }.
 */
export function checkMesh(mesh) {
  const p = mesh.positions, n = mesh.normals, idx = mesh.indices;
  const nv = p.length / 3, nt = idx.length / 3;
  let nan = 0, badNormals = 0, weightErr = 0, flipped = 0, degenerate = 0;
  for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i]) || !Number.isFinite(n[i])) nan++;
  for (let v = 0; v < nv; v++) { const l = Math.hypot(n[3 * v], n[3 * v + 1], n[3 * v + 2]); if (Math.abs(l - 1) > 1e-3) badNormals++; }
  if (mesh.weights) for (let v = 0; v < nv; v++) {
    const w = mesh.weights; const s = w[4 * v] + w[4 * v + 1] + w[4 * v + 2] + w[4 * v + 3];
    if (Math.abs(s - 1) > 1e-4 || !Number.isFinite(s)) weightErr++;
  }
  const edges = new Map();
  for (let t = 0; t < nt; t++) {
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    const ux = p[3 * b] - p[3 * a], uy = p[3 * b + 1] - p[3 * a + 1], uz = p[3 * b + 2] - p[3 * a + 2];
    const vx = p[3 * c] - p[3 * a], vy = p[3 * c + 1] - p[3 * a + 1], vz = p[3 * c + 2] - p[3 * a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const fl = Math.hypot(fx, fy, fz);
    if (fl < 1e-14) degenerate++;
    else {
      const sx = n[3 * a] + n[3 * b] + n[3 * c], sy = n[3 * a + 1] + n[3 * b + 1] + n[3 * c + 1], sz = n[3 * a + 2] + n[3 * b + 2] + n[3 * c + 2];
      if (fx * sx + fy * sy + fz * sz < 0) flipped++;
    }
    for (const [x, y] of [[a, b], [b, c], [c, a]]) {
      const key = x < y ? x * nv + y : y * nv + x;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  let boundaryEdges = 0, nonManifoldEdges = 0;
  for (const c of edges.values()) { if (c === 1) boundaryEdges++; else if (c > 2) nonManifoldEdges++; }
  return { vertices: nv, triangles: nt, edges: edges.size, boundaryEdges, nonManifoldEdges, nan, badNormals, weightErr, flipped, degenerate };
}

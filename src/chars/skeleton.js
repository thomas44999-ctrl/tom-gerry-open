// Skelett: Knochenliste, Ruhepose, Vorwärtskinematik (FK) und Skin-Matrizen.
//
// Konventionen (siehe ARCHITECTURE §5.1):
//   * Modellraum der Figur: Y oben, Blick nach +Z, linke Körperseite = +X (Knochen *_l liegen bei +X).
//   * Alle Ruhe-Orientierungen sind Identität. Eine Skelett-Definition besteht nur aus Gelenkpositionen
//     im Modellraum. Lokale Rotationen (Quaternionen) drehen um das Gelenk im Raum des Elternknochens.
//   * Pose = lokale Rotationen (rot, 4 Floats/Knochen) + lokale Zusatz-Translationen (t, 3 Floats/Knochen).
//     pose.root   = t[0..2]  -> Verschiebung der Wurzel im Modellraum
//     pose.pelvis = t[3..5]  -> Beckenversatz (z.B. Hocke: pelvis[1] = -0.2) im Wurzelraum
//   * skel.update() berechnet skel.world[i] (Modellraum-Matrix je Knochen) und skel.skin
//     (Float32Array 16*n, boneModel * inverseBind) für den Renderer.
//   * Jeder Knochen hat zusätzlich einen anatomischen "Gelenkrahmen" (def.frames), den pose.js für
//     Euler-Winkel nutzt: Y' = Knochenrichtung (zum Kind), Z' = vorne (bzw. oben bei Fuß/Zeh),
//     X' = Y' x Z' (Beuge-/Scharnierachse). Details und Spickzettel: pose.js.

import { vec3, quat } from '../core/math.js';

/** Feste humanoide Knochen (Index = Position in dieser Liste). */
export const HUMANOID_BONES = [
  'root', 'pelvis', 'spine', 'chest', 'neck', 'head',
  'shoulder_l', 'arm_l', 'forearm_l', 'hand_l',
  'shoulder_r', 'arm_r', 'forearm_r', 'hand_r',
  'thigh_l', 'shin_l', 'foot_l', 'toe_l',
  'thigh_r', 'shin_r', 'foot_r', 'toe_r',
];
export const HUMANOID_PARENTS = [-1, 0, 1, 2, 3, 4, 3, 6, 7, 8, 3, 10, 11, 12, 1, 14, 15, 16, 1, 18, 19, 20];
export const BONE = Object.freeze(Object.fromEntries(HUMANOID_BONES.map((n, i) => [n, i])));
export const MAX_BONES = 64;

/**
 * Referenz-Gelenke für einen durchschnittlichen Erwachsenen (1.80 m) in A-Pose
 * (Arme ~45° unter der Horizontalen, leicht nach vorn, Ellbogen minimal gebeugt).
 * Positionen im Modellraum (Meter). `tips` = Endpunkte der Blattknochen (Kopf-Oberseite, Fingerspitzen-Mitte
 * der Hand, Zehenspitze) – werden für Knochenlängen, Gelenkrahmen und Feder-Ketten genutzt.
 */
export const HUMANOID_DEFAULT_JOINTS = Object.freeze({
  root: [0, 0, 0],
  pelvis: [0, 0.985, -0.005],
  spine: [0, 1.105, -0.025],
  chest: [0, 1.275, -0.03],
  neck: [0, 1.495, -0.035],
  head: [0, 1.605, -0.015],
  shoulder_l: [0.03, 1.455, 0.0],
  arm_l: [0.185, 1.43, -0.025],
  forearm_l: [0.392, 1.215, 0.0],
  hand_l: [0.565, 1.025, 0.06],
  shoulder_r: [-0.03, 1.455, 0.0],
  arm_r: [-0.185, 1.43, -0.025],
  forearm_r: [-0.392, 1.215, 0.0],
  hand_r: [-0.565, 1.025, 0.06],
  thigh_l: [0.095, 0.935, 0.0],
  shin_l: [0.1, 0.505, 0.015],
  foot_l: [0.1, 0.085, -0.025],
  toe_l: [0.11, 0.022, 0.125],
  thigh_r: [-0.095, 0.935, 0.0],
  shin_r: [-0.1, 0.505, 0.015],
  foot_r: [-0.1, 0.085, -0.025],
  toe_r: [-0.11, 0.022, 0.125],
});
export const HUMANOID_DEFAULT_TIPS = Object.freeze({
  head: [0, 1.80, 0.0],
  hand_l: [0.625, 0.955, 0.085],
  hand_r: [-0.625, 0.955, 0.085],
  toe_l: [0.115, 0.02, 0.19],
  toe_r: [-0.115, 0.02, 0.19],
});

const _sideOf = (name) => (/(_l$|_l_)/.test(name) ? 1 : /(_r$|_r_)/.test(name) ? -1 : 0);
const _mirrorName = (name) => name.replace(/_l$/, '_\u0001').replace(/_r$/, '_l').replace(/_\u0001$/, '_r')
  .replace(/_l_/g, '_\u0002_').replace(/_r_/g, '_l_').replace(/_\u0002_/g, '_r_');

/**
 * Skelett-Definition aus Gelenkpositionen.
 * @param {{ joints: Object<string, number[]>, extras?: {name:string, parent:string, pos:number[], tip?:number[]}[],
 *           tips?: Object<string, number[]> }} spec
 *   joints: alle 22 humanoiden Gelenke (root darf fehlen -> [0,0,0]). extras: Zusatzknochen in Eltern-vor-Kind-Reihenfolge.
 *   tips: optionale Endpunkte für Blattknochen (sonst: Elternrichtung * halbe Elternlänge bzw. 0.1 m nach oben).
 * @returns SkeletonDef { names, parents, count, rest, offset, tip, length, frames, side, mirror, children,
 *                        inverseBind, index, boneIndex(name), joints, extras }
 */
export function defineSkeleton({ joints, extras = [], tips = {} }) {
  const names = HUMANOID_BONES.slice();
  const parents = HUMANOID_PARENTS.slice();
  const pos = [];
  for (const n of HUMANOID_BONES) {
    const p = joints[n] || (n === 'root' ? [0, 0, 0] : null);
    if (!p) throw new Error(`defineSkeleton: Gelenk "${n}" fehlt`);
    pos.push([p[0], p[1], p[2]]);
  }
  const tipMap = { ...defaultTipsFor(joints), ...tips };
  for (const e of extras) {
    const pi = names.indexOf(e.parent);
    if (pi < 0) throw new Error(`defineSkeleton: Eltern-Knochen "${e.parent}" von "${e.name}" unbekannt (Reihenfolge?)`);
    if (names.includes(e.name)) throw new Error(`defineSkeleton: Knochen "${e.name}" doppelt`);
    names.push(e.name); parents.push(pi); pos.push([e.pos[0], e.pos[1], e.pos[2]]);
    if (e.tip) tipMap[e.name] = e.tip;
  }
  const n = names.length;
  if (n > MAX_BONES) throw new Error(`defineSkeleton: maximal ${MAX_BONES} Knochen`);
  const index = Object.create(null);
  names.forEach((nm, i) => (index[nm] = i));
  const children = names.map(() => []);
  for (let i = 1; i < n; i++) children[parents[i]].push(i);

  const rest = new Float32Array(3 * n), offset = new Float32Array(3 * n), tip = new Float32Array(3 * n);
  const length = new Float32Array(n), frames = new Float32Array(4 * n), inverseBind = new Float32Array(16 * n);
  const side = new Int8Array(n), mirror = new Int16Array(n), bendSign = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    rest.set(pos[i], 3 * i);
    const p = parents[i];
    for (let k = 0; k < 3; k++) offset[3 * i + k] = pos[i][k] - (p >= 0 ? pos[p][k] : 0);
  }
  // Spitzen: primäres Kind (erstes Kind in Index-Reihenfolge) oder explizit
  for (let i = 0; i < n; i++) {
    let t;
    if (tipMap[names[i]]) t = tipMap[names[i]];
    else if (children[i].length) t = pos[children[i][0]];
    else {
      const p = parents[i];
      const d = p >= 0 ? vec3.sub([0, 0, 0], pos[i], pos[p]) : [0, 0.1, 0];
      const l = Math.hypot(d[0], d[1], d[2]) || 1;
      const len = p >= 0 ? Math.max(0.03, l * 0.5) : 0.1;
      t = [pos[i][0] + d[0] / l * len, pos[i][1] + d[1] / l * len, pos[i][2] + d[2] / l * len];
    }
    tip.set(t, 3 * i);
    length[i] = Math.hypot(t[0] - pos[i][0], t[1] - pos[i][1], t[2] - pos[i][2]);
  }
  // Gelenkrahmen: Y' = Knochenrichtung, Z' = Vorwärts (oder Oben, falls Knochen ~nach vorn zeigt), X' = Y' x Z'
  const y = [0, 0, 0], z = [0, 0, 0], x = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    y[0] = tip[3 * i] - pos[i][0]; y[1] = tip[3 * i + 1] - pos[i][1]; y[2] = tip[3 * i + 2] - pos[i][2];
    if (length[i] < 1e-5) vec3.set(y, 0, 1, 0);
    vec3.normalize(y, y);
    const ref = Math.abs(y[2]) > 0.8 ? [0, 1, 0] : [0, 0, 1];
    const dp = vec3.dot(ref, y);
    vec3.scaleAndAdd(z, ref, y, -dp); vec3.normalize(z, z);
    vec3.cross(x, y, z); vec3.normalize(x, x);
    // Quaternion aus Basis (Spalten x, y, z)
    const m = [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]];
    const q = quat.fromMat3(quat.create(), m); quat.normalize(q, q);
    frames.set(q, 4 * i);
    // inverse Bindmatrix = Translation(-rest)
    const o = 16 * i;
    inverseBind[o] = inverseBind[o + 5] = inverseBind[o + 10] = inverseBind[o + 15] = 1;
    inverseBind[o + 12] = -pos[i][0]; inverseBind[o + 13] = -pos[i][1]; inverseBind[o + 14] = -pos[i][2];
  }
  // Spiegelpartner + Seite
  for (let i = 0; i < n; i++) {
    side[i] = _sideOf(names[i]);
    const mi = index[_mirrorName(names[i])];
    mirror[i] = mi === undefined ? i : mi;
  }
  // natürliche Beugerichtung des Scharniers (für IK): Vorzeichen von (dirParent x dirSelf) · X'
  for (let i = 0; i < n; i++) {
    const p = parents[i];
    let s = /shin|knee|calf/.test(names[i]) ? -1 : 1;
    if (p >= 0) {
      const dp = [tip[3 * p] - pos[p][0], tip[3 * p + 1] - pos[p][1], tip[3 * p + 2] - pos[p][2]];
      const ds = [tip[3 * i] - pos[i][0], tip[3 * i + 1] - pos[i][1], tip[3 * i + 2] - pos[i][2]];
      vec3.normalize(dp, dp); vec3.normalize(ds, ds);
      const c = vec3.cross([0, 0, 0], dp, ds);
      const xa = vec3.transformQuat([0, 0, 0], [1, 0, 0], frames.subarray(4 * i, 4 * i + 4));
      const d = vec3.dot(c, xa);
      if (Math.abs(d) > 0.03) s = d > 0 ? 1 : -1;
    }
    bendSign[i] = s;
  }
  const def = {
    names, parents: Int16Array.from(parents), count: n, rest, offset, tip, length, frames, side, mirror, bendSign,
    children, inverseBind, index,
    joints: Object.fromEntries(names.map((nm, i) => [nm, pos[i]])),
    extras: extras.map((e) => ({ ...e })),
    boneIndex(name) { const i = index[name]; return i === undefined ? -1 : i; },
  };
  return def;
}

// Standard-Spitzen relativ zu den gegebenen Gelenken (falls der Aufrufer keine angibt).
function defaultTipsFor(j) {
  const head = j.head, neck = j.neck;
  const headLen = neck && head ? Math.max(0.12, (head[1] - neck[1]) * 1.75) : 0.19;
  const ext = (a, b, s) => [b[0] + (b[0] - a[0]) * s, b[1] + (b[1] - a[1]) * s, b[2] + (b[2] - a[2]) * s];
  const out = {};
  if (head) out.head = [head[0], head[1] + headLen, head[2] + 0.015];
  if (j.forearm_l && j.hand_l) out.hand_l = ext(j.forearm_l, j.hand_l, 0.36);
  if (j.forearm_r && j.hand_r) out.hand_r = ext(j.forearm_r, j.hand_r, 0.36);
  if (j.foot_l && j.toe_l) out.toe_l = [j.toe_l[0] + 0.005, j.toe_l[1] - 0.002, j.toe_l[2] + 0.065];
  if (j.foot_r && j.toe_r) out.toe_r = [j.toe_r[0] - 0.005, j.toe_r[1] - 0.002, j.toe_r[2] + 0.065];
  return out;
}

/** Leere Pose (Identität) für n Knochen. pose.root / pose.pelvis sind Sichten auf pose.t. */
export function makePose(n) {
  const rot = new Float32Array(4 * n);
  for (let i = 0; i < n; i++) rot[4 * i + 3] = 1;
  const t = new Float32Array(3 * n);
  return { n, rot, t, root: t.subarray(0, 3), pelvis: t.subarray(3, 6) };
}

/** Laufzeit-Skelett. */
export class Skeleton {
  constructor(def) {
    this.def = def;
    this.count = def.count;
    this.names = def.names;
    this.parents = def.parents;
    this.bones = def.names.map((name, i) => ({
      name, index: i, parent: def.parents[i], rest: def.rest.subarray(3 * i, 3 * i + 3),
      length: def.length[i], children: def.children[i],
    }));
    this.pose = makePose(this.count);
    this.worldBuf = new Float32Array(16 * this.count);
    this.world = [];
    for (let i = 0; i < this.count; i++) this.world.push(this.worldBuf.subarray(16 * i, 16 * i + 16));
    this.skin = new Float32Array(16 * this.count);
    this.update();
  }
  boneIndex(name) { if (typeof name === 'number') return name; const i = this.def.index[name]; return i === undefined ? -1 : i; }
  resetPose() {
    const r = this.pose.rot; r.fill(0); for (let i = 0; i < this.count; i++) r[4 * i + 3] = 1;
    this.pose.t.fill(0); return this;
  }
  /** FK für `pose` (Standard: this.pose): füllt this.world (Modellraum) und this.skin. Allokationsfrei. */
  update(pose = this.pose) {
    computeModelMatrices(this.def, pose, this.worldBuf);
    const W = this.worldBuf, S = this.skin, rest = this.def.rest;
    for (let i = 0, n = this.count; i < n; i++) {
      const o = 16 * i, rx = rest[3 * i], ry = rest[3 * i + 1], rz = rest[3 * i + 2];
      for (let k = 0; k < 12; k++) S[o + k] = W[o + k];
      S[o + 12] = W[o + 12] - (W[o] * rx + W[o + 4] * ry + W[o + 8] * rz);
      S[o + 13] = W[o + 13] - (W[o + 1] * rx + W[o + 5] * ry + W[o + 9] * rz);
      S[o + 14] = W[o + 14] - (W[o + 2] * rx + W[o + 6] * ry + W[o + 10] * rz);
      S[o + 15] = 1;
    }
    return this;
  }
  /** Gelenkposition im Modellraum (nach update()). Mit `model` (mat4) in Weltkoordinaten. */
  getWorldPos(name, out = vec3.create(), model = null) {
    const o = 16 * this.boneIndex(name), W = this.worldBuf;
    const x = W[o + 12], y = W[o + 13], z = W[o + 14];
    if (!model) { out[0] = x; out[1] = y; out[2] = z; return out; }
    out[0] = model[0] * x + model[4] * y + model[8] * z + model[12];
    out[1] = model[1] * x + model[5] * y + model[9] * z + model[13];
    out[2] = model[2] * x + model[6] * y + model[10] * z + model[14];
    return out;
  }
  /** Knochenmatrix im Modellraum (bzw. Welt, wenn `model` gegeben). */
  getWorldMatrix(name, out = new Float32Array(16), model = null) {
    const o = 16 * this.boneIndex(name);
    if (!model) { for (let k = 0; k < 16; k++) out[k] = this.worldBuf[o + k]; return out; }
    return mul4(out, model, 0, this.worldBuf, o);
  }
  /** Modellraum-Rotation eines Knochens als Quaternion (nach update()). */
  getWorldRot(name, out = quat.create()) {
    const o = 16 * this.boneIndex(name), W = this.worldBuf;
    _m3[0] = W[o]; _m3[1] = W[o + 1]; _m3[2] = W[o + 2]; _m3[3] = W[o + 4]; _m3[4] = W[o + 5]; _m3[5] = W[o + 6];
    _m3[6] = W[o + 8]; _m3[7] = W[o + 9]; _m3[8] = W[o + 10];
    return quat.normalize(out, quat.fromMat3(out, _m3));
  }
  /** Ruheposition (Modellraum). */
  restPos(name, out = vec3.create()) { const i = this.boneIndex(name); out[0] = this.def.rest[3 * i]; out[1] = this.def.rest[3 * i + 1]; out[2] = this.def.rest[3 * i + 2]; return out; }
  /** Lokale Ruhe-Richtung (Einheitsvektor Gelenk -> Spitze) eines Knochens. */
  restDir(name, out = vec3.create()) { const i = this.boneIndex(name); const d = this.def; out[0] = d.tip[3 * i] - d.rest[3 * i]; out[1] = d.tip[3 * i + 1] - d.rest[3 * i + 1]; out[2] = d.tip[3 * i + 2] - d.rest[3 * i + 2]; return vec3.normalize(out, out); }
}
const _m3 = new Float32Array(9);

export function createSkeleton(def) { return new Skeleton(def); }

/** Inverse Bindmatrizen (Translation -rest je Knochen), Float32Array(16n). */
export function computeInverseBind(def) { return new Float32Array(def.inverseBind); }

/**
 * FK in einen beliebigen Puffer (Float32Array 16n), ohne Allokation. Knochen müssen nach Eltern sortiert sein.
 */
export function computeModelMatrices(def, pose, out) {
  const rot = pose.rot, t = pose.t, off = def.offset, par = def.parents, rest = def.rest;
  for (let i = 0, n = def.count; i < n; i++) {
    const qx = rot[4 * i], qy = rot[4 * i + 1], qz = rot[4 * i + 2], qw = rot[4 * i + 3];
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2, wx = qw * x2, wy = qw * y2, wz = qw * z2;
    // lokale Rotationsmatrix (Spalten)
    const l0 = 1 - (yy + zz), l1 = xy + wz, l2 = xz - wy;
    const l4 = xy - wz, l5 = 1 - (xx + zz), l6 = yz + wx;
    const l8 = xz + wy, l9 = yz - wx, l10 = 1 - (xx + yy);
    const p = par[i], o = 16 * i;
    if (p < 0) {
      out[o] = l0; out[o + 1] = l1; out[o + 2] = l2; out[o + 3] = 0;
      out[o + 4] = l4; out[o + 5] = l5; out[o + 6] = l6; out[o + 7] = 0;
      out[o + 8] = l8; out[o + 9] = l9; out[o + 10] = l10; out[o + 11] = 0;
      out[o + 12] = rest[3 * i] + t[3 * i]; out[o + 13] = rest[3 * i + 1] + t[3 * i + 1]; out[o + 14] = rest[3 * i + 2] + t[3 * i + 2]; out[o + 15] = 1;
      continue;
    }
    const po = 16 * p;
    const a0 = out[po], a1 = out[po + 1], a2 = out[po + 2], a4 = out[po + 4], a5 = out[po + 5], a6 = out[po + 6];
    const a8 = out[po + 8], a9 = out[po + 9], a10 = out[po + 10];
    const tx = off[3 * i] + t[3 * i], ty = off[3 * i + 1] + t[3 * i + 1], tz = off[3 * i + 2] + t[3 * i + 2];
    out[o] = a0 * l0 + a4 * l1 + a8 * l2; out[o + 1] = a1 * l0 + a5 * l1 + a9 * l2; out[o + 2] = a2 * l0 + a6 * l1 + a10 * l2; out[o + 3] = 0;
    out[o + 4] = a0 * l4 + a4 * l5 + a8 * l6; out[o + 5] = a1 * l4 + a5 * l5 + a9 * l6; out[o + 6] = a2 * l4 + a6 * l5 + a10 * l6; out[o + 7] = 0;
    out[o + 8] = a0 * l8 + a4 * l9 + a8 * l10; out[o + 9] = a1 * l8 + a5 * l9 + a9 * l10; out[o + 10] = a2 * l8 + a6 * l9 + a10 * l10; out[o + 11] = 0;
    out[o + 12] = out[po + 12] + a0 * tx + a4 * ty + a8 * tz;
    out[o + 13] = out[po + 13] + a1 * tx + a5 * ty + a9 * tz;
    out[o + 14] = out[po + 14] + a2 * tx + a6 * ty + a10 * tz;
    out[o + 15] = 1;
  }
  return out;
}

/**
 * Modellraum-Transformation EINES Knochens für eine beliebige Pose (läuft die Elternkette ab, allokationsfrei).
 * outRot: quat, outPos: vec3. Gibt outRot zurück.
 */
export function boneModelTransform(def, pose, index, outRot, outPos) {
  // Kette sammeln (max. Tiefe 64)
  let depth = 0;
  for (let i = index; i >= 0; i = def.parents[i]) _chain[depth++] = i;
  outRot[0] = 0; outRot[1] = 0; outRot[2] = 0; outRot[3] = 1;
  outPos[0] = 0; outPos[1] = 0; outPos[2] = 0;
  const rot = pose.rot, t = pose.t, off = def.offset, rest = def.rest;
  for (let k = depth - 1; k >= 0; k--) {
    const i = _chain[k];
    if (k === depth - 1) {
      outPos[0] = rest[3 * i] + t[3 * i]; outPos[1] = rest[3 * i + 1] + t[3 * i + 1]; outPos[2] = rest[3 * i + 2] + t[3 * i + 2];
    } else {
      _v[0] = off[3 * i] + t[3 * i]; _v[1] = off[3 * i + 1] + t[3 * i + 1]; _v[2] = off[3 * i + 2] + t[3 * i + 2];
      vec3.transformQuat(_v, _v, outRot);
      outPos[0] += _v[0]; outPos[1] += _v[1]; outPos[2] += _v[2];
    }
    _q[0] = rot[4 * i]; _q[1] = rot[4 * i + 1]; _q[2] = rot[4 * i + 2]; _q[3] = rot[4 * i + 3];
    quat.multiply(outRot, outRot, _q);
  }
  return outRot;
}
const _chain = new Int32Array(MAX_BONES + 1), _v = new Float32Array(3), _q = new Float32Array(4);

function mul4(o, a, ao, b, bo) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[bo + 4 * c], b1 = b[bo + 4 * c + 1], b2 = b[bo + 4 * c + 2], b3 = b[bo + 4 * c + 3];
    for (let r = 0; r < 4; r++) o[4 * c + r] = a[ao + r] * b0 + a[ao + 4 + r] * b1 + a[ao + 8 + r] * b2 + a[ao + 12 + r] * b3;
  }
  return o;
}

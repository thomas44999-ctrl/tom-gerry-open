// Posen, Euler-Konvention, Clips (Keyframes), Überblendung, Masken, IK, Blickausrichtung, Sekundärbewegung.
//
// ============================================================================ KONVENTIONEN
//
// Pose = { n, rot: Float32Array(4n) lokale Quaternionen [x,y,z,w], t: Float32Array(3n) lokale Zusatz-Translation,
//          root: Sicht auf t[0..2] (Wurzelverschiebung), pelvis: Sicht auf t[3..5] (Beckenversatz) }.
// Lokale Rotationen wirken um das Gelenk im Raum des Elternknochens. Da alle Ruhe-Orientierungen Identität sind,
// ist dieser Raum in Ruhe der Modellraum der Figur (X = links der Figur, Y = oben, Z = vorn/Blickrichtung).
//
// EULER-WINKEL (poseFromEuler, Clip-Keys) sind GRAD im anatomischen Gelenkrahmen jedes Knochens (skeleton.js):
//   Y' = Knochenrichtung in Ruhe (Gelenk -> Spitze/Kind), Z' = vorn (bei Fuß/Zeh, die nach vorn zeigen: oben),
//   X' = Y' x Z' (Scharnierachse).
// Reihenfolge: R = Rz(z) * Rx(x) * Ry(y)  -> auf den Knochen wirkt zuerst die Verdrehung y (um die eigene Achse),
//   dann die Beugung x (Spitze schwenkt nach vorn), zuletzt die Seitwärtsbewegung z (um die Vorwärtsachse Z').
// Rechte Knochen (*_r): y und z werden intern negiert. Dadurch bedeuten GLEICHE Zahlen links und rechts die
// GESPIEGELTE (anatomisch gleiche) Bewegung: arm_l [0,0,45] und arm_r [0,0,45] heben beide Arme seitlich.
//
//   Achse  Grundregel (alle Knochen)                     Bedeutung je Körperteil (positive Werte)
//   x      Spitze des Knochens schwenkt nach VORN        spine/chest: Vorbeugen · neck/head: Nicken (Kinn runter)
//          (Fuß/Zeh: nach OBEN)                          arm: Anteversion (Arm nach vorn heben) · forearm: Ellbogen
//                                                        beugen · hand: Hand Richtung Daumen kippen (radial)
//                                                        thigh: Hüftbeugung (Bein nach vorn) · shin: NEGATIV =
//                                                        Kniebeugung! · foot: Fußspitze hoch · toe: Zehen hoch
//                                                        shoulder (Schlüsselbein): Schulter nach vorn ziehen
//   y      Verdrehung um die Knochenachse                spine/chest/neck/head/pelvis/root: Drehung nach LINKS
//          (links: Vorderseite dreht nach innen-unten)   (Blick/Brust dreht zur +X-Seite; rechts herum = negativ)
//                                                        arm/thigh: Innenrotation · forearm: Pronation
//                                                        (Handrücken nach vorn) · hand: Innenrotation
//   z      seitlich um die Vorwärtsachse                 spine/chest/neck/head/pelvis: Neigung nach RECHTS (-X)
//                                                        arm: Abduktion (Arm seitlich hoch; 45 = waagrecht,
//                                                        135 = senkrecht nach oben) · thigh: Abspreizen
//                                                        hand: Handgelenk-Streckung (Handrücken-Richtung)
//                                                        shoulder: Schulter hochziehen
//   pelvisOffset [x,y,z] m  Beckenverschiebung im Wurzelraum (Hocke: y negativ) · rootOffset [x,y,z] m
//
// ============================================================================ SPICKZETTEL (in test/rig.test.mjs per FK geprüft)
//   (Werte für HUMANOID_DEFAULT_JOINTS; A-Pose: Oberarm ~46° unter der Waagrechten, Ellbogen kaum gebeugt)
//   Arme waagrecht nach vorn:      arm_l [90, 0, 0], arm_r [90, 0, 0]       (Oberarm zeigt +Z, ±3°)
//   Arme seitlich waagrecht (T):   arm_l [0, 0, 45], arm_r [0, 0, 45]       (Oberarm zeigt ±X, ±3°)
//   Arm senkrecht nach oben:       arm_r [0, 0, 135]                        (Oberarm zeigt +Y, ±3°)
//   Arm hängt am Körper:           arm_r [0, 0, -40]                        (Oberarm fast senkrecht nach unten)
//   Ellbogen 90° gebeugt:          forearm_r [90, 0, 0]                     (Winkel Ober-/Unterarm ändert sich um 90°)
//   Unterarm-Pronation 90°:        forearm_r [0, 90, 0]                     (Hand dreht um die Unterarmachse)
//   Knie 60° gebeugt:              shin_l [-60, 0, 0]                       (Unterschenkel schwenkt nach hinten)
//   Hüfte 90° gebeugt (Sitzen):    thigh_l [90, 0, 0]                       (Oberschenkel zeigt +Z)
//   Tiefe Hocke:                   thigh [100,0,8], shin [-120,0,0], foot [20,0,0], pelvisOffset [0,-0.43,-0.12],
//                                  spine [25,0,0]                           (Füße bleiben am Boden)
//   Rumpf 30° nach rechts drehen:  spine [0,-12,0], chest [0,-18,0]         (Brust-Vorwärts dreht sich zu -X)
//   Kopf nach links schauen:       neck [0, 20, 0], head [0, 30, 0]
//   Vorhand-Treffpunkt (Rechtsh.): root [0,-25,0], spine [8,-10,0], chest [0,-15,0], arm_r [55,-20,40],
//                                  forearm_r [25,-40,0], hand_r [0,0,25], thigh_r [25,0,5], shin_r [-35,0,0],
//                                  thigh_l [-10,0,8], shin_l [-20,0,0], pelvisOffset [0,-0.08,0]
//
// ============================================================================ API (Kurzüberblick)
//   createPose(skel) · copyPose(out, src) · resetPose(out) · blendPose(out, a, b, t, mask?) · addPose(out, base, add, w, mask?)
//   makeAdditive(out, pose, ref) · mirrorPose(skel, out, src) · mirrorEulerSpec(spec) · mirrorClip(clip)
//   eulerToQuat(skel, bone, x, y, z, out) · quatToEuler(skel, bone, q, out) · poseFromEuler(skel, spec, out?)
//   applyEuler(skel, pose, spec, weight?) · poseToEuler(skel, pose, eps?)
//   boneMask(skel, spec, weight?) -> Float32Array(n)   ('upper'|'lower'|'arm_r'|'leg_l'|'head'|'chest*'|[...]|{bone:w})
//   EASE · compileClip(skel, clip) · sampleClip(skel, clip, time, out) · clipEvents(clip, t0, t1, out, loop?)
//   class AnimLayer (Crossfade-Abspieler) · twoBoneIK(...) · limbIK(...) · aimBone(...) · lookAt(...)
//   class SpringChain / springChain(skel, pose, boneNames, dt, params) · getBoneModel(skel, pose, bone, outRot, outPos)

import { quat, clamp, DEG, easeInOutCubic, easeOutCubic, easeInCubic, easeInOutQuad, easeOutBack, smoothstep, smootherstep } from '../core/math.js';
import { makePose, boneModelTransform } from './skeleton.js';

const defOf = (skel) => (skel && skel.def ? skel.def : skel);
function boneIdx(def, b) {
  if (typeof b === 'number') return b;
  const i = def.index[b];
  if (i === undefined) throw new Error(`pose: unbekannter Knochen "${b}"`);
  return i;
}

// ---------------------------------------------------------------------------- Grundoperationen

/** Neue Pose (Identität) für ein Skelett (Skeleton oder SkeletonDef). */
export function createPose(skel) { return makePose(defOf(skel).count); }

export function copyPose(out, src) { out.rot.set(src.rot); out.t.set(src.t); return out; }

export function resetPose(out) {
  const r = out.rot; r.fill(0);
  for (let i = 3; i < r.length; i += 4) r[i] = 1;
  out.t.fill(0); return out;
}

/** Inline-Slerp für Quaternion-Arrays mit Offset (allokationsfrei, kürzester Weg). */
function slerpInto(o, oo, a, ao, b, bo, t) {
  const ax = a[ao], ay = a[ao + 1], az = a[ao + 2], aw = a[ao + 3];
  let bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
  let c = ax * bx + ay * by + az * bz + aw * bw;
  if (c < 0) { c = -c; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let s0, s1;
  if (c < 0.9995) {
    const om = Math.acos(c), so = 1 / Math.sin(om);
    s0 = Math.sin((1 - t) * om) * so; s1 = Math.sin(t * om) * so;
  } else { s0 = 1 - t; s1 = t; }
  let x = s0 * ax + s1 * bx, y = s0 * ay + s1 * by, z = s0 * az + s1 * bz, w = s0 * aw + s1 * bw;
  const l = 1 / (Math.sqrt(x * x + y * y + z * z + w * w) || 1);
  o[oo] = x * l; o[oo + 1] = y * l; o[oo + 2] = z * l; o[oo + 3] = w * l;
}

/**
 * out = a + (b - a) * t je Knochen (Rotation: slerp, Translation: lerp). mask (Float32Array n, 0..1) skaliert t
 * pro Knochen. out darf a oder b sein.
 */
export function blendPose(out, a, b, t, mask = null) {
  const n = out.n, ar = a.rot, br = b.rot, or = out.rot, at = a.t, bt = b.t, ot = out.t;
  for (let i = 0; i < n; i++) {
    const w = mask ? t * mask[i] : t;
    const o4 = 4 * i, o3 = 3 * i;
    if (w <= 0) {
      if (out !== a) { or[o4] = ar[o4]; or[o4 + 1] = ar[o4 + 1]; or[o4 + 2] = ar[o4 + 2]; or[o4 + 3] = ar[o4 + 3]; ot[o3] = at[o3]; ot[o3 + 1] = at[o3 + 1]; ot[o3 + 2] = at[o3 + 2]; }
      continue;
    }
    if (w >= 1) {
      if (out !== b) { or[o4] = br[o4]; or[o4 + 1] = br[o4 + 1]; or[o4 + 2] = br[o4 + 2]; or[o4 + 3] = br[o4 + 3]; ot[o3] = bt[o3]; ot[o3 + 1] = bt[o3 + 1]; ot[o3 + 2] = bt[o3 + 2]; }
      continue;
    }
    slerpInto(or, o4, ar, o4, br, o4, w);
    ot[o3] = at[o3] + (bt[o3] - at[o3]) * w; ot[o3 + 1] = at[o3 + 1] + (bt[o3 + 1] - at[o3 + 1]) * w; ot[o3 + 2] = at[o3 + 2] + (bt[o3 + 2] - at[o3 + 2]) * w;
  }
  return out;
}

const _ID = new Float32Array([0, 0, 0, 1]);
const _qa = new Float32Array(4), _qb = new Float32Array(4), _qc = new Float32Array(4);

/**
 * Additive Ebene: out.rot[i] = base.rot[i] * slerp(I, add.rot[i], w*mask[i])  (Rotation im bereits gedrehten
 * Knochenrahmen, d.h. Euler-Additive wirken "lokal" – eine Verdrehung bleibt eine Verdrehung um die aktuelle
 * Knochenachse); out.t = base.t + add.t * w. Die additive Pose ist relativ zur Ruhepose (Identität) zu verstehen,
 * z.B. poseFromEuler(skel, { chest: [3, 0, 0] }) als Atem-Ebene. out darf base sein.
 */
export function addPose(out, base, additive, w = 1, mask = null) {
  const n = out.n, br = base.rot, ar = additive.rot, or = out.rot;
  for (let i = 0; i < n; i++) {
    const wi = mask ? w * mask[i] : w;
    const o4 = 4 * i, o3 = 3 * i;
    if (wi <= 0) {
      if (out !== base) { or[o4] = br[o4]; or[o4 + 1] = br[o4 + 1]; or[o4 + 2] = br[o4 + 2]; or[o4 + 3] = br[o4 + 3]; out.t[o3] = base.t[o3]; out.t[o3 + 1] = base.t[o3 + 1]; out.t[o3 + 2] = base.t[o3 + 2]; }
      continue;
    }
    if (wi >= 1) { _qa[0] = ar[o4]; _qa[1] = ar[o4 + 1]; _qa[2] = ar[o4 + 2]; _qa[3] = ar[o4 + 3]; }
    else slerpInto(_qa, 0, _ID, 0, ar, o4, wi);
    _qb[0] = br[o4]; _qb[1] = br[o4 + 1]; _qb[2] = br[o4 + 2]; _qb[3] = br[o4 + 3];
    quat.multiply(_qc, _qb, _qa);
    or[o4] = _qc[0]; or[o4 + 1] = _qc[1]; or[o4 + 2] = _qc[2]; or[o4 + 3] = _qc[3];
    out.t[o3] = base.t[o3] + additive.t[o3] * wi; out.t[o3 + 1] = base.t[o3 + 1] + additive.t[o3 + 1] * wi; out.t[o3 + 2] = base.t[o3 + 2] + additive.t[o3 + 2] * wi;
  }
  return out;
}

/** Additive Differenz: out so, dass addPose(x, ref, out, 1) == pose (out.rot = ref^-1 * pose, out.t = pose.t - ref.t). */
export function makeAdditive(out, pose, ref) {
  for (let i = 0; i < out.n; i++) {
    const o4 = 4 * i;
    _qa[0] = -ref.rot[o4]; _qa[1] = -ref.rot[o4 + 1]; _qa[2] = -ref.rot[o4 + 2]; _qa[3] = ref.rot[o4 + 3];
    _qb[0] = pose.rot[o4]; _qb[1] = pose.rot[o4 + 1]; _qb[2] = pose.rot[o4 + 2]; _qb[3] = pose.rot[o4 + 3];
    quat.multiply(_qc, _qa, _qb);
    out.rot[o4] = _qc[0]; out.rot[o4 + 1] = _qc[1]; out.rot[o4 + 2] = _qc[2]; out.rot[o4 + 3] = _qc[3];
  }
  for (let k = 0; k < out.t.length; k++) out.t[k] = pose.t[k] - ref.t[k];
  return out;
}

// ---------------------------------------------------------------------------- Spiegeln

let _mirrorTmp = null;
/**
 * Spiegelt eine Pose an der Ebene X = 0 (links <-> rechts). Für symmetrische Skelette exakt.
 * Quaternion-Spiegelung: (x, y, z, w) -> (x, -y, -z, w); Translation: (x, y, z) -> (-x, y, z). out darf src sein.
 */
export function mirrorPose(skel, out, src) {
  const def = defOf(skel), n = def.count;
  let s = src;
  if (out === src) {
    if (!_mirrorTmp || _mirrorTmp.n < n) _mirrorTmp = makePose(n);
    _mirrorTmp.rot.set(src.rot.subarray(0, 4 * n)); _mirrorTmp.t.set(src.t.subarray(0, 3 * n)); s = _mirrorTmp;
  }
  for (let i = 0; i < n; i++) {
    const j = def.mirror[i], o = 4 * i, p = 4 * j;
    out.rot[o] = s.rot[p]; out.rot[o + 1] = -s.rot[p + 1]; out.rot[o + 2] = -s.rot[p + 2]; out.rot[o + 3] = s.rot[p + 3];
    out.t[3 * i] = -s.t[3 * j]; out.t[3 * i + 1] = s.t[3 * j + 1]; out.t[3 * i + 2] = s.t[3 * j + 2];
  }
  return out;
}

const mirrorName = (name) => name.replace(/_l$/, '_\u0001').replace(/_r$/, '_l').replace(/_\u0001$/, '_r')
  .replace(/_l_/g, '_\u0002_').replace(/_r_/g, '_l_').replace(/_\u0002_/g, '_r_');
const isSided = (name) => /(_l$|_r$|_l_|_r_)/.test(name);

/** Euler-Spezifikation spiegeln (seitliche Knochen: Namen tauschen; Mittelknochen: [x,-y,-z]; Offsets: [-x,y,z]). */
export function mirrorEulerSpec(spec) {
  const out = {};
  for (const k in spec) {
    const v = spec[k];
    if (k === 'pelvisOffset' || k === 'rootOffset') out[k] = [-v[0], v[1], v[2]];
    else if (isSided(k)) out[mirrorName(k)] = [v[0], v[1], v[2]];
    else out[k] = [v[0], -v[1], -v[2]];
  }
  return out;
}

/** Gespiegelte Kopie eines Clips (Keys/Events werden kopiert). */
export function mirrorClip(clip, name = (clip.name || 'clip') + '_mirror') {
  return {
    ...clip, name,
    keys: clip.keys.map((k) => ({ ...k, pose: k.pose && k.pose.rot ? k.pose : mirrorEulerSpec(k.pose || {}) })),
    events: (clip.events || []).map((e) => ({ ...e })),
  };
}

// ---------------------------------------------------------------------------- Euler <-> Quaternion

/**
 * Euler (Grad, anatomischer Gelenkrahmen, siehe Kopfkommentar) -> lokale Quaternion des Knochens. Allokationsfrei.
 */
export function eulerToQuat(skel, bone, xDeg, yDeg, zDeg, out = quat.create()) {
  const def = defOf(skel), i = boneIdx(def, bone);
  const s = def.side[i] < 0 ? -1 : 1;
  const hx = xDeg * DEG * 0.5, hy = yDeg * s * DEG * 0.5, hz = zDeg * s * DEG * 0.5;
  const sx = Math.sin(hx), cx = Math.cos(hx), sy = Math.sin(hy), cy = Math.cos(hy), sz = Math.sin(hz), cz = Math.cos(hz);
  // R = Rz * Rx * Ry
  const rx = cz * sx * cy - sz * cx * sy, ry = sz * sx * cy + cz * cx * sy, rz = sz * cx * cy + cz * sx * sy, rw = cz * cx * cy - sz * sx * sy;
  // out = F * R * F^-1
  const F = def.frames, o = 4 * i;
  const fx = F[o], fy = F[o + 1], fz = F[o + 2], fw = F[o + 3];
  const tx = fw * rx + fx * rw + fy * rz - fz * ry;
  const ty = fw * ry + fy * rw + fz * rx - fx * rz;
  const tz = fw * rz + fz * rw + fx * ry - fy * rx;
  const tw = fw * rw - fx * rx - fy * ry - fz * rz;
  // * conj(F)
  const bx = -fx, by = -fy, bz = -fz, bw = fw;
  out[0] = tx * bw + tw * bx + ty * bz - tz * by;
  out[1] = ty * bw + tw * by + tz * bx - tx * bz;
  out[2] = tz * bw + tw * bz + tx * by - ty * bx;
  out[3] = tw * bw - tx * bx - ty * by - tz * bz;
  return out;
}

/** Lokale Quaternion -> Euler [x, y, z] in Grad (Umkehrung von eulerToQuat; |x| < 90° eindeutig). */
export function quatToEuler(skel, bone, q, out = [0, 0, 0]) {
  const def = defOf(skel), i = boneIdx(def, bone);
  const F = def.frames, o = 4 * i;
  const fx = F[o], fy = F[o + 1], fz = F[o + 2], fw = F[o + 3];
  // R = F^-1 * q * F
  const ax = -fx, ay = -fy, az = -fz, aw = fw;
  const tx = aw * q[0] + ax * q[3] + ay * q[2] - az * q[1];
  const ty = aw * q[1] + ay * q[3] + az * q[0] - ax * q[2];
  const tz = aw * q[2] + az * q[3] + ax * q[1] - ay * q[0];
  const tw = aw * q[3] - ax * q[0] - ay * q[1] - az * q[2];
  const x = tx * fw + tw * fx + ty * fz - tz * fy;
  const y = ty * fw + tw * fy + tz * fx - tx * fz;
  const z = tz * fw + tw * fz + tx * fy - ty * fx;
  const w = tw * fw - tx * fx - ty * fy - tz * fz;
  // Matrixelemente von R = Rz Rx Ry: m21 = sx, m20 = -cx sy, m22 = cx cy, m01 = -sz cx, m11 = cz cx
  const m21 = 2 * (y * z + w * x), m20 = 2 * (x * z - w * y), m22 = 1 - 2 * (x * x + y * y);
  const m01 = 2 * (x * y - w * z), m11 = 1 - 2 * (x * x + z * z);
  const s = def.side[i] < 0 ? -1 : 1;
  let ex = Math.asin(clamp(m21, -1, 1)) / DEG, ey = Math.atan2(-m20, m22) / DEG, ez = Math.atan2(-m01, m11) / DEG;
  // gleichwertige Lösung (180 - x, y + 180, z + 180) bevorzugen, wenn sie kleinere Verdreh-/Seitwinkel hat
  // (z.B. Kniebeugung > 90°: [-112, 0, 0] statt [-68, 180, 180])
  if (Math.abs(ey) + Math.abs(ez) > 180) {
    const w = (a) => (a > 180 ? a - 360 : a <= -180 ? a + 360 : a);
    ex = w(180 - ex); ey = w(ey + 180); ez = w(ez + 180);
  }
  out[0] = ex; out[1] = s * ey; out[2] = s * ez;
  return out;
}

/**
 * Pose aus Euler-Winkeln: { bone: [xDeg, yDeg, zDeg], …, pelvisOffset: [x,y,z], rootOffset: [x,y,z] }.
 * Nicht genannte Knochen bleiben in Ruhe. Unbekannte Knochen werden ignoriert (Clips sind zwischen Figuren
 * mit unterschiedlichen Zusatzknochen teilbar), außer opts.strict.
 */
export function poseFromEuler(skel, spec, out = null, opts = {}) {
  const def = defOf(skel);
  if (!out) out = makePose(def.count); else resetPose(out);
  return applyEuler(def, out, spec, 1, opts);
}

/** Euler-Werte in eine bestehende Pose schreiben (weight < 1: von der vorhandenen Rotation aus geslerpt). */
export function applyEuler(skel, pose, spec, weight = 1, opts = {}) {
  const def = defOf(skel);
  for (const k in spec) {
    const v = spec[k];
    if (k === 'pelvisOffset' || k === 'rootOffset') {
      const o = k === 'rootOffset' ? 0 : 3;
      for (let c = 0; c < 3; c++) pose.t[o + c] += (v[c] - pose.t[o + c]) * weight;
      continue;
    }
    const i = def.index[k];
    if (i === undefined) { if (opts.strict) throw new Error(`poseFromEuler: unbekannter Knochen "${k}"`); continue; }
    eulerToQuat(def, i, v[0], v[1], v[2], _qa);
    if (weight >= 1) pose.rot.set(_qa, 4 * i);
    else slerpInto(pose.rot, 4 * i, pose.rot, 4 * i, _qa, 0, weight);
  }
  return pose;
}

/** Pose -> Euler-Spezifikation (nur Knochen mit |Winkel| > eps Grad; für Debugging/Export). */
export function poseToEuler(skel, pose, eps = 0.05) {
  const def = defOf(skel), out = {};
  const e = [0, 0, 0];
  for (let i = 0; i < def.count; i++) {
    quatToEuler(def, i, pose.rot.subarray(4 * i, 4 * i + 4), e);
    if (Math.abs(e[0]) > eps || Math.abs(e[1]) > eps || Math.abs(e[2]) > eps) out[def.names[i]] = e.map((v) => Math.round(v * 100) / 100);
  }
  const r = (v) => Math.round(v * 10000) / 10000;
  if (pose.t[0] || pose.t[1] || pose.t[2]) out.rootOffset = [r(pose.t[0]), r(pose.t[1]), r(pose.t[2])];
  if (pose.t[3] || pose.t[4] || pose.t[5]) out.pelvisOffset = [r(pose.t[3]), r(pose.t[4]), r(pose.t[5])];
  return out;
}

// ---------------------------------------------------------------------------- Masken

/**
 * Knochenmaske (Float32Array n, Werte 0..1) für Ebenen/Überblendungen.
 * spec: 'upper' (spine + alles darüber inkl. Arme/Kopf/Ohren) | 'lower' (root, pelvis, Beine, Schwanz) |
 *       'torso' (spine, chest) | 'head' (neck, head + Kinder) | 'arm_l' | 'arm_r' (shoulder..hand + Kinder) |
 *       'leg_l' | 'leg_r' (thigh..toe) | 'arms' | 'legs' | 'name*' (Knochen + alle Nachfahren) | 'name' |
 *       Array solcher Einträge | { eintrag: gewicht, … } (spätere Einträge überschreiben frühere).
 */
export function boneMask(skel, spec, weight = 1) {
  const def = defOf(skel), n = def.count;
  const m = new Float32Array(n);
  const setTree = (i, w) => { m[i] = w; for (const c of def.children[i]) setTree(c, w); };
  const apply = (s, w) => {
    if (Array.isArray(s)) { for (const e of s) apply(e, w); return; }
    if (typeof s === 'object') { for (const k in s) apply(k, s[k] * w); return; }
    const has = (b) => def.index[b] !== undefined;
    switch (s) {
      case 'all': m.fill(w); return;
      case 'upper': setTree(def.index.spine, w); return;
      case 'lower':
        for (const b of ['root', 'pelvis']) m[def.index[b]] = w;
        for (const c of def.children[def.index.pelvis]) if (c !== def.index.spine) setTree(c, w);
        return;
      case 'torso': m[def.index.spine] = w; m[def.index.chest] = w; return;
      case 'head': setTree(def.index.neck, w); return;
      case 'arm_l': case 'arm_r': setTree(def.index['shoulder' + s.slice(3)], w); return;
      case 'leg_l': case 'leg_r': setTree(def.index['thigh' + s.slice(3)], w); return;
      case 'arms': apply(['arm_l', 'arm_r'], w); return;
      case 'legs': apply(['leg_l', 'leg_r'], w); return;
    }
    if (s.endsWith('*')) { const b = s.slice(0, -1); if (has(b)) setTree(def.index[b], w); return; }
    if (has(s)) m[def.index[s]] = w;
  };
  apply(spec, weight);
  return m;
}

// ---------------------------------------------------------------------------- Easing

/** Easing-Funktionen [0,1] -> [0,1] für Clip-Keys (ease: Name oder Funktion). */
export const EASE = {
  linear: (u) => u,
  in: easeInCubic, out: easeOutCubic, inOut: easeInOutCubic,
  inQuad: (u) => u * u, outQuad: (u) => 1 - (1 - u) * (1 - u), inOutQuad: easeInOutQuad,
  inCubic: easeInCubic, outCubic: easeOutCubic, inOutCubic: easeInOutCubic,
  inQuart: (u) => u * u * u * u, outQuart: (u) => 1 - Math.pow(1 - u, 4),
  inExpo: (u) => (u <= 0 ? 0 : Math.pow(2, 10 * u - 10)), outExpo: (u) => (u >= 1 ? 1 : 1 - Math.pow(2, -10 * u)),
  outBack: (u) => easeOutBack(u), inBack: (u) => 2.70158 * u * u * u - 1.70158 * u * u,
  smooth: (u) => smoothstep(0, 1, u), smoother: (u) => smootherstep(0, 1, u),
  step: () => 0, hold: () => 0,
};
function easeFn(e) {
  if (!e) return null;
  if (typeof e === 'function') return e;
  const f = EASE[e];
  if (!f) throw new Error(`pose: unbekanntes Easing "${e}"`);
  return f;
}

// ---------------------------------------------------------------------------- Clips

/*
 * Clip-Format:
 *   { name, duration, loop: false, interp: 'spline' | 'linear', ease?: Standard-Easing,
 *     keys: [ { t, pose: { bone: [x,y,z], pelvisOffset: [..], rootOffset: [..] } | Pose-Objekt, ease? }, … ],
 *     events: [ { t, name, …beliebige Daten } ] }
 *
 * Kanäle sind PRO KNOCHEN spärlich: ein Key muss nur die Knochen enthalten, die er festlegt. Zwischen zwei Keys,
 * die einen Knochen enthalten, wird interpoliert; davor/danach gehalten. Nie genannte Knochen = Ruhe (Identität).
 * Ein Pose-Objekt (createPose/poseFromEuler) als key.pose legt alle Knochen + beide Offsets fest.
 * `ease` eines Keys gilt für das Segment, das IN diesen Key hineinführt ("ankommen mit …").
 * interp 'spline' (Standard): monotone kubische Hermite-Kurve durch die Keys (C1-stetig, kein Überschwingen),
 *   Enden nicht-loopender Clips mit Tangente 0; 'linear': stückweise slerp. Easing wirkt auf den Segmentparameter.
 * Loop-Clips: Zeit wird modulo duration genommen; ein Key bei t = duration wird mit dem bei t = 0 gleichgesetzt.
 */

const _compiled = new WeakMap();

/** Clip vorkompilieren (passiert automatisch und gecacht beim ersten sampleClip je Skelett). */
export function compileClip(skel, clip) {
  const def = defOf(skel);
  let per = _compiled.get(clip);
  if (!per) { per = new Map(); _compiled.set(clip, per); }
  let c = per.get(def);
  if (c && c.version === clip.keys) return c;
  c = buildClip(def, clip);
  per.set(def, c);
  return c;
}

function buildClip(def, clip) {
  const keys = clip.keys.slice().sort((a, b) => a.t - b.t);
  const D = clip.duration !== undefined ? clip.duration : (keys.length ? keys[keys.length - 1].t : 0);
  const loop = !!clip.loop && D > 0;
  const linear = clip.interp === 'linear';
  const defEase = easeFn(clip.ease) || null;
  const chans = new Map(); // id -> [{t, v, ease}]
  const push = (id, t, v, ease) => { let a = chans.get(id); if (!a) chans.set(id, (a = [])); a.push({ t, v, ease }); };
  for (const k of keys) {
    const ease = easeFn(k.ease) || defEase;
    const p = k.pose || {};
    if (p.rot && p.t) {
      for (let i = 0; i < def.count; i++) push('r' + i, k.t, Array.from(p.rot.subarray(4 * i, 4 * i + 4)), ease);
      push('t0', k.t, Array.from(p.t.subarray(0, 3)), ease);
      push('t1', k.t, Array.from(p.t.subarray(3, 6)), ease);
      continue;
    }
    for (const name in p) {
      const v = p[name];
      if (name === 'rootOffset') { push('t0', k.t, [v[0], v[1], v[2]], ease); continue; }
      if (name === 'pelvisOffset') { push('t1', k.t, [v[0], v[1], v[2]], ease); continue; }
      const i = def.index[name];
      if (i === undefined) continue;
      push('r' + i, k.t, Array.from(eulerToQuat(def, i, v[0], v[1], v[2], quat.create())), ease);
    }
  }
  const rot = [], tra = [];
  for (const [id, arr] of chans) {
    const isRot = id[0] === 'r';
    const tr = buildTrack(arr, isRot ? 4 : 3, D, loop, linear, isRot);
    tr.bone = +id.slice(1);
    (isRot ? rot : tra).push(tr);
  }
  const events = (clip.events || []).slice().sort((a, b) => a.t - b.t);
  return { version: clip.keys, duration: D, loop, rot, tra, events, keyedRot: new Uint8Array(def.count).map((_, i) => (chans.has('r' + i) ? 1 : 0)) };
}

/** Kanal: Zeiten, Werte, Tangenten (pro Komponente), Easing je Segment (Index = Ziel-Key). */
function buildTrack(arr, dim, D, loop, linear, isRot) {
  // gleiche Zeiten zusammenfassen (letzter gewinnt)
  let ks = [];
  for (const k of arr) {
    let t = k.t;
    if (loop) { t = ((t % D) + D) % D; if (D - t < 1e-6) t = 0; }
    const e = ks.find((q) => Math.abs(q.t - t) < 1e-6);
    if (e) { if (!(loop && Math.abs(k.t - D) < 1e-6)) { e.v = k.v; e.ease = k.ease; } } else ks.push({ t, v: k.v.slice(), ease: k.ease });
  }
  ks.sort((a, b) => a.t - b.t);
  const m = ks.length;
  // Hemisphären angleichen
  if (isRot) for (let k = 1; k < m; k++) {
    const a = ks[k - 1].v, b = ks[k].v;
    if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0) for (let c = 0; c < 4; c++) b[c] = -b[c];
  }
  // erweiterte Folge für Loops: [letzter - D, …, erster + D]
  let ext = ks;
  if (loop && m > 1) {
    const first = { t: ks[0].t + D, v: ks[0].v.slice(), ease: ks[0].ease };
    const last = { t: ks[m - 1].t - D, v: ks[m - 1].v.slice(), ease: ks[m - 1].ease };
    if (isRot) {
      const a = ks[m - 1].v;
      if (a[0] * first.v[0] + a[1] * first.v[1] + a[2] * first.v[2] + a[3] * first.v[3] < 0) for (let c = 0; c < 4; c++) first.v[c] = -first.v[c];
      const b = ks[0].v;
      if (b[0] * last.v[0] + b[1] * last.v[1] + b[2] * last.v[2] + b[3] * last.v[3] < 0) for (let c = 0; c < 4; c++) last.v[c] = -last.v[c];
    }
    ext = [last, ...ks, first];
  }
  const N = ext.length;
  const times = new Float64Array(N), vals = new Float32Array(N * dim), tans = new Float32Array(N * dim);
  const eases = new Array(N);
  for (let k = 0; k < N; k++) { times[k] = ext[k].t; vals.set(ext[k].v, k * dim); eases[k] = ext[k].ease; }
  if (!linear && N > 1) {
    // monotone Tangenten (Fritsch-Carlson je Komponente); Loop: Nachbarn zyklisch
    const val = (k, c) => vals[k * dim + c];
    for (let k = 0; k < N; k++) {
      const hasPrev = k > 0, hasNext = k < N - 1;
      for (let c = 0; c < dim; c++) {
        let mt = 0;
        if (loop && m > 1 && (!hasPrev || !hasNext)) {
          // Randkopien: Tangente des Original-Keys übernehmen (unten nachgetragen)
          mt = NaN;
        } else if (hasPrev && hasNext) {
          const dl = times[k] - times[k - 1], dr = times[k + 1] - times[k];
          const sl = (val(k, c) - val(k - 1, c)) / (dl || 1e-9), sr = (val(k + 1, c) - val(k, c)) / (dr || 1e-9);
          if (sl * sr > 0) {
            mt = (sl * dr + sr * dl) / (dl + dr);
            const lim = 3 * Math.min(Math.abs(sl), Math.abs(sr));
            if (Math.abs(mt) > lim) mt = Math.sign(mt) * lim;
          }
        }
        tans[k * dim + c] = mt;
      }
    }
    if (loop && m > 1) {
      // Randkopien: ext[0] = Kopie von ks[m-1] (= ext[N-2]), ext[N-1] = Kopie von ks[0] (= ext[1]).
      // Quaternion-Kopien können negiert sein (Hemisphäre) -> Tangente mitnegieren.
      const flip0 = isRot && dot4(vals, 0, vals, (N - 2) * 4) < 0, flip1 = isRot && dot4(vals, (N - 1) * 4, vals, 4) < 0;
      for (let c = 0; c < dim; c++) {
        tans[c] = tans[(N - 2) * dim + c] * (flip0 ? -1 : 1);
        tans[(N - 1) * dim + c] = tans[dim + c] * (flip1 ? -1 : 1);
      }
    }
  }
  return { n: N, dim, times, vals, tans, eases, linear, last: 0 };
}
function dot4(a, ao, b, bo) { return a[ao] * b[bo] + a[ao + 1] * b[bo + 1] + a[ao + 2] * b[bo + 2] + a[ao + 3] * b[bo + 3]; }

/** Kanal an Zeit t auswerten -> out[oo..oo+dim). */
function evalTrack(tr, t, out, oo) {
  const n = tr.n, dim = tr.dim, T = tr.times, V = tr.vals;
  if (n === 1 || t <= T[0]) { for (let c = 0; c < dim; c++) out[oo + c] = V[c]; return; }
  if (t >= T[n - 1]) { const o = (n - 1) * dim; for (let c = 0; c < dim; c++) out[oo + c] = V[o + c]; return; }
  // Segment suchen (letzte Position als Startwert – meist monoton fortschreitende Zeit)
  let k = tr.last;
  if (k >= n - 1 || T[k] > t) k = 0;
  while (k < n - 2 && T[k + 1] <= t) k++;
  tr.last = k;
  const t0 = T[k], t1 = T[k + 1], dt = t1 - t0;
  let u = dt > 0 ? (t - t0) / dt : 1;
  const e = tr.eases[k + 1];
  if (e) u = e(u);
  const a = k * dim, b = a + dim;
  if (tr.linear) {
    if (dim === 4) slerpInto(out, oo, V, a, V, b, u);
    else for (let c = 0; c < dim; c++) out[oo + c] = V[a + c] + (V[b + c] - V[a + c]) * u;
    return;
  }
  const u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = (u3 - 2 * u2 + u) * dt, h01 = -2 * u3 + 3 * u2, h11 = (u3 - u2) * dt;
  const M = tr.tans;
  for (let c = 0; c < dim; c++) out[oo + c] = h00 * V[a + c] + h10 * M[a + c] + h01 * V[b + c] + h11 * M[b + c];
  if (dim === 4) {
    const l = 1 / (Math.hypot(out[oo], out[oo + 1], out[oo + 2], out[oo + 3]) || 1);
    out[oo] *= l; out[oo + 1] *= l; out[oo + 2] *= l; out[oo + 3] *= l;
  }
}

/** Clip-Zeit normalisieren (Loop: modulo, sonst geklemmt). */
export function clipTime(clip, time) {
  const D = clip.duration !== undefined ? clip.duration : (clip.keys.length ? Math.max(...clip.keys.map((k) => k.t)) : 0);
  if (D <= 0) return 0;
  if (clip.loop) return ((time % D) + D) % D;
  return time < 0 ? 0 : time > D ? D : time;
}

/**
 * Clip an `time` (s) in outPose auswerten. Nicht gekeyte Knochen = Identität, Offsets = 0. Allokationsfrei
 * (nach dem ersten Aufruf, der kompiliert).
 */
export function sampleClip(skel, clip, time, outPose) {
  const c = compileClip(skel, clip);
  let t = time;
  if (c.duration > 0) t = c.loop ? ((t % c.duration) + c.duration) % c.duration : (t < 0 ? 0 : t > c.duration ? c.duration : t);
  else t = 0;
  resetPose(outPose);
  for (let k = 0; k < c.rot.length; k++) { const tr = c.rot[k]; evalTrack(tr, t, outPose.rot, 4 * tr.bone); }
  for (let k = 0; k < c.tra.length; k++) { const tr = c.tra[k]; evalTrack(tr, t, outPose.t, 3 * tr.bone); }
  return outPose;
}

/**
 * Events im halboffenen Intervall (t0, t1] sammeln (Clip-Zeit, nicht normalisiert; bei Loop-Clips mit Umbruch).
 * Pusht die Event-Objekte des Clips selbst in `out` (keine Allokation). Gibt out zurück.
 */
export function clipEvents(clip, t0, t1, out = [], loop = !!clip.loop) {
  const ev = clip.events; if (!ev || !ev.length || t1 <= t0) return out;
  const D = clip.duration !== undefined ? clip.duration : 0;
  if (!loop || D <= 0) {
    for (let i = 0; i < ev.length; i++) if (ev[i].t > t0 && ev[i].t <= t1) out.push(ev[i]);
    return out;
  }
  const c0 = Math.floor(t0 / D), c1 = Math.floor(t1 / D);
  for (let cyc = c0; cyc <= c1 && cyc - c0 < 64; cyc++) {
    for (let i = 0; i < ev.length; i++) { const et = ev[i].t + cyc * D; if (et > t0 && et <= t1) out.push(ev[i]); }
  }
  return out;
}

// ---------------------------------------------------------------------------- AnimLayer (Crossfade)

/**
 * Abspieler mit Überblendung (Crossfade) zwischen Clips. Allokationsfrei im Betrieb.
 *   const L = new AnimLayer(skel);
 *   L.play(clips.idle, { fade: 0.2 });   L.play(clips.forehand, { fade: 0.1, speed: 1.2, time: 0 });
 *   L.update(dt);  -> L.pose (gemischte Pose), L.events (in diesem Update überschrittene Events: Clip-Event-Objekte;
 *                     zusätzlich { name: 'end', clip } wenn ein nicht-loopender Clip sein Ende erreicht)
 *   L.current -> { clip, time, speed, weight, done }
 * Verknüpfen mit anderen Ebenen: blendPose(out, base, L.pose, L.weight, mask) bzw. addPose(...).
 */
export class AnimLayer {
  constructor(skel, opts = {}) {
    this.def = defOf(skel);
    this.pose = makePose(this.def.count);
    this._tmp = makePose(this.def.count);
    this.tracks = [];
    this.maxTracks = opts.maxTracks || 4;
    this.events = [];
    this.weight = 1;
    this.mask = opts.mask || null;
  }
  get current() { return this.tracks.length ? this.tracks[this.tracks.length - 1] : null; }
  /** Normierte Zeit (0..1) des aktuellen Clips. */
  get progress() { const c = this.current; return c && c.duration > 0 ? clamp(c.time / c.duration, 0, 1) : 0; }
  /**
   * Clip starten. opts: fade (s, Überblendzeit, Standard 0.15), speed (1), time (Startzeit, 0), ease ('inOut'
   * Überblendkurve), restart (true: auch wenn derselbe Clip schon läuft neu starten).
   */
  play(clip, opts = {}) {
    const cur = this.current;
    if (cur && cur.clip === clip && !opts.restart && opts.time === undefined) { if (opts.speed !== undefined) cur.speed = opts.speed; return cur; }
    const fade = opts.fade !== undefined ? opts.fade : 0.15;
    const c = compileClip(this.def, clip);
    const tr = {
      clip, time: opts.time || 0, speed: opts.speed !== undefined ? opts.speed : 1, duration: c.duration, loop: c.loop,
      fade, fadeT: fade > 0 && this.tracks.length ? 0 : 1, weight: 0, ease: easeFn(opts.ease || 'inOut'), done: false,
      endEvent: { name: 'end', clip, t: c.duration },
    };
    tr.weight = tr.fadeT >= 1 ? 1 : 0;
    this.tracks.push(tr);
    if (this.tracks.length > this.maxTracks) this.tracks.shift();
    if (tr.weight >= 1) this.tracks.splice(0, this.tracks.length - 1);
    return tr;
  }
  /** Alle Clips stoppen (Pose bleibt bis zum nächsten play/update auf dem letzten Stand). */
  stop() { this.tracks.length = 0; }
  /** Zeit voranschreiten lassen und this.pose berechnen. */
  update(dt) {
    this.events.length = 0;
    const T = this.tracks;
    for (let k = 0; k < T.length; k++) {
      const tr = T[k];
      const t0 = tr.time;
      tr.time += dt * tr.speed;
      if (!tr.loop && tr.duration > 0 && tr.time >= tr.duration) {
        tr.time = tr.duration;
        if (!tr.done) { tr.done = true; if (k === T.length - 1) { clipEvents(tr.clip, t0, tr.time, this.events, false); this.events.push(tr.endEvent); continue; } }
      }
      if (k === T.length - 1 && tr.time > t0) clipEvents(tr.clip, t0, tr.time, this.events, tr.loop);
    }
    // Überblendgewichte
    for (let k = 0; k < T.length; k++) {
      const tr = T[k];
      if (tr.fadeT < 1) { tr.fadeT = tr.fade > 0 ? Math.min(1, tr.fadeT + dt / tr.fade) : 1; tr.weight = tr.ease(tr.fadeT); }
    }
    // vollständig eingeblendete Spur verdeckt alle älteren
    for (let k = T.length - 1; k > 0; k--) if (T[k].weight >= 1) { T.splice(0, k); break; }
    if (!T.length) return this.pose;
    sampleClip(this.def, T[0].clip, T[0].time, this.pose);
    for (let k = 1; k < T.length; k++) {
      sampleClip(this.def, T[k].clip, T[k].time, this._tmp);
      blendPose(this.pose, this.pose, this._tmp, T[k].weight, this.mask);
    }
    return this.pose;
  }
}

// ---------------------------------------------------------------------------- FK-Hilfen

/** Modellraum-Rotation (quat) und -Position eines Knochens für eine beliebige Pose (allokationsfrei). */
export function getBoneModel(skel, pose, bone, outRot, outPos) {
  const def = defOf(skel);
  return boneModelTransform(def, pose, boneIdx(def, bone), outRot, outPos);
}
function parentModelRot(def, pose, i, outRot) {
  const p = def.parents[i];
  if (p < 0) { outRot[0] = 0; outRot[1] = 0; outRot[2] = 0; outRot[3] = 1; return outRot; }
  return boneModelTransform(def, pose, p, outRot, _pTmp);
}
const _pTmp = new Float32Array(3);
function rotVec(o, q, x, y, z) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const uvx = qy * z - qz * y, uvy = qz * x - qx * z, uvz = qx * y - qy * x;
  const uuvx = qy * uvz - qz * uvy, uuvy = qz * uvx - qx * uvz, uuvz = qx * uvy - qy * uvx;
  o[0] = x + 2 * (qw * uvx + uuvx); o[1] = y + 2 * (qw * uvy + uuvy); o[2] = z + 2 * (qw * uvz + uuvz);
  return o;
}
/** Minimale Rotation, die Einheitsvektor a auf Einheitsvektor b dreht (allokationsfrei). */
function rotationTo(o, ax, ay, az, bx, by, bz) {
  const d = ax * bx + ay * by + az * bz;
  if (d < -0.999999) {
    // 180°: beliebige Achse senkrecht zu a
    let cx = 0, cy = -az, cz = ay;
    if (cy * cy + cz * cz < 1e-8) { cx = az; cy = 0; cz = -ax; }
    const l = 1 / Math.hypot(cx, cy, cz);
    o[0] = cx * l; o[1] = cy * l; o[2] = cz * l; o[3] = 0; return o;
  }
  o[0] = ay * bz - az * by; o[1] = az * bx - ax * bz; o[2] = ax * by - ay * bx; o[3] = 1 + d;
  const l = 1 / Math.hypot(o[0], o[1], o[2], o[3]);
  o[0] *= l; o[1] *= l; o[2] *= l; o[3] *= l; return o;
}
/** Neue Modellraum-Rotation `modelRot` für Knochen i setzen (lokal = Eltern^-1 * modelRot). */
function setModelRot(def, pose, i, modelRot) {
  parentModelRot(def, pose, i, _qp);
  _qp[0] = -_qp[0]; _qp[1] = -_qp[1]; _qp[2] = -_qp[2];
  quat.multiply(_qq, _qp, modelRot);
  quat.normalize(_qq, _qq);
  pose.rot[4 * i] = _qq[0]; pose.rot[4 * i + 1] = _qq[1]; pose.rot[4 * i + 2] = _qq[2]; pose.rot[4 * i + 3] = _qq[3];
}
const _qp = new Float32Array(4), _qq = new Float32Array(4);
/** Quaternion auf Winkel begrenzen und mit Gewicht skalieren (slerp von Identität). */
function limitQuat(q, maxAngle, weight) {
  if (q[3] < 0) { q[0] = -q[0]; q[1] = -q[1]; q[2] = -q[2]; q[3] = -q[3]; }
  const ang = 2 * Math.acos(clamp(q[3], -1, 1));
  let f = weight;
  if (ang > maxAngle && ang > 1e-9) f *= maxAngle / ang;
  if (f >= 1) return q;
  const a = ang * f * 0.5, s = Math.sin(ang * 0.5);
  if (s < 1e-9) { q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 1; return q; }
  const k = Math.sin(a) / s;
  q[0] *= k; q[1] *= k; q[2] *= k; q[3] = Math.cos(a);
  return q;
}

// ---------------------------------------------------------------------------- Zwei-Knochen-IK

const _A = new Float64Array(3), _B = new Float32Array(3), _E = new Float32Array(3), _Ru = new Float32Array(4);
const _tq = new Float32Array(4), _origU = new Float32Array(4), _origL = new Float32Array(4), _endRot0 = new Float32Array(4);
const _fq = new Float32Array(4), _tw = new Float32Array(4), _H = new Float32Array(4), _Q = new Float32Array(4), _m9 = new Float32Array(9), _v3 = new Float32Array(3);
const _ikResult = { reached: true, distance: 0, error: 0, clamped: false };

/**
 * Analytische Zwei-Knochen-IK (Arm: arm/forearm/hand, Bein: thigh/shin/foot). Ändert pose.rot von upper und lower
 * (und end bei keepEndRot/endRot). Ziel und Pol im MODELLRAUM der Figur (wie skel.getWorldPos ohne model).
 * Das mittlere Gelenk bleibt ein reines Scharnier um seine X'-Achse (vorhandene Verdrehung um die Knochenachse,
 * z.B. Pronation, bleibt erhalten); die Beugerichtung folgt def.bendSign (Ellbogen nach vorn, Knie nach hinten).
 * Der Pol bestimmt die Ebene: das mittlere Gelenk zeigt zum Pol (Ellbogen: Punkt hinter/unter dem Ellbogen,
 * Knie: Punkt vor dem Knie). Ohne Pol bleibt die aktuelle Beugeebene erhalten.
 * opts: weight (0..1), soft (m, weiches Strecken vor voller Länge gegen "Knie-Schnappen", Standard 0),
 *       keepEndRot (true: Modellraum-Rotation des end-Knochens bleibt wie vor der IK), endRot (quat Modellraum:
 *       end-Knochen auf diese Rotation setzen), maxReach (Anteil der Kettenlänge, Standard 0.9999).
 * Gibt ein (wiederverwendetes) Objekt { reached, distance, error, clamped } zurück.
 */
export function twoBoneIK(skel, pose, upper, lower, end, targetModelPos, poleModelPos = null, opts = {}) {
  const def = defOf(skel);
  const iu = boneIdx(def, upper), il = boneIdx(def, lower), ie = boneIdx(def, end);
  const weight = opts.weight !== undefined ? opts.weight : 1;
  const res = _ikResult;
  if (weight <= 0) { res.reached = false; res.distance = 0; res.error = 0; res.clamped = false; return res; }
  const R = pose.rot, Tt = pose.t;
  for (let c = 0; c < 4; c++) { _origU[c] = R[4 * iu + c]; _origL[c] = R[4 * il + c]; }
  const keepEnd = !!opts.keepEndRot && !opts.endRot;
  if (keepEnd) boneModelTransform(def, pose, ie, _endRot0, _v3);

  // Vektoren der Kette in Elternräumen: u = upper->lower (in upper-lokal), w = lower->end (in lower-lokal)
  const ux = def.offset[3 * il] + Tt[3 * il], uy = def.offset[3 * il + 1] + Tt[3 * il + 1], uz = def.offset[3 * il + 2] + Tt[3 * il + 2];
  const wx0 = def.offset[3 * ie] + Tt[3 * ie], wy0 = def.offset[3 * ie + 1] + Tt[3 * ie + 1], wz0 = def.offset[3 * ie + 2] + Tt[3 * ie + 2];
  const lab = Math.hypot(ux, uy, uz), lcb = Math.hypot(wx0, wy0, wz0);

  // Position des oberen Gelenks
  boneModelTransform(def, pose, iu, _Ru, _v3);
  _A[0] = _v3[0]; _A[1] = _v3[1]; _A[2] = _v3[2];
  let tx = targetModelPos[0] - _A[0], ty = targetModelPos[1] - _A[1], tz = targetModelPos[2] - _A[2];
  const dist = Math.hypot(tx, ty, tz);
  const maxL = (lab + lcb) * (opts.maxReach || 0.9999), minL = Math.abs(lab - lcb) * 1.001 + 1e-5;
  let L = dist;
  const soft = opts.soft || 0;
  if (soft > 0) { const ds = maxL - soft; if (L > ds) L = ds + soft * (1 - Math.exp(-(L - ds) / soft)); }
  res.clamped = L > maxL || L < minL;
  L = clamp(L, minL, maxL);
  if (dist > 1e-9) { tx /= dist; ty /= dist; tz /= dist; } else { tx = 0; ty = -1; tz = 0; }

  // 1) Scharnierwinkel: Verdrehung von lower um seine Ruhe-Knochenachse Y' erhalten, Schwung ersetzen
  const F = def.frames, fo = 4 * il;
  _fq[0] = F[fo]; _fq[1] = F[fo + 1]; _fq[2] = F[fo + 2]; _fq[3] = F[fo + 3];
  rotVec(_v3, _fq, 0, 1, 0);
  const yax = _v3[0], yay = _v3[1], yaz = _v3[2];
  const o4 = 4 * il;
  const pd = R[o4] * yax + R[o4 + 1] * yay + R[o4 + 2] * yaz;
  _tw[0] = yax * pd; _tw[1] = yay * pd; _tw[2] = yaz * pd; _tw[3] = R[o4 + 3];
  const twl = Math.hypot(_tw[0], _tw[1], _tw[2], _tw[3]);
  if (twl < 1e-6) { _tw[0] = 0; _tw[1] = 0; _tw[2] = 0; _tw[3] = 1; } else { _tw[0] /= twl; _tw[1] /= twl; _tw[2] /= twl; _tw[3] /= twl; }
  rotVec(_v3, _tw, wx0, wy0, wz0);
  const wx = _v3[0], wy = _v3[1], wz = _v3[2];
  rotVec(_v3, _fq, 1, 0, 0);
  const ax = _v3[0], ay = _v3[1], az = _v3[2];
  const aw = ax * wx + ay * wy + az * wz;
  const pwx = ax * aw, pwy = ay * aw, pwz = az * aw;              // w parallel zur Achse
  const qwx = wx - pwx, qwy = wy - pwy, qwz = wz - pwz;           // w senkrecht
  const cwx = ay * wz - az * wy, cwy = az * wx - ax * wz, cwz = ax * wy - ay * wx; // a x w
  const Aq = ux * pwx + uy * pwy + uz * pwz, Bq = ux * qwx + uy * qwy + uz * qwz, Cq = ux * cwx + uy * cwy + uz * cwz;
  const Dq = (L * L - lab * lab - lcb * lcb) * 0.5;
  const Rq = Math.hypot(Bq, Cq);
  let theta = 0;
  if (Rq > 1e-9) {
    const phi = Math.atan2(Cq, Bq);
    const alpha = Math.acos(clamp((Dq - Aq) / Rq, -1, 1));
    theta = phi + (def.bendSign[il] >= 0 ? 1 : -1) * alpha;
  }
  const hs = Math.sin(theta * 0.5);
  _H[0] = ax * hs; _H[1] = ay * hs; _H[2] = az * hs; _H[3] = Math.cos(theta * 0.5);
  quat.multiply(_tq, _H, _tw);
  R[4 * il] = _tq[0]; R[4 * il + 1] = _tq[1]; R[4 * il + 2] = _tq[2]; R[4 * il + 3] = _tq[3];

  // 2) upper so drehen, dass end auf dem Ziel liegt und lower in der Pol-Ebene
  boneModelTransform(def, pose, il, _tq, _B);
  boneModelTransform(def, pose, ie, _tq, _E);
  let s1x = _E[0] - _A[0], s1y = _E[1] - _A[1], s1z = _E[2] - _A[2];
  let l = Math.hypot(s1x, s1y, s1z) || 1; s1x /= l; s1y /= l; s1z /= l;
  const mx = _B[0] - _A[0], my = _B[1] - _A[1], mz = _B[2] - _A[2];
  let md = mx * s1x + my * s1y + mz * s1z;
  let s2x = mx - s1x * md, s2y = my - s1y * md, s2z = mz - s1z * md;
  l = Math.hypot(s2x, s2y, s2z);
  // Pol-Richtung
  let px, py, pz;
  if (poleModelPos) { px = poleModelPos[0] - _A[0]; py = poleModelPos[1] - _A[1]; pz = poleModelPos[2] - _A[2]; } else { px = mx; py = my; pz = mz; }
  const pdt = px * tx + py * ty + pz * tz;
  let d2x = px - tx * pdt, d2y = py - ty * pdt, d2z = pz - tz * pdt;
  let l2 = Math.hypot(d2x, d2y, d2z);
  if (l < 1e-9) {
    // gestreckt: nur die Richtung zählt
    rotationTo(_Q, s1x, s1y, s1z, tx, ty, tz);
  } else {
    s2x /= l; s2y /= l; s2z /= l;
    if (l2 < 1e-6) {
      // Pol auf der Zielachse: aktuelle Ebene mitdrehen
      rotationTo(_Q, s1x, s1y, s1z, tx, ty, tz);
      rotVec(_v3, _Q, s2x, s2y, s2z);
      d2x = _v3[0]; d2y = _v3[1]; d2z = _v3[2];
      const k = d2x * tx + d2y * ty + d2z * tz; d2x -= tx * k; d2y -= ty * k; d2z -= tz * k; l2 = Math.hypot(d2x, d2y, d2z) || 1;
    }
    d2x /= l2; d2y /= l2; d2z /= l2;
    const s3x = s1y * s2z - s1z * s2y, s3y = s1z * s2x - s1x * s2z, s3z = s1x * s2y - s1y * s2x;
    const d3x = ty * d2z - tz * d2y, d3y = tz * d2x - tx * d2z, d3z = tx * d2y - ty * d2x;
    // Q = D * S^T  (Spalten von D: t, d2, d3; von S: s1, s2, s3), spaltenweise gespeichert
    _m9[0] = tx * s1x + d2x * s2x + d3x * s3x; _m9[1] = ty * s1x + d2y * s2x + d3y * s3x; _m9[2] = tz * s1x + d2z * s2x + d3z * s3x;
    _m9[3] = tx * s1y + d2x * s2y + d3x * s3y; _m9[4] = ty * s1y + d2y * s2y + d3y * s3y; _m9[5] = tz * s1y + d2z * s2y + d3z * s3y;
    _m9[6] = tx * s1z + d2x * s2z + d3x * s3z; _m9[7] = ty * s1z + d2y * s2z + d3y * s3z; _m9[8] = tz * s1z + d2z * s2z + d3z * s3z;
    quat.fromMat3(_Q, _m9); quat.normalize(_Q, _Q);
  }
  quat.multiply(_tq, _Q, _Ru);
  setModelRot(def, pose, iu, _tq);

  // Gewicht
  if (weight < 1) {
    slerpInto(R, 4 * iu, _origU, 0, R, 4 * iu, weight);
    slerpInto(R, 4 * il, _origL, 0, R, 4 * il, weight);
  }
  // Endrotation
  if (keepEnd || opts.endRot) setModelRot(def, pose, ie, keepEnd ? _endRot0 : opts.endRot);

  boneModelTransform(def, pose, ie, _tq, _E);
  res.distance = dist;
  res.error = Math.hypot(_E[0] - targetModelPos[0], _E[1] - targetModelPos[1], _E[2] - targetModelPos[2]);
  res.reached = res.error < 1e-3;
  return res;
}

/** Kurzform: limbIK(skel, pose, 'arm_r' | 'arm_l' | 'leg_r' | 'leg_l', target, pole, opts). */
export function limbIK(skel, pose, limb, target, pole = null, opts = {}) {
  const s = limb.slice(-2);
  if (limb.startsWith('arm')) return twoBoneIK(skel, pose, 'arm' + s, 'forearm' + s, 'hand' + s, target, pole, opts);
  return twoBoneIK(skel, pose, 'thigh' + s, 'shin' + s, 'foot' + s, target, pole, opts);
}

// ---------------------------------------------------------------------------- Ausrichten / Blick

const _aR = new Float32Array(4), _aP = new Float32Array(3), _aD = new Float32Array(4), _aN = new Float32Array(4), _aV = new Float32Array(3);

/**
 * Knochen so drehen, dass seine lokale Achse `axis` (Ruherahmen = Modellachsen, Standard [0,0,1] = vorn) vom
 * Punkt `offset` (lokal, Standard Gelenk) aus auf targetModelPos zeigt. Minimale Drehung (Swing).
 * opts: axis, offset, weight (0..1), maxAngle (rad, Standard π). Gibt den Restwinkel (rad) zurück.
 */
export function aimBone(skel, pose, bone, targetModelPos, opts = {}) {
  const def = defOf(skel), i = boneIdx(def, bone);
  const axis = opts.axis || AXIS_Z, off = opts.offset || null;
  const weight = opts.weight !== undefined ? opts.weight : 1, maxAngle = opts.maxAngle !== undefined ? opts.maxAngle : Math.PI;
  boneModelTransform(def, pose, i, _aR, _aP);
  let ox = _aP[0], oy = _aP[1], oz = _aP[2];
  if (off) { rotVec(_aV, _aR, off[0], off[1], off[2]); ox += _aV[0]; oy += _aV[1]; oz += _aV[2]; }
  rotVec(_aV, _aR, axis[0], axis[1], axis[2]);
  let cx = _aV[0], cy = _aV[1], cz = _aV[2];
  const cl = Math.hypot(cx, cy, cz) || 1; cx /= cl; cy /= cl; cz /= cl;
  let wx = targetModelPos[0] - ox, wy = targetModelPos[1] - oy, wz = targetModelPos[2] - oz;
  const wl = Math.hypot(wx, wy, wz); if (wl < 1e-9) return 0;
  wx /= wl; wy /= wl; wz /= wl;
  const full = Math.acos(clamp(cx * wx + cy * wy + cz * wz, -1, 1));
  rotationTo(_aD, cx, cy, cz, wx, wy, wz);
  limitQuat(_aD, maxAngle, weight);
  quat.multiply(_aN, _aD, _aR);
  setModelRot(def, pose, i, _aN);
  return Math.max(0, full - Math.min(full, maxAngle) * weight);
}
const AXIS_Z = [0, 0, 1];

const LOOK_BONES = ['spine', 'chest', 'neck', 'head'], LOOK_WEIGHTS = [0.1, 0.15, 0.3, 0.45];
const _lookTarget = new Float32Array(3), _lE = new Float32Array(3), _lF = new Float32Array(3);

/**
 * Blickausrichtung mit Verteilung über eine Kette (Standard spine/chest/neck/head mit 10/15/30/45 %).
 * targetModelPos im Modellraum. opts: bones, weights, eyeOffset (Kopf-lokal, Standard [0, 0.09, 0.09]),
 *   forward (Kopf-lokale Blickachse, [0,0,1]), weight (0..1), maxYaw (rad, 1.4), maxPitchUp (0.7), maxPitchDown (0.9).
 * Gierwinkel/Nickwinkel werden relativ zur Wurzel (Körperausrichtung) begrenzt.
 */
export function lookAt(skel, pose, targetModelPos, opts = {}) {
  const def = defOf(skel);
  const bones = opts.bones || LOOK_BONES, weights = opts.weights || LOOK_WEIGHTS;
  const weight = opts.weight !== undefined ? opts.weight : 1;
  if (weight <= 0) return;
  const eye = opts.eyeOffset || EYE_DEF, fwd = opts.forward || AXIS_Z;
  const head = boneIdx(def, bones[bones.length - 1]);
  // Ziel relativ zur Körperausrichtung begrenzen (Wurzelrahmen)
  boneModelTransform(def, pose, head, _aR, _aP);
  rotVec(_aV, _aR, eye[0], eye[1], eye[2]);
  _lE[0] = _aP[0] + _aV[0]; _lE[1] = _aP[1] + _aV[1]; _lE[2] = _aP[2] + _aV[2];
  boneModelTransform(def, pose, 0, _aN, _aV);
  let dx = targetModelPos[0] - _lE[0], dy = targetModelPos[1] - _lE[1], dz = targetModelPos[2] - _lE[2];
  const dl = Math.hypot(dx, dy, dz); if (dl < 1e-6) return;
  // in den Wurzelrahmen
  _aD[0] = -_aN[0]; _aD[1] = -_aN[1]; _aD[2] = -_aN[2]; _aD[3] = _aN[3];
  rotVec(_lF, _aD, dx / dl, dy / dl, dz / dl);
  let yaw = Math.atan2(_lF[0], _lF[2]), pitch = Math.asin(clamp(_lF[1], -1, 1));
  const maxYaw = opts.maxYaw !== undefined ? opts.maxYaw : 1.4;
  yaw = clamp(yaw, -maxYaw, maxYaw);
  pitch = clamp(pitch, -(opts.maxPitchDown !== undefined ? opts.maxPitchDown : 0.9), opts.maxPitchUp !== undefined ? opts.maxPitchUp : 0.7);
  const cp = Math.cos(pitch);
  rotVec(_lF, _aN, Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
  _lookTarget[0] = _lE[0] + _lF[0] * dl; _lookTarget[1] = _lE[1] + _lF[1] * dl; _lookTarget[2] = _lE[2] + _lF[2] * dl;
  // Verteilung: jeder Knochen übernimmt seinen Anteil der verbleibenden Drehung
  let rest = 0; for (let k = 0; k < bones.length; k++) rest += weights[k];
  for (let k = 0; k < bones.length; k++) {
    const i = def.index[bones[k]]; if (i === undefined) { rest -= weights[k]; continue; }
    const frac = rest > 1e-9 ? weights[k] / rest : 1;
    rest -= weights[k];
    // aktuelle Augenposition/Blickrichtung
    boneModelTransform(def, pose, head, _aR, _aP);
    rotVec(_aV, _aR, eye[0], eye[1], eye[2]);
    const ex = _aP[0] + _aV[0], ey = _aP[1] + _aV[1], ez = _aP[2] + _aV[2];
    rotVec(_aV, _aR, fwd[0], fwd[1], fwd[2]);
    let cx = _aV[0], cy = _aV[1], cz = _aV[2]; const cl = Math.hypot(cx, cy, cz) || 1; cx /= cl; cy /= cl; cz /= cl;
    let wx = _lookTarget[0] - ex, wy = _lookTarget[1] - ey, wz = _lookTarget[2] - ez;
    const wl = Math.hypot(wx, wy, wz) || 1; wx /= wl; wy /= wl; wz /= wl;
    rotationTo(_aD, cx, cy, cz, wx, wy, wz);
    limitQuat(_aD, Math.PI, frac * weight);
    boneModelTransform(def, pose, i, _aR, _aP);
    quat.multiply(_aN, _aD, _aR);
    setModelRot(def, pose, i, _aN);
  }
}
const EYE_DEF = [0, 0.09, 0.09];

// ---------------------------------------------------------------------------- Sekundärbewegung (Federkette)

/**
 * Feder-Kette für Schwanz, Ohren, Haarsträhnen: jede Knochenspitze ist ein Partikel, das per kritisch
 * gedämpfter Feder (damping = 1; < 1 schwingt nach) der animierten Spitzenposition folgt. Danach wird jeder
 * Knochen (Wurzel -> Spitze) zur Partikelposition gedreht. Mit `model` (mat4 Modell -> Welt) wird in Weltkoordinaten
 * simuliert, sodass Laufen/Drehen der Figur Nachschwingen erzeugt.
 *   const tail = new SpringChain(skel, ['tail_0', …, 'tail_5'], { frequency: 2.5, damping: 0.7, gravity: 2 });
 *   tail.update(pose, dt, modelMatrix);   // nach Animation/IK, vor skel.update(pose)
 * params: frequency (Hz, 3), damping (Dämpfungsgrad, 1 = kritisch), gravity (m/s², nach -Y, 0), falloff (Frequenz-
 *   Faktor je Glied, 0.85), maxAngle (rad, Abweichung von der Animation je Glied, 1.0), weight (0..1).
 */
export class SpringChain {
  constructor(skel, boneNames, params = {}) {
    const def = defOf(skel);
    this.def = def;
    this.idx = Int16Array.from(boneNames.map((b) => boneIdx(def, b)));
    for (let k = 1; k < this.idx.length; k++) {
      if (def.parents[this.idx[k]] !== this.idx[k - 1]) throw new Error(`SpringChain: "${boneNames[k]}" ist kein Kind von "${boneNames[k - 1]}"`);
    }
    const n = this.n = this.idx.length;
    this.params = params;
    this.pos = new Float64Array(3 * n); this.vel = new Float64Array(3 * n);
    this.tipLocal = new Float32Array(3 * n);
    for (let k = 0; k < n; k++) {
      const i = this.idx[k];
      for (let c = 0; c < 3; c++) this.tipLocal[3 * k + c] = def.tip[3 * i + c] - def.rest[3 * i + c];
    }
    this.initialized = false;
    this._inv = new Float32Array(16);
  }
  reset() { this.initialized = false; }
  update(pose, dt, model = null) {
    const def = this.def, P = this.params, n = this.n;
    const freq = P.frequency !== undefined ? P.frequency : 3, zeta = P.damping !== undefined ? P.damping : 1;
    const grav = P.gravity || 0, falloff = P.falloff !== undefined ? P.falloff : 0.85;
    const maxAngle = P.maxAngle !== undefined ? P.maxAngle : 1.0, weight = P.weight !== undefined ? P.weight : 1;
    const teleport = !this.initialized || dt > 0.25 || dt <= 0;
    let inv = null;
    if (model) { inv = this._inv; invertAffine(inv, model); }
    // Startrahmen: Eltern des ersten Glieds
    const p0 = def.parents[this.idx[0]];
    if (p0 >= 0) boneModelTransform(def, pose, p0, _sR, _sJ); else { _sR[0] = _sR[1] = _sR[2] = 0; _sR[3] = 1; _sJ[0] = _sJ[1] = _sJ[2] = 0; }
    for (let k = 0; k < n; k++) {
      const i = this.idx[k];
      // Gelenkposition dieses Glieds (Modellraum) aus korrigiertem Elternrahmen
      rotVec(_sV, _sR, def.offset[3 * i] + pose.t[3 * i], def.offset[3 * i + 1] + pose.t[3 * i + 1], def.offset[3 * i + 2] + pose.t[3 * i + 2]);
      const jx = _sJ[0] + _sV[0], jy = _sJ[1] + _sV[1], jz = _sJ[2] + _sV[2];
      // animierte Modell-Rotation und Zielspitze
      _sL[0] = pose.rot[4 * i]; _sL[1] = pose.rot[4 * i + 1]; _sL[2] = pose.rot[4 * i + 2]; _sL[3] = pose.rot[4 * i + 3];
      quat.multiply(_sM, _sR, _sL);
      rotVec(_sV, _sM, this.tipLocal[3 * k], this.tipLocal[3 * k + 1], this.tipLocal[3 * k + 2]);
      const len = Math.hypot(_sV[0], _sV[1], _sV[2]) || 1e-6;
      let gx = jx + _sV[0], gy = jy + _sV[1], gz = jz + _sV[2];
      let Jx = jx, Jy = jy, Jz = jz;
      if (model) { xf(_sW, model, gx, gy, gz); gx = _sW[0]; gy = _sW[1]; gz = _sW[2]; xf(_sW, model, jx, jy, jz); Jx = _sW[0]; Jy = _sW[1]; Jz = _sW[2]; }
      const o = 3 * k, X = this.pos, V = this.vel;
      if (teleport) { X[o] = gx; X[o + 1] = gy; X[o + 2] = gz; V[o] = V[o + 1] = V[o + 2] = 0; }
      else {
        const w = 2 * Math.PI * freq * Math.pow(falloff, k);
        const steps = Math.max(1, Math.ceil(dt * w * 2));
        const h = dt / steps;
        for (let s = 0; s < steps; s++) {
          for (let c = 0; c < 3; c++) {
            const tgt = c === 0 ? gx : c === 1 ? gy : gz;
            const acc = w * w * (tgt - X[o + c]) - 2 * zeta * w * V[o + c] - (c === 1 ? grav : 0);
            V[o + c] += acc * h; X[o + c] += V[o + c] * h;
          }
        }
        // Länge erhalten
        let dx = X[o] - Jx, dy = X[o + 1] - Jy, dz = X[o + 2] - Jz;
        const dl = Math.hypot(dx, dy, dz) || 1e-9;
        const ls = len / dl; X[o] = Jx + dx * ls; X[o + 1] = Jy + dy * ls; X[o + 2] = Jz + dz * ls;
      }
      // simulierte Richtung im Modellraum
      let sx = X[o], sy = X[o + 1], sz = X[o + 2];
      if (model) { xf(_sW, inv, sx, sy, sz); sx = _sW[0]; sy = _sW[1]; sz = _sW[2]; }
      let ddx = sx - jx, ddy = sy - jy, ddz = sz - jz;
      const ddl = Math.hypot(ddx, ddy, ddz) || 1e-9; ddx /= ddl; ddy /= ddl; ddz /= ddl;
      const ax = _sV[0] / len, ay = _sV[1] / len, az = _sV[2] / len;
      rotationTo(_sD, ax, ay, az, ddx, ddy, ddz);
      limitQuat(_sD, maxAngle, weight);
      quat.multiply(_sN, _sD, _sM);
      // lokal = R_parent^-1 * neu
      _sI[0] = -_sR[0]; _sI[1] = -_sR[1]; _sI[2] = -_sR[2]; _sI[3] = _sR[3];
      quat.multiply(_sL, _sI, _sN); quat.normalize(_sL, _sL);
      pose.rot[4 * i] = _sL[0]; pose.rot[4 * i + 1] = _sL[1]; pose.rot[4 * i + 2] = _sL[2]; pose.rot[4 * i + 3] = _sL[3];
      // Rahmen für das nächste Glied
      _sR[0] = _sN[0]; _sR[1] = _sN[1]; _sR[2] = _sN[2]; _sR[3] = _sN[3];
      _sJ[0] = jx; _sJ[1] = jy; _sJ[2] = jz;
    }
    this.initialized = true;
    return pose;
  }
}
const _sR = new Float32Array(4), _sJ = new Float64Array(3), _sV = new Float32Array(3), _sL = new Float32Array(4), _sM = new Float32Array(4);
const _sN = new Float32Array(4), _sD = new Float32Array(4), _sI = new Float32Array(4), _sW = new Float64Array(3);
function xf(o, m, x, y, z) { o[0] = m[0] * x + m[4] * y + m[8] * z + m[12]; o[1] = m[1] * x + m[5] * y + m[9] * z + m[13]; o[2] = m[2] * x + m[6] * y + m[10] * z + m[14]; return o; }
/** Inverse einer affinen Matrix (Rotation * Skalierung + Translation). */
function invertAffine(o, m) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a10 = m[4], a11 = m[5], a12 = m[6], a20 = m[8], a21 = m[9], a22 = m[10];
  const b01 = a22 * a11 - a12 * a21, b11 = -a22 * a10 + a12 * a20, b21 = a21 * a10 - a11 * a20;
  let det = a00 * b01 + a01 * b11 + a02 * b21; det = det ? 1 / det : 0;
  o[0] = b01 * det; o[1] = (-a22 * a01 + a02 * a21) * det; o[2] = (a12 * a01 - a02 * a11) * det; o[3] = 0;
  o[4] = b11 * det; o[5] = (a22 * a00 - a02 * a20) * det; o[6] = (-a12 * a00 + a02 * a10) * det; o[7] = 0;
  o[8] = b21 * det; o[9] = (-a21 * a00 + a01 * a20) * det; o[10] = (a11 * a00 - a01 * a10) * det; o[11] = 0;
  const tx = m[12], ty = m[13], tz = m[14];
  o[12] = -(o[0] * tx + o[4] * ty + o[8] * tz); o[13] = -(o[1] * tx + o[5] * ty + o[9] * tz); o[14] = -(o[2] * tx + o[6] * ty + o[10] * tz); o[15] = 1;
  return o;
}

/**
 * Funktionsform: springChain(skel, pose, ['tail_0', …], dt, params). `params` dient zugleich als Zustandsträger
 * (dasselbe Objekt jedes Frame übergeben; die Kette wird beim ersten Aufruf als params._chain angelegt).
 * params.model (mat4) optional für Weltraum-Simulation. Siehe SpringChain für alle Parameter.
 */
export function springChain(skel, pose, boneNames, dt, params = {}) {
  let ch = params._chain;
  if (!ch || ch.def !== defOf(skel)) ch = params._chain = new SpringChain(skel, boneNames, params);
  ch.params = params;
  return ch.update(pose, dt, params.model || null);
}

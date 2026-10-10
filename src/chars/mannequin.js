// Generische Test-Gliederpuppe (Mannequin) aus SDF-Primitiven – für Rig-/Animationstests und als
// Referenz, wie man eine Figur mit sdf.js modelliert. Passt sich an beliebige humanoide Gelenkpositionen an.
//
//   const { skeletonDef, mesh } = buildMannequin({ cell: 0.008 });
//   // mesh.data[0] = Material-ID (MANNEQUIN_MATS), mesh.colors = lineare Vertexfarben

import { createSculpt, P, polygonize, alignQuat, along } from '../gfx/sdf.js';
import { defineSkeleton, HUMANOID_DEFAULT_JOINTS } from './skeleton.js';

export const MANNEQUIN_MATS = Object.freeze({ SKIN: 0, SHIRT: 1, SHORTS: 2, SHOES: 3, EYES: 4, HAIR: 5 });
const COL = { skin: '#e3b08e', shirt: '#8fcdf2', shorts: '#f2f2ee', shoes: '#fbfbfb', sole: '#9aa3ab', eyes: '#1d1a1a', hair: '#2b1d16', sock: '#ffffff' };

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const nrm = (a) => scl(a, 1 / (len(a) || 1));

/**
 * Sculpt einer humanoiden Puppe für die gegebenen Gelenke (Modellraum, A-Pose).
 * Nur die linke Seite wird modelliert, die rechte entsteht per mirror (Gelenke sollten symmetrisch sein).
 * @param {object} J  Gelenke (wie HUMANOID_DEFAULT_JOINTS)
 * @param {object} [o] { colors: {skin, shirt, shorts, shoes, eyes, hair}, hair: true }
 */
export function buildMannequinSculpt(J = HUMANOID_DEFAULT_JOINTS, o = {}) {
  const C = { ...COL, ...(o.colors || {}) };
  const M = MANNEQUIN_MATS;
  const H = J.head, N = J.neck, CH = J.chest, SP = J.spine, PE = J.pelvis;
  const s = (J.head[1] + 0.195) / 1.80; // Größenfaktor (1 bei 1.80 m)
  const S = createSculpt({ blend: 0.02 * s, skinBlend: 0.045 * s });

  // ---- Kopf
  S.with({ bone: 'head', mat: M.SKIN, color: C.skin, skinBlend: 0.03 * s }, () => {
    const hc = add(H, [0, 0.095 * s, 0.005 * s]);
    S.add(P.ellipsoid(hc, [0.083 * s, 0.1 * s, 0.097 * s]));
    S.add(P.ellipsoid(add(H, [0, 0.04 * s, 0.03 * s]), [0.066 * s, 0.07 * s, 0.075 * s]), { blend: 0.035 * s });
    S.add(P.sphere(add(H, [0, 0.0 * s, 0.065 * s]), 0.03 * s), { blend: 0.03 * s }); // Kinn
    S.add(P.capsule(add(H, [0, 0.083 * s, 0.093 * s]), add(H, [0, 0.058 * s, 0.108 * s]), 0.0115 * s), { blend: 0.012 * s }); // Nase
    S.add(P.ellipsoid(add(H, [0.083 * s, 0.075 * s, -0.005 * s]), [0.011 * s, 0.028 * s, 0.019 * s], [0, -15, 0]), { blend: 0.01 * s, mirror: true }); // Ohren
    // aufgemalte Augen
    S.add(P.sphere(add(H, [0.031 * s, 0.098 * s, 0.083 * s]), 0.0125 * s), { color: C.eyes, mat: M.EYES, blend: 0.004 * s, colorBlend: 0.001, mirror: true });
    if (o.hair !== false) {
      // Haarkappe: Ellipsoid, unten/vorn abgeschnitten
      S.group({ color: C.hair, mat: M.HAIR, blend: 0.006 * s, colorBlend: 0.002 }, (g) => {
        g.add(P.ellipsoid(add(hc, [0, 0.012 * s, -0.008 * s]), [0.089 * s, 0.1 * s, 0.1 * s]));
        g.intersect(P.plane(add(hc, [0, 0.015 * s, 0]), [0, -0.55, 0.9]), { blend: 0.01 * s });
      });
    }
  });
  // ---- Hals
  S.add(P.capsule(add(N, [0, -0.02 * s, 0.0]), add(H, [0, 0.03 * s, 0]), 0.047 * s), { bone: 'neck', mat: M.SKIN, color: C.skin, blend: 0.03 * s, skinBlend: 0.04 * s });

  // ---- Rumpf (Shirt)
  S.with({ mat: M.SHIRT, color: C.shirt, blend: 0.05 * s, skinBlend: 0.07 * s }, () => {
    S.add(P.ellipsoid(add(CH, [0, 0.065 * s, 0.005 * s]), [0.155 * s, 0.165 * s, 0.105 * s]), { bone: 'chest' });
    S.add(P.capsule(add(CH, [-0.12 * s, 0.155 * s, -0.01 * s]), add(CH, [0.12 * s, 0.155 * s, -0.01 * s]), 0.06 * s), { bone: 'chest', blend: 0.06 * s });
    S.add(P.ellipsoid(add(SP, [0, 0.035 * s, 0.015 * s]), [0.135 * s, 0.13 * s, 0.098 * s]), { bone: 'spine' });
  });
  // Schlüsselbein/Trapez
  S.add(P.capsule(add(J.shoulder_l, [0, 0, -0.005 * s]), add(J.arm_l, [-0.02 * s, 0.012 * s, 0]), 0.05 * s), { bone: 'shoulder_l', mat: M.SHIRT, color: C.shirt, blend: 0.04 * s, skinBlend: 0.05 * s, mirror: true });

  // ---- Becken (Shorts)
  S.with({ mat: M.SHORTS, color: C.shorts, blend: 0.045 * s, skinBlend: 0.06 * s }, () => {
    S.add(P.ellipsoid(add(PE, [0, 0.015 * s, 0.0]), [0.15 * s, 0.11 * s, 0.1 * s]), { bone: 'pelvis' });
    S.add(P.sphere(add(J.thigh_l, [-0.025 * s, 0.0, -0.06 * s]), 0.085 * s), { bone: { pelvis: 1, thigh_l: 0.45 }, mirror: true }); // Gesäß
  });

  // ---- Arme
  for (const m of [false, true]) {
    const b = m ? S.mirrored.bind(S) : (fn) => fn(S);
    b((B) => {
      const A = J.arm_l, F = J.forearm_l, Hd = J.hand_l;
      const da = nrm(sub(F, A)), df = nrm(sub(Hd, F));
      // Schulter (Deltamuskel) + Ärmel
      B.add(P.sphere(add(A, [0.005 * s, 0.0, 0]), 0.058 * s), { bone: 'arm_l', mat: M.SHIRT, color: C.shirt, blend: 0.04 * s, skinBlend: 0.05 * s });
      B.add(P.roundCone(A, along(A, F, 0.45), 0.062 * s, 0.054 * s), { bone: 'arm_l', mat: M.SHIRT, color: C.shirt, blend: 0.01 * s, skinBlend: 0.04 * s });
      // Oberarm, Unterarm (Haut)
      B.add(P.roundCone(A, F, 0.05 * s, 0.038 * s), { bone: 'arm_l', mat: M.SKIN, color: C.skin, blend: 0.02 * s, skinBlend: 0.035 * s });
      B.add(P.ellipsoid(along(A, F, 0.45, scl(da, 0)), [0.042 * s, 0.1 * s, 0.045 * s], alignQuat(da, [0, 0, 1])), { bone: 'arm_l', mat: M.SKIN, color: C.skin, blend: 0.02 * s });
      B.add(P.roundCone(F, Hd, 0.038 * s, 0.026 * s), { bone: 'forearm_l', mat: M.SKIN, color: C.skin, blend: 0.025 * s, skinBlend: 0.035 * s });
      B.add(P.ellipsoid(along(F, Hd, 0.28), [0.04 * s, 0.085 * s, 0.035 * s], alignQuat(df, [0, 0, 1])), { bone: 'forearm_l', mat: M.SKIN, color: C.skin, blend: 0.025 * s });
      // Hand: Handfläche als Ellipsoid (Handfläche zeigt zum Körper), Daumen als Kapsel
      const palmN = nrm([-1, 0, 0]); // medial (für die linke Hand)
      const zh = nrm(sub([0, 0, 1], scl(df, df[2])));
      const hc = add(Hd, scl(df, 0.045 * s));
      B.add(P.ellipsoid(hc, [0.02 * s, 0.05 * s, 0.043 * s], alignQuat(df, zh)), { bone: 'hand_l', mat: M.SKIN, color: C.skin, blend: 0.02 * s, skinBlend: 0.025 * s });
      B.add(P.capsule(add(Hd, add(scl(zh, 0.03 * s), scl(palmN, 0.005 * s))), add(Hd, add(add(scl(df, 0.06 * s), scl(zh, 0.05 * s)), scl(palmN, 0.012 * s))), 0.012 * s), { bone: 'hand_l', mat: M.SKIN, color: C.skin, blend: 0.012 * s, skinBlend: 0.02 * s });
    });
  }

  // ---- Beine
  for (const m of [false, true]) {
    const b = m ? S.mirrored.bind(S) : (fn) => fn(S);
    b((B) => {
      const T = J.thigh_l, K = J.shin_l, Fo = J.foot_l, To = J.toe_l;
      const dt = nrm(sub(K, T)), dsn = nrm(sub(Fo, K));
      // Shorts-Bein
      B.add(P.roundCone(add(T, [0, 0.02 * s, 0]), along(T, K, 0.5), 0.098 * s, 0.078 * s), { bone: 'thigh_l', mat: M.SHORTS, color: C.shorts, blend: 0.04 * s, skinBlend: 0.06 * s });
      // Oberschenkel, Knie, Wade, Schienbein (Haut)
      B.add(P.roundCone(T, K, 0.085 * s, 0.052 * s), { bone: 'thigh_l', mat: M.SKIN, color: C.skin, blend: 0.03 * s, skinBlend: 0.045 * s });
      B.add(P.ellipsoid(along(T, K, 0.4, [0.0, 0, 0.01 * s]), [0.075 * s, 0.15 * s, 0.075 * s], alignQuat(dt, [0, 0, 1])), { bone: 'thigh_l', mat: M.SKIN, color: C.skin, blend: 0.03 * s });
      B.add(P.sphere(add(K, [0, 0.005 * s, 0.022 * s]), 0.045 * s), { bone: 'shin_l', mat: M.SKIN, color: C.skin, blend: 0.03 * s, skinBlend: 0.04 * s });
      B.add(P.roundCone(K, Fo, 0.05 * s, 0.033 * s), { bone: 'shin_l', mat: M.SKIN, color: C.skin, blend: 0.02 * s, skinBlend: 0.04 * s });
      B.add(P.ellipsoid(along(K, Fo, 0.3, [0, 0, -0.02 * s]), [0.05 * s, 0.11 * s, 0.05 * s], alignQuat(dsn, [0, 0, 1])), { bone: 'shin_l', mat: M.SKIN, color: C.skin, blend: 0.03 * s });
      // Socke
      B.add(P.roundCone(along(K, Fo, 0.78), add(Fo, [0, 0.01 * s, 0]), 0.037 * s, 0.038 * s), { bone: 'shin_l', mat: M.SHORTS, color: C.sock, blend: 0.006 * s, colorBlend: 0.002, skinBlend: 0.03 * s });
      // Schuh (Gruppe, unten flach)
      B.group({ mat: M.SHOES, color: C.shoes, blend: 0.004 * s, colorBlend: 0.003 }, (g) => {
        const heel = add(Fo, [0, -0.04 * s, -0.045 * s]);
        g.add(P.roundBox(add(Fo, [0.003 * s, -0.022 * s, 0.035 * s]), [0.047 * s, 0.06 * s, 0.1 * s], 0.04 * s), { bone: 'foot_l', skinBlend: 0.02 * s, blend: 0.02 * s });
        g.add(P.sphere(heel, 0.045 * s), { bone: 'foot_l', skinBlend: 0.02 * s, blend: 0.03 * s });
        g.add(P.roundBox(add(To, [0.004 * s, 0.006 * s, 0.03 * s]), [0.046 * s, 0.03 * s, 0.055 * s], 0.028 * s), { bone: 'toe_l', skinBlend: 0.025 * s, blend: 0.03 * s });
        g.intersect(P.plane([0, 0.0, 0], [0, -1, 0]), { blend: 0.004 * s });
        // Sohlenstreifen
        g.paint(P.box([Fo[0] + 0.003 * s, 0.0, Fo[2] + 0.04 * s], [0.07 * s, 0.012 * s, 0.2 * s]), { color: C.sole, colorBlend: 0.002 });
      });
    });
  }
  return S;
}

/**
 * Fertige Puppe: Skelett-Definition + polygonisiertes, geskinntes Mesh.
 * @param {object} [o] { joints, cell (0.008), colors, polygonize: {...zusätzliche polygonize-Optionen} }
 */
export function buildMannequin(o = {}) {
  const joints = o.joints || HUMANOID_DEFAULT_JOINTS;
  const skeletonDef = defineSkeleton({ joints, tips: o.tips });
  const sculpt = buildMannequinSculpt(joints, o);
  const mesh = polygonize(sculpt, { cell: o.cell || 0.008, skeleton: skeletonDef, ...(o.polygonize || {}) });
  return { skeletonDef, sculpt, mesh };
}

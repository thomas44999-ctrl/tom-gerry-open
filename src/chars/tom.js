// Tom – Chibi-Tennisspieler im Stil von Mario Tennis: großer runder Kopf (~1/3 der Körpergröße), große ovale
// Augen, Knubbelnase, offenes Lächeln, braune Haartolle, runder Polo-Körper, kurze Arme und Beine, große Hände
// und Sneaker. Komplett aus SDF-Primitiven modelliert (sdf.js).
// ARCHITECTURE §5.4:  buildTom(renderer, q) -> CharacterAsset
//
// Aufbau
//   parts (geskinnt, gemeinsames Material 'tom-body', Material-ID in data[0] = TOM_MAT):
//     body – Polo, Shorts, Arme, Beine, Socken, Schuhe, Hände (rechte Hand = Faust um den Schlägergriff)
//     head – Kopf, Hals, Haare, Ohren, Nase, Mund (feineres Raster)
//   attachments (starr am Kopf): eye_l/eye_r (Augapfel, oval skaliert), lid_l/lid_r (Oberlider), brow_l/brow_r.
//
// gripSocket: { bone:'hand_r', offset, rotation, matrix }
//   Schläger-Weltmatrix = charModel * skel.world[hand_r] * gripSocket.matrix
//   Schlägerrahmen in der Hand: +Y (Schaft) = Daumenrichtung der Faust, +Z (Saitennormale) = Handflächennormale.
// face.update(dt, { blink, mood, lookDir }): blink 0..1 (undefined -> automatisch), mood 'neutral'|'happy'|'focused'|'sad',
//   lookDir = Blickrichtung im Kopf-Knochenraum (+Z = geradeaus) oder null.

import { createSculpt, P, polygonize, alignQuat, along } from '../gfx/sdf.js';
import { defineSkeleton } from './skeleton.js';
import { mat4, quat, hexToLinear, clamp, smoothstep, DEG } from '../core/math.js';

/** Material-IDs (data[0]) des Körper-Materials. */
export const TOM_MAT = Object.freeze({
  SKIN: 0, SHIRT: 1, SHORTS: 2, SHOE: 3, SOLE: 4, HAIR: 5, SOCK: 6, TONGUE: 7, WRIST: 8, TRIM: 9,
  BROW: 10, LASH: 11, MOUTH: 12, TEETH: 13, COLLAR: 14,
});

/** Farbpalette (sRGB). */
export const TOM_COLORS = Object.freeze({
  skin: '#f6c6a2', blush: '#f4a493', nose: '#f3b593', mouth: '#7a2a2a', tongue: '#e8707a', teeth: '#fbfaf6',
  shirt: '#7cc6f6', trim: '#ffffff', shorts: '#f7f7f3', stripe: '#59aee8',
  sock: '#fbfbf8', shoe: '#fbfbf9', sole: '#2a3d6b', navy: '#24386e',
  hair: '#6b3a1c', brow: '#4a2612', lash: '#2a160c', wrist: '#ffffff',
  iris: '#5a3014', irisLight: '#b8742e', sclera: '#fdfcf8',
});

/** Körpergröße (Scheitel inkl. Haartolle), m. */
export const TOM_HEIGHT = 1.34;

const mirrorX = (p) => [-p[0], p[1], p[2]];
const LEFT = {
  shoulder_l: [0.035, 0.80, -0.012], arm_l: [0.155, 0.785, -0.015], forearm_l: [0.268, 0.655, 0.0], hand_l: [0.362, 0.535, 0.035],
  thigh_l: [0.082, 0.465, 0.0], shin_l: [0.086, 0.272, 0.012], foot_l: [0.088, 0.088, -0.022], toe_l: [0.092, 0.028, 0.085],
};
/** Gelenke (Modellraum, A-Pose, Blick +Z, links = +X). */
export const TOM_JOINTS = Object.freeze({
  root: [0, 0, 0], pelvis: [0, 0.5, -0.005], spine: [0, 0.585, -0.01], chest: [0, 0.70, -0.015],
  neck: [0, 0.835, -0.02], head: [0, 0.875, -0.01],
  ...LEFT,
  ...Object.fromEntries(Object.entries(LEFT).map(([k, v]) => [k.replace(/_l$/, '_r'), mirrorX(v)])),
});
const TOM_TIPS = Object.freeze({
  head: [0, 1.30, 0.0],
  hand_l: [0.41, 0.472, 0.062], hand_r: [-0.41, 0.472, 0.062],
  toe_l: [0.094, 0.024, 0.16], toe_r: [-0.094, 0.024, 0.16],
});

/** Kopfkugel (Modellraum): Mitte und Halbachsen. */
const HEAD = Object.freeze({ c: [0, 1.05, 0.008], r: [0.2, 0.188, 0.19] });
/** Auge (links; Kopfraum relativ zu HEAD.c): Mitte, Halbachsen des Augapfels, Drehung nach außen (Grad). */
const EYE = Object.freeze({ c: [0.066, -0.004, 0.158], r: [0.044, 0.06, 0.031], yaw: 17, irisYaw: 1.0 });

// ---------------------------------------------------------------------------- Vektor-Helfer
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const nrm = (a) => scl(a, 1 / (len(a) || 1));
/** p + v1*s1 + v2*s2 + … */
function mad(p, ...vs) {
  const o = [p[0], p[1], p[2]];
  for (let i = 0; i < vs.length; i += 2) { const v = vs[i], s = vs[i + 1]; o[0] += v[0] * s; o[1] += v[1] * s; o[2] += v[2] * s; }
  return o;
}
const lin = (hex) => { const c = hexToLinear(hex); return [c[0], c[1], c[2]]; };
/** Kopfraum -> Modellraum. */
const hp = (x, y, z) => [HEAD.c[0] + x, HEAD.c[1] + y, HEAD.c[2] + z];
/** Ellipsoid-Abstand (Näherung, für custom-SDFs). */
function ellDist(x, y, z, r) {
  const k0 = Math.hypot(x / r[0], y / r[1], z / r[2]);
  const k1 = Math.hypot(x / (r[0] * r[0]), y / (r[1] * r[1]), z / (r[2] * r[2])) || 1e-9;
  return k0 * (k0 - 1) / k1;
}

// ---------------------------------------------------------------------------- Anker / Maße
/**
 * Handrahmen in Ruhe (Modellraum): d = Handrichtung (Handgelenk -> Fingerspitzen), n = Handflächennormale
 * (zur Körpermitte), t = Daumenrichtung (vorn). Für beide Seiten zeigt t nach vorn-oben.
 */
function handFrame(J, side) {
  const W = J['hand_' + side], tip = TOM_TIPS['hand_' + side];
  const d = nrm(sub(tip, W));
  const s = side === 'l' ? 1 : -1;
  let n = [-s, 0, 0];
  n = nrm(sub(n, scl(d, dot(n, d))));
  const t = side === 'r' ? nrm(cross(d, n)) : nrm(cross(n, d));
  return { W, d, n, t };
}

function computeAnchors(J) {
  const hr = handFrame(J, 'r'), hl = handFrame(J, 'l');
  return {
    H: J.head, hr, hl, handleR: 0.0145,
    // Faustmitte = Griffachse (Schlägergriff läuft entlang t durch die Faust)
    grip: mad(hr.W, hr.d, 0.056, hr.n, 0.006),
    leftGrip: mad(hl.W, hl.d, 0.056, hl.n, 0.006),
    eyeL: hp(EYE.c[0], EYE.c[1], EYE.c[2]),
    // Oberlid: Kantenwinkel (Grad über dem Augenäquator) offen / geschlossen
    lidOpen: 80, lidClosed: -14,
  };
}

// ============================================================================ Körper
function sculptBody(J, A, C) {
  const M = TOM_MAT;
  const S = createSculpt({ blend: 0.02, skinBlend: 0.045 });

  // ---- Polo: runder Rumpf (Brust + Bauch), Saum über den Shorts, weißer Kragen
  S.group({ name: 'polo', mat: M.SHIRT, color: C.shirt, blend: 0.012, childBlend: 0.06, skinBlend: 0.08 }, (g) => {
    g.add(P.ellipsoid([0, 0.67, -0.008], [0.168, 0.15, 0.132]), { bone: 'chest' });
    g.add(P.ellipsoid([0, 0.57, 0.004], [0.178, 0.12, 0.142]), { bone: 'spine' });
    g.add(P.capsule([-0.105, 0.772, -0.014], [0.105, 0.772, -0.014], 0.058), { bone: 'chest' });
    g.intersect(P.plane([0, 0.505, 0], [0, -1, 0.05]), { blend: 0.008 });
  });
  // Kragen (weiß): flacher Ring um den Halsansatz, vorn offen
  S.add(P.custom((x, y, z) => {
    const cx = x, cy = y - 0.818, cz = z + 0.016;
    const r = Math.hypot(cx / 1.08, cz);
    const d = Math.hypot(r - 0.074, cy * 1.3) - 0.019;
    const a = Math.abs(Math.atan2(cx, cz)) / DEG;
    return Math.max(d, (16 - a) * DEG * 0.07);
  }, [-0.12, 0.78, -0.12], [0.12, 0.86, 0.1]), { bone: 'chest', mat: M.COLLAR, color: C.trim, blend: 0.004, colorBlend: 0.002, skinBlend: 0.06 });

  // ---- Ärmel (Polo, leicht gebauscht) + weiße Saumblende
  const Ar = J.arm_l, F = J.forearm_l, Hd = J.hand_l;
  const da = nrm(sub(F, Ar));
  const hem = along(Ar, F, 0.56);
  S.group({ name: 'sleeve', mat: M.SHIRT, color: C.shirt, bone: { arm_l: 1, shoulder_l: 0.25 }, blend: 0.03, childBlend: 0.02, skinBlend: 0.05, mirror: true }, (g) => {
    g.add(P.ellipsoid(along(Ar, F, 0.12), [0.064, 0.07, 0.064], alignQuat(da)));
    g.add(P.roundCone(add(Ar, scl(da, -0.01)), hem, 0.062, 0.058));
    g.intersect(P.plane(hem, da), { blend: 0.004 });
  });
  S.add(P.torus(along(Ar, F, 0.545), 0.056, 0.0095, alignQuat(da)), { bone: 'arm_l', mat: M.TRIM, color: C.trim, blend: 0.004, colorBlend: 0.002, mirror: true });

  // ---- Arme (Haut): kurz und rundlich
  S.with({ mat: M.SKIN, color: C.skin }, () => {
    S.add(P.roundCone(Ar, F, 0.043, 0.037), { bone: 'arm_l', blend: 0.02, mirror: true });
    S.add(P.sphere(F, 0.038), { bone: 'forearm_l', blend: 0.02, mirror: true });
    S.add(P.roundCone(F, along(F, Hd, 0.92), 0.038, 0.034), { bone: 'forearm_l', blend: 0.02, mirror: true });
  });
  // Schweißband rechts (weißes Frottee)
  S.add(P.cylinder(along(J.forearm_r, J.hand_r, 0.66), along(J.forearm_r, J.hand_r, 0.97), 0.043, 0.01),
    { bone: 'forearm_r', mat: M.WRIST, color: C.wrist, blend: 0.003, colorBlend: 0.001, skinBlend: 0.03 });

  // ---- Shorts (weiß, hellblauer Seitenstreifen im Shader)
  const T = J.thigh_l, K = J.shin_l, Fo = J.foot_l;
  const dt = nrm(sub(K, T));
  S.group({ name: 'shorts', mat: M.SHORTS, color: C.shorts, blend: 0.01, childBlend: 0.035, skinBlend: 0.06 }, (g) => {
    g.add(P.ellipsoid([0, 0.5, -0.01], [0.158, 0.088, 0.124]), { bone: 'pelvis' });
    g.add(P.ellipsoid([0, 0.448, -0.004], [0.09, 0.05, 0.085]), { bone: 'pelvis' });
    g.group({ bone: 'thigh_l', childBlend: 0.02, blend: 0.012, mirror: true }, (gg) => {
      gg.add(P.roundCone(add(T, [0.008, 0.02, -0.004]), along(T, K, 0.5), 0.074, 0.07));
      gg.intersect(P.plane(along(T, K, 0.44), dt), { blend: 0.004 });
    });
  });

  // ---- Beine (Haut): kurz und stämmig
  S.with({ mat: M.SKIN, color: C.skin }, () => {
    S.add(P.roundCone(add(T, [0, -0.04, 0]), K, 0.054, 0.045), { bone: 'thigh_l', blend: 0.02, skinBlend: 0.05, mirror: true });
    S.add(P.sphere(add(K, [0, 0.0, 0.006]), 0.045), { bone: 'shin_l', blend: 0.02, skinBlend: 0.04, mirror: true });
    S.add(P.roundCone(K, add(Fo, [0, 0.03, 0.0]), 0.045, 0.036), { bone: 'shin_l', blend: 0.02, skinBlend: 0.045, mirror: true });
  });
  return S;
}

// ============================================================================ Füße: Socken + große Sneaker
function sculptFeet(J, A, C) {
  const M = TOM_MAT;
  const S = createSculpt({ blend: 0.008, skinBlend: 0.02 });
  const K = J.shin_l, Fo = J.foot_l;
  const ds = nrm(sub(Fo, K));
  // ---- Socke: weiß, oben Bündchen mit blauem Ring (Shader); steckt unten im Schuh
  const sockTop = along(K, Fo, 0.42);
  S.group({ name: 'sock', mat: M.SOCK, color: C.sock, bone: 'shin_l', blend: 0.0, childBlend: 0.02, skinBlend: 0.04, mirror: true }, (g) => {
    g.add(P.roundCone(add(K, [0, -0.02, 0]), add(Fo, [0, 0.02, -0.004]), 0.049, 0.04));
    g.add(P.ellipsoid(add(Fo, [0, -0.01, 0.01]), [0.042, 0.04, 0.05]), { bone: 'foot_l' });
    g.intersect(P.plane(sockTop, scl(ds, -1)), { blend: 0.004 });
  });
  S.add(P.torus(along(K, Fo, 0.44), 0.049, 0.0065, alignQuat(scl(ds, -1))), { bone: 'shin_l', mat: M.SOCK, color: C.sock, blend: 0.004, mirror: true });
  // ---- Schuh: dicke runde Kappe, hohe Ferse; weißes Obermaterial, Einstieg ausgespart
  const cx = Fo[0] + 0.003;
  S.group({ name: 'shoe', mat: M.SHOE, color: C.shoe, bone: 'foot_l', blend: 0.0, childBlend: 0.035, skinBlend: 0.02, mirror: true }, (g) => {
    g.add(P.ellipsoid([cx, 0.07, -0.038], [0.058, 0.058, 0.062]));                                          // Ferse/Schaft
    g.add(P.ellipsoid([cx + 0.002, 0.055, 0.062], [0.064, 0.05, 0.094]), { bone: { foot_l: 0.45, toe_l: 0.55 } }); // Vorderfuß
    g.add(P.ellipsoid([cx + 0.002, 0.05, 0.118], [0.056, 0.042, 0.05]), { bone: 'toe_l' });                  // Zehenkappe
    g.subtract(P.ellipsoid([cx, 0.128, -0.03], [0.04, 0.04, 0.045]), { blend: 0.008 });                       // Einstieg
    g.intersect(P.plane([0, 0.022, 0], [0, -1, 0]), { blend: 0.006 });
  });
  // Zunge
  S.add(P.capsule([cx, 0.098, 0.03], [cx, 0.124, -0.002], 0.016), { bone: 'foot_l', mat: M.SHOE, color: C.shoe, blend: 0.012, mirror: true });
  // ---- Sohle (dunkelblau, umlaufend)
  S.group({ name: 'sole', mat: M.SOLE, color: C.sole, bone: 'foot_l', blend: 0.004, childBlend: 0.02, skinBlend: 0.02, mirror: true }, (g) => {
    g.add(P.ellipsoid([cx + 0.001, 0.016, 0.03], [0.068, 0.024, 0.142]), { bone: { foot_l: 0.6, toe_l: 0.4 } });
    g.intersect(P.plane([0, 0.0, 0], [0, -1, 0]), { blend: 0.004 });
    g.intersect(P.plane([0, 0.03, 0], [0, 1, 0]), { blend: 0.004 });
  });
  S.weight(P.ellipsoid([cx, 0.03, 0.13], [0.07, 0.05, 0.06]), { bone: 'toe_l', skinBlend: 0.035, mirror: true });
  return S;
}

// ============================================================================ Hände (groß, rundlich)
function sculptHands(J, A, C) {
  const M = TOM_MAT;
  const S = createSculpt({ blend: 0.012, skinBlend: 0.025, mat: M.SKIN, color: C.skin });
  for (const side of ['l', 'r']) {
    const fr = side === 'l' ? A.hl : A.hr;
    const { W, d, n, t } = fr;
    const fb = 'forearm_' + side, hb = 'hand_' + side;
    const q = side === 'r' ? alignQuat(d, n) : alignQuat(d, scl(n, -1));
    S.add(P.sphere(mad(W, d, 0.006), 0.036), { bone: { [fb]: 1, [hb]: 0.7 }, blend: 0.016 });               // Handgelenk
    if (side === 'r') {
      // Faust um den Griff: rundlicher Ballen, Fingerwulst vorn, Daumen über den Fingern
      const c = A.grip;
      S.add(P.ellipsoid(c, [0.05, 0.054, 0.044], alignQuat(t, n)), { bone: hb, blend: 0.016 });
      S.add(P.capsule(mad(c, t, 0.028, d, 0.03, n, -0.012), mad(c, t, -0.03, d, 0.03, n, -0.012), 0.026), { bone: hb, blend: 0.012 });  // Finger
      S.add(P.capsule(mad(c, t, 0.03, n, 0.026, d, -0.01), mad(c, t, 0.038, n, 0.03, d, 0.026), 0.019), { bone: hb, blend: 0.01 });     // Daumen
    } else {
      // offene Hand: Handfläche + Fingerblock + Daumen (Fäustling-artig, leicht gekrümmt)
      S.add(P.roundBox(mad(W, d, 0.045, n, -0.004), [0.042, 0.04, 0.02], 0.018, q), { bone: hb, blend: 0.014 });
      S.add(P.bezier(mad(W, d, 0.07, n, -0.004), mad(W, d, 0.1, n, 0.006), mad(W, d, 0.11, n, 0.03), 0.028, 0.022), { bone: hb, blend: 0.012 });
      S.add(P.capsule(mad(W, d, 0.03, t, 0.034, n, 0.012), mad(W, d, 0.066, t, 0.05, n, 0.03), 0.017), { bone: hb, blend: 0.01 });
    }
  }
  return S;
}

// ============================================================================ Kopf, Haare, Gesicht
/** Offenes Lächeln (Kopfraum): Sichel zwischen Ober- und Unterkante, beide an den Mundwinkeln nach oben gebogen. */
const MOUTH = { w: 0.054, top: -0.093, a: 0.024, bot: -0.13, b: 0.061, z0: 0.118 };
const mouthTop = (u) => MOUTH.top + MOUTH.a * u * u;
function mouthSDF(x, y, z) {
  const lx = x - HEAD.c[0], ly = y - HEAD.c[1], lz = z - HEAD.c[2];
  const u = Math.min(1, Math.abs(lx) / MOUTH.w);
  return Math.max(ly - mouthTop(u), MOUTH.bot + MOUTH.b * u * u - ly, Math.abs(lx) - MOUTH.w, MOUTH.z0 - lz) * 0.8;
}

/** Haarkappe: etwas größer als der Schädel, unten vom Haaransatz begrenzt (vorn hoch, seitlich über den Ohren, hinten tief). */
function hairCapSDF(x, y, z) {
  const lx = x - HEAD.c[0], ly = y - HEAD.c[1], lz = z - HEAD.c[2];
  const dS = ellDist(lx, ly - 0.014, lz + 0.006, [0.216, 0.205, 0.207]);
  const c = lz / (Math.hypot(lx, lz) || 1);                           // cos(Azimut), 1 = vorn
  const yl = c >= 0 ? 0.03 + 0.072 * Math.pow(c, 1.6) : 0.03 - 0.15 * Math.pow(-c, 1.2);
  return Math.max(dS, (yl - ly) * 0.75);
}

function sculptHead(J, A, C) {
  const M = TOM_MAT;
  const S = createSculpt({ blend: 0.02, skinBlend: 0.03, mat: M.SKIN, color: C.skin, bone: 'head' });
  // ---- Hals (kurz, steckt im Kragen)
  S.add(P.roundCone([0, 0.79, -0.016], [0, 0.92, -0.004], 0.06, 0.068), { bone: 'neck', blend: 0.03, skinBlend: 0.045 });
  S.weight(P.sphere([0, 0.79, -0.016], 0.05), { bone: 'chest', skinBlend: 0.05 });
  // ---- Schädel + Pausbacken (Unterkopf voller, weiches Kinn)
  S.add(P.ellipsoid(HEAD.c, HEAD.r));
  S.add(P.ellipsoid(hp(0, -0.07, 0.05), [0.16, 0.105, 0.125]), { blend: 0.07 });
  // ---- Ohren (rund, Muschel angedeutet)
  S.group({ blend: 0.014, childBlend: 0.008, mirror: true }, (g) => {
    g.add(P.ellipsoid(hp(0.192, -0.018, -0.006), [0.03, 0.052, 0.04], [0, -14, 8]));
    g.subtract(P.ellipsoid(hp(0.214, -0.016, 0.002), [0.013, 0.032, 0.024], [0, -14, 8]), { blend: 0.008, color: C.blush, colorBlend: 0.01 });
  });
  // ---- Nase (runder Knubbel)
  S.add(P.sphere(hp(0, -0.04, 0.183), 0.034), { blend: 0.022, color: C.nose, colorBlend: 0.02 });
  // ---- Wangenröte
  S.paint(P.sphere(hp(0.115, -0.06, 0.14), 0.034), { color: C.blush, colorBlend: 0.03, mirror: true });
  // ---- Mund: offenes Lächeln (dunkel), oben Zahnreihe, unten Zunge
  S.subtract(P.custom(mouthSDF, hp(-0.07, -0.15, 0.1), hp(0.07, -0.05, 0.25)), { blend: 0.006, color: C.mouth, colorBlend: 0.002, mat: M.MOUTH });
  S.paint(P.custom((x, y, z) => {
    const lx = x - HEAD.c[0], ly = y - HEAD.c[1], lz = z - HEAD.c[2];
    const top = mouthTop(Math.min(1, Math.abs(lx) / MOUTH.w));
    return Math.max(Math.abs(lx) - 0.042, (top - 0.01) - ly, ly - (top + 0.008), 0.12 - lz);
  }, hp(-0.06, -0.12, 0.1), hp(0.06, -0.06, 0.25)), { mat: M.TEETH, color: C.teeth, colorBlend: 0.002 });
  S.add(P.ellipsoid(hp(0, -0.126, 0.128), [0.026, 0.011, 0.022]), { mat: M.TONGUE, color: C.tongue, blend: 0.006, colorBlend: 0.003 });

  // ---- Haare: Kappe + Tolle + Stirnfransen + Koteletten (eine Gruppe, scharfe Grenze zur Haut)
  S.group({ name: 'hair', mat: M.HAIR, color: C.hair, blend: 0.005, colorBlend: 0.002, childBlend: 0.022, skinBlend: 0.03 }, (g) => {
    g.add(P.custom(hairCapSDF, hp(-0.24, -0.16, -0.24), hp(0.24, 0.24, 0.24)));
    // Stirnfransen: dicke Strähnen, von oben nach vorn-unten und zur Seite geschwungen (Seitenscheitel links)
    const locks = [[-0.105, 0.0], [-0.055, 0.004], [-0.005, 0.008], [0.045, 0.006], [0.092, 0.0]];
    for (const [x0, dy] of locks) {
      g.add(P.bezier(hp(x0 - 0.01, 0.168 + dy, 0.075), hp(x0 + 0.02, 0.15 + dy, 0.17), hp(x0 + 0.05, 0.088 + dy, 0.19), 0.046, 0.013));
    }
    // Tolle: großer Schwung nach oben-vorn
    g.add(P.bezier(hp(-0.03, 0.17, 0.03), hp(-0.02, 0.27, 0.11), hp(0.06, 0.26, 0.18), 0.07, 0.016), { blend: 0.03 });
    g.add(P.bezier(hp(0.03, 0.18, 0.0), hp(0.07, 0.25, 0.07), hp(0.12, 0.22, 0.12), 0.05, 0.012), { blend: 0.03 });
    // Hinterkopf-Wirbel (kleine Spitze)
    g.add(P.bezier(hp(0.0, 0.17, -0.13), hp(0.02, 0.23, -0.17), hp(-0.03, 0.25, -0.2), 0.04, 0.01), { blend: 0.025 });
    // Koteletten vor den Ohren
    g.add(P.roundCone(hp(0.172, 0.06, 0.04), hp(0.178, -0.006, 0.05), 0.03, 0.014), { mirror: true, blend: 0.02 });
  });
  return S;
}

/** Brauen (linke Seite; rechts = Spiegelung): kurzer, dicker Bogen über dem Auge. */
function sculptBrow(C) {
  const S = createSculpt({ blend: 0.006, mat: TOM_MAT.BROW, color: C.brow });
  S.add(P.bezier(hp(0.032, 0.066, 0.17), hp(0.07, 0.086, 0.162), hp(0.108, 0.068, 0.146), 0.0115, 0.008));
  return S;
}

// ============================================================================ Augen, Lider (prozedurale Meshes, Einheitskugel)
/** Augapfel (Einheitskugel, Blick +Z); wird über die Attachment-Matrix zum Oval skaliert. */
function eyeMesh() {
  const ws = 36, hs = 24;
  const pos = [], nor = [], idx = [];
  for (let j = 0; j <= hs; j++) {
    const th = (j / hs) * Math.PI;
    for (let i = 0; i <= ws; i++) {
      const ph = (i / ws) * Math.PI * 2;
      const dx = Math.sin(th) * Math.cos(ph), dy = Math.sin(th) * Math.sin(ph), dz = Math.cos(th);
      pos.push(dx, dy, dz); nor.push(dx, dy, dz);
    }
  }
  for (let j = 0; j < hs; j++) for (let i = 0; i < ws; i++) {
    const a = j * (ws + 1) + i, b = a + ws + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint16Array(idx) };
}

/**
 * Oberlid: Kugelschale (Radius 1.08, Einheitsraum) um die X-Achse; Kante bei α = 0 (Augenäquator), dunkler
 * Wimpernrand. Drehung um +X: positiver Winkel öffnet nach oben.
 */
function lidMesh(C) {
  const RL = 1.08;
  const nb = 24, na = 12;
  const bMax = 84 * DEG, a1 = 150 * DEG;
  const pos = [], nor = [], col = [], dat = [], idx = [];
  const skin = lin(C.skin), lash = lin(C.lash);
  const sp = (r, a, b) => [r * Math.sin(b), r * Math.cos(b) * Math.sin(a), r * Math.cos(b) * Math.cos(a)];
  const rows = [];
  rows.push((b) => ({ p: sp(RL + 0.1, -0.06, b), n: nrm([Math.sin(b), -0.4, Math.cos(b)]), c: lash, m: TOM_MAT.LASH }));
  rows.push((b) => ({ p: sp(RL + 0.02, -0.02, b), n: nrm([Math.sin(b), -0.4, Math.cos(b)]), c: lash, m: TOM_MAT.LASH }));
  for (let k = 0; k <= na; k++) {
    const a = (k / na) * a1;
    rows.push((b) => { const p = sp(RL, a, b); return { p, n: nrm(p), c: k === 0 ? lash : skin, m: k === 0 ? TOM_MAT.LASH : TOM_MAT.SKIN }; });
  }
  for (const row of rows) {
    for (let i = 0; i <= nb; i++) {
      const v = row(-bMax + (2 * bMax * i) / nb);
      pos.push(v.p[0], v.p[1], v.p[2]); nor.push(v.n[0], v.n[1], v.n[2]); col.push(v.c[0], v.c[1], v.c[2], 1); dat.push(v.m, 1, 0, 0);
    }
  }
  const W = nb + 1;
  const strip = (r0, r1) => { for (let i = 0; i < nb; i++) { const a = r0 * W + i, b = r1 * W + i; idx.push(a, b, a + 1, a + 1, b, b + 1); } };
  strip(1, 0);
  for (let r = 2; r < rows.length - 1; r++) strip(r + 1, r);
  // Windung an den Vertex-Normalen ausrichten (Wimpernkante ist nach unten gekippt)
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b2, c] = [idx[t], idx[t + 1], idx[t + 2]];
    const u = sub(pos.slice(3 * b2, 3 * b2 + 3), pos.slice(3 * a, 3 * a + 3)), w = sub(pos.slice(3 * c, 3 * c + 3), pos.slice(3 * a, 3 * a + 3));
    const n = [nor[3 * a] + nor[3 * b2] + nor[3 * c], nor[3 * a + 1] + nor[3 * b2 + 1] + nor[3 * c + 1], nor[3 * a + 2] + nor[3 * b2 + 2] + nor[3 * c + 2]];
    if (dot(cross(u, w), n) < 0) { idx[t + 1] = c; idx[t + 2] = b2; }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), colors: new Float32Array(col), data: new Float32Array(dat), indices: new Uint16Array(idx) };
}

/** Mesh an X = 0 spiegeln (Positionen, Normalen, Wicklung). */
function mirrorMeshX(m) {
  const o = { ...m };
  o.positions = Float32Array.from(m.positions); o.normals = Float32Array.from(m.normals);
  for (let i = 0; i < o.positions.length; i += 3) { o.positions[i] = -o.positions[i]; o.normals[i] = -o.normals[i]; }
  const I = m.indices.constructor.from(m.indices);
  for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; }
  o.indices = I;
  return o;
}

// ============================================================================ Mesh-Hilfen
/**
 * Material-Nähte: data[0] (Material-ID) wird über Dreiecke interpoliert – an Grenzen entstünden Zwischen-IDs.
 * Jedes Dreieck bekommt eine einheitliche ID (Mehrheit), Vertices an Nähten werden dafür dupliziert.
 */
function splitMaterialSeams(m) {
  const D = m.data, I = m.indices, nv0 = m.positions.length / 3;
  const extra = [];
  const key = new Map();
  const out = new Uint32Array(I.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const ma = D[4 * a], mb = D[4 * b], mc = D[4 * c];
    let mt = ma;
    if (ma !== mb || ma !== mc) mt = mb === mc ? mb : ma;
    for (let k = 0; k < 3; k++) {
      const v = I[t + k];
      if (D[4 * v] === mt) { out[t + k] = v; continue; }
      const kk = v * 64 + mt;
      let nvI = key.get(kk);
      if (nvI === undefined) { nvI = nv0 + extra.length; extra.push([v, mt]); key.set(kk, nvI); }
      out[t + k] = nvI;
    }
  }
  if (!extra.length) return m;
  const nv = nv0 + extra.length;
  for (const name of ['positions', 'normals', 'colors', 'data', 'joints', 'weights', 'uvs']) {
    const src = m[name]; if (!src) continue;
    const st = src.length / nv0;
    const dst = new src.constructor(nv * st);
    dst.set(src);
    for (let e = 0; e < extra.length; e++) {
      const v = extra[e][0];
      for (let j = 0; j < st; j++) dst[(nv0 + e) * st + j] = src[v * st + j];
      if (name === 'data') dst[(nv0 + e) * st] = extra[e][1];
    }
    m[name] = dst;
  }
  m.indices = nv > 65535 ? out : Uint16Array.from(out);
  m.vertexCount = nv; m.triangleCount = m.indices.length / 3;
  return m;
}

/** Mesh-Daten (gleiche Attribute) zusammenführen. */
function mergeMeshData(list) {
  const out = {};
  const keys = ['positions', 'normals', 'colors', 'data', 'joints', 'weights'];
  let nv = 0, ni = 0;
  for (const m of list) { nv += m.positions.length / 3; ni += m.indices.length; }
  for (const key of keys) {
    if (!list.every((m) => m[key])) continue;
    const stride = list[0][key].length / (list[0].positions.length / 3);
    const dst = new list[0][key].constructor(nv * stride);
    let o = 0;
    for (const m of list) { dst.set(m[key], o); o += m[key].length; }
    out[key] = dst;
  }
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let base = 0, o = 0;
  for (const m of list) { for (let i = 0; i < m.indices.length; i++) idx[o++] = m.indices[i] + base; base += m.positions.length / 3; }
  out.indices = idx;
  if (list[0].boneNames) out.boneNames = list[0].boneNames;
  out.vertexCount = nv; out.triangleCount = ni / 3;
  return out;
}

// ============================================================================ Shader
const BODY_SURFACE = /* glsl */`
// Material-IDs: 0 Haut 1 Polo 2 Shorts 3 Schuh 4 Sohle 5 Haar 6 Socke 7 Zunge 8 Schweißband 9 Blende
//               10 Braue 11 Wimpern 12 Mund 13 Zähne 14 Kragen
float tg_line(float d, float w) { float aa = fwidth(d) * 1.2 + 1e-5; return 1.0 - smoothstep(w - aa, w + aa, abs(d)); }
void surface(in SurfaceInput i, inout Surface s) {
  int m = int(i.data.x + 0.5);
  vec3 op = i.objPos;
  vec3 on = normalize(i.objNormal);
  vec3 col = i.color.rgb;
  s.ao = mix(1.0, i.data.y, 0.75);
  float fw = length(fwidth(op));
  // weiche Kanten-Aufhellung (Cartoon-Lesbarkeit aus der TV-Perspektive)
  float rim = pow(1.0 - saturate(dot(normalize(i.normal), i.viewDir)), 3.0);
  if (m == 0) {
    s.albedo = col;
    s.roughness = 0.55; s.specular = 0.32;
    s.subsurface = 0.38; s.subsurfaceColor = vec3(1.0, 0.45, 0.35);
  } else if (m == 1 || m == 14) {
    // Polo: feiner Strick, Knopfleiste, Emblem
    vec3 a = abs(on);
    vec2 uv = a.x > a.z ? op.zy : op.xy;
    vec2 g = uv * vec2(420.0, 460.0);
    float knit = abs(sin(g.x + 0.6 * sin(g.y))) * abs(sin(g.y));
    float kf = 1.0 - smoothstep(0.0006, 0.002, fw);
    if (kf > 0.0) s.normal = bumpNormal(s.normal, i.worldPos, knit, 0.00018 * kf);
    if (m == 1 && op.z > 0.05 && op.y > 0.7 && op.y < 0.812) {
      float pl = tg_line(abs(op.x) - 0.016, 0.0012) * step(op.y, 0.81);
      col *= 1.0 - 0.25 * pl;
      for (int k = 0; k < 2; k++) {
        vec2 bp = vec2(op.x, op.y - (k == 0 ? 0.785 : 0.745));
        float b = 1.0 - smoothstep(0.0065, 0.0075, length(bp));
        col = mix(col, vec3(0.97), b);
      }
    }
    // Emblem (Toms linke Brust): Tennisball
    vec2 ep = vec2(op.x - 0.075, op.y - 0.73);
    if (op.z > 0.05 && dot(ep, ep) < 0.0006) {
      float ball = 1.0 - smoothstep(0.0125, 0.0135, length(ep));
      float seam = tg_line(length(ep - vec2(0.016, 0.0)) - 0.012, 0.0013) * ball;
      col = mix(col, vec3(0.75, 0.9, 0.08), ball);
      col = mix(col, vec3(1.0), seam);
    }
    if (m == 14) col = vec3(0.97);
    s.albedo = col;
    s.roughness = 0.8; s.specular = 0.3;
    s.sheen = 0.5; s.sheenColor = mix(col, vec3(1.0), 0.5);
  } else if (m == 2) {
    // Shorts: hellblauer Seitenstreifen
    float side = step(0.1, abs(op.x));
    float stripe = tg_line(op.z + 0.004, 0.011) * side;
    col = mix(col, u_stripe, stripe);
    s.albedo = col; s.roughness = 0.85; s.specular = 0.3;
    s.sheen = 0.35; s.sheenColor = vec3(0.95);
  } else if (m == 6) {
    // Socke: zwei blaue Ringe am Bündchen
    float band = tg_line(op.y - 0.192, 0.0045) + tg_line(op.y - 0.172, 0.003);
    col = mix(col, u_stripe, clamp(band, 0.0, 1.0));
    s.albedo = col; s.roughness = 0.9; s.sheen = 0.45; s.sheenColor = vec3(0.95);
  } else if (m == 3) {
    // Schuh: weiß, blauer Schwung an der Außenseite, dunkelblaue Fersenkappe, Schnürung oben
    vec3 fp = vec3(abs(op.x) - 0.091, op.y, op.z);
    float side = smoothstep(0.2, 0.5, abs(on.x));
    float t = clamp((fp.z + 0.07) / 0.2, 0.0, 1.0);
    float yc = 0.04 + 0.05 * t * (1.0 - 0.6 * t);
    float th = mix(0.014, 0.003, t);
    float aa = fwidth(fp.y) * 1.2 + 1e-5;
    float sw = (1.0 - smoothstep(th - aa, th + aa, abs(fp.y - yc))) * step(-0.08, fp.z) * (1.0 - smoothstep(0.12, 0.13, fp.z)) * side;
    col = mix(col, u_stripe, sw);
    float heel = (1.0 - smoothstep(-0.07, -0.062, fp.z)) * (1.0 - smoothstep(0.075 - aa, 0.075 + aa, fp.y));
    col = mix(col, u_navy, heel);
    if (abs(fp.x) < 0.024 && fp.z > -0.004 && fp.z < 0.09 && on.y > 0.35) {
      float lz = fract((fp.z + 0.004) / 0.022);
      float lace = (1.0 - smoothstep(0.18, 0.3, abs(lz - 0.5))) * (1.0 - smoothstep(0.015, 0.018, abs(fp.x)));
      col = mix(col, u_navy, lace * 0.85);
    }
    s.albedo = col; s.roughness = 0.42; s.specular = 0.45; s.sheen = 0.15;
  } else if (m == 4) {
    s.albedo = col; s.roughness = 0.6; s.specular = 0.35;
  } else if (m == 5) {
    // Haare: weiche Strähnen + glänzendes Cartoon-Lichtband (Ring um den Kopf)
    vec3 hd = normalize(op - u_headC);
    float el = asin(clamp(hd.y, -1.0, 1.0));
    float az = atan(hd.x, hd.z);
    float strands = 0.5 + 0.5 * sin(az * 34.0 + sin(el * 9.0) * 1.4);
    float sf = 1.0 - smoothstep(0.0012, 0.004, fw);
    col *= 0.86 + 0.18 * mix(0.5, strands, sf);
    float band = smoothstep(0.24, 0.0, abs(el - 0.72 - 0.06 * sin(az * 5.0)));
    s.albedo = col;
    s.emissive = col * band * 0.55 * saturate(dot(normalize(i.normal), u_sunDir) + 0.6);
    s.roughness = 0.42; s.specular = 0.4;
    s.sheen = 0.35; s.sheenColor = col * 2.2;
  } else if (m == 8) {
    float tt = noise3(op * 900.0);
    float kf = 1.0 - smoothstep(0.0005, 0.0015, fw);
    if (kf > 0.0) s.normal = bumpNormal(s.normal, i.worldPos, tt, 0.0004 * kf);
    s.albedo = col * (0.94 + 0.06 * tt);
    s.roughness = 0.9; s.sheen = 0.7; s.sheenColor = vec3(1.0);
  } else if (m == 9) {
    s.albedo = col; s.roughness = 0.75; s.sheen = 0.4; s.sheenColor = vec3(1.0);
  } else if (m == 12) {
    s.albedo = col; s.roughness = 0.6; s.specular = 0.2; s.ao *= 0.8;
  } else if (m == 13) {
    s.albedo = col; s.roughness = 0.25; s.specular = 0.5;
  } else if (m == 7) {
    s.albedo = col; s.roughness = 0.35; s.specular = 0.4; s.subsurface = 0.3;
  } else {
    s.albedo = col; s.roughness = 0.6;
  }
  s.emissive += s.albedo * rim * 0.12;
}`;

const EYE_SURFACE = /* glsl */`
void surface(in SurfaceInput i, inout Surface s) {
  vec3 p = normalize(i.objPos);
  float ang = acos(clamp(p.z, -1.0, 1.0));
  float aa = fwidth(ang) * 1.3 + 1e-4;
  float irisR = u_iris.x, pupilR = u_iris.y;
  float iris = 1.0 - smoothstep(irisR - aa, irisR + aa, ang);
  float pupil = 1.0 - smoothstep(pupilR - aa, pupilR + aa, ang);
  float rr = ang / irisR;
  // Iris: Verlauf dunkel oben -> hell unten (Cartoon), dunkler Rand
  vec3 ic = mix(u_irisDark, u_irisLight, smoothstep(0.3, -0.6, p.y / max(sin(irisR), 1e-3)) * 0.85);
  ic *= mix(0.55, 1.0, smoothstep(1.0, 0.82, rr));
  vec3 sc = u_sclera * mix(1.0, 0.86, smoothstep(0.9, 1.6, ang));
  vec3 col = mix(sc, ic, iris);
  col = mix(col, vec3(0.02, 0.012, 0.01), pupil);
  // feste Glanzlichter (oben seitlich + klein unten) – lebendiger Cartoon-Blick
  vec2 q = p.xy;
  float h1 = 1.0 - smoothstep(0.1, 0.13, length(q - vec2(-0.14, 0.2)));
  float h2 = 1.0 - smoothstep(0.045, 0.065, length(q - vec2(0.12, -0.16)));
  float hl = max(h1, h2 * 0.8) * step(0.0, p.z);
  s.albedo = col;
  s.roughness = 0.12; s.specular = 0.6;
  s.ao = mix(1.0, 0.7, smoothstep(0.3, 0.9, p.y));
  s.emissive = vec3(hl) * u_catch;
}`;

// ============================================================================ Aufbau
function cellsFor(q) {
  const name = (q && q.name) || 'high';
  if (name === 'low') return { body: 0.011, head: 0.0085, feet: 0.009, hands: 0.008, brow: 0.004 };
  if (name === 'medium') return { body: 0.0095, head: 0.0072, feet: 0.0075, hands: 0.0068, brow: 0.0032 };
  return { body: 0.009, head: 0.0068, feet: 0.007, hands: 0.0062, brow: 0.0028 };
}

const now = () => (typeof performance !== 'undefined' ? performance : Date).now();

/**
 * CPU-Teil (ohne Renderer, auch in node nutzbar): Skelett + alle Mesh-Daten.
 * @param {object} [q] Qualität (renderer.q) – bestimmt Zellgrößen.  o.cells überschreibt.
 */
export function buildTomGeometry(q = null, o = {}) {
  const t0 = now();
  const J = TOM_JOINTS;
  const C = TOM_COLORS;
  const A = computeAnchors(J);
  const cells = { ...cellsFor(q), ...(o.cells || {}) };
  const skeletonDef = defineSkeleton({ joints: J, tips: TOM_TIPS });

  const bodyS = sculptBody(J, A, C);
  const feetS = sculptFeet(J, A, C);
  const handsS = sculptHands(J, A, C);
  const headS = sculptHead(J, A, C);
  const browS = sculptBrow(C);
  if (o.sculptsOnly) return { J, A, C, skeletonDef, sculpts: { bodyS, feetS, handsS, headS, browS } };
  const ms = { sculpt: Math.round(now() - t0) };
  const poly = (name, S, opts) => { const t = now(); const m = polygonize(S, opts); ms[name] = Math.round(now() - t); return m; };

  const body0 = poly('body', bodyS, { cell: cells.body, skeleton: skeletonDef, aoDist: 0.05, aoSamples: 4, aoDirs: 2, data2: 'none', project: 1 });
  const feet = poly('feet', feetS, { cell: cells.feet, skeleton: skeletonDef, aoDist: 0.03, aoSamples: 4, aoDirs: 1, data2: 'none', project: 1 });
  const hands = poly('hands', handsS, { cell: cells.hands, skeleton: skeletonDef, aoDist: 0.03, aoDirs: 1, data2: 'none', project: 1 });
  const body = splitMaterialSeams(mergeMeshData([body0, feet, hands]));
  const head = splitMaterialSeams(poly('head', headS, { cell: cells.head, skeleton: skeletonDef, aoDist: 0.04, aoDirs: 2, aoStrength: 0.9, data2: 'none', project: 1 }));
  const brows = poly('brows', browS, { cell: cells.brow, ao: false, data2: 'none' });
  const eye = eyeMesh();
  const lid = lidMesh(C);
  const tris = body.triangleCount + head.triangleCount + 2 * brows.triangleCount + 2 * eye.indices.length / 3 + 2 * lid.indices.length / 3;
  return {
    J, A, C, skeletonDef, sculpts: { bodyS, feetS, handsS, headS, browS },
    meshes: { body, head, brows, eye, lid },
    stats: { ms: now() - t0, polyMs: ms, triangles: tris },
  };
}

/** Rotationsmatrix-Helfer (Spalten = Achsen) -> Quaternion. */
function quatFromAxes(x, y, z) {
  const q = quat.fromMat3(quat.create(), [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]]);
  return quat.normalize(q, q);
}

/** Griff-Sockel (siehe Kopfkommentar). */
function gripSocketFor(A) {
  const { W, n, t } = A.hr;
  const offset = sub(A.grip, W);
  const y = t, z = nrm(sub(n, scl(t, dot(n, t)))), x = nrm(cross(y, z));
  const rotation = quatFromAxes(x, y, z);
  const matrix = mat4.fromRotationTranslation(mat4.create(), rotation, offset);
  return { bone: 'hand_r', offset, rotation: Array.from(rotation), matrix };
}

/**
 * Tom bauen (GPU-Ressourcen + Asset gemäß §5.4).
 * @param {Renderer} renderer
 * @param {object} [q] Qualitäts-Settings (Standard: renderer.q)
 */
export function buildTom(renderer, q = renderer && renderer.q) {
  const G = buildTomGeometry(q);
  const { A, C, meshes } = G;
  const H = A.H;

  const bodyMat = renderer.createMaterial({
    name: 'tom-body',
    uniforms: { u_stripe: lin(C.stripe), u_navy: lin(C.navy), u_headC: HEAD.c.slice() },
    surface: BODY_SURFACE,
  });
  const eyeMat = renderer.createMaterial({
    name: 'tom-eye',
    uniforms: { u_iris: [0.62, 0.36], u_irisDark: lin(C.iris), u_irisLight: lin(C.irisLight), u_sclera: lin(C.sclera), u_catch: 1.6 },
    surface: EYE_SURFACE,
    castShadow: false,
  });

  const parts = [
    { name: 'body', mesh: renderer.createMesh(meshes.body), material: bodyMat, skinned: true, castShadow: true },
    { name: 'head', mesh: renderer.createMesh(meshes.head), material: bodyMat, skinned: true, castShadow: true },
  ];

  // ---- Attachments (Kopf-Knochenraum: Ruhe-Orientierung = Identität, Ursprung = Kopfgelenk)
  const toHead = mat4.fromTranslation(mat4.create(), [-H[0], -H[1], -H[2]]);
  const eyeMesh0 = renderer.createMesh(meshes.eye);
  const lidMesh0 = renderer.createMesh(meshes.lid);
  const attachments = [];
  const brows = [];
  for (const side of [1, -1]) {
    const b = { name: side > 0 ? 'brow_l' : 'brow_r', bone: 'head', mesh: renderer.createMesh(side > 0 ? meshes.brows : mirrorMeshX(meshes.brows)), material: bodyMat, offset: mat4.clone(toHead), castShadow: false };
    attachments.push(b);
    brows.push({ side, att: b });
  }
  const eyes = [];
  for (const side of [1, -1]) {
    const c = side > 0 ? A.eyeL : mirrorX(A.eyeL);
    const local = sub(c, H);
    const eye = { name: side > 0 ? 'eye_l' : 'eye_r', bone: 'head', mesh: eyeMesh0, material: eyeMat, offset: mat4.create(), castShadow: false };
    const lid = { name: side > 0 ? 'lid_l' : 'lid_r', bone: 'head', mesh: lidMesh0, material: bodyMat, offset: mat4.create(), castShadow: false };
    attachments.push(eye, lid);
    eyes.push({ side, local, eye, lid });
  }
  const face = createFace(eyes, A, brows);
  face.update(0, { blink: 0, mood: 'neutral', lookDir: null });

  return {
    id: 'tom', name: 'Tom',
    skeletonDef: G.skeletonDef,
    parts, attachments,
    gripSocket: gripSocketFor(A),
    leftHandGrip: { bone: 'hand_l', offset: sub(A.leftGrip, A.hl.W) },
    face,
    readyPose: { hand_r: [-58, 0, -14] },   // Schläger in Bereitschaft vor der Brust statt vor dem Gesicht
    relaxedPose: { hand_r: [-60, 0, -10] }, // locker: Schläger zeigt nach vorn-unten
    racketStyle: { frame: lin('#1d2b4f'), accent: lin('#7cc6f6'), grip: lin('#f4f4f2'), name: 'tom' },
    heightM: TOM_HEIGHT,
    headCenter: HEAD.c.slice(),
    stats: { buildMs: G.stats.ms, triangles: G.stats.triangles, phases: G.stats.polyMs },
  };
}

// ============================================================================ Mimik / Augen
const MOODS = {
  neutral: { browY: 0, browIn: 0, browTilt: 0, lid: 0 },
  happy: { browY: 0.006, browIn: 0, browTilt: -6, lid: -6 },
  focused: { browY: -0.003, browIn: 0.002, browTilt: 7, lid: -6 },
  sad: { browY: 0.002, browIn: 0.0, browTilt: -16, lid: -12 },
};

function createFace(eyes, A, brows) {
  const H = A.H;
  const st = { blink: 0, auto: 0, next: 2.5, yaw: 0, pitch: 0 };
  const qL = quat.create(), qY = quat.create(), qI = quat.create(), mS = mat4.create(), mA = mat4.create(), mB = mat4.create();
  const pivot = hp(0.072, 0.08, 0.16);
  const mood = { ...MOODS.neutral };
  // Augen-Basismatrix je Seite: T(Mitte) * R(Gier nach außen) * S(Halbachsen) * R(-Gier * irisYaw)
  const base = eyes.map((e) => {
    quat.identity(qY); quat.rotateY(qY, qY, e.side * EYE.yaw * DEG);
    const T = mat4.fromRotationTranslation(mat4.create(), qY, e.local);
    mat4.scale(T, T, EYE.r);
    quat.identity(qI); quat.rotateY(qI, qI, -e.side * EYE.yaw * EYE.irisYaw * DEG);
    const Ri = mat4.fromQuat(mat4.create(), qI);
    return { T, Ri };
  });
  return {
    state: st, mood,
    update(dt, o = {}) {
      // Blinzeln (o.blink: 0 offen .. 1 zu; undefined -> automatisch)
      let blink;
      if (typeof o.blink === 'number') blink = o.blink;
      else {
        st.next -= dt;
        if (st.next <= 0) { st.auto = 1e-4; st.next = 2.2 + Math.random() * 3.5; }
        if (st.auto > 0) { st.auto += dt; if (st.auto > 0.16) st.auto = 0; }
        blink = st.auto > 0 ? Math.sin(Math.min(1, st.auto / 0.16) * Math.PI) : 0;
      }
      st.blink = blink;
      const m = MOODS[o.mood] || MOODS.neutral;
      const k = dt > 0 ? 1 - Math.exp(-10 * dt) : 1;
      for (const key in mood) mood[key] += (m[key] - mood[key]) * k;
      // Blickrichtung (Kopfraum)
      let yaw = 0, pitch = 0;
      if (o.lookDir) {
        const d = o.lookDir, l = Math.hypot(d[0], d[1], d[2]) || 1;
        yaw = clamp(Math.atan2(d[0] / l, Math.max(0.2, d[2] / l)), -0.5, 0.5);
        pitch = clamp(Math.asin(clamp(d[1] / l, -1, 1)), -0.35, 0.35);
      }
      const ke = dt > 0 ? 1 - Math.exp(-28 * dt) : 1;
      st.yaw += (yaw - st.yaw) * ke; st.pitch += (pitch - st.pitch) * ke;
      for (let j = 0; j < eyes.length; j++) {
        const e = eyes[j], B = base[j];
        quat.identity(qL);
        quat.rotateY(qL, qL, st.yaw);
        quat.rotateX(qL, qL, -st.pitch);
        mat4.fromQuat(mS, qL);
        mat4.multiply(mA, B.Ri, mS);
        mat4.multiply(e.eye.offset, B.T, mA);
        // Lid: Kante über dem Äquator (offen) bis darunter (zu); Blick nach unten -> Lid sinkt mit
        const open = A.lidOpen + mood.lid + st.pitch * 30;
        const ang = open + (A.lidClosed - open) * clamp(blink, 0, 1);
        quat.identity(qL);
        quat.rotateX(qL, qL, -ang * DEG);
        mat4.fromQuat(mS, qL);
        mat4.multiply(e.lid.offset, B.T, mS);
      }
      // Brauen: Verschiebung + Neigung um die Brauenmitte
      for (const b of brows) {
        const s = b.side;
        const pv = [pivot[0] * s, pivot[1], pivot[2]];
        mat4.fromTranslation(mA, [pv[0] - s * mood.browIn - H[0], pv[1] + mood.browY - H[1], pv[2] - H[2]]);
        mat4.rotateZ(mA, mA, s * mood.browTilt * DEG);
        mat4.fromTranslation(mB, [-pv[0], -pv[1], -pv[2]]);
        mat4.multiply(b.att.offset, mA, mB);
      }
    },
  };
}

// Requisiten: Schiedsrichterstuhl mit Schiedsrichter (Kopf folgt dem Ball), Balljungen/-mädchen,
// Linienrichter, Spielerbänke mit Handtüchern/Taschen/Flaschen, TV-Kameras auf Stativen/Podesten.
import { MeshBuilder } from './mb.js';
import { hex } from './envlib.js';
import { LAYOUT } from './layout.js';
import { sphere, cylinder, roundedBox } from '../gfx/geometry.js';
import { mat4, vec3, damp } from '../core/math.js';

const D = (rough, pat = 0, ao = 1) => [rough, pat, ao, 0];
const COL = {
  green: hex('#143f2c'), greenMid: hex('#1f5a3d'), cream: hex('#efe7d2'), white: hex('#f3f1ea'), gold: hex('#c9a04a'),
  brown: hex('#5a3b24'), dark: hex('#1b1d1e'), metal: hex('#9aa09e'), shoe: hex('#f0eee8'),
  skinA: hex('#e0ac8a'), skinB: hex('#c48a63'), skinC: hex('#8d5a3c'), hairA: hex('#2a1a10'), hairB: hex('#6b4a2a'), hairC: hex('#c9a26a'),
  towel: hex('#f4f1ea'), purple: hex('#4b2a5e'), bag: hex('#20262b'), orange: hex('#e2782f'), lightBlue: hex('#8cc6ec'),
};

const _m = mat4.create();

/** Kugel bei p (Radien r = [rx, ry, rz]). */
function ball(mb, p, r, col, d, seg = 12) {
  mat4.fromTranslation(_m, p);
  mat4.scale(_m, _m, Array.isArray(r) ? r : [r, r, r]);
  mb.add(sphere(1, seg, Math.max(6, seg >> 1)), _m, col, d);
}

/** Ellipsoid zwischen zwei Punkten (Achse a->b), Querschnitt rx/rz. */
function blob(mb, a, b, rx, rz, col, d, seg = 12) {
  const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const ax = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(ax[0], ax[1], ax[2]) || 1;
  const y = [ax[0] / len, ax[1] / len, ax[2] / len];
  const ref = Math.abs(y[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  const z = vec3.normalize([], vec3.cross([], ref, y));
  const x = vec3.cross([], y, z);
  const m = mat4.create();
  m[0] = x[0] * rx; m[1] = x[1] * rx; m[2] = x[2] * rx;
  m[4] = y[0] * len / 2; m[5] = y[1] * len / 2; m[6] = y[2] * len / 2;
  m[8] = z[0] * rz; m[9] = z[1] * rz; m[10] = z[2] * rz;
  m[12] = c[0]; m[13] = c[1]; m[14] = c[2];
  mb.add(sphere(1, seg, Math.max(6, seg >> 1)), m, col, d);
}

function limb(mb, a, b, r0, r1, col, d) {
  mb.tube(a, b, (r0 + r1) / 2, 8, col, d);
  ball(mb, b, r1, col, d, 8);
}

const POSES = {
  seated: {
    hip: [0, 0.5, 0], chest: [0, 0.98, -0.02], neck: [0, 1.12, 0], head: [0, 1.27, 0.02],
    sh: [0.19, 1.04, -0.01], el: [0.23, 0.8, 0.1], ha: [0.12, 0.7, 0.33],
    hj: [0.1, 0.5, 0.02], kn: [0.11, 0.52, 0.45], an: [0.1, 0.09, 0.5], to: [0.1, 0.035, 0.62],
  },
  crouch: {
    hip: [0, 0.56, -0.05], chest: [0, 0.94, 0.12], neck: [0, 1.08, 0.18], head: [0, 1.21, 0.23],
    sh: [0.18, 0.99, 0.12], el: [0.2, 0.76, 0.26], ha: [0.13, 0.58, 0.38],
    hj: [0.1, 0.56, -0.05], kn: [0.12, 0.52, 0.38], an: [0.12, 0.09, 0.33], to: [0.12, 0.035, 0.46],
    hjR: [-0.1, 0.56, -0.05], knR: [-0.12, 0.07, 0.12], anR: [-0.12, 0.1, -0.33], toR: [-0.12, 0.03, -0.43],
  },
  stand: {
    hip: [0, 0.95, 0], chest: [0, 1.36, -0.01], neck: [0, 1.5, 0], head: [0, 1.65, 0.01],
    sh: [0.19, 1.43, -0.02], el: [0.22, 1.16, -0.1], ha: [0.07, 0.99, -0.16],
    hj: [0.1, 0.93, 0], kn: [0.11, 0.5, 0.03], an: [0.11, 0.09, 0], to: [0.11, 0.035, 0.13],
  },
};

/**
 * Menschliche Figur (statisch) in mb einfügen. M = Welttransformation (mat4, +z = Blickrichtung).
 * c = { top, sleeve?, bottom, skin, hair, shoe, hat?, hatBand?, cap? }. headSeparate: Kopf weglassen (eigenes Drawable).
 */
export function addFigure(mb, pose, c, M, opts = {}) {
  const P = POSES[pose];
  const T = (p) => vec3.transformMat4([], p, M);
  const mir = (p) => [-p[0], p[1], p[2]];
  const d = D(0.75, 0), dSkin = D(0.55, 0);
  // Rumpf + Becken
  blob(mb, T([0, P.hip[1] - 0.08, P.hip[2]]), T(P.neck), 0.185, 0.12, c.top, d, 14);
  blob(mb, T([0, P.hip[1] - 0.1, P.hip[2] - 0.01]), T([0, P.hip[1] + 0.14, P.hip[2]]), 0.17, 0.125, c.bottom, d, 12);
  if (c.collar) blob(mb, T([0, P.neck[1] - 0.12, P.neck[2] + 0.06]), T([0, P.neck[1] + 0.01, P.neck[2] + 0.075]), 0.06, 0.025, c.collar, d, 8);
  // Hals
  mb.tube(T([0, P.neck[1] - 0.04, P.neck[2]]), T([0, P.neck[1] + 0.08, P.neck[2] + 0.01]), 0.048, 8, c.skin, dSkin);
  // Arme
  for (const sg of [1, -1]) {
    const f = (p) => T(sg > 0 ? p : mir(p));
    limb(mb, f(P.sh), f(P.el), 0.05, 0.045, c.sleeve || c.top, d);
    limb(mb, f(P.el), f(P.ha), 0.042, 0.036, c.forearm || c.sleeve || c.top, d);
    ball(mb, f(P.ha), [0.045, 0.05, 0.045], c.skin, dSkin, 8);
    ball(mb, f(P.sh), 0.058, c.sleeve || c.top, d, 10);
  }
  // Beine
  for (const sg of [1, -1]) {
    const R = sg < 0 && P.hjR;
    const hj = R ? P.hjR : P.hj, kn = R ? P.knR : P.kn, an = R ? P.anR : P.an, to = R ? P.toR : P.to;
    const f = (p) => T(sg > 0 || R ? p : mir(p));
    limb(mb, f(hj), f(kn), 0.075, 0.058, c.bottom, d);
    limb(mb, f(kn), f(an), 0.055, 0.045, c.leg || c.bottom, d);
    blob(mb, f([an[0], an[1] - 0.04, an[2] - 0.04]), f([to[0], to[1], to[2] + 0.03]), 0.05, 0.045, c.shoe, D(0.5, 0), 8);
  }
  if (!opts.headSeparate) addHead(mb, P, c, M);
  return { neck: T(P.neck), head: T(P.head) };
}

/** Kopf (+ Haare/Hut) relativ zur Pose in mb. */
export function addHead(mb, P, c, M) {
  const T = (p) => vec3.transformMat4([], p, M);
  const h = P.head;
  const dSkin = D(0.55, 0);
  ball(mb, T(h), [0.098, 0.118, 0.105], c.skin, dSkin, 14);
  ball(mb, T([0, h[1] - 0.01, h[2] + 0.1]), [0.016, 0.022, 0.02], c.skin, dSkin, 6);         // Nase
  for (const sg of [1, -1]) {
    ball(mb, T([sg * 0.036, h[1] + 0.012, h[2] + 0.088]), [0.013, 0.011, 0.008], hex('#151515'), D(0.2, 0), 6);   // Augen
    ball(mb, T([sg * 0.098, h[1], h[2] - 0.005]), [0.018, 0.03, 0.02], c.skin, dSkin, 6);           // Ohren
  }
  // Haare: Kappe hinten/oben
  ball(mb, T([0, h[1] + 0.03, h[2] - 0.018]), [0.104, 0.105, 0.108], c.hair, D(0.6, 0), 12);
  if (c.hat === 'panama') {
    mb.add(cylinder(0.105, 0.11, 0.09, 14, 1, false), mat4.multiply(mat4.create(), M, mat4.fromTranslation(mat4.create(), [0, h[1] + 0.1, h[2] - 0.01])), c.hatCol, D(0.8, 0));
    mb.add(cylinder(0.2, 0.2, 0.008, 18, 1, false), mat4.multiply(mat4.create(), M, mat4.fromTranslation(mat4.create(), [0, h[1] + 0.06, h[2] - 0.01])), c.hatCol, D(0.8, 0));
    mb.add(cylinder(0.111, 0.111, 0.022, 14, 1, true), mat4.multiply(mat4.create(), M, mat4.fromTranslation(mat4.create(), [0, h[1] + 0.075, h[2] - 0.01])), c.hatBand, D(0.6, 0));
  } else if (c.hat === 'cap') {
    ball(mb, T([0, h[1] + 0.045, h[2] - 0.01]), [0.108, 0.088, 0.115], c.hatCol, D(0.7, 0), 12);
    const m = mat4.multiply(mat4.create(), M, mat4.fromTranslation(mat4.create(), [0, h[1] + 0.05, h[2] + 0.13]));
    mat4.rotateX(m, m, 0.12);
    mb.add(roundedBox(0.17, 0.012, 0.1, 0.005, 1), m, c.hatCol, D(0.7, 0));
  }
}

export function buildProps(r, q, opts = {}) {
  const mb = new MeshBuilder();
  const L = LAYOUT;
  const M = (x, y, z, yaw = 0, s = 1) => mat4.fromYawTranslation(mat4.create(), yaw, [x, y, z], s);
  const box = (c, s, m, col, d = D(0.6, 0)) => mb.box(c, s, m, col, d);

  // ---------------------------------------------------------------- Schiedsrichterstuhl (Westseite, Netzhöhe)
  const UX = -7.35, UZ = 0;
  const chair = M(UX, 0, UZ, Math.PI / 2);       // +z lokal = +x Welt (Blick zum Platz)
  const g = COL.green, dG = D(0.45, 0);
  for (const [lx, lz] of [[-0.42, -0.36], [0.42, -0.36], [-0.42, 0.34], [0.42, 0.34]]) box([lx, 0.92, lz], [0.07, 1.84, 0.07], chair, g, dG);
  for (const y of [0.45, 1.15]) { box([0, y, -0.36], [0.9, 0.05, 0.05], chair, g, dG); box([0, y, 0.34], [0.9, 0.05, 0.05], chair, g, dG); }
  box([0, 1.86, 0], [1.0, 0.08, 0.86], chair, g, dG);                       // Plattform
  box([0, 2.32, -0.33], [0.62, 0.06, 0.06], chair, g, dG);
  box([0, 2.32, -0.33], [0.06, 0.06, 0.06], chair, g, dG);
  box([0, 2.33, -0.1], [0.56, 0.08, 0.5], chair, COL.cream, D(0.8, 0));   // Sitzkissen
  box([0, 2.62, -0.36], [0.56, 0.6, 0.06], chair, g, dG);                  // Lehne
  for (const sx of [-1, 1]) box([sx * 0.31, 2.48, -0.1], [0.05, 0.05, 0.5], chair, g, dG);   // Armlehnen
  box([0, 1.95, -0.18], [0.5, 0.36, 0.06], chair, g, dG);                  // Sitzstütze
  // Pult vorne mit Logo-Feld
  box([0, 2.3, 0.4], [0.86, 0.9, 0.05], chair, g, dG);
  box([0, 2.77, 0.33], [0.9, 0.04, 0.2], chair, COL.cream, D(0.7, 0));
  box([0, 2.3, 0.426], [0.42, 0.3, 0.01], chair, COL.gold, D(0.35, 5));
  // Leiter (Seite -z lokal = Richtung Norden)
  for (let k = 0; k < 5; k++) box([0, 0.3 + k * 0.33, -0.62 - k * 0.0], [0.6, 0.04, 0.2], chair, COL.metal, D(0.4, 5));
  for (const sx of [-1, 1]) box([sx * 0.31, 0.95, -0.62], [0.04, 1.9, 0.04], chair, COL.metal, D(0.4, 5));
  // Mikrofon
  const micA = vec3.transformMat4([], [0.18, 2.8, 0.36], chair), micB = vec3.transformMat4([], [0.12, 3.0, 0.2], chair);
  mb.tube(micA, micB, 0.008, 6, COL.dark, D(0.4, 5));
  ball(mb, micB, 0.025, COL.dark, D(0.6, 0), 8);
  // Schiedsrichter (sitzend, Kopf separat)
  const umpC = {
    top: COL.green, sleeve: COL.green, bottom: COL.cream, skin: COL.skinA, hair: COL.hairB, shoe: COL.brown,
    collar: COL.white, hat: 'panama', hatCol: COL.cream, hatBand: COL.green,
  };
  const umpM = mat4.multiply(mat4.create(), chair, M(0, 1.9, -0.1));
  addFigure(mb, 'seated', umpC, umpM, { headSeparate: true });
  // Kopf-Mesh (lokal um den Hals)
  const headMB = new MeshBuilder();
  const P = POSES.seated;
  const neckLocal = [0, P.neck[1] + 0.06, P.neck[2]];
  addHead(headMB, P, umpC, mat4.fromTranslation(mat4.create(), [-neckLocal[0], -neckLocal[1], -neckLocal[2]]));
  const neckWorld = vec3.transformMat4([], neckLocal, umpM);
  const umpYaw0 = Math.PI / 2;

  // ---------------------------------------------------------------- Spielerbänke (westlich, beiderseits des Stuhls)
  const benchX = -L.wallX + 0.75;
  const towelCols = [[COL.towel, COL.green], [COL.towel, COL.purple]];
  for (const [bz, pi] of [[-2.6, 0], [2.6, 1]]) {
    const bm = M(benchX, 0, bz, Math.PI / 2);
    // zwei Stühle
    for (const cx of [-0.42, 0.42]) {
      const cm = mat4.multiply(mat4.create(), bm, M(cx, 0, 0));
      for (const [lx, lz] of [[-0.22, -0.2], [0.22, -0.2], [-0.22, 0.2], [0.22, 0.2]]) box([lx, 0.22, lz], [0.035, 0.44, 0.035], cm, COL.green, dG);
      box([0, 0.46, 0], [0.5, 0.06, 0.46], cm, COL.green, dG);
      box([0, 0.5, 0.01], [0.46, 0.04, 0.42], cm, COL.cream, D(0.85, 0));
      box([0, 0.78, -0.22], [0.5, 0.5, 0.05], cm, COL.green, dG);
      // Handtuch über der Lehne
      const tc = towelCols[pi];
      box([0.05, 0.86, -0.22], [0.36, 0.42, 0.075], cm, tc[0], D(0.95, 0));
      box([0.05, 0.98, -0.22], [0.365, 0.035, 0.08], cm, tc[1], D(0.95, 0));
    }
    // Tisch mit Flaschen
    const tm = mat4.multiply(mat4.create(), bm, M(1.0, 0, 0.05));
    box([0, 0.33, 0], [0.42, 0.04, 0.42], tm, COL.green, dG);
    box([0, 0.16, 0], [0.05, 0.32, 0.05], tm, COL.green, dG);
    for (let k = 0; k < 4; k++) {
      const p = vec3.transformMat4([], [-0.12 + k * 0.08, 0.35, (k % 2) * 0.1 - 0.05], tm);
      const col = k % 2 ? hex('#7fb3c9') : (pi ? COL.orange : COL.lightBlue);
      mb.tube(p, [p[0], p[1] + 0.2, p[2]], 0.033, 10, col, D(0.15, 0), true);
      mb.tube([p[0], p[1] + 0.2, p[2]], [p[0], p[1] + 0.24, p[2]], 0.015, 8, COL.white, D(0.4, 0), true);
    }
    // Kühlbox
    const km = mat4.multiply(mat4.create(), bm, M(-1.05, 0, 0));
    box([0, 0.25, 0], [0.5, 0.5, 0.38], km, COL.green, D(0.4, 0));
    box([0, 0.51, 0], [0.52, 0.04, 0.4], km, COL.cream, D(0.5, 0));
    box([0, 0.3, 0.192], [0.22, 0.12, 0.01], km, COL.gold, D(0.3, 5));
    // Schlägertasche am Boden
    const sm = mat4.multiply(mat4.create(), bm, M(0, 0, 0.62, 0.1));
    mb.add(roundedBox(0.84, 0.27, 0.29, 0.134, 4), mat4.multiply(mat4.create(), sm, M(0, 0.135, 0)), pi ? COL.orange : COL.lightBlue, D(0.55, 0));
    mb.add(roundedBox(0.86, 0.06, 0.31, 0.03, 2), mat4.multiply(mat4.create(), sm, M(0, 0.2, 0)), COL.dark, D(0.5, 0));
    for (const hx of [-0.12, 0.12]) mb.tube(vec3.transformMat4([], [hx, 0.27, 0], sm), vec3.transformMat4([], [hx, 0.33, 0], sm), 0.012, 6, COL.dark, D(0.5, 0));
    mb.tube(vec3.transformMat4([], [-0.12, 0.33, 0], sm), vec3.transformMat4([], [0.12, 0.33, 0], sm), 0.012, 6, COL.dark, D(0.5, 0));
    // Handtuch auf dem Boden
    box([0.2, 0.012, 0.95], [0.5, 0.024, 0.3], bm, towelCols[pi][0], D(0.95, 0));
  }

  // ---------------------------------------------------------------- Balljungen/-mädchen
  const kidC = (skin, hair) => ({
    top: COL.green, sleeve: COL.green, forearm: skin, bottom: COL.cream, leg: skin, skin, hair, shoe: COL.shoe,
    hat: 'cap', hatCol: COL.green, collar: COL.gold,
  });
  const kids = [
    { pose: 'crouch', x: -6.75, z: 1.15, yaw: Math.PI / 2 + 0.25, c: kidC(COL.skinB, COL.hairA) },
    { pose: 'crouch', x: 6.75, z: -1.15, yaw: -Math.PI / 2 + 0.25, c: kidC(COL.skinA, COL.hairC) },
    { pose: 'stand', x: -7.4, z: -17.7, yaw: 0.35, c: kidC(COL.skinC, COL.hairA) },
    { pose: 'stand', x: 7.4, z: 17.7, yaw: Math.PI + 0.35, c: kidC(COL.skinA, COL.hairB) },
    { pose: 'stand', x: 7.4, z: -17.7, yaw: -0.35, c: kidC(COL.skinB, COL.hairB) },
    { pose: 'stand', x: -7.4, z: 17.7, yaw: Math.PI - 0.35, c: kidC(COL.skinA, COL.hairA) },
  ];
  for (const k of kids) addFigure(mb, k.pose, k.c, M(k.x, 0, k.z, k.yaw, 0.82));

  // ---------------------------------------------------------------- Linienrichter (sitzend) mit Stühlen
  const judgeC = (skin, hair) => ({
    top: COL.green, sleeve: COL.green, bottom: COL.cream, skin, hair, shoe: COL.brown, collar: COL.white,
    hat: 'panama', hatCol: COL.cream, hatBand: COL.green,
  });
  const judges = [
    { x: 4.115, z: -17.75, yaw: 0, c: judgeC(COL.skinA, COL.hairC) },
    { x: -4.115, z: 17.75, yaw: Math.PI, c: judgeC(COL.skinB, COL.hairA) },
    { x: L.wallX - 0.6, z: -11.885, yaw: -Math.PI / 2, c: judgeC(COL.skinC, COL.hairA) },
    { x: L.wallX - 0.6, z: 11.885, yaw: -Math.PI / 2, c: judgeC(COL.skinA, COL.hairB) },
  ];
  for (const j of judges) {
    const jm = M(j.x, 0, j.z, j.yaw);
    for (const [lx, lz] of [[-0.2, -0.18], [0.2, -0.18], [-0.2, 0.18], [0.2, 0.18]]) box([lx, 0.22, lz], [0.03, 0.44, 0.03], jm, COL.green, dG);
    box([0, 0.46, 0], [0.46, 0.05, 0.42], jm, COL.green, dG);
    box([0, 0.72, -0.2], [0.46, 0.46, 0.04], jm, COL.green, dG);
    addFigure(mb, 'seated', j.c, mat4.multiply(mat4.create(), jm, M(0, -0.02, -0.02)));
  }

  // ---------------------------------------------------------------- TV-Kameras
  const camRig = (m, operator) => {
    // Stativ
    const top = vec3.transformMat4([], [0, 1.25, 0], m);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      mb.tube(vec3.transformMat4([], [Math.cos(a) * 0.4, 0, Math.sin(a) * 0.4], m), top, 0.018, 6, COL.dark, D(0.4, 5));
    }
    box([0, 1.32, 0], [0.16, 0.12, 0.16], m, COL.dark, D(0.4, 5));
    box([0, 1.48, -0.1], [0.24, 0.26, 0.5], m, hex('#2a2d30'), D(0.45, 5));
    mb.tube(vec3.transformMat4([], [0, 1.5, 0.15], m), vec3.transformMat4([], [0, 1.5, 0.62], m), 0.075, 12, hex('#e8e8e4'), D(0.35, 0), true);
    mb.tube(vec3.transformMat4([], [0, 1.5, 0.6], m), vec3.transformMat4([], [0, 1.5, 0.66], m), 0.085, 12, COL.dark, D(0.3, 0), true);
    box([0.18, 1.55, -0.22], [0.12, 0.16, 0.12], m, COL.dark, D(0.4, 5));
    if (operator) addFigure(mb, 'stand', { top: COL.dark, bottom: hex('#2a3140'), skin: COL.skinB, hair: COL.hairA, shoe: COL.dark, hat: 'cap', hatCol: COL.dark }, mat4.multiply(mat4.create(), m, M(-0.05, 0, -0.75)));
  };
  // Eckkameras auf dem Rasen (hinter den Grundlinien)
  camRig(M(-L.wallX + 0.9, 0, -L.wallZ + 1.4, Math.atan2(L.wallX - 0.9 - 2, L.wallZ - 1.4)), true);
  camRig(M(L.wallX - 0.9, 0, L.wallZ - 1.4, Math.atan2(-(L.wallX - 0.9) + 2, -(L.wallZ - 1.4))), true);
  // Führungskameras auf Podesten in den Stirntribünen (seitlich versetzt)
  for (const sz of [1, -1]) {
    const pz = sz * (L.wallZ + 2.6), py = L.end.floor0 + 3 * L.end.rise + 0.05;
    const pm = M(sz > 0 ? -4.85 : 4.85, py, pz, sz > 0 ? Math.PI : 0);
    box([0, -0.6, 0], [2.0, 1.2, 1.8], pm, COL.green, D(0.6, 0));
    box([0, 0.02, 0], [2.1, 0.06, 1.9], pm, COL.cream, D(0.7, 0));
    mb.tube(vec3.transformMat4([], [-1.0, 0.05, 0.9], pm), vec3.transformMat4([], [1.0, 0.05, 0.9], pm), 0.02, 6, COL.metal, D(0.4, 5));
    camRig(mat4.multiply(mat4.create(), pm, M(0, 0.05, 0.3)), true);
  }
  // Netzkamera (klein, am Pfosten Ost)
  box([6.62, 0.12, 0.25], [0.12, 0.1, 0.18], null, COL.dark, D(0.4, 5));
  mb.tube([6.62, 0.13, 0.15], [6.62, 0.13, 0.08], 0.03, 10, COL.dark, D(0.3, 0), true);

  // ---------------------------------------------------------------- Meshes
  const mesh = r.createMesh(mb.finish());
  const headMesh = r.createMesh(headMB.finish());
  const headModel = mat4.create();
  const headDrawable = { mesh: headMesh, material: opts.structMaterial, model: headModel, bounds: { center: [0, 0.1, 0], radius: 0.4 } };
  const drawables = [
    { mesh, material: opts.structMaterial },
    headDrawable,
  ];
  // ---------------------------------------------------------------- Schiedsrichter-Blick
  const look = { yaw: 0, pitch: 0.25, tYaw: 0, tPitch: 0.25, target: null, manual: 0 };
  const aim = (pos) => {
    if (!pos) { look.tYaw = 0; look.tPitch = 0.2; return; }
    const dx = pos[0] - neckWorld[0], dy = pos[1] - neckWorld[1], dz = pos[2] - neckWorld[2];
    const yaw = Math.atan2(dx, dz) - umpYaw0;
    const y = ((yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    look.tYaw = Math.max(-1.3, Math.min(1.3, y));
    look.tPitch = Math.max(-0.3, Math.min(0.6, Math.atan2(-dy, Math.hypot(dx, dz))));
  };
  const updateHead = () => {
    mat4.fromYawTranslation(headModel, umpYaw0 + look.yaw, neckWorld);
    mat4.rotateX(headModel, headModel, look.pitch);
  };
  updateHead();
  const umpire = {
    position: neckWorld,
    /** Kopf zum Punkt drehen (null = geradeaus). Übersteuert das automatische Ballfolgen für 0.5 s. */
    lookAt(pos) { aim(pos); look.manual = 0.5; },
    /** Automatisches Ballfolgen (von world.update aufgerufen, wenn kein manuelles lookAt aktiv ist). */
    autoLook(pos) { if (look.manual <= 0) aim(pos); },
    update(dt) {
      look.manual -= dt;
      look.yaw = damp(look.yaw, look.tYaw, 7, dt);
      look.pitch = damp(look.pitch, look.tPitch, 7, dt);
      updateHead();
    },
  };
  return { drawables, umpire, stats: { tris: mb.idx.length / 3 } };
}

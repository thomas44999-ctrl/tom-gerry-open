// Gerry – anthropomorpher orange Tabby-Kater, Tennisspieler (ARCHITECTURE §5.4). Chibi-Proportionen
// (Mario-Tennis-Stil): großer runder Kopf, große runde Augen mit runden Pupillen, kurzer runder Körper, große Pfoten.
//
//   const asset = buildGerry(renderer, renderer.q);      // CharacterAsset
//   const cpu = buildGerryMeshes({ furShells: 20 });     // nur CPU-Daten (Node-Tests), ohne Renderer
//
// Aufbau:
//   * Körper = SDF-Sculpt (sdf.js) -> Basis-Mesh (8 mm Zellen, low 10.5 / medium 9 mm) mit Kleidung
//     (Material `gerry-body`, Zweige je Material-Klasse). Grenzen Fell/Stirnband/Schweißband/Shorts, Pfotenballen,
//     Lidstrich und Shorts-Paspel werden analytisch im Shader (Bindpose-objPos) gezeichnet -> scharf bei jeder Auflösung.
//   * Fell  = Schalen (Shells) über einem per Vertex-Clustering (~13 mm) vergröberten Auszug der Fell-Dreiecke,
//             aufgeteilt in langes Fell (Wangen, Brustkrause, Hals, Schwanz, Ohrbüschel) und kurzes Fell
//             (unterschiedliche Schalenzahl). Schalenhöhe h = (id+1)/N. Strähnen = Zellrauschen an der
//             Wurzelposition (objPos, Bindpose), Büschelung, Kämmrichtung (pro Vertex), Schwerkraft (Welt),
//             Distanz-LOD (Strähnen-"Mip"-Stufen) gegen Sandpapier-Rauschen, Streu-Term gegen schmutzige Schatten.
//   * Gesicht/Details = Anbauteile (Augäpfel, Lider, Nase, Mund-ω, Schnurrhaare, Ohrbüschel), starr an Knochen.
//   * Sculpt-Farbkanal = Fellparameter [creme, länge, kamm, dichte]; die echte Fellfarbe (Tabby-Streifen) wird
//     danach pro Vertex berechnet; feine Kopf-Zeichnung ("M", Wangenlinien) im Shader.
//
// Erweiterungen gegenüber §5.4 (abwärtskompatibel):
//   gripSocket/leftHandGrip: { bone, offset, rotation, matrix, axis, palm } – wie tom.js:
//     Schläger-Weltmatrix = charModel * skel.world[bone] * matrix (+Y Schaft = Daumenrichtung, +Z = Handflächennormale).
//   face.update(dt, { blink, mood, lookDir }): blink undefined -> automatisches Blinzeln.
//   asset.furLod(screenPx) / asset.applyFurLod(drawables, screenPx): Schalenzahl nach Bildgröße (setzt d.shells und
//     d.uniforms.u_furShells – beide müssen zusammenpassen, wenn der Runtime die Schalenzahl ändert).

import { createSculpt, P, polygonize, alignQuat, along, raycast } from '../gfx/sdf.js';
import { defineSkeleton } from './skeleton.js';
import { sphere as geoSphere, tube as geoTube, merge as geoMerge } from '../gfx/geometry.js';
import { mat4, quat, hexToLinear, fbm3, clamp, smoothstep, makeRng, DEG } from '../core/math.js';

// ============================================================================ Konstanten

export const GERRY_HEIGHT = 1.34;   // inkl. Ohren

/** Material-IDs (mesh.data[0]). */
export const GERRY_MATS = Object.freeze({
  FUR: 0, SHORTS: 1, PIPING: 2, TERRY: 3, STRIPE: 4, NOSE: 5, PAD: 6, INNER_EAR: 7, CLAW: 8, DARK: 9,
  WHISKER: 10, LID: 11, MOUTH: 12, TONGUE: 13,
});
const M = GERRY_MATS;

/** Farbpalette (sRGB). */
export const GERRY_COLORS = Object.freeze({
  orange: '#E8822A', orangeLight: '#F09A45', stripe: '#B5541C', stripeDark: '#9A4416', cream: '#F6E7CF',
  nose: '#E79A9A', pad: '#DE8E93', innerEar: '#EDB2AA', shorts: '#F5F4EF', piping: '#F07D1E', terry: '#FBFAF6',
  green: '#1F9A55', dark: '#2B1B15', liner: '#3B2116', innerEarDeep: '#D98C8C', claw: '#EFE8DC', whisker: '#FBF8F2', mouth: '#5A2626', tongue: '#E77C86',
});

const mirrorX = (p) => [-p[0], p[1], p[2]];
const LEFT = {
  shoulder_l: [0.03, 0.70, -0.012], arm_l: [0.14, 0.688, -0.02], forearm_l: [0.243, 0.572, -0.008], hand_l: [0.326, 0.466, 0.025],
  thigh_l: [0.075, 0.405, 0.0], shin_l: [0.078, 0.238, 0.014], foot_l: [0.08, 0.074, -0.022], toe_l: [0.084, 0.024, 0.07],
};
/** Gelenke (Modellraum, A-Pose, Blick +Z, links = +X). */
export const GERRY_JOINTS = Object.freeze({
  root: [0, 0, 0], pelvis: [0, 0.44, -0.01], spine: [0, 0.52, -0.016], chest: [0, 0.62, -0.02],
  neck: [0, 0.73, -0.02], head: [0, 0.775, -0.004],
  ...LEFT,
  ...Object.fromEntries(Object.entries(LEFT).map(([k, v]) => [k.replace(/_l$/, '_r'), mirrorX(v)])),
});
/** Kopfskalierung (alle Kopf-Maße sind in "Einheitskopf"-Koordinaten relativ zu GERRY_HEAD_CENTER angegeben). */
export const GERRY_HEAD_SCALE = 1.72;
const HS = GERRY_HEAD_SCALE;
const HC0 = [0, 0.975, 0.008];
const hk = (o) => [HC0[0] + o[0] * HS, HC0[1] + o[1] * HS, HC0[2] + o[2] * HS];
const EAR_BASE = hk([0.078, 0.085, -0.033]), EAR_TIP = hk([0.124, 0.207, -0.05]);
// Jedes Segment mit |dir.z| > 0.8 -> einheitliche Gelenkrahmen (pose.js): Euler x > 0 hebt die Schwanzspitze.
// Ruhe: nach hinten-unten, dann J-förmig nach oben, leicht seitlich geschwungen (Spitze ~0.72 m).
const TAIL_PTS = [[0, 0.405, -0.1], [0, 0.37, -0.175], [0.006, 0.36, -0.258], [0.018, 0.382, -0.33], [0.032, 0.43, -0.38], [0.044, 0.495, -0.405], [0.05, 0.56, -0.41]];
/** Zusatzknochen: Schwanzkette tail_0..tail_5 (am Becken), Ohren (am Kopf). */
export const GERRY_EXTRAS = Object.freeze([
  ...TAIL_PTS.slice(0, 6).map((p, i) => ({ name: 'tail_' + i, parent: i ? 'tail_' + (i - 1) : 'pelvis', pos: p, ...(i === 5 ? { tip: TAIL_PTS[6] } : {}) })),
  { name: 'ear_l', parent: 'head', pos: EAR_BASE, tip: EAR_TIP },
  { name: 'ear_r', parent: 'head', pos: mirrorX(EAR_BASE), tip: mirrorX(EAR_TIP) },
]);
const TIPS = { head: [0, 1.2, 0.0], toe_l: [0.086, 0.022, 0.15], toe_r: [-0.086, 0.022, 0.15] };

/** Kopfzentrum (Schädelmitte) – Bezugspunkt für Gesicht und Shader-Zeichnung. */
export const GERRY_HEAD_CENTER = Object.freeze(HC0.slice());
const HC = GERRY_HEAD_CENTER;

export function buildGerrySkeletonDef() {
  return defineSkeleton({ joints: GERRY_JOINTS, extras: GERRY_EXTRAS.map((e) => ({ ...e })), tips: TIPS });
}

// ============================================================================ Vektor-Helfer (Build-Zeit)

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const nrm = (a) => scl(a, 1 / (len(a) || 1));
const madd = (...terms) => { const o = [0, 0, 0]; for (let i = 0; i < terms.length; i += 2) { const v = terms[i], s = terms[i + 1]; o[0] += v[0] * s; o[1] += v[1] * s; o[2] += v[2] * s; } return o; };
const hc = (o) => [HC[0] + o[0] * HS, HC[1] + o[1] * HS, HC[2] + o[2] * HS];
const kk = (x) => (Array.isArray(x) ? x.map((v) => v * HS) : x * HS);
/** Fellparameter als Sculpt-"Farbe": [creme 0..1, Länge 0..1, Kamm 0..1, Dichte 0..1]. */
const F = (cream, length, comb = 0.75, dens = 1) => [cream, length, comb, dens];
const NOFUR = [0, 0, 0, 0];

// ============================================================================ Gesichts-Geometrie (Augen)

const EYE = { r: 0.039 * HS, out: 10, up: 2, roll: 0, x: 0.046, y: -0.008, z: 0.07, protrude: 0.004 * HS };
const LID = { gap: 0.0016, azA: 60, top: 58, bot: -50, corner: -2, azMax: 92, elMax: 140, grow: 0.8 };

/** Lidkanten (Grad Elevation) als Funktion des Azimuts (Grad) im Augen-Rahmen; jenseits der Winkel kreuzen sie. */
function lidEdgeUp(az) {
  const u = az / LID.azA, au = Math.abs(u);
  if (au < 1) return LID.corner + (LID.top - LID.corner) * Math.pow(1 - u * u, 0.62) + (u > 0 ? 2.5 * u : 1.5 * u);
  return LID.corner + (u > 0 ? 2.5 : -1.5) - (au - 1) * 32;
}
function lidEdgeLo(az) {
  const u = az / LID.azA, au = Math.abs(u);
  if (au < 1) return LID.corner + (LID.bot - LID.corner) * Math.pow(1 - u * u, 0.8) + (u > 0 ? 2.0 * u : 0);
  return LID.corner + (u > 0 ? 2.0 : 0) + (au - 1) * 32;
}

/** Augen-Rahmen (links): Achsen x = lateral, y = oben, z = Blick. */
function eyeFrameLeft() {
  const f = nrm([Math.sin(EYE.out * DEG), Math.sin(EYE.up * DEG), Math.cos(EYE.out * DEG)]);
  let x = nrm(cross([0, 1, 0], f));
  let y = cross(f, x);
  const r = EYE.roll * DEG, c = Math.cos(r), s = Math.sin(r);
  const x2 = add(scl(x, c), scl(y, s)), y2 = add(scl(x, -s), scl(y, c));
  return { x: x2, y: y2, z: f };
}

// ============================================================================ Sculpt

function addHeadVolumes(S) {
  S.with({ bone: 'head', mat: M.FUR, skinBlend: 0.035 }, () => {
    S.add(P.ellipsoid(hc([0, 0.012, -0.016]), kk([0.117, 0.098, 0.104])), { color: F(0, 0.3, 0.85) });               // Schädel
    S.add(P.ellipsoid(hc([0, -0.034, 0.006]), kk([0.126, 0.074, 0.09])), { blend: kk(0.05), color: F(0, 0.45, 0.6) });    // Wangenpartie
    S.add(P.ellipsoid(hc([0, 0.044, 0.048]), kk([0.08, 0.055, 0.056])), { blend: kk(0.045), color: F(0, 0.2, 0.9) });      // Stirn
    // Wangenkrause (Büschel nach außen-unten)
    S.add(P.roundCone(hc([0.085, -0.04, -0.006]), hc([0.132, -0.07, -0.024]), kk(0.04), kk(0.016)), { blend: kk(0.04), color: F(0.12, 0.85, 0.32), mirror: true });
    S.add(P.roundCone(hc([0.072, -0.066, 0.004]), hc([0.105, -0.1, -0.012]), kk(0.034), kk(0.014)), { blend: kk(0.036), color: F(0.6, 0.8, 0.32), mirror: true });
    // Nasenrücken
    S.add(P.capsule(hc([0, 0.016, 0.092]), hc([0, -0.024, 0.105]), kk(0.0175)), { blend: kk(0.032), color: F(0, 0.1, 0.95) });
    // Schnurrhaarpolster + Oberlippe + Kinn
    S.add(P.sphere(hc([0.025, -0.054, 0.093]), kk(0.032)), { blend: kk(0.022), color: F(1, 0.0, 0.9), mirror: true });
    S.add(P.sphere(hc([0, -0.046, 0.102]), kk(0.015)), { blend: kk(0.018), color: F(1, 0.0, 0.9) });
    S.add(P.ellipsoid(hc([0, -0.087, 0.07]), kk([0.022, 0.014, 0.019])), { blend: kk(0.022), color: F(1, 0.08, 0.8) });
    // Unterlid-Wulst + Brauenbogen (fassen das Auge ein)
    S.add(P.ellipsoid(hc([0.05, -0.034, 0.08]), kk([0.034, 0.016, 0.024]), [0, 0, 10]), { blend: kk(0.026), color: F(0.45, 0.12, 0.9), mirror: true });
    S.add(P.ellipsoid(hc([0.047, 0.05, 0.078]), kk([0.03, 0.01, 0.016]), [0, 0, 8]), { blend: kk(0.03), color: F(0.2, 0.16, 0.9), mirror: true });
    S.add(P.ellipsoid(hc([0, -0.074, 0.016]), kk([0.074, 0.038, 0.058])), { blend: kk(0.04), color: F(1, 0.32, 0.8) }); // Kiefer/Kehle
  });
}

function addEars(S) {
  // Ohr links (gespiegelt rechts): flach gedrückter Kegel, vorn flach ausgehöhlt (rosa Innenseite)
  const B = EAR_BASE, T = EAR_TIP;
  const v = nrm(sub(T, B));
  const w0 = [Math.sin(26 * DEG), 0.08, Math.cos(26 * DEG)];
  const w = nrm(sub(w0, scl(v, dot(w0, v))));
  S.group({ bone: 'ear_l', mat: M.FUR, skinBlend: 0.014, blend: 0.024, childBlend: 0.007, color: F(0, 0.22, 0.85), mirror: true }, (g) => {
    g.add(P.roundCone(madd(B, 1, v, -0.014 * HS), T, 0.056 * HS, 0.0075 * HS));
    g.intersect(P.plane(madd(B, 1, w, 0.0098 * HS), w));
    g.intersect(P.plane(madd(B, 1, w, -0.0115 * HS), scl(w, -1)));
    g.subtract(P.ellipsoid(madd(B, 1, v, 0.052 * HS, w, 0.0128 * HS), kk([0.031, 0.062, 0.0115]), alignQuat(v, w)),
      { blend: 0.008, color: NOFUR, mat: M.INNER_EAR });
  });
  // Ohrbüschel: unterer/innerer Teil der Muschel mit langem, lockerem, cremeweißem Fell (nach oben gekämmt)
  S.paint(P.ellipsoid(madd(B, 1, v, 0.012 * HS, w, 0.012 * HS), kk([0.032, 0.034, 0.026]), alignQuat(v, w)),
    { mat: M.FUR, color: F(0.85, 0.8, 0.95, 0.5), colorBlend: 0.012, mirror: true });
  return { v, w };
}

/** Mandelförmiger Öffnungskegel ab Augenmitte (SDF-Näherung, konservativ). */
function almondCone(E, fr, grow) {
  return (x, y, z) => {
    const px = x - E[0], py = y - E[1], pz = z - E[2];
    const lx = px * fr.x[0] + py * fr.x[1] + pz * fr.x[2];
    const ly = px * fr.y[0] + py * fr.y[1] + pz * fr.y[2];
    const lz = px * fr.z[0] + py * fr.z[1] + pz * fr.z[2];
    const rr = Math.hypot(lx, ly, lz) || 1e-6;
    const az = Math.atan2(lx, lz) / DEG;
    const el = Math.asin(clamp(ly / rr, -1, 1)) / DEG;
    const sd = Math.max(el - (lidEdgeUp(az) + grow), (lidEdgeLo(az) - grow) - el);
    return Math.max(sd * DEG * rr * 0.5, 0.004 - lz, rr - 0.09);
  };
}

function addEyeSockets(S, eyes) {
  for (const e of eyes) {
    const { E, fr } = e;
    const fn = almondCone(E, e.side === 'l' ? fr : fr, LID.grow);
    S.subtract(P.custom(fn, sub(E, [0.08, 0.08, 0.08]), add(E, [0.08, 0.08, 0.08])), { blend: 0.003, color: F(-1, 0.0, 0.9), colorBlend: 0.002, mat: M.FUR, name: 'socket' });
  }
}

function quatFromBasis(x, y, z) {
  const q = quat.fromMat3(quat.create(), [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]]);
  quat.normalize(q, q);
  return [q[0], q[1], q[2], q[3]];
}

/** Augenpositionen per Raycast auf den Kopf (ohne Höhlen) bestimmen. */
function placeEyes() {
  const S = createSculpt({ blend: 0.02 });
  addHeadVolumes(S);
  const fr = eyeFrameLeft();
  const guess = hc([EYE.x, EYE.y, EYE.z]);
  const o = madd(guess, 1, fr.z, 0.25);
  const hit = raycast(S, o, scl(fr.z, -1), 0.5);
  const surf = hit ? hit.pos : madd(guess, 1, fr.z, 0.03);
  const E = madd(surf, 1, fr.z, -(EYE.r - EYE.protrude));
  // rechts: gespiegelt; x-Achse bleibt "lateral" -> Rahmen ist dann linkshändig, daher Lider/Iris per Spiegelmesh
  const frR = { x: mirrorX(fr.x), y: mirrorX(fr.y), z: mirrorX(fr.z) };
  return [{ side: 'l', E, fr }, { side: 'r', E: mirrorX(E), fr: frR }];
}

/** Stirnband-Rahmen: Mitte c, Normale N (geneigt, vorn tiefer), Achsen X/Z, halbe Breite, Dicke. */
export function headbandFrame() {
  // vorn auf der Stirn knapp über den Brauen, hinten tiefer (sitzt um den Hinterkopf, unter den Ohren durch)
  const tilt = 13;
  const c = hc([0, 0.038, -0.01]);
  const N = [0, Math.cos(tilt * DEG), -Math.sin(tilt * DEG)];
  const X = [1, 0, 0], Z = cross(X, N);
  const k = HS / 1.22;
  return { tilt, c, N, X, Z, half: 0.0152 * k, th: 0.0105 * k, stripe: 0.0038 * k };
}

/** Saum der Shorts als Anteil der Oberschenkellänge (Hüfte -> Knie). */
const SHORTS_HEM = 0.52;

/** Shorts-Paspel (analytisch im Shader): Bund-Höhe, Saum entlang Oberschenkel, Seitennaht-z. */
export function shortsPiping(J = GERRY_JOINTS) {
  const T = J.thigh_l, K = J.shin_l;
  const L = len(sub(K, T));
  return {
    waistY: SHORTS_TOP - 0.025, waistHalf: 0.0035, thigh: T.slice(), dir: nrm(sub(K, T)), hem0: (SHORTS_HEM - 0.04) * L, hem1: (SHORTS_HEM - 0.016) * L,
    seamZ: -0.012, seamHalf: 0.0045, top: SHORTS_TOP, hemT: SHORTS_HEM * L + 0.0025,
  };
}
/** Oberkante des Bunds (Modell-y), für die analytische Fell/Shorts-Grenze. */
const SHORTS_TOP = 0.505;

/** Schweißband-Achse (linker Arm; rechts gespiegelt): Startpunkt a, Richtung d, Bereich t = [t0, t1] (m). */
export function wristbandAxis(J = GERRY_JOINTS) {
  const a = along(J.forearm_l, J.hand_l, WB[0]), b = along(J.forearm_l, J.hand_l, WB[1]);
  const L = len(sub(b, a));
  return { a, d: nrm(sub(b, a)), t: [0.002, L - 0.002], b };
}
const WB = [0.66, 0.96];

/** Gesamter Körper-Sculpt. */
export function buildGerrySculpt(J = GERRY_JOINTS, eyes = placeEyes()) {
  const S = createSculpt({ blend: 0.02, skinBlend: 0.04, mat: M.FUR, color: F(0, 0.42, 0.8), tag: 0 });
  const info = { eyes };

  addHeadVolumes(S);
  info.ear = addEars(S);
  // Augenumrandung heller, Schnauze/Kinn creme
  for (const e of eyes) S.paint(P.ellipsoid(madd(e.E, 1, e.fr.z, 0.016, e.fr.y, -0.005), kk([0.042, 0.034, 0.03]), quatFromBasis(e.fr.x, e.fr.y, e.fr.z)), { color: F(0.5, 0.1, 0.9), colorBlend: 0.014, mat: M.FUR });
  S.paint(P.ellipsoid(hc([0, -0.068, 0.08]), kk([0.062, 0.038, 0.05])), { color: F(1, 0.05, 0.9), colorBlend: 0.016, mat: M.FUR });
  addEyeSockets(S, eyes);

  // ---- Stirnband (Frottee): Ring, dessen Radius pro Winkel dem Kopf folgt (Tabelle per Raycast), auf geneigten
  //      Streifen begrenzt. Grüner Mittelstreifen analytisch im Shader (u_band*).
  {
    const HS = createSculpt({ blend: 0.02 }); addHeadVolumes(HS);
    const band = headbandFrame();
    const { c, N, X, Z, half, th } = band;
    const NA = 72, R = new Float32Array(NA + 1);
    // Kopfradius je Winkel: Maximum über die ganze Bandbreite (sonst ragt die gewölbte Stirn durch das Band)
    for (let k = 0; k <= NA; k++) {
      const a = (k / NA) * Math.PI * 2;
      const dir = madd(X, Math.sin(a), Z, Math.cos(a));
      let rMax = 0.1;
      for (const hh of [-1, -0.5, 0, 0.5, 1]) {
        const o = madd(c, 1, N, hh * (half + 0.004));
        const hit = raycast(HS, madd(o, 1, dir, 0.4), scl(dir, -1), 0.5);
        if (hit) rMax = Math.max(rMax, 0.4 - hit.t);
      }
      R[k] = rMax;
    }
    const bandFn = (x, y, z) => {
      const rx = x - c[0], ry = y - c[1], rz = z - c[2];
      const h = rx * N[0] + ry * N[1] + rz * N[2];
      const px = rx * X[0] + ry * X[1] + rz * X[2], pz = rx * Z[0] + ry * Z[1] + rz * Z[2];
      let a = Math.atan2(px, pz); if (a < 0) a += Math.PI * 2;
      const f = (a / (Math.PI * 2)) * NA, i0 = Math.floor(f), t = f - i0;
      const rr = R[i0] + (R[Math.min(i0 + 1, NA)] - R[i0]) * t;
      const d = Math.hypot(px, pz) - rr - th;
      const sd = Math.abs(h) - half;
      const k = 0.009, hm = Math.max(k - Math.abs(d - sd), 0) / k;
      return Math.max(d, sd) + hm * hm * k * 0.25;
    };
    const ext = 0.3;   // Rechenbereich (Kopf + Band, großer Chibi-Kopf)
    S.paint(P.box(c, [ext, half + 0.014, ext], [-band.tilt, 0, 0]), { mat: M.FUR, color: F(0, 0.1, 0.95), colorBlend: 0.01, name: 'bandFurShort' });
    S.add(P.custom(bandFn, add(c, [-ext, -0.09, -ext]), add(c, [ext, 0.09, ext])),
      { bone: 'head', mat: M.TERRY, color: NOFUR, blend: 0.0025, colorBlend: 0.0008, skinBlend: 0.03, name: 'headband' });
    info.headband = band;
  }

  // ---- Hals + Rumpf (kurz, rund; Bauch etwas vorgewölbt)
  S.add(P.capsule(add(J.neck, [0, -0.03, 0.0]), add(J.head, [0, 0.04, 0.0]), 0.068), { bone: 'neck', blend: 0.04, skinBlend: 0.045, color: F(0.3, 0.75, 0.5) });
  S.with({ blend: 0.05, skinBlend: 0.07 }, () => {
    S.add(P.ellipsoid([0, 0.63, -0.004], [0.146, 0.118, 0.112]), { bone: 'chest', color: F(0, 0.44, 0.75) });
    S.add(P.capsule([-0.098, 0.68, -0.02], [0.098, 0.68, -0.02], 0.056), { bone: 'chest', blend: 0.06, color: F(0, 0.42, 0.8) });
    S.add(P.ellipsoid([0, 0.66, 0.062], [0.085, 0.078, 0.05]), { bone: 'chest', color: F(1, 0.85, 0.4) });             // Brustkrause
    S.add(P.ellipsoid([0, 0.72, 0.045], [0.075, 0.05, 0.05]), { bone: { neck: 0.6, chest: 0.4 }, color: F(1, 0.8, 0.4) });
    S.add(P.ellipsoid([0, 0.53, 0.016], [0.148, 0.112, 0.124]), { bone: 'spine', color: F(0, 0.4, 0.8) });               // Bauch
    S.add(P.ellipsoid([0, 0.58, -0.04], [0.126, 0.09, 0.08]), { bone: { spine: 0.5, chest: 0.5 }, color: F(0, 0.42, 0.85) });
  });

  // ---- Shorts (weiß, orange Paspel) + Schwanzloch
  S.with({ mat: M.SHORTS, color: NOFUR, blend: 0.03, skinBlend: 0.06 }, () => {
    S.add(P.ellipsoid([0, 0.44, -0.012], [0.142, 0.086, 0.114]), { bone: 'pelvis' });
    S.add(P.torus([0, SHORTS_TOP - 0.012, 0.004], 0.132, 0.0105, null, [1, 1, 0.9]), { bone: { pelvis: 1, spine: 0.35 }, blend: 0.012 });   // Bund
    S.add(P.sphere(add(J.thigh_l, [-0.02, 0.0, -0.04]), 0.07), { bone: { pelvis: 1, thigh_l: 0.4 }, mirror: true });
    S.add(P.ellipsoid([0, 0.385, -0.008], [0.058, 0.044, 0.07]), { bone: { pelvis: 1, thigh_l: 0.3, thigh_r: 0.3 }, blend: 0.04 });   // Schritt
    S.add(P.ellipsoid([0.055, 0.425, -0.065], [0.072, 0.075, 0.064]), { bone: { pelvis: 1, thigh_l: 0.35 }, mirror: true, blend: 0.05 });   // Gesäß
  });
  // Materialgrenze Bund/Fell exakt auf y = SHORTS_TOP (passt zur analytischen Shader-Maske)
  S.paint(P.box([0, SHORTS_TOP - 0.03, 0], [0.19, 0.03, 0.25]), { mat: M.SHORTS, color: NOFUR, colorBlend: 0 });
  S.paint(P.box([0, SHORTS_TOP + 0.03, 0], [0.19, 0.03, 0.25]), { mat: M.FUR, color: F(0, 0.42, 0.8), colorBlend: 0 });
  // Bauch creme (nur oberhalb des Bunds)
  {
    const c = [0, 0.6, 0.09], r = [0.08, 0.15, 0.07];
    const fn = (x, y, z) => {
      const qx = (x - c[0]) / r[0], qy = (y - c[1]) / r[1], qz = (z - c[2]) / r[2];
      return Math.max((Math.hypot(qx, qy, qz) - 1) * 0.07, SHORTS_TOP + 0.002 - y);
    };
    S.paint(P.custom(fn, sub(c, r), add(c, r)), { color: F(1, 0.4, 0.8), colorBlend: 0.03, mat: M.FUR });
  }
  for (const mir of [false, true]) {
    const run = (B) => {
      const T = J.thigh_l, K = J.shin_l;
      const dt = nrm(sub(K, T));
      B.group({ mat: M.SHORTS, color: NOFUR, bone: 'thigh_l', skinBlend: 0.06, blend: 0.03, childBlend: 0.004 }, (g) => {
        g.add(P.roundCone(add(T, [0.008, 0.035, -0.006]), along(T, K, SHORTS_HEM + 0.05, [0.006, 0, 0.003]), 0.088, 0.08));
        g.intersect(P.plane(along(T, K, SHORTS_HEM), dt));
      });
    };
    if (mir) S.mirrored(run); else run(S);
  }

  // ---- Arme + Pfoten (Faust)
  info.grip = {};
  for (const mir of [false, true]) {
    const run = (B) => {
      const A = J.arm_l, Fo = J.forearm_l, H = J.hand_l;
      const da = nrm(sub(Fo, A)), df = nrm(sub(H, Fo));
      B.add(P.sphere(add(A, [0.004, 0.006, 0.002]), 0.052), { bone: 'arm_l', blend: 0.05, skinBlend: 0.05, color: F(0, 0.42, 0.8) });   // Schulter
      B.add(P.roundCone(A, Fo, 0.045, 0.037), { bone: 'arm_l', blend: 0.022, skinBlend: 0.04, color: F(0, 0.42, 0.8) });
      B.add(P.sphere(Fo, 0.037), { bone: 'forearm_l', blend: 0.02, skinBlend: 0.035, color: F(0, 0.4, 0.8) });
      B.add(P.roundCone(Fo, H, 0.039, 0.033), { bone: 'forearm_l', blend: 0.02, skinBlend: 0.035, color: F(0, 0.38, 0.85) });
      // Schweißband
      B.add(P.cylinder(along(Fo, H, WB[0]), along(Fo, H, WB[1]), 0.043, 0.009), { bone: 'forearm_l', mat: M.TERRY, color: NOFUR, blend: 0.003, skinBlend: 0.03 });
      // Faust: a = Handachse, t = Daumen/Griffrichtung (vorn), pn = Handflächenseite (medial)
      const a = df;
      const t = nrm(sub([0, 0, 1], scl(a, a[2])));
      const pn = nrm(cross(a, t));
      const hq = alignQuat(a, t);
      const PS = 1.3; // große, runde Pfoten (Cartoon)
      const at = (sa, st, sp) => madd(H, 1, a, sa * PS, t, st * PS, pn, sp * PS);
      B.group({ bone: 'hand_l', skinBlend: 0.025, blend: 0.022, childBlend: 0.014, color: F(1, 0.15, 0.85) }, (g) => {
        g.add(P.ellipsoid(at(0.036, 0.0, 0.004), [0.038 * PS, 0.046 * PS, 0.044 * PS], hq));
        for (let k = 0; k < 4; k++) {
          const o = -0.027 + k * 0.018;
          g.add(P.capsule(at(0.066, o, -0.006), at(0.06, o * 0.95, 0.024), 0.0145 * PS), { blend: 0.008 });
        }
        g.add(P.capsule(at(0.008, 0.033, 0.013), at(0.044, 0.042, 0.032), 0.014 * PS), { blend: 0.012 });
      });
      const G = at(0.047, 0.0, 0.0165);
      const side = B === S ? 'l' : 'r';
      info.grip[side] = { G, a, t, pn };
      if (B !== S) B.subtract(P.cylinder(madd(G, 1, t, -0.08), madd(G, 1, t, 0.08), 0.0128), { blend: 0.003, color: F(0.8, 0.0, 0.9), mat: M.FUR, name: 'gripHole' });
    };
    if (mir) S.mirrored(run); else run(S);
  }
  if (info.grip.r) {
    const g = info.grip.r;
    info.grip.r = { G: mirrorX(g.G), a: mirrorX(g.a), t: mirrorX(g.t), pn: mirrorX(g.pn) };
  }

  // ---- Beine + Füße (kurz, rund; große Katzenpfoten mit Zehenballen)
  for (const mir of [false, true]) {
    const run = (B) => {
      const T = J.thigh_l, K = J.shin_l, Fo = J.foot_l, To = J.toe_l;
      const dt = nrm(sub(K, T)), ds = nrm(sub(Fo, K));
      B.add(P.roundCone(add(T, [0.004, 0.02, -0.004]), K, 0.072, 0.05), { bone: 'thigh_l', blend: 0.03, skinBlend: 0.05, color: F(0, 0.45, 0.8) });
      B.add(P.ellipsoid(along(T, K, 0.45, [0.004, 0, 0.01]), [0.066, 0.09, 0.062], alignQuat(dt, [0, 0, 1])), { bone: 'thigh_l', blend: 0.03, color: F(0, 0.45, 0.8) });
      B.add(P.sphere(add(K, [0, 0.004, 0.012]), 0.046), { bone: 'shin_l', blend: 0.03, skinBlend: 0.04, color: F(0, 0.4, 0.8) });
      B.add(P.roundCone(K, Fo, 0.046, 0.036), { bone: 'shin_l', blend: 0.02, skinBlend: 0.04, color: F(0, 0.4, 0.85) });
      B.add(P.ellipsoid(along(K, Fo, 0.32, [0, 0, -0.016]), [0.048, 0.075, 0.05], alignQuat(ds, [0, 0, 1])), { bone: 'shin_l', blend: 0.03, color: F(0, 0.44, 0.8) });
      // Pfote: groß, rund, vier getrennte Zehen
      const FS = 1.18;
      B.group({ bone: 'foot_l', skinBlend: 0.03, blend: 0.03, childBlend: 0.014, color: F(1, 0.2, 0.85) }, (g) => {
        g.add(P.sphere(add(Fo, [0, -0.028, -0.024]), 0.052 * FS));
        g.add(P.ellipsoid(add(Fo, [0.002, -0.04, 0.042]), [0.06 * FS, 0.046 * FS, 0.078 * FS]));
        for (let k = 0; k < 4; k++) {
          const dx = [-0.038, -0.013, 0.013, 0.038][k] * FS, dz = [0.02, 0.034, 0.034, 0.02][k] * FS;
          g.add(P.ellipsoid(add(To, [dx, 0.006, dz]), [0.023 * FS, 0.024 * FS, 0.027 * FS]), { bone: 'toe_l', skinBlend: 0.015, blend: 0.005 });
        }
        g.intersect(P.plane([0, 0.0, 0], [0, -1, 0]), { blend: 0.006 });
      });
      // Sohle: kurzes Fell; Zehen-/Hauptballen werden analytisch im Shader gezeichnet (gerryPadMask)
      B.paint(P.box([Fo[0], 0.004, Fo[2] + 0.07], [0.08, 0.012, 0.13]), { color: F(1, 0.12, 0.6), colorBlend: 0.01, mat: M.FUR });
    };
    if (mir) S.mirrored(run); else run(S);
  }

  // ---- Schwanz (Kette tail_0..5), Spitze creme
  // Schwanzloch: gesäumter Rand in den Shorts
  {
    const d = nrm(sub(TAIL_PTS[1], TAIL_PTS[0]));
    S.add(P.torus(along(TAIL_PTS[0], TAIL_PTS[1], 0.3), 0.045, 0.0065, alignQuat(d, [0, 1, 0])),
      { bone: { pelvis: 1, tail_0: 0.25 }, mat: M.SHORTS, color: NOFUR, blend: 0.006, skinBlend: 0.03, name: 'tailHole' });
  }
  const tr = [0.036, 0.038, 0.039, 0.039, 0.038, 0.035, 0.026];
  for (let i = 0; i < 6; i++) {
    S.add(P.roundCone(TAIL_PTS[i], TAIL_PTS[i + 1], tr[i], tr[i + 1]), { bone: 'tail_' + i, blend: i === 0 ? 0.012 : 0.02, skinBlend: 0.055, color: F(0, i === 0 ? 0.8 : 0.95, 0.55) });
  }
  S.paint(P.sphere(TAIL_PTS[6], 0.07), { color: F(1, 1.0, 0.5), colorBlend: 0.03, mat: M.FUR });
  return { sculpt: S, info };
}

// ============================================================================ Fell-Nachbearbeitung

const LIN = Object.fromEntries(Object.entries(GERRY_COLORS).map(([k, v]) => [k, hexToLinear(v)]));
const MAT_COLOR = {
  [M.SHORTS]: LIN.shorts, [M.PIPING]: LIN.piping, [M.TERRY]: LIN.terry, [M.STRIPE]: LIN.green, [M.NOSE]: LIN.nose,
  [M.PAD]: LIN.pad, [M.INNER_EAR]: LIN.innerEar, [M.CLAW]: LIN.claw, [M.DARK]: LIN.dark, [M.WHISKER]: LIN.whisker,
  [M.MOUTH]: LIN.mouth, [M.TONGUE]: LIN.tongue,
};

const band = (phase, th, soft) => smoothstep(th - soft, th + soft, 0.5 + 0.5 * Math.sin(phase));

/** Kategorien der Knochen für Muster/Kämmrichtung. */
function boneKinds(def) {
  return def.names.map((n) => {
    if (/^tail_/.test(n)) return 'tail';
    if (/^ear_/.test(n)) return 'ear';
    if (n === 'head') return 'head';
    if (/^(arm|forearm)_/.test(n)) return 'arm';
    if (/^hand_/.test(n)) return 'hand';
    if (/^(thigh|shin)_/.test(n)) return 'leg';
    if (/^(foot|toe)_/.test(n)) return 'foot';
    if (/^shoulder_/.test(n)) return 'shoulder';
    return 'torso';
  });
}

/** Bogenlänge entlang der Schwanzkette (für Ringe). */
function tailArc(p) {
  let best = 1e9, s = 0, acc = 0;
  for (let i = 0; i < 6; i++) {
    const a = TAIL_PTS[i], b = TAIL_PTS[i + 1];
    const ab = sub(b, a), L = len(ab);
    const t = clamp(dot(sub(p, a), ab) / (L * L), 0, 1);
    const q = madd(a, 1, ab, t);
    const d = len(sub(p, q));
    if (d < best) { best = d; s = acc + t * L; }
    acc += L;
  }
  return s;
}

/**
 * Pro Vertex: Fellfarbe (Tabby), Länge, Kämmrichtung (oktaedrisch in uvs), Kamm/Dichte (data.z/w).
 * Sculpt-Farbe enthält [creme, länge, kamm, dichte]; mesh.data[0] = Material.
 */
function furify(mesh, def, opts = {}) {
  const n = mesh.positions.length / 3;
  const pos = mesh.positions, nor = mesh.normals, col = mesh.colors, dat = mesh.data;
  const jn = mesh.joints, wt = mesh.weights;
  const kinds = boneKinds(def);
  const rest = def.rest, tip = def.tip;
  const outCol = new Float32Array(4 * n);
  const flow = new Float32Array(3 * n);
  const outData = new Float32Array(4 * n);
  const noseP = hc([0, -0.03, 0.11]);
  const orange = LIN.orange, stripeC = LIN.stripe, cream = LIN.cream, stripeD = LIN.stripeDark;
  const fl = [0, 0, 0];
  for (let v = 0; v < n; v++) {
    const px = pos[3 * v], py = pos[3 * v + 1], pz = pos[3 * v + 2];
    const nx = nor[3 * v], ny = nor[3 * v + 1], nz = nor[3 * v + 2];
    const mat = Math.round(dat[4 * v]);
    let creamM = col[4 * v], furLen = col[4 * v + 1], comb = col[4 * v + 2], dens = col[4 * v + 3];
    const liner = creamM < 0 ? Math.min(1, -creamM) : 0;
    if (liner > 0) creamM = 0;
    // ---- Muster + Fließrichtung über Skin-Gewichte gemischt
    let stripe = 0, wsum = 0, dark = 0, creamInner = 0;
    fl[0] = fl[1] = fl[2] = 0;
    const warp = (fbm3(px * 9 + 3.1, py * 9, pz * 9, 3) - 0.5);
    for (let k = 0; k < 4; k++) {
      const w = wt[4 * v + k]; if (w <= 0.001) continue;
      const b = jn[4 * v + k], kind = kinds[b];
      const jx = rest[3 * b], jy = rest[3 * b + 1], jz = rest[3 * b + 2];
      let dx = tip[3 * b] - jx, dy = tip[3 * b + 1] - jy, dz = tip[3 * b + 2] - jz;
      const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
      let s = 0, fx = 0, fy = -1, fz = 0;
      if (kind === 'torso' || kind === 'shoulder') {
        const back = smoothstep(0.55, -0.35, nz);
        const ph = py * 40 + 0.55 * Math.abs(px) * 40 * Math.abs(px) * 6 + warp * 6.5;
        s = band(ph, 0.6, 0.12) * back;
        // dunkler Rückenstrich
        dark += w * smoothstep(0.045, 0.006, Math.abs(px + warp * 0.02)) * smoothstep(-0.35, -0.8, nz) * 0.45;
        if (kind === 'shoulder') { fx = Math.sign(px) * 0.6; fy = -0.8; }
      } else if (kind === 'arm' || kind === 'leg') {
        const t = (px - jx) * dx + (py - jy) * dy + (pz - jz) * dz;
        const inner = smoothstep(-0.1, 0.7, -Math.sign(px) * nx * 0.8);
        if (kind === 'arm') s = band(t * 44 + warp * 5 + 1.3, 0.6, 0.13) * (1 - 0.65 * inner);
        else {
          // unregelmäßige, leicht gebogene Querbinden, außen kräftig, innen kaum; Rauschen bricht sie in Abschnitte
          const brk = smoothstep(0.32, 0.62, fbm3(px * 16 + 5.3, py * 7, pz * 16, 2));
          s = band(t * 36 + warp * 6.5 + 2.2 * nz * nz - 1.2 * nx * Math.sign(px) + 0.4, 0.56, 0.12) * (1 - 0.8 * inner) * (0.35 + 0.65 * brk);
          creamInner = Math.max(creamInner, w * inner * 0.55 * smoothstep(0.08, 0.6, py));
        }
        fx = dx; fy = dy; fz = dz;
      } else if (kind === 'tail') {
        const sArc = tailArc([px, py, pz]);
        s = band(sArc * 52 + warp * 3.5 - 0.6, 0.57, 0.1);
        fx = dx; fy = dy; fz = dz;
      } else if (kind === 'head') {
        const qx = (px - HC[0]) / HS, qy = (py - HC[1]) / HS;
        // Hinterkopf/Nacken: Querstreifen
        const backH = smoothstep(0.0, -0.6, nz) * smoothstep(-0.02, 0.05, -qy + 0.06);
        s = band(qy * 70 + warp * 5, 0.62, 0.12) * backH * 0.8;
        // Fell fließt von der Nase weg (Gesicht), unten zusätzlich abwärts
        fx = px - noseP[0]; fy = py - noseP[1]; fz = pz - noseP[2];
        const fl2 = Math.hypot(fx, fy, fz) || 1; fx /= fl2; fy /= fl2; fz /= fl2;
        if (qy < -0.02) { fy -= 0.6 * smoothstep(-0.02, -0.07, qy); }
        if (Math.abs(qx) > 0.07) { fx += Math.sign(qx) * 0.4; }
      } else if (kind === 'ear') {
        s = smoothstep(0.75, 0.95, (py - jy) / 0.16) * 0.7; // dunklere Ohrspitzen
        fx = dx; fy = dy; fz = dz;
      } else if (kind === 'hand' || kind === 'foot') {
        fx = dx; fy = dy; fz = dz;
      }
      stripe += w * s; wsum += w;
      fl[0] += w * fx; fl[1] += w * fy; fl[2] += w * fz;
    }
    if (wsum > 0) stripe /= wsum;
    creamM = Math.max(creamM, creamInner);
    // ---- Farbe
    let r, g, b;
    if (mat === M.FUR || mat === M.TERRY || mat === M.SHORTS) {
      const tint = 0.93 + 0.14 * fbm3(px * 5 + 11, py * 5, pz * 5, 2);
      const st = clamp(stripe * (1 - creamM), 0, 1) * 0.92;
      r = orange[0] + (stripeC[0] - orange[0]) * st; g = orange[1] + (stripeC[1] - orange[1]) * st; b = orange[2] + (stripeC[2] - orange[2]) * st;
      const dk = clamp(dark, 0, 1) * (1 - creamM);
      r += (stripeD[0] - r) * dk; g += (stripeD[1] - g) * dk; b += (stripeD[2] - b) * dk;
      r *= tint; g *= tint; b *= tint;
      const c = smoothstep(0.0, 1.0, creamM);
      r += (cream[0] - r) * c; g += (cream[1] - g) * c; b += (cream[2] - b) * c;
      if (liner > 0) { const k2 = 0.12 * smoothstep(0.0, 0.6, liner); r *= 1 - k2; g *= 1 - k2; b *= 1 - k2; }
      if (mat !== M.FUR) { furLen = 0; comb = 0; dens = 0; }
    } else {
      const mc = MAT_COLOR[mat] || orange;
      r = mc[0]; g = mc[1]; b = mc[2];
      furLen = 0; comb = 0; dens = 0;
    }
    outCol[4 * v] = r; outCol[4 * v + 1] = g; outCol[4 * v + 2] = b; outCol[4 * v + 3] = clamp(furLen, 0, 1);
    // ---- Kämmrichtung in Tangentialebene
    let fx = fl[0], fy = fl[1], fz = fl[2];
    const dn = fx * nx + fy * ny + fz * nz;
    fx -= dn * nx; fy -= dn * ny; fz -= dn * nz;
    let L = Math.hypot(fx, fy, fz);
    if (L < 1e-4) { fx = -nx * ny; fy = 1 - ny * ny; fz = -nz * ny; fx = -fx; fy = -fy; fz = -fz; L = Math.hypot(fx, fy, fz) || 1; }
    flow[3 * v] = fx / L; flow[3 * v + 1] = fy / L; flow[3 * v + 2] = fz / L;
    outData[4 * v] = mat; outData[4 * v + 1] = dat[4 * v + 1]; outData[4 * v + 2] = clamp(comb, 0, 1); outData[4 * v + 3] = clamp(dens, 0, 1);
  }
  // Kämmrichtung über Nachbarn glätten
  smoothFlow(mesh, flow, opts.flowSmooth ?? 2);
  const uvs = new Float32Array(2 * n);
  for (let v = 0; v < n; v++) octEncode(flow[3 * v], flow[3 * v + 1], flow[3 * v + 2], uvs, 2 * v);
  mesh.colors = outCol; mesh.data = outData; mesh.uvs = uvs;
  return mesh;
}

function smoothFlow(mesh, flow, iters) {
  if (!iters) return;
  const n = mesh.positions.length / 3, idx = mesh.indices, nor = mesh.normals;
  const acc = new Float32Array(3 * n), cnt = new Float32Array(n);
  for (let it = 0; it < iters; it++) {
    acc.set(flow); cnt.fill(1);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      for (const [x, y] of [[a, b], [b, c], [c, a]]) {
        acc[3 * x] += flow[3 * y]; acc[3 * x + 1] += flow[3 * y + 1]; acc[3 * x + 2] += flow[3 * y + 2]; cnt[x]++;
        acc[3 * y] += flow[3 * x]; acc[3 * y + 1] += flow[3 * x + 1]; acc[3 * y + 2] += flow[3 * x + 2]; cnt[y]++;
      }
    }
    for (let v = 0; v < n; v++) {
      let fx = acc[3 * v], fy = acc[3 * v + 1], fz = acc[3 * v + 2];
      const nx = nor[3 * v], ny = nor[3 * v + 1], nz = nor[3 * v + 2];
      const d = fx * nx + fy * ny + fz * nz; fx -= d * nx; fy -= d * ny; fz -= d * nz;
      const L = Math.hypot(fx, fy, fz);
      if (L > 1e-5) { flow[3 * v] = fx / L; flow[3 * v + 1] = fy / L; flow[3 * v + 2] = fz / L; }
    }
  }
}

function octEncode(x, y, z, out, o) {
  const s = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / s, v = y / s;
  if (z < 0) { const u2 = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1), v2 = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1); u = u2; v = v2; }
  out[o] = u * 0.5 + 0.5; out[o + 1] = v * 0.5 + 0.5;
}

// ============================================================================ Anbauteile (Geometrie)

function setAttrs(mesh, rgb, mat, extra = {}) {
  const n = mesh.positions.length / 3;
  const c = new Float32Array(4 * n), d = new Float32Array(4 * n);
  for (let v = 0; v < n; v++) {
    const cc = typeof rgb === 'function' ? rgb(v) : rgb;
    c[4 * v] = cc[0]; c[4 * v + 1] = cc[1]; c[4 * v + 2] = cc[2]; c[4 * v + 3] = 0;
    d[4 * v] = typeof mat === 'function' ? mat(v) : mat; d[4 * v + 1] = extra.ao ?? 1; d[4 * v + 2] = 0; d[4 * v + 3] = 0;
  }
  mesh.colors = c; mesh.data = d;
  return mesh;
}

/** Lid-Mesh im Augen-Rahmen (z = Blick). upper: Kante unten, sonst oben. */
function lidMesh(upper, rOut, rIn, colFur) {
  const azS = 36, elS = 16;
  // Oberlid: breiter (±105°), damit die Kappe um den Pol lückenlos bleibt, wenn es beim Blinzeln nach vorn dreht
  const azMax = upper ? 105 : LID.azMax;
  const edge = upper ? lidEdgeUp : lidEdgeLo;
  const rows = []; // [el(az) fn, radius, isDark]
  const sgn = upper ? 1 : -1;
  // Lippe (rollt nach innen), dann Außenfläche bis zum Rand im Kopfinneren
  rows.push((az) => [edge(az) - sgn * 3.2, rIn - 0.0012, 1]);
  rows.push((az) => [edge(az) - sgn * 1.6, (rIn + rOut) * 0.5 - 0.0003, 1]);
  rows.push((az) => [edge(az), rOut, 1]);
  for (let j = 1; j <= elS; j++) {
    const t = j / elS;
    rows.push((az) => {
      const e0 = edge(az), e1 = sgn * LID.elMax;
      const tt = t * t * 0.7 + t * 0.3;
      return [e0 + (e1 - e0) * tt, rOut, j <= 1 ? 0.6 : 0];
    });
  }
  const P = [], N = [], C = [], D = [], I = [];
  const nR = rows.length, nA = azS + 1;
  for (let i = 0; i < nA; i++) {
    const az = -azMax + (2 * azMax * i) / azS;
    for (let j = 0; j < nR; j++) {
      const [el, r, dk] = rows[j](az);
      const e = el * DEG, a = az * DEG;
      const dir = [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
      P.push(dir[0] * r, dir[1] * r, dir[2] * r);
      N.push(dir[0], dir[1], dir[2]);
      const cc = dk >= 1 ? LIN.dark : dk > 0 ? lerp3(colFur, LIN.dark, 0.55) : colFur;
      C.push(cc[0], cc[1], cc[2], 0);
      D.push(M.LID, j < 2 ? 0.5 : 1, 0, 0);
    }
  }
  for (let i = 0; i < azS; i++) for (let j = 0; j < nR - 1; j++) {
    const a = i * nR + j, b = (i + 1) * nR + j, c = a + 1, d = b + 1;
    if (upper) I.push(a, b, c, c, b, d); else I.push(a, c, b, c, d, b);
  }
  // Lippen-Normalen: grob nach "vorn-unten/oben" kippen, damit die Kante dunkel-weich wirkt
  const mesh = { positions: new Float32Array(P), normals: new Float32Array(N), colors: new Float32Array(C), data: new Float32Array(D), indices: new Uint16Array(I) };
  fixLidWinding(mesh);
  return mesh;
}
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function fixLidWinding(mesh) {
  const p = mesh.positions, n = mesh.normals, I = mesh.indices;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const u = [p[3 * b] - p[3 * a], p[3 * b + 1] - p[3 * a + 1], p[3 * b + 2] - p[3 * a + 2]];
    const w = [p[3 * c] - p[3 * a], p[3 * c + 1] - p[3 * a + 1], p[3 * c + 2] - p[3 * a + 2]];
    const f = cross(u, w);
    const s = [n[3 * a] + n[3 * b] + n[3 * c], n[3 * a + 1] + n[3 * b + 1] + n[3 * c + 1], n[3 * a + 2] + n[3 * b + 2] + n[3 * c + 2]];
    if (dot(f, s) < 0) { I[t + 1] = c; I[t + 2] = b; }
  }
}

/** Spiegelt ein Mesh an lokal X (Windung korrigiert). */
function mirrorMeshX(m) {
  const o = { ...m, positions: m.positions.slice(), normals: m.normals.slice(), indices: m.indices.slice() };
  for (let i = 0; i < o.positions.length; i += 3) { o.positions[i] = -o.positions[i]; o.normals[i] = -o.normals[i]; }
  for (let t = 0; t < o.indices.length; t += 3) { const b = o.indices[t + 1]; o.indices[t + 1] = o.indices[t + 2]; o.indices[t + 2] = b; }
  return o;
}

function tubeAlong(points, r0, r1, segs = 24, radial = 6) {
  const m = geoTube(points, (t) => r0 + (r1 - r0) * Math.pow(t, 0.8), segs, radial, false, true);
  return m;
}

/** Schnurrhaare, Brauenhaare (Modellraum). */
function buildWhiskers(sculpt) {
  const list = [];
  const pad = hc([0.0215, -0.047, 0.08]);
  const rows = [
    { el: 10, az: 30, L: 0.165, droop: 0.55, up: 0.12 }, { el: 4, az: 40, L: 0.175, droop: 0.6, up: 0.04 },
    { el: -3, az: 48, L: 0.17, droop: 0.65, up: -0.04 }, { el: -10, az: 38, L: 0.16, droop: 0.7, up: -0.12 },
    { el: -16, az: 50, L: 0.145, droop: 0.75, up: -0.2 }, { el: 16, az: 46, L: 0.14, droop: 0.5, up: 0.2 },
  ];
  for (const w of rows) {
    const e = w.el * DEG, a = w.az * DEG;
    const dirOut = nrm([Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)]);
    const o = madd(pad, 1, dirOut, 0.09);
    const hit = raycast(sculpt, o, scl(dirOut, -1), 0.2);
    const root = hit ? madd(hit.pos, 1, dirOut, -0.0015) : madd(pad, 1, dirOut, 0.028);
    // Verlauf: seitlich nach außen, leicht vor, mit Hängen
    const out = nrm([1, w.up, 0.25 + 0.15 * w.up]);
    const pts = [];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6, s = t * w.L * 1.3;
      pts.push([root[0] + out[0] * s, root[1] + out[1] * s - w.droop * 0.12 * s * t * 1.6, root[2] + out[2] * s - 0.25 * s * t]);
    }
    list.push(tubeAlong(pts, 0.00078, 0.00014, 22, 5));
  }
  // Brauen-Tasthaare
  // (unter dem Stirnband: kurz, nach außen/vorn geschwungen statt nach oben – sonst stechen sie durchs Band)
  for (const b of [{ x: 0.034, len: 0.042, a: 0.55 }, { x: 0.052, len: 0.05, a: 0.9 }]) {
    const o = hc([b.x, 0.058, 0.25]);
    const hit = raycast(sculpt, o, [0, -0.2, -1], 0.4);
    if (!hit) continue;
    const root = hit.pos;
    const dir = nrm([b.a, 0.32, 0.55]);
    const pts = [];
    for (let k = 0; k <= 5; k++) { const t = k / 5, s = t * b.len * 1.3; pts.push([root[0] + dir[0] * s, root[1] + dir[1] * s - 0.35 * s * t, root[2] + dir[2] * s - 0.12 * s * t]); }
    list.push(tubeAlong(pts, 0.00055, 0.0001, 14, 5));
  }
  const left = geoMerge(list);
  const right = mirrorMeshX(left);
  const all = geoMerge([left, right]);
  return setAttrs(all, LIN.whisker, M.WHISKER);
}

/** Nase (kleiner Sculpt, fein polygonisiert) + ω-Mund (Röhren). */
function buildNoseMouth(sculpt) {
  const hitN = raycast(sculpt, hc([0, -0.016, 0.3]), [0, -0.05, -1], 0.5);
  const ns = hitN ? hitN.pos : hc([0, -0.018, 0.108]);
  const nn = hitN ? hitN.normal : [0, 0.1, 1];
  const zN = nrm(add(nn, [0, 0.25, 0.3]));
  const xN = nrm(cross([0, 1, 0], zN));
  const yN = cross(zN, xN);
  const NSZ = 1.04 * HS;
  const L = (o) => madd(ns, 1, xN, o[0] * NSZ, yN, o[1] * NSZ, zN, o[2] * NSZ);
  const NS = createSculpt({ blend: 0.006, color: GERRY_COLORS.nose, mat: M.NOSE });
  const nq = quatFromBasis(xN, yN, zN), z = NSZ;
  NS.add(P.ellipsoid(L([0.0, 0.0005, -0.001]), [0.0128 * z, 0.0072 * z, 0.0072 * z], nq));
  NS.add(P.ellipsoid(L([0.0, -0.006, 0.0005]), [0.0052 * z, 0.0052 * z, 0.0052 * z], nq), { blend: 0.008 * z });
  NS.add(P.ellipsoid(L([0.0, 0.004, -0.004]), [0.009 * z, 0.006 * z, 0.006 * z], nq), { blend: 0.006 * z });
  // Nasenlöcher: schräge Schlitze an den unteren Seiten, öffnen nach außen-unten (kein "Schweinchen"-Look)
  for (const s of [1, -1]) {
    const q = quat.create();
    quat.multiply(q, nq, quat.setAxisAngle(quat.create(), [0, 0, 1], s * 38 * DEG));
    NS.subtract(P.ellipsoid(L([s * 0.0071, -0.0039, 0.0024]), [0.0031 * z, 0.00105 * z, 0.0026 * z], [q[0], q[1], q[2], q[3]]), { blend: 0.0012, color: '#8E4650' });
  }
  NS.subtract(P.capsule(L([0, -0.0035, 0.0066]), L([0, -0.012, 0.004]), 0.0008), { blend: 0.001, color: '#B66870' });
  const nose = polygonize(NS, { cell: 0.0011, ao: false, data2: 'none', relax: 1 });
  const nc = new Float32Array(nose.colors.length), nd = new Float32Array(nose.data.length);
  for (let v = 0; v < nose.colors.length / 4; v++) {
    nc[4 * v] = nose.colors[4 * v]; nc[4 * v + 1] = nose.colors[4 * v + 1]; nc[4 * v + 2] = nose.colors[4 * v + 2]; nc[4 * v + 3] = 0;
    nd[4 * v] = M.NOSE; nd[4 * v + 1] = 1;
  }
  nose.colors = nc; nose.data = nd;
  // ω-Mund: Philtrum + zwei Bögen, auf die Schnauze projiziert
  const bottom = L([0, -0.0102, 0.001]);
  const proj = (x, y) => {
    const o = [x, y, HC[2] + 0.3];
    const hit = raycast(sculpt, o, [0, 0, -1], 0.5);
    return hit ? madd(hit.pos, 1, hit.normal, 0.0007) : [x, y, bottom[2]];
  };
  const by = bottom[1];
  const cx = 0, y0 = by - 0.0005;
  const half = (s) => [proj(cx, y0), proj(cx, y0 - 0.0075 * HS), proj(cx + s * 0.004 * HS, y0 - 0.0118 * HS), proj(cx + s * 0.0105 * HS, y0 - 0.0128 * HS), proj(cx + s * 0.0165 * HS, y0 - 0.0105 * HS), proj(cx + s * 0.0205 * HS, y0 - 0.0068 * HS)];
  const mL = geoTube(half(1), (t) => 0.00092 * (t > 0.85 ? 1 - (t - 0.85) / 0.15 * 0.7 : 1), 30, 6, false, true);
  const mR = geoTube(half(-1).slice(1), (t) => 0.00092 * (t > 0.85 ? 1 - (t - 0.85) / 0.15 * 0.7 : 1), 26, 6, false, true);
  const mouth = setAttrs(geoMerge([mL, mR]), LIN.dark, M.DARK);
  // offener Mund (für "happy"): dunkle Höhle + Zunge, unter dem ω
  const mo = proj(0, y0 - 0.013 * HS);
  const MS = createSculpt({ blend: 0.003, color: GERRY_COLORS.mouth, mat: M.MOUTH });
  MS.add(P.ellipsoid(madd(mo, 1, [0, 0, 1], -0.004 * HS, [0, 1, 0], -0.002 * HS), kk([0.0135, 0.0085, 0.006])));
  MS.add(P.ellipsoid(madd(mo, 1, [0, 0, 1], -0.0015 * HS, [0, 1, 0], -0.006 * HS), kk([0.0075, 0.0036, 0.0055])), { color: GERRY_COLORS.tongue, mat: M.TONGUE, blend: 0.002 });
  MS.intersect(P.plane(madd(mo, 1, [0, 1, 0], 0.0005), [0, 1, 0]), { blend: 0.0015 });
  const mopen = polygonize(MS, { cell: 0.001, ao: false, data2: 'none' });
  const oc = new Float32Array(mopen.colors.length), od = new Float32Array(mopen.data.length);
  for (let v = 0; v < mopen.colors.length / 4; v++) {
    oc.set(mopen.colors.subarray(4 * v, 4 * v + 3), 4 * v); oc[4 * v + 3] = 0;
    od[4 * v] = mopen.data[4 * v]; od[4 * v + 1] = 1;
  }
  mopen.colors = oc; mopen.data = od;
  return { nose, mouth, mouthOpen: mopen, mouthAnchor: mo, noseTip: ns };
}

/** Ohrbüschel (cremeweiß) im Modellraum, linkes Ohr. */
function buildEarTufts(ear) {
  // feine, helle Haarbüschel aus der Ohrmuschel (Fächer nach vorn/oben, leicht zur Mitte)
  const { v, w } = ear;
  const u = nrm(cross(v, w));
  const rng = makeRng(17);
  const list = [];
  for (let k = 0; k < 26; k++) {
    const dv = 0.006 + 0.05 * Math.pow(rng(), 1.3);
    const wid = 0.024 * (1 - dv / 0.075);
    const du = (rng() * 2 - 1) * wid;
    const root = madd(EAR_BASE, 1, u, du * HS, v, dv * HS, w, 0.004 * HS);
    const L = (0.022 + 0.026 * rng() * (1 - dv / 0.09)) * HS;
    const fan = du / 0.024;
    const dir = nrm(madd(v, 0.75 + 0.3 * rng(), w, 0.55 + 0.25 * rng(), u, fan * 0.45 - 0.12));
    const pts = [];
    for (let j = 0; j <= 5; j++) { const t = j / 5, s2 = t * L; pts.push(madd(root, 1, dir, s2, w, 0.2 * s2 * t, v, -0.18 * s2 * t)); }
    list.push(tubeAlong(pts, 0.00075, 0.00008, 10, 4));
  }
  return setAttrs(geoMerge(list), lerp3(LIN.cream, [1, 1, 1], 0.45), M.WHISKER);
}

// ============================================================================ CPU-Build (ohne Renderer)

/**
 * Alle Mesh-Daten von Gerry (CPU). opts: { cell (0.008), furCell (0.013), furShells (20) }.
 * @returns { skeletonDef, body, furLong, furShort, shells: {long, short}, attachments: [{name, bone, mesh, offset, kind}], info, stats }
 */
export function buildGerryMeshes(opts = {}) {
  const t0 = now();
  const def = buildGerrySkeletonDef();
  const eyes = placeEyes();
  const { sculpt, info } = buildGerrySculpt(GERRY_JOINTS, eyes);
  const t1 = now();
  const body = polygonize(sculpt, { cell: opts.cell || 0.008, skeleton: def, data2: 'none', aoDist: 0.06 });
  furify(body, def);
  const t2 = now();
  // Fell-Basis: Fell-Dreiecke des feinen Meshes, per Vertex-Clustering auf ~furCell vergröbert (statt zweiter
  // Polygonisierung: spart ~40 % Bauzeit, Attribute/Skin-Gewichte kommen direkt vom Basis-Mesh).
  const isFurV = (vi) => Math.round(body.data[4 * vi]) === M.FUR && body.colors[4 * vi + 3] > 0.03;
  const furAll = clusterDecimate(body, opts.furCell || 0.013, isFurV);
  const t3 = now();
  // lang = Dreieck mit mind. einem langen Vertex (eigene, höhere Schalenzahl), sonst kurz – keine Dubletten
  const FI = furAll.indices, longT = [], shortT = [];
  const isLong = (vi) => furAll.colors[4 * vi + 3] > 0.6;
  for (let t = 0; t < FI.length; t += 3) (isLong(FI[t]) || isLong(FI[t + 1]) || isLong(FI[t + 2]) ? longT : shortT).push(t);
  const furLong = subsetTris(furAll, longT), furShort2 = subsetTris(furAll, shortT);
  const shellsLong = Math.max(4, Math.round(opts.furShells ?? 20));
  const shellsShort = Math.max(3, Math.round(shellsLong * 0.6));

  // ---- Anbauteile
  const attachments = [];
  const headJ = GERRY_JOINTS.head;
  const T = (p) => mat4.fromTranslation(mat4.create(), [-p[0], -p[1], -p[2]]);
  // Augen
  const eyeMesh = geoSphere(EYE.r, 48, 28);
  setAttrs(eyeMesh, [1, 1, 1], M.FUR);
  const lidColUp = lerp3(sampleColorNear(body, eyes[0].E, madd(eyes[0].fr.y, 1, eyes[0].fr.z, 0.4), 0.045, 0.02), LIN.stripe, 0.12);
  const lidColLo = lerp3(sampleColorNear(body, eyes[0].E, madd(eyes[0].fr.y, -1, eyes[0].fr.z, 0.4), 0.04, 0.02), LIN.cream, 0.15);
  const rOut = EYE.r + LID.gap, rIn = EYE.r + 0.0003;
  const upL = lidMesh(true, rOut, rIn, lidColUp), loL = lidMesh(false, rOut - 0.0004, rIn - 0.0002, lidColLo);
  const upR = mirrorMeshX(upL), loR = mirrorMeshX(loL);
  for (const e of eyes) {
    const base = eyeBaseMatrix(e, headJ);
    attachments.push({ name: 'eye_' + e.side, bone: 'head', mesh: eyeMesh, offset: mat4.clone(base), base, kind: 'eye', side: e.side, castShadow: false });
    attachments.push({ name: 'lidUp_' + e.side, bone: 'head', mesh: e.side === 'l' ? upL : upR, offset: mat4.clone(base), base, kind: 'lidUp', side: e.side, castShadow: false });
    attachments.push({ name: 'lidLo_' + e.side, bone: 'head', mesh: e.side === 'l' ? loL : loR, offset: mat4.clone(base), base, kind: 'lidLo', side: e.side, castShadow: false });
  }
  // Nase, Mund, Schnurrhaare
  const nm = buildNoseMouth(sculpt);
  attachments.push({ name: 'nose', bone: 'head', mesh: nm.nose, offset: T(headJ), kind: 'static', castShadow: false });
  attachments.push({ name: 'mouth', bone: 'head', mesh: nm.mouth, offset: T(headJ), kind: 'static', castShadow: false });
  attachments.push({ name: 'mouthOpen', bone: 'head', mesh: nm.mouthOpen, offset: mat4.fromScaling(mat4.create(), [0, 0, 0]), anchor: sub(nm.mouthAnchor, headJ), anchorNeg: scl(nm.mouthAnchor, -1), kind: 'mouthOpen', castShadow: false });
  attachments.push({ name: 'whiskers', bone: 'head', mesh: buildWhiskers(sculpt), offset: T(headJ), kind: 'static', castShadow: false });
  // Ohrbüschel
  const tuftL = buildEarTufts(info.ear);
  attachments.push({ name: 'earTufts_l', bone: 'ear_l', mesh: tuftL, offset: T(EAR_BASE), kind: 'static', castShadow: false });
  attachments.push({ name: 'earTufts_r', bone: 'ear_r', mesh: mirrorMeshX(tuftL), offset: T(mirrorX(EAR_BASE)), kind: 'static', castShadow: false });

  toShaderClass(body);
  const t4 = now();
  const grip = info.grip;
  const stats = {
    buildMs: t4 - t0, sculptMs: t1 - t0, bodyMs: t2 - t1, furMs: t3 - t2, attachMs: t4 - t3,
    bodyTris: body.indices.length / 3, furLongTris: furLong.indices.length / 3, furShortTris: furShort2.indices.length / 3,
    shellsLong, shellsShort,
  };
  stats.totalTris = stats.bodyTris + stats.furLongTris * shellsLong + stats.furShortTris * shellsShort
    + attachments.reduce((s, a) => s + a.mesh.indices.length / 3, 0);
  return { skeletonDef: def, body, furLong, furShort: furShort2, shells: { long: shellsLong, short: shellsShort }, attachments, info, grip, eyes, stats };
}

/**
 * Material-ID -> Shader-Klasse (interpoliert sauber an Grenzen): 0 Fell, 1 Frottee, 2 Webstoff, -1 rosa Haut.
 * (Interpolierte IDs 0..7 würden sonst fremde Zweige treffen.)
 */
const SHADER_CLASS = { [M.FUR]: 0, [M.TERRY]: 1, [M.STRIPE]: 1, [M.SHORTS]: 2, [M.PIPING]: 2, [M.PAD]: -1, [M.INNER_EAR]: -1 };
function toShaderClass(mesh) {
  const d = mesh.data;
  for (let v = 0; v < d.length; v += 4) { const c = SHADER_CLASS[Math.round(d[v])]; if (c !== undefined) d[v] = c; }
}

/** Teilmesh aus einer Liste von Dreiecks-Offsets (alle Attribute). */
function subsetTris(mesh, triList) {
  const I = mesh.indices, n = mesh.positions.length / 3;
  const map = new Int32Array(n).fill(-1);
  const out = new Uint32Array(triList.length * 3); let cnt = 0, o = 0;
  for (const t of triList) for (let k = 0; k < 3; k++) { const v = I[t + k]; if (map[v] < 0) map[v] = cnt++; out[o++] = map[v]; }
  const res = { indices: cnt < 65536 ? Uint16Array.from(out) : out };
  for (const key of ['positions', 'normals', 'colors', 'data', 'uvs', 'joints', 'weights']) {
    const src = mesh[key]; if (!src) continue;
    const stride = src.length / n;
    const dst = new src.constructor(cnt * stride);
    for (let v = 0; v < n; v++) if (map[v] >= 0) for (let k = 0; k < stride; k++) dst[map[v] * stride + k] = src[v * stride + k];
    res[key] = dst;
  }
  return res;
}

/**
 * Vertex-Clustering-Vergröberung (nur Dreiecke, deren drei Vertices keep() erfüllen). Cluster = Rasterzelle x
 * dominante Normalenrichtung (trennt Vorder-/Rückseite dünner Teile wie Ohren). Position = Schwerpunkt,
 * Normale = Mittel, übrige Attribute vom Vertex nächst am Schwerpunkt. Entartete/umgeklappte/doppelte Dreiecke fallen weg.
 */
function clusterDecimate(mesh, cell, keep) {
  const P = mesh.positions, N = mesh.normals, I = mesh.indices, n = P.length / 3;
  const inv = 1 / cell;
  const cid = new Int32Array(n).fill(-1);
  const keyMap = new Map();
  let nc = 0;
  const acc = [];
  const used = new Uint8Array(n);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    if (keep(a) && keep(b) && keep(c)) used[a] = used[b] = used[c] = 1;
  }
  for (let v = 0; v < n; v++) {
    if (!used[v]) continue;
    const nx = N[3 * v], ny = N[3 * v + 1], nz = N[3 * v + 2];
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const dir = ax >= ay && ax >= az ? (nx > 0 ? 0 : 1) : ay >= az ? (ny > 0 ? 2 : 3) : (nz > 0 ? 4 : 5);
    const ix = Math.floor(P[3 * v] * inv) + 512, iy = Math.floor(P[3 * v + 1] * inv) + 512, iz = Math.floor(P[3 * v + 2] * inv) + 512;
    const key = ((ix * 1024 + iy) * 1024 + iz) * 6 + dir;
    let c = keyMap.get(key);
    if (c === undefined) { c = nc++; keyMap.set(key, c); acc.push(0, 0, 0, 0, 0, 0, 0); }
    cid[v] = c;
    const o = 7 * c;
    acc[o] += P[3 * v]; acc[o + 1] += P[3 * v + 1]; acc[o + 2] += P[3 * v + 2];
    acc[o + 3] += nx; acc[o + 4] += ny; acc[o + 5] += nz; acc[o + 6]++;
  }
  // Repräsentant je Cluster
  const rep = new Int32Array(nc).fill(-1), best = new Float32Array(nc).fill(1e9);
  for (let v = 0; v < n; v++) {
    const c = cid[v]; if (c < 0) continue;
    const o = 7 * c, k = 1 / acc[o + 6];
    const dx = P[3 * v] - acc[o] * k, dy = P[3 * v + 1] - acc[o + 1] * k, dz = P[3 * v + 2] - acc[o + 2] * k;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best[c]) { best[c] = d2; rep[c] = v; }
  }
  const pos = new Float32Array(3 * nc), nor = new Float32Array(3 * nc);
  for (let c = 0; c < nc; c++) {
    const o = 7 * c, k = 1 / acc[o + 6];
    // Schwerpunkt leicht Richtung Repräsentant (bleibt näher an der Oberfläche)
    const r = rep[c];
    for (let j = 0; j < 3; j++) pos[3 * c + j] = acc[o + j] * k * 0.6 + P[3 * r + j] * 0.4;
    const L = Math.hypot(acc[o + 3], acc[o + 4], acc[o + 5]) || 1;
    nor[3 * c] = acc[o + 3] / L; nor[3 * c + 1] = acc[o + 4] / L; nor[3 * c + 2] = acc[o + 5] / L;
  }
  const tris = [], seen = new Set();
  for (let t = 0; t < I.length; t += 3) {
    const a = cid[I[t]], b = cid[I[t + 1]], c = cid[I[t + 2]];
    if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue;
    if (!(keep(I[t]) && keep(I[t + 1]) && keep(I[t + 2]))) continue;
    const lo = Math.min(a, b, c), hi = Math.max(a, b, c), mid = a + b + c - lo - hi;
    const k = (lo * nc + mid) * nc + hi;
    if (seen.has(k)) continue;
    // umgeklappt?
    const ux = pos[3 * b] - pos[3 * a], uy = pos[3 * b + 1] - pos[3 * a + 1], uz = pos[3 * b + 2] - pos[3 * a + 2];
    const vx = pos[3 * c] - pos[3 * a], vy = pos[3 * c + 1] - pos[3 * a + 1], vz = pos[3 * c + 2] - pos[3 * a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const sn = (nor[3 * a] + nor[3 * b] + nor[3 * c]) * fx + (nor[3 * a + 1] + nor[3 * b + 1] + nor[3 * c + 1]) * fy + (nor[3 * a + 2] + nor[3 * b + 2] + nor[3 * c + 2]) * fz;
    if (sn <= 0) continue;
    seen.add(k);
    tris.push(a, b, c);
  }
  const res = { positions: pos, normals: nor, indices: nc < 65536 ? Uint16Array.from(tris) : Uint32Array.from(tris) };
  for (const key of ['colors', 'data', 'uvs', 'joints', 'weights']) {
    const src = mesh[key]; if (!src) continue;
    const stride = src.length / n;
    const dst = new src.constructor(nc * stride);
    for (let c = 0; c < nc; c++) for (let k = 0; k < stride; k++) dst[c * stride + k] = src[rep[c] * stride + k];
    res[key] = dst;
  }
  return res;
}

/** Mittlere Fellfarbe der Basis-Vertices nahe E + dir*dist (Radius r). */
function sampleColorNear(mesh, E, dir, dist, r) {
  const c = madd(E, 1, dir, dist);
  const p = mesh.positions, col = mesh.colors;
  let s0 = 0, s1 = 0, s2 = 0, w = 0;
  for (let v = 0; v < p.length / 3; v++) {
    const dx = p[3 * v] - c[0], dy = p[3 * v + 1] - c[1], dz = p[3 * v + 2] - c[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r * r || mesh.data[4 * v] > 0.5) continue;
    const ww = 1 - Math.sqrt(d2) / r;
    s0 += col[4 * v] * ww; s1 += col[4 * v + 1] * ww; s2 += col[4 * v + 2] * ww; w += ww;
  }
  return w > 0 ? [s0 / w, s1 / w, s2 / w] : LIN.orange;
}

function eyeBaseMatrix(e, headJ) {
  const { E, fr } = e;
  const m = mat4.create();
  const sx = e.side === 'r' ? -1 : 1;   // rechts: rechtshändiger Rahmen + gespiegelte Meshes
  m[0] = sx * fr.x[0]; m[1] = sx * fr.x[1]; m[2] = sx * fr.x[2];
  m[4] = fr.y[0]; m[5] = fr.y[1]; m[6] = fr.y[2];
  m[8] = fr.z[0]; m[9] = fr.z[1]; m[10] = fr.z[2];
  m[12] = E[0] - headJ[0]; m[13] = E[1] - headJ[1]; m[14] = E[2] - headJ[2];
  return m;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ============================================================================ Shader

/** Ballen-Geometrie (Sohlenebene x/z, linker Fuß) -> GLSL (Abstandsfunktion in m). */
const PAD_GLSL = (() => {
  const To = GERRY_JOINTS.toe_l, Fo = GERRY_JOINTS.foot_l;
  const f = (v) => v.toFixed(4);
  const lines = [];
  const FS = 1.18;   // Pfotengröße (wie im Sculpt)
  const bx = [-0.036, -0.0122, 0.0122, 0.036].map((v) => v * FS), bz = [0.022, 0.037, 0.037, 0.022].map((v) => v * FS);
  for (let k = 0; k < 4; k++) {
    // ovale Zehenballen, leicht nach außen gedreht
    const cx = To[0] + bx[k], cz = To[2] + bz[k], rx = 0.0098 * FS, rz = 0.0118 * FS;
    lines.push(`  d = min(d, (length((p - vec2(${f(cx)}, ${f(cz)})) / vec2(${f(rx)}, ${f(rz)})) - 1.0) * ${f(rx)});`);
  }
  // Hauptballen: drei Lappen vorn + breiter Körper
  const mx = Fo[0], mz = Fo[2] + 0.062;
  lines.push(`  d = min(d, (length((p - vec2(${f(mx)}, ${f(mz - 0.004)})) / vec2(0.0245, 0.0165)) - 1.0) * 0.0165);`);
  for (const [ox, oz] of [[-0.0145, 0.0085], [0, 0.0125], [0.0145, 0.0085]]) {
    lines.push(`  d = min(d, length(p - vec2(${f(mx + ox)}, ${f(mz + oz)})) - 0.0112);`);
  }
  return lines.join('\n');
})();

const GLSL_COMMON = /* glsl */`
vec3 gFw;   // fwidth(objPos) – einmal oben in surface() berechnet (Ableitungen nur im uniformen Kontrollfluss)
float gerryLod(vec3 wp) {
  float dist = max(length(u_cameraPos - wp), 0.05);
  float pxPerM = u_proj[1][1] * 0.5 * u_resolution.y / dist;
  return pxPerM / u_furFreq;      // Strähnenzelle in Pixeln
}
float gSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
// Abstand zum Segment + Parameter t (für verjüngte Striche)
vec2 gSegT(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return vec2(length(pa - ba * h), h);
}
float gStroke(vec2 p, vec2 a, vec2 b, float w0, float w1, float soft) {
  vec2 dt = gSegT(p, a, b);
  float w = mix(w0, w1, dt.y);
  return smoothstep(w, w - soft, dt.x);
}
// Kopfzeichnung: "M" auf der Stirn, Scheitelstreifen, Wangenlinien. objPos in Bindpose.
float gerryMarks(vec3 op, vec3 on) {
  vec3 q = (op - u_headC) / u_headS;
  if (q.y < -0.09 || q.y > 0.16 || abs(q.x) > 0.16) return 0.0;
  float nz = noise3(op * 140.0);
  q += (vec3(noise3(op * 70.0), noise3(op * 70.0 + 7.1), noise3(op * 70.0 + 3.3)) - 0.5) * 0.005;
  float m = 0.0;
  // M (Frontalprojektion x/y): Striche unten breit, oben spitz auslaufend
  float front = smoothstep(0.1, 0.5, on.z);
  vec2 f = vec2(abs(q.x), q.y);
  float sm = 0.0;
  sm = max(sm, gStroke(f, vec2(0.031, 0.015), vec2(0.02, 0.043), 0.0062, 0.0028, 0.0035));
  sm = max(sm, gStroke(f, vec2(0.02, 0.043), vec2(0.007, 0.024), 0.0034, 0.0052, 0.0032));
  sm = max(sm, gStroke(f, vec2(0.0, 0.026), vec2(0.0, 0.046), 0.0048, 0.0026, 0.003) * step(f.x, 0.012));
  // kurze Stirnstreifen über dem M (unter dem Stirnband teilweise verdeckt)
  sm = max(sm, gStroke(f, vec2(0.012, 0.04), vec2(0.014, 0.06), 0.003, 0.0018, 0.0022) * 0.8);
  m = max(m, sm * front * (0.72 + 0.28 * nz));
  // Scheitel/Hinterkopf: Längsstreifen
  float top = smoothstep(0.06, 0.09, q.y) * smoothstep(0.65, 0.2, on.z);
  float xs = abs(q.x);
  float st = max(smoothstep(0.0055, 0.0022, abs(xs - 0.0)), max(smoothstep(0.0048, 0.0018, abs(xs - 0.021)), smoothstep(0.0042, 0.0016, abs(xs - 0.041))));
  m = max(m, st * top * smoothstep(0.075, 0.03, xs + max(0.0, -q.z) * 0.15) * (0.7 + 0.3 * nz));
  // Wangenlinien (Seitenprojektion z/y), verjüngt
  float side = smoothstep(0.25, 0.6, abs(on.x)) * step(0.055, xs);
  vec2 s2 = vec2(q.z, q.y);
  float c1 = gStroke(s2, vec2(0.056, -0.004), vec2(-0.008, -0.03), 0.0052, 0.0016, 0.0028);
  float c2 = gStroke(s2, vec2(0.042, -0.036), vec2(-0.014, -0.06), 0.0046, 0.0014, 0.0026);
  m = max(m, max(c1, c2) * side * (0.75 + 0.25 * nz));
  return m;
}
// Lidkanten (Grad Elevation) im Augenrahmen – identisch zu lidEdgeUp/lidEdgeLo in JS
float gLidUp(float az) {
  float u = az / ${LID.azA.toFixed(3)}, au = abs(u);
  if (au < 1.0) return ${LID.corner.toFixed(3)} + ${(LID.top - LID.corner).toFixed(3)} * pow(1.0 - u * u, 0.62) + (u > 0.0 ? 2.5 * u : 1.5 * u);
  return ${LID.corner.toFixed(3)} + (u > 0.0 ? 2.5 : -1.5) - (au - 1.0) * 32.0;
}
float gLidLo(float az) {
  float u = az / ${LID.azA.toFixed(3)}, au = abs(u);
  if (au < 1.0) return ${LID.corner.toFixed(3)} + ${(LID.bot - LID.corner).toFixed(3)} * pow(1.0 - u * u, 0.8) + (u > 0.0 ? 2.0 * u : 0.0);
  return ${LID.corner.toFixed(3)} + (u > 0.0 ? 2.0 : 0.0) + (au - 1.0) * 32.0;
}
// Dunkler Lidrand ("Eyeliner") um die Augenöffnung, außen mit kleinem Schwung. 0..1
// Gemessen in der Ebene senkrecht zur Blickachse des Auges (Projektion), damit die Breite auf der Haut ~konstant ist.
float gerryLiner(vec3 op) {
  vec3 p = vec3(abs(op.x), op.y, op.z) - u_eyeE;
  if (dot(p, p) > 0.0036) return 0.0;
  vec3 l = vec3(dot(p, u_eyeX), dot(p, u_eyeY), dot(p, u_eyeZ));
  if (l.z < 0.0) return 0.0;
  float R0 = u_eyeR;
  float xc = R0 * ${Math.sin(LID.azA * DEG).toFixed(5)} * ${Math.cos(LID.corner * DEG).toFixed(5)};
  float az = degrees(asin(clamp(l.x / (R0 * 0.975), -1.0, 1.0)));
  az = clamp(az, -${LID.azA.toFixed(3)}, ${LID.azA.toFixed(3)});
  float yUp = R0 * sin(radians(gLidUp(az))), yLo = R0 * sin(radians(gLidLo(az)));
  float dv = max(l.y - yUp, yLo - l.y);
  float dh = abs(l.x) - xc;
  float d = dh > 0.0 ? length(vec2(dh, max(dv, 0.0))) : dv;      // m außerhalb der Öffnung
  float lateral = smoothstep(0.2, 0.95, l.x / xc);
  float upper = step(mix(yUp, yLo, 0.5), l.y);
  float w = mix(mix(0.0021, 0.0029, upper), 0.0036, lateral) * u_headS;
  float liner = smoothstep(w + 0.0012, w - 0.0004, d);
  // Schwung am äußeren Augenwinkel (nach außen-oben)
  vec2 fp = vec2(l.x - xc, l.y - R0 * ${Math.sin(LID.corner * DEG).toFixed(5)});
  float fl = gSeg(fp, vec2(0.0), vec2(0.0062, 0.0022) * u_headS);
  float flick = smoothstep(0.0016, 0.0005, fl - 0.0011 * (1.0 - clamp(fp.x / (0.0062 * u_headS), 0.0, 1.0)));
  return max(liner, flick * 0.9);
}
// Pfotenballen (Sohle, Bindpose): 4 Zehenballen + dreilappiger Hauptballen, gespiegelt. grow = Rand (m). 0..1
float gerryPadMask(vec3 op, vec3 on, float grow) {
  if (op.y > 0.03 || on.y > -0.25) return 0.0;
  vec2 p = vec2(abs(op.x), op.z);
  float d = 1e3;
${PAD_GLSL}
  d -= grow;
  float aa = max(max(gFw.x, gFw.z), 1e-5) * 0.8;
  return smoothstep(aa, -aa, d);
}
// Rückgabe < 0: Punkt liegt in keiner Frottee-Zone.
float gerryTerryMask(vec3 op, float grow) {
  vec3 r = op - u_bandC;
  float d, aa;
  if (dot(r, r) < 0.1) { d = abs(dot(r, u_bandN)) - u_bandHalf - grow; aa = dot(abs(u_bandN), gFw); }
  else {
    vec3 p = vec3(abs(op.x), op.y, op.z) - u_wbA;
    float t = dot(p, u_wbD);
    if (length(p - u_wbD * t) > 0.075 || t < -0.06 || t > u_wbT.y + 0.06) return -1.0;
    d = max(u_wbT.x - grow - t, t - u_wbT.y - grow); aa = dot(abs(u_wbD), gFw);
  }
  aa = max(aa, 1e-5) * 0.8;
  return smoothstep(aa, -aa, d);
}
// Shorts-Maske: unterhalb der Bundoberkante und oberhalb des Saums (je Bein gespiegelt).
float gerryShortsMask(vec3 op, float grow) {
  float dW = op.y - u_shortsTop - grow;
  vec3 th = vec3(abs(op.x), op.y, op.z) - u_pipThigh;
  float ta = dot(th, vec3(abs(u_pipDir.x), u_pipDir.y, u_pipDir.z)) - u_hemT - grow;
  float d = max(dW, ta);
  float aa = max(dW > ta ? gFw.y : dot(abs(u_pipDir), gFw), 1e-5) * 0.8;
  return smoothstep(aa, -aa, d);
}
`;

const BODY_SURFACE = /* glsl */`
${GLSL_COMMON}
void gerryFurBase(in SurfaceInput i, inout Surface s, vec3 col) {
  float cellPx = gerryLod(i.worldPos);
  float lod = smoothstep(0.5, 2.0, cellPx);
  float orange = smoothstep(0.45, 0.85, 1.0 - col.b / max(col.r, 1e-3));
  col = mix(col, u_markCol, gerryMarks(i.objPos, i.objNormal) * orange * 0.45);
  col = mix(col, u_linerCol, gerryLiner(i.objPos) * 0.3);
  float g = noise3(i.objPos * u_furFreq * 0.45);
  col *= mix(1.0, 0.86 + 0.28 * g, lod);
  float shelled = smoothstep(0.02, 0.06, i.color.a);
  col *= mix(1.0, mix(0.93, 0.84, orange), shelled * smoothstep(0.2, 1.5, cellPx));
  s.albedo = col;
  s.roughness = 0.75; s.specular = 0.28;
  s.sheen = 0.6; s.sheenColor = mix(col, vec3(1.0), 0.45);
  s.subsurface = 0.3; s.subsurfaceColor = vec3(1.0, 0.55, 0.28);
  s.emissive = col * u_sunColor * (u_furScatter * 0.5);
}
void gerryTerry(in SurfaceInput i, inout Surface s) {
  vec3 p = i.objPos * 1100.0;
  float lp = mix(0.5, noise3(p) * 0.65 + noise3(p * 2.3) * 0.35, smoothstep(1.6, 0.6, length(gFw) * 1100.0));
  float bh = dot(i.objPos - u_bandC, u_bandN);
  float aa = max(dot(abs(u_bandN), gFw), 1e-5) * 0.8;
  float onHead = step(length(i.objPos - u_headC), 0.34);   // Schweißbänder ohne Streifen
  vec3 col = mix(u_terryCol, u_bandStripeCol, smoothstep(u_bandStripe + aa, u_bandStripe - aa, abs(bh)) * onHead);
  s.albedo = col * (0.9 + 0.12 * lp);
  s.roughness = 0.95; s.specular = 0.2; s.sheen = 0.35; s.sheenColor = vec3(1.0, 0.97, 0.92);
  s.normal = bumpNormal(s.normal, i.worldPos, lp, 0.00035);
  s.subsurface = 0.2; s.subsurfaceColor = vec3(1.0, 0.95, 0.9);
}
void gerryShorts(in SurfaceInput i, inout Surface s) {
  vec3 p = i.objPos * 2400.0;
  float fwv = length(gFw) * 2400.0;                       // Webmuster ausblenden, bevor es flimmert
  float wv = 0.5 + 0.25 * (sin(p.x + p.z) * sin(p.y * 1.02)) * smoothstep(2.2, 0.8, fwv);
  vec3 op = i.objPos;
  float aa = max(gFw.y, 1e-5) * 0.8;
  float pip = smoothstep(u_pipW + aa, u_pipW - aa, abs(op.y - u_pipWaist.x)) * step(op.y, u_pipWaist.x + 0.02);
  vec3 th = vec3(abs(op.x), op.y, op.z) - u_pipThigh;
  float ta = dot(th, vec3(abs(u_pipDir.x), u_pipDir.y, u_pipDir.z));
  float aa2 = max(dot(abs(u_pipDir), gFw), 1e-5) * 0.8;
  pip = max(pip, smoothstep(aa2, -aa2, abs(ta - (u_pipHem.x + u_pipHem.y) * 0.5) - (u_pipHem.y - u_pipHem.x) * 0.5));
  float side = smoothstep(0.085, 0.1, abs(op.x));
  pip = max(pip, side * smoothstep(aa, -aa, abs(op.z - u_pipWaist.y) - u_pipW * 1.25) * step(ta, u_pipHem.y));
  vec3 col = mix(u_shortsCol, u_pipCol, pip);
  s.albedo = col * (0.94 + 0.08 * wv);
  s.roughness = 0.88; s.specular = 0.3; s.sheen = 0.5; s.sheenColor = vec3(0.9);
  s.subsurface = 0.0;
  // Stofffalten (Bindpose): Raffung unter dem Bund + Zugfalten vom Schritt zur Hüfte, mit Abstand ausgeblendet
  float fl = smoothstep(0.004, 0.0012, length(gFw));
  float ang = atan(op.x, op.z + 0.01);
  float gath = sin(ang * 44.0 + 2.0 * noise3(op * 35.0)) * smoothstep(u_pipWaist.x - 0.055, u_pipWaist.x - 0.014, op.y) * smoothstep(u_pipWaist.x - 0.002, u_pipWaist.x - 0.012, op.y);
  vec2 cr = vec2(abs(op.x), op.y - 0.385);
  float crl = length(cr);
  float crease = sin(atan(cr.y, cr.x) * 6.0 + crl * 20.0 + 1.5 * noise3(op * 25.0)) * smoothstep(0.17, 0.05, crl) * smoothstep(0.015, 0.04, crl) * smoothstep(0.0, 0.05, op.z + 0.02);
  float hgt = (gath * 0.45 + crease * 0.35) * fl;
  s.normal = bumpNormal(s.normal, i.worldPos, hgt + wv * 0.17, 0.0015);
  s.ao *= 1.0 - 0.04 * max(-crease, 0.0) * fl;
}
void surface(in SurfaceInput i, inout Surface s) {
  gFw = fwidth(i.objPos);
  float mc = i.data.x;
  int m = int(mc + 0.5);
  vec3 col = i.color.rgb;
  float bao = i.data.y;
  s.roughness = 0.8; s.specular = 0.35;
  if (mc < -0.5) {                            // rosa Haut (Ballen, Ohr innen)
    float n = noise3(i.objPos * 1500.0);
    vec3 pc = col;
    vec3 ep = vec3(abs(i.objPos.x), i.objPos.y, i.objPos.z) - u_earB;
    float te = dot(ep, u_earV);
    if (te > -0.02 && length(ep - u_earV * te) < 0.09) {   // Ohrinnenseite: unten tiefer rosa, zur Spitze heller, Rand cremig
      float t = clamp(te / 0.13, 0.0, 1.0);
      pc = mix(u_earDeep, u_earLight, smoothstep(0.0, 0.9, t));
      pc *= 0.92 + 0.16 * noise3(i.objPos * vec3(260.0, 90.0, 260.0));
      float rim = smoothstep(-0.75, -0.05, mc);
      pc = mix(pc, u_earRim, rim * 0.85);
    }
    s.albedo = pc * (0.95 + 0.1 * n);
    s.roughness = 0.55; s.specular = 0.4;
    s.subsurface = 0.75; s.subsurfaceColor = vec3(1.0, 0.35, 0.3);
  } else if (mc < 2.5 && m != 11) {           // Fell / Frottee / Shorts (Grenzen analytisch scharf)
    // Zweig-Bedingung mit gewachsener Maske: an der sichtbaren Kante laufen alle Pixel eines 2x2-Quads durch
    // gerryTerry/gerryShorts (bumpNormal braucht Ableitungen) -> keine gestrichelten Kanten
    float tm = 0.0, sm = 0.0; bool inT = false, inS = false;
    if (mc > 0.02) {
      float t = gerryTerryMask(i.objPos, -0.0006);
      if (t >= 0.0) { tm = t; inT = gerryTerryMask(i.objPos, 0.004) > 0.0; }
      else { sm = gerryShortsMask(i.objPos, 0.0); inS = gerryShortsMask(i.objPos, 0.004) > 0.0; }
    }
    if (tm + sm < 0.999) gerryFurBase(i, s, col);
    float pm = 0.0; bool inP = false;
    if (i.objPos.y < 0.03) { pm = gerryPadMask(i.objPos, i.objNormal, 0.0); inP = gerryPadMask(i.objPos, i.objNormal, 0.003) > 0.001; }
    if (inP) {
      float n = noise3(i.objPos * 1500.0);
      s.albedo = mix(s.albedo, u_padCol * (0.93 + 0.12 * n), pm);
      s.roughness = mix(s.roughness, 0.5, pm); s.specular = mix(s.specular, 0.4, pm);
      s.sheen *= 1.0 - pm; s.emissive *= 1.0 - pm;
      s.subsurface = mix(s.subsurface, 0.35, pm); s.subsurfaceColor = vec3(1.0, 0.45, 0.4);
      s.normal = normalize(mix(s.normal, bumpNormal(s.normal, i.worldPos, n, 0.00015), pm));
    }
    if (inT || inS) {
      Surface st = s;
      if (inT) gerryTerry(i, st); else gerryShorts(i, st);
      float w = max(tm, sm);
      s.albedo = mix(s.albedo, st.albedo, w); s.roughness = mix(s.roughness, st.roughness, w);
      s.specular = mix(s.specular, st.specular, w); s.sheen = mix(s.sheen, st.sheen, w);
      s.sheenColor = mix(s.sheenColor, st.sheenColor, w); s.normal = normalize(mix(s.normal, st.normal, w));
      s.subsurface = mix(s.subsurface, st.subsurface, w); s.subsurfaceColor = mix(s.subsurfaceColor, st.subsurfaceColor, w);
    }
  } else if (m == 11) {                       // Lid: kurzes Fell (Strich nach unten), dunkler Lidrand
    vec3 lp = i.objPos;
    float fn = noise3(lp * vec3(2200.0, 520.0, 2200.0)) * 0.6 + noise3(lp * vec3(4800.0, 900.0, 4800.0)) * 0.4;
    float lodL = smoothstep(2.5, 0.8, length(gFw) * 2200.0);
    s.albedo = col * mix(1.0, 0.82 + 0.3 * fn, lodL);
    s.roughness = 0.75; s.specular = 0.3; s.sheen = 0.55; s.sheenColor = mix(col, vec3(1.0), 0.45);
    s.subsurface = 0.25; s.subsurfaceColor = vec3(1.0, 0.5, 0.25);
    s.emissive = s.albedo * u_sunColor * (u_furScatter * 0.5);
  } else if (m == 5) {                        // Nase
    float n = noise3(i.objPos * 1800.0);
    s.albedo = col * (0.95 + 0.1 * n);
    s.roughness = 0.36; s.specular = 0.5;
    s.subsurface = 0.4; s.subsurfaceColor = vec3(1.0, 0.35, 0.3);
    s.normal = bumpNormal(s.normal, i.worldPos, n, 0.00012);
  } else if (m == 10) {                       // Schnurrhaare / Büschel
    s.albedo = col; s.roughness = 0.35; s.specular = 0.5; s.subsurface = 0.6; s.subsurfaceColor = vec3(1.0, 0.9, 0.8);
    s.sheen = 0.4;
  } else if (m == 12 || m == 13) {            // Mundhöhle / Zunge
    s.albedo = col; s.roughness = m == 13 ? 0.35 : 0.7; s.subsurface = 0.3;
  } else {                                    // dunkel (Mundlinie), Krallen
    s.albedo = col; s.roughness = 0.5; s.specular = 0.4;
  }
  // Kleidung: gebackene SDF-AO nur in echten Spalten (sonst grauer Schmier im Schritt der Shorts)
  bool cloth = mc > 0.98 && mc < 2.5 && m != 11;
  float baoC = cloth ? smoothstep(0.15, 0.85, bao) : bao;
  s.ao = mix(1.0, baoC, mc > -0.5 && mc < 0.98 ? mix(0.85, 0.6, smoothstep(0.02, 0.06, i.color.a)) : (cloth ? 0.75 : 0.85));
  if (u_debug > 0.5) { s.albedo = u_debug > 1.5 ? vec3(gerryLiner(i.objPos), bao, 0.0) : vec3(i.color.a); s.ao = 1.0; }
}`;

const FUR_VERTEX = /* glsl */`
vec3 gerryOct(vec2 e) {
  e = e * 2.0 - 1.0;
  vec3 v = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  if (v.z < 0.0) v.xy = (1.0 - abs(v.yx)) * vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0);
  return normalize(v);
}
float gerryShellH() {
#ifdef SHELLS
  return (g_shell * (u_shellCount - 1.0) + 1.0) / u_shellCount;
#else
  return 0.0;
#endif
}
void vertexObject(inout vec3 p, inout vec3 n) {
  float h = gerryShellH();
  float L = a_color.a * u_furLen;
  vec3 f = gerryOct(a_uv);
  float comb = a_data.z;
  vec3 nn = normalize(n);
  p += nn * (L * h * (1.0 - 0.5 * comb * h)) + f * (L * comb * 0.95 * h * h);
  n = normalize(nn + f * (comb * h * 0.55));
}
void vertexWorld(inout vec3 wp, inout vec3 wn) {
  float h = gerryShellH();
  wp.y -= u_furGrav * a_color.a * u_furLen * h * h;
}`;

const FUR_SURFACE = /* glsl */`
${GLSL_COMMON}
// Strähnenfeld bei Frequenz fr: x = Abstand innen (>0 = Strähne), y = Zufallswert
vec2 gerryStrands(vec3 op, float h, float fr, float dens) {
  vec3 rp = op * fr;
  // Büschel: Spitzen zur Büschelmitte ziehen
  vec3 cq = rp * 0.22;
  vec3 cc = floor(cq);
  vec3 cp = (cc + 0.3 + 0.4 * hash33(cc)) / 0.22;
  vec3 q = mix(rp, cp, u_clump * h * h);
  vec3 c1 = floor(q); vec3 h1 = hash33(c1);
  float d1 = length(q - (c1 + 0.25 + 0.5 * h1));
  float l1 = mix(0.55, 1.0, h1.x);
  float r1 = 0.42 * (1.0 - pow(clamp(h / l1, 0.0, 1.5), 1.6));
  float a1 = r1 - d1 - (1.0 - dens) * 0.25 * step(h1.y, 0.6);
  vec3 q2 = q * 1.6 + 11.7;
  vec3 c2 = floor(q2); vec3 h2 = hash33(c2);
  float d2 = length(q2 - (c2 + 0.25 + 0.5 * h2)) / 1.6;
  float l2 = mix(0.3, 0.62, h2.x);
  float r2 = 0.42 / 1.6 * (1.0 - pow(clamp(h / l2, 0.0, 1.5), 1.6));
  float a2 = r2 - d2 - (1.0 - dens) * 0.3;
  return a1 >= a2 ? vec2(a1, h1.z) : vec2(a2, h2.z);
}
void surface(in SurfaceInput i, inout Surface s) {
  gFw = fwidth(i.objPos);
  float N = u_furShells;
  float h = (i.shell * (N - 1.0) + 1.0) / N;
  float dens = i.data.w;
  // LOD: Strähnenfrequenz in Oktaven absenken, bis eine Zelle ~u_minPx Pixel hat
  float cellPx = gerryLod(i.worldPos);
  float k = clamp(log2(u_minPx / max(cellPx, 1e-3)), 0.0, 3.0);
  float k0 = floor(k), kt = fract(k);
  // zweite LOD-Stufe nur im Übergangsbereich auswerten
  vec2 sA = kt < 0.98 ? gerryStrands(i.objPos, h, u_furFreq * exp2(-k0), dens) : vec2(0.0);
  vec2 sB = kt > 0.02 ? gerryStrands(i.objPos, h, u_furFreq * exp2(-k0 - 1.0), dens) : sA;
  if (kt >= 0.98) sA = sB;
  float a = mix(sA.x, sB.x, kt);
  float rnd = kt < 0.5 ? sA.y : sB.y;
  s.alpha = 0.5 + a * 3.0;
  if (i.objPos.y < 0.035) s.alpha -= 4.0 * gerryPadMask(i.objPos, i.objNormal, 0.0012);
  // kein Fell auf Kleidung: Schalen-Dreiecke am Bund/Saum/Band reichen per Vertex-Clustering etwas über die
  // analytische Kante hinaus -> dort hart verwerfen (sonst gestrichelte dunkle Wurzelreihen auf dem Stoff)
  if (i.objPos.y > 0.4) {
    float tmk = gerryTerryMask(i.objPos, 0.0015);
    s.alpha -= 4.0 * (tmk >= 0.0 ? tmk : gerryShortsMask(i.objPos, 0.003));
  }
  // sicher verworfene Fragmente: Rest der Oberfläche sparen (Hauptkosten bei Nahaufnahmen)
  if (s.alpha < 0.5 - 1.5 * fwidth(s.alpha)) return;
  vec3 col = i.color.rgb;
  float orange = smoothstep(0.45, 0.85, 1.0 - col.b / max(col.r, 1e-3));
  col = mix(col, u_markCol, gerryMarks(i.objPos, i.objNormal) * orange * 0.45);
  col = mix(col, u_linerCol, gerryLiner(i.objPos) * 0.3);
  col *= 0.86 + 0.28 * rnd;
  col = mix(col, col * 1.22 + 0.035, h * h * 0.55);
  s.albedo = col;
  float far = smoothstep(2.5, 0.0, cellPx);
  // Wurzeln dunkler (Selbstverschattung), helles Fell streut mehr Licht -> weniger Abdunklung (kein "Schmutzrand")
  float rootAO = mix(0.84, 0.56, orange);
  s.ao = mix(mix(rootAO, 1.0, pow(h, 0.7)), 1.0, far * 0.5) * mix(1.0, i.data.y, mix(0.3, 0.5, orange));
  s.roughness = 0.7; s.specular = 0.28;
  s.sheen = 0.65; s.sheenColor = mix(col, vec3(1.0), 0.45);
  s.subsurface = 0.32; s.subsurfaceColor = vec3(1.0, 0.45, 0.2);
  // Mehrfachstreuung im Fell: Schattenseiten bleiben warm statt schmutzig-dunkel
  s.emissive = col * u_sunColor * (u_furScatter * (0.6 + 0.4 * h));
  if (u_debug > 0.5) { s.albedo = vec3(i.color.a); }
}`;

const EYE_SURFACE = /* glsl */`
void surface(in SurfaceInput i, inout Surface s) {
  vec3 d = normalize(i.objPos);
  float ang = acos(clamp(d.z, -1.0, 1.0));
  vec2 q = d.xy / max(length(d.xy), 1e-5) * ang;
  float r = length(q) / u_irisR;
  float aa = fwidth(r) * 1.2 + 1e-4;
  // runde, große Pupille (Cartoon); Stimmung weitet/verengt sie
  float pr = 0.5 * clamp(u_pupil, 0.6, 1.5);
  float pupil = 1.0 - smoothstep(pr - aa, pr + aa, r);
  vec3 iris = mix(u_irisIn, u_irisMid, smoothstep(0.25, 0.65, r));
  iris = mix(iris, u_irisOut, smoothstep(0.62, 0.95, r));
  iris *= mix(1.15, 0.85, smoothstep(-0.5, 0.6, q.y / u_irisR));         // oben dunkler, unten heller
  iris = mix(iris, iris * 0.45, smoothstep(0.88, 1.0, r));               // Limbusring
  iris = mix(iris, vec3(0.02, 0.016, 0.015), pupil);
  vec3 sclera = vec3(0.97, 0.96, 0.93);
  float inIris = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
  vec3 col = mix(sclera, iris, inIris);
  float lidSh = smoothstep(0.1, 0.7, d.y);
  s.albedo = col;
  s.ao = 1.0 - 0.35 * lidSh;
  s.roughness = 0.1; s.specular = 0.6;
  // feste Glanzlichter (groß oben seitlich, klein unten) – freundlicher, lebendiger Blick
  vec2 hp = q / u_irisR;
  float h1 = 1.0 - smoothstep(0.2, 0.26, length(hp - vec2(-0.3, 0.38)));
  float h2 = 1.0 - smoothstep(0.08, 0.12, length(hp - vec2(0.3, -0.34)));
  s.emissive = vec3(1.0, 0.99, 0.96) * max(h1, h2 * 0.85) * 1.6 + iris * inIris * (1.0 - pupil) * 0.08;
}`;

// ============================================================================ GPU-Asset

/**
 * Gerry für den Renderer bauen (CharacterAsset, ARCHITECTURE §5.4).
 * @param {Renderer} renderer
 * @param {object} [q] Qualitätseinstellungen (renderer.q) – furShells steuert die Schalenzahl.
 * @param {object} [opts] { cell, furCell, debug }
 */
export function buildGerry(renderer, q = renderer.q, opts = {}) {
  const furShells = (q && q.furShells) || 20;
  const qn = (q && q.name) || 'high';
  const cell = opts.cell || (qn === 'low' ? 0.0108 : qn === 'medium' ? 0.0095 : 0.0086);
  const cpu = buildGerryMeshes({ ...opts, cell, furShells });
  const r = renderer;
  const hb = headbandFrame(), sp = shortsPiping(), wb = wristbandAxis();
  const eL = cpu.eyes[0];
  const bodyExtra = {};
  const common = {
    u_furFreq: opts.furFreq || 470, u_furScatter: 0.006, u_markCol: hexToLinear(GERRY_COLORS.stripeDark), u_headC: GERRY_HEAD_CENTER.slice(), u_headS: HS, u_debug: Number(opts.debug) || 0,
    u_linerCol: hexToLinear(GERRY_COLORS.liner), u_eyeR: EYE.r + LID.gap, u_eyeE: eL.E.slice(), u_eyeX: eL.fr.x.slice(), u_eyeY: eL.fr.y.slice(), u_eyeZ: eL.fr.z.slice(),
    u_bandC: hb.c, u_bandN: hb.N, u_bandHalf: hb.half, u_wbA: wb.a, u_wbD: wb.d, u_wbT: wb.t,
    u_shortsTop: sp.top, u_hemT: sp.hemT, u_pipThigh: sp.thigh, u_pipDir: sp.dir,
  };
  bodyExtra.u_padCol = LIN.pad;
  const bodyU = {
    ...common, u_bandStripe: hb.stripe, u_bandStripeCol: hexToLinear(GERRY_COLORS.green), u_terryCol: LIN.terry, u_shortsCol: LIN.shorts,
    u_pipWaist: [sp.waistY, sp.seamZ], u_pipW: sp.waistHalf, u_pipHem: [sp.hem0, sp.hem1],
    u_pipCol: hexToLinear(GERRY_COLORS.piping),
    ...bodyExtra, u_earB: EAR_BASE.slice(), u_earV: cpu.info.ear.v.slice(), u_earDeep: hexToLinear(GERRY_COLORS.innerEarDeep), u_earLight: LIN.innerEar, u_earRim: LIN.cream,
  };
  const bodyMat = r.createMaterial({ name: 'gerry-body', uniforms: bodyU, surface: BODY_SURFACE });
  const furMat = (shells, nm) => r.createMaterial({
    name: nm,
    uniforms: { ...common, u_furLen: opts.furLen || 0.034, u_furGrav: 0.25, u_furShells: shells, u_clump: 0.45, u_minPx: 1.6 },
    vertex: FUR_VERTEX, surface: FUR_SURFACE, alphaTest: 0.5, castShadow: false,
  });
  const eyeMat = r.createMaterial({
    name: 'gerry-eye',
    uniforms: {
      u_pupil: 1.0, u_irisR: 0.74,
      u_irisIn: hexToLinear('#F2D45A'), u_irisMid: hexToLinear('#8CCB4A'), u_irisOut: hexToLinear('#3E8A3A'),
    },
    surface: EYE_SURFACE,
  });
  const parts = [
    { name: 'body', mesh: r.createMesh(cpu.body), material: bodyMat, skinned: true, castShadow: true },
    { name: 'furLong', mesh: r.createMesh(cpu.furLong), material: furMat(cpu.shells.long, 'gerry-fur-long'), skinned: true, shells: cpu.shells.long, castShadow: false },
    { name: 'furShort', mesh: r.createMesh(cpu.furShort), material: furMat(cpu.shells.short, 'gerry-fur-short'), skinned: true, shells: cpu.shells.short, castShadow: false },
  ];
  const meshCache = new Map();
  const gpu = (m) => { if (!meshCache.has(m)) meshCache.set(m, r.createMesh(m)); return meshCache.get(m); };
  const attachments = cpu.attachments.map((a) => ({
    name: a.name, bone: a.bone, mesh: gpu(a.mesh), material: a.kind === 'eye' ? eyeMat : bodyMat, offset: a.offset,
    castShadow: a.castShadow !== false,
  }));
  const byName = Object.fromEntries(attachments.map((a, k) => [a.name, { gpu: a, cpu: cpu.attachments[k] }]));
  const face = createFace(byName, eyeMat);
  face.update(0, { blink: 0 });
  const g = cpu.grip;
  const hr = GERRY_JOINTS.hand_r, hl = GERRY_JOINTS.hand_l;
  return {
    id: 'gerry', name: 'Gerry',
    skeletonDef: cpu.skeletonDef,
    parts, attachments,
    gripSocket: gripFrame('hand_r', sub(g.r.G, hr), g.r.t, g.r.pn),
    leftHandGrip: gripFrame('hand_l', sub(g.l.G, hl), g.l.t, g.l.pn),
    face,
    secondary: { tail: ['tail_0', 'tail_1', 'tail_2', 'tail_3', 'tail_4', 'tail_5'], ears: ['ear_l', 'ear_r'] },
    readyPose: { hand_r: [-55, 0, -14] },   // Schläger in Bereitschaft vor der Brust statt vor dem Gesicht
    relaxedPose: { hand_r: [-50, 0, -10] }, // locker: Schläger zeigt nach vorn-unten
    racketStyle: { frame: [0.018, 0.018, 0.02], accent: hexToLinear('#F07D1E'), grip: [0.025, 0.025, 0.027] },
    heightM: GERRY_HEIGHT,
    headCenter: GERRY_HEAD_CENTER.slice(),
    stats: cpu.stats,
    /**
     * Fell-LOD (optional, für den Runtime): Schalenzahl je Part abhängig von der Bildschirmhöhe der Figur in px.
     * Rückgabe parallel zu parts (0 = Part ohne Fell). Klein im Bild (Broadcast) reichen wenige Schalen.
     */
    furLod(screenPx) {
      const f = screenPx < 160 ? 0.3 : screenPx < 420 ? 0.6 : 1;
      return parts.map((p) => (p.shells ? Math.max(3, Math.round(p.shells * f)) : 0));
    },
    /** Wendet furLod auf Drawables an (parallel zu parts): d.shells + d.uniforms.u_furShells. */
    applyFurLod(drawables, screenPx) {
      const n = this.furLod(screenPx);
      for (let k = 0; k < parts.length; k++) {
        const d = drawables[k]; if (!d || !n[k]) continue;
        if (d.shells !== n[k]) { d.shells = n[k]; d.uniforms = d.uniforms || {}; d.uniforms.u_furShells = n[k]; }
      }
    },
    materials: { body: bodyMat, eye: eyeMat, furLong: parts[1].material, furShort: parts[2].material },
  };
}

/**
 * Griff-Sockel (Konvention wie tom.js): Schlägerrahmen in der Hand, +Y (Schaft) = Daumenrichtung der Faust,
 * +Z (Saitennormale) = Handflächennormale. matrix = T(offset) * R(rotation) im Hand-Knochenraum (Ruhe).
 * Schläger-Weltmatrix = charModel * skel.world[bone] * matrix.
 */
function gripFrame(bone, offset, axis, palm) {
  const y = nrm(axis), z = nrm(sub(palm, scl(y, dot(palm, y)))), x = nrm(cross(y, z));
  const rotation = quatFromBasis(x, y, z);
  const matrix = mat4.fromRotationTranslation(mat4.create(), rotation, offset);
  return { bone, offset, rotation, matrix, axis: y, palm: z };
}

// ============================================================================ Gesicht (Blinzeln, Blick, Stimmung)

const MOODS = {
  neutral: { up: 0, lo: 0, pupil: 1.0, tilt: 0, mouth: 0 },
  happy: { up: 9, lo: -13, pupil: 1.45, tilt: -3, mouth: 1 },
  focused: { up: 4, lo: -3, pupil: 0.95, tilt: 0, mouth: 0 },   // im Ballwechsel fast immer aktiv: wach, nicht grimmig
  sad: { up: 17, lo: 0, pupil: 1.5, tilt: -12, mouth: 0 },
};

function createFace(byName, eyeMat) {
  const st = { blink: 0, up: 0, lo: 0, pupil: 1, tilt: 0, mouth: 0, yaw: 0, pitch: 0, auto: 0, next: 2.2, dbl: false };
  // automatisches Blinzeln (blink undefined): 0.16 s, Abstand 2–5 s, gelegentlich doppelt
  let seed = 0x9e3779b9;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const autoBlink = (dt) => {
    st.next -= dt;
    if (st.next <= 0) { st.auto = 0.16; st.next = st.dbl ? 0.24 : 2 + 3 * rnd(); st.dbl = !st.dbl && rnd() < 0.18; }
    if (st.auto > 0) { st.auto = Math.max(0, st.auto - dt); return Math.sin((1 - st.auto / 0.16) * Math.PI); }
    return 0;
  };
  const closeUp = LID.top - LID.bot - 2;   // Oberlid bis zum Unterlid
  const tmpQ = quat.create(), tmpM = mat4.create(), tmpR = mat4.create();
  const items = Object.values(byName);
  const face = {
    state: st,
    /**
     * @param {number} dt
     * @param {{ blink?: number, mood?: 'neutral'|'happy'|'focused'|'sad', lookDir?: number[] }} o
     *   blink 0 (offen) .. 1 (zu), undefined = automatisch; lookDir = Blickrichtung im Kopf-Knochenraum (Ruhe: +Z vorn),
     *   null = geradeaus.
     */
    update(dt, o = {}) {
      const md = MOODS[o.mood] || MOODS.neutral;
      const k = dt > 0 ? 1 - Math.exp(-dt * 14) : 1;
      const kb = dt > 0 ? 1 - Math.exp(-dt * 40) : 1;
      st.up += (md.up - st.up) * k; st.lo += (md.lo - st.lo) * k; st.pupil += (md.pupil - st.pupil) * k * 0.6;
      st.tilt += (md.tilt - st.tilt) * k; st.mouth += (md.mouth - st.mouth) * k;
      const bt = o.blink === undefined || o.blink === null ? autoBlink(dt) : clamp(o.blink, 0, 1);
      st.blink += (bt - st.blink) * kb;
      let yaw = 0, pitch = 0;
      if (o.lookDir) {
        const d = o.lookDir, l = Math.hypot(d[0], d[1], d[2]) || 1;
        yaw = clamp(Math.atan2(d[0] / l, d[2] / l), -0.45, 0.45);
        pitch = clamp(Math.atan2(d[1] / l, Math.hypot(d[0], d[2]) / l), -0.32, 0.32);
      }
      st.yaw += (yaw - st.yaw) * kb; st.pitch += (pitch - st.pitch) * kb;
      eyeMat.uniforms.u_pupil = st.pupil;
      const b = st.blink;
      for (const { gpu, cpu } of items) {
        if (!cpu.kind || cpu.kind === 'static') continue;
        if (cpu.kind === 'mouthOpen') {
          const sc = Math.max(st.mouth, 1e-4);
          mat4.fromTranslation(gpu.offset, cpu.anchor);
          mat4.scale(gpu.offset, gpu.offset, [sc, sc, sc]);
          mat4.multiply(gpu.offset, gpu.offset, mat4.fromTranslation(tmpR, cpu.anchorNeg));
          continue;
        }
        const sideSign = cpu.side === 'l' ? 1 : -1;
        if (cpu.kind === 'eye') {
          // Blick: Gieren um Kopf-Y, Nicken um lokale X
          quat.identity(tmpQ);
          quat.rotateY(tmpQ, tmpQ, st.yaw);
          quat.rotateX(tmpQ, tmpQ, -st.pitch);
          mat4.fromQuat(tmpR, tmpQ);
          // offset = T(E) * Rlook(Kopfraum) * Rframe
          const base = cpu.base;
          mat4.copy(tmpM, base); tmpM[12] = tmpM[13] = tmpM[14] = 0;
          mat4.multiply(gpu.offset, tmpR, tmpM);
          gpu.offset[12] = base[12]; gpu.offset[13] = base[13]; gpu.offset[14] = base[14];
          continue;
        }
        // Lider: Rotation um lokale X-Achse (positiv = Kante nach unten), Neigung um lokale Z
        let ang, tilt;
        const lookPitch = st.pitch * 57.3;
        if (cpu.kind === 'lidUp') {
          const open = st.up - lookPitch * 0.55;
          ang = open + (closeUp + 4 - open) * b;
          tilt = st.tilt * sideSign * (1 - b);
        } else {
          const open = st.lo - lookPitch * 0.25;
          ang = open + (-6 - open) * b;
          tilt = -st.tilt * 0.3 * sideSign * (1 - b);
        }
        quat.identity(tmpQ);
        quat.rotateZ(tmpQ, tmpQ, tilt * DEG);
        quat.rotateX(tmpQ, tmpQ, ang * DEG);
        mat4.fromQuat(tmpR, tmpQ);
        mat4.multiply(gpu.offset, cpu.base, tmpR);
      }
    },
  };
  return face;
}

// Publikum (Art-Pass nach Kunden-Referenz): weniger, dafür hochwertigere Zuschauer. ~50 % Auslastung in
// Gruppen (Freunde/Familien) mit sichtbaren freien Sitzen; detaillierte Figuren (Proportionen, Hals, Ohren,
// Kinnpartie, Haare, Hände, Schuhe, Kleider/Shorts, weibl./männl. Silhouette) und Hüte (Kappe, Sonnenhut,
// Panama) in einer eigenen Instanzliste. Zwei LOD-Stufen (CPU-Aufteilung nach Kameraabstand).
// Arme/Beine entstehen im Vertex-Shader aus Gelenkpositionen je Pose (sitzen, Arme verschränkt, klatschen,
// jubeln, "ooh", stehen); Kopf folgt dem Ball. Licht (Dachschatten, Himmelssicht) je Instanz vorberechnet.
import { MeshBuilder } from './mb.js';
import { hex, roofShadowAt, skyVisAt } from './envlib.js';
import { mat4, damp } from '../core/math.js';
import { rng32 } from './layout.js';

// a_data = (Farbe, Teil, Variante, t)
// Teil: 0 Rumpf, 1 Kopf, 2/3 Ober-/Unterarm links, 4/5 rechts, 6/7 Ober-/Unterschenkel links, 8/9 rechts, 10/11 Fuß l/r
// Farbe: 0 Hemd, 1 Haut, 2 Haar, 3 Beine, 4 Hut, 5 Augen/Brille, 6 Mund, 8 Schuh
// Variante: 0 immer, 1 Kappe, 2 Sonnenhut, 3 Sonnenbrille, 4 lange Haare, 5 Panama
// Instanz: color = (Hemd rgb, gepackt: Haut3|Haar3|Hose2|Hutfarbe2|Flags7|Himmel4|Schatten2)
//          data  = (Phase, s, Energie, Stil: Beine2 (0 Hose, 1 Shorts, 2 Kleid) | Schuh2<<2 | weiblich<<4 | Arme verschränkt<<5)
// Flags: Bit0-1 Huttyp (1 Kappe, 2 Sonnenhut, 3 Panama), 2 Brille, 3 lange Haare, 4 kurze Ärmel, 5 Streifen, 6 Glatze

function figureBuilder() {
  const mb = new MeshBuilder();
  const add = (x, y, z, nx, ny, nz, col, part, variant = 0, t = 0) => mb.v(x, y, z, nx, ny, nz, 0, 0, [1, 1, 1, 1], [col, part, variant, t]);
  // Ellipsoid; deform(x,y,z,cy) -> [x,y,z] optional (z.B. Kinnpartie)
  const ellipsoid = (c, rx, ry, rz, segs, rings, col, part, variant, ringMax = rings, deform = null, t = 0) => {
    const base = mb.vertexCount;
    for (let j = 0; j <= ringMax; j++) {
      const th = (j / rings) * Math.PI;
      const cy = Math.cos(th), sy = Math.sin(th);
      for (let i = 0; i <= segs; i++) {
        const ph = (i / segs) * Math.PI * 2;
        const nx = Math.sin(ph) * sy, nz = Math.cos(ph) * sy;
        let x = c[0] + nx * rx, y = c[1] + cy * ry, z = c[2] + nz * rz;
        if (deform) [x, y, z] = deform(x, y, z, cy, nz);
        add(x, y, z, nx / rx, cy / ry, nz / rz, col, part, variant, t);
      }
    }
    for (let j = 0; j < ringMax; j++) for (let i = 0; i < segs; i++) {
      const a = base + j * (segs + 1) + i, b = a + 1, c2 = a + segs + 1, d = c2 + 1;
      if (j > 0) mb.tri(a, c2, b);
      if (j < rings - 1) mb.tri(b, c2, d);
    }
  };
  const torso = (segs, rings, col = 0, part = 0, variant = 0) => {
    const base = mb.vertexCount;
    for (const R of rings) {
      for (let i = 0; i <= segs; i++) {
        const ph = (i / segs) * Math.PI * 2;
        const sx = Math.sin(ph), cz = Math.cos(ph);
        add(sx * R.w, R.y, R.z + cz * R.d, sx / R.w, R.ny || 0, cz / R.d, col, part, variant, R.t || 0);
      }
    }
    for (let j = 0; j < rings.length - 1; j++) for (let i = 0; i < segs; i++) {
      const a = base + j * (segs + 1) + i, b = a + 1, c = a + segs + 1, d = c + 1;
      mb.tri(a, b, d); mb.tri(a, d, c);
    }
  };
  // Gliedmaßen: a_position = (ox, oy, t); Lage im Shader aus Gelenken. prof = [[t, r], ...]
  const limb = (part, col, sides, prof, cap) => {
    const base = mb.vertexCount;
    for (const [t, r] of prof) for (let i = 0; i <= sides; i++) {
      const ph = (i / sides) * Math.PI * 2 + Math.PI / sides;
      const ox = Math.cos(ph), oy = Math.sin(ph);
      add(ox * r, oy * r, t, ox, oy, 0, col, part, 0, t);
    }
    for (let k = 0; k < prof.length - 1; k++) for (let i = 0; i < sides; i++) {
      const a = base + k * (sides + 1) + i, b = a + 1, c = a + sides + 1, d = c + 1;
      mb.tri(a, c, d); mb.tri(a, d, b);
    }
    if (!cap) return;
    const tip = mb.vertexCount;
    const [tl, rl] = prof[prof.length - 1];
    add(0, 0, tl + rl * 0.8, 0, 0, 1, col, part, 0, 1);
    const last = base + (prof.length - 1) * (sides + 1);
    for (let i = 0; i < sides; i++) mb.tri(last + i, tip, last + i + 1);
  };
  const quad2 = (pts, n, col, part, variant, twoSided) => {
    const b = mb.vertexCount;
    for (const p of pts) add(p[0], p[1], p[2], n[0], n[1], n[2], col, part, variant);
    mb.tri(b, b + 1, b + 2); mb.tri(b, b + 2, b + 3);
    if (twoSided) {
      const b2 = mb.vertexCount;
      for (const p of pts) add(p[0], p[1], p[2], -n[0], -n[1], -n[2], col, part, variant);
      mb.tri(b2, b2 + 2, b2 + 1); mb.tri(b2, b2 + 3, b2 + 2);
    }
  };
  // Ring-Fläche (Krempe): r0 -> r1 bei Höhe y0 -> y1 (Hängen), zweiseitig
  const brim = (cy, cz, r0, r1, y0, y1, segs, col, part, variant, tilt = 0) => {
    for (const side of [1, -1]) {
      const rb = mb.vertexCount;
      for (const [r, y] of [[r0, y0], [r1, y1]]) for (let i = 0; i <= segs; i++) {
        const ph = (i / segs) * Math.PI * 2;
        const sx = Math.sin(ph), cz2 = Math.cos(ph);
        add(sx * r, y + tilt * cz2 * (r - r0), cz + cz2 * r, 0, side, 0, col, part, variant);
      }
      for (let i = 0; i < segs; i++) {
        const a = rb + i, b = a + 1, c = a + segs + 1, d = c + 1;
        if (side > 0) { mb.tri(a, b, d); mb.tri(a, d, c); } else { mb.tri(a, d, b); mb.tri(a, c, d); }
      }
    }
  };
  const finish = () => { const md = mb.finish(); delete md.colors; return md; };
  return { mb, add, ellipsoid, torso, limb, quad2, brim, finish };
}

// Rumpf (sitzend, Hüfte bei y 0.5). t = 1 kennzeichnet Halsring (Haut)
const TORSO_HI = [
  { y: 0.455, w: 0.158, d: 0.112, z: -0.07, ny: -0.6 },
  { y: 0.52, w: 0.168, d: 0.118, z: -0.07 },
  { y: 0.66, w: 0.152, d: 0.106, z: -0.066 },
  { y: 0.82, w: 0.168, d: 0.11, z: -0.07 },
  { y: 0.94, w: 0.196, d: 0.118, z: -0.075 },
  { y: 1.005, w: 0.186, d: 0.1, z: -0.075, ny: 0.5 },
  { y: 1.05, w: 0.11, d: 0.075, z: -0.07, ny: 0.9 },
  { y: 1.068, w: 0.058, d: 0.052, z: -0.064, ny: 0.3, t: 1 },
  { y: 1.15, w: 0.05, d: 0.048, z: -0.058, t: 1 },
];
const HEAD_C = [0, 1.222, -0.048];
// Kinnpartie: unten schmaler und leicht nach vorne
const headDeform = (x, y, z, cy) => {
  if (cy < -0.1) { const k = -cy; x *= 1 - 0.22 * k; z += 0.012 * k; }
  if (cy > 0.2) z -= 0.008 * cy;
  return [x, y, z];
};

/** Nahe Stufe (~470 Dreiecke). */
function buildFigureHi() {
  const F = figureBuilder();
  F.torso(8, TORSO_HI);
  F.ellipsoid(HEAD_C, 0.086, 0.112, 0.099, 8, 6, 1, 1, 0, 6, headDeform);
  // Nase
  { const b = F.mb.vertexCount;
    F.add(-0.012, 1.2, 0.045, -0.6, -0.2, 0.7, 1, 1); F.add(0.012, 1.2, 0.045, 0.6, -0.2, 0.7, 1, 1);
    F.add(0, 1.234, 0.05, 0, 0.3, 0.9, 1, 1); F.add(0, 1.202, 0.066, 0, -0.1, 1, 1, 1);
    F.mb.tri(b, b + 3, b + 2); F.mb.tri(b + 1, b + 2, b + 3); F.mb.tri(b, b + 1, b + 3); }
  // Ohren
  for (const sx of [-1, 1]) F.ellipsoid([sx * 0.085, 1.222, -0.056], 0.015, 0.028, 0.019, 4, 2, 1, 1, 0);
  // Haare: Kappe oben/hinten, lange Haare als Schale hinter dem Kopf
  F.ellipsoid([0, 1.242, -0.064], 0.092, 0.11, 0.104, 8, 6, 2, 1, 0, 3);
  F.ellipsoid([0, 1.13, -0.088], 0.092, 0.13, 0.072, 6, 4, 2, 1, 4);
  // Augen, Mund
  for (const sx of [-1, 1]) F.quad2([[sx * 0.032 - 0.012, 1.226, 0.043], [sx * 0.032 + 0.012, 1.226, 0.043], [sx * 0.032 + 0.012, 1.24, 0.041], [sx * 0.032 - 0.012, 1.24, 0.041]], [0, 0, 1], 5, 1, 0, false);
  F.quad2([[-0.021, 1.172, 0.046], [0.021, 1.172, 0.046], [0.019, 1.18, 0.048], [-0.019, 1.18, 0.048]], [0, -0.2, 1], 6, 1, 0, false);
  // Sonnenbrille
  F.quad2([[-0.076, 1.218, 0.049], [0.076, 1.218, 0.049], [0.076, 1.25, 0.045], [-0.076, 1.25, 0.045]], [0, 0, 1], 5, 1, 3, false);
  // Arme (Unterarm mit Handgelenk + Hand), Beine, Füße
  const UA = [[0, 0.057], [1, 0.048]];
  const FA = [[0, 0.048], [0.8, 0.036], [0.92, 0.04], [1.0, 0.033]];
  F.limb(2, 0, 5, UA, false); F.limb(3, 0, 5, FA, true);
  F.limb(4, 0, 5, UA, false); F.limb(5, 0, 5, FA, true);
  const TH = [[0, 0.078], [1, 0.06]];
  const SH = [[0, 0.055], [0.35, 0.052], [1, 0.04]];
  F.limb(6, 3, 6, TH, false); F.limb(7, 3, 5, SH, false);
  F.limb(8, 3, 6, TH, false); F.limb(9, 3, 5, SH, false);
  const FT = [[0, 0.042], [1, 0.038]];
  F.limb(10, 8, 4, FT, true); F.limb(11, 8, 4, FT, true);
  return F.finish();
}

/** Ferne Stufe (~160 Dreiecke). */
function buildFigureLo() {
  const F = figureBuilder();
  F.torso(6, [TORSO_HI[0], TORSO_HI[2], TORSO_HI[4], TORSO_HI[6], { ...TORSO_HI[8], t: 1 }]);
  F.ellipsoid(HEAD_C, 0.087, 0.113, 0.1, 6, 4, 1, 1, 0, 4, headDeform);
  F.ellipsoid([0, 1.244, -0.066], 0.093, 0.111, 0.105, 6, 4, 2, 1, 0, 2);
  F.ellipsoid([0, 1.13, -0.09], 0.092, 0.13, 0.07, 5, 3, 2, 1, 4);
  F.limb(2, 0, 3, [[0, 0.052], [1, 0.046]], false);
  F.limb(3, 0, 3, [[0, 0.045], [0.8, 0.036], [1, 0.034]], false);
  F.limb(4, 0, 3, [[0, 0.052], [1, 0.046]], false);
  F.limb(5, 0, 3, [[0, 0.045], [0.8, 0.036], [1, 0.034]], false);
  F.limb(6, 3, 4, [[0, 0.078], [1, 0.06]], false);
  F.limb(7, 3, 3, [[0, 0.056], [1, 0.044]], false);
  F.limb(8, 3, 4, [[0, 0.078], [1, 0.06]], false);
  F.limb(9, 3, 3, [[0, 0.056], [1, 0.044]], false);
  F.limb(10, 8, 3, [[0, 0.045], [1, 0.04]], false);
  F.limb(11, 8, 3, [[0, 0.045], [1, 0.04]], false);
  return F.finish();
}

/** Hüte (je Typ eigene Instanzliste): 1 Kappe, 2 Sonnenhut, 3 Panama. t = 1 -> Hutband. */
function buildHat(type) {
  const F = figureBuilder();
  const cz = -0.056;
  if (type === 1) {
  // Kappe: Kalotte + Schirm
  F.ellipsoid([0, 1.248, cz], 0.091, 0.098, 0.102, 8, 6, 4, 1, 1, 3);
  { const b = F.mb.vertexCount, y = 1.262;
    const P = [[-0.075, y, 0.025], [0.075, y, 0.025], [0.07, y - 0.022, 0.135], [-0.07, y - 0.022, 0.135], [0, y - 0.012, 0.15]];
    for (const side of [1, -1]) {
      const s0 = F.mb.vertexCount;
      for (const p of P) F.add(p[0], p[1], p[2], 0, side, 0.15 * side, 4, 1, 1);
      if (side > 0) { F.mb.tri(s0, s0 + 2, s0 + 1); F.mb.tri(s0, s0 + 3, s0 + 2); F.mb.tri(s0 + 3, s0 + 4, s0 + 2); }
      else { F.mb.tri(s0, s0 + 1, s0 + 2); F.mb.tri(s0, s0 + 2, s0 + 3); F.mb.tri(s0 + 3, s0 + 2, s0 + 4); }
    }
    void b; }
  } else if (type === 2) {
  // Sonnenhut: runde Krone, Band, breite, leicht hängende Krempe
  F.ellipsoid([0, 1.262, cz], 0.096, 0.088, 0.104, 10, 6, 4, 1, 2, 3);
  F.torso(10, [{ y: 1.262, w: 0.099, d: 0.107, z: cz, t: 1 }, { y: 1.29, w: 0.097, d: 0.105, z: cz, t: 1 }], 4, 1, 2);
  F.brim(1.262, cz, 0.1, 0.225, 1.264, 1.232, 12, 4, 1, 2);
  } else {
  // Panama: kantige Krone mit eingedrückter Oberseite, schwarzes Band, mittlere Krempe (hinten leicht hoch)
  F.torso(10, [
    { y: 1.262, w: 0.1, d: 0.11, z: cz, t: 1 }, { y: 1.288, w: 0.098, d: 0.108, z: cz, t: 1 },
    { y: 1.29, w: 0.098, d: 0.108, z: cz }, { y: 1.345, w: 0.088, d: 0.098, z: cz, ny: 0.3 },
    { y: 1.35, w: 0.07, d: 0.082, z: cz, ny: 1 }, { y: 1.338, w: 0.02, d: 0.03, z: cz, ny: 1 },
  ], 4, 1, 5);
  F.brim(1.262, cz, 0.1, 0.17, 1.262, 1.256, 10, 4, 1, 5, -0.12);
  }
  // an den (größeren) Kopf anpassen: um Kopfmitte skalieren
  const md = F.finish(), P = md.positions;
  for (let i = 0; i < P.length; i += 3) { P[i] *= 1.08; P[i + 1] = HEAD_C[1] + (P[i + 1] - HEAD_C[1]) * 1.08 + 0.004; P[i + 2] = HEAD_C[2] + (P[i + 2] - HEAD_C[2]) * 1.08; }
  return md;
}

const CROWD_VERTEX = `
// Uniforms: u_look/u_look2 (geglättete Ballposition schnell/träge), u_react (x Klatschen, y Jubel, z Stehen, w Ooh),
// u_wave (x Amplitude, y Zentrum 0..1, z Breite), u_motion (globale Bewegungsstärke)
mat3 cr_rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 cr_rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
float cr_part(float env, float energy) { float th = (1.0 - energy) * 0.75; return smoothstep(th, th + 0.25, env); }
void vertexObject(inout vec3 p, inout vec3 n) {
  int part = int(a_data.y + 0.5);
  int vmask = int(a_data.z + 0.5);
  int pk = int(g_instColor.a + 0.5);
  int flags = (pk >> 10) & 127;
  int hat = flags & 3;
  int style = int(g_instData.w + 0.5);
  float female = float((style >> 4) & 1);
  float crossed = float((style >> 5) & 1);
  float dress = (style & 3) == 2 ? 1.0 : 0.0;
  if (vmask != 0) {
    bool show = (vmask == 1 && hat == 1) || (vmask == 2 && hat == 2) || (vmask == 5 && hat == 3)
             || (vmask == 3 && (flags & 4) != 0) || (vmask == 4 && (flags & 8) != 0);
    if (!show) { p = vec3(0.0); n = vec3(0.0, 1.0, 0.0); return; }
  }
  float phase = g_instData.x, energy = g_instData.z;
  float t = u_time * u_motion + phase * 61.0;
  float ds = abs(fract(g_instData.y - u_wave.y + 0.5) - 0.5);
  float wave = u_wave.x * exp(-ds * ds / (u_wave.z * u_wave.z));
  float stand = max(u_react.z * cr_part(u_react.z, energy * 0.8 + 0.2) * step(0.1, energy), wave);
  float cheer = max(u_react.y * cr_part(u_react.y, energy), wave);
  float clap = u_react.x * cr_part(u_react.x, energy) * (1.0 - cheer);
  float ooh = u_react.w * cr_part(u_react.w, energy) * (1.0 - cheer);
  float rest = 1.0 - max(max(clap, cheer), max(ooh, stand));
  // Blickrichtung (lokal)
  vec3 W = i_model[3].xyz;
  vec3 tgt = mix(u_look, u_look2, fract(phase * 7.3));
  tgt.x += (fract(phase * 91.7) - 0.5) * 0.6;
  vec3 dW = tgt - (W + i_model[1].xyz * 1.2);
  float lx = dot(dW, i_model[0].xyz), ly = dot(dW, i_model[1].xyz), lz = dot(dW, i_model[2].xyz);
  // gelegentlich kurzer Blick zum Nachbarn (Gespräch)
  float chat = smoothstep(0.86, 0.96, sin(t * 0.13 + phase * 17.0)) * rest * (fract(phase * 3.7) < 0.5 ? 1.0 : -1.0);
  float yawL = clamp(atan(lx, max(lz, 0.05)), -1.2, 1.2) + sin(t * 0.37) * 0.05 + chat * 0.9;
  float pitchL = clamp(atan(-ly, length(vec2(lx, lz))), -0.45, 0.55);
  float bodyYaw = yawL * 0.22 + sin(t * 0.21) * 0.03;
  vec3 hipRest = vec3(0.0, 0.5, -0.07);
  vec3 hip = mix(hipRest, vec3(0.0, 0.92, 0.0), stand);
  hip.y += wave * 0.05 * sin(t * 3.0) + sin(t * 0.9) * 0.003;
  float lean = sin(t * 0.53) * 0.025 - cheer * 0.06 + ooh * 0.08 - stand * 0.06 - crossed * rest * 0.05;
  mat3 Rt = cr_rotY(bodyYaw) * cr_rotX(lean);
  if (part == 0) {
    // Silhouette: Frauen schmalere Schultern, etwas breitere Hüfte
    float sc = 1.0 + female * (0.06 * smoothstep(0.66, 0.5, p.y) - 0.1 * smoothstep(0.8, 0.98, p.y));
    float br = 1.0 + 0.012 * sin(t * 1.6);   // Atmung
    p.x *= sc; p.z = (p.z + 0.07) * br - 0.07;
    p = hip + Rt * (p - hipRest); n = Rt * n; return;
  }
  if (part == 1) {
    vec3 neck = vec3(0.0, 1.1, -0.06);
    mat3 Rh = cr_rotY(yawL - bodyYaw) * cr_rotX(pitchL * 0.8 + sin(t * 0.8) * 0.02 - ooh * 0.15);
    p = hip + Rt * (neck - hipRest + Rh * (p - neck)); n = Rt * (Rh * n);
    return;
  }
  float sg = (part == 2 || part == 3 || part == 6 || part == 7 || part == 10) ? 1.0 : -1.0;
  vec3 A, B;
  if (part <= 5) {
    float shX = mix(0.188, 0.17, female);
    vec3 S = vec3(sg * shX, 0.975, -0.075);
    // Ruhe: Hände auf den Oberschenkeln oder Arme verschränkt
    vec3 ErA = mix(vec3(sg * 0.2, 0.75, -0.02), vec3(sg * 0.23, 0.74, -0.06), stand);
    vec3 HrA = mix(vec3(sg * 0.11, 0.6, 0.2), vec3(sg * 0.24, 0.52, -0.01), stand);
    vec3 ErX = vec3(sg * 0.19, 0.78, 0.06);
    vec3 HrX = vec3(-sg * 0.075, 0.83 + sg * 0.03, 0.1);
    vec3 Er = mix(ErA, ErX, crossed * (1.0 - stand));
    vec3 Hr = mix(HrA, HrX, crossed * (1.0 - stand));
    float cl = 0.5 + 0.5 * sin(t * (19.0 + 6.0 * fract(phase * 13.0)));
    vec3 Ec = vec3(sg * 0.22, 0.86, 0.12);
    vec3 Hc = vec3(sg * (0.018 + 0.07 * cl), 1.0 + 0.02 * cl, 0.3);
    float wav = sin(t * 7.0 + sg) * 0.06;
    vec3 Ej = vec3(sg * 0.29, 1.28, -0.03);
    vec3 Hj = vec3(sg * (0.26 + wav), 1.6, 0.05 + wav * 0.5);
    vec3 Eo = vec3(sg * 0.25, 1.0, 0.1);
    vec3 Ho = vec3(sg * 0.1, 1.24, 0.06);
    vec3 E = mix(mix(mix(Er, Ec, clap), Eo, ooh), Ej, cheer);
    vec3 H = mix(mix(mix(Hr, Hc, clap), Ho, ooh), Hj, cheer);
    bool upper = part == 2 || part == 4;
    A = hip + Rt * ((upper ? S : E) - hipRest);
    B = hip + Rt * ((upper ? E : H) - hipRest);
  } else {
    float kx = mix(0.115, 0.075, dress);
    vec3 Hp = mix(vec3(sg * 0.095, 0.5, -0.04), vec3(sg * 0.1, 0.92, 0.0), stand);
    vec3 Kp = mix(vec3(sg * kx, 0.52, 0.36), vec3(sg * 0.1, 0.5, 0.05), stand);
    vec3 Ap = mix(vec3(sg * (kx + 0.01), 0.1, 0.4), vec3(sg * 0.1, 0.1, 0.04), stand);
    vec3 Tp = Ap + vec3(sg * 0.015, -0.055, 0.15);
    if (part == 10 || part == 11) { A = Ap; B = Tp; }
    else { bool upper = part == 6 || part == 8; A = upper ? Hp : Kp; B = upper ? Kp : Ap; }
  }
  vec3 axis = B - A;
  float len = max(length(axis), 1e-4);
  vec3 Z = axis / len;
  vec3 U = normalize(cross(abs(Z.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), Z));
  vec3 V = cross(Z, U);
  p = A + Z * (p.z * len) + U * p.x + V * p.y;
  n = normalize(U * n.x + V * n.y + Z * n.z);
}`;

const CROWD_SURFACE = `
vec3 cr_skin(int k) {
  return k == 0 ? vec3(0.78, 0.56, 0.45) : k == 1 ? vec3(0.70, 0.47, 0.35) : k == 2 ? vec3(0.56, 0.36, 0.25)
       : k == 3 ? vec3(0.38, 0.23, 0.15) : k == 4 ? vec3(0.22, 0.13, 0.08) : vec3(0.74, 0.52, 0.40);
}
vec3 cr_hair(int k) {
  return k == 0 ? vec3(0.02, 0.015, 0.012) : k == 1 ? vec3(0.06, 0.035, 0.02) : k == 2 ? vec3(0.14, 0.075, 0.035)
       : k == 3 ? vec3(0.34, 0.21, 0.1) : k == 4 ? vec3(0.62, 0.48, 0.25) : k == 5 ? vec3(0.3, 0.1, 0.035)
       : k == 6 ? vec3(0.36, 0.35, 0.33) : vec3(0.7, 0.68, 0.64);
}
vec3 cr_hat(int type, int k) {
  if (type == 1) return k == 0 ? vec3(0.9, 0.9, 0.87) : k == 1 ? vec3(0.05, 0.08, 0.18) : k == 2 ? vec3(0.06, 0.24, 0.15) : vec3(0.62, 0.08, 0.07);
  if (type == 2) return k == 0 ? vec3(0.8, 0.67, 0.44) : k == 1 ? vec3(0.92, 0.89, 0.82) : k == 2 ? vec3(0.86, 0.76, 0.55) : vec3(0.9, 0.72, 0.72);
  return k == 0 ? vec3(0.9, 0.86, 0.76) : k == 1 ? vec3(0.8, 0.7, 0.5) : k == 2 ? vec3(0.93, 0.92, 0.88) : vec3(0.7, 0.6, 0.45);
}
void surface(in SurfaceInput i, inout Surface s) {
  int col = int(i.data.x + 0.5);
  int part = int(i.data.y + 0.5);
  float t = i.data.w;
  int pk = int(i.instColor.a + 0.5);
  int flags = (pk >> 10) & 127;
  int style = int(i.instData.w + 0.5);
  int leg = style & 3;
  vec3 skin = cr_skin(pk & 7);
  vec3 shirt = i.instColor.rgb;
  vec3 c = shirt;
  float rough = 0.8;
  float sheen = 0.3;
  if (col == 0) {
    if ((flags & 32) != 0) c *= mix(1.0, 0.6, step(0.5, fract(i.worldPos.y * 18.0)));
    if (part == 0 && t > 0.5) c = skin;                       // Hals
    bool sleeve = (flags & 16) != 0;
    if ((part == 3 || part == 5) && (t > 0.8 || sleeve)) c = skin;
    if ((part == 2 || part == 4) && sleeve && t > 0.5) c = skin;
  } else if (col == 1) {
    c = skin; rough = 0.55; sheen = 0.1;
    s.subsurface = 0.3; s.subsurfaceColor = vec3(0.9, 0.35, 0.25);
  } else if (col == 2) {
    c = (flags & 64) != 0 ? skin : cr_hair((pk >> 3) & 7); rough = 0.5; sheen = 0.5;
  } else if (col == 3) {
    int k = (pk >> 6) & 3;
    vec3 pant = k == 0 ? vec3(0.04, 0.06, 0.13) : k == 1 ? vec3(0.62, 0.55, 0.4) : k == 2 ? vec3(0.86, 0.85, 0.8) : vec3(0.16, 0.24, 0.38);
    bool thigh = part == 6 || part == 8;
    if (leg == 2) c = thigh && t < 0.75 ? shirt : skin;        // Kleid/Rock
    else if (leg == 1) c = thigh && t < 0.8 ? pant : skin;      // Shorts
    else c = pant;
  } else if (col == 4) {
    int type = flags & 3;
    c = cr_hat(type, (pk >> 8) & 3);
    if (type >= 2) c *= 0.9 + 0.18 * noise2(i.worldPos.xz * 140.0 + i.worldPos.y * 90.0);   // Strohgeflecht
    if (t > 0.5) c = type == 2 ? shirt * 0.8 : vec3(0.03, 0.03, 0.04);                     // Hutband
    rough = 0.75;
  } else if (col == 5) { c = vec3(0.012); rough = 0.12; s.specular = 1.0; sheen = 0.0; }
  else if (col == 6) { c = skin * vec3(0.78, 0.55, 0.52); rough = 0.4; }
  else if (col == 8) {
    int sk = (style >> 2) & 3;
    c = sk == 0 ? vec3(0.9, 0.9, 0.88) : sk == 1 ? vec3(0.22, 0.12, 0.06) : sk == 2 ? vec3(0.05, 0.06, 0.1) : vec3(0.62, 0.5, 0.36);
    rough = 0.5;
  }
  s.albedo = c;
  s.roughness = rough;
  s.sheen = sheen; s.sheenColor = vec3(0.9);
  float sky = float((pk >> 17) & 15) / 15.0;
  float sh = float((pk >> 21) & 3) / 3.0;
  float occ = part >= 6 ? (part >= 10 ? 0.35 : 0.5) : part >= 2 ? 0.85 : (part == 0 ? mix(0.7, 1.0, smoothstep(0.5, 0.9, i.objPos.y)) : 1.0);
  s.ao = occ * sky;
  s.shadow = sh;
}`;

/** Zuschauer erzeugen. seats: aus buildStadium. */
export function buildCrowd(r, q, seats, opts = {}) {
  const rnd = rng32(opts.seed ?? 777);
  // Auslastung ~50 % (Kunden-Referenz): Gruppen von Freunden/Familien mit freien Plätzen dazwischen,
  // untere Reihen etwas voller als obere. Ehrenloge fast voll.
  const density = q.crowdDensity ?? 1;
  const occupancy = opts.occupancy ?? 0.45 * (0.7 + 0.3 * density);
  const pick = (w) => { let x = rnd() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < w.length; i++) { x -= w[i]; if (x <= 0) return i; } return w.length - 1; };
  const groupSize = () => [1, 2, 3, 4, 5][pick([0.12, 0.4, 0.22, 0.17, 0.09])];
  const list = [];           // { st, grp, gi, gn }
  let prev = null, inGroup = false, remain = 0, grp = -1, gi = 0, gn = 0;
  for (const st of seats) {
    const rows = st.block === 'N' || st.block === 'S' ? 12 : 18;
    const rowF = st.row / (rows - 1);
    const pr = Math.min(0.9, Math.max(0.1, occupancy * (1.3 - 0.6 * rowF)));
    const gapMean = 2.8 * (1 - pr) / pr;
    const gapSize = () => Math.max(1, Math.round(gapMean * (0.35 + 1.3 * rnd())));
    const newRun = !prev || prev.block !== st.block || prev.row !== st.row || Math.hypot(st.x - prev.x, st.z - prev.z) > 0.8;
    if (newRun) { inGroup = rnd() < pr; remain = inGroup ? groupSize() : Math.ceil(gapSize() * rnd()); if (inGroup) { grp++; gi = 0; gn = remain; } }
    if (remain <= 0) {
      inGroup = !inGroup;
      remain = inGroup ? groupSize() : gapSize();
      if (inGroup) { grp++; gi = 0; gn = remain; }
    }
    if (st.royal ? rnd() < 0.85 : inGroup) list.push({ st, grp: st.royal ? -1 : grp, gi: gi, gn });
    if (inGroup) gi++;
    remain--;
    prev = st;
  }
  list.sort((a, b) => a.st.s - b.st.s || a.st.row - b.st.row);
  const N = list.length;
  const src = new Float32Array(N * 24);
  const pos = new Float32Array(N * 3);
  const hasHat = new Uint8Array(N);
  const m = mat4.create();
  // Sommerliche, geschmackvolle Palette: viel Weiß/Creme, Pastell, Navy, wenige kräftige Akzente
  const shirts = [
    ['#f5f4ef', 9], ['#efe9dc', 4], ['#e4e7ea', 2], ['#b9d3ec', 3], ['#cfe0f2', 2], ['#f2cdd0', 2], ['#bfe0d0', 2],
    ['#d6cdea', 1.5], ['#f3e3a6', 1.5], ['#24365c', 3], ['#1b2740', 1.5], ['#6e9ccc', 1.5], ['#e88f7c', 1],
    ['#b8352f', 0.8], ['#1f6a47', 0.8], ['#2d58a6', 0.8], ['#d8c8a2', 1.5], ['#a9adb2', 1], ['#f1b8a0', 1], ['#2a2a2e', 0.5],
  ];
  const shirtCol = shirts.map(([h]) => hex(h)), shirtW = shirts.map(([, w]) => w);
  const formal = ['#1f2533', '#2b2f36', '#3a3d45', '#f1ece0', '#24324d', '#e9e2d0'].map(hex);
  const grpStyle = new Map();
  const hatN = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const { st, grp: g, gi: gIdx, gn: gN } = list[i];
    let gs = grpStyle.get(g);
    if (!gs) { gs = { hatty: rnd(), kid: gN >= 3 && rnd() < 0.35 ? Math.floor(rnd() * gN) : -1, tone: rnd() }; grpStyle.set(g, gs); }
    const child = !st.royal && (gIdx === gs.kid || (gs.kid >= 0 && gIdx === gs.kid + 1 && gN >= 4 && rnd() < 0.5));
    const female = rnd() < 0.5;
    const sc = child ? 0.74 + rnd() * 0.06 : (female ? 0.92 : 0.97) + rnd() * 0.08;
    const jitter = (rnd() - 0.5) * 0.04;
    const x = st.x - st.nx * jitter, z = st.z - st.nz * jitter;
    mat4.fromYawTranslation(m, st.yaw + (rnd() - 0.5) * 0.14, [x, st.y, z], sc);
    let shirt = st.royal ? formal[Math.floor(rnd() * formal.length)] : shirtCol[pick(shirtW)];
    const v = 0.9 + rnd() * 0.14;
    shirt = [shirt[0] * v, shirt[1] * v, shirt[2] * v];
    // Hauttöne gruppenweise leicht korreliert (Familien)
    const skin = rnd() < 0.6 ? Math.floor(gs.tone * 6) : Math.floor(rnd() * 6);
    const old = !child && rnd() < 0.18;
    const hairK = old ? 6 + Math.floor(rnd() * 2) : Math.floor(rnd() * 6);
    const pant = Math.floor(rnd() * 4);
    let flags = 0;
    // Hüte: Gruppen mit "Hut-Neigung", Frauen eher Sonnenhut, Männer Panama/Kappe
    const hp = 0.18 + 0.4 * gs.hatty;
    let hatType = 0;
    if (rnd() < hp) hatType = st.royal ? (female ? 2 : 3) : female ? [2, 2, 2, 1, 3][Math.floor(rnd() * 5)] : child ? 1 : [1, 3, 3, 1, 2][Math.floor(rnd() * 5)];
    flags |= hatType;
    if (rnd() < 0.2) flags |= 4;
    if (female ? rnd() < 0.65 : rnd() < 0.04) flags |= 8;
    if (!st.royal && rnd() < 0.6) flags |= 16;
    if (!st.royal && rnd() < 0.1) flags |= 32;
    if (!female && !child && rnd() < (old ? 0.3 : 0.06) && !(flags & 8)) flags |= 64;
    const hatK = Math.floor(rnd() * 4);
    // Beine: Hose / Shorts / Kleid; Schuhe
    const leg = st.royal ? (female && rnd() < 0.6 ? 2 : 0) : female ? pick([0.35, 0.25, 0.4]) : pick([0.6, 0.4, 0]);
    const shoe = pick([0.45, 0.2, 0.2, 0.15]);
    const crossed = !child && rnd() < 0.18 ? 1 : 0;
    const style = leg | (shoe << 2) | ((female ? 1 : 0) << 4) | (crossed << 5);
    // Licht je Instanz (Kopfhöhe)
    const sky = skyVisAt(x, st.y + 1.0, z, -st.nx * 0.6, 0.8, -st.nz * 0.6);
    const sh = roofShadowAt(x, st.y + 1.0, z);
    const skyQ = Math.round(Math.min(1, Math.max(0, sky)) * 15), shQ = Math.round(sh * 3);
    const packed = skin | (hairK << 3) | (pant << 6) | (hatK << 8) | (flags << 10) | (skyQ << 17) | (shQ << 21);
    const energy = st.royal ? 0.15 + rnd() * 0.2 : child ? 0.9 : rnd();
    const o = i * 24;
    src.set(m, o);
    src[o + 16] = shirt[0]; src[o + 17] = shirt[1]; src[o + 18] = shirt[2]; src[o + 19] = packed;
    src[o + 20] = rnd(); src[o + 21] = st.s; src[o + 22] = energy; src[o + 23] = style;
    pos[i * 3] = x; pos[i * 3 + 1] = st.y + 1; pos[i * 3 + 2] = z;
    hasHat[i] = hatType;
    if (hatType) hatN[hatType - 1]++;
  }
  const instHi = r.createInstances(Math.max(1, N));
  const instLo = r.createInstances(Math.max(1, N));
  const instHats = hatN.map((n) => r.createInstances(Math.max(1, n)));
  const mat = r.createMaterial({
    name: 'env-crowd',
    uniforms: { u_look: [0, 1, 0], u_look2: [0, 1, 0], u_react: [0, 0, 0, 0], u_wave: [0, 0, 0.03, 0], u_motion: 1 },
    vertex: CROWD_VERTEX,
    surface: CROWD_SURFACE,
    castShadow: false,
  });
  const dHi = { mesh: r.createMesh(buildFigureHi()), material: mat, instances: instHi, castShadow: false, receiveShadow: false };
  const dLo = { mesh: r.createMesh(buildFigureLo()), material: mat, instances: instLo, castShadow: false, receiveShadow: false };
  const dHats = instHats.map((inst, k) => ({ mesh: r.createMesh(buildHat(k + 1)), material: mat, instances: inst, castShadow: false, receiveShadow: false }));

  // ---------------------------------------------------------------- LOD-Aufteilung
  const lod = { radius: opts.lodRadius ?? 12 + 20 * density, cam: [1e9, 0, 0], fwd: [0, 0, 0], hi: 0, lo: 0, hats: 0, culled: 0 };
  // Aufteilung nah/fern; Zuschauer deutlich hinter der Kamera werden gar nicht gezeichnet.
  const partition = (cx, cy, cz, fx = 0, fy = 0, fz = 0) => {
    const R2 = lod.radius * lod.radius;
    const useCull = fx * fx + fy * fy + fz * fz > 0.5;
    let nh = 0, nl = 0, nc = 0;
    const nt = [0, 0, 0];
    const H = instHi.data, Lo = instLo.data;
    for (let i = 0; i < N; i++) {
      const dx = pos[i * 3] - cx, dy = pos[i * 3 + 1] - cy, dz = pos[i * 3 + 2] - cz;
      if (useCull && dx * fx + dy * fy + dz * fz < -2.5) { nc++; continue; }
      const row = src.subarray(i * 24, i * 24 + 24);
      if (dx * dx + dy * dy + dz * dz < R2) { H.set(row, nh * 24); nh++; } else { Lo.set(row, nl * 24); nl++; }
      if (hasHat[i]) { const k = hasHat[i] - 1; instHats[k].data.set(row, nt[k] * 24); nt[k]++; }
    }
    instHi.count = nh; instLo.count = nl; instHi.dirty = instLo.dirty = true;
    for (let k = 0; k < 3; k++) { instHats[k].count = nt[k]; instHats[k].dirty = true; }
    lod.hi = nh; lod.lo = nl; lod.hats = nt[0] + nt[1] + nt[2]; lod.culled = nc;
    lod.cam[0] = cx; lod.cam[1] = cy; lod.cam[2] = cz;
    lod.fwd[0] = fx; lod.fwd[1] = fy; lod.fwd[2] = fz;
  };
  partition(0, 8.6, 21.6);

  // ---------------------------------------------------------------- Reaktions-Zustand
  const env = { clap: 0, cheer: 0, stand: 0, ooh: 0 };
  const target = { clap: 0, cheer: 0, stand: 0, ooh: 0 };
  const hold = { clap: 0, cheer: 0, stand: 0, ooh: 0 };
  const wave = { active: 0, amp: 0, center: 0, speed: 0.075, time: 0 };
  const look = [0, 1, 0], look2 = [0, 1, 0];
  let idleClock = 0, lodClock = 0;
  const crowd = {
    drawables: [dHi, dLo, ...dHats], count: N, material: mat, lod,
    /** Reaktion auslösen: 'applause' | 'ooh' | 'cheer' | 'standing' | 'wave' | 'quiet'. */
    react(kind, intensity = 1) {
      const k = Math.max(0, Math.min(1, intensity));
      switch (kind) {
        case 'applause': target.clap = Math.max(target.clap, 0.35 + 0.65 * k); hold.clap = Math.max(hold.clap, 1.8 + 2.2 * k); break;
        case 'cheer':
          target.cheer = Math.max(target.cheer, 0.4 + 0.6 * k); hold.cheer = Math.max(hold.cheer, 1.2 + 1.3 * k);
          target.clap = Math.max(target.clap, 0.8); hold.clap = Math.max(hold.clap, 3.5 + 2 * k);
          target.stand = Math.max(target.stand, 0.25 * k); hold.stand = Math.max(hold.stand, 1.5);
          break;
        case 'standing':
          target.stand = Math.max(target.stand, 0.5 + 0.5 * k); hold.stand = Math.max(hold.stand, 5 + 4 * k);
          target.clap = 1; hold.clap = Math.max(hold.clap, 7 + 4 * k); target.cheer = Math.max(target.cheer, 0.35 * k); hold.cheer = Math.max(hold.cheer, 1.5);
          break;
        case 'ooh': target.ooh = Math.max(target.ooh, 0.4 + 0.6 * k); hold.ooh = Math.max(hold.ooh, 0.9 + 0.6 * k); break;
        case 'wave': wave.active = 1; wave.time = 9 + 6 * k; wave.center = Math.random(); break;
        case 'quiet': for (const key in target) { target[key] = 0; hold[key] = 0; } wave.time = 0; break;
        default: break;
      }
    },
    /** Kamera für LOD-Aufteilung und Rückseiten-Culling: Position + Ziel (optional). */
    setCamera(p, target) {
      let fx = 0, fy = 0, fz = 0;
      if (target) {
        fx = target[0] - p[0]; fy = target[1] - p[1]; fz = target[2] - p[2];
        const l = Math.hypot(fx, fy, fz) || 1; fx /= l; fy /= l; fz /= l;
      }
      const dx = p[0] - lod.cam[0], dy = p[1] - lod.cam[1], dz = p[2] - lod.cam[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      const dot = fx * lod.fwd[0] + fy * lod.fwd[1] + fz * lod.fwd[2];
      const cut = d2 > 25 || dot < 0.85;          // Schnitt: sofort neu aufteilen
      if (cut || ((d2 > 2.25 || dot < 0.985) && lodClock <= 0)) { partition(p[0], p[1], p[2], fx, fy, fz); lodClock = 0.2; }
    },
    update(dt, ballPos, excitement = 0) {
      lodClock -= dt;
      if (ballPos) {
        const bx = Math.max(-14, Math.min(14, ballPos[0])), bz = Math.max(-22, Math.min(22, ballPos[2])), by = Math.max(0, Math.min(6, ballPos[1]));
        look[0] = damp(look[0], bx, 6, dt); look[1] = damp(look[1], by, 6, dt); look[2] = damp(look[2], bz, 6, dt);
        look2[0] = damp(look2[0], bx, 2.2, dt); look2[1] = damp(look2[1], by, 2.2, dt); look2[2] = damp(look2[2], bz, 2.2, dt);
      }
      for (const k in env) {
        if (hold[k] > 0) hold[k] -= dt; else target[k] = 0;
        env[k] = damp(env[k], target[k], target[k] > env[k] ? 5 : 1.6, dt);
      }
      idleClock -= dt;
      if (idleClock <= 0) { idleClock = 4 + Math.random() * 6; if (excitement > 0.7 && Math.random() < 0.15) crowd.react('applause', 0.3); }
      if (wave.active) {
        wave.time -= dt;
        wave.center = (wave.center + wave.speed * dt) % 1;
        wave.amp = damp(wave.amp, wave.time > 0 ? 1 : 0, 2.5, dt);
        if (wave.time <= 0 && wave.amp < 0.01) { wave.active = 0; wave.amp = 0; }
      }
      const U = mat.uniforms;
      U.u_look[0] = look[0]; U.u_look[1] = look[1]; U.u_look[2] = look[2];
      U.u_look2[0] = look2[0]; U.u_look2[1] = look2[1]; U.u_look2[2] = look2[2];
      U.u_react[0] = env.clap; U.u_react[1] = env.cheer; U.u_react[2] = env.stand; U.u_react[3] = env.ooh;
      U.u_wave[0] = wave.amp; U.u_wave[1] = wave.center;
    },
    get state() { return { ...env, wave: wave.amp }; },
  };
  return crowd;
}

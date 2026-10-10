// Tennisschläger, prozedural (ARCHITECTURE §5.4).
//   buildRacket(renderer, style) -> { parts: [{ mesh, material, name }], sweetSpot: [0, y, 0], length, headCenter, ... }
// Lokaler Rahmen: Ursprung = Griffpunkt (Mitte der Faust), +Y entlang des Schafts zum Kopf, Saitenebene = lokale
// XY-Ebene (Flächennormale ±Z).
// Aufbau: ein durchgehender Rahmen-Strang (Schaft links -> Herzarm -> Kopfoval -> Herzarm -> Schaft rechts) mit
// abgeschrägtem Profil und Ösenrinne außen, Herzbrücke, achteckiger Griff mit Griffband-Spirale und Endkappe,
// Saiten als alpha-getestetes prozedurales Gitter (Mains/Crosses mit Rundung, Fernbereich = Abdeckungsgrad), Dämpfer.
// style: { frame:[r,g,b], accent:[r,g,b], grip:[r,g,b], strings?:[r,g,b], name? } (lineare Farben)

import { hexToLinear, smoothstep } from '../core/math.js';
import { roundedBox, transform, merge } from '../gfx/geometry.js';
import { mat4 } from '../core/math.js';

export const RACKET_STYLES = Object.freeze({
  tom: { frame: hexToLinear('#1d2b4f'), accent: hexToLinear('#8ccbf2'), grip: hexToLinear('#f4f4f2'), strings: hexToLinear('#eef3f6'), name: 'tom' },
  gerry: { frame: hexToLinear('#141414'), accent: hexToLinear('#ff7a1a'), grip: hexToLinear('#efe6cf'), strings: hexToLinear('#f2f0ea'), name: 'gerry' },
});

// Maße (m)
const DIM = {
  butt: -0.054, handleTop: 0.128, shaftTop: 0.2,
  headA: 0.128, headB: 0.152, headCY: 0.483,      // Außen-Halbachsen des Kopfovals (Rahmenmitte), Zentrum
  beamW: 0.0118, beamD: 0.0225,                    // Rahmenprofil: Breite (in Ebene) x Tiefe (Z)
  shaftW: 0.0105, shaftD: 0.021,
  junction: -50,                                   // Winkel (Grad) am Oval, wo die Herzarme einlaufen
  handleW: 0.0305, handleD: 0.0265,
  mains: 16, crosses: 19, stringW: 0.00125,
};

// ------------------------------------------------------------------ Helfer
const lin3 = (c) => [c[0], c[1], c[2]];
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

class MeshBuilder {
  constructor() { this.pos = []; this.nor = []; this.col = []; this.dat = []; this.uv = []; this.idx = []; }
  get n() { return this.pos.length / 3; }
  v(p, n, c, mat = 0, uv = null) {
    this.pos.push(p[0], p[1], p[2]); this.nor.push(n[0], n[1], n[2]); this.col.push(c[0], c[1], c[2], 1);
    this.dat.push(mat, 1, 0, 0); this.uv.push(uv ? uv[0] : 0, uv ? uv[1] : 0);
    return this.n - 1;
  }
  /** Dreieck; Wicklung wird an der mittleren Vertexnormale ausgerichtet. */
  tri(a, b, c) {
    const P = this.pos, N = this.nor;
    const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
    const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    const nx = N[3 * a] + N[3 * b] + N[3 * c], ny = N[3 * a + 1] + N[3 * b + 1] + N[3 * c + 1], nz = N[3 * a + 2] + N[3 * b + 2] + N[3 * c + 2];
    if (gx * nx + gy * ny + gz * nz >= 0) this.idx.push(a, b, c); else this.idx.push(a, c, b);
  }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
  build() {
    const n = this.n;
    return {
      positions: new Float32Array(this.pos), normals: new Float32Array(this.nor), colors: new Float32Array(this.col),
      data: new Float32Array(this.dat), uvs: new Float32Array(this.uv),
      indices: n > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx),
    };
  }
}

/** Geschlossenes 2D-Profil (CCW, u = nach außen, v = Z) eines abgerundeten Rechtecks mit optionaler Außenrinne. */
function profile(hw, hd, rc, groove = 0, grooveW = 0.0042, segs = 4) {
  const pts = [];
  const arc = (cu, cv, a0) => { for (let i = 0; i <= segs; i++) { const a = a0 + (i / segs) * Math.PI / 2; pts.push([cu + rc * Math.cos(a), cv + rc * Math.sin(a)]); } };
  // Außenseite (u = +hw) von unten nach oben, mit Rinne
  const nG = 7;
  for (let i = 0; i <= nG; i++) {
    const v = -(hd - rc) + (2 * (hd - rc) * i) / nG;
    const g = groove * (1 - smoothstep(grooveW * 0.55, grooveW, Math.abs(v)));
    pts.push([hw - g, v]);
  }
  arc(hw - rc, hd - rc, 0);
  arc(-hw + rc, hd - rc, Math.PI / 2);
  arc(-hw + rc, -hd + rc, Math.PI);
  arc(hw - rc, -hd + rc, 1.5 * Math.PI);
  // Normalen aus Nachbarpunkten
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i - 1 + pts.length) % pts.length], b = pts[(i + 1) % pts.length];
    const du = b[0] - a[0], dv = b[1] - a[1], l = Math.hypot(du, dv) || 1;
    out.push({ u: pts[i][0], v: pts[i][1], nu: dv / l, nv: -du / l });
  }
  return out;
}

/** Bezier (kubisch) 2D. */
function bez(p0, p1, p2, p3, t) {
  const s = 1 - t;
  return [s * s * s * p0[0] + 3 * s * s * t * p1[0] + 3 * s * t * t * p2[0] + t * t * t * p3[0],
    s * s * s * p0[1] + 3 * s * s * t * p1[1] + 3 * s * t * t * p2[1] + t * t * t * p3[1]];
}

// ------------------------------------------------------------------ Geometrie
function frameGeometry(mb, style) {
  const { headA: a, headB: b, headCY: cy } = DIM;
  const frame = lin3(style.frame), accent = lin3(style.accent);
  const dark = mixc(frame, [0.01, 0.01, 0.01], 0.6);
  const ell = (th) => [a * Math.cos(th), cy + b * Math.sin(th)];
  const ellT = (th) => { const t = [-a * Math.sin(th), b * Math.cos(th)]; const l = Math.hypot(t[0], t[1]); return [t[0] / l, t[1] / l]; };
  const thJ = DIM.junction * Math.PI / 180;
  // Pfad: Schaft rechts (+X) hoch -> Herzarm -> Oval CCW -> Herzarm -> Schaft links runter
  const path = []; // { p, kind: 0 Schaft, 1 Arm, 2 Kopf, w }
  const x0 = DIM.shaftW * 0.5 - 0.0004;
  const S0 = [x0, DIM.handleTop - 0.01], S1 = [x0, DIM.shaftTop];
  for (let i = 0; i <= 6; i++) path.push({ p: [x0, S0[1] + (S1[1] - S0[1]) * i / 6], kind: 0 });
  const J = ell(thJ), TJ = ellT(thJ);
  const armPts = (sx) => {
    const s1 = [sx * x0, DIM.shaftTop], j = [sx * J[0], J[1]], tj = [sx * TJ[0], TJ[1]];
    return [s1, [s1[0], s1[1] + 0.07], [j[0] - tj[0] * 0.06, j[1] - tj[1] * 0.06], j];
  };
  const ar = armPts(1);
  for (let i = 1; i < 24; i++) path.push({ p: bez(ar[0], ar[1], ar[2], ar[3], i / 24), kind: 1, t: i / 24 });
  const nH = 150, th0 = thJ, th1 = Math.PI - thJ;
  for (let i = 0; i <= nH; i++) { const th = th0 + (th1 - th0) * i / nH; path.push({ p: ell(th), kind: 2, th }); }
  const al = armPts(-1);
  for (let i = 23; i >= 1; i--) path.push({ p: bez(al[0], al[1], al[2], al[3], i / 24), kind: 1, t: i / 24 });
  for (let i = 6; i >= 0; i--) path.push({ p: [-x0, S0[1] + (S1[1] - S0[1]) * i / 6], kind: 0 });
  // Tangenten
  for (let i = 0; i < path.length; i++) {
    const p0 = path[Math.max(0, i - 1)].p, p1 = path[Math.min(path.length - 1, i + 1)].p;
    const tx = p1[0] - p0[0], ty = p1[1] - p0[1], l = Math.hypot(tx, ty) || 1;
    path[i].t2 = [tx / l, ty / l];
  }
  const profHead = profile(DIM.beamW / 2, DIM.beamD / 2, 0.0034, 0.0022);
  const profShaft = profile(DIM.shaftW / 2, DIM.shaftD / 2, 0.0034, 0);
  const sweep = (pts, profFn, colorFn) => {
    let prev = null;
    for (const s of pts) {
      const prof = profFn(s);
      const N = [s.t2[1], -s.t2[0]]; // rechts der Tangente = außen
      const ring = [];
      for (const q of prof) {
        const p = [s.p[0] + N[0] * q.u, s.p[1] + N[1] * q.u, q.v];
        const n = [N[0] * q.nu, N[1] * q.nu, q.nv];
        const c = colorFn(s, q);
        ring.push(mb.v(p, n, c.c, c.m, [s.p[0], s.p[1]]));
      }
      if (prev) for (let k = 0; k < ring.length; k++) { const k1 = (k + 1) % ring.length; mb.quad(prev[k], ring[k], ring[k1], prev[k1]); }
      prev = ring;
    }
  };
  // Profil: Schaft -> Kopf überblenden
  const lerpProf = (t) => profHead.map((q, i) => {
    const r = profShaft[i];
    return { u: r.u + (q.u - r.u) * t, v: r.v + (q.v - r.v) * t, nu: r.nu + (q.nu - r.nu) * t, nv: r.nv + (q.nv - r.nv) * t };
  });
  const colorFn = (s, q) => {
    // Rinne (Ösenband) dunkel, Innenkante Akzent, Akzentfelder auf den Herzarmen und bei 3/9 Uhr
    if (s.kind === 2 && q.u > DIM.beamW / 2 - 0.0016 && Math.abs(q.v) < 0.0036) return { c: dark, m: 0 };
    if (q.u < -DIM.beamW / 2 + 0.0008 && Math.abs(q.v) < 0.0014 && s.kind === 2) return { c: accent, m: 0 };
    if (s.kind === 1 && Math.abs(q.v) > DIM.shaftD / 2 - 0.003 && s.t > 0.25 && s.t < 0.8) return { c: accent, m: 0 };
    if (s.kind === 2) {
      const deg = s.th * 180 / Math.PI;
      const band = (c, w) => Math.abs(deg - c) < w;
      if ((band(0, 7) || band(180, 7)) && Math.abs(q.v) > 0.004 && q.u > -0.002) return { c: accent, m: 0 };
      if (band(90, 3.2) && q.u > 0.002) return { c: accent, m: 0 };
    }
    return { c: frame, m: 0 };
  };
  sweep(path, (s) => (s.kind === 0 ? profShaft : s.kind === 2 ? profHead : lerpProf(smoothstep(0.0, 0.85, s.t))), colorFn);
  // Herzbrücke (unterer Ovalbogen zwischen den Armen, leicht in die Arme hinein)
  const bridge = [];
  const thA = -Math.PI - thJ - 0.1, thB = thJ + 0.1; // von links (−X) nach rechts (+X) über unten
  for (let i = 0; i <= 40; i++) {
    const th = thA + (thB - thA) * i / 40;
    bridge.push({ p: [a * 0.995 * Math.cos(th), cy + b * 0.995 * Math.sin(th)], kind: 3, th });
  }
  for (let i = 0; i < bridge.length; i++) {
    const p0 = bridge[Math.max(0, i - 1)].p, p1 = bridge[Math.min(bridge.length - 1, i + 1)].p;
    const tx = p1[0] - p0[0], ty = p1[1] - p0[1], l = Math.hypot(tx, ty) || 1;
    bridge[i].t2 = [tx / l, ty / l];
  }
  const profBridge = profile(DIM.beamW * 0.46, DIM.beamD * 0.46, 0.0032, 0.0016);
  sweep(bridge, () => profBridge, (s, q) => (q.u > DIM.beamW * 0.46 - 0.0014 && Math.abs(q.v) < 0.003 ? { c: dark, m: 0 } : { c: frame, m: 0 }));
}

function handleGeometry(mb, style) {
  const grip = lin3(style.grip), frame = lin3(style.frame), accent = lin3(style.accent);
  const hw = DIM.handleW / 2, hd = DIM.handleD / 2, bev = 0.0062;
  // Achteck (X = Breite in Rahmenebene, Z = Tiefe)
  const oct = [[hw, hd - bev], [hw - bev, hd], [-hw + bev, hd], [-hw, hd - bev], [-hw, -hd + bev], [-hw + bev, -hd], [hw - bev, -hd], [hw, -hd + bev]];
  const sub = 3, ring = [];
  for (let i = 0; i < oct.length; i++) {
    const a = oct[i], b = oct[(i + 1) % oct.length];
    for (let k = 0; k < sub; k++) { const t = k / sub; ring.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  const nr = ring.length;
  const normal2 = (i) => {
    const p0 = ring[(i - 1 + nr) % nr], p1 = ring[(i + 1) % nr];
    const dx = p1[0] - p0[0], dz = p1[1] - p0[1], l = Math.hypot(dx, dz) || 1;
    return [dz / l, -dx / l];
  };
  // Griffband: Spirale (Überlappungs-Wulst)
  const y0 = DIM.butt + 0.008, y1 = DIM.handleTop - 0.012, rows = 96, pitch = 0.0235;
  let prev = null;
  for (let r = 0; r <= rows; r++) {
    const y = y0 + (y1 - y0) * r / rows;
    const cur = [];
    for (let i = 0; i < nr; i++) {
      const [x, z] = ring[i];
      const ang = Math.atan2(z, x) / (2 * Math.PI);
      const ph = (y / pitch + ang) % 1;
      const f = ph < 0 ? ph + 1 : ph;
      const ridge = smoothstep(0.0, 0.12, f) * (1 - smoothstep(0.12, 0.3, f));
      const lift = 0.0013 + 0.0006 * ridge;
      const n2 = normal2(i);
      const p = [x + n2[0] * lift, y, z + n2[1] * lift];
      const c = mixc(grip, grip.map((v) => v * 0.88), ridge * 0.6);
      cur.push(mb.v(p, [n2[0], (ridge - 0.5) * 0.0, n2[1]], c, 1, [ang, y]));
    }
    if (prev) for (let i = 0; i < nr; i++) { const i1 = (i + 1) % nr; mb.quad(prev[i], cur[i], cur[i1], prev[i1]); }
    prev = cur;
  }
  // Abschlussband oben (Akzent) + Konus in den Schaft
  const cone = (yA, yB, sA, sB, col, mat) => {
    const a = [], b = [];
    for (let i = 0; i < nr; i++) {
      const [x, z] = ring[i], n2 = normal2(i);
      a.push(mb.v([x * sA + n2[0] * 0.0013, yA, z * sA + n2[1] * 0.0013], [n2[0], 0.25 * (sA - sB) * 10, n2[1]], col, mat));
      b.push(mb.v([x * sB + n2[0] * 0.0013, yB, z * sB + n2[1] * 0.0013], [n2[0], 0.25 * (sA - sB) * 10, n2[1]], col, mat));
    }
    for (let i = 0; i < nr; i++) { const i1 = (i + 1) % nr; mb.quad(a[i], b[i], b[i1], a[i1]); }
  };
  cone(y1 - 0.001, y1 + 0.011, 1.0, 1.0, accent, 0);
  cone(y1 + 0.011, DIM.handleTop + 0.02, 1.0, 0.62, frame, 0);
  // Endkappe (leicht ausgestellt) + Boden
  cone(DIM.butt, y0 + 0.001, 1.09, 1.0, frame, 3);
  const center = mb.v([0, DIM.butt - 0.0004, 0], [0, -1, 0], accent, 3);
  const bot = [];
  for (let i = 0; i < nr; i++) { const [x, z] = ring[i]; bot.push(mb.v([x * 1.09, DIM.butt, z * 1.09], [0, -1, 0], frame, 3)); }
  for (let i = 0; i < nr; i++) mb.tri(center, bot[(i + 1) % nr], bot[i]);
}

function dampenerGeometry(style) {
  const g = roundedBox(0.024, 0.014, 0.0105, 0.004, 2);
  const yb = DIM.headCY - (DIM.headB - DIM.beamW * 0.5) + 0.03;
  const m = transform(g, mat4.fromTranslation(mat4.create(), [0, yb, 0]));
  const n = m.positions.length / 3;
  const c = lin3(style.accent);
  m.colors = new Float32Array(4 * n); m.data = new Float32Array(4 * n);
  for (let i = 0; i < n; i++) { m.colors.set([c[0], c[1], c[2], 1], 4 * i); m.data.set([2, 1, 0, 0], 4 * i); }
  m.uvs = new Float32Array(2 * n);
  return m;
}

/** Saitenfläche: elliptische Scheibe innerhalb des Rahmens, uv = lokale XY-Position. */
function stringsGeometry() {
  const ai = DIM.headA - DIM.beamW * 0.5 + 0.0012, bi = DIM.headB - DIM.beamW * 0.5 + 0.0012, cy = DIM.headCY;
  const seg = 72, rings = 6;
  const pos = [], nor = [], uv = [], idx = [];
  pos.push(0, cy, 0); nor.push(0, 0, 1); uv.push(0, 0);
  for (let r = 1; r <= rings; r++) {
    const f = r / rings;
    for (let i = 0; i < seg; i++) {
      const th = (i / seg) * Math.PI * 2;
      const x = ai * f * Math.cos(th), y = bi * f * Math.sin(th);
      pos.push(x, cy + y, 0); nor.push(0, 0, 1); uv.push(x, y);
    }
  }
  for (let i = 0; i < seg; i++) idx.push(0, 1 + i, 1 + ((i + 1) % seg));
  for (let r = 1; r < rings; r++) {
    const o0 = 1 + (r - 1) * seg, o1 = 1 + r * seg;
    for (let i = 0; i < seg; i++) { const i1 = (i + 1) % seg; idx.push(o0 + i, o1 + i, o1 + i1, o0 + i, o1 + i1, o0 + i1); }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), uvs: new Float32Array(uv), indices: new Uint16Array(idx), ai, bi };
}

// ------------------------------------------------------------------ Shader
const FRAME_SURFACE = /* glsl */`
void surface(in SurfaceInput i, inout Surface s) {
  int m = int(i.data.x + 0.5);
  vec3 col = i.color.rgb;
  float fw = length(fwidth(i.objPos));
  if (m == 0 || m == 3) {
    // Lack über Carbon: feines Köpergewebe nur in Nahsicht
    vec2 p = (abs(i.objNormal.z) > 0.6 ? i.objPos.xy : vec2(i.objPos.z, i.objPos.y + i.objPos.x)) * 900.0;
    float weave = step(0.5, fract(p.x + floor(p.y) * 0.5)) * 0.5 + 0.5 * sin(p.y * 3.14159);
    float wf = (1.0 - smoothstep(0.0003, 0.0009, fw)) * (1.0 - smoothstep(0.15, 0.35, dot(col, vec3(0.33))));
    col *= 1.0 + (weave - 0.5) * 0.25 * wf;
    s.albedo = col;
    s.roughness = 0.22; s.specular = 0.7;
  } else if (m == 1) {
    // Griffband: Perforation + weich
    vec2 g = vec2(i.uv.x * 40.0, i.uv.y * 520.0);
    float perf = 1.0 - smoothstep(0.12, 0.22, length(fract(g) - 0.5));
    float pf = 1.0 - smoothstep(0.0004, 0.001, fw);
    s.albedo = col * (1.0 - 0.2 * perf * pf);
    s.roughness = 0.72; s.specular = 0.35;
    s.sheen = 0.2;
  } else {
    s.albedo = col; s.roughness = 0.55; s.specular = 0.4; // Dämpfer (Gummi)
  }
}`;

const STRING_SURFACE = /* glsl */`
void surface(in SurfaceInput i, inout Surface s) {
  vec2 p = i.uv;                                   // lokale Saitenebene (m), Zentrum = Kopfmitte
  vec2 sp = u_spacing;                             // Abstand Mains (x) / Crosses (y)
  vec2 q = p / sp + vec2(0.5 * mod(u_counts.x, 2.0), 0.5 * mod(u_counts.y, 2.0));
  vec2 f = abs(fract(q) - 0.5) * sp;               // Abstand zur nächsten Saite (m)
  float w = u_width * 0.5;
  vec2 fwp = fwidth(p) + 1e-7;
  float mainA = 1.0 - smoothstep(w - fwp.x, w + fwp.x, f.x);
  float crossA = 1.0 - smoothstep(w - fwp.y, w + fwp.y, f.y);
  float a = max(mainA, crossA);
  // Fernbereich: Gitter nicht mehr auflösbar -> mittlere Abdeckung
  float far = smoothstep(0.18, 0.5, max(fwp.x / sp.x, fwp.y / sp.y));
  float cover = 1.0 - (1.0 - u_width / sp.x) * (1.0 - u_width / sp.y);
  s.alpha = mix(a, cover * 1.6, far);
  // runde Saiten (Höhenprofil -> Bump), Kreuzungen leicht abgedunkelt
  float dm = clamp((fract(q.x) - 0.5) * sp.x / w, -1.0, 1.0), dc = clamp((fract(q.y) - 0.5) * sp.y / w, -1.0, 1.0);
  float h = max(sqrt(max(1.0 - dm * dm, 0.0)) * mainA, sqrt(max(1.0 - dc * dc, 0.0)) * crossA) * w;
  s.normal = bumpNormal(s.normal, i.worldPos, h, 1.0 - far);
  s.albedo = u_stringColor * (1.0 - 0.25 * mainA * crossA);
  s.roughness = 0.35; s.specular = 0.5;
}`;

// ------------------------------------------------------------------ Aufbau
/** CPU-Geometrie (auch in node nutzbar). */
export function buildRacketGeometry(style = RACKET_STYLES.tom) {
  const st = { ...RACKET_STYLES.tom, ...(style || {}) };
  const mb = new MeshBuilder();
  frameGeometry(mb, st);
  handleGeometry(mb, st);
  const body = merge([mb.build(), dampenerGeometry(st)]);
  const strings = stringsGeometry();
  return { body, strings, style: st };
}

/**
 * Schläger bauen.
 * @param {Renderer} renderer
 * @param {object} style { frame, accent, grip, strings? } lineare RGB (z.B. asset.racketStyle) oder RACKET_STYLES.*
 */
export function buildRacket(renderer, style = RACKET_STYLES.tom) {
  const G = buildRacketGeometry(style);
  const st = G.style;
  const sx = (2 * G.strings.ai) / DIM.mains, sy = (2 * G.strings.bi) / DIM.crosses;
  const frameMat = renderer.createMaterial({ name: 'racket-frame', surface: FRAME_SURFACE });
  const stringMat = renderer.createMaterial({
    name: 'racket-strings',
    uniforms: { u_spacing: [sx, sy], u_counts: [DIM.mains, DIM.crosses], u_width: DIM.stringW, u_stringColor: lin3(st.strings || [0.9, 0.9, 0.9]) },
    surface: STRING_SURFACE,
    alphaTest: 0.5,
    cull: 'none',
  });
  const length = DIM.headCY + DIM.headB + DIM.beamW * 0.5 - DIM.butt;
  return {
    parts: [
      { name: 'frame', mesh: renderer.createMesh(G.body), material: frameMat },
      { name: 'strings', mesh: renderer.createMesh(G.strings), material: stringMat },
    ],
    sweetSpot: [0, DIM.headCY - 0.012, 0],
    headCenter: [0, DIM.headCY, 0],
    headSize: [2 * (DIM.headA + DIM.beamW * 0.5), 2 * (DIM.headB + DIM.beamW * 0.5)],
    length,
    buttY: DIM.butt,
    tipY: DIM.headCY + DIM.headB + DIM.beamW * 0.5,
  };
}

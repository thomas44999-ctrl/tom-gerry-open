// GLSL-Bausteine der Umgebung: analytischer Dachschatten, Himmelssichtbarkeit im Stadionkessel,
// Hilfsfunktionen für Materialien der World-Module. Wird per String-Verkettung in Surface-Shader eingefügt.
import { LAYOUT, SUN_DIR, sdRoundRect } from './layout.js';

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(+x.toFixed(5)));
const R = LAYOUT.roof;

export const GLSL_ENV = `
float env_sdRR(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
// Dachring (Innenkante/Außenkante) als Schattenwerfer: Strahl zur Sonne schneidet Dachebene.
float env_roofShadow(vec3 p) {
  const float H = ${f((R.yIn + R.yOut) * 0.5)};
  if (p.y >= H || u_sunDir.y < 0.02) return 1.0;
  // Platz + Mauern: nur Schattenkarten-Schatten (Platz bleibt sonnig, konsistent mit Spielern)
  if (env_sdRR(p.xz, vec2(${f(LAYOUT.wallX)}, ${f(LAYOUT.wallZ)}), ${f(LAYOUT.cornerR)}) < 0.32) return 1.0;
  float t = (H - p.y) / u_sunDir.y;
  vec2 h = p.xz + u_sunDir.xz * t;
  float dIn = env_sdRR(h, vec2(${f(R.innerX)}, ${f(R.innerZ)}), ${f(R.innerR)});
  float dOut = env_sdRR(h, vec2(${f(R.outerX + 1.5)}, ${f(R.outerZ + 1.5)}), ${f(R.outerR)});
  float pen = 0.25 + 0.012 * t;
  float blocked = smoothstep(-pen, pen, dIn) * smoothstep(pen, -pen, dOut);
  return 1.0 - blocked;
}
// Grobe Himmelssichtbarkeit (kosinusgewichtet) im Kessel: Horizont durch Tribünenrand, Dach darüber.
float env_skyVis(vec3 p, vec3 n) {
  const float RIM = ${f(R.yIn)};
  if (env_sdRR(p.xz, vec2(${f(R.outerX)}, ${f(R.outerZ)}), ${f(R.outerR)}) > -0.5) return 1.0;
  float dIn = env_sdRR(p.xz, vec2(${f(R.innerX)}, ${f(R.innerZ)}), ${f(R.innerR)});
  // Abstand zum gegenüberliegenden Rand in 4 Richtungen
  vec2 ext = vec2(${f(R.innerX)}, ${f(R.innerZ)});
  vec4 dist = max(vec4(ext.x - p.x, ext.x + p.x, ext.y - p.z, ext.y + p.z), vec4(1.0));
  vec4 hgt = vec4(max(RIM - p.y, 0.0));
  vec4 sinE = hgt / sqrt(hgt * hgt + dist * dist);
  // Normalen-Gewichtung: Richtung, in die die Fläche schaut, zählt mehr
  vec4 w = vec4(max(n.x, 0.0), max(-n.x, 0.0), max(n.z, 0.0), max(-n.z, 0.0)) + 0.35;
  float occl = dot(sinE * sinE, w) / dot(w, vec4(1.0));
  float v = 1.0 - occl * (0.55 + 0.45 * max(n.y, 0.0));
  // unter dem Dach: Zenit verdeckt
  float under = smoothstep(-1.0, 3.0, dIn) * step(p.y, RIM);
  v *= mix(1.0, 0.42 + 0.25 * max(-n.y, 0.0), under);
  return clamp(v, 0.15, 1.0);
}
`;

/** Linear-RGB aus sRGB-Hex. */
export function hex(h) {
  const n = parseInt(h.replace('#', ''), 16);
  const c = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return [c((n >> 16) & 255), c((n >> 8) & 255), c(n & 255)];
}

/** Palette (linear). */
export const PAL = {
  bottle: hex('#123d2b'), bottleDeep: hex('#0b2a1d'), bottleLight: hex('#1d5a3e'),
  cream: hex('#efe8d6'), creamDark: hex('#d9cfb6'), white: hex('#f6f4ee'),
  gold: hex('#c9a04a'), goldDeep: hex('#9c7a2e'),
  purple: hex('#4b2a5e'),
  concrete: hex('#b9b3a6'), concreteDark: hex('#8c877c'),
  seat: hex('#1f4d36'), seatDark: hex('#173a29'),
  roof: hex('#e7e6e1'), steel: hex('#cfd2d1'),
  glass: hex('#2a3c44'),
  optic: hex('#d6ea3c'),
};

// ---------------------------------------------------------------- JS-Gegenstücke (zum Vorberechnen je Instanz)
const _ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Analytischer Dachschatten (1 = Sonne, 0 = Schatten) wie env_roofShadow. */
export function roofShadowAt(x, y, z, sun = SUN_DIR) {
  const H = (R.yIn + R.yOut) * 0.5;
  if (y >= H || sun[1] < 0.02) return 1;
  if (sdRoundRect(x, z, LAYOUT.wallX, LAYOUT.wallZ, LAYOUT.cornerR) < 0.32) return 1;
  const t = (H - y) / sun[1];
  const hx = x + sun[0] * t, hz = z + sun[2] * t;
  const dIn = sdRoundRect(hx, hz, R.innerX, R.innerZ, R.innerR);
  const dOut = sdRoundRect(hx, hz, R.outerX + 1.5, R.outerZ + 1.5, R.outerR);
  const pen = 0.25 + 0.012 * t;
  return 1 - _ss(-pen, pen, dIn) * _ss(pen, -pen, dOut);
}

/** Himmelssichtbarkeit wie env_skyVis. */
export function skyVisAt(x, y, z, nx, ny, nz) {
  const RIM = R.yIn;
  if (sdRoundRect(x, z, R.outerX, R.outerZ, R.outerR) > -0.5) return 1;
  const dIn = sdRoundRect(x, z, R.innerX, R.innerZ, R.innerR);
  const ext = [R.innerX, R.innerZ];
  const dist = [ext[0] - x, ext[0] + x, ext[1] - z, ext[1] + z].map((v) => Math.max(v, 1));
  const h = Math.max(RIM - y, 0);
  const w = [Math.max(nx, 0) + 0.35, Math.max(-nx, 0) + 0.35, Math.max(nz, 0) + 0.35, Math.max(-nz, 0) + 0.35];
  let occl = 0, ws = 0;
  for (let k = 0; k < 4; k++) { const s = h / Math.sqrt(h * h + dist[k] * dist[k]); occl += s * s * w[k]; ws += w[k]; }
  occl /= ws;
  let v = 1 - occl * (0.55 + 0.45 * Math.max(ny, 0));
  const under = _ss(-1, 3, dIn) * (y <= RIM ? 1 : 0);
  v *= 1 + (0.42 + 0.25 * Math.max(-ny, 0) - 1) * under;
  return Math.min(1, Math.max(0.15, v));
}

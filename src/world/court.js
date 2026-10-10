// Rasenplatz: sauberer, gestreifter Rasen (blickabhängige Mähstreifen), Laubschatten-Tupfen an der Westseite,
// analytisch antialiaste Kreidelinien (Einzel + Doppel), Kontakt-AO an den Mauern.
// Großräumige Felder (Abnutzung, Büschel, Himmelssicht/AO) werden einmalig in eine Textur gebacken.
import { plane } from '../gfx/geometry.js';
import { mat4, fbm3, noise3 } from '../core/math.js';
import { LAYOUT, sdRoundRect } from './layout.js';
import { hex, skyVisAt } from './envlib.js';

const TEX_W = 256, TEX_H = 512;
const EXT_X = LAYOUT.wallX + 0.4, EXT_Z = LAYOUT.wallZ + 0.4;

const COURT_GLSL = `
float crt_rect(vec2 p, vec2 lo, vec2 hi) {
  vec2 c = (lo + hi) * 0.5, h = (hi - lo) * 0.5;
  vec2 q = abs(p - c) - h;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}
// Abstand zur nächsten Linie (p = |xz|). Linien liegen innerhalb der Feldgrenzen ("Linie ist drin").
float crt_lines(vec2 p) {
  float d = crt_rect(p, vec2(0.0, 11.785), vec2(5.485, 11.885));
  d = min(d, crt_rect(p, vec2(5.435, 0.0), vec2(5.485, 11.885)));
  d = min(d, crt_rect(p, vec2(4.065, 0.0), vec2(4.115, 11.885)));
  d = min(d, crt_rect(p, vec2(0.0, 6.35), vec2(4.115, 6.40)));
  d = min(d, crt_rect(p, vec2(0.0, 0.0), vec2(0.025, 6.40)));
  d = min(d, crt_rect(p, vec2(0.0, 11.685), vec2(0.025, 11.885)));
  return d;
}
`;

const GRASS_SURFACE = `
void surface(in SurfaceInput i, inout Surface s) {
  vec3 P = i.worldPos;
  vec2 w = P.xz;
  float dist = length(P - u_cameraPos);
  vec2 fw = fwidth(w);
  float pix = max(fw.x, fw.y);                    // Weltmeter pro Pixel
  // --- gebackene Felder: r Büschel/Großrauschen, g Trockenheit, b Erde (Potenzial), a Himmelssicht*Kontakt-AO
  vec4 cf = texture(u_field, w * vec2(${(0.5 / EXT_X).toFixed(6)}, ${(0.5 / EXT_Z).toFixed(6)}) + 0.5);
  float nL = cf.r;
  float fineFade = 1.0 - smoothstep(0.004, 0.02, pix);
  float nF = mix(0.5, noise2(w * 14.0), fineFade);
  float nFF = mix(0.5, noise2(w * 47.0 + 3.0), 1.0 - smoothstep(0.0015, 0.006, pix));
  // --- Mähstreifen (Bänder parallel zum Netz), blickabhängig
  float sw = u_stripeW;
  float sz = w.y / sw + 0.5;
  float band = mod(floor(sz), 2.0) * 2.0 - 1.0;
  float edge = abs(fract(sz) - 0.5) * 2.0;
  band *= smoothstep(1.0, 1.0 - max(0.04, pix * 2.0 / sw), edge);
  vec2 vh = (u_cameraPos.xz - w) / max(dist, 1.0);
  float stripe = -band * vh.y * 1.1 + band * u_sunDir.z * 0.12 + band * 0.42;
  // --- Grasfarbe
  vec3 g = mix(u_gDark, u_gLight, 0.5 + 0.5 * clamp(stripe, -1.0, 1.0));
  g *= 0.93 + 0.12 * nL;
  g = mix(g, g * vec3(1.04, 1.02, 0.9), smoothstep(0.6, 0.9, nL) * 0.35);
  g *= 0.94 + 0.12 * nF;
  g *= 0.95 + 0.1 * nFF;
  // --- sauberer Rasen (Kundenwunsch: keine Abnutzungsflecken). Nur Baumschatten-Tupfen an der Westseite.
  vec3 col = g;
  float soil = 0.0;
  // --- Kreidelinien (analytisch, antialiased)
  vec2 a = abs(w);
  float ld = crt_lines(a) + (nFF - 0.5) * 0.004 * fineFade;
  float aa = max(pix * 0.75, 0.0015);
  float line = 1.0 - smoothstep(-aa, aa, ld);
  float chalk = mix(0.9, 1.0, nFF) * mix(0.94, 1.0, nF);
  float thin = clamp(0.05 / max(pix, 1e-4), 0.0, 1.0);
  col = mix(col, u_chalk * chalk, line * mix(0.85, 1.0, thin));
  // --- Material
  s.albedo = col;
  s.roughness = mix(mix(0.72, 0.9, soil), 0.85, line);
  s.specular = mix(0.38, 0.25, soil);
  s.sheen = 0.55 * (1.0 - soil) * (1.0 - line);
  s.sheenColor = vec3(0.55, 0.75, 0.32);
  float bf = 1.0 - smoothstep(3.0, 15.0, dist);
  if (bf > 0.0) s.normal = bumpNormal(s.normal, P, nF * 0.6 + nFF * 0.4, 0.003 * bf);
  s.ao = cf.a;
  // Laubschatten der Bäume hinter der Westtribüne (golden hour): weicher, getupfter Rand, Platzmitte bleibt sonnig
  float reach = -P.x - 4.6 - 1.8 * (cf.r - 0.5) * 2.0 - 0.9 * sin(P.z * 0.21 + 1.3);
  float zone = smoothstep(-1.2, 1.6, reach);
  if (zone > 0.0) {
    float leaf = fbm2(P.xz * vec2(0.55, 0.42) + vec2(3.1, 0.7), 4);
    float dapple = smoothstep(0.38, 0.62, leaf + zone * 0.35 - 0.12);
    s.shadow = 1.0 - 0.9 * zone * dapple;
  }
}
`;

/** Gebackene Felder (CPU): Großrauschen, Trockenheits-/Erde-Potenzial, Himmelssicht * Kontakt-AO. */
function bakeField() {
  const data = new Uint8Array(TEX_W * TEX_H * 4);
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const L = LAYOUT;
  for (let j = 0; j < TEX_H; j++) {
    const z = ((j + 0.5) / TEX_H - 0.5) * 2 * EXT_Z;
    for (let i = 0; i < TEX_W; i++) {
      const x = ((i + 0.5) / TEX_W - 0.5) * 2 * EXT_X;
      const nL = fbm3(x * 0.23 + 3.7, 0.5, z * 0.23, 3);
      const nM = noise3(x * 1.7 + 11, 2.5, z * 1.7);
      const ax = Math.abs(x), az = Math.abs(z);
      const zr = az - 12.25;
      const zf = zr < 0 ? zr / 1.25 : zr / 2.3;
      const xf = ax / (3.0 + 0.9 * nL);
      const core = Math.exp(-Math.pow(xf, 4) - zf * zf);
      const lane = Math.exp(-Math.pow((az - 12.9) / 1.2, 2)) * ss(6.0, 3.0, ax) * 0.7;
      const ret = Math.exp(-Math.pow((ax - 2.9) / 1.1, 2) - Math.pow((az - 13.0) / 1.0, 2)) * 0.55;
      const tee = Math.exp(-Math.pow(ax / 0.85, 2) - Math.pow((az - 6.0) / 0.9, 2)) * 0.5;
      const vol = Math.exp(-Math.pow(ax / 2.4, 2) - Math.pow((az - 2.8) / 1.6, 2)) * 0.22;
      const m = Math.max(core, lane, ret) + tee + vol;
      const n = nL * 0.65 + nM * 0.35;
      const dryP = 0 * m * n;
      const soilP = 0;
      // Himmelssicht + Kontakt-AO an der Mauer
      const dw = -sdRoundRect(x, z, L.wallX, L.wallZ, L.cornerR);
      const wallH = az > L.wallZ - 0.6 && ax < L.wallX - L.cornerR ? L.end.wallH : L.grand.wallH;
      const contact = 0.45 + 0.55 * ss(0, 0.35 + wallH * 0.35, dw);
      const ao = skyVisAt(x, 0.3, z, 0, 1, 0) * contact;
      const o = (j * TEX_W + i) * 4;
      data[o] = Math.round(Math.min(1, Math.max(0, nL)) * 255);
      data[o + 1] = Math.round(Math.min(1, Math.max(0, dryP / 1.6)) * 255);
      data[o + 2] = Math.round(Math.min(1, Math.max(0, soilP / 1.6)) * 255);
      data[o + 3] = Math.round(Math.min(1, Math.max(0, ao)) * 255);
    }
  }
  return { width: TEX_W, height: TEX_H, data };
}

/** Rasenfläche innerhalb der Mauern inkl. Linien. */
export function buildCourt(r, q) {
  const W = LAYOUT.wallX * 2 + 0.6, D = LAYOUT.wallZ * 2 + 0.6;
  const mesh = r.createMesh(plane(W, D, 4, 8));
  const fieldData = bakeField();
  const field = r.createTexture(fieldData, { filter: 'linear', wrap: 'clamp', mipmaps: true });
  const mat = r.createMaterial({
    name: 'env-grass',
    uniforms: {
      u_gLight: hex('#5c9a3e'), u_gDark: hex('#3b6f2a'), u_gDry: hex('#8f8a4e'), u_soil: hex('#b19d78'),
      u_chalk: [0.86, 0.87, 0.84], u_stripeW: 23.77 / 14, u_field: field,
    },
    surface: COURT_GLSL + GRASS_SURFACE,
  });
  const drawables = [{ mesh, material: mat, model: mat4.create(), castShadow: false, bounds: { center: [0, 0, 0], radius: Math.hypot(W, D) * 0.5 } }];
  /** Abnutzung an (x,z): sauberer Rasen -> immer 0 (API bleibt stabil). */
  const wearAt = () => ({ dry: 0, soil: 0 });
  /** Abstand zur nächsten Linie (m, < 0 = auf der Linie). */
  const lineDistance = (x, z) => {
    const ax = Math.abs(x), az = Math.abs(z);
    const rect = (x0, z0, x1, z1) => {
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, hx = (x1 - x0) / 2, hz = (z1 - z0) / 2;
      const qx = Math.abs(ax - cx) - hx, qz = Math.abs(az - cz) - hz;
      return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
    };
    return Math.min(rect(0, 11.785, 5.485, 11.885), rect(5.435, 0, 5.485, 11.885), rect(4.065, 0, 4.115, 11.885),
      rect(0, 6.35, 4.115, 6.4), rect(0, 0, 0.025, 6.4), rect(0, 11.685, 0.025, 11.885));
  };
  return { drawables, material: mat, wearAt, lineDistance };
}

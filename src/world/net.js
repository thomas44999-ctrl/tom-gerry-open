// Netz: alpha-getestetes prozedurales Maschennetz mit korrektem Durchhang (netHeightAt), Netzband,
// Mittelband, Pfosten mit Kurbelkasten, Einzelstützen; Gitterschatten; Wellen bei net.impulse().
import { MeshBuilder } from './mb.js';
import { COURT, netHeightAt } from '../sim/court.js';
import { hex } from './envlib.js';

const N = COURT.net;
const MAX_IMP = 4;

const NET_VERTEX = `
// u_imp[k] = (x, y, Alter s, Stärke m); Auslenkung entlang z
float net_disp(vec3 p) {
  float d = 0.0;
  float pin = smoothstep(${N.postX.toFixed(3)}, ${(N.postX - 0.9).toFixed(3)}, abs(p.x));
  float bottom = 0.35 + 0.65 * smoothstep(0.0, 0.5, p.y);
  for (int k = 0; k < ${MAX_IMP}; k++) {
    vec4 I = u_imp[k];
    if (I.w == 0.0) continue;
    float age = I.z;
    vec2 q = vec2(p.x - I.x, (p.y - I.y) * 1.6);
    float r = length(q);
    float env = exp(-age * 2.6) * exp(-r * r * 0.9);
    float bulge = exp(-age * 9.0) * exp(-r * r * 30.0);
    d += I.w * (env * sin(age * 26.0 - r * 7.0) * 0.55 + bulge);
  }
  return d * pin * bottom;
}
void vertexObject(inout vec3 p, inout vec3 n) {
  float d = net_disp(p);
  // Netzband (a_data.x = 1) steifer
  if (a_data.x > 0.5) d *= 0.55;
  p.z += d;
}`;

const NET_SURFACE = `
void surface(in SurfaceInput i, inout Surface s) {
  vec2 p = i.objPos.xy;
  float solid = i.data.x;              // 1 = Band/Gurt (massiv)
  float top = i.data.y;                 // Oberkante des Netzes an dieser Stelle (Ruhelage)
  float cell = 0.045;
  vec2 g = p / cell;
  vec2 fw = max(fwidth(g), vec2(1e-4));
#ifdef SHADOW_PASS
  float lw = 0.11;                      // Schatten: dickere Fäden, damit ein Gitter sichtbar bleibt
#else
  float lw = 0.035;
#endif
  vec2 dd = abs(fract(g) - 0.5);
  vec2 cov = smoothstep(0.5 - lw - fw * 0.5, 0.5 - lw + fw * 0.5, dd);
  float mesh = max(cov.x, cov.y);
  // feine Maschen in der Ferne: mittlere Bedeckung
  // Ferne: Maschen nicht mehr auflösbar -> stochastische Bedeckung (Bildschirm-Rauschen, mit A2C weich),
  // damit das Netz aus der TV-Perspektive als dichtes dunkles Gewebe lesbar bleibt statt zu verschwinden.
  float far = smoothstep(0.3, 0.6, max(fw.x, fw.y));
#ifndef SHADOW_PASS
  if (far > 0.0) {
    float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float covFar = 0.42;
    mesh = mix(mesh, step(ign, covFar), far);
  }
#else
  mesh = mix(mesh, 0.62 * 2.0 * lw * 2.0 + 0.1, far);
#endif
  // Netzband oben (6.35 cm), Mittelband, Seitenbänder an den Pfosten, Unterkante
  float tape = step(top - 0.064, p.y);
  float strap = step(abs(p.x), 0.025) * step(p.y, top);
  float sideBand = step(${(N.postX - 0.05).toFixed(3)}, abs(p.x));
  float bottomCord = step(p.y, 0.035);
  float band = max(max(tape, strap), max(sideBand, bottomCord));
  float a = max(mesh, max(band, solid));
  s.alpha = a;
  vec3 netCol = vec3(0.05, 0.056, 0.052);
  vec3 white = vec3(0.86, 0.86, 0.83);
  float isWhite = max(max(tape, strap), solid);
  s.albedo = mix(netCol, white, isWhite);
  s.albedo = mix(s.albedo, vec3(0.03, 0.06, 0.045), sideBand * (1.0 - tape));
  s.roughness = mix(0.85, 0.6, isWhite);
  s.sheen = (1.0 - isWhite) * 0.55; s.sheenColor = vec3(0.8);
}`;

export function buildNet(r, q, opts = {}) {
  // ---------------------------------------------------------------- Netzfläche + Band
  const mb = new MeshBuilder();
  const cols = 128, rows = 12;
  const X0 = -N.postX + 0.04, X1 = N.postX - 0.04;
  const base = mb.vertexCount;
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const x = X0 + (X1 - X0) * i / cols;
      const top = netHeightAt(x);
      const v = j / rows;
      const y = 0.02 + (top - 0.02) * v;
      mb.v(x, y, 0, 0, 0, 1, 0, 0, [1, 1, 1, 1], [0, top, 0, 0]);
    }
  }
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const a = base + j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1;
    mb.tri(a, b, d); mb.tri(a, d, c);
  }
  // Netzband als flacher Quader um das Seil (Dicke 1.6 cm, Höhe 7 cm)
  const tb = mb.vertexCount;
  const tz = 0.008;
  const seg = 96;
  for (let i = 0; i <= seg; i++) {
    const x = -N.postX + 2 * N.postX * i / seg;
    const top = netHeightAt(x);
    const y0 = top - 0.066, y1 = top + 0.006;
    for (const [z, y, nz, ny] of [[-tz, y0, -1, 0], [-tz, y1, -1, 0], [-tz, y1, 0, 1], [tz, y1, 0, 1], [tz, y1, 1, 0], [tz, y0, 1, 0]]) {
      mb.v(x, y, z, 0, ny, nz, 0, 0, [1, 1, 1, 1], [1, top, 0, 0]);
    }
  }
  for (let i = 0; i < seg; i++) {
    const a = tb + i * 6, b = a + 6;
    // Vorderseite -z, Deckel, Rückseite +z
    mb.tri(a, a + 1, b + 1); mb.tri(a, b + 1, b);
    mb.tri(a + 2, a + 3, b + 3); mb.tri(a + 2, b + 3, b + 2);
    mb.tri(a + 4, a + 5, b + 5); mb.tri(a + 4, b + 5, b + 4);
  }
  const netData = mb.finish();
  delete netData.colors;
  const imp = new Float32Array(MAX_IMP * 4);
  const netMat = r.createMaterial({
    name: 'env-net',
    uniforms: { u_imp: { type: 'vec4', count: MAX_IMP, value: imp } },
    vertex: NET_VERTEX,
    surface: NET_SURFACE,
    alphaTest: 0.5,
    cull: 'none',
  });
  const netMesh = r.createMesh(netData);

  // ---------------------------------------------------------------- Pfosten, Stützen, Kurbel
  const pm = new MeshBuilder();
  const green = hex('#123826'), white = hex('#e9e6dc'), metal = hex('#8d938f');
  const D = (rough, pat, ao = 1) => [rough, pat, ao, 0];
  for (const sx of [-1, 1]) {
    const x = sx * N.postX;
    pm.tube([x, 0, 0], [x, N.postHeight + 0.02, 0], N.postRadius, 14, green, D(0.4, 5), true);
    pm.tube([x, N.postHeight + 0.02, 0], [x, N.postHeight + 0.06, 0], N.postRadius * 1.15, 14, green, D(0.35, 5), true);
    // Kurbelkasten außen
    pm.box([x + sx * 0.085, 0.82, 0], [0.07, 0.16, 0.1], null, green, D(0.45, 5));
    pm.tube([x + sx * 0.12, 0.82, 0], [x + sx * 0.12, 0.82, 0.13], 0.008, 6, metal, D(0.3, 5), true);
    pm.tube([x + sx * 0.12, 0.82, 0.13], [x + sx * 0.12, 0.74, 0.13], 0.012, 6, hex('#1a1a1a'), D(0.5, 0), true);
    // Bodenplatte
    pm.tube([x, 0, 0], [x, 0.015, 0], N.postRadius * 1.8, 14, green, D(0.5, 0), true);
    // Einzelstütze (weiß)
    const xs = sx * N.stickX;
    pm.tube([xs, 0, 0.012], [xs, N.stickHeight + 0.01, 0.012], N.stickRadius * 0.5, 10, white, D(0.45, 0), true);
    pm.tube([xs, 0, 0.012], [xs, 0.01, 0.012], N.stickRadius * 0.9, 10, white, D(0.5, 0), true);
  }
  // Bodenanker des Mittelbands
  pm.box([0, 0.006, 0], [0.12, 0.012, 0.06], null, hex('#222'), D(0.4, 5));
  const postMesh = r.createMesh(pm.finish());

  const drawables = [
    { mesh: netMesh, material: netMat, bounds: { center: [0, 0.55, 0], radius: 6.6 } },
    { mesh: postMesh, material: opts.structMaterial, bounds: { center: [0, 0.55, 0], radius: 6.6 } },
  ];

  // ---------------------------------------------------------------- Impulse
  const slots = Array.from({ length: MAX_IMP }, () => ({ x: 0, y: 0, age: 99, s: 0 }));
  let next = 0;
  const net = {
    drawables, material: netMat,
    /** Ball trifft das Netz: pos = Treffpunkt (Welt), strength in m (+ in +z). */
    impulse(pos, strength = 0.06) {
      const sl = slots[next]; next = (next + 1) % MAX_IMP;
      sl.x = Math.max(-N.postX, Math.min(N.postX, pos[0]));
      sl.y = Math.max(0.05, Math.min(1.07, pos[1]));
      sl.age = 0; sl.s = strength;
    },
    update(dt) {
      for (let k = 0; k < MAX_IMP; k++) {
        const sl = slots[k];
        sl.age += dt;
        const on = sl.age < 3 && sl.s !== 0;
        imp[k * 4] = sl.x; imp[k * 4 + 1] = sl.y; imp[k * 4 + 2] = sl.age; imp[k * 4 + 3] = on ? sl.s : 0;
      }
    },
  };
  return net;
}

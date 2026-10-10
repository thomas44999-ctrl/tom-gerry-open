// Umgebung außerhalb des Stadions: Vorplatz (Pflaster), Parkrasen mit Wegen, Baumring (instanziert, Wind),
// Hügel und Stadtsilhouette im Dunst.
import { MeshBuilder } from './mb.js';
import { LAYOUT, rng32, sdRoundRect } from './layout.js';
import { hex } from './envlib.js';
import { sphere, cylinder } from '../gfx/geometry.js';
import { mat4, noise3, fbm3 } from '../core/math.js';

const TERRAIN_SURFACE = `
void surface(in SurfaceInput i, inout Surface s) {
  vec3 P = i.worldPos;
  float kind = i.data.y;          // 0 Gelände, 1 Hügel, 2 Stadt
  float dist = length(P.xz);
  if (kind < 0.5) {
    float plaza = i.data.x;       // Abstand zur Außenfassade (m)
    float n = fbm2(P.xz * 0.05, 3);
    // Parkrasen mit breiten Mähstreifen
    float stripe = step(0.5, fract(P.x / 9.0 + 0.5 * step(0.5, fract(P.z / 140.0))));
    vec3 g = mix(vec3(0.055, 0.12, 0.035), vec3(0.075, 0.15, 0.045), stripe) * (0.8 + 0.4 * n);
    // Wege: radial + Ring
    float ang = atan(P.z, P.x);
    float radial = abs(fract(ang / 6.2831853 * 8.0 + 0.0625) - 0.5) * dist * 0.785;
    float ring = abs(dist - 92.0);
    float path = (1.0 - smoothstep(2.0, 2.6, radial)) * step(55.0, dist) + (1.0 - smoothstep(2.4, 3.0, ring));
    vec3 gravel = vec3(0.42, 0.38, 0.31) * (0.85 + 0.3 * noise2(P.xz * 3.0));
    vec3 col = mix(g, gravel, clamp(path, 0.0, 1.0));
    // Vorplatz: helle Steinplatten mit Fugen
    float pz = 1.0 - smoothstep(13.9, 14.0, plaza);
    float curb = smoothstep(13.75, 13.85, plaza) * (1.0 - smoothstep(14.0, 14.1, plaza));
    vec2 tile = abs(fract(P.xz / 1.2) - 0.5);
    float joint = smoothstep(0.47, 0.49, max(tile.x, tile.y));
    vec3 stone = vec3(0.56, 0.53, 0.47) * (0.9 + 0.15 * noise2(floor(P.xz / 1.2) * 7.1)) * (1.0 - joint * 0.25);
    col = mix(col, stone, pz);
    col = mix(col, vec3(0.7, 0.68, 0.62), curb);
    col *= mix(1.0, 0.75, smoothstep(14.0, 15.5, plaza) * (1.0 - smoothstep(15.5, 19.0, plaza)));
    s.albedo = col;
    s.roughness = mix(0.9, 0.7, pz);
    s.ao = mix(0.6, 1.0, smoothstep(0.0, 4.0, plaza));
  } else if (kind < 1.5) {
    float n = fbm2(P.xz * 0.01, 4);
    vec3 a = vec3(0.07, 0.11, 0.05), b = vec3(0.12, 0.13, 0.07);
    s.albedo = mix(a, b, n) * (0.8 + 0.4 * smoothstep(0.0, 60.0, P.y));
    s.roughness = 0.95;
  } else {
    // Stadt: Fassaden mit Fensterraster
    vec2 f = abs(fract(vec2(P.x + P.z, P.y) / vec2(3.2, 3.5)) - 0.5);
    float win = step(f.x, 0.3) * step(f.y, 0.25) * step(0.2, abs(i.normal.y - 1.0));
    s.albedo = mix(i.color.rgb, vec3(0.08, 0.1, 0.12), win * 0.8);
    s.roughness = mix(0.8, 0.2, win);
    s.specular = mix(0.4, 1.0, win);
  }
}`;

const TREE_VERTEX = `
void vertexObject(inout vec3 p, inout vec3 n) {
  float h = max(p.y - 2.0, 0.0);
  float ph = g_instData.x * 6.2831853;
  float sway = (sin(u_time * 1.3 + ph) * 0.6 + sin(u_time * 2.9 + ph * 1.7) * 0.25) * u_wind;
  float k = a_data.x;               // 1 = Laub
  p.x += sway * h * 0.025 * (0.4 + 0.6 * k);
  p.z += sway * h * 0.012;
  p += n * k * sin(u_time * 4.0 + p.x * 3.0 + p.y * 2.0 + ph) * 0.03 * u_wind;
}`;

const TREE_SURFACE = `
void surface(in SurfaceInput i, inout Surface s) {
  float leaf = i.data.x;
  vec3 P = i.worldPos;
  if (leaf > 0.5) {
    float n = noise3(P * 1.7) * 0.6 + noise3(P * 5.3) * 0.4;
    vec3 base = i.instColor.rgb;
    s.albedo = base * (0.7 + 0.6 * n);
    s.normal = normalize(s.normal + (vec3(noise3(P * 3.1), noise3(P * 3.1 + 7.0), noise3(P * 3.1 + 13.0)) - 0.5) * 1.2);
    s.roughness = 0.8;
    s.subsurface = 0.6; s.subsurfaceColor = vec3(0.5, 0.75, 0.2);
    s.sheen = 0.3; s.sheenColor = vec3(0.7, 0.9, 0.5);
    s.ao = i.data.y * (0.75 + 0.25 * n);
  } else {
    s.albedo = vec3(0.12, 0.09, 0.065) * (0.8 + 0.4 * noise3(P * vec3(8.0, 1.0, 8.0)));
    s.roughness = 0.9;
    s.ao = 0.7;
  }
}`;

/** Abstand vom Zentrum bis zur Außenfassade entlang Richtung (cx, cz). */
function exteriorRadius(cx, cz) {
  const L = LAYOUT, e = L.exterior;
  const ax = L.wallX + e, az = L.wallZ + e, rr = L.cornerR + e;
  let lo = 0, hi = 200;
  for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (sdRoundRect(cx * m, cz * m, ax, az, rr) < 0) lo = m; else hi = m; }
  return lo;
}

export function buildSurroundings(r, q) {
  const rnd = rng32(4242);
  const mb = new MeshBuilder();
  // ---------------------------------------------------------------- Gelände (Ring um das Stadion)
  const NA = 160;
  const radii = [0, 3, 8, 14, 22, 35, 55, 85, 130, 200, 300, 450, 700, 950];
  const base = mb.vertexCount;
  for (let i = 0; i <= NA; i++) {
    const a = (i / NA) * Math.PI * 2, cx = Math.cos(a), cz = Math.sin(a);
    const r0 = exteriorRadius(cx, cz) - 0.3;
    for (const dr of radii) {
      const rr = r0 + dr;
      const y = dr > 120 ? (fbm3(cx * 3.0, 0.5, cz * 3.0, 3) - 0.5) * Math.min(1, (dr - 120) / 200) * 6 : 0;
      mb.v(cx * rr, y, cz * rr, 0, 1, 0, 0, 0, [1, 1, 1, 1], [dr, 0, 1, 0]);
    }
  }
  const nr = radii.length;
  for (let i = 0; i < NA; i++) for (let j = 0; j < nr - 1; j++) {
    const a = base + i * nr + j, b = a + 1, c = a + nr, d = c + 1;
    mb.tri(a, d, b); mb.tri(a, c, d);
  }
  // ---------------------------------------------------------------- Hügel
  const NH = 220, hb = mb.vertexCount;
  const hr = [480, 560, 700, 860];
  for (let i = 0; i <= NH; i++) {
    const a = (i / NH) * Math.PI * 2, cx = Math.cos(a), cz = Math.sin(a);
    const ridge = fbm3(cx * 2.2 + 5, 1.5, cz * 2.2, 4);
    const H = 15 + Math.pow(ridge, 1.6) * 110;
    for (let j = 0; j < hr.length; j++) {
      const t = j / (hr.length - 1);
      const y = j === 0 ? -2 : H * Math.sin(t * Math.PI * 0.5 + 0.35) * (0.75 + 0.25 * noise3(cx * 9, t * 3, cz * 9));
      mb.v(cx * hr[j], y, cz * hr[j], -cx * 0.3, 1, -cz * 0.3, 0, 0, [1, 1, 1, 1], [0, 1, 1, 0]);
    }
  }
  for (let i = 0; i < NH; i++) for (let j = 0; j < hr.length - 1; j++) {
    const a = hb + i * hr.length + j, b = a + 1, c = a + hr.length, d = c + 1;
    mb.tri(a, d, b); mb.tri(a, c, d);
  }
  // ---------------------------------------------------------------- Stadtsilhouette (Sektor im Nordosten)
  const cityCols = ['#8e9aa6', '#a7aeb5', '#6f7c88', '#b8b2a6', '#7d8790'].map(hex);
  for (let k = 0; k < 46; k++) {
    const a = -1.15 + rnd() * 0.9;
    const d = 380 + rnd() * 120;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const w = 14 + rnd() * 26, h = 18 + Math.pow(rnd(), 2.2) * 95, dd = 14 + rnd() * 20;
    const m = mat4.fromYawTranslation(mat4.create(), rnd() * 3, [x, h / 2 - 1, z]);
    mb.box([0, 0, 0], [w, h, dd], m, cityCols[k % cityCols.length], [0, 2, 1, 0], 63 - 8);
  }
  const terrainData = mb.finish();
  const terrainMat = r.createMaterial({ name: 'env-terrain', surface: TERRAIN_SURFACE });
  const terrain = { mesh: r.createMesh(terrainData), material: terrainMat, castShadow: false, bounds: { center: [0, 0, 0], radius: 1000 } };

  // ---------------------------------------------------------------- Bäume
  const tb = new MeshBuilder();
  const trunk = cylinder(0.22, 0.32, 3.2, 7, 1, true);
  tb.add(trunk, mat4.fromTranslation(mat4.create(), [0, 1.6, 0]), [1, 1, 1, 1], [0, 1, 0, 0]);
  const blobs = [[0, 4.6, 0, 2.6, 2.2], [1.1, 5.6, 0.4, 1.9, 1.7], [-0.9, 5.4, -0.5, 2.0, 1.8], [0.2, 6.6, -0.2, 1.6, 1.4]];
  for (const [x, y, z, rad, ry] of blobs) {
    const sp = sphere(1, 9, 6);
    const P = sp.positions, N = sp.normals;
    // knubbelige Krone + AO (innen/unten dunkler)
    const data = new Float32Array((P.length / 3) * 4);
    for (let i = 0; i < P.length; i += 3) {
      const nx = N[i], ny = N[i + 1], nz = N[i + 2];
      const bump = 1 + (noise3(nx * 2.3 + x, ny * 2.3 + y, nz * 2.3 + z) - 0.5) * 0.55;
      P[i] = x + nx * rad * bump; P[i + 1] = y + ny * ry * bump; P[i + 2] = z + nz * rad * bump;
      const k = i / 3;
      data[k * 4] = 1; data[k * 4 + 1] = 0.55 + 0.45 * Math.max(0, ny * 0.5 + 0.5);
    }
    const base2 = tb.vertexCount;
    for (let i = 0; i < P.length / 3; i++) tb.v(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], N[i * 3], N[i * 3 + 1], N[i * 3 + 2], 0, 0, [1, 1, 1, 1], [1, data[i * 4 + 1], 0, 0]);
    for (let i = 0; i < sp.indices.length; i++) tb.idx.push(base2 + sp.indices[i]);
  }
  const treeData = tb.finish(); delete treeData.colors;
  const trees = [];
  const pathAt = (a, d) => {
    const ang = ((a / (Math.PI * 2)) * 8 + 0.0625) % 1;
    const radial = Math.abs(ang - 0.5) * d * 0.785;
    return (radial < 4 && d > 50) || Math.abs(d - 92) < 5;
  };
  const tryTree = (a, d) => {
    if (pathAt(((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2), d)) return;
    const cx = Math.cos(a), cz = Math.sin(a);
    const re = exteriorRadius(cx, cz);
    if (d < re + 16) return;
    trees.push({ x: cx * d, z: cz * d, s: 0.85 + rnd() * 0.75, yaw: rnd() * 6.28, c: rnd() });
  };
  // Allee und lockerer Bestand
  for (let i = 0; i < 64; i++) tryTree((i / 64) * Math.PI * 2, 84 + (rnd() - 0.5) * 2);
  for (let i = 0; i < 64; i++) tryTree((i / 64) * Math.PI * 2 + 0.05, 100 + (rnd() - 0.5) * 2);
  for (let i = 0; i < 260; i++) tryTree(rnd() * Math.PI * 2, 58 + Math.pow(rnd(), 0.8) * 160);
  const treeInst = r.createInstances(trees.length);
  const leafCols = ['#2c4a1e', '#365a22', '#2a4320', '#3d5f26', '#4a6a2a'].map(hex);
  const m = mat4.create();
  trees.forEach((t, i) => {
    mat4.fromYawTranslation(m, t.yaw, [t.x, 0, t.z], t.s);
    const c = leafCols[Math.floor(t.c * leafCols.length)];
    treeInst.set(i, m, [c[0], c[1], c[2], 1], [rnd(), 0, 0, 0]);
  });
  treeInst.count = trees.length;
  const treeMat = r.createMaterial({ name: 'env-tree', uniforms: { u_wind: 1.0 }, vertex: TREE_VERTEX, surface: TREE_SURFACE });
  const treeDraw = { mesh: r.createMesh(treeData), material: treeMat, instances: treeInst, castShadow: false };

  return {
    drawables: [terrain, treeDraw],
    treeCount: trees.length,
    update() {},
  };
}

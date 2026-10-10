// Engine-Showcase: testet alle Renderer-Features in einer Szene.
//   dev.html?scene=gfxtest[&quality=low|medium|high|ultra][&dof=1][&t=3][&cam=dist,yaw,pitch,targetY]
//   &tonemap=agx|neutral  &view=hue (Nahansicht Farbtreue-Kugeln)  &view=fur  &view=net  &view=pbr
// Inhalt: PBR-Kugelraster (Rauheit × Metall), Farbtreue-Kugeln (Orange #E8822A, Hellblau #8CCBF2),
// geskinnter Biege-Zylinder (3 Knochen), 2000 Instanzen mit vertexObject-Wackeln, Fell-Kugel
// (24 Schalen, Alpha-Test), alpha-getestetes Netz mit Gitterschatten, additive Billboard-Partikel
// (vertexWorld + u_cameraRight/Up), Canvas-Textur-Schild, emissive Objekte (Bloom).
import { mat4, quat, vec3, DEG, hexToLinear, makeRng } from '../../src/core/math.js';
import * as G from '../../src/gfx/geometry.js';

const VIEWS = {
  default: { dist: 17, yaw: 28, pitch: 20, target: [0, 0.8, 0] },
  hue: { dist: 4.6, yaw: -160, pitch: 12, target: [-0.55, 0.55, 2.7] },
  fur: { dist: 2.6, yaw: -120, pitch: 12, target: [-4.2, 0.75, 1.6] },
  net: { dist: 9, yaw: 70, pitch: 30, target: [0, 0.6, 5.5] },
  pbr: { dist: 8.5, yaw: 0, pitch: 14, target: [0, 0.7, -3] },
  skin: { dist: 5, yaw: -20, pitch: 10, target: [4.2, 1.2, 1.2] },
  sparks: { dist: 7, yaw: -40, pitch: 8, target: [6, 1.5, -3] },
};

export async function run({ renderer: r, devkit, params }) {
  const scene = devkit.defaultScene();
  if (params.has('tonemap')) scene.post.tonemap = params.get('tonemap');
  if (params.has('debug')) scene.post.debug = params.get('debug');
  const D = scene.drawables;
  const rng = makeRng(7);
  const T = (x, y, z, s = 1, yaw = 0) => mat4.fromYawTranslation(mat4.create(), yaw, [x, y, z], s);

  // ---------------------------------------------------------------- PBR-Raster
  const sph = r.createMesh(G.sphere(0.5, 64, 32));
  const pbrMat = r.createMaterial({
    name: 'pbr-grid',
    uniforms: { u_baseColor: [0.9, 0.9, 0.9], u_rough: 0.5, u_metal: 0 },
    surface: `void surface(in SurfaceInput i, inout Surface s) { s.roughness = u_rough; s.metalness = u_metal; }`,
  });
  const rows = [
    { metal: 0, color: [0.80, 0.80, 0.80] },
    { metal: 0, color: hexToLinear('#c0392b') },
    { metal: 1, color: [0.95, 0.93, 0.88] },
    { metal: 1, color: [1.0, 0.71, 0.29] },
  ];
  for (let ri = 0; ri < rows.length; ri++) {
    for (let ci = 0; ci < 7; ci++) {
      const rough = 0.05 + ci / 6 * 0.95;
      D.push({ mesh: sph, material: pbrMat, model: T(-4.5 + ci * 1.5, 0.35, -2.2 - ri * 1.05, 0.7), uniforms: { u_rough: rough, u_metal: rows[ri].metal, u_baseColor: rows[ri].color } });
    }
  }

  // ---------------------------------------------------------------- Farbtreue (matt)
  const matte = r.createMaterial({
    name: 'matte',
    uniforms: { u_baseColor: [1, 1, 1] },
    surface: `void surface(in SurfaceInput i, inout Surface s) { s.roughness = 0.85; s.specular = 0.4; }`,
  });
  D.push({ mesh: sph, material: matte, model: T(-1.3, 0.6, 2.6, 1.2), uniforms: { u_baseColor: hexToLinear('#E8822A') } });
  D.push({ mesh: sph, material: matte, model: T(0.2, 0.6, 2.6, 1.2), uniforms: { u_baseColor: hexToLinear('#8CCBF2') } });
  D.push({ mesh: sph, material: matte, model: T(1.55, 0.45, 2.9, 0.9), uniforms: { u_baseColor: [0.85, 0.85, 0.85] } });
  // Tennisball-Gelb zum Vergleich
  D.push({ mesh: sph, material: matte, model: T(-2.35, 0.2, 3.2, 0.4), uniforms: { u_baseColor: hexToLinear('#D7E83A') } });

  // ---------------------------------------------------------------- Skinning: Biege-Zylinder
  const cyl = G.cylinder(0.22, 0.22, 2.4, 32, 36);
  {
    const n = cyl.positions.length / 3;
    cyl.joints = new Uint8Array(n * 4); cyl.weights = new Float32Array(n * 4);
    for (let v = 0; v < n; v++) {
      const y = cyl.positions[v * 3 + 1] + 1.2; // 0..2.4
      // weiche Übergänge an den Gelenken bei 0.8 und 1.6
      const w1 = smooth(0.6, 1.0, y), w2 = smooth(1.4, 1.8, y);
      const wa = 1 - w1, wb = w1 - w2, wc = w2;
      cyl.joints.set([0, 1, 2, 0], v * 4);
      cyl.weights.set([wa, wb, wc, 0], v * 4);
    }
    // in Bind-Pose auf y = 0..2.4 verschieben
    for (let v = 0; v < n; v++) cyl.positions[v * 3 + 1] += 1.2;
  }
  const skinMat = r.createMaterial({
    name: 'skin-test',
    uniforms: { u_baseColor: hexToLinear('#3f7fd1') },
    surface: `void surface(in SurfaceInput i, inout Surface s) {
      float band = step(0.5, fract(i.objPos.y * 2.5));
      s.albedo = mix(s.albedo, vec3(0.9, 0.88, 0.82), band * 0.85);
      s.roughness = 0.45; s.sheen = 0.2;
    }`,
  });
  const bones = new Float32Array(3 * 16);
  const skinDrawable = { mesh: r.createMesh(cyl), material: skinMat, model: T(4.2, 0, 1.2), bones };
  D.push(skinDrawable);
  const _q = quat.create(), _b = [mat4.create(), mat4.create(), mat4.create()], _l = mat4.create(), _inv = mat4.create();
  const updateBones = (t) => {
    for (let k = 0; k < 3; k++) {
      const ang = Math.sin(t * 1.3 + k * 0.6) * (k === 0 ? 0.25 : 0.55);
      quat.identity(_q); quat.rotateZ(_q, _q, ang); quat.rotateX(_q, _q, Math.sin(t * 0.9 + k) * 0.25);
      mat4.fromRotationTranslation(_l, _q, k === 0 ? [0, 0, 0] : [0, 0.8, 0]);
      if (k === 0) mat4.copy(_b[0], _l); else mat4.multiply(_b[k], _b[k - 1], _l);
      mat4.fromTranslation(_inv, [0, -0.8 * k, 0]);
      mat4.multiply(_l, _b[k], _inv);
      bones.set(_l, k * 16);
    }
  };

  // ---------------------------------------------------------------- 2000 Instanzen (Wackeln im vertexObject)
  const N_INST = 2000;
  const instMesh = r.createMesh(G.roundedBox(0.16, 0.42, 0.16, 0.05, 2));
  const inst = r.createInstances(N_INST);
  const im = mat4.create();
  for (let i = 0; i < N_INST; i++) {
    const a = rng() * Math.PI * 2, rad = 10 + Math.sqrt(rng()) * 9;
    const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
    const s = 0.8 + rng() * 0.6;
    mat4.fromYawTranslation(im, rng() * 6.28, [x, 0.21 * s, z], s);
    const h = rng();
    inst.set(i, im, hsl(h, 0.55, 0.55), [rng(), 0.5 + rng(), 0, 0]);
  }
  inst.count = N_INST;
  const instMat = r.createMaterial({
    name: 'inst-wobble',
    uniforms: { u_amp: 0.07 },
    vertex: `void vertexObject(inout vec3 p, inout vec3 n) {
      float h = p.y + 0.21;
      float w = sin(u_time * 2.6 * g_instData.y + g_instData.x * 6.2831) * u_amp * h * h * 4.0;
      p.x += w; p.z += w * 0.5;
    }`,
    surface: `void surface(in SurfaceInput i, inout Surface s) { s.albedo = i.instColor.rgb; s.roughness = 0.55; }`,
  });
  D.push({ mesh: instMesh, material: instMat, instances: inst, bounds: { center: [0, 0.3, 0], radius: 20 } });

  // ---------------------------------------------------------------- Fell-Kugel (Schalen)
  const furMat = r.createMaterial({
    name: 'fur-test',
    uniforms: { u_baseColor: hexToLinear('#E8822A'), u_furLen: 0.05, u_density: 300 },
    vertex: `void vertexObject(inout vec3 p, inout vec3 n) {
      p += n * (g_shell * u_furLen);
      p.y -= g_shell * g_shell * u_furLen * 0.3;   // Schwerkraft
    }`,
    surface: `void surface(in SurfaceInput i, inout Surface s) {
      vec3 P = i.objPos * u_density;
      vec3 cell = floor(P);
      vec3 h = hash33(cell);
      float d = length(P - (cell + 0.2 + 0.6 * h));
      float len = 0.5 + 0.5 * h.z;
      float sh = i.shell;
      float r = 0.7 * (1.0 - sh / len);
      s.alpha = sh <= 0.0 ? 1.0 : smoothstep(r + 0.1, r - 0.1, d) * step(sh, len);
      // Tabby-Streifen (über objPos stabil), heller Bauch, dunklere Wurzeln
      float stripe = smoothstep(0.45, 0.62, sin(i.objPos.y * 24.0 + i.objPos.x * 6.0 + snoise3(i.objPos * 5.0) * 2.0) * 0.5 + 0.5);
      vec3 base = mix(s.albedo, s.albedo * vec3(0.5, 0.33, 0.2), stripe * 0.7);
      base = mix(base, vec3(0.92, 0.86, 0.76), smoothstep(-0.05, -0.4, i.objPos.y));
      s.albedo = base * mix(0.5, 1.0, sqrt(sh)) * (0.88 + 0.24 * h.x);
      s.ao = mix(0.55, 1.0, sh);
      s.roughness = 0.7;
      s.sheen = 0.5; s.sheenColor = mix(vec3(1.0), base, 0.5);
    }`,
    alphaTest: 0.5,
  });
  D.push({ mesh: sph, material: furMat, model: T(-4.2, 0.72, 1.6, 1.2), shells: 24 });

  // ---------------------------------------------------------------- Netz (Alpha-Test, Gitterschatten)
  const netMat = r.createMaterial({
    name: 'net-test',
    uniforms: { u_baseColor: [0.85, 0.85, 0.82], u_cells: [60, 12] },
    surface: `void surface(in SurfaceInput i, inout Surface s) {
      vec2 g = fract(i.uv * u_cells);
      vec2 w = fwidth(i.uv * u_cells);
      vec2 line = smoothstep(0.09 + w, 0.09 - w * 0.5, min(g, 1.0 - g));
      float band = step(i.uv.y, 0.07);   // oberes Band
      s.alpha = max(max(line.x, line.y), band);
      s.albedo = mix(vec3(0.06), s.albedo, max(band, 0.2));
      s.albedo = band > 0.5 ? vec3(0.92) : vec3(0.08);
      s.roughness = 0.8;
    }`,
    alphaTest: 0.5, cull: 'none',
  });
  const netMesh = r.createMesh(G.quad(6.4, 1.07));
  D.push({ mesh: netMesh, material: netMat, model: T(0, 0.535, 5.2) });
  const postMesh = r.createMesh(G.cylinder(0.04, 0.04, 1.07, 16));
  const steel = r.createMaterial({ name: 'steel', uniforms: { u_baseColor: [0.2, 0.32, 0.22] }, surface: `void surface(in SurfaceInput i, inout Surface s) { s.roughness = 0.35; s.metalness = 0.2; }` });
  D.push({ mesh: postMesh, material: steel, model: T(-3.25, 0.535, 5.2) });
  D.push({ mesh: postMesh, material: steel, model: T(3.25, 0.535, 5.2) });

  // ---------------------------------------------------------------- Partikel (additiv, Billboards)
  const N_P = 500;
  const pInst = r.createInstances(N_P);
  for (let i = 0; i < N_P; i++) {
    mat4.fromTranslation(im, [6, 0.15, -3]);
    const warm = rng();
    pInst.set(i, im, [1.0, 0.45 + warm * 0.35, 0.12 + warm * 0.1, 1], [rng(), 0.25 + rng() * 0.5, rng() * 6.283, 0.04 + rng() * 0.07]);
  }
  pInst.count = N_P;
  const sparkMat = r.createMaterial({
    name: 'sparks',
    uniforms: { u_height: 3.2, u_intensity: 7.0 },
    vertex: `
      vec2 g_corner; float g_life;
      void vertexObject(inout vec3 p, inout vec3 n) { g_corner = a_uv * 2.0 - 1.0; p = vec3(0.0); }
      void vertexWorld(inout vec3 wp, inout vec3 wn) {
        float life = fract(u_time * g_instData.y + g_instData.x);
        g_life = life;
        float a = g_instData.z + life * 2.5;
        float rr = 0.15 + life * 0.9;
        wp += vec3(cos(a) * rr, life * u_height + sin(life * 9.0 + g_instData.z) * 0.15, sin(a) * rr);
        float size = g_instData.w * (1.0 - life * 0.7);
        wp += (u_cameraRight * g_corner.x + u_cameraUp * g_corner.y) * size;
        wn = -normalize(cross(u_cameraRight, u_cameraUp));
      }`,
    surface: `void surface(in SurfaceInput i, inout Surface s) {
      vec2 c = i.uv * 2.0 - 1.0;
      float f = saturate(1.0 - dot(c, c));
      f *= f;
      s.albedo = vec3(0.0);
      s.emissive = i.instColor.rgb * u_intensity;
      s.alpha = f;
    }`,
    blend: 'additive', unlit: true, depthWrite: false, cull: 'none', castShadow: false,
  });
  D.push({ mesh: r.createMesh(G.quad(1, 1)), material: sparkMat, instances: pInst, pass: 'transparent', bounds: { center: [6, 2, -3], radius: 4 } });
  // Glut-Schale (emissiv)
  const emberMat = r.createMaterial({
    name: 'ember',
    uniforms: { u_baseColor: [0.05, 0.05, 0.05], u_glow: [6.0, 2.0, 0.4] },
    surface: `void surface(in SurfaceInput i, inout Surface s) {
      float n = fbm3(i.objPos * 6.0 + vec3(0.0, i.time * 0.6, 0.0), 4);
      s.emissive = u_glow * smoothstep(0.45, 0.75, n) * step(0.0, i.objNormal.y);
      s.roughness = 0.9;
    }`,
  });
  D.push({ mesh: r.createMesh(G.cylinder(0.55, 0.4, 0.3, 32)), material: emberMat, model: T(6, 0.15, -3) });

  // ---------------------------------------------------------------- emissive Objekte (Bloom)
  const glow = r.createMaterial({
    name: 'glow',
    uniforms: { u_baseColor: [0.02, 0.02, 0.02], u_emit: [0, 0, 0] },
    surface: `void surface(in SurfaceInput i, inout Surface s) { s.emissive = u_emit; s.roughness = 0.3; }`,
  });
  const torus = r.createMesh(G.torus(0.55, 0.06, 16, 64, Math.PI * 2, 'z'));
  D.push({ mesh: torus, material: glow, model: T(5.0, 1.25, 3.6, 1, -0.5), uniforms: { u_emit: [0.4, 2.5, 9.0] } });
  const cube = r.createMesh(G.box(0.3, 0.3, 0.3));
  D.push({ mesh: cube, material: glow, model: T(6.4, 0.15, 3.2), uniforms: { u_emit: [12.0, 1.5, 3.0] } });
  D.push({ mesh: cube, material: glow, model: T(6.9, 0.15, 3.8), uniforms: { u_emit: [6.0, 9.0, 1.5] } });
  D.push({ mesh: cube, material: glow, model: T(5.8, 0.15, 4.1), uniforms: { u_emit: [1.5, 2.0, 2.5] } });

  // ---------------------------------------------------------------- Canvas-Textur
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 512;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 1024, 512);
  grad.addColorStop(0, '#0f3d2e'); grad.addColorStop(1, '#1c6b4a');
  g.fillStyle = grad; g.fillRect(0, 0, 1024, 512);
  g.strokeStyle = '#f4efe1'; g.lineWidth = 14; g.strokeRect(24, 24, 976, 464);
  g.fillStyle = '#f4efe1'; g.font = 'bold 96px Georgia, serif'; g.textAlign = 'center';
  g.fillText('Tom & Gerry', 512, 220);
  g.font = 'italic 64px Georgia, serif'; g.fillStyle = '#e8c35a';
  g.fillText('Open · Centre Court', 512, 330);
  g.fillStyle = '#d7e83a'; g.beginPath(); g.arc(512, 420, 34, 0, Math.PI * 2); g.fill();
  const tex = r.createTexture(cv, { srgb: true, anisotropy: 8 });
  const signMat = r.createMaterial({
    name: 'canvas-sign',
    uniforms: { u_tex: tex },
    surface: `void surface(in SurfaceInput i, inout Surface s) {
      s.albedo = texture(u_tex, i.uv).rgb;
      s.roughness = 0.5;
    }`,
  });
  D.push({ mesh: r.createMesh(G.quad(3.2, 1.6)), material: signMat, model: T(-6.2, 1.35, -3.6, 1, 0.55) });
  D.push({ mesh: cube, material: steel, model: mat4.multiply(mat4.create(), T(-6.2, 0.28, -3.6, 1, 0.55), mat4.fromScaling(mat4.create(), [10, 1.85, 0.4])) });

  // ---------------------------------------------------------------- Kamera
  const view = VIEWS[params.get('view', 'default')] || VIEWS.default;
  devkit.setOrbit(view);
  if (params.bool('dof', false)) devkit.camera.dof = { focus: devkit.orbit.dist, aperture: params.num('aperture', 0.7) };
  scene.shadow.center = [0, 0, 0];
  scene.shadow.radius = 14;

  window.__gfx = { scene, renderer: r };
  devkit.start({
    scene,
    update(dt, t) {
      updateBones(t);
      if (devkit.camera.dof) devkit.camera.dof.focus = devkit.orbit.dist;
    },
  });
}

function smooth(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function hsl(h, s, l) {
  const f = (n) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return [lin(f(0)), lin(f(8)), lin(f(4)), 1];
}

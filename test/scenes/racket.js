// Schläger-Testszene: Tom- und Gerry-Stil nebeneinander (Rahmen, Herz, Griffband, Saiten, Dämpfer).
//   dev.html?scene=racket&view=front|side|throat|grip|far  &spin=1 (Drehung)  &style=tom|gerry|both
//   Markierungen: kleine Kugeln am Griffpunkt (Ursprung) und am Sweet-Spot.
import { buildRacket, RACKET_STYLES } from '../../src/chars/racket.js';
import { sphere } from '../../src/gfx/geometry.js';
import { mat4, DEG } from '../../src/core/math.js';

const VIEWS = {
  front: { target: [0, 0.44, 0], dist: 1.25, yaw: 0, pitch: 4, fov: 0.62 },
  side: { target: [0, 0.44, 0], dist: 1.25, yaw: 70, pitch: 6, fov: 0.62 },
  throat: { target: [-0.22, 0.36, 0], dist: 0.42, yaw: 25, pitch: 8, fov: 0.6 },
  grip: { target: [-0.22, 0.13, 0], dist: 0.32, yaw: 35, pitch: 12, fov: 0.6 },
  far: { target: [0, 0.44, 0], dist: 9, yaw: 20, pitch: 10, fov: 0.35 },
};

export async function run(ctx) {
  const { renderer: r, params, devkit } = ctx;
  const scene = devkit.defaultScene();
  const which = params.get('style', 'both');
  const styles = which === 'both' ? ['tom', 'gerry'] : [which];
  const t0 = performance.now();
  const rackets = styles.map((s) => buildRacket(r, RACKET_STYLES[s]));
  const buildMs = performance.now() - t0;
  const marker = r.createMesh(sphere(0.006, 12, 8));
  const markMat = r.createMaterial({ name: 'racket-marker', surface: 'void surface(in SurfaceInput i, inout Surface s){ s.albedo = vec3(0.9, 0.1, 0.1); s.roughness = 0.5; }' });
  const items = rackets.map((rk, i) => {
    const model = mat4.create();
    const ds = rk.parts.map((p) => { const d = { mesh: p.mesh, material: p.material, model, castShadow: true }; scene.drawables.push(d); return d; });
    const marks = params.bool('marks', true) ? [[0, 0, 0], rk.sweetSpot].map((p) => {
      const d = { mesh: marker, material: markMat, model: mat4.create(), castShadow: false, local: p };
      scene.drawables.push(d); return d;
    }) : [];
    return { rk, model, ds, marks, x: (i - (rackets.length - 1) / 2) * 0.44 };
  });
  const v = VIEWS[params.get('view', 'front')] || VIEWS.front;
  devkit.camera.fov = v.fov;
  devkit.setOrbit({ target: v.target, dist: v.dist, yaw: v.yaw, pitch: v.pitch });
  const spin = params.bool('spin', false);
  window.__racket = { rackets, buildMs };
  devkit.start({
    scene,
    update(dt, t) {
      for (const it of items) {
        mat4.fromTranslation(it.model, [it.x, 0.12, 0]);      // aufrecht, Griffpunkt 12 cm über dem Boden
        if (spin) mat4.rotateY(it.model, it.model, t * 0.7);
        for (const m of it.marks) mat4.translate(m.model, it.model, m.local);
      }
    },
  });
  return { rackets, buildMs };
}

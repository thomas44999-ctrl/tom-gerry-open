// Tom-Testszene: geskinnter Tom + Schläger in der Faust, Testposen, Mimik.
//   dev.html?scene=tom&view=full|face|broadcast|back|hands&pose=rest|ready|forehand|armsup|backhand&blink=1
//   &mood=neutral|happy|focused|sad  &look=x,y,z (Blickrichtung Kopfraum)  &racket=0  &spin=1 (Drehteller)
import { buildTom } from '../../src/chars/tom.js';
import { buildRacket } from '../../src/chars/racket.js';
import { createSkeleton } from '../../src/chars/skeleton.js';
import { createPose, poseFromEuler, limbIK } from '../../src/chars/pose.js';
import { mat4, DEG } from '../../src/core/math.js';

/** Testposen (Euler-Grad, Konvention src/chars/pose.js). feet: Fuß-IK-Ziele relativ zur Ruheposition. */
export const TOM_POSES = {
  rest: { spec: {} },
  ready: {
    spec: {
      pelvisOffset: [0, -0.1, -0.02], spine: [16, 0, 0], chest: [6, 0, 0], neck: [-10, 0, 0], head: [-12, 0, 0],
      arm_r: [38, 10, -2], forearm_r: [62, -55, 0], hand_r: [0, 0, 10],
      arm_l: [42, -15, 4], forearm_l: [78, 40, 0], hand_l: [0, 0, 0],
    },
    ik: true, feet: { l: [0.06, 0, 0.02], r: [-0.06, 0, 0.02] },
  },
  forehand: {
    spec: {
      root: [0, -20, 0], pelvisOffset: [0, -0.1, 0],
      spine: [10, -8, -4], chest: [4, -14, -4], neck: [-6, 12, 0], head: [-8, 14, 4],
      shoulder_r: [0, 0, 6], arm_r: [40, -15, 55], forearm_r: [30, -50, 0], hand_r: [0, 0, 30],
      arm_l: [75, 10, 15], forearm_l: [55, 0, 0],
    },
    ik: true, feet: { l: [0.22, 0, 0.18], r: [-0.28, 0, -0.12] },
  },
  backhand: {
    spec: {
      root: [0, 35, 0], pelvisOffset: [0, -0.1, 0], spine: [10, 10, 0], chest: [6, 18, 0], neck: [-6, -20, 0], head: [-8, -18, 0],
      arm_r: [70, 30, -10], forearm_r: [20, 20, 0], hand_r: [0, 0, -20],
      arm_l: [40, 0, -10], forearm_l: [60, 0, 0],
    },
    ik: true, feet: { l: [0.2, 0, -0.1], r: [-0.25, 0, 0.18] },
  },
  armsup: { spec: { arm_l: [10, 0, 130], arm_r: [10, 0, 130], forearm_l: [15, 0, 0], forearm_r: [15, 0, 0], spine: [-6, 0, 0], chest: [-6, 0, 0] } },
  crouch: {
    spec: { spine: [25, 0, 0], chest: [10, 0, 0], neck: [-15, 0, 0], head: [-15, 0, 0], arm_l: [70, 0, -5], arm_r: [70, 0, -5], forearm_l: [40, 0, 0], forearm_r: [40, 0, 0], pelvisOffset: [0, -0.43, -0.12] },
    ik: true,
  },
};

export function buildTomPose(def, sk, name, out = createPose(def)) {
  const P = TOM_POSES[name] || TOM_POSES.rest;
  poseFromEuler(def, P.spec, out);
  if (P.ik) {
    for (const s of ['l', 'r']) {
      const f = sk.restPos('foot_' + s), off = (P.feet && P.feet[s]) || [0, 0, 0];
      const tgt = [f[0] + off[0], f[1] + off[1], f[2] + off[2]];
      const k = sk.restPos('shin_' + s);
      limbIK(def, out, 'leg_' + s, tgt, [k[0] * 1.8 + off[0], k[1], k[2] + 1 + off[2]], { endRot: [0, 0, 0, 1] });
    }
  }
  return out;
}

const VIEWS = {
  full: { target: [0, 0.98, 0], dist: 3.3, yaw: 28, pitch: 6, fov: 0.75 },
  back: { target: [0, 0.98, 0], dist: 3.3, yaw: 160, pitch: 8, fov: 0.75 },
  face: { target: [0, 1.665, 0.02], dist: 0.62, yaw: 22, pitch: 3, fov: 0.55 },
  hands: { target: [-0.5, 1.0, 0.1], dist: 0.7, yaw: -30, pitch: 10, fov: 0.6 },
  headf: { target: [0, 1.672, 0.0], dist: 1.6, yaw: 0, pitch: 0, fov: 0.19 },
  heads: { target: [0, 1.672, 0.0], dist: 1.6, yaw: 90, pitch: 0, fov: 0.19 },
  head34: { target: [0, 1.672, 0.0], dist: 1.6, yaw: 35, pitch: 4, fov: 0.19 },
  headb: { target: [0, 1.672, 0.0], dist: 1.6, yaw: 145, pitch: 10, fov: 0.19 },
  broadcast: { target: [0, 0.95, 0], dist: Math.hypot(18, 7), yaw: 180 + 12, pitch: Math.atan2(7, 18) / DEG, fov: 25 * DEG },
};

export async function run(ctx) {
  const { renderer: r, params, devkit } = ctx;
  const t0 = performance.now();
  const asset = buildTom(r);
  const buildMs = performance.now() - t0;
  const racket = params.bool('racket', true) ? buildRacket(r, asset.racketStyle) : null;
  const def = asset.skeletonDef;
  const sk = createSkeleton(def);
  const scene = devkit.defaultScene();
  // Sonne: front (Standard für Begutachtung), back (Gegenlicht wie Standard-Devkit), side
  const sunMode = params.get('sun', 'front');
  const sunAt = { front: [30, 40], side: [80, 35], back: [-148, 32], top: [20, 70] }[sunMode];
  if (sunAt) { const az = sunAt[0] * DEG, el = sunAt[1] * DEG; scene.sun.dir = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)]; }
  const root = mat4.create();
  for (const p of asset.parts) scene.drawables.push({ mesh: p.mesh, material: p.material, bones: sk.skin, model: root, castShadow: p.castShadow !== false });
  const hide = params.get('hide', '').split(',');
  const atts = asset.attachments.map((a) => {
    const d = { mesh: a.mesh, material: a.material, model: mat4.create(), castShadow: a.castShadow !== false && !params.get('noshadow', '').split(',').includes(a.name) };
    if (!hide.includes(a.name)) scene.drawables.push(d);
    return { a, d, bi: def.index[a.bone] };
  });
  const rk = racket ? racket.parts.map((p) => { const d = { mesh: p.mesh, material: p.material, model: mat4.create(), castShadow: true }; scene.drawables.push(d); return d; }) : [];
  const handR = def.index[asset.gripSocket.bone];

  const viewName = params.get('view', 'full');
  const v = VIEWS[viewName] || VIEWS.full;
  devkit.camera.fov = params.num('fov', 0) > 0 ? params.num('fov', 0) * DEG : v.fov;
  devkit.setOrbit({ target: v.target, dist: v.dist, yaw: v.yaw, pitch: v.pitch });
  if (viewName === 'broadcast') scene.post.vignette = 0.15;

  const pose = createPose(def);
  const poseName = params.get('pose', 'rest');
  const blink = params.has('blink') ? params.num('blink', 1) : undefined;
  const mood = params.get('mood', 'neutral');
  const look = params.list('look', []);
  const spin = params.bool('spin', false);
  const tmp = mat4.create();
  window.__tom = { asset, buildMs, sk };
  devkit.start({
    scene,
    update(dt, t) {
      buildTomPose(def, sk, poseName, pose);
      if (spin) poseFromEuler(def, {}, null);
      mat4.identity(root);
      if (spin) mat4.rotateY(root, root, t * 0.6);
      sk.update(pose);
      asset.face.update(dt, { blink, mood, lookDir: look.length === 3 ? look : null });
      for (const { a, d, bi } of atts) { mat4.multiply(tmp, sk.world[bi], a.offset); mat4.multiply(d.model, root, tmp); }
      if (racket) {
        mat4.multiply(tmp, sk.world[handR], asset.gripSocket.matrix);
        for (const d of rk) mat4.multiply(d.model, root, tmp);
      }
    },
  });
  return { asset, buildMs };
}

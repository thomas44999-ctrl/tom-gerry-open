// Rig-Testszene: geskinnte Gliederpuppe (SDF -> Surface Nets -> Skin-Gewichte) mit einem Zyklus aus Testposen.
//   dev.html?scene=rig                    Posen-Zyklus (Crossfade über AnimLayer)
//   dev.html?scene=rig&pose=forehand      feste Pose (Namen: siehe RIG_POSES)
//   dev.html?scene=rig&mode=weights&bone=forearm_r   Gewichts-Heatmap eines Knochens; mode=bones: dominanter Knochen
// Außerdem von test/rig-viewer.html (eigenständiger WebGL2-Betrachter) und test/rig.test.mjs genutzt.

import { buildMannequin } from '../../src/chars/mannequin.js';
import { createSkeleton } from '../../src/chars/skeleton.js';
import { createPose, poseFromEuler, limbIK, AnimLayer, lookAt } from '../../src/chars/pose.js';

/** Testposen als Euler-Spezifikationen (Grad, Konvention siehe src/chars/pose.js). ik: Füße auf Ruhe-Position halten. */
export const RIG_POSES = {
  rest: { spec: {} },
  armsForward: { spec: { arm_l: [90, 0, 0], arm_r: [90, 0, 0], forearm_l: [10, 0, 0], forearm_r: [10, 0, 0] } },
  armsUp: { spec: { arm_l: [10, 0, 130], arm_r: [10, 0, 130], forearm_l: [15, 0, 0], forearm_r: [15, 0, 0], spine: [-6, 0, 0], chest: [-6, 0, 0] } },
  tpose: { spec: { arm_l: [0, 0, 45], arm_r: [0, 0, 45] } },
  elbowsKnees: { spec: { arm_l: [40, 0, 0], arm_r: [40, 0, 0], forearm_l: [100, 0, 0], forearm_r: [100, 0, 0], thigh_l: [70, 0, 0], shin_l: [-110, 0, 0], foot_l: [30, 0, 0] } },
  crouch: {
    spec: { spine: [25, 0, 0], chest: [10, 0, 0], neck: [-15, 0, 0], head: [-15, 0, 0], arm_l: [70, 0, -5], arm_r: [70, 0, -5], forearm_l: [40, 0, 0], forearm_r: [40, 0, 0], pelvisOffset: [0, -0.43, -0.12] },
    ik: true,
  },
  twist: { spec: { spine: [0, -12, 0], chest: [0, -18, 0], neck: [0, 10, 0], head: [0, 15, 0], arm_l: [60, 0, 10], arm_r: [-30, 0, 20], forearm_l: [30, 0, 0], forearm_r: [60, 0, 0] } },
  forehand: {
    spec: {
      root: [0, -20, 0], pelvisOffset: [0, -0.1, 0],
      spine: [10, -8, -4], chest: [4, -14, -4], neck: [-6, 12, 0], head: [-8, 14, 4],
      shoulder_r: [0, 0, 6], arm_r: [40, -15, 55], forearm_r: [30, -50, 0], hand_r: [0, 0, 30],
      arm_l: [75, 10, 15], forearm_l: [55, 0, 0],
    },
    ik: true, feet: { l: [0.22, 0, 0.18], r: [-0.28, 0, -0.12] },
  },
  serve: {
    spec: {
      pelvisOffset: [0.04, -0.09, 0.03], spine: [-10, 0, 6], chest: [-12, 15, 4], neck: [-10, -10, 0], head: [-20, -5, 0],
      arm_l: [20, 0, 120], forearm_l: [5, 0, 0], arm_r: [-30, 25, 50], forearm_r: [115, -10, 0], hand_r: [0, 0, 20],
    },
    ik: true, feet: { l: [0.12, 0, 0.12], r: [-0.18, 0, -0.1] },
  },
  run: {
    spec: {
      pelvisOffset: [0, -0.05, 0], spine: [12, 6, 0], chest: [0, 8, 0], head: [-8, -12, 0],
      thigh_l: [45, 0, 0], shin_l: [-30, 0, 0], foot_l: [5, 0, 0], thigh_r: [-25, 0, 0], shin_r: [-90, 0, 0], foot_r: [-25, 0, 0],
      arm_l: [-35, 0, -35], forearm_l: [70, 0, 0], arm_r: [45, 0, -35], forearm_r: [80, 0, 0],
    },
  },
};
export const RIG_POSE_CYCLE = ['rest', 'armsForward', 'armsUp', 'crouch', 'twist', 'forehand', 'serve', 'run', 'elbowsKnees'];

/**
 * Pose `name` in `out` aufbauen (Euler + optionale Fuß-IK: Füße bleiben auf Ruhe-Position bzw. RIG_POSES.feet-Versatz,
 * Fußrotation flach wie in Ruhe).
 */
export function buildRigPose(def, name, out = createPose(def)) {
  const P = RIG_POSES[name] || RIG_POSES.rest;
  poseFromEuler(def, P.spec, out);
  if (P.ik) {
    const sk = buildRigPose._sk && buildRigPose._sk.def === def ? buildRigPose._sk : (buildRigPose._sk = createSkeleton(def));
    for (const s of ['l', 'r']) {
      const f = sk.restPos('foot_' + s), off = (P.feet && P.feet[s]) || [0, 0, 0];
      // Ziel im Modellraum (Wurzelrotation der Pose beachten: Füße sollen in Welt/Modell fest stehen)
      const tgt = [f[0] + off[0], f[1] + off[1], f[2] + off[2]];
      const k = sk.restPos('shin_' + s);
      const pole = [k[0] * 1.8 + off[0], k[1], k[2] + 1 + off[2]];
      limbIK(def, out, 'leg_' + s, tgt, pole, { endRot: [0, 0, 0, 1] });
    }
  }
  return out;
}

/** Clip, der die Testposen nacheinander anfährt (je `hold` s halten, `move` s Übergang). Testet das Clip-System. */
export function buildPoseCycleClip(def, names = RIG_POSE_CYCLE, hold = 0.6, move = 0.7) {
  const keys = []; let t = 0;
  for (const n of names) {
    const p = buildRigPose(def, n);
    keys.push({ t, pose: p, ease: 'inOutCubic' }); t += hold;
    keys.push({ t, pose: p, ease: 'linear' }); t += move;
  }
  keys.push({ t, pose: buildRigPose(def, names[0]), ease: 'inOutCubic' });
  return { name: 'rig_cycle', duration: t, loop: true, interp: 'linear', keys, events: [] };
}

/** Puppe + Skelett bauen (Mesh-Daten, CPU). */
export function buildRigModel(o = {}) {
  const m = buildMannequin({ cell: o.cell || 0.008 });
  return { ...m, skeleton: createSkeleton(m.skeletonDef) };
}

// ---------------------------------------------------------------------------- Dev-Szene (devkit der Engine)

export async function run(ctx) {
  const { renderer: r, params, devkit } = ctx;
  const { skeletonDef: def, mesh, skeleton: sk } = buildRigModel({ cell: params.num('cell', 0.008) });
  const mode = params.get('mode', 'shaded');
  const boneSel = def.index[params.get('bone', 'forearm_r')] ?? 0;
  const mat = r.createMaterial({
    name: 'rig-mannequin',
    uniforms: { u_mode: mode === 'weights' ? 1 : mode === 'bones' ? 2 : 0, u_bone: boneSel },
    surface: `
      void surface(in SurfaceInput i, inout Surface s) {
        s.albedo = i.color.rgb;
        s.ao = mix(1.0, i.data.y, 0.85);
        int m = int(i.data.x + 0.5);
        s.roughness = m == 0 ? 0.55 : m == 3 ? 0.4 : m == 5 ? 0.7 : 0.8;
        if (m == 0) { s.subsurface = 0.35; }
        if (m == 1 || m == 2) { s.sheen = 0.25; }
      }`,
  });
  const drawable = { mesh: r.createMesh(mesh), material: mat, bones: sk.skin, castShadow: true };
  const pose = createPose(def);
  const fixed = params.get('pose', null);
  const layer = new AnimLayer(def);
  const clip = buildPoseCycleClip(def);
  layer.play(clip, { fade: 0 });
  const look = params.get('look', null);
  devkit.setOrbit({ target: [0, 0.95, 0], dist: 4.2, yaw: 30, pitch: 8 });
  devkit.start({
    scene: { drawables: [drawable] },
    update(dt, t) {
      if (fixed) buildRigPose(def, fixed, pose);
      else { layer.update(dt); pose.rot.set(layer.pose.rot); pose.t.set(layer.pose.t); }
      if (look) lookAt(def, pose, [Math.sin(t) * 2, 1.6, 2]);
      sk.update(pose);
    },
  });
  return { mesh, def, skeleton: sk, stats: mesh.stats };
}

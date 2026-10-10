// Gerry-Testszene: dev.html?scene=gerry
//   &view=full|face|broadcast|back|side|paw|feet|tail   Kamera-Voreinstellungen (cam=… überschreibt)
//   &pose=rest|ready|forehand|backhand|armsup|happy|cycle   (cycle = Posen-Zyklus, Standard)
//   &blink=0..1  &mood=neutral|happy|focused|sad  &look=x,y,z (Kopfraum)  &racket=0  &debug=1 (Fell-Länge)
//   &quality=low|medium|high (dev.html)  &yaw=Grad (Figur drehen)  &shells=N (Override)  &sun=front|back
//   &fur=0 (Schalen aus)  &lod=0 (kein Fell-LOD)  &debug=1 (Felllänge) | 2 (Liner/AO)
import { buildGerry, GERRY_HEIGHT as GERRY_H } from '../../src/chars/gerry.js';
import { createSkeleton } from '../../src/chars/skeleton.js';
import { createPose, poseFromEuler, limbIK, blendPose, getBoneModel } from '../../src/chars/pose.js';
import { mat4, quat } from '../../src/core/math.js';
import { cylinder, torus, merge, transform, setColor } from '../../src/gfx/geometry.js';

export const GERRY_POSES = {
  rest: { spec: {} },
  ready: {
    spec: {
      pelvisOffset: [0, -0.09, -0.02], spine: [22, 0, 0], chest: [6, 0, 0], neck: [-12, 0, 0], head: [-14, 0, 0],
      arm_l: [62, 0, -8], forearm_l: [75, -20, 0], arm_r: [42, 30, -22], forearm_r: [72, -25, 0], hand_r: [-38, 0, 8],
      tail_0: [15, 0, 0], tail_1: [10, 0, 0], tail_3: [12, 0, 0], tail_4: [18, 0, 0], tail_5: [20, 0, 0], ear_l: [8, 0, 0], ear_r: [8, 0, 0],
    },
    ik: true, feet: { l: [0.07, 0, 0.02], r: [-0.07, 0, 0.02] },
    twoHanded: 0.2,   // linke Hand stützt am Herz/Schaft
  },
  forehand: {
    spec: {
      root: [0, -25, 0], pelvisOffset: [0, -0.08, 0], spine: [8, -10, 0], chest: [0, -15, 0], neck: [-5, 12, 0], head: [-8, 14, 0],
      arm_r: [55, -20, 40], forearm_r: [25, -40, 0], hand_r: [0, 0, 25], arm_l: [70, 10, 20], forearm_l: [60, 0, 0],
      tail_0: [25, 25, 0], tail_1: [10, 10, 0], tail_2: [-5, 10, 0], tail_4: [15, 0, 0], tail_5: [25, 0, 0], ear_l: [-12, 0, 6], ear_r: [-12, 0, 6],
    },
    ik: true, feet: { l: [0.2, 0, 0.16], r: [-0.26, 0, -0.1] },
  },
  backhand: {
    spec: {
      root: [0, 35, 0], pelvisOffset: [0, -0.08, 0], spine: [10, 12, 0], chest: [4, 20, 0], neck: [-6, -15, 0], head: [-10, -18, 0],
      arm_r: [60, 25, -5], forearm_r: [40, 10, 0], arm_l: [70, -15, -15], forearm_l: [80, 0, 0],
      tail_0: [20, -25, 0], tail_2: [10, -10, 0], tail_5: [25, 0, 0],
    },
    ik: true, feet: { l: [0.24, 0, -0.1], r: [-0.2, 0, 0.16] },
    twoHanded: 0.1,   // linke Faust 10 cm über der rechten am Griff (beidhändige Rückhand, IK über leftHandGrip)
  },
  armsup: {
    spec: {
      arm_l: [10, 0, 130], arm_r: [10, 0, 130], forearm_l: [15, 0, 0], forearm_r: [15, 0, 0], spine: [-6, 0, 0], chest: [-6, 0, 0],
      head: [-10, 0, 0], tail_0: [40, 0, 0], tail_1: [10, 0, 0], tail_2: [-10, 0, 0], ear_l: [0, 0, 15], ear_r: [0, 0, 15],
    },
  },
  happy: {
    spec: {
      chest: [-4, 0, 0], head: [-6, 0, 6], arm_l: [0, 0, -15], arm_r: [20, 0, -5], forearm_r: [40, 0, 0],
      tail_0: [72, 0, 0], tail_1: [28, 0, 0], tail_2: [12, 0, 0], tail_3: [-20, 0, 0], tail_4: [-40, 0, 0], tail_5: [-50, 0, 0],
      ear_l: [10, 0, -8], ear_r: [10, 0, -8],
    },
    mood: 'happy',
  },
};
const CYCLE = ['rest', 'ready', 'forehand', 'happy', 'backhand', 'armsup'];

const VIEWS = {
  full: { dist: 3.1, yaw: 24, pitch: 6, target: [0, 0.84, 0] },
  face: { dist: 0.72, yaw: 14, pitch: 3, target: [0, 1.4, 0.03] },
  broadcast: { dist: 19.3, yaw: 8, pitch: 21, target: [0, 0.8, 0] },
  back: { dist: 3.1, yaw: 160, pitch: 10, target: [0, 0.82, 0] },
  side: { dist: 3.0, yaw: 90, pitch: 4, target: [0, 0.84, 0] },
  paw: { dist: 0.75, yaw: 40, pitch: 8, target: [-0.45, 0.82, 0.05] },
  feet: { dist: 0.9, yaw: 25, pitch: 14, target: [0, 0.1, 0.05] },
  tail: { dist: 1.4, yaw: 130, pitch: 8, target: [0, 0.62, -0.35] },
  mid: { dist: 6.5, yaw: 20, pitch: 10, target: [0, 0.82, 0] },
};

function buildPose(def, sk, name, out, asset) {
  const P = GERRY_POSES[name] || GERRY_POSES.rest;
  poseFromEuler(def, P.spec, out);
  if (P.ik) {
    for (const s of ['l', 'r']) {
      const f = sk.restPos('foot_' + s), off = (P.feet && P.feet[s]) || [0, 0, 0];
      const tgt = [f[0] + off[0], f[1] + off[1], f[2] + off[2]];
      const k = sk.restPos('shin_' + s);
      limbIK(def, out, 'leg_' + s, tgt, [k[0] * 1.8 + off[0], k[1], k[2] + 1 + off[2]], { endRot: [0, 0, 0, 1] });
    }
  }
  if (P.twoHanded && asset && asset.leftHandGrip) {
    // Schlägerrahmen aus der rechten Hand, linke Hand per IK auf den Griff darüber (Konvention wie character.js)
    const rq = quat.create(), rp = new Float32Array(3);
    getBoneModel(def, out, asset.gripSocket.bone, rq, rp);
    const Rk = mat4.multiply(mat4.create(), mat4.fromRotationTranslation(mat4.create(), rq, rp), asset.gripSocket.matrix);
    mat4.translate(Rk, Rk, [0, P.twoHanded, 0]);
    const Ml = mat4.multiply(mat4.create(), Rk, mat4.invert(mat4.create(), asset.leftHandGrip.matrix));
    const pos = [Ml[12], Ml[13], Ml[14]];
    limbIK(def, out, 'arm_l', pos, [pos[0] + 0.3, pos[1] - 0.45, pos[2] - 0.05], { endRot: mat4.getRotation(quat.create(), Ml) });
  }
  return out;
}

async function loadRacket(r, style) {
  try {
    const mod = await import('../../src/chars/racket.js');
    if (mod && mod.buildRacket) return mod.buildRacket(r, style);
  } catch (e) { /* Platzhalter */ }
  // Platzhalter-Schläger (schwarz/orange): Griff, Schaft, Kopf
  const mat = r.createMaterial({ name: 'gerry-racket-ph', surface: `void surface(in SurfaceInput i, inout Surface s){ s.albedo = i.color.rgb; s.roughness = 0.35; }` });
  const grip = setColor(transform(cylinder(0.0135, 0.0135, 0.2, 12), mat4.fromTranslation(mat4.create(), [0, 0.0, 0])), [...style.grip, 1]);
  const shaft = setColor(transform(cylinder(0.01, 0.012, 0.2, 10), mat4.fromTranslation(mat4.create(), [0, 0.19, 0])), [...style.frame, 1]);
  const m = mat4.create(); mat4.translate(m, m, [0, 0.43, 0]); mat4.scale(m, m, [0.125, 0.145, 1]);
  const head = setColor(transform(torus(1, 0.075, 8, 40, Math.PI * 2, 'z'), m), [...style.accent, 1]);
  return { parts: [{ mesh: r.createMesh(merge([grip, shaft, head])), material: mat }], sweetSpot: [0, 0.5, 0] };
}

export async function run(ctx) {
  const { renderer: r, params, devkit } = ctx;
  const q = { ...r.q };
  if (params.has('shells')) q.furShells = params.num('shells', 20);
  const t0 = performance.now();
  const asset = buildGerry(r, q, { debug: params.num('debug', 0) });
  const buildMs = performance.now() - t0;
  const def = asset.skeletonDef;
  const sk = createSkeleton(def);
  const scene = devkit.defaultScene();
  // &sun=front: Sonne von vorn-oben-links (Kamera-Seite) für Farb-/Formbeurteilung; &sun=back: Gegenlicht (Standard devkit)
  if (params.get('sun', 'front') === 'front') { const d = [0.45, 0.62, 0.64], l = Math.hypot(...d); scene.sun.dir = d.map((x) => x / l); }
  const charModel = mat4.create();
  const yawDeg = params.num('yaw', 0);
  mat4.fromYawTranslation ? mat4.fromYawTranslation(charModel, yawDeg * Math.PI / 180, [0, 0, 0]) : mat4.rotateY(charModel, charModel, yawDeg * Math.PI / 180);

  const drawables = [];
  const showFur = params.get('fur', '1') !== '0';
  for (const p of asset.parts) {
    drawables.push({ mesh: p.mesh, material: p.material, bones: sk.skin, model: charModel, shells: p.shells || 0, castShadow: p.castShadow !== false, visible: showFur || !p.shells });
  }
  const att = asset.attachments.map((a) => {
    const d = { mesh: a.mesh, material: a.material, model: mat4.create(), castShadow: a.castShadow !== false };
    drawables.push(d);
    return { a, d, bi: def.index[a.bone] };
  });
  // Schläger
  let racket = null;
  if (params.get('racket', '1') !== '0') {
    const rk = await loadRacket(r, asset.racketStyle);
    const g = asset.gripSocket;
    // Schläger-Weltmatrix = charModel * skel.world[hand_r] * gripSocket.matrix
    racket = { local: g.matrix, bi: def.index[g.bone], ds: rk.parts.map((p) => { const d = { mesh: p.mesh, material: p.material, model: mat4.create(), castShadow: true }; drawables.push(d); return d; }) };
  }
  scene.drawables.push(...drawables);

  const view = VIEWS[params.get('view', 'full')] || VIEWS.full;
  devkit.setOrbit(view);
  const poseName = params.get('pose', 'cycle');
  const pose = createPose(def), pa = createPose(def), pb = createPose(def);
  const poses = Object.fromEntries(Object.keys(GERRY_POSES).map((n) => [n, buildPose(def, sk, n, createPose(def), asset)]));
  const blink = params.num('blink', -1);
  const moodP = params.get('mood', null);
  const look = params.has('look') ? params.list('look', [0, 0, 1]).map(Number) : null;
  const tmp = mat4.create();
  const info = document.createElement('div');
  info.style.cssText = 'position:fixed;left:8px;bottom:8px;font:12px/1.35 monospace;color:#fff;background:rgba(0,0,0,.45);padding:4px 8px;border-radius:4px;white-space:pre;pointer-events:none';
  document.body.appendChild(info);
  const st = asset.stats;
  info.textContent = `Gerry  build ${buildMs.toFixed(0)} ms (cpu ${st.buildMs.toFixed(0)})  tris ${(st.totalTris / 1000).toFixed(0)}k  ` +
    `body ${(st.bodyTris / 1000).toFixed(1)}k  fur ${(st.furLongTris / 1000).toFixed(1)}k×${st.shellsLong} + ${(st.furShortTris / 1000).toFixed(1)}k×${st.shellsShort}`;
  const lod = params.get('lod', '1') !== '0';
  const partDs = drawables.slice(0, asset.parts.length);
  devkit.start({
    scene,
    update(dt, t) {
      if (lod && devkit.camera) {
        // Bildschirmhöhe der Figur (px) -> Fell-LOD
        const c = devkit.camera.position, dist = Math.hypot(c[0], c[1] - 0.8, c[2]);
        const px = r.gl.drawingBufferHeight * GERRY_H / (2 * dist * Math.tan((devkit.camera.fov || 0.75) / 2));
        asset.applyFurLod(partDs, px);
      }
      let mood = moodP;
      if (poseName === 'cycle') {
        const seg = 2.2, i = Math.floor(t / seg) % CYCLE.length, f = (t / seg) % 1;
        const a = CYCLE[i], b = CYCLE[(i + 1) % CYCLE.length];
        const k = f < 0.55 ? 0 : (f - 0.55) / 0.45;
        const e = k * k * (3 - 2 * k);
        blendPose(pose, poses[a], poses[b], e);
        if (!mood) mood = (e < 0.5 ? GERRY_POSES[a] : GERRY_POSES[b]).mood || 'neutral';
      } else {
        pose.rot.set((poses[poseName] || poses.rest).rot); pose.t.set((poses[poseName] || poses.rest).t);
        if (!mood) mood = (GERRY_POSES[poseName] || {}).mood || 'neutral';
      }
      sk.update(pose);
      // Blinzeln: Parameter oder automatisch alle ~3.5 s
      // Blinzeln: Parameter oder automatisch (face.update mit blink undefined)
      asset.face.update(dt, { blink: blink < 0 ? undefined : blink, mood, lookDir: look });
      for (const { a, d, bi } of att) {
        mat4.multiply(tmp, charModel, sk.world[bi]);
        mat4.multiply(d.model, tmp, a.offset);
      }
      if (racket) {
        mat4.multiply(tmp, charModel, sk.world[racket.bi]);
        mat4.multiply(tmp, tmp, racket.local);
        for (const d of racket.ds) mat4.copy(d.model, tmp);
      }
    },
  });
  window.__gerry = { asset, sk, buildMs, r };
  return { asset, buildMs };
}

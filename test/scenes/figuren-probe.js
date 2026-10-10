// Figuren-Probe: direkter Vergleich möglicher Figurenstile im Open-Stadion (keine Integration ins Spiel).
//   dev.html?scene=figuren-probe&v=a|b|c&pose=bereit|laufen|aus|treffer|jubel|enttaeuscht&cam=spiel|nah&licht=stadion|weich
//   &anim=1 (Animation läuft statt gehaltener Pose)  &t=<s> (Zeit einfrieren)
//   A = Pixelfiguren aus Tom & Gerry Flutlicht als Billboards (src/chars/probe-pixel.js)
//   B = einfache 3D-Spielzeugfiguren aus Code (src/chars/probe-toy.js)
//   C = Referenz: heutige Chibi-Figuren (src/chars/tom.js, gerry.js, character.js)
// Tasten: 1/2/3 Variante, P Pose weiter, K Kamera, L Licht, Leertaste Animation an/aus.
// window.__probe.set({ v, pose, cam, licht, anim }) schaltet um (für Aufnahmen); __probe.buildMs = Ladezeiten.
import { vec3, DEG } from '../../src/core/math.js';
import { buildWorld } from '../../src/world/world.js';
import { BroadcastCamera } from '../../src/game/camera.js';

export const POSES = ['bereit', 'laufen', 'aus', 'treffer', 'jubel', 'enttaeuscht'];
export const POSE_LABEL = {
  bereit: 'bereit', laufen: 'laufen', aus: 'Vorhand: Ausholen', treffer: 'Vorhand: Treffer', jubel: 'Jubel', enttaeuscht: 'enttäuscht',
};
const VARIANT_LABEL = { a: 'A · Pixel-Billboards (Flutlicht)', b: 'B · 3D-Spielzeugfiguren', c: 'C · heute (Chibi mit Fell)' };

// Aufstellung: Spielkamera = beide an der Grundlinie; Nahaufnahme = nebeneinander vor der Kamera
const SPOTS = {
  spiel: { tom: { pos: [0.6, 0, 11.4], yaw: Math.PI }, gerry: { pos: [-0.6, 0, -11.4], yaw: 0 } },
  nah: { tom: { pos: [-0.72, 0, 7.4], yaw: 0.32 }, gerry: { pos: [0.72, 0, 7.4], yaw: -0.32 } },
};
const RUN_SPEED = 4.2;

// ---------------------------------------------------------------- Licht
function softLight(base) {
  // Mittagslicht wie in Mario Tennis: Sonne höher und weißer, viel Himmelslicht, weichere Schatten, bunter
  const d = base.sun.dir, el = 56 * DEG, az = Math.atan2(d[0], d[2]);
  return {
    sun: { dir: [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)], color: [1.0, 0.95, 0.88], intensity: base.sun.intensity * 0.74 },
    hemi: { sky: [0.55, 0.7, 1.0], ground: [0.3, 0.36, 0.2], intensity: base.hemi.intensity * 2.0 },
    shadow: { strength: 0.72 },
    exposure: (base.exposure ?? 1) * 1.14,
    post: { ...base.post, saturation: 1.3, contrast: 0.97, bloom: 0.6, vignette: 0.1, temperature: 0.0, lift: [0.012, 0.012, 0.02] },
  };
}

// ---------------------------------------------------------------- Variante C: Steuerung der heutigen Figuren
/** Figur deterministisch in die Pose simulieren (60 Hz ab Ruhe). */
function driveC(c, spot, pose) {
  const dt = 1 / 60;
  c.position.set(spot.pos); c.yaw = spot.yaw;
  c.stopAction();
  c.setLocomotion([0, 0, 0], 1);
  c.reset();
  const step = (n, vel) => {
    for (let i = 0; i < n; i++) {
      if (vel) { c.position[0] += vel[0] * dt; c.position[2] += vel[2] * dt; }
      c.setLocomotion(vel || [0, 0, 0], 1);
      c.update(dt);
    }
  };
  if (pose === 'laufen') {
    const v = [Math.sin(spot.runYaw) * RUN_SPEED, 0, Math.cos(spot.runYaw) * RUN_SPEED];
    c.yaw = spot.runYaw;
    c.position[0] -= v[0] * 1.0; c.position[2] -= v[2] * 1.0;
    c.reset();
    step(60, v);
    return;
  }
  step(45);
  if (pose === 'aus' || pose === 'treffer') {
    c.playStroke('forehand', { timeToContact: 0.5, shot: 'topspin', power: 0.8 });
    step(pose === 'aus' ? 17 : 30);
    return;
  }
  if (pose === 'jubel') { c.playEmote('celebrate'); step(36); return; }
  if (pose === 'enttaeuscht') { c.playEmote('dejected'); step(66); return; }
  step(30);
}

// ---------------------------------------------------------------- Szene
export async function run({ renderer: r, devkit, params }) {
  const state = {
    v: params.get('v', 'a'), pose: params.get('pose', 'bereit'), cam: params.get('cam', 'spiel'),
    licht: params.get('licht', 'stadion'), anim: params.bool('anim', false),
  };
  const buildMs = {};
  let t0 = performance.now();
  const world = await buildWorld(r, { onProgress: () => {} });
  buildMs.world = performance.now() - t0;
  const scene = { drawables: [], time: 0 };
  world.applyTo(scene);
  const baseLight = { sun: { ...scene.sun }, hemi: { ...scene.hemi }, exposure: scene.exposure, post: { ...scene.post } };
  const soft = softLight(baseLight);

  const figs = {};       // v -> { tom, gerry, drawables(), pose(p, cam), update(dt, cam) }
  async function ensure(v) {
    if (figs[v]) return figs[v];
    t0 = performance.now();
    if (v === 'a') {
      const { loadPixelSheets, PixelFigure } = await import('../../src/chars/probe-pixel.js');
      const sheets = await loadPixelSheets(r);
      const tom = new PixelFigure(r, sheets.tom, 'tom'), gerry = new PixelFigure(r, sheets.gerry, 'gerry');
      const FRAME = { bereit: ['bereit', 0], laufen: ['laufen', 1], aus: ['vorhand', 0], treffer: ['vorhand', 2], jubel: ['jubel', 1], enttaeuscht: ['enttaeuscht', 0] };
      const ANIM = { bereit: 'bereit', laufen: 'laufen', aus: 'vorhand', treffer: 'vorhand', jubel: 'jubel', enttaeuscht: 'enttaeuscht' };
      figs.a = {
        list: [tom, gerry],
        drawables: () => [...tom.drawables, ...gerry.drawables],
        pose(p, cam, anim) {
          for (const f of [tom, gerry]) {
            f.position.set(SPOTS[cam][f.id].pos);
            if (anim) f.play(ANIM[p]); else f.setPose(...FRAME[p]);
          }
        },
        update(dt, camera) { tom.update(dt, camera); gerry.update(dt, camera); },
      };
    } else if (v === 'b') {
      const { buildToyFigure } = await import('../../src/chars/probe-toy.js');
      const tom = buildToyFigure(r, 'tom'), gerry = buildToyFigure(r, 'gerry');
      figs.b = {
        list: [tom, gerry],
        drawables: () => [...tom.drawables, ...gerry.drawables],
        pose(p, cam, anim) {
          for (const f of [tom, gerry]) {
            const s = SPOTS[cam][f.id];
            f.position.set(s.pos); f.yaw = p === 'laufen' ? runYaw(cam, f.id) : s.yaw;
            if (anim) f.play(p); else f.setPose(p);
          }
        },
        update(dt) { tom.update(dt); gerry.update(dt); },
      };
    } else {
      const [{ buildTom }, { buildGerry }, { buildRacket }, { Character }] = await Promise.all([
        import('../../src/chars/tom.js'), import('../../src/chars/gerry.js'), import('../../src/chars/racket.js'), import('../../src/chars/character.js'),
      ]);
      const ta = performance.now(); const tomAsset = buildTom(r, r.q); buildMs.cTom = performance.now() - ta;
      const tg = performance.now(); const gerryAsset = buildGerry(r, r.q); buildMs.cGerry = performance.now() - tg;
      const tom = new Character(r, tomAsset, buildRacket(r, tomAsset.racketStyle));
      const gerry = new Character(r, gerryAsset, buildRacket(r, gerryAsset.racketStyle));
      tom.update(0); gerry.update(0);
      figs.c = {
        list: [tom, gerry],
        drawables: () => [...tom.drawables, ...gerry.drawables],
        pose(p, cam) {
          for (const f of [tom, gerry]) driveC(f, { ...SPOTS[cam][f.id], runYaw: runYaw(cam, f.id) }, p);
        },
        update(dt) { if (dt > 0) { tom.update(dt); gerry.update(dt); } },
      };
    }
    buildMs[v] = performance.now() - t0;
    return figs[v];
  }
  // Laufrichtung: in der Spielkamera seitlich nach rechts (aus Sicht der Kamera), in der Nahaufnahme ebenso
  function runYaw(cam, id) { return Math.PI / 2 * (cam === 'spiel' && id === 'gerry' ? 1 : 1); }

  // ---------------------------------------------------------------- Kameras
  const broadcast = new BroadcastCamera({ side: 1 });
  function cameraFor(cam) {
    const C = devkit.camera;
    if (cam === 'spiel') {
      const tp = SPOTS.spiel.tom.pos, gp = SPOTS.spiel.gerry.pos;
      broadcast.cut();
      const pose = broadcast.update(0.016, {
        phase: 'rally', ball: { pos: [0, 1, 0], vel: [0, 0, 0], visible: false },
        players: [{ id: 'tom', pos: tp, vel: [0, 0, 0], side: 1 }, { id: 'gerry', pos: gp, vel: [0, 0, 0], side: -1 }], humanIndex: 0,
      });
      vec3.copy(C.position, pose.pos); vec3.copy(C.target, pose.tgt); C.fov = pose.fov;
    } else {
      vec3.set(C.position, 0, 1.15, 12.9); vec3.set(C.target, 0, 0.74, 7.4); C.fov = 27 * DEG;
    }
    devkit.orbit.enabled = false;
  }

  // ---------------------------------------------------------------- Beschriftung
  const label = document.createElement('div');
  label.style.cssText = 'position:fixed;right:10px;top:10px;font:600 15px/1.35 system-ui,sans-serif;color:#fff;background:rgba(10,14,18,.62);padding:6px 10px;border-radius:7px;pointer-events:none;white-space:pre;text-align:right';
  document.body.appendChild(label);

  let active = null;
  async function set(o = {}) {
    Object.assign(state, o);
    const F = await ensure(state.v);
    active = F;
    scene.drawables = [...world.drawables, ...F.drawables()];
    const L = state.licht === 'weich' ? soft : baseLight;
    scene.sun = { ...scene.sun, ...L.sun }; scene.hemi = { ...scene.hemi, ...L.hemi };
    scene.exposure = L.exposure; scene.post = L.post;
    scene.shadow = { ...scene.shadow, strength: L.shadow ? L.shadow.strength : 1 };
    cameraFor(state.cam);
    F.pose(state.pose, state.cam, state.anim);
    F.update(0, devkit.camera);
    label.textContent = `${VARIANT_LABEL[state.v]}\n${POSE_LABEL[state.pose]} · ${state.cam === 'spiel' ? 'Spielkamera' : 'Nahaufnahme'}${state.licht === 'weich' ? ' · weiches Licht' : ''}`;
    probe.frame = devkit.frame;
    return true;
  }
  const probe = window.__probe = { set, buildMs, state, frame: 0, ready: false };
  await set({});

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === '1' || k === '2' || k === '3') set({ v: 'abc'[+k - 1] });
    else if (k === 'p') set({ pose: POSES[(POSES.indexOf(state.pose) + 1) % POSES.length] });
    else if (k === 'k') set({ cam: state.cam === 'spiel' ? 'nah' : 'spiel' });
    else if (k === 'l') set({ licht: state.licht === 'weich' ? 'stadion' : 'weich' });
    else if (k === ' ') set({ anim: !state.anim });
  });

  devkit.start({
    scene,
    update(dt, t) {
      world.update(dt, { time: t, ballPos: [0, -5, 0], events: [], excitement: 0.2, camera: devkit.camera });
      if (active) active.update(state.anim ? dt : 0, devkit.camera);
      probe.ready = true;
    },
  });
}

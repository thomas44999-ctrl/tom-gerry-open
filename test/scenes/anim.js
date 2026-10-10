// Animations-Testszene (ANIM): Figur + Schläger + Character-Laufzeit.
//   dev.html?scene=anim&char=tom|gerry|mannequin
//     &clip=forehand|backhand|forehand_slice|backhand_slice|forehand_volley|backhand_volley|smash|serve|split|ready|idle
//           |fistpump|celebrate|jump|dejected|shrug|wave|clap|bow|catch_ball|gallery (alle nacheinander)
//     &loco=run|shuffle|circle|walk|back|zigzag|turn (Bewegungsmuster über setLocomotion)  &face=net|move
//     &contact=1 (Ball genau am Treffpunkt zum Treffzeitpunkt + Sweet-Spot-Marker)  &up=,&side=,&fwd= (Treffpunkt-Versatz, m)
//     &shot=topspin|slice|lob|drop|flat  &speed=0.25  &t=<s> (Zeit einfrieren; deterministisch simuliert)
//     &strip=t0,t1,… (mehrere Figuren nebeneinander zu verschiedenen Zeiten; mit &t: Versatz)  &view=front|side|back|top|broadcast|right
//     &ready=0..1  &marks=1 (Füße/Sweet-Spot-Marker)
import { Character } from '../../src/chars/character.js';
import { buildRacket, RACKET_STYLES } from '../../src/chars/racket.js';
import { STROKES, SERVE } from '../../src/sim/strokes.js';
import { sphere } from '../../src/gfx/geometry.js';
import { mat4, DEG } from '../../src/core/math.js';

export const STROKE_LIST = ['forehand', 'backhand', 'forehand_slice', 'backhand_slice', 'forehand_volley', 'backhand_volley', 'smash'];
export const EMOTE_LIST = ['fistpump', 'celebrate', 'jump', 'dejected', 'shrug', 'wave', 'clap', 'bow', 'catch_ball'];
const GALLERY = [...STROKE_LIST, 'serve', 'split', ...EMOTE_LIST];

/** Asset für id bauen (mannequin: Adapter auf CharacterAsset). */
export async function buildAsset(r, id) {
  if (id === 'gerry') return (await import('../../src/chars/gerry.js')).buildGerry(r, r.q);
  if (id === 'mannequin') {
    const { buildMannequin } = await import('../../src/chars/mannequin.js');
    const m = buildMannequin({ cell: 0.01 });
    const mat = r.createMaterial({ name: 'anim-mannequin', surface: 'void surface(in SurfaceInput i, inout Surface s){ s.albedo = i.color.rgb; s.ao = mix(1.0, i.data.y, 0.8); s.roughness = 0.6; }' });
    const rot = [0.5197, 0.3525, 0.2484, 0.7375], off = [-0.0292, -0.0746, 0.0266];
    return {
      id: 'mannequin', name: 'Puppe', skeletonDef: m.skeletonDef,
      parts: [{ mesh: r.createMesh(m.mesh), material: mat, skinned: true }], attachments: [],
      gripSocket: { bone: 'hand_r', offset: off, rotation: rot, matrix: mat4.fromRotationTranslation(mat4.create(), rot, off) },
      leftHandGrip: { bone: 'hand_l', offset: [-off[0], off[1], off[2]] },
      racketStyle: RACKET_STYLES.tom, heightM: 1.8,
    };
  }
  return (await import('../../src/chars/tom.js')).buildTom(r, r.q);
}

const VIEWS = {
  front: { dist: 4.2, yaw: -30, pitch: 8, ty: 1.0 },
  right: { dist: 4.2, yaw: -90, pitch: 6, ty: 1.0 },
  side: { dist: 4.2, yaw: 90, pitch: 6, ty: 1.0 },
  back: { dist: 4.2, yaw: 160, pitch: 10, ty: 1.0 },
  top: { dist: 6, yaw: -20, pitch: 70, ty: 0.4 },
  broadcast: { dist: Math.hypot(19, 8), yaw: 180, pitch: 22, ty: 0.9, fov: 26 },
};

/**
 * Treiber: setzt Position/Gier/Befehle einer Figur abhängig von der Szenenzeit (deterministisch).
 * st = Zustandsobjekt je Figur.
 */
export function makeDriver(opts) {
  const { clip, loco, face, shot, ready, off } = opts;
  const ball = opts.ball;
  return function drive(c, st, t, dt) {
    if (loco) return driveLoco(c, st, t, dt, loco, face, ready);
    let name = clip;
    let tl = t;
    if (clip === 'gallery') {
      // jede Nummer 3.2 s (Aufschlag 4.2 s)
      let acc = 0, k = 0;
      for (;;) { const d = GALLERY[k % GALLERY.length] === 'serve' ? 4.4 : 3.0; if (t < acc + d) break; acc += d; k++; }
      name = GALLERY[k % GALLERY.length]; tl = t - acc;
      if (st.gk !== k) { st.gk = k; st.cmd = 0; }
    }
    c.position[0] = st.x0; c.position[2] = st.z0; c.yaw = 0;
    c.setLocomotion([0, 0, 0], ready);
    if (STROKES[name] && name !== 'serve') return driveStroke(c, st, tl, name, shot, off, ball);
    if (name === 'serve') return driveServe(c, st, tl, ball);
    if (name === 'split') { const P = 1.6; const k = Math.floor(tl / P); if (st.sk !== k && tl - k * P > 0.4) { st.sk = k; c.splitStep(0.12); } return; }
    if (name === 'ready' || name === 'idle') return;
    // Emote
    const P = 3.0, k = Math.floor(tl / P);
    if (st.ek !== k && tl - k * P > 0.3) { st.ek = k; c.playEmote(name); }
  };
}

function driveStroke(c, st, tl, name, shot, off, ball) {
  const S = STROKES[name];
  const P = 0.5 + S.windup + S.follow + 0.6;
  const k = Math.floor(tl / P), u = tl - k * P;
  const sc = c.scale;
  const ct = st.contact || (st.contact = new Float32Array(3));
  ct[0] = st.x0 - (S.contact.right * sc + off[0]); ct[1] = S.contact.up * sc + off[1]; ct[2] = st.z0 + S.contact.forward * sc + off[2];
  if (st.k !== k && u >= 0.5) { st.k = k; c.playStroke(name, { timeToContact: S.windup, contactWorld: ct, shot, power: 0.7 }); st.tContact = k * P + 0.5 + S.windup; }
  if (ball) {
    // Ball fliegt vom Netz (+Z) heran und nach dem Treffer zurück
    const tc = k * P + 0.5 + S.windup, d = tl - tc;
    const v = 16;
    ball[0] = ct[0] + (d < 0 ? 0.6 * d : 0.3 * d); ball[1] = ct[1] + (d < 0 ? -1.2 * d * d : 3 * d - 4.9 * d * d); ball[2] = ct[2] - d * v * (d < 0 ? 1 : -1);
    ball[3] = Math.abs(d) < 0.9 ? 1 : 0;
  }
}

function driveServe(c, st, tl, ball) {
  const P = 4.4;
  const k = Math.floor(tl / P), u = tl - k * P;
  if (st.svk !== k) { st.svk = k; st.ph = 0; }
  const tToss = 1.45;
  const tIdeal = idealServe(c);
  if (st.ph === 0 && u >= 0.0) { st.ph = 1; c.playServe('bounce', { period: 0.62 }); }
  if (st.ph === 1 && u >= tToss) { st.ph = 2; c.playServe('toss'); }
  if (st.ph === 2 && u >= tToss + tIdeal - STROKES.serve.windup) {
    st.ph = 3;
    const ct = st.contact || (st.contact = new Float32Array(3));
    c.heldBallPos(ct);
    // Ball zum Trefferzeitpunkt (Spiellogik: senkrechter Flug ab Wurfpunkt)
    const sv = c.serve, t2 = tIdeal - SERVE.tossRelease;
    ct[0] = sv.spot[0]; ct[2] = sv.spot[2]; ct[1] = sv.release + sv.v0 * t2 - 0.5 * 9.81 * t2 * t2;
    c.playServe('swing', { timeToContact: STROKES.serve.windup, contactWorld: ct, shot: 'serve_flat', power: 0.8 });
    st.tc = tl + STROKES.serve.windup;
  }
  if (ball) {
    if (st.ph === 3 && tl >= st.tc) {
      const d = tl - st.tc;
      ball[0] = st.contact[0] + 1.2 * d; ball[1] = st.contact[1] - 2.0 * d - 4.9 * d * d; ball[2] = st.contact[2] + 40 * d; ball[3] = d < 0.6 ? 1 : 0;
    } else { c.heldBallPos(ball); ball[3] = 1; }
  }
}

/** Zeit vom Wurf bis zum idealen Treffer (wie match.js). */
export function idealServe(c) {
  const k = c.scale, hc = STROKES.serve.contact.up * k, rel = SERVE.releaseUp * k;
  const v0 = Math.sqrt(2 * 9.81 * Math.max(0.2, hc + SERVE.tossApexAbove * k - rel));
  return SERVE.tossRelease + v0 / 9.81 + Math.sqrt(2 * SERVE.tossApexAbove * k / 9.81);
}

function locoPath(mode, t, out) {
  // out: [x, z]
  switch (mode) {
    case 'run': {   // seitlich: beschleunigen, sprinten, abbremsen, Pause, zurück
      const P = 5.2, u = ((t % (2 * P)) + 2 * P) % (2 * P), dir = u < P ? 1 : -1, v = u < P ? u : u - P;
      const s = smoothSeg(v, 0.4, 2.6);   // 0..1
      out[0] = dir > 0 ? -3.6 + 7.2 * s : 3.6 - 7.2 * s; out[1] = 0; return out;
    }
    case 'shuffle': { const w = 1.5; out[0] = 1.1 * Math.sin(t * w) + 0.25 * Math.sin(t * 2.3 * w); out[1] = 0.15 * Math.sin(t * 0.7); return out; }
    case 'circle': { const R = 3, w = 3.2 / R; out[0] = R * Math.sin(t * w); out[1] = R * Math.cos(t * w) - R; return out; }
    case 'walk': { const R = 3, w = 1.3 / R; out[0] = R * Math.sin(t * w); out[1] = R * Math.cos(t * w) - R; return out; }
    case 'back': { const P = 3.4, u = ((t % (2 * P)) + 2 * P) % (2 * P); const s = u < P ? smoothSeg(u, 0.3, 2.6) : 1 - smoothSeg(u - P, 0.3, 2.6); out[0] = 0; out[1] = -4 * s; return out; }
    case 'zigzag': { out[0] = 2.4 * Math.sin(t * 1.1) + 0.6 * Math.sin(t * 3.1); out[1] = -1.4 * Math.abs(Math.sin(t * 0.55)) + 0.5 * Math.sin(t * 1.7); return out; }
    case 'turn': { out[0] = 0; out[1] = 0; return out; }
    default: out[0] = 0; out[1] = 0; return out;
  }
}
function smoothSeg(v, a, b) { const x = Math.min(1, Math.max(0, (v - a) / (b - a))); return x * x * (3 - 2 * x); }

function driveLoco(c, st, t, dt, mode, face, ready) {
  const p = locoPath(mode, t, st.p || (st.p = [0, 0]));
  const q = locoPath(mode, t + 0.01, st.q || (st.q = [0, 0]));
  const vx = (q[0] - p[0]) / 0.01, vz = (q[1] - p[1]) / 0.01;
  c.position[0] = st.x0 + p[0]; c.position[2] = st.z0 + p[1];
  const sp = Math.hypot(vx, vz);
  if (mode === 'turn') c.yaw = Math.sin(t * 0.8) * 2.2;
  else if (face === 'move' && sp > 0.5) {
    const tgt = Math.atan2(vx, vz);
    let d = tgt - c.yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    c.yaw += Math.max(-7 * dt, Math.min(7 * dt, d));
  } else if (face !== 'move') c.yaw = 0;
  c.setLocomotion([vx, 0, vz], ready);
}

// ---------------------------------------------------------------------------- Szene

export async function run(ctx) {
  const { renderer: r, params, devkit } = ctx;
  const id = params.get('char', 'tom');
  const t0 = performance.now();
  const asset = await buildAsset(r, id);
  const racket = buildRacket(r, RACKET_STYLES[id] || RACKET_STYLES.tom);
  const buildMs = performance.now() - t0;
  const scene = devkit.defaultScene();
  const clip = params.get('clip', params.has('loco') ? null : 'forehand');
  const loco = params.get('loco', null);
  const clipList = params.list('clips', []);
  const strip = params.list('strip', clipList.map(() => 0));
  const N = Math.max(1, strip.length);
  const S = asset.skeletonDef.rest[3 * asset.skeletonDef.index.pelvis + 1] / 0.985;
  const spacing = params.num('spacing', 1.5) * S;
  const off = [params.num('side', 0), params.num('up', 0), params.num('fwd', 0)];
  const showBall = params.bool('ball', true);
  const marks = params.bool('marks', params.bool('contact', false));
  const opts = { clip, loco, face: params.get('face', loco === 'walk' || loco === 'circle' ? 'move' : 'net'), shot: params.get('shot', 'topspin'),
    ready: params.num('ready', loco === 'walk' ? 0 : 1), off };

  // Marker
  const ballMesh = r.createMesh(sphere(0.0335, 16, 10));
  const ballMat = r.createMaterial({ name: 'anim-ball', surface: 'void surface(in SurfaceInput i, inout Surface s){ s.albedo = vec3(0.75, 0.95, 0.05); s.roughness = 0.7; s.emissive = vec3(0.08, 0.1, 0.0); }' });
  const markMesh = r.createMesh(sphere(0.02, 10, 6));
  const markMat = r.createMaterial({ name: 'anim-mark', surface: 'void surface(in SurfaceInput i, inout Surface s){ s.albedo = vec3(0.9, 0.08, 0.1); s.emissive = vec3(0.4, 0.0, 0.0); }' });

  const items = [];
  const view = VIEWS[params.get('view', loco ? 'top' : 'front')] || VIEWS.front;
  const vy = params.num('vyaw', view.yaw) * DEG;
  for (let k = 0; k < N; k++) {
    const c = new Character(r, asset, racket);
    // Filmstreifen: Figuren entlang der Bildhorizontalen aufreihen
    const o = (k - (N - 1) / 2) * spacing;
    const lx = Math.cos(vy) * o, lz = -Math.sin(vy) * o;
    const st = loco ? { x0: 0, z0: 0, lx, lz } : { x0: lx, z0: lz, lx, lz };
    if (N > 1) c.blink = 0;
    c.position[0] = st.x0; c.position[2] = st.z0;
    c.reset();
    for (const d of c.drawables) scene.drawables.push(d);
    const ball = new Float32Array(4);
    const bm = mat4.create();
    const ballD = { mesh: ballMesh, material: ballMat, model: bm, castShadow: true, visible: false };
    if (showBall) scene.drawables.push(ballD);
    const sm = mat4.create();
    const sweetD = { mesh: markMesh, material: markMat, model: sm, castShadow: false, visible: marks };
    scene.drawables.push(sweetD);
    const o2 = clipList.length ? { ...opts, clip: String(clipList[k % clipList.length]) } : opts;
    items.push({ c, st, ball, bm, ballD, sm, sweetD, tOff: strip.length ? strip[k] : 0, drive: makeDriver({ ...o2, ball }) });
  }
  if (view.fov) devkit.camera.fov = view.fov * DEG;
  const tread = loco && N > 1;
  devkit.setOrbit({ target: [0, view.ty * S, loco && !tread ? -0.5 : 0], dist: (loco && !tread ? view.dist * 1.6 : Math.max(view.dist * S, N * spacing * 0.62)) * params.num('zoom', 1), yaw: vy / DEG, pitch: view.pitch });

  const look = new Float32Array(3);
  const step = (it, t, dt) => {
    it.drive(it.c, it.st, t, dt);
    // Blick: Ball (falls sichtbar) sonst Netz
    if (it.ball[3] > 0) look.set(it.ball.subarray(0, 3)); else { look[0] = it.c.position[0]; look[1] = 1.3; look[2] = it.c.position[2] + 10; }
    it.c.lookAt(look);
    it.c.update(dt);
  };
  const H = 1 / 120;
  const frozen = devkit.frozen;
  const tFix = devkit.time;
  if (frozen) {
    for (const it of items) {
      const T = Math.max(0, tFix + it.tOff);
      let t = 0;
      it.drive(it.c, it.st, 0, 0); it.c.reset();
      while (t < T - 1e-9) { const h = Math.min(H, T - t); t += h; step(it, t, h); }
      if (T === 0) step(it, 0, 0);
    }
  }
  // Laufband-Darstellung (eingefroren, Fortbewegung): jede Figur an ihren Streifenplatz verschieben
  if (frozen && loco && params.bool('treadmill', strip.length > 1)) {
    for (const it of items) {
      const c = it.c, dx = it.st.lx - c.position[0], dz = it.st.lz - c.position[2];
      for (const m of [c.model, c.racketM, c.shadowM, ...c.attM]) { m[12] += dx; m[14] += dz; }
      const U = c.shadowU; U.u_shFeet[0] += dx; U.u_shFeet[1] += dz; U.u_shFeet[2] += dx; U.u_shFeet[3] += dz; U.u_shLift[2] += dx; U.u_shLift[3] += dz;
    }
  }
  const stats = { contactErr: [] };
  window.__anim = { items, asset, buildMs, stats, chars: items.map((i) => i.c) };
  let simT = 0;
  devkit.start({
    scene,
    update(dt, t) {
      if (!frozen) {
        // feste Unterschritte für stabile Simulation
        let rem = dt;
        while (rem > 1e-6) { const h = Math.min(H, rem); rem -= h; simT += h; for (const it of items) step(it, simT + it.tOff, h); }
      }
      for (const it of items) {
        for (const e of it.c.events) if (e.type === 'swing_contact') { const sw = it.c.getRacketSweetSpot(new Float32Array(3)); stats.contactErr.push(Math.hypot(sw[0] - e.pos[0], sw[1] - e.pos[1], sw[2] - e.pos[2])); }
        it.ballD.visible = showBall && it.ball[3] > 0;
        mat4.fromTranslation(it.bm, it.ball.subarray(0, 3));
        if (marks) { const sw = it.c.getRacketSweetSpot(new Float32Array(3)); mat4.fromTranslation(it.sm, sw); }
      }
      void t;
    },
  });
}

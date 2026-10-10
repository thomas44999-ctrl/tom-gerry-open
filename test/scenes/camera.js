// Kamera-/Regie-Testszene: echte Welt + Platzhalter-Spieler (echte Tom/Gerry-Modelle, prozedural posiert)
// + echtes Match (KI gegen KI, 120 Hz) + Director.
//   dev.html?scene=camera&seq=broadcast|title_flyover|intro|closeup|change_ends|replay|hawkeye|match_end|auto
//   &warm=<s>     Match vor dem Start vorspulen (broadcast/auto)
//   &at=<s>       deterministisch bis Sequenzzeit s vorspulen, dann anhalten (Einzelbild)
//   &sheet=N      Kontaktbogen: N Bilder gleichmäßig über die Sequenz (bzw. &span=s bei broadcast), 3 Spalten
//   &chars=standin|none   &seed=N   &q=low|medium|high|ultra   &hk=x,z,verdict,mm (Hawk-Eye-Position)
//   &bars=0 (Kinobalken aus)  &check=1 (Kamerapfade auf Geometrie-Kollisionen prüfen, Ausgabe in window.__cam.check)
import { vec3, mat4, clamp, lerp, DEG } from '../../src/core/math.js';
import { nextFrame } from '../../src/core/util.js';
import { buildWorld } from '../../src/world/world.js';
import { Match } from '../../src/game/match.js';
import { Director } from '../../src/game/director.js';
import { minCameraY, safeCameraPos } from '../../src/game/camera.js';
const _chk = [0, 0, 0];
import { createSkeleton } from '../../src/chars/skeleton.js';
import { createPose, poseFromEuler } from '../../src/chars/pose.js';

const DT = 1 / 60;

// ============================================================================ Platzhalter-Figur
/** Echte Figur (Asset) mit einfacher prozeduraler Animation; erfüllt den Teil der Character-API, den die Regie nutzt. */
class StandIn {
  constructor(r, asset, racket) {
    this.asset = asset;
    this.def = asset.skeletonDef;
    this.sk = createSkeleton(this.def);
    this.pose = createPose(this.def);
    this.position = vec3.create();
    this.yaw = 0;
    this.model = mat4.create();
    this.drawables = [];
    this.parts = [];
    for (const p of asset.parts) {
      const d = { mesh: p.mesh, material: p.material, bones: this.sk.skin, model: this.model, shells: p.shells || 0, castShadow: p.castShadow !== false };
      this.drawables.push(d); this.parts.push(d);
    }
    this.att = asset.attachments.map((a) => {
      const d = { mesh: a.mesh, material: a.material, model: mat4.create(), castShadow: a.castShadow !== false };
      this.drawables.push(d);
      return { a, d, bi: this.def.index[a.bone] };
    });
    this.racket = null;
    if (racket && asset.gripSocket && asset.gripSocket.matrix) {
      const g = asset.gripSocket;
      this.racket = { local: g.matrix, bi: this.def.index[g.bone], ds: racket.parts.map((p) => { const d = { mesh: p.mesh, material: p.material, model: mat4.create(), castShadow: true }; this.drawables.push(d); return d; }) };
    }
    this.capturePoseLayout = { quats: this.def.count };
    this.phase = 0; this.walkAmp = 0; this.ready = 0; this.emoteT = 0; this.lastEmote = null;
    this.spec = {};
    this._tmp = mat4.create();
    this.mood = 'neutral';
    this.visible = true;
  }
  setVisible(v) { this.visible = v; for (const d of this.drawables) d.visible = v; }
  /** Prozedurale Pose aus dem Spielerzustand. */
  update(dt, p, t) {
    if (p) {
      vec3.set(this.position, p.pos[0], p.pos[1] || 0, p.pos[2]);
      this.yaw = p.yaw;
    }
    const v = p ? Math.hypot(p.vel[0], p.vel[2]) : 0;
    this.walkAmp += (clamp(v / 5.5, 0, 1) - this.walkAmp) * (1 - Math.exp(-dt * 8));
    this.phase += dt * (5.2 + v * 1.6);
    const rd = p ? (p.mode === 'ready' || p.mode === 'move' || p.mode === 'stroke' || p.mode === 'recover' ? 1 : 0) : 0;
    this.ready += (rd - this.ready) * (1 - Math.exp(-dt * 6));
    const emote = p ? p.emote : null;
    if (emote !== this.lastEmote) { this.emoteT = 0; this.lastEmote = emote; }
    this.emoteT += dt;
    const S = this.spec;
    for (const k in S) delete S[k];
    const r = this.ready, a = this.walkAmp, ph = this.phase, sn = Math.sin(ph);
    S.pelvisOffset = [0, -0.07 * r - 0.015 * a * Math.abs(Math.cos(ph)), 0];
    S.spine = [3 + 10 * r + 6 * a, 0, 0];
    S.chest = [2, 0, 0];
    S.thigh_l = [24 * r + (18 + 26 * a) * sn * a, 0, 7 * r];
    S.thigh_r = [24 * r - (18 + 26 * a) * sn * a, 0, 7 * r];
    S.shin_l = [-(38 * r + (12 + 45 * a) * a * (0.5 + 0.5 * Math.sin(ph + 1.7))), 0, 0];
    S.shin_r = [-(38 * r + (12 + 45 * a) * a * (0.5 - 0.5 * Math.sin(ph + 1.7))), 0, 0];
    S.foot_l = [14 * r, 0, 0]; S.foot_r = [14 * r, 0, 0];
    S.arm_l = [8 + 28 * r - (16 + 22 * a) * sn * a, 0, -40 + 18 * r];
    S.arm_r = [8 + 32 * r + (10 + 14 * a) * sn * a, 0, -37 + 16 * r];
    S.forearm_l = [18 + 50 * r + 25 * a, 0, 0];
    S.forearm_r = [30 + 40 * r + 20 * a, 0, 0];
    // Schlag
    const st = p && p.stroke;
    if (st && st.contactTime != null) {
      const t0 = st.start ?? (st.contactTime - (st.windup || 0.4));
      let k;
      if (t < st.contactTime) { const f = clamp((t - t0) / Math.max(0.05, st.contactTime - t0), 0, 1); k = f < 0.6 ? -(f / 0.6) : -1 + (f - 0.6) / 0.4; }
      else k = clamp((t - st.contactTime) / 0.45, 0, 1);
      const type = st.type || '';
      if (type === 'serve' || type === 'smash') {
        const up = k < 0 ? 1 : 1 - k;
        S.arm_r = [lerp(-10, 85, Math.max(0, k)), 0, lerp(150, 60, Math.max(0, k)) * up + (1 - up) * -20];
        S.forearm_r = [k < -0.4 ? 110 : lerp(110, 10, clamp((k + 0.4) / 0.4, 0, 1)), 0, 0];
        S.arm_l = [20, 0, k < -0.2 ? 130 : 40];
        S.spine = [k < 0 ? -12 : 25 * k, 0, 0];
        S.chest = [0, k < 0 ? -25 : 20 * k, 0];
      } else {
        const bh = type.indexOf('backhand') >= 0;
        const sgn = bh ? -1 : 1;
        S.chest = [4, sgn * 38 * k, 0];
        S.spine = [8, sgn * 22 * k, 0];
        if (!bh) {
          S.arm_r = [lerp(-15, 95, (k + 1) / 2), lerp(-20, 30, (k + 1) / 2), lerp(55, 25, (k + 1) / 2)];
          S.forearm_r = [lerp(45, 70, (k + 1) / 2), 0, 0];
        } else {
          S.arm_r = [lerp(70, 40, (k + 1) / 2), lerp(40, -30, (k + 1) / 2), lerp(-30, 70, (k + 1) / 2)];
          S.forearm_r = [lerp(80, 15, (k + 1) / 2), 0, 0];
          S.arm_l = [lerp(60, 30, (k + 1) / 2), 0, lerp(-20, 20, (k + 1) / 2)];
        }
      }
    }
    // Emotes
    if (emote && !st) {
      const e = clamp(this.emoteT / 0.35, 0, 1);
      const w = (spec) => { for (const b in spec) { const sv = spec[b], cur = S[b] || [0, 0, 0]; S[b] = [lerp(cur[0], sv[0], e), lerp(cur[1], sv[1], e), lerp(cur[2], sv[2], e)]; } };
      if (emote === 'celebrate' || emote === 'jump') w({ arm_l: [10, 0, 128], arm_r: [10, 0, 128], forearm_l: [20, 0, 0], forearm_r: [25, 0, 0], head: [-14, 0, 0], spine: [-6, 0, 0] });
      else if (emote === 'fistpump') w({ arm_r: [30, 0, 52], forearm_r: [112, 0, 0], spine: [12, 0, 0], chest: [6, -10, 0], head: [6, 0, 0], thigh_l: [20, 0, 6], thigh_r: [20, 0, 6], shin_l: [-30, 0, 0], shin_r: [-30, 0, 0], pelvisOffset: [0, -0.06, 0] });
      else if (emote === 'dejected' || emote === 'shrug') w({ neck: [26, 0, 0], head: [14, 0, 0], spine: [12, 0, 0], arm_l: [0, 0, -44], arm_r: [4, 0, -42], forearm_l: [8, 0, 0], forearm_r: [12, 0, 0] });
      else if (emote === 'wave' || emote === 'clap') w({ arm_r: [20, 0, 120], forearm_r: [40, 0, 0] });
    }
    poseFromEuler(this.def, S, this.pose);
    if (this.asset.face) this.asset.face.update(dt, { blink: undefined, mood: emote === 'dejected' ? 'sad' : (emote ? 'happy' : 'focused') });
    this._apply();
  }
  _apply() {
    mat4.fromYawTranslation(this.model, this.yaw, this.position);
    this.sk.update(this.pose);
    const tmp = this._tmp;
    for (const { a, d, bi } of this.att) { mat4.multiply(tmp, this.model, this.sk.world[bi]); mat4.multiply(d.model, tmp, a.offset); }
    if (this.racket) {
      mat4.multiply(tmp, this.model, this.sk.world[this.racket.bi]);
      mat4.multiply(tmp, tmp, this.racket.local);
      for (const d of this.racket.ds) mat4.copy(d.model, tmp);
    }
  }
  /** Fell-LOD nach Bildgröße (Gerry). */
  lod(cam, viewH) {
    if (!this.asset.applyFurLod) return;
    const c = cam.position, dist = Math.max(0.5, Math.hypot(c[0] - this.position[0], c[1] - 0.8, c[2] - this.position[2]));
    const px = viewH * 1.6 / (2 * dist * Math.tan(cam.fov / 2));
    this.asset.applyFurLod(this.parts, px);
  }
  // ---- Character-API (Teil) für Regie/Wiederholung
  getBoneWorld(name, out) { return this.sk.getWorldPos(name, out, this.model); }
  capturePose(out) {
    const n = this.pose.rot.length + this.pose.t.length;
    if (!out || out.length !== n) out = new Float32Array(n);
    out.set(this.pose.rot, 0); out.set(this.pose.t, this.pose.rot.length);
    return out;
  }
  applyCapturedPose(arr) {
    const nr = this.pose.rot.length;
    this.pose.rot.set(arr.subarray(0, nr)); this.pose.t.set(arr.subarray(nr, nr + this.pose.t.length));
    this._apply();
  }
}

// ============================================================================ Szene
export async function run({ renderer: r, devkit, params }) {
  const qn = params.get('q', null);
  if (qn && qn !== r.q.name) r.setQuality(qn);
  const seqName = params.get('seq', 'broadcast');
  const sheetN = params.num('sheet', 0);
  const atT = params.has('at') ? params.num('at', 0) : null;
  const info = document.createElement('div');
  info.style.cssText = 'position:fixed;left:8px;top:8px;font:12px/1.35 monospace;color:#fff;background:#0009;padding:4px 8px;white-space:pre;pointer-events:none;z-index:5';
  document.body.appendChild(info);
  info.textContent = 'Welt wird gebaut …';

  const world = await buildWorld(r, {});
  const scene = { drawables: world.drawables.slice(), time: 0 };
  world.applyTo(scene);
  scene.drawables.push(...world.ball.drawables);
  const baseExposure = scene.exposure ?? 1;

  // ---- Spieler
  const charsMode = params.get('chars', 'standin');
  let chars = [null, null];
  if (charsMode !== 'none') {
    info.textContent = 'Figuren werden gebaut …';
    await nextFrame();
    const { buildTom } = await import('../../src/chars/tom.js');
    const { buildGerry } = await import('../../src/chars/gerry.js');
    let buildRacket = null;
    try { ({ buildRacket } = await import('../../src/chars/racket.js')); } catch (e) { buildRacket = null; }
    const tom = buildTom(r, r.q);
    await nextFrame();
    const gerry = buildGerry(r, r.q);
    const rk = (a) => (buildRacket ? buildRacket(r, a.racketStyle) : null);
    chars = [new StandIn(r, tom, rk(tom)), new StandIn(r, gerry, rk(gerry))];
    for (const c of chars) scene.drawables.push(...c.drawables);
  }

  // ---- Match (KI gegen KI)
  const seed = params.num('seed', 3);
  const m = new Match({ players: ['tom', 'gerry'], humans: [], seed, difficulty: 'normal', format: { sets: 3 } });
  const S = m.state;
  const director = new Director({ renderer: r, world });
  if (seqName === 'auto') director.auto = true;
  let simT = 0, stepMatch = true;
  let override = null;            // Szenen-Skript überschreibt Spielerpositionen (Einlauf etc.)
  let lastEvents = [];
  const view = { phase: S.phase, ball: S.ball, players: S.players, humanIndex: 0, humanSide: 1, events: null, characters: chars[0] ? chars : null, time: 0, server: 0, state: S };

  const fadeEl = document.createElement('div');
  fadeEl.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;z-index:3';
  const barT = document.createElement('div'), barB = document.createElement('div');
  for (const b of [barT, barB]) { b.style.cssText = 'position:fixed;left:0;right:0;height:0;background:#000;pointer-events:none;z-index:4'; document.body.appendChild(b); }
  barT.style.top = '0'; barB.style.bottom = '0';
  document.body.appendChild(fadeEl);
  const showBars = params.get('bars', '1') !== '0';

  let cueLog = [];
  director.on('cue', (c) => { cueLog.push(`${c.seq}:${c.name}${c.data && c.data.index != null ? '#' + c.data.index : ''}`); if (cueLog.length > 6) cueLog.shift(); });

  /** Ein Simulationsschritt (Spiel, Figuren, Regie, Welt). */
  const step = (dt) => {
    simT += dt;
    if (stepMatch && director.timeScale > 0 && dt > 0) m.step(dt * director.timeScale);
    const events = m.drainEvents();
    lastEvents = events;
    if (override) override(dt, simT);
    if (!director.replaying) for (let i = 0; i < 2; i++) if (chars[i]) chars[i].update(dt, S.players[i], m.time);
    view.phase = S.phase; view.events = events; view.time = m.time; view.server = S.server;
    view.humanSide = S.players[0].side;
    director.update(dt, view);
    const rb = director.replaying && director.replayState ? director.replayState.ball : S.ball;
    world.update(dt, { time: simT, ballPos: rb.visible !== false ? rb.pos : null, events, excitement: 0.4, camera: director.camera });
    if (!director.replaying) world.ball.update(dt, S.ball);
    const vh = r.canvas.height || 720;
    for (const c of chars) if (c) c.lod(director.camera, vh);
    scene.time = simT;
  };
  const simulate = (sec, until = null) => {
    const n = Math.round(sec / DT);
    for (let k = 0; k < n; k++) { step(DT); if (until && until()) return true; }
    return false;
  };
  const untilEvent = (pred, maxSec = 90) => {
    let hit = null;
    const n = Math.round(maxSec / DT);
    for (let k = 0; k < n; k++) { step(DT); for (const e of lastEvents) if (pred(e)) hit = e; if (hit) return hit; }
    return null;
  };

  // ---- Sequenz vorbereiten
  info.textContent = 'Vorbereitung …';
  await nextFrame();
  let playOpts = null, playName = null;
  const warm = params.num('warm', seqName === 'broadcast' || seqName === 'auto' ? 3 : 0);
  if (seqName === 'broadcast' || seqName === 'auto') {
    simulate(warm);
  } else if (seqName === 'title_flyover') {
    stepMatch = false; simulate(0.1);
    if (!params.bool('players', false)) for (const c of chars) if (c) c.setVisible(false);
    playName = 'title_flyover'; playOpts = {};
  } else if (seqName === 'intro') {
    stepMatch = false;
    // Einlauf: von der Bankseite an die Grundlinien
    const P = S.players;
    const start = [[-6.5, 0, 1.2], [-6.2, 0, -1.4]];
    const goal = [[0.9, 0, 12.4 * P[0].side], [-2.4, 0, 12.7 * P[1].side]];
    const T = 3.6;
    override = (dt, t) => {
      for (let i = 0; i < 2; i++) {
        const k = clamp((t - 0.2 - i * 0.4) / T, 0, 1), e = k * k * (3 - 2 * k);
        const p = P[i];
        const nx = lerp(start[i][0], goal[i][0], e), nz = lerp(start[i][2], goal[i][2], e);
        p.vel[0] = (nx - p.pos[0]) / Math.max(dt, 1e-4); p.vel[2] = (nz - p.pos[2]) / Math.max(dt, 1e-4);
        if (dt <= 0) { p.vel[0] = p.vel[2] = 0; }
        p.pos[0] = nx; p.pos[2] = nz;
        const sp = Math.hypot(p.vel[0], p.vel[2]);
        p.yaw = sp > 0.2 ? Math.atan2(p.vel[0], p.vel[2]) : (p.side > 0 ? Math.PI : 0);
        p.mode = sp > 0.2 ? 'walk' : 'idle'; p.stroke = null; p.emote = null;
      }
      S.ball.visible = false;
    };
    simulate(DT);
    playName = 'intro'; playOpts = {};
  } else if (seqName === 'closeup') {
    const e = untilEvent((e) => e.type === 'point', 120);
    simulate(0.25);
    const w = e ? e.winner : 0;
    playName = 'closeup'; playOpts = { player: params.num('player', w), emote: params.get('emote', null) || S.players[w].emote || 'fistpump', walk: params.bool('walk', false) };
  } else if (seqName === 'change_ends') {
    simulate(1.0);
    m.setPhase('change_ends');
    simulate(0.2);
    playName = 'change_ends'; playOpts = {};
  } else if (seqName === 'replay') {
    const minRally = params.num('rally', 3);
    const reasons = params.get('reason', 'winner,ace,service_winner').split(',');
    const e = untilEvent((e) => e.type === 'point' && e.rally >= minRally && reasons.includes(e.reason), 400);
    simulate(1.0);
    playName = 'replay'; playOpts = { angles: params.has('angles') ? params.get('angles').split(',') : undefined };
    window.__cam_point = e ? { reason: e.reason, rally: e.rally, winner: e.winner } : null;
  } else if (seqName === 'hawkeye') {
    simulate(1.0);
    const hk = params.list('hk', []);
    const pos = hk.length >= 2 ? [+hk[0], 0, +hk[1]] : [2.35, 0, -11.9];
    playName = 'hawkeye'; playOpts = { pos, verdict: hk[2] || 'in', distanceMm: hk[3] ? +hk[3] : 3 };
  } else if (seqName === 'match_end') {
    simulate(1.0);
    stepMatch = false;
    const w = params.num('winner', 0);
    override = () => { S.players[w].emote = 'celebrate'; S.players[1 - w].emote = 'dejected'; S.players[w].stroke = null; S.players[1 - w].stroke = null; S.ball.visible = false; };
    if (world.crowd) world.crowd.react('standing', 1);
    playName = 'match_end'; playOpts = { winner: w, loop: params.bool('loop', false) };
  }
  let playing = null, seqDur = 0;
  const startSeq = () => {
    if (!playName) return;
    playing = director.play(playName, playOpts);
    const c = director._cur;
    seqDur = c ? c.seq.shots.reduce((s, sh) => s + sh.dur, 0) : 0;
    playing.then((res) => { window.__cam.done = res; });
  };
  window.__cam = { director, match: m, world, chars, scene, seqDur: 0, done: null, check: null };
  startSeq();
  window.__cam.seqDur = seqDur;

  // ---- Pfadprüfung (Geometrie-Kollisionen der Kinematik)
  if (params.bool('check', false)) {
    const saved = director.stats.clamped;
    const pose = director.pose;
    let minClear = Infinity, worst = null;
    const tEnd = seqDur || 8;
    for (let t = 0; t < tEnd; t += DT) {
      step(DT);
      _chk[0] = pose.pos[0]; _chk[1] = pose.pos[1]; _chk[2] = pose.pos[2];
      const cl = safeCameraPos(_chk) ? -Math.abs(_chk[1] - pose.pos[1]) : pose.pos[1] - minCameraY(pose.pos[0], pose.pos[2]);
      if (cl < minClear) { minClear = cl; worst = { t: +t.toFixed(2), pos: Array.from(pose.pos).map((v) => +v.toFixed(2)), shot: director._cur && director._cur.seq.shot ? director._cur.seq.shot.name : director.mode }; }
    }
    window.__cam.check = { clamped: director.stats.clamped - saved, minClear: +minClear.toFixed(3), worst };
  }

  const overlay = (fade, lb, w, h, ctx2d, ox, oy) => {
    const barH = showBars ? lb * Math.max(0, (h - w / 2.39) / 2) : 0;
    if (ctx2d) {
      ctx2d.fillStyle = '#000';
      if (barH > 0.5) { ctx2d.fillRect(ox, oy, w, barH); ctx2d.fillRect(ox, oy + h - barH, w, barH); }
      if (fade > 0.01) { ctx2d.globalAlpha = fade; ctx2d.fillRect(ox, oy, w, h); ctx2d.globalAlpha = 1; }
    } else {
      barT.style.height = barB.style.height = `${barH.toFixed(1)}px`;
      fadeEl.style.opacity = fade.toFixed(3);
    }
  };
  const label = () => {
    const c = director._cur, sh = c && c.seq.shot;
    const cam = director.camera, b = director.broadcast.debug;
    return `${director.mode}${c ? ' · ' + c.name + ' · ' + (sh ? sh.name : '') + ' ' + c.seq.t.toFixed(2) + 's' : ''}  fov ${(cam.fov / DEG).toFixed(1)}°` +
      (director.mode === 'broadcast' ? `  need ${b.fovNeed.toFixed(1)}° pitch ${b.pitch.toFixed(1)}°` : '') +
      `  ${S.phase}  clamp ${director.stats.clamped}` + (cam.dof ? `  dof f=${cam.dof.focus.toFixed(1)} a=${cam.dof.aperture.toFixed(2)}` : '');
  };

  // ---- Kontaktbogen
  if (sheetN > 0) {
    r.dynamicResolution = false; r.renderScale = 1;
    const cols = sheetN <= 9 ? 3 : 4, rows = Math.ceil(sheetN / cols);
    const W = r.canvas.clientWidth || 1280, H = r.canvas.clientHeight || 720;
    const cw = Math.floor(W / cols), ch = Math.floor(cw * 9 / 16);
    const sheet = document.createElement('canvas');
    sheet.width = cw * cols; sheet.height = ch * rows;
    sheet.style.cssText = `position:fixed;left:0;top:0;width:${sheet.width}px;height:${sheet.height}px;z-index:6;background:#222`;
    document.body.appendChild(sheet);
    const g = sheet.getContext('2d');
    const span = params.num('span', seqDur > 0 ? seqDur : 8);
    const t0 = params.num('from', 0);
    let t = 0;
    for (let k = 0; k < sheetN; k++) {
      const target = t0 + (sheetN === 1 ? 0 : span * (k + 0.5) / sheetN);
      while (t < target - 1e-6) { step(DT); t += DT; }
      r.render(scene, director.camera);
      const x = (k % cols) * cw, y = Math.floor(k / cols) * ch;
      g.drawImage(r.canvas, x, y, cw, ch);
      overlay(director.fade, director.letterbox, cw, ch, g, x, y);
      g.fillStyle = '#000a'; g.fillRect(x, y, cw, 16);
      g.fillStyle = '#fff'; g.font = '11px monospace';
      g.fillText(`t=${target.toFixed(2)} ${label()}`.slice(0, 110), x + 4, y + 12);
      await nextFrame();
    }
    info.textContent = `sheet ${sheetN} × ${span.toFixed(1)}s  seqDur ${seqDur.toFixed(1)}s  cues: ${cueLog.join(' ')}`;
    info.style.top = 'auto'; info.style.bottom = '8px';
    window.__dev.ready = true; window.__cam.sheetDone = true;
    return;
  }

  // ---- Einzelbild bei Sequenzzeit at
  if (atT != null) { simulate(atT); }
  const frozen = atT != null;
  let infoT = 0;
  devkit.start({
    scene,
    camera: director.camera,
    update(dt) {
      if (frozen) dt = 0;
      step(dt);
      scene.exposure = baseExposure;
      overlay(director.fade, director.letterbox, window.innerWidth, window.innerHeight, null);
      infoT += dt;
      if (infoT > 0.25 || frozen) {
        infoT = 0;
        const st = r.stats;
        info.textContent = `${label()}\n${st.fps.toFixed(0)} fps ${st.frameMs.toFixed(1)} ms  cues: ${cueLog.join(' ')}`;
      }
    },
  });
}

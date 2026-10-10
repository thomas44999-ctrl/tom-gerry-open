// Regie (ARCHITECTURE §8): wählt die aktive Kamera (TV-Übertragung, Kinematik, Wiederholung), spielt
// Sequenzen ab (Titel-Überflug, Einlauf, Nahaufnahmen, Seitenwechsel, Zeitlupen-Wiederholung, Hawk-Eye,
// Matchende) und meldet Stichworte (cues) für die UI. Zeichnet nebenbei für Wiederholungen auf.
//
//   const d = new Director({ renderer, world });
//   d.update(dt, { phase, ball, players, humanIndex, humanSide, events, characters?, time? });
//   renderer.render(scene, d.camera);
//   await d.play('closeup', { player: 0, emote: 'fistpump' });   // Promise -> { name, skipped }
//   d.skip();  d.on('cue', (c) => ui…);  d.fade (0..1 Abblende), d.letterbox (0..1), d.timeScale
import { vec3, clamp, lerp, DEG, saturate } from '../core/math.js';
import { Emitter } from '../core/util.js';
import { COURT, lineDistance } from '../sim/court.js';
import { LAYOUT } from '../world/layout.js';
import {
  createCamera, CamPose, applyPose, BroadcastCamera, ShotSequence, spline, crane, orbit, track, custom,
  EASE, Spring, safeCameraPos, keepAwayFromPlayers, headPosOf, headHeightOf, pullIn, minCameraY,
} from './camera.js';
import { Recorder, ReplayPlayer } from './replay.js';
import { params } from '../core/util.js';

// TV-Kamera: Debug-Überschreibung per URL (?camh=Höhe&camb=Abstand hinter der Grundlinie)
const BROADCAST_OPTS = {};
if (params.has('camh')) BROADCAST_OPTS.height = params.num('camh', 5.6);
if (params.has('camb')) BROADCAST_OPTS.back = params.num('camb', 7.5);

const HL = COURT.halfLength;
const SUN_X = -0.56, SUN_Z = -0.83;          // horizontale Richtung zur Sonne (NW), für Licht-bewusste Platzierung
const EMPTY_VIEW = { phase: 'idle', ball: null, players: [], humanIndex: 0, humanSide: 1, events: null };
const POSITIVE = new Set(['fistpump', 'celebrate', 'jump', 'wave', 'bow', 'clap']);

const _a = vec3.create(), _b = vec3.create(), _c = vec3.create();


/** Prüft eine Kandidaten-Position für Nahaufnahmen: im Platzbereich, Abstand zu Mauer/Netz/Stuhl, gleiche Netzseite. */
function closeupPenalty(cam, subj) {
  const L = LAYOUT;
  let pen = 0;
  const mx = L.wallX - Math.abs(cam[0]), mz = L.wallZ - Math.abs(cam[2]);
  if (mx < 0.9) pen += (0.9 - mx) * 8;
  if (mz < 0.9) pen += (0.9 - mz) * 8;
  if (Math.abs(cam[2]) < 0.8) pen += 6;                                      // Netz
  if (Math.sign(cam[2]) !== Math.sign(subj[2]) && Math.abs(subj[2]) > 0.5) pen += 10;  // Netz zwischen Kamera und Spieler
  if (cam[0] < -6.0 && Math.abs(cam[2]) < 3.5) pen += 3;                      // Stuhl/Bänke
  return pen;
}

/** Verdeckung: steht ein anderer Spieler (Kapsel r≈0.45 m) zwischen Kamera und Subjekt? Liefert 0..1. */
function occlusion(cx, cz, subj, others, skip) {
  let occ = 0;
  if (!others) return 0;
  for (let k = 0; k < others.length; k++) {
    if (k === skip) continue;
    const o = others[k];
    if (!o || !o.pos) continue;
    const dx = subj[0] - cx, dz = subj[2] - cz, L2 = dx * dx + dz * dz || 1;
    const t = ((o.pos[0] - cx) * dx + (o.pos[2] - cz) * dz) / L2;
    if (t < 0.02 || t > 1.08) continue;
    const px = cx + dx * t - o.pos[0], pz = cz + dz * t - o.pos[2];
    const d = Math.hypot(px, pz);
    occ = Math.max(occ, clamp(1 - (d - 0.45) / 0.5, 0, 1));
  }
  return occ;
}

const CANDIDATES = [0.5, -0.5, 1, -1, 1.8, -1.8, 2.6, -2.6];
/**
 * Kamera-Azimut (Welt) für eine Nahaufnahme von vorn-seitlich: Kandidaten ±base um die Blickrichtung,
 * bevorzugt die Sonnenseite (Gesicht im Licht), freie Positionen und keine Verdeckung durch den anderen Spieler.
 */
function chooseCloseupAngle(subj, yaw, dist, base = 32 * DEG, others = null, self = -1, prefer = null, lightW = 0.6) {
  let best = yaw, bestScore = Infinity;
  for (const m of CANDIDATES) {
    const off = m * base;
    const a = yaw + off;
    const x = subj[0] + Math.sin(a) * dist, z = subj[2] + Math.cos(a) * dist;
    _c[0] = x; _c[1] = 1; _c[2] = z;
    // Licht: Kamera auf der Sonnenseite des Spielers -> Gesicht beleuchtet
    const light = -(Math.sin(a) * SUN_X + Math.cos(a) * SUN_Z);
    let score = closeupPenalty(_c, subj) + light * lightW + Math.abs(off) * 0.9 + occlusion(x, z, subj, others, self) * 25;
    if (prefer != null) score += Math.abs(Math.atan2(Math.sin(a - prefer), Math.cos(a - prefer))) * 1.5;   // Stabilität
    if (score < bestScore) { bestScore = score; best = a; }
  }
  return best;
}

/**
 * Zwei Punkte (z.B. Ball und Spieler) ins Bild nehmen: Ziel = gewichtete Mitte, fov so, dass beide
 * (plus Rand) hineinpassen. Gibt den benötigten fov zurück (geklemmt).
 */
function frameTwo(pos, A, B, wA, outTgt, minFov, maxFov, aspect = 16 / 9, pad = 1.25, extra = null) {
  for (let k = 0; k < 3; k++) outTgt[k] = A[k] * wA + B[k] * (1 - wA);
  // Kamerabasis (Horizont waagerecht): vorwärts f, rechts r, oben u
  let fx = outTgt[0] - pos[0], fy = outTgt[1] - pos[1], fz = outTgt[2] - pos[2];
  const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
  let rx = -fz, rz = fx; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  // nötige Tangens-Ausdehnung horizontal und vertikal getrennt (vorher nur horizontal -> vertikal zu eng, Köpfe abgeschnitten)
  let needH = 0, needV = 0;
  const fit = (P) => {
    const px = P[0] - pos[0], py = P[1] - pos[1], pz = P[2] - pos[2];
    const z = Math.max(0.3, px * fx + py * fy + pz * fz);
    needH = Math.max(needH, Math.abs(px * rx + pz * rz) / z);
    needV = Math.max(needV, Math.abs(px * ux + py * uy + pz * uz) / z);
  };
  fit(A); fit(B);
  if (extra) for (const P of extra) fit(P);
  const t = Math.max(needV * pad, needH * pad / aspect) + 0.03;
  return clamp(2 * Math.atan(t), minFov, maxFov);
}

export class Director {
  /** opts = { renderer, world, aspect?, record: true } */
  constructor({ renderer = null, world = null, aspect = null, record = true } = {}) {
    this.renderer = renderer;
    this.world = world;
    this.anchors = (world && world.anchors) || {};
    this.camera = createCamera();
    this.broadcast = new BroadcastCamera(BROADCAST_OPTS);
    this.mode = 'broadcast';             // 'broadcast' | 'cinematic' | 'replay'
    this.timeScale = 1;                  // Empfehlung für die Spielgeschwindigkeit (0 während Wiederholungen)
    this.fade = 0;                       // 0..1 Abblende (UI/Post: Schwarz überblenden)
    this.letterbox = 0;                  // 0..1 Kinobalken (UI)
    this.recorder = record ? new Recorder({ seconds: 15, hz: 60 }) : null;
    this.autoRecord = true;
    this.autoShake = true;
    this.auto = false;                   // automatische Regie (Nahaufnahmen/Wiederholungen/Hawk-Eye) – optional
    this.dofEnabled = true;
    this.events = new Emitter();
    this.pose = new CamPose();
    this.view = EMPTY_VIEW;
    this.time = 0;
    this.replay = null;                  // ReplayPlayer während einer Wiederholung
    this.replayState = null;             // { ball, players } der Wiederholung (z.B. für world.update)
    this.stats = { clamped: 0, clampShots: {} };
    this._aspectOpt = aspect;
    this._cur = null;
    this._lb = 0;
    this._exit = null;                   // weiche Rückkehr in die Übertragung
    this._fadeIn = 0;
    this._cueWaiters = [];
    this._side = 1;
    this._lastPos = [[0, 0, 0], [0, 0, 0]]; this._hasLast = false;
    this.ctx = { view: EMPTY_VIEW, director: this, world, rp: null, rs: null };
    this._auto = { pending: null, t: 0, lastPoint: null, lastPhase: null, closeCall: null };
    this._buildSeq = {
      title_flyover: (o) => this._seqTitle(o),
      intro: (o) => this._seqIntro(o),
      closeup: (o) => this._seqCloseup(o),
      change_ends: (o) => this._seqChangeEnds(o),
      replay: (o) => this._seqReplay(o),
      hawkeye: (o) => this._seqHawkeye(o),
      match_end: (o) => this._seqMatchEnd(o),
    };
  }

  // ================================================================ öffentliche API
  /** Ereignisse: 'cue' {seq, name, index, data}, 'shot' {seq, shot, index}, 'sequence_start'/'sequence_end' {name, skipped}. */
  on(type, fn) { return this.events.on(type, fn); }
  /** Promise, das beim nächsten Stichwort `name` (optional einer Sequenz) erfüllt wird. */
  cue(name, seq = null) { return new Promise((res) => this._cueWaiters.push({ name, seq, res })); }
  /** Erschütterung der Übertragungskamera (0..1). */
  shake(amount = 0.5) { this.broadcast.shake(amount); }
  /** Harter Schnitt der Übertragungskamera (z.B. nach Teleport). */
  cut() { this.broadcast.cut(); this._exit = null; }
  /** Kurz aus dem Schwarz aufblenden (verdeckt Schnitte, z. B. Spieler stehen zum neuen Punkt bereit). */
  dip(t = 0.35) { this._fadeIn = Math.max(this._fadeIn || 0, Math.min(0.35, t)); }
  get playing() { return this._cur ? this._cur.name : null; }
  get replaying() { return this.mode === 'replay'; }
  get sequences() { return Object.keys(this._buildSeq); }

  /**
   * Sequenz abspielen: 'title_flyover' | 'intro' | 'closeup' | 'change_ends' | 'replay' | 'hawkeye' | 'match_end'.
   * Gemeinsame opts: { onCue(cue), exit: 'cut'|'blend'|'dip', loop }. Liefert Promise -> { name, skipped }.
   */
  play(name, opts = {}) {
    if (this._cur) this._finish(true, true);
    const build = this._buildSeq[name];
    if (!build) return Promise.resolve({ name, skipped: true, error: 'unknown sequence' });
    this.ctx.view = this.view;
    const spec = build(opts || {});
    if (!spec || !spec.shots || !spec.shots.length) return Promise.resolve({ name, skipped: true });
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const seq = new ShotSequence(spec.shots, {
      name, loop: opts.loop ?? spec.loop, entryDip: spec.entryDip ?? false,
      onShot: (sh, i) => this._onShot(name, sh, i),
    });
    this._cur = { name, seq, resolve, spec, opts, cueT: 0 };
    this.mode = spec.mode || 'cinematic';
    this.timeScale = spec.timeScale ?? 1;
    this._lb = spec.letterbox ?? 0;
    this._exit = null;
    if (spec.start) spec.start();
    this._emit('sequence_start', { name });
    seq.start(this.ctx);
    return promise;
  }

  /** Laufende Sequenz beenden (Promise wird mit skipped: true erfüllt). */
  skip() { if (this._cur) this._finish(true); }
  /** Zur nächsten Einstellung der laufenden Sequenz springen. */
  next() { if (this._cur) this._cur.seq.next(this.ctx); }

  /** Manuelle Aufzeichnung (falls autoRecord = false). */
  record(t, ball, characters, events) {
    if (!this.recorder) return;
    if (events) this.recorder.addEvents(events, t);
    this.recorder.record(t, ball, characters);
  }

  /** Abblende auf eine Szene anwenden (Belichtung). base = Grundbelichtung (Standard 1). */
  applyToScene(scene, base = 1) { scene.exposure = base * (1 - this.fade * 0.985); return scene; }

  /**
   * Pro Bild aufrufen. view = { phase, ball:{pos,vel,visible}, players:[{pos,yaw,side,id,…}], humanIndex, humanSide,
   *   events (seit letztem Bild), characters? (für Kopfpositionen/Aufzeichnung), time? (Spielzeit), server? }
   */
  update(dt, view) {
    if (view) this.view = view;
    view = this.view;
    this.ctx.view = view;
    this.time += dt;
    this.broadcast.aspect = this._aspect();

    // ---- Aufzeichnung (nicht während der Wiederholung)
    if (this.recorder && this.autoRecord && this.mode !== 'replay') {
      const t = view.time ?? this.time;
      if (view.events) this.recorder.addEvents(view.events, t);
      if (view.ball || view.players) this.recorder.record(t, view.ball, view.characters || view.players);
    }
    // ---- Erschütterung bei Schmetterbällen
    if (this.autoShake && view.events && this.mode === 'broadcast') {
      for (const e of view.events) if ((e.type === 'hit') && (e.stroke === 'smash') && (e.speed ?? 30) > 18) this.broadcast.shake(0.42);
    }
    // ---- Seite der Übertragungskamera (Wechsel erst nach dem Seitenwechsel-Gang)
    const P = view.players || [];
    const hs = view.humanSide ?? (P[view.humanIndex ?? 0] ? P[view.humanIndex ?? 0].side : 1);
    if (view.phase !== 'change_ends') this._side = hs < 0 ? -1 : 1;
    this.broadcast.setSide(this._side);

    // Teleport (z.B. Seitenwechsel): verfolgende Einstellungen und Übertragung schneiden statt schwenken
    let jumped = false;
    for (let i = 0; i < P.length && i < 2; i++) {
      const p = P[i] && P[i].pos, lp = this._lastPos[i];
      if (!p) continue;
      if (this._hasLast && Math.hypot(p[0] - lp[0], p[2] - lp[2]) > 2.5) jumped = true;
      lp[0] = p[0]; lp[2] = p[2];
    }
    this._hasLast = P.length > 0;
    if (jumped) {
      this.broadcast.cut();
      const sh = this._cur && this._cur.seq.shot;
      if (sh && this.mode !== 'replay') sh._init = false;
    }
    if (this._cur && this._cur.spec.untilPhase && view.phase !== this._cur.spec.untilPhase && this._cur.seq.time > 0.2) this._finish(false);
    // Kurze Einspieler zwischen den Punkten enden spätestens, wenn der Aufschlag beginnt
    if (this._cur && this._cur.spec.liveCut !== false && (view.phase === 'serve' || view.phase === 'rally') && this._cur.seq.time > 0.3 &&
        (this._cur.name === 'closeup' || this._cur.name === 'hawkeye' || this._cur.name === 'change_ends')) this._finish(false);

    if (this.auto) this._autoDirect(dt, view);

    // ---- Kamera
    const c = this._cur;
    let fade = 0;
    if (c) {
      c.seq.update(dt, this.ctx, this.pose);
      this._timedCues(c);
      fade = c.seq.fade;
      // Sicherheit: nie in Geometrie/Spielern
      if (safeCameraPos(this.pose.pos)) {
        this.stats.clamped++;
        const nm = c.name + ':' + (c.seq.shot ? c.seq.shot.name : '?');
        this.stats.clampShots[nm] = (this.stats.clampShots[nm] || 0) + 1;
      }
      const pl = this.mode === 'replay' && this.replayState ? this.replayState.players : P;
      keepAwayFromPlayers(this.pose.pos, pl, 0.7);
      if (c.seq.done) this._finish(false);
    }
    if (!this._cur) {
      const bp = this.broadcast.update(dt, view);
      if (this._exit) {
        const ex = this._exit;
        ex.t += dt;
        const k = EASE.inOut2(saturate(ex.t / ex.dur));
        this.pose.lerp(ex.from, bp, k);
        if (ex.t >= ex.dur) this._exit = null;
      } else this.pose.copy(bp);
      if (this._fadeIn > 0) { fade = Math.max(fade, this._fadeIn / 0.35); this._fadeIn = Math.max(0, this._fadeIn - dt); }
    }
    this.fade = saturate(fade);
    this.letterbox += (this._lb - this.letterbox) * (1 - Math.exp(-dt * 3.5));
    if (dt <= 0) this.letterbox = this._lb;
    const qd = this.renderer && this.renderer.q ? this.renderer.q.dof !== false : true;
    applyPose(this.camera, this.pose, this.dofEnabled && qd);
    return this.camera;
  }

  // ================================================================ intern
  _aspect() {
    if (this._aspectOpt) return this._aspectOpt;
    const r = this.renderer;
    if (r) {
      if (r._aspect) return r._aspect;
      const c = r.canvas;
      if (c && c.clientHeight) return c.clientWidth / c.clientHeight;
    }
    return 16 / 9;
  }

  _emit(type, e) { this.events.emit(type, e); }

  _onShot(seqName, sh, i) {
    const c = this._cur;
    if (c) c.shotId = (c.shotId || 0) + 1;
    this._emit('shot', { seq: seqName, shot: sh.name, index: i });
    if (sh.cue) this._fireCue(seqName, sh.cue, i, sh.o.cueData);
  }

  _fireCue(seq, name, index, data) {
    const cue = { seq, name, index, data: data ?? null };
    this._emit('cue', cue);
    const c = this._cur;
    if (c && c.opts.onCue) c.opts.onCue(cue);
    for (let k = this._cueWaiters.length - 1; k >= 0; k--) {
      const w = this._cueWaiters[k];
      if (w.name === name && (!w.seq || w.seq === seq)) { this._cueWaiters.splice(k, 1); w.res(cue); }
    }
  }

  /** Zeitgesteuerte Stichworte innerhalb einer Einstellung: shot.o.cues = [{ t, name, data }]. */
  _timedCues(c) {
    const sh = c.seq.shot;
    if (!sh || !sh.o.cues) return;
    const t = c.seq.t;
    for (const q of sh.o.cues) {
      if (q._fired === c.shotId) continue;
      if (t >= q.t) { q._fired = c.shotId; this._fireCue(c.name, q.name, c.seq.index, q.data); }
    }
  }

  _finish(skipped, replaced = false) {
    const c = this._cur;
    if (!c) return;
    this._cur = null;
    const sh = c.seq.shot;
    if (sh) sh.end(this.ctx);
    if (c.spec.end) c.spec.end(skipped);
    this.mode = 'broadcast';
    this.timeScale = 1;
    this._lb = 0;
    this.broadcast.cut();
    const exit = c.opts.exit || c.spec.exit || 'cut';
    if (!replaced) {
      if (exit === 'blend' && !skipped) this._exit = { from: new CamPose().copy(this.pose), t: 0, dur: c.opts.exitTime || 1.4 };
      else if (exit === 'dip' || skipped) this._fadeIn = 0.35;
    }
    this._emit('sequence_end', { name: c.name, skipped });
    c.resolve({ name: c.name, skipped });
  }

  // ---------------------------------------------------------------- Subjekte
  _head(i, out) { return headPosOf(this.ctx.view, i, out); }
  /** Kopfmitte einer Figur in der Wiederholung (Figur trägt die abgespielte Pose); Rückfall: Position + Kopfhöhe. */
  _replayHead(targets, i, pos, out) {
    const c = targets.characters && targets.characters[i];
    if (c && typeof c.getHeadWorld === 'function') { c.getHeadWorld(out); if (isFinite(out[1]) && out[1] > 0.3) return out; }
    const p = this.ctx.view.players && this.ctx.view.players[i];
    out[0] = pos[0]; out[1] = (p ? headHeightOf(p) : 1.1); out[2] = pos[2];
    return out;
  }
  _player(i) { const P = this.ctx.view.players; return P && P[i] ? P[i] : null; }
  _winnerIdx(o) {
    if (o.player != null) return o.player;
    const v = this.ctx.view;
    if (v.state && v.state.pointWinner != null) return v.state.pointWinner;
    return v.humanIndex ?? 0;
  }

  /**
   * Nahaufnahme eines Spielers (Verfolgung, gedämpft): Kamera von vorn-seitlich auf der Sonnenseite,
   * Schärfe auf dem Kopf. o = { dist: [d0, d1], height: [h0, h1], fov, look (Höhe unter dem Kopf), aperture, side }
   */
  _closeupShot(i, o = {}) {
    const self = this;
    const dist = o.dist || [2.6, 2.2], height = o.height || [0.95, 1.05];
    const st = { ang: null, angS: new Spring(), yawS: new Spring() };
    const subject = (ctx, out) => headPosOf(ctx.view, i, out);
    return track({
      name: o.name || 'closeup', dur: o.dur ?? 3.2, trans: o.trans || 'cut', cue: o.cue, cueData: o.cueData, cues: o.cues,
      ease: o.ease || 'inOut', fov: o.fov ?? 30 * DEG, smooth: o.smooth ?? 0.45, smoothTarget: o.smoothTarget ?? 0.22,
      handheld: o.handheld ?? 0.012, seed: o.seed ?? (i * 7.3 + 2),
      dof: { aperture: o.aperture ?? 0.65, focus: (ctx, out) => headPosOf(ctx.view, i, out), rack: o.rack },
      begin(ctx) {
        const p = self._player(i);
        const yaw = p ? p.yaw : 0;
        const h = subject(ctx, _a);
        st.yaw = yaw + (o.yawOffset || 0);
        st.ang = o.angle != null ? o.angle : chooseCloseupAngle(h, st.yaw, dist[0], o.base ?? 32 * DEG, ctx.view.players, i, null, o.light ?? 0.6);
        st.angS.snap(st.ang); st.t = 0;
      },
      update(dt, ctx, shot) {
        // Verdeckung durch den anderen Spieler laufend prüfen und ggf. sanft umsetzen
        st.t += dt;
        if (o.angle == null && st.t > 0.25) {
          const h = subject(ctx, _a), d = dist[0];
          const occ = occlusion(h[0] + Math.sin(st.ang) * d, h[2] + Math.cos(st.ang) * d, h, ctx.view.players, i);
          // Spieler dreht sich deutlich (z.B. am Ende des Einlaufs) -> Kamera geht mit nach vorn
          const p = self._player(i);
          const turned = p && Math.abs(Math.atan2(Math.sin(p.yaw - st.yaw), Math.cos(p.yaw - st.yaw))) > 55 * DEG;
          if (turned) st.yaw = p.yaw + (o.yawOffset || 0);
          if (occ > 0.3 || turned) { st.ang = chooseCloseupAngle(h, st.yaw, d, o.base ?? 32 * DEG, ctx.view.players, i, st.ang, o.light ?? 0.6); st.t = 0; }
        }
        // Winkel als stetige Größe nachführen (kein Sprung über ±π); große Wechsel = Schnitt
        const da = Math.atan2(Math.sin(st.ang - st.angS.v), Math.cos(st.ang - st.angS.v));
        if (Math.abs(da) > 95 * DEG) { st.angS.snap(st.ang); if (shot) shot._init = false; }
        else st.angS.update(st.angS.v + da, 1.1, dt, 1.6);
      },
      subject,
      place(ctx, s, u, outP, outT) {
        const d = lerp(dist[0], dist[1], u), hh = lerp(height[0], height[1], u);
        const a = st.angS.v + (o.orbit ? lerp(o.orbit[0], o.orbit[1], u) : 0);
        const pl = self._player(i), ground = pl ? (pl.pos[1] || 0) : 0;
        outP[0] = s[0] + Math.sin(a) * d; outP[1] = ground + hh; outP[2] = s[2] + Math.cos(a) * d;
        pullIn(outP, s);
        const look = o.look ?? 0.12;
        outT[0] = s[0]; outT[1] = s[1] - look; outT[2] = s[2];
        // Blick leicht an der Figur vorbei (Raum in Blickrichtung lassen)
        const lx = Math.cos(a), lz = -Math.sin(a), side = o.lead ?? 0.12;
        outT[0] += lx * side; outT[2] += lz * side;
      },
    });
  }

  // ================================================================ Sequenzen
  /** Titel-Überflug (Endlosschleife): Luftbild, Kranfahrt durch die Dachöffnung, Netzfahrt, Tribüne, Abstieg. */
  _seqTitle(o) {
    const shots = [
      // Luftbild von Westen (Sonne seitlich von rechts hinten), zwischen den Flutlichtmasten
      orbit({ name: 'aerial', dur: 7.5, trans: 'dip', ease: 'linear', center: [0, 0, 0], radius: [54, 46], height: [64, 55],
        angle: [252 * DEG, 284 * DEG], look: [0, -2], fov: 44 * DEG }),
      // Kranfahrt über der Südost-Ecke hinab, Blick in die tiefe Sonne (Gegenlicht, lange Schatten)
      crane({ name: 'crane_in', dur: 7.0, trans: { type: 'dip', time: 1.1 },
        from: { pos: [17, 30, 19], tgt: [-2, 2, -4] }, to: { pos: [9.6, 8.6, 19.6], tgt: [-1.2, 0.4, -4.5] }, fov: [48 * DEG, 42 * DEG] }),
      // tiefe Seitwärtsfahrt hinter der Nord-Grundlinie, Blick über den ganzen Platz auf den sonnigen Südpavillon
      spline({ name: 'baseline_slide', dur: 6.5, trans: { type: 'dip', time: 1.1 }, ease: 'linear',
        pos: [[-3.8, 1.0, -16.4], [3.8, 1.1, -16.2]], tgt: [[-1.2, 0.5, 10], [1.2, 0.6, 10]], fov: 36 * DEG, handheld: 0.004 }),
      // seitliche Fahrt am Westrand, Blick schräg auf die sonnige Osttribüne
      spline({ name: 'stands', dur: 6.5, trans: { type: 'dip', time: 1.1 }, ease: 'linear',
        pos: [[-5.4, 1.45, -8.5], [-5.4, 1.6, 5.5]], tgt: [[12, 4.3, 0.5], [12, 4.9, 14.5]], fov: 40 * DEG }),
      // Abstieg von außen durch die Dachöffnung bis tief hinter die Grundlinie
      spline({ name: 'descend', dur: 9.0, trans: { type: 'dip', time: 1.1 }, ease: 'glide',
        pos: [[-64, 40, 16], [-36, 33, 11], [-13, 19, 8], [-3.2, 1.6, 15.6]],
        tgt: [[0, 0, 0], [0, 0, 0], [0, 0.6, 2], [0.2, 1.1, 0]], fov: [46 * DEG, 42 * DEG] }),
    ];
    return { shots, loop: true, letterbox: o.letterbox ?? 0, entryDip: true, mode: 'cinematic' };
  }

  /**
   * Einlauf: Totale, dann je Spieler eine Nahaufnahme (Stichwort 'player' {index} für die Vorstellungskarte),
   * zum Schluss Kranfahrt in die Übertragungsposition. o = { order: [0,1], onCue }
   */
  _seqIntro(o) {
    const order = o.order || [0, 1];
    const s = this._side;
    const shots = [];
    // Totale: Kran aus der Ecke über der Tribüne (Schiedsrichterseite gegenüber, Sonnenlicht von hinten)
    shots.push(crane({ name: 'wide', cue: 'wide', dur: o.wideDur ?? 3.8,
      from: { pos: [14.0, 15.0, 24.0 * s], tgt: [0.5, 0, 0.5 * s] }, to: { pos: [10.5, 7.8, 20.6 * s], tgt: [-1.6, 0.8, -2.0 * s] },
      fov: [44 * DEG, 40 * DEG] }));
    order.forEach((idx, k) => {
      shots.push(this._closeupShot(idx, {
        name: 'player', cue: 'player', cueData: { index: idx }, dur: o.playerDur ?? 3.5, trans: k === 0 ? 'dip' : 'cut',
        dist: [3.1, 2.25], height: [1.05, 1.15], fov: 28 * DEG, aperture: 0.75, look: 0.18,
        rack: [14, (ctx, out) => headPosOf(ctx.view, idx, out), 0.2, 1.4], orbit: [-6 * DEG, 6 * DEG],
      }));
    });
    // Abschluss: von tief hinter der Grundlinie in die Übertragungsposition
    const self = this;
    const fin = new CamPose();
    shots.push(custom({
      name: 'to_broadcast', cue: 'versus', dur: o.finalDur ?? 3.0, trans: 'dip', ease: 'inOut2',
      begin() { self.broadcast.cut(); fin.copy(self.broadcast.update(0, self.ctx.view)); },
      frame(u, t, ctx, pose) {
        const start = _b;
        vec3.set(start, 2.2 * s, 1.25, (HL + 3.6) * s);
        // erst steigen, dann zurückfahren (über Mauer und Tribünenreihen hinweg)
        const r = saturate(t / this.dur), ky = EASE.inOut(Math.min(1, r * 1.35)), kxz = EASE.inOut2(r);
        pose.pos[0] = lerp(start[0], fin.pos[0], kxz); pose.pos[1] = lerp(start[1], fin.pos[1], ky); pose.pos[2] = lerp(start[2], fin.pos[2], kxz);
        // Ziel: anfangs ferner Spieler, am Ende Übertragungsziel
        const far = self._player(order[order.length - 1]);
        const fx = far ? far.pos[0] : 0, fz = far ? far.pos[2] : -HL * s;
        vec3.set(_c, fx, 1.2, fz);
        for (let k = 0; k < 3; k++) pose.tgt[k] = lerp(_c[k], fin.tgt[k], EASE.inOut(u));
        pose.fov = lerp(30 * DEG, fin.fov, u);
      },
    }));
    return { shots, letterbox: o.letterbox ?? 1, mode: 'cinematic', exit: 'cut', entryDip: o.entryDip ?? true };
  }

  /** Nahaufnahme zwischen den Punkten. o = { player, emote, walk?: bool, dur } */
  _seqCloseup(o) {
    const i = this._winnerIdx(o);
    const emote = o.emote || (this._player(i) && this._player(i).emote) || null;
    const positive = o.walk ? false : (emote ? POSITIVE.has(emote) : true);
    const sh = positive
      ? this._closeupShot(i, { name: 'closeup', cue: 'closeup', cueData: { index: i, emote }, dur: o.dur ?? 3.4,
        dist: [2.7, 2.15], height: [0.72, 0.85], fov: 30 * DEG, aperture: 0.7, look: 0.22, orbit: [-5 * DEG, 5 * DEG] })
      : this._closeupShot(i, { name: 'walkback', cue: 'closeup', cueData: { index: i, emote }, dur: o.dur ?? 3.4,
        dist: [3.4, 3.0], height: [1.35, 1.4], fov: 25 * DEG, aperture: 0.6, look: 0.1, smooth: 0.6, base: 20 * DEG });
    return { shots: [sh], letterbox: 0, mode: 'cinematic', exit: o.exit || 'cut' };
  }

  /** Seitenwechsel: hohe Totale mit langsamer Fahrt, dann Blick über den Schiedsrichter auf die gehenden Spieler. */
  _seqChangeEnds(o) {
    const self = this;
    const mid = (ctx, out) => {
      const P = ctx.view.players || [];
      if (P.length >= 2) vec3.set(out, (P[0].pos[0] + P[1].pos[0]) * 0.5, 1.1, (P[0].pos[2] + P[1].pos[2]) * 0.5);
      else vec3.set(out, 0, 1, 0);
      return out;
    };
    // Spieler gehen zur Bankseite: Seite aus ihrer aktuellen Position ableiten
    const P = this.ctx.view.players || [];
    const bx = P.length >= 2 ? Math.sign((P[0].pos[0] + P[1].pos[0]) || 1) : 1;
    const wide = track({
      name: 'wide', cue: 'wide', dur: o.wideDur ?? 2.6, ease: 'linear', fov: [42 * DEG, 40 * DEG], smooth: 0.9, smoothTarget: 0.6,
      subject: mid,
      place(ctx, s, u, outP, outT) {
        // hoch über der gegenüberliegenden Tribüne, langsame seitliche Fahrt
        vec3.set(outP, -bx * 15.5, 12.5, lerp(-7, 7, u) * self._side);
        vec3.set(outT, s[0] * 0.6, 0.4, s[2] * 0.5);
      },
    });
    // zweite Einstellung: halbnahe Verfolgung des (menschlichen) Spielers auf dem Weg zur Bank
    const hi = o.player ?? (this.ctx.view.humanIndex ?? 0);
    const second = this._closeupShot(hi, {
      name: 'walk', cue: 'walk', cueData: { index: hi }, dur: o.walkDur ?? 2.6, dist: [4.4, 3.9], height: [1.35, 1.4],
      fov: 24 * DEG, aperture: 0.55, look: 0.3, smooth: 0.6, base: 24 * DEG, handheld: 0.014, lead: 0.2,
    });
    return { shots: [wide, second], letterbox: 0, mode: 'cinematic', exit: o.exit || 'cut', untilPhase: o.untilPhase === undefined ? 'change_ends' : o.untilPhase };
  }

  /**
   * Hawk-Eye: tiefe Kamera an der Linie, Blick entlang der Linie, langsame Fahrt auf den Abdruck zu.
   * o = { pos, verdict: 'in'|'out', distanceMm, serverSide?, box?, dir?, dur }
   */
  _seqHawkeye(o) {
    const p = o.pos || [0, 0, HL];
    const ld = lineDistance(p[0], p[2], o.serverSide ? { serverSide: o.serverSide, box: o.box } : {});
    // Richtung entlang der Linie (Kamera schaut nach außen bzw. Richtung Grundlinie)
    let ax, az, lx, lz;
    if (ld.axis === 'z') {            // Grund-/Aufschlaglinie verläuft in x
      const sx = Math.abs(p[0]) > 0.3 ? Math.sign(p[0]) : 1;
      ax = sx; az = 0; lx = p[0]; lz = ld.lineZ;
    } else {                          // Seiten-/Mittellinie verläuft in z
      const sz = Math.sign(p[2]) || 1;
      ax = 0; az = sz; lx = ld.lineX; lz = p[2];
    }
    // Startpunkt hoch über dem Platzinneren, dann Abstieg auf die Linie und langsame Fahrt auf den Abdruck
    const inX = ld.axis === 'z' ? 0 : -(Math.sign(lx) || 1), inZ = ld.axis === 'z' ? -(Math.sign(lz) || 1) : 0;
    const mark = [p[0], 0.0, p[2]];
    const aim = [p[0] + ax * 0.12, 0.0, p[2] + az * 0.12];
    const P0 = [lx - ax * 6.5 + inX * 3.5, 6.8, lz - az * 6.5 + inZ * 3.5];
    const P1 = [lx - ax * 2.9, 0.5, lz - az * 2.9];
    const P2 = [lx - ax * 1.2, 0.42, lz - az * 1.2];
    const world = this.world;
    const verdict = o.verdict ?? (ld.in ? 'in' : 'out');
    const dir = o.dir || null;
    // Weg: Bogen (quadratische Bézierkurve, kommt waagerecht entlang der Linie an) + langsame Fahrt auf den Abdruck.
    // Zeitverlauf s(t) als monotone Hermite-Kurve: schneller Abstieg, dann ruhiges Heranschieben ohne Stillstand.
    const C = [P1[0] - ax * 2.4, P1[1] + 0.05, P1[2] - az * 2.4];
    const lenA = vec3.distance(P0, C) * 0.5 + vec3.distance(C, P1) * 0.5, lenB = vec3.distance(P1, P2);
    const sJ = lenA / (lenA + lenB), tJ = 0.42;
    const herm = (t, t0, t1, s0, s1, v0, v1) => {
      const h = t1 - t0, x = (t - t0) / h, x2 = x * x, x3 = x2 * x;
      return (2 * x3 - 3 * x2 + 1) * s0 + (x3 - 2 * x2 + x) * h * v0 + (-2 * x3 + 3 * x2) * s1 + (x3 - x2) * h * v1;
    };
    const vJ = (1 - sJ) / (1 - tJ) * 0.9;
    const dur = o.dur ?? 4.6;
    const sh = custom({
      name: 'hawkeye', dur, ease: 'linear', cue: 'hawkeye', cueData: { verdict, distanceMm: o.distanceMm ?? null },
      cues: [{ t: dur * tJ + 0.25, name: 'verdict', data: { verdict, distanceMm: o.distanceMm ?? Math.round(Math.abs(ld.dist) * 1000) } }],
      fov: [42 * DEG, 25 * DEG],
      dof: { aperture: [0.0, 0.32], focus: mark },
      frame(u, t, ctx, pose) {
        const sp = u < tJ ? herm(u, 0, tJ, 0, sJ, 0, vJ) : herm(u, tJ, 1, sJ, 1, vJ, 0);
        if (sp < sJ) {
          const q = sp / sJ, q1 = 1 - q;
          for (let k = 0; k < 3; k++) pose.pos[k] = q1 * q1 * P0[k] + 2 * q1 * q * C[k] + q * q * P1[k];
        } else {
          const q = (sp - sJ) / (1 - sJ);
          for (let k = 0; k < 3; k++) pose.pos[k] = P1[k] + (P2[k] - P1[k]) * q;
        }
        const w = EASE.inOut(saturate(u / tJ));
        for (let k = 0; k < 3; k++) pose.tgt[k] = mark[k] + (aim[k] - mark[k]) * w;
      },
      begin() {
        if (!world || !world.marks || !world.marks.hawkeye) return;
        world.marks.hawkeye(mark, verdict, dir);
        // Adapter: ballfx setzt bounds.center in Weltkoordinaten, der Renderer erwartet lokale -> Nahaufnahme würde
        // die Markierung wegschneiden. Lokale Kugel um den Ursprung setzen.
        for (const d of world.marks.drawables || []) {
          if (d && d.material && d.material.name === 'env-hawkeye' && d.model && d.bounds) d.bounds = { center: [0, 0, 0], radius: 1.0 };
        }
      },
      end() { if (!o.keep && world && world.marks && world.marks.clearHawkeye) world.marks.clearHawkeye(); },
    });
    return { shots: [sh], letterbox: 0, mode: 'cinematic', exit: o.exit || 'cut' };
  }

  /** Matchende: Orbit um den Sieger, stehendes Publikum, Pokal-Moment. o = { winner, loop } */
  _seqMatchEnd(o) {
    const w = o.winner ?? this._winnerIdx(o);
    const self = this;
    const wp = this._player(w);
    const yaw0 = wp ? wp.yaw : 0;
    const center = (ctx, out) => { const p = self._player(w); if (p) vec3.set(out, p.pos[0], 0, p.pos[2]); else vec3.set(out, 0, 0, 0); return out; };
    const hh = headHeightOf(wp);
    const a0 = chooseCloseupAngle(this._head(w, _a), yaw0, 3, 40 * DEG, this.ctx.view.players, w);
    // Schwenkrichtung so wählen, dass der Orbit möglichst frei bleibt (Netz/Mauer/Stuhl)
    const wpos = wp ? wp.pos : [0, 0, 0];
    const sweepCost = (from, to) => {
      let c = 0;
      for (let k = 0; k <= 10; k++) {
        const a = lerp(from, to, k / 10), x = wpos[0] + Math.sin(a) * 3.6, z = wpos[2] + Math.cos(a) * 3.6;
        c += Math.max(0, minCameraY(x, z) - 0.9) + closeupPenalty([x, 1, z], wpos);
      }
      return c;
    };
    const sw = sweepCost(a0 + 50 * DEG, a0 - 25 * DEG) <= sweepCost(a0 - 50 * DEG, a0 + 25 * DEG) ? 1 : -1;
    const sx = wp && wp.pos[0] > 0 ? -1 : 1;
    const shots = [
      orbit({ name: 'winner', cue: 'winner', cueData: { index: w }, dur: 4.2, trans: 'dip', ease: 'linear', center, safe: true,
        radius: [3.9, 3.3], height: [0.8, 1.05], angle: [a0 + sw * 50 * DEG, a0 - sw * 25 * DEG], look: [hh - 0.4, hh - 0.35], fov: 36 * DEG,
        dof: { aperture: 0.75, focus: (ctx, out) => headPosOf(ctx.view, w, out) }, handheld: 0.01 }),
      spline({ name: 'crowd_east', cue: 'crowd', dur: 3.2, trans: 'dip', ease: 'linear',
        pos: [[1.5, 1.3, -7.8], [1.5, 1.45, -1.6]], tgt: [[20, 5.6, -11], [20, 7.2, -3]], fov: 36 * DEG, handheld: 0.012 }),
      spline({ name: 'crowd_south', cue: 'crowd', dur: 2.8, trans: 'cut', ease: 'linear',
        pos: [[sx * 2.5, 1.4, 4.0], [sx * 1.0, 1.5, 5.2]], tgt: [[sx * -1.0, 4.8, 26], [sx * 1.5, 7.6, 26]], fov: 40 * DEG }),
      // Pokal-Moment: von hinten-seitlich, Sieger vor dem stehenden Publikum, langsame Kranfahrt nach oben
      this._closeupShot(w, { name: 'trophy', cue: 'trophy', cueData: { index: w }, dur: 4.6, trans: 'dip', yawOffset: Math.PI,
        dist: [4.6, 3.9], height: [0.7, 1.9], fov: 38 * DEG, aperture: 0.3, look: 0.2, lead: -0.35, base: 22 * DEG, handheld: 0.006 }),
    ];
    return { shots, letterbox: o.letterbox ?? 1, mode: 'cinematic', exit: o.exit || 'dip', loop: !!o.loop, entryDip: true };
  }

  /**
   * Zeitlupen-Wiederholung aus 2–3 Perspektiven. o = { recording?, from?, to?, highlightT?, angles?: ['side','hitter','high'],
   *   characters?, ball?, slow: 0.3, maxDur: 9 }. Ohne recording wird der letzte Punkt aus dem Rekorder geschnitten.
   * Während der Wiederholung: mode = 'replay', timeScale = 0; Ball/Figuren werden von der Regie gesetzt.
   */
  _seqReplay(o) {
    const rec = o.recording || (this.recorder ? this.recorder.clipLastPoint(o.maxClip ?? 9) : null);
    if (!rec || rec.n < 4) return null;
    const rp = new ReplayPlayer(rec);
    const hl = rec.highlight();
    if (o.highlightT != null) { hl.t = o.highlightT; hl.hitT = o.highlightT; hl.t0 = o.highlightT - 0.35; hl.t1 = o.highlightT + 0.8; }
    const T0 = rec.t0, T1 = rec.t1;
    const slow = o.slow ?? 0.38;
    const hitT = clamp(hl.hitT ?? hl.t, T0, T1);
    const endT = clamp(hl.bounceT != null ? Math.min(hl.bounceT + 0.3, hitT + 1.0) : Math.min(hl.t1, hitT + 0.9), hitT + 0.3, T1);
    // Zeitlupenfenster: kurz vor dem entscheidenden Schlag bis kurz nach dem Aufsprung
    const w0 = clamp(hitT - 0.22, T0, T1), w1 = clamp(endT, w0 + 0.1, T1);
    const speed = (tau) => {
      const r = 0.28;
      const k = saturate((tau - (w0 - r)) / r) * saturate(((w1 + r) - tau) / r);
      return lerp(1, slow, k * k * (3 - 2 * k));
    };
    const durOf = (a, b) => { let d = 0; for (let t = a; t < b; t += 1 / 120) d += (1 / 120) / speed(t); return d; };
    const targets = { characters: o.characters || this.ctx.view.characters || null, ball: o.ball || (this.world ? this.world.ball : null), dt: 0 };
    const self = this;
    const st = { tau: T0, a: T0, b: T1 };
    const rs = { ball: rp.ballState, players: rp.chars.map((c, i) => ({ pos: c.pos, yaw: 0, side: 0, id: (this.ctx.view.players[i] || {}).id })) };
    const syncRS = () => { for (let i = 0; i < rs.players.length; i++) rs.players[i].yaw = rp.chars[i].yaw; };
    const seekTo = (tau, dt) => { st.tau = tau; targets.dt = dt; rp.seek(tau, targets); syncRS(); };
    const resetTrail = () => { const b = targets.ball; if (b && typeof b.update === 'function') b.update(0, { pos: rp.ballState.pos, visible: false }); };
    const mkUpdate = () => (dt) => {
      if (dt <= 0) return;
      const nt = Math.min(st.b, st.tau + dt * speed(st.tau));
      seekTo(nt, nt - st.tau);
    };
    const hitter = hl.player >= 0 && hl.player < rp.chars.length ? hl.player : 0;
    const angles = o.angles || ['side', 'hitter'];
    const shots = [];
    const ump = this.anchors.umpire;
    const sideX = ump ? -Math.sign(ump.position[0]) || 1 : 1;     // Kamera auf der dem Schiedsrichter gegenüberliegenden Seite
    for (let k = 0; k < angles.length; k++) {
      const kind = angles[k];
      let a, b;
      if (kind === 'side') { a = Math.max(T0, o.from ?? (hitT - (angles.length > 1 ? 1.1 : 2.4))); b = Math.min(T1, o.to ?? (w1 + 0.25)); }
      else if (kind === 'hitter') { a = Math.max(T0, hitT - 0.6); b = Math.min(T1, w1); }
      else { a = Math.max(T0, hitT - 0.5); b = Math.min(T1, w1 + 0.35); }
      if (b <= a + 0.2) continue;
      const dur = durOf(a, b) + 0.2;
      const ballS = [new Spring(), new Spring(), new Spring()];
      const fovS = new Spring(32 * DEG), railS = new Spring();
      let lastT = 0;
      const common = {
        name: 'replay_' + kind, dur, trans: k === 0 ? 'cut' : { type: 'dip', time: 0.45 }, ease: 'linear',
        cue: k === 0 ? 'replay_start' : 'replay_angle', cueData: { angle: kind, index: k },
        begin() {
          st.a = a; st.b = b; lastT = 0; resetTrail(); seekTo(a, 0);
          const bp = rp.ballState.visible ? rp.ballState.pos : rp.chars[hitter].pos;
          for (let j = 0; j < 3; j++) ballS[j].snap(bp[j]);
          railS.snap(clamp(bp[2] * 0.55, -7.5, 7.5));
        },
        update: mkUpdate(),
      };
      const dtOf = (t) => { const d = Math.max(0, t - lastT); lastT = t; return d; };
      // geglätteter Ball (unsichtbar: Schläger des Treffers)
      const ballSm = (dt, smooth = 0.14) => {
        const bp = rp.ballState.visible ? rp.ballState.pos : rp.chars[hitter].pos;
        for (let j = 0; j < 3; j++) ballS[j].update(j === 1 && !rp.ballState.visible ? 1.0 : bp[j], smooth, dt);
        return vec3.set(_c, ballS[0].v, ballS[1].v, ballS[2].v);
      };
      if (kind === 'side') {
        // erhöhte Seitenkamera an der Bande (über Netzpfosten/Balljungen hinweg), fährt auf einer Schiene mit;
        // Bildausschnitt: Ball + Bezugsspieler (vor dem Treffer der Schlagende, danach der Gegner)
        const subj = vec3.create(), top = vec3.create(), extra = [top];
        shots.push(custom({ ...common,
          frame(u, t, ctx, pose) {
            const dt = dtOf(t);
            const bs = ballSm(dt);
            const who = st.tau < hitT + 0.15 ? hitter : 1 - hitter;
            const cp = rp.chars[who] ? rp.chars[who].pos : bs;
            self._replayHead(targets, who, cp, top);
            subj[0] = cp[0]; subj[1] = top[1] * 0.62; subj[2] = cp[2];      // Körpermitte
            top[1] += 0.3;                                                  // Scheitel (+ Luft) muss ins Bild
            const mz = (bs[2] + subj[2]) * 0.5;
            const z = railS.update(clamp(mz * 0.6, -7.5, 7.5), 0.5, dt);
            vec3.set(pose.pos, sideX * (LAYOUT.wallX - 0.45), 2.6, z);
            _b[0] = bs[0]; _b[1] = clamp(bs[1], 0.3, 4.5); _b[2] = bs[2];
            const f = frameTwo(pose.pos, _b, subj, 0.55, pose.tgt, 26 * DEG, 46 * DEG, self._aspect(), 1.25, extra);
            pose.tgt[1] = pose.tgt[1] * 0.8 + 0.2;
            pose.fov = t === 0 ? fovS.snap(f) : fovS.update(f, 0.65, dt);
          } }));
      } else if (kind === 'hitter') {
        // tief hinter dem Schlagenden, deutlich seitlich versetzt (über die Schulter): Spieler im Drittel,
        // vor dem Treffer der ankommende Ball, danach dem Ball nach in Richtung Gegner
        const hp = vec3.create(), chest = vec3.create(), head = vec3.create(), top = vec3.create(), extra = [top];
        let hs = 1, sx = 1, camY = 1.55;
        shots.push(custom({ ...common,
          begin() {
            common.begin(); vec3.copy(hp, rp.sampleChar(hitter, hitT).pos); hs = Math.sign(hp[2]) || 1; sx = hp[0] > 0.3 ? -1 : 1;
            self._replayHead(targets, hitter, hp, head);
            camY = head[1] + 0.35;                        // knapp über Kopfhöhe der Figur (Chibi ~1.4 m)
          },
          frame(u, t, ctx, pose) {
            const dt = dtOf(t);
            const bs = ballSm(dt, 0.1);
            const push = EASE.inOut(u) * 0.9;
            vec3.set(pose.pos, hp[0] + sx * 2.3, camY, clamp(hp[2] + hs * (4.6 - push), -LAYOUT.wallZ + 0.5, LAYOUT.wallZ - 0.5));
            const ch = rp.chars[hitter].pos;
            self._replayHead(targets, hitter, ch, head);
            chest[0] = ch[0]; chest[1] = head[1] * 0.75; chest[2] = ch[2];
            top[0] = head[0]; top[1] = head[1] + 0.3; top[2] = head[2];   // ganzer Kopf im Bild
            const after = saturate((st.tau - hitT) / 0.6);
            const w = after * after * (3 - 2 * after);
            // Ball nach dem Treffer: nicht weiter als 14 m vorausschauen (Gegner bleibt erreichbar)
            _b[0] = bs[0]; _b[1] = clamp(bs[1], 0.4, 3.5); _b[2] = bs[2];
            const f = frameTwo(pose.pos, chest, _b, lerp(0.55, 0.3, w), pose.tgt, 24 * DEG, 44 * DEG, self._aspect(), 1.15, extra);
            pose.fov = t === 0 ? fovS.snap(f) : fovS.update(f, 0.3, dt);
            pose.aperture = 0.22; pose.focus = Math.hypot(head[0] - pose.pos[0], head[1] - pose.pos[1], head[2] - pose.pos[2]);
          } }));
      } else {
        // hohe Gegenrichtung (Rückwärtsperspektive zur Übertragung)
        const s = this._side;
        shots.push(custom({ ...common, fov: 42 * DEG,
          frame(u, t, ctx, pose) {
            const dt = dtOf(t);
            const bs = ballSm(dt, 0.25);
            vec3.set(pose.pos, clamp(bs[0] * 0.25, -2.5, 2.5), 11.5, -s * 23.5);
            vec3.set(pose.tgt, bs[0] * 0.5, 0, clamp(bs[2] * 0.4, -7, 7) + s * 2.5);
          } }));
      }
    }
    if (!shots.length) return null;
    return {
      shots, mode: 'replay', timeScale: 0, letterbox: 0, exit: o.exit || 'dip',
      start() { self.replay = rp; self.replayState = rs; self.ctx.rp = rp; self.ctx.rs = rs; },
      end() { resetTrail(); self.replay = null; self.replayState = null; self.ctx.rp = null; self.ctx.rs = null; self._fireCue('replay', 'replay_end', -1, null); },
    };
  }

  // ================================================================ automatische Regie (optional)
  /**
   * Einfache TV-Regie: nach jedem Punkt Nahaufnahme des Gewinners; bei knappen Bällen Hawk-Eye;
   * bei großen Punkten (lange Ballwechsel, Asse, Gewinnschläge bei wichtigen Punkten) Zeitlupe;
   * Seitenwechsel- und Matchende-Sequenzen.
   */
  _autoDirect(dt, view) {
    const A = this._auto;
    if (view.events) {
      for (const e of view.events) {
        if (e.type === 'line_call' && e.closeCall) A.closeCall = e.closeCall;
        if (e.type === 'point') {
          A.lastPoint = e; A.n = (A.n || 0) + 1;
          const cc = e.closeCall || A.closeCall;
          A.closeCall = null;
          const great = e.reason === 'winner' || e.reason === 'ace' || e.reason === 'service_winner';
          const big = !!e.bigPoint;
          const wantReplay = (great && (e.rally >= 5 || big)) || e.rally >= 14 || (big && e.rally >= 4);
          const sinceReplay = A.n - (A.lastReplay ?? -9);
          let kind;
          if (cc) kind = 'hawkeye';
          else if (wantReplay && (sinceReplay >= 3 || big)) { kind = 'replay'; A.lastReplay = A.n; }
          else if (e.reason === 'double_fault') kind = 'walk';
          else kind = (A.n % 2 === 0 || great || big) ? 'closeup' : null;
          A.pending = kind ? { kind, t: 0, e, cc } : null;
        }
        if (e.type === 'match') A.pending = { kind: 'match_end', t: 0, e };
      }
    }
    if (view.phase !== A.lastPhase) {
      if (view.phase === 'change_ends') A.changeEnds = true;
      A.lastPhase = view.phase;
    }
    if (view.phase !== 'change_ends') A.changeEnds = false;
    if (this._cur) return;
    if (A.changeEnds && (!A.pending || A.pending.kind !== 'match_end')) {
      A.changeEnds = false; A.pending = null;
      this.play('change_ends', {});
      return;
    }
    if (!A.pending) return;
    A.pending.t += dt;
    const p = A.pending;
    // Nur während der Pause zwischen den Punkten (nicht mehr, wenn der nächste Aufschlag läuft)
    if (p.kind !== 'match_end' && (view.phase === 'serve' || view.phase === 'rally')) { A.pending = null; return; }
    if ((p.kind === 'closeup' || p.kind === 'walk') && p.t > 0.55) {
      A.pending = null;
      const i = p.kind === 'walk' ? p.e.loser ?? (1 - p.e.winner) : p.e.winner;
      const em = (view.players[i] && view.players[i].emote) || (p.kind === 'walk' ? 'dejected' : 'fistpump');
      this.play('closeup', { player: i, emote: em, walk: p.kind === 'walk', dur: 2.8 });
    } else if (p.kind === 'hawkeye' && p.t > 0.4) {
      A.pending = null;
      const cc = p.cc;
      this.play('hawkeye', { pos: cc.pos, verdict: cc.in ? 'in' : 'out', distanceMm: cc.distanceMm, dur: 4.0 });
    } else if (p.kind === 'replay' && p.t > 1.0) {
      A.pending = null;
      this.play('replay', {});
    } else if (p.kind === 'match_end' && p.t > 1.2) {
      A.pending = null;
      this.play('match_end', { winner: p.e.winner, loop: true });
    }
  }
}

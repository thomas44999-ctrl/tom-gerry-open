// Match: komplette Spiellogik eines Einzels (Phasen, Aufschlag, Ballwechsel, Regeln, Punkte, Seitenwechsel).
// Reine Logik (kein DOM/WebGL), deterministisch mit Seed, intern fester 120-Hz-Takt.
// Vertrag: ARCHITECTURE.md §7. Ereignisse über drainEvents().

import { COURT, inServiceBox, isInSingles, serverPosition, receiverPosition, lineDistance, footprintRadius, describeServeMiss, describeMiss } from '../sim/court.js';
import { Ball, BALL, predict, RPM } from '../sim/ball.js';
import { serveTarget, solveShot } from '../sim/shot.js';
import { Score } from '../sim/rules.js';
import { STROKES, SERVE, CHARGE, HIT, strokeContactWorld } from '../sim/strokes.js';
import { Player, Rng, planIntercept, contactQuality, strokeQuality, resolveShot, previewShot, strokeKey, rotateVel, assistOf, hitRadius, lungeOf, contactAt } from './player.js';
import { AIController } from './ai.js';

export const MATCH_DT = 1 / 120;
const HL = COURT.halfLength;
const SW = COURT.singlesHalfWidth;
const G = BALL.g;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

/** Phasendauern (s). */
export const TIMING = {
  pointOver: 1.8, pointOverMin: 0.6,
  betweenPoints: 0.5, betweenMin: 0.15,
  changeEnds: 4.0, changeEndsMin: 0.8,
  changeEndsQuick: 1.1,           // Seitenwechsel ohne Gang zur Bank (Schnitt in der Blende)
  preServeMin: 0.9, preServeMax: 5.5,
  faultPause: 1.15, letPause: 1.3,
  readyMin: 0.45,                 // Mindestzeit Ball tippen vor dem Ballwurf
  bouncePeriod: 0.62,             // Ball tippen (Periode)
  replanEvery: 0.1,
};

const SHOT_BUTTONS = ['topspin', 'slice', 'lob', 'drop'];

/** Leere PlayerInput-Struktur. */
export function makeInput() {
  return { move: [0, 0], aim: [0, 0], buttons: { topspin: false, slice: false, lob: false, drop: false }, skip: false };
}
const NEUTRAL = makeInput();

const _v3 = new Float64Array(3), _w3 = new Float64Array(3), _q = {}, _md = {}, _ld = {};
const _sv = { requested: {}, landing: {}, vel: new Float64Array(3), spin: new Float64Array(3) };
const _shot = {};

export class Match {
  /**
   * opts = { players: ['tom','gerry'], humans: [0], format, difficulty: 'easy'|'normal'|'hard' | [d0, d1], seed,
   *          assist?: 'off'|'light'|'strong' (Laufhilfe für Menschen, Standard 'light'), breakOnHit?: false,
   *          names?: ['Tom','Gerry'], surface? }
   * breakOnHit: step() endet nach dem Takt eines Treffers (Rest bleibt im Akkumulator) – die Darstellung kann so genau
   * das Bild des Kontakts zeigen (Schläger am Ball, Treffer-Stopp).
   */
  constructor(opts = {}) {
    const ids = opts.players || ['tom', 'gerry'];
    this.humans = (opts.humans || [0]).slice();
    const diffs = Array.isArray(opts.difficulty) ? opts.difficulty : [opts.difficulty || 'normal', opts.difficulty || 'normal'];
    this.seed = (opts.seed ?? 1) >>> 0;
    this.rng = new Rng(this.seed * 2654435761 + 17);
    this.assist = opts.assist || 'light';
    this.players = ids.map((id, i) => new Player(i, id, { human: this.humans.includes(i), difficulty: diffs[i], assist: this.assist }));
    this.breakOnHit = !!opts.breakOnHit;
    this._hitTick = false;
    const names = opts.names || this.players.map((p) => p.name);
    this.score = new Score(names, opts.format || {});
    this.ball = new Ball();
    if (opts.surface) this.ball.surface = opts.surface;
    // Neuer Punkt: Spieler stehen sofort auf ihren Positionen (kein Zurücklaufen); false = alter Gang zur Grundlinie
    this.instantReset = opts.instantReset !== false;
    this.ai = this.players.map((p, i) => (p.human ? null : new AIController(this, i, diffs[i], this.seed * 7919 + i * 104729 + 3)));
    this.events = [];
    this.time = 0;
    this._acc = 0;
    this._prevButtons = [{}, {}];
    this._cur = [NEUTRAL, NEUTRAL];
    this._pressed = [{ any: false, shot: null }, { any: false, shot: null }];
    this._skipPrev = [false, false];
    this._inputs = [NEUTRAL, NEUTRAL];
    for (let i = 0; i < 2; i++) this.players[i].side = this.score.sides[i];
    // Ball-/Ballwechsel-Zustand
    this.rally = {
      active: false, isServe: false, lastHitter: -1, hits: 0, bounces: 0, firstBounce: null, netTouched: false,
      serveTouchedNet: false, decided: false, launchTime: 0, shotId: 0, lastShot: null, closeCall: null,
      receiverTouched: false, serveKmh: 0, faultKmh: 0,
    };
    this.serveNo = 1;
    this.srv = { state: 'none', t: 0, tossTime: 0, contactTime: 0, idealPress: 0, tIdeal: 0, v0: 0, spot: [0, 0, 0], hand: [0, 0, 0],
      meter: 0, dtc: 0, shot: 'serve_flat', pause: 0, bounceN: 0, lastBounceCycle: -1 };
    this.pendingChangeEnds = false;
    this.pointInfo = null;
    this.state = {
      phase: 'pre_serve', prevPhase: null, time: 0, phaseTime: 0,
      ball: { pos: this.ball.pos, vel: this.ball.vel, spin: this.ball.spin, visible: true, held: true, inPlay: false, mode: 'held', lastHitter: -1, bounces: 0 },
      players: this.players, score: this.score,
      server: this.score.server, receiver: this.score.receiver, serveNo: 1, serveBox: this.score.serveBox,
      rally: 0, lastHitter: -1, lastHitTime: -1, shotId: 0, lastShot: null, target: null,
      serve: this.srv, humans: this.humans, difficulty: diffs.slice(),
      excitement: 0, pointWinner: null, lastPoint: null, over: false,
    };
    this._phaseT = 0;
    this._enter('pre_serve');
  }

  // ================================================================ öffentliche API
  /** Simuliert dt Sekunden (intern in 1/120-s-Schritten). inputs: [PlayerInput, PlayerInput] (KI-Slots ignoriert). */
  step(dt, inputs) {
    if (inputs) { this._inputs[0] = inputs[0] || NEUTRAL; this._inputs[1] = inputs[1] || NEUTRAL; }
    this._acc += Math.min(dt, 0.25);
    while (this._acc >= MATCH_DT - 1e-9) {
      this._acc -= MATCH_DT;
      this._hitTick = false;
      this._tick(MATCH_DT);
      if (this._hitTick && this.breakOnHit) break;
    }
  }

  /** Laufhilfe für menschliche Spieler ändern ('off'|'light'|'strong'). */
  setAssist(a) {
    this.assist = a;
    for (const p of this.players) p.assist = assistOf(a);
  }

  /** Alle seit dem letzten Aufruf entstandenen Ereignisse. */
  drainEvents() { const e = this.events; this.events = []; return e; }

  /** Debug: Phase erzwingen. */
  setPhase(phase) { this._enter(phase); }

  /** Debug: Spielstand setzen (rules.Score.force) und neuen Punkt beginnen. */
  forceScore(o) {
    this.score.force(o);
    for (let i = 0; i < 2; i++) this.players[i].side = this.score.sides[i];
    this.pendingChangeEnds = false;
    this._enter('pre_serve', true);
  }

  /**
   * Test/Debug: Ballwechsel mit vorgegebenem Ball starten (als hätte Spieler hitter gerade geschlagen).
   * opts = { serve: false } — serve: true behandelt den Ball als Aufschlag (Feld-/Netzregeln).
   */
  debugLaunch(hitter, pos, vel, spin, opts = {}) {
    const S = this.state, R = this.rally;
    if (S.phase !== 'rally' && S.phase !== 'serve') { this._enter('pre_serve', true); }
    for (const p of this.players) { p.stroke = null; p.pending = null; p.charge = 0; p.plan = null; p.emote = null; }
    this._resetRally();
    this.ball.launch(pos, vel, spin || [0, 0, 0]);
    R.active = true; R.isServe = !!opts.serve; R.lastHitter = hitter; R.hits = 1; R.launchTime = this.time; R.shotId++;
    R.lastShot = { player: hitter, type: opts.serve ? 'serve' : 'forehand', shot: 'topspin', family: opts.serve ? 'serve' : 'ground', quality: 'good', speed: Math.hypot(vel[0], vel[1], vel[2]), kmh: Math.hypot(vel[0], vel[1], vel[2]) * 3.6, pressure: 0, time: this.time };
    R.serveKmh = R.lastShot.kmh;
    S.rally = 1; S.lastHitter = hitter; S.lastHitTime = this.time; S.shotId = R.shotId; S.ball.visible = true;
    S.prevPhase = S.phase; S.phase = 'rally'; this._phaseT = 0;
    this._afterLaunch(hitter);
  }

  /** Menschliche Slots ändern (z. B. Demo -> Spiel). */
  setHumans(list) {
    this.humans = list.slice();
    this.state.humans = this.humans;
    this.players.forEach((p, i) => {
      p.human = this.humans.includes(i);
      if (!p.human && !this.ai[i]) this.ai[i] = new AIController(this, i, this.state.difficulty[i], this.seed * 7919 + i * 104729 + 3);
    });
  }

  // ================================================================ Takt
  _tick(h) {
    this.time += h;
    this._phaseT += h;
    const S = this.state;
    S.time = this.time; S.phaseTime = this._phaseT;
    // Eingaben einsammeln (KI erzeugt PlayerInput wie ein Mensch)
    for (let i = 0; i < 2; i++) {
      const inp = this.players[i].human ? this._inputs[i] : this.ai[i].update(h);
      this._cur[i] = inp || NEUTRAL;
      this._edges(i, this._cur[i]);
    }
    switch (S.phase) {
      case 'pre_serve': this._tickPreServe(h); break;
      case 'serve': this._tickServe(h); break;
      case 'rally': this._tickRally(h); break;
      case 'point_over': this._tickPointOver(h); break;
      case 'between_points': this._tickBetween(h); break;
      case 'change_ends': this._tickChangeEnds(h); break;
      case 'match_over': this._tickMatchOver(h); break;
      default: break;
    }
    this._updateLook(h);
    S.ball.held = this.ball.mode === 'held';
    S.ball.mode = this.ball.mode;
    S.ball.inPlay = this.rally.active && !this.rally.decided;
    S.ball.lastHitter = this.rally.lastHitter;
    S.ball.bounces = this.rally.bounces;
  }

  _edges(i, inp) {
    const prev = this._prevButtons[i], pr = this._pressed[i], b = inp.buttons || NEUTRAL.buttons;
    pr.any = false; pr.shot = null;
    for (const k of SHOT_BUTTONS) {
      const now = !!b[k];
      if (now && !prev[k]) { pr.any = true; pr.shot = k; }
      prev[k] = now;
    }
    const sk = !!inp.skip;
    pr.skip = sk && !this._skipPrev[i];
    this._skipPrev[i] = sk;
    if (this.players[i].human && pr.any) pr.skip = true;   // jede Schlagtaste überspringt Pausen
  }

  _humanSkip() {
    for (let i = 0; i < 2; i++) if (this.players[i].human && this._pressed[i].skip) return true;
    return false;
  }

  _emit(type, data) { const e = data || {}; e.type = type; e.event = type; e.time = this.time; this.events.push(e); return e; }

  // ================================================================ Phasen
  _enter(phase, force = false) {
    const S = this.state;
    if (S.phase === phase && !force && this._phaseT > 0) return;
    S.prevPhase = S.phase;
    S.phase = phase;
    this._phaseT = 0; S.phaseTime = 0;
    this._emit('phase', { phase, prev: S.prevPhase });
    switch (phase) {
      case 'pre_serve': this._setupPoint(); break;
      case 'serve': this._serveReady(); break;
      case 'point_over': break;
      case 'between_points':
        for (const p of this.players) { p.emote = null; p.stroke = null; p.mode = 'walk'; }
        this.ball.hold(this.ball.pos); this.state.ball.visible = false;
        break;
      case 'change_ends':
        for (const p of this.players) { p.emote = null; p.stroke = null; p.mode = 'walk'; }
        this.ball.hold(this.ball.pos); this.state.ball.visible = false;
        this._emit('change_ends', { sides: this.score.sides.slice() });
        break;
      case 'match_over':
        S.over = true;
        break;
      default: break;
    }
  }

  /** Neuer Punkt: Positionen, Aufschläger, Ball. */
  _setupPoint() {
    const S = this.state, sc = this.score;
    for (let i = 0; i < 2; i++) { this.players[i].side = sc.sides[i]; this.players[i].resetForPoint(); this.players[i].emote = null; }
    this.serveNo = 1;
    S.serveNo = 1; S.server = sc.server; S.receiver = sc.receiver; S.serveBox = sc.serveBox;
    S.rally = 0; S.pointWinner = null; S.lastShot = null; S.target = null;
    this._resetRally();
    this._computeServePositions();
    if (this.instantReset) {
      for (const p of this.players) {
        const t = p.walkTarget;
        p.pos[0] = t[0]; p.pos[2] = t[2]; p.vel[0] = p.vel[2] = 0;
        p.yaw = p.netYaw; p.mode = 'ready';
      }
    }
    this.srv.state = 'walk';
    this.ball.hold(this._handPos(this.players[sc.server], this.ball.pos));
    S.ball.visible = true;
    this.pointInfo = null;
    this._pointStart = this.time;
    for (let i = 0; i < 2; i++) if (this.ai[i]) this.ai[i].onNewPoint();
  }

  _resetRally() {
    const R = this.rally;
    R.active = false; R.isServe = false; R.lastHitter = -1; R.hits = 0; R.bounces = 0; R.firstBounce = null;
    R.netTouched = false; R.serveTouchedNet = false; R.decided = false; R.lastShot = null; R.closeCall = null;
    R.receiverTouched = false;
    this.state.lastHitter = -1;
  }

  _computeServePositions() {
    const sc = this.score, srv = this.players[sc.server], rcv = this.players[sc.receiver];
    const box = sc.serveBox, side = srv.side;
    this._srvPos = serverPosition(side, box, this._srvPos || [0, 0, 0], box === 'deuce' ? 0.7 : 1.05, 0.22);
    const behind = this.serveNo === 1 ? 1.35 : 0.55;
    this._rcvPos = receiverPosition(side, box, this._rcvPos || [0, 0, 0], 2.7, behind);
    srv.walkTarget = this._srvPos; rcv.walkTarget = this._rcvPos;
  }

  _tickPreServe(h) {
    const S = this.state;
    const skip = this._humanSkip();
    let done = true;
    for (const p of this.players) {
      const t = p.walkTarget;
      const d = Math.hypot(t[0] - p.pos[0], t[2] - p.pos[2]);
      const fast = d > 3 ? 0.62 : 0.4;
      if (skip || this._phaseT > TIMING.preServeMax) { p.pos[0] = t[0]; p.pos[2] = t[2]; p.vel[0] = p.vel[2] = 0; }
      else p.steerTo(h, t[0], t[2], fast);
      if (Math.hypot(t[0] - p.pos[0], t[2] - p.pos[2]) > 0.12 || Math.hypot(p.vel[0], p.vel[2]) > 0.3) done = false;
      p.mode = Math.hypot(p.vel[0], p.vel[2]) > 0.3 ? 'walk' : 'ready';
      p.ready = p.index === S.receiver ? 0.5 : 0.2;
    }
    const srv = this.players[S.server];
    this._handPos(srv, this.ball.pos);
    if (done && this._phaseT >= TIMING.preServeMin) this._enter('serve');
    else if (skip && this._phaseT >= 0.05) this._enter('serve');
  }

  // ---------------------------------------------------------------- Aufschlag
  _handPos(p, out) {
    // linke Hand vor dem Körper (Ball halten)
    const s = p.side, k = p.scale;
    out[0] = p.pos[0] - s * 0.22 * k;
    out[1] = 1.0 * k;
    out[2] = p.pos[2] - s * 0.32 * k;
    return out;
  }

  _serveReady() {
    const S = this.state, srv = this.players[S.server];
    const V = this.srv;
    V.state = 'ready'; V.t = 0; V.bounceN = 0; V.lastBounceCycle = -1;
    srv.servePhase = 'bounce'; srv.mode = 'serve';
    srv.serveMeter = null; srv.serveMeterLocked = false;
    this.ball.hold(this._handPos(srv, this.ball.pos));
    this.state.ball.visible = true;
    // Kinematik des Ballwurfs vorbereiten
    const k = srv.scale;
    V.hc = STROKES.serve.contact.up * k;
    V.release = SERVE.releaseUp * k;
    const apex = V.hc + SERVE.tossApexAbove * k;
    V.v0 = Math.sqrt(2 * G * Math.max(0.2, apex - V.release));
    V.tApex = V.v0 / G;
    V.tIdeal = SERVE.tossRelease + V.tApex + Math.sqrt(2 * SERVE.tossApexAbove * k / G);   // ab Druck
    V.windup = STROKES.serve.windup;
  }

  _tickServe(h) {
    const S = this.state, V = this.srv;
    const srv = this.players[S.server], rcv = this.players[S.receiver];
    V.t += h;
    // Rückschläger: darf sich leicht bewegen (Mensch), KI tänzelt
    {
      const inp = this._cur[rcv.index];
      if (rcv.human && V.state !== 'pause') rcv.applyMove(h, inp.move[0] * 0.45, inp.move[1] * 0.45);
      else rcv.steerTo(h, rcv.walkTarget[0], rcv.walkTarget[2], 0.5);
      rcv.ready = V.state === 'toss' || V.state === 'swing' ? 1 : 0.7;
      rcv.mode = 'ready';
      this._tickSplit(rcv, h);
    }
    srv.ready = 0.6;
    switch (V.state) {
      case 'pause': {
        // nach Fehler/Netz: Ball fliegt aus, dann neuer Ball
        this._stepBallFree(h);
        srv.steerTo(h, this._srvPos[0], this._srvPos[2], 0.45);
        if (V.t >= V.pause) {
          this._computeServePositions();
          this._serveReady();
        }
        return;
      }
      case 'ready': {
        // seitlich verschieben (Mensch), Ball tippen
        const inp = this._cur[srv.index];
        if (srv.human) {
          const lim = this._srvLatLimits();
          srv.applyMove(h, inp.move[0] * 0.35, 0);
          srv.pos[0] = clamp(srv.pos[0], lim[0], lim[1]);
          srv.pos[2] = this._srvPos[2];
        } else srv.steerTo(h, this._srvPos[0], this._srvPos[2], 0.4);
        this._bounceBall(srv, V.t);
        if (V.t >= TIMING.readyMin && this._pressed[srv.index].any) this._toss(srv);
        return;
      }
      case 'toss': {
        srv.applyMove(h, 0, 0);
        const tau = this.time - V.tossTime;
        this._tossBallPos(tau, this.ball.pos);
        // Messanzeige: Qualität, wenn jetzt geschlagen würde
        const dtc = tau + V.windup - V.tIdeal;
        srv.serveMeter = clamp01(1 - Math.abs(dtc) / 0.42);
        V.meter = srv.serveMeter; V.dtc = dtc;
        if (tau > SERVE.tossRelease + 0.05 && this._pressed[srv.index].any) {
          this._serveSwing(srv, this._pressed[srv.index].shot);
          return;
        }
        // Ball gefallen ohne Schlag: fangen, neuer Versuch (kein Fehler)
        if (tau > SERVE.maxWait || (tau > V.tIdeal && this.ball.pos[1] < 0.95 * srv.scale)) {
          srv.serveMeter = null;
          V.state = 'ready'; V.t = 0; srv.servePhase = 'bounce';
          this.ball.hold(this._handPos(srv, this.ball.pos));
          this._emit('serve_catch', { player: srv.index });
        }
        return;
      }
      case 'swing': {
        srv.applyMove(h, 0, 0);
        const tau = this.time - V.tossTime;
        this._tossBallPos(tau, this.ball.pos);
        if (this.time >= V.contactTime - h * 0.5) this._serveContact(srv);
        return;
      }
      default: return;
    }
  }

  _srvLatLimits() {
    const S = this.state, srv = this.players[S.server];
    // Aufschläger bleibt zwischen Mittelzeichen und Seitenlinie seiner Hälfte (Deuce = rechts aus seiner Sicht)
    const xs = S.serveBox === 'deuce' ? srv.side : -srv.side;
    const a = xs * 0.15, b = xs * (SW - 0.3);
    return a < b ? [a, b] : [b, a];
  }

  _bounceBall(srv, t) {
    const V = this.srv;
    const T = TIMING.bouncePeriod;
    const cyc = Math.floor(t / T), u = (t % T) / T;
    const hand = this._handPos(srv, V.hand);
    const r = BALL.radius;
    this.ball.mode = 'held';
    this.ball.pos[0] = hand[0]; this.ball.pos[2] = hand[2];
    this.ball.pos[1] = r + (hand[1] - r) * (2 * u - 1) * (2 * u - 1);
    if (u >= 0.5 && V.lastBounceCycle !== cyc) {
      V.lastBounceCycle = cyc; V.bounceN++;
      this._emit('serve_bounce', { player: srv.index, pos: [hand[0], 0, hand[2]] });
    }
  }

  _toss(srv) {
    const V = this.srv;
    V.state = 'toss';
    V.tossTime = this.time;
    srv.servePhase = 'toss';
    this._handPos(srv, V.hand);
    // Wurfpunkt = Treffpunkt bei perfektem Timing
    srv.racketPoint(V.spot, STROKES.serve.contact);
    V.idealPress = this.time + V.tIdeal - V.windup;
    V.idealContact = this.time + V.tIdeal;
    this._emit('serve_toss', {
      player: srv.index, pos: [V.spot[0], V.hc, V.spot[2]], release: SERVE.tossRelease,
      apex: V.hc + SERVE.tossApexAbove * srv.scale, contactTime: V.tIdeal, idealPress: V.tIdeal - V.windup,
    });
  }

  /** Ballposition während des Wurfs (tau = Zeit seit dem Druck). */
  _tossBallPos(tau, out) {
    const V = this.srv;
    if (tau < SERVE.tossRelease) {
      const u = smooth(clamp01(tau / SERVE.tossRelease));
      out[0] = lerp(V.hand[0], V.spot[0], u); out[2] = lerp(V.hand[2], V.spot[2], u);
      out[1] = lerp(V.hand[1], V.release, u);
    } else {
      const t2 = tau - SERVE.tossRelease;
      out[0] = V.spot[0]; out[2] = V.spot[2];
      out[1] = Math.max(BALL.radius, V.release + V.v0 * t2 - 0.5 * G * t2 * t2);
    }
    this.ball.mode = 'held';
    return out;
  }

  _serveSwing(srv, button) {
    const V = this.srv, S = this.state;
    V.state = 'swing';
    V.contactTime = this.time + V.windup;
    const tau = V.contactTime - V.tossTime;
    V.dtc = tau - V.tIdeal;
    V.meter = clamp01(1 - Math.abs(V.dtc) / 0.42);
    srv.serveMeter = V.meter; srv.serveMeterLocked = true;
    // Aufschlagart aus Taste
    let shot;
    if (button === 'slice' || button === 'drop') shot = 'serve_slice';
    else if (button === 'lob') shot = 'serve_kick';
    else shot = this.serveNo === 1 ? 'serve_flat' : 'serve_kick';
    V.shot = shot;
    const c = this._tossBallPos(tau, [0, 0, 0]);
    const power = this._servePower(V.meter);
    srv.servePhase = 'swing';
    srv.stroke = { type: 'serve', shot, hand: 'fh', family: 'serve', start: this.time, windup: V.windup, contactTime: V.contactTime, contact: c, power, rushed: false };
    srv.mode = 'stroke';
    this._emit('stroke_start', { player: srv.index, stroke: 'serve', shot, windup: V.windup, contact: c, contactTime: V.contactTime, power, serve: true });
    // Gegner: Split-Step zum Treffzeitpunkt
    this._scheduleSplit(this.players[S.receiver], V.contactTime);
  }

  _servePower(meter) {
    return this.serveNo === 1 ? lerp(0.32, 1.0, meter) : lerp(0.22, 0.62, meter);
  }

  _serveContact(srv) {
    const V = this.srv, S = this.state, R = this.rally;
    const adt = Math.abs(V.dtc);
    const quality = adt <= 0.035 ? 'perfect' : adt <= 0.09 ? 'good' : adt > 0.33 ? 'frame' : V.dtc < 0 ? 'early' : 'late';
    srv.servePhase = 'follow';
    if (adt > 0.5) {
      // Luftschlag: Ball fällt -> Fehler
      this._emit('miss', { player: srv.index, serve: true });
      this.ball.launch(this.ball.pos, [0, -1, 0], [0, 0, 0]);
      R.active = true; R.isServe = true; R.lastHitter = srv.index; R.hits = 0;
      this._serveFault('miss', null, 0);
      return;
    }
    const inp = this._cur[srv.index];
    const box = S.serveBox, side = srv.side;
    const depth = this.serveNo === 1 ? 0.93 : 0.8;
    // zweiter Aufschlag: sicherer (Ziel weiter von den Linien weg, auch bei voller Richtung)
    const lr = clamp(inp.aim ? inp.aim[0] : 0, -1, 1) * (this.serveNo === 1 ? 1 : 0.55);
    const tgt = serveTarget(side, box, lr, depth, {});
    const meter = V.meter;
    const power = this._servePower(meter);
    const st = srv.stats;
    let sig = 0.5 * (1.5 - 0.6 * (st.serve ?? 0.8)) * (1 + 2.0 * (1 - meter)) * (0.75 + 0.5 * power);
    if (quality === 'frame') sig *= 2.2;
    if (this.serveNo === 2) sig *= 1.0;
    sig *= this._errMul(srv);
    const ex = this.rng.gaussC(2.6) * sig * 0.8, ez = this.rng.gaussC(2.6) * sig * 1.05;
    const target = { x: tgt.x + ex, z: tgt.z + ez };
    const from = [this.ball.pos[0], this.ball.pos[1], this.ball.pos[2]];
    const sol = solveShot({ from, target, spin: V.shot, power, stats: st }, _sv);
    const vel = _v3; vel.set(sol.vel);
    const dth = this.rng.gaussC(2.6) * sig * 0.0042;
    rotateVel(vel, dth, this.rng.gaussC(2.6) * sig * 0.002);
    this.ball.launch(from, vel, sol.spin);
    const speed = Math.hypot(vel[0], vel[1], vel[2]);
    const kmh = speed * 3.6;
    R.active = true; R.isServe = true; R.lastHitter = srv.index; R.hits = 1; R.bounces = 0; R.firstBounce = null;
    R.netTouched = false; R.serveTouchedNet = false; R.decided = false; R.launchTime = this.time; R.shotId++;
    R.closeCall = null; R.receiverTouched = false;
    R.lastShot = { player: srv.index, type: 'serve', shot: V.shot, family: 'serve', quality, speed, kmh, target: tgt, pressure: 0, preset: V.shot, time: this.time, serveNo: this.serveNo };
    if (this.serveNo === 1) R.serveKmh = kmh; else R.serveKmh = kmh;
    S.rally = 1; S.lastHitter = srv.index; S.lastHitTime = this.time; S.shotId = R.shotId; S.lastShot = R.lastShot; S.target = tgt;
    srv.lastHit = R.lastShot;
    srv.serveMeter = null;
    this._emit('hit', {
      player: srv.index, stroke: 'serve', shot: V.shot, quality, speed, kmh, spin: Math.hypot(sol.spin[0], sol.spin[1], sol.spin[2]) / RPM,
      pos: from, target: { x: tgt.x, z: tgt.z }, serve: true, serveNo: this.serveNo, power,
    });
    this._emit('serve_speed', { player: srv.index, kmh: Math.round(kmh), serveNo: this.serveNo });
    srv.stroke.contact = from; srv.stroke.done = true;
    this._hitTick = true;
    this._afterLaunch(srv.index);
    this._enter('rally');
  }

  _errMul(p) {
    return p.human ? p.diff.humanError : p.diff.aiError;
  }

  // ---------------------------------------------------------------- Ballwechsel
  /** Nach jedem Abschlag: Vorhersage für den Gegner, Split-Step, KI informieren. */
  _afterLaunch(hitter) {
    const opp = this.players[1 - hitter];
    predict(this.ball, 4.6, BALL.dt, { out: opp.traj, maxBounces: 2 });
    opp.trajValid = true; opp.trajLaunch = this.time; opp._planAge = 1e9;
    opp.plan = null; opp._plan.valid = false;
    opp.pending = opp.pending && opp.pending.early ? opp.pending : null;   // früh gedrückt (während des gegnerischen Schwungs) bleibt
    const me = this.players[hitter];
    me.trajValid = false; me.plan = null; me._plan.valid = false; me.pending = null; me.charge = 0;
    // Erster Aufsprung: drin?
    const b = opp.traj.bounce(0, BNC);
    let bin = false;
    if (b) {
      if (this.rally.isServe) bin = inServiceBox(b.pos[0], b.pos[2], this.players[this.state.server].side, this.state.serveBox, footprintRadius(b.velIn[1]));
      else bin = isInSingles(b.pos[0], b.pos[2], footprintRadius(b.velIn[1]));
      if (b.pos[2] * opp.side < 0) bin = false;
    }
    opp.predBounceIn = bin;
    opp.predBounce = b ? [b.pos[0], b.pos[1], b.pos[2], b.t] : null;
    for (let i = 0; i < 2; i++) if (this.ai[i]) this.ai[i].onShot(hitter);
  }

  _tickRally(h) {
    const R = this.rally, S = this.state;
    // 1) Schläge (Treffer genau zum Kontaktzeitpunkt, vor dem Ballschritt)
    for (const p of this.players) {
      if (p.stroke && p.stroke.family !== 'serve' && !p.stroke.done && this.time >= p.stroke.contactTime - h * 0.5) this._strokeContact(p);
    }
    // 2) Ballphysik + Regeln
    const ev = this.ball.step(h);
    for (let i = 0; i < ev.length; i++) {
      this._ballEvent(ev[i]);
      if (S.phase !== 'rally') break;
    }
    if (S.phase !== 'rally') { this._movePlayersIdle(h); return; }
    // Sicherheitsnetz: Ball bleibt irgendwo liegen/hängen
    if (!R.decided && this.time - R.launchTime > 9) {
      const owner = this._halfOwner(this.ball.pos[2]);
      if (owner === R.lastHitter || R.bounces === 0) this._netError(this.ball.pos); else this._ballPassed();
      if (S.phase !== 'rally') return;
    }
    // 3) Spieler
    for (const p of this.players) this._rallyPlayer(p, h);
    // Aufregung
    S.excitement = clamp01(0.15 + 0.06 * R.hits + (this.score.flags().breakPoint != null ? 0.2 : 0));
  }

  _rallyPlayer(p, h) {
    const R = this.rally;
    const inp = this._cur[p.index];
    const incoming = R.active && !R.decided && R.lastHitter !== p.index && R.lastHitter >= 0;
    const opp = this.players[1 - p.index];
    const pr = this._pressed[p.index];
    const swinging = p.stroke && !p.stroke.done;
    // --- Tastendruck -> Laden (Powerbalken startet)
    if (pr.any && !swinging) {
      const oppSwinging = opp.stroke && !opp.stroke.done && R.lastHitter !== p.index;
      // früher Druck: eigener Ball ist schon über dem Netz -> Laden beginnt sofort
      const ownOver = R.active && !R.decided && R.lastHitter === p.index && this.ball.pos[2] * p.side < -0.5;
      if (incoming || oppSwinging || ownOver) {
        if (!p.pending) p.pending = { shot: pr.shot, pressTime: this.time, early: !incoming };
        else p.pending.shot = pr.shot;
        p.chargeShot = p.pending.shot;
      }
    }
    // --- Planung
    if (incoming && !p.stroke && p.trajValid) {
      p._planAge += h;
      if (p._planAge >= TIMING.replanEvery || !p.plan) {
        p._planAge = 0;
        planIntercept(p, this.time - p.trajLaunch, p.trajLaunch, this._planOpts(p));
      }
    } else if (!incoming && !p.stroke) { p.plan = null; }
    // --- Powerbalken: läuft vom Tastendruck bis zum Treffer (dort friert er ein)
    if (p.pending) p.charge = clamp01((this.time - p.pending.pressTime) / CHARGE.fill);
    // --- Schwung starten: kurz vor dem Treffer, aus der gehaltenen Ausholpose
    if (incoming && p.pending && p.plan && p.plan.valid && !p.stroke) {
      let key = strokeKey(p.plan.family, p.plan.hand, p.pending.shot);
      let ttc = p.plan.time - this.time;
      // Mensch steht nicht für den (späteren) Plan bereit, der Ball kommt aber jetzt in Reichweite: jetzt schwingen
      if (p.human && ttc > STROKES[key].swing + 1e-6 && this._swingNow(p, key)) {
        key = strokeKey(p.plan.family, p.plan.hand, p.pending.shot);
        ttc = p.plan.time - this.time;
      }
      if (ttc <= STROKES[key].swing + 1e-6) this._startStroke(p, key, ttc);
    }
    // --- Bewegung
    const st = p.stroke;
    if (st && !st.done) {
      // Ausfallschritt: vom Schwungstart zum Schlagstandort (begrenzt, weich)
      const u = clamp01((this.time - st.start) / Math.max(1e-3, st.contactTime - st.start)), e = smooth(u);
      const nx = lerp(st.from[0], st.to[0], e), nz = lerp(st.from[2], st.to[2], e);
      p.vel[0] = (nx - p.pos[0]) / h; p.vel[2] = (nz - p.pos[2]) / h;
      p.pos[0] = nx; p.pos[2] = nz;
      p.mode = 'stroke';
    } else if (st && st.done) {
      // Ausschwung: langsam (nach einer Rettung noch langsamer)
      const m = p.recover > 0 ? 0.2 : p.human ? 0.4 : 0.5;
      p.applyMove(h, inp.move[0] * m, inp.move[1] * m);
      if (this.time >= st.contactTime + STROKES[st.type].follow * 0.8) { p.stroke = null; }
      p.mode = 'stroke';
    } else {
      let mx = inp.move[0], mz = inp.move[1];
      let speedMul = p.pending ? CHARGE.moveMul : 1;   // Laden kostet Beweglichkeit
      if (p.recover > 0) speedMul *= 0.5;
      if (p.human && incoming && p.plan && p.plan.valid && p.assist > 0) {
        // Laufhilfe (Einstellung aus/leicht/stark): sanfter Zug zum idealen Standort
        const a = p.assist * (p.pending ? 1 : 0.6);
        const dx = p.plan.pos[0] - p.pos[0], dz = p.plan.pos[2] - p.pos[2];
        const d = Math.hypot(dx, dz);
        if (d > 0.03) {
          const tl = Math.max(0.05, p.plan.time - this.time);
          const need = clamp(d / tl / (p.stats.maxSpeed * speedMul), 0, 1);
          const inMag = Math.hypot(mx, mz);
          const k = a * Math.max(need, Math.min(1, d / 0.7)) * (inMag > 0.2 ? 0.6 : 1);
          mx += (dx / d) * k; mz += (dz / d) * k;
        }
      }
      if (this._splitActive(p)) speedMul *= 0.45;
      p.applyMove(h, mx, mz, speedMul);
      const sp = Math.hypot(p.vel[0], p.vel[2]);
      p.mode = sp > 0.5 ? 'move' : 'ready';
    }
    if (p.recover > 0) p.recover -= h;
    this._tickSplit(p, h);
    this._updatePreview(p, inp, incoming);
    p.ready = 1;
    if (Math.abs(p.pos[2]) < 6.0) p.wentToNet = true;
    p.atNet = Math.abs(p.pos[2]) < 6.4;
  }

  /**
   * Ball ist in Schwungzeit am Spieler vorbei erreichbar (Ausfallschritt), der Plan verlangt aber einen weiten Weg:
   * Plan auf diesen Treffpunkt umstellen (true). So schwingt ein stehender Mensch mit geladenem Balken am Ball,
   * statt dass der Plan immer weiter nach hinten wandert.
   */
  _swingNow(p, key) {
    const h = MATCH_DT, plan = p.plan;
    const reach = lungeOf(p) + hitRadius(p) * 0.5;
    if (Math.hypot(plan.pos[0] - p.pos[0], plan.pos[2] - p.pos[2]) <= reach) return false;   // steht bereit
    const tRel = Math.round((this.time + STROKES[key].swing - p.trajLaunch) / h) * h;
    const c = contactAt(p, tRel, this._planOpts(p), this._ca || (this._ca = { ball: [0, 0, 0], pos: [0, 0, 0] }));
    if (!c || c.gap > reach) return false;
    plan.time = p.trajLaunch + tRel; plan.t = tRel;
    plan.contact[0] = c.ball[0]; plan.contact[1] = c.ball[1]; plan.contact[2] = c.ball[2];
    plan.pos[0] = c.pos[0]; plan.pos[2] = c.pos[2];
    plan.family = c.family; plan.hand = c.hand; plan.height = c.ball[1];
    p._planAge = 0;
    return true;
  }

  /** Zielkreis-Vorschau beim Laden (p.preview): erwartete Qualität aus der aktuellen Stellung, Kraft = Balken. */
  _updatePreview(p, inp, incoming) {
    const pv = p.preview, st = p.stroke, plan = p.plan;
    if (!p.pending || !incoming || !plan || !plan.valid || (st && st.done)) { pv.on = false; return; }
    const q = this._pq || (this._pq = { gap: 0, gapFwd: 0, rescue: false, rushed: false });
    if (st) { q.gap = st.gap; q.gapFwd = st.gapFwd; q.rescue = st.rescue; q.rushed = st.rushed; }
    else {
      const dx = plan.pos[0] - p.pos[0], dz = plan.pos[2] - p.pos[2];
      q.gap = Math.hypot(dx, dz); q.gapFwd = -dz * p.side; q.rescue = q.gap - lungeOf(p) > hitRadius(p) && plan.family !== 'smash'; q.rushed = false;
    }
    const o = this._pvo || (this._pvo = { shot: 'topspin', family: 'ground', power: 0, aim: null, from: null, quality: 'good', runSpeed: 0, incomingSpeed: 0, rescue: false });
    o.shot = p.pending.shot; o.family = st ? st.family : plan.family;
    o.power = q.rescue ? Math.min(p.charge, HIT.rescuePower) : p.charge;
    o.aim = inp.aim; o.from = st ? st.ball : plan.contact;
    o.quality = strokeQuality(q); o.rescue = q.rescue;
    o.runSpeed = st ? st.approach : Math.hypot(p.vel[0], p.vel[2]);
    const bv = st ? st.ballVel : plan.ballVel;
    o.incomingSpeed = Math.hypot(bv[0], bv[1], bv[2]);
    previewShot(p, o, pv);
    pv.quality = o.quality; pv.power = o.power;
    pv.on = true;
  }

  _planOpts(p) {
    const R = this.rally;
    const o = this._po || (this._po = {});
    const z = Math.abs(p.pos[2]);
    o.serveReturn = R.isServe;
    o.allowVolley = !R.isServe && (p.netMode || z < 8.7);
    o.volleyBonus = p.netMode || z < 6.6 ? 1.0 : 0.15;
    o.volleyZ = p.netMode ? 9.6 : COURT.serviceLineZ + 2.4;
    o.fhBias = p.human ? 0.1 : p.diff.aiFhBias;
    o.reaction = 0;
    if (!p.human && this.ai[p.index]) o.reaction = this.ai[p.index].reactionLeft();
    o.bounceIn = p.predBounceIn !== false;
    o.aggressive = !p.human && this.ai[p.index] ? this.ai[p.index].wantsEarly() : false;
    return o;
  }

  /**
   * Schwung starten (ttc = Zeit bis zum geplanten Treffer). Kontaktzeit liegt auf dem 120-Hz-Raster, damit der Ball beim
   * Treffer exakt an der vorhergesagten Stelle ist. Ausfallschritt höchstens HIT.lunge; reicht das nicht, Rettung mit
   * HIT.rescueLunge; hoffnungslose Bälle werden nicht angeschwungen.
   */
  _startStroke(p, key, ttc) {
    const plan = p.plan, S = STROKES[key], h = MATCH_DT;
    if (ttc < 0.07) { p.pending = null; p.charge = 0; return; }        // zu spät gedrückt
    const tRel = Math.max(h, Math.round((plan.time - p.trajLaunch) / h) * h);
    const contactTime = p.trajLaunch + tRel;
    const ball = p.traj.positionAt(tRel, [0, 0, 0]);
    const ideal = p.idealPosFor([0, 0, 0], ball[0], ball[2], S.contact);
    if (ideal[2] * p.side < 0.5) ideal[2] = 0.5 * p.side;
    const dx = ideal[0] - p.pos[0], dz = ideal[2] - p.pos[2], d = Math.hypot(dx, dz);
    const R = hitRadius(p);                                   // Reichweite der Figur: Radius und Ausfallschritt
    let L = lungeOf(p), rescue = false;
    if (d - L > R) {
      if (d - lungeOf(p, true) > HIT.whiff) { p.pending = null; p.charge = 0; return; }   // hoffnungslos
      if (plan.family !== 'smash') { L = lungeOf(p, true); rescue = true; }             // Überkopf: kein Hechtsprung
    }
    const k = d > L ? L / d : 1;
    const to = [p.pos[0] + dx * k, 0, p.pos[2] + dz * k];
    // Schlägerpunkt am Ende des Ausfallschritts: Fehlschlag schon jetzt absehbar -> Figur schwingt sichtbar vorbei
    const rp = strokeContactWorld([0, 0, 0], to, p.netYaw, S.contact, p.scale);
    const miss = Math.hypot(ball[0] - rp[0], ball[2] - rp[2]) > R;
    if (miss) rp[1] = clamp(ball[1], S.height[0] * p.scale, S.height[1] * p.scale);
    const contact = miss ? rp : ball;
    const rushed = ttc < S.swing - 0.03;
    p.stroke = {
      type: key, shot: p.pending.shot, hand: plan.hand, family: plan.family, start: this.time, windup: ttc, contactTime,
      contact, ball, from: [p.pos[0], 0, p.pos[2]], to, planPos: to, rushed, rescue, miss, gap: d, gapFwd: -dz * p.side,
      approach: Math.hypot(p.vel[0], p.vel[2]), power: p.charge, pressTime: p.pending.pressTime, done: false,
      slack: plan.slack, feasible: plan.feasible, ballVel: plan.ballVel.slice(),
    };
    p.mode = 'stroke';
    this._emit('stroke_start', {
      player: p.index, stroke: key, shot: p.pending.shot, windup: ttc, contact: contact.slice(), contactTime, power: p.charge,
      charge: p.charge, hand: plan.hand, family: plan.family, rushed, rescue, miss,
    });
    // Gegner: Split-Step zum Treffzeitpunkt
    this._scheduleSplit(this.players[1 - p.index], contactTime);
  }

  _strokeContact(p) {
    const R = this.rally, S = this.state;
    const st = p.stroke;
    st.done = true;
    const charge = p.charge = clamp01((this.time - st.pressTime) / CHARGE.fill);   // Balken friert hier ein
    p.pending = null;
    if (R.decided || R.lastHitter === p.index || this.ball.mode !== 'air') { p.charge = 0; return; }
    const q = contactQuality(p, this.ball.pos, st.type, st, _q);
    if (q.miss) {
      this._emit('miss', { player: p.index, pos: [this.ball.pos[0], this.ball.pos[1], this.ball.pos[2]], err: q.err, rescue: st.rescue });
      p.charge = 0;
      if (R.isServe) R.receiverTouched = false;
      p.missed = true;
      if (st.rescue) p.recover = 0.5;
      return;
    }
    // Schlag ausführen: Kraft = Balkenwert (Rettung: schwach)
    const inp = this._cur[p.index];
    const inSpeed = Math.hypot(this.ball.vel[0], this.ball.vel[1], this.ball.vel[2]);
    const inRpm = Math.hypot(this.ball.spin[0], this.ball.spin[1], this.ball.spin[2]) / RPM;
    const runSpeed = st.approach;
    const power = st.rescue ? Math.min(charge, HIT.rescuePower) : charge;
    st.power = power;
    if (st.rescue) p.recover = 0.45;
    const shot = st.shot;
    const from = [this.ball.pos[0], this.ball.pos[1], this.ball.pos[2]];
    const res = resolveShot({
      p, rng: this.rng, shot, family: st.family, key: st.type, from, aim: inp.aim, target: null,
      quality: q.quality, power, incomingSpeed: inSpeed, runSpeed, rescue: st.rescue,
    }, _shot);
    const wasServe = R.isServe;
    this.ball.launch(from, res.vel, res.spin);
    // Druck (für erzwungen/unerzwungen)
    // Bedrängnis 0..~1.5: Kontaktqualität, Tempo/Spin des ankommenden Balls, Zeitnot, Laufen, unbequeme Höhe
    const QP = { perfect: 0, good: 0.05, early: 0.15, late: 0.35, stretch: 0.45, frame: 0.6 };
    let pressure = QP[q.quality] || 0;
    pressure += clamp((inSpeed - 17) / 14, 0, 1.2) * 0.3 + clamp((inRpm - 2200) / 2500, 0, 1) * 0.1;
    pressure += clamp((0.3 - st.slack) / 0.3, 0, 1.2) * 0.3;
    pressure += clamp((runSpeed - 2.2) / 3, 0, 1) * 0.25;
    if (from[1] < 0.42 * p.scale || from[1] > 1.65 * p.scale) pressure += 0.15;
    if (wasServe && inSpeed > 35) pressure += 0.3;
    if (st.rescue) pressure += 0.4;
    R.lastHitter = p.index; R.isServe = false; R.hits++; R.bounces = 0; R.firstBounce = null; R.netTouched = false;
    R.launchTime = this.time; R.shotId++; R.closeCall = null;
    if (wasServe) R.receiverTouched = true;
    R.lastShot = {
      player: p.index, type: st.type, shot, family: st.family, quality: q.quality, speed: res.speed, kmh: res.speed * 3.6,
      target: { x: res.aimTarget.x, z: res.aimTarget.z }, pressure, preset: res.preset, time: this.time, returnOfServe: wasServe,
      height: from[1], charge: power, radius: res.radius, rescue: st.rescue,
    };
    p.lastHit = R.lastShot;
    if (st.family === 'volley' || st.family === 'smash') p.wentToNet = true;
    S.rally = R.hits; S.lastHitter = p.index; S.lastHitTime = this.time; S.shotId = R.shotId; S.lastShot = R.lastShot;
    S.target = R.lastShot.target;
    p.charge = 0;
    this._hitTick = true;
    this._emit('hit', {
      player: p.index, stroke: st.type, shot, quality: q.quality, speed: res.speed, kmh: res.speed * 3.6, spin: res.rpm, pos: from,
      target: { x: res.aimTarget.x, z: res.aimTarget.z }, landing: { x: res.target.x, z: res.target.z }, radius: res.radius, red: res.red,
      netDump: res.netDump, family: st.family, power, bar: charge, pressTime: st.pressTime, serve: false, rally: R.hits, clearance: res.clearance,
      rescue: st.rescue, err: q.err, strong: st.family === 'smash' || (power >= 0.7 && (q.quality === 'perfect' || q.quality === 'good')),
    });
    this._afterLaunch(p.index);
  }

  _ballEvent(e) {
    const R = this.rally;
    switch (e.type) {
      case 'bounce': this._onBounce(e); break;
      case 'net':
        R.netTouched = true;
        if (R.isServe) R.serveTouchedNet = true;
        this._emit('net', { pos: e.pos, cord: e.cord, speed: e.speedIn, soft: e.soft });
        break;
      case 'post':
        this._emit('net', { pos: e.pos, cord: false, post: true, speed: e.speedIn });
        break;
      case 'wall':
        this._emit('wall', { pos: e.pos, speed: e.speedIn });
        if (!R.decided) {
          if (R.bounces === 0) this._ballOut(e.pos, null);          // ohne Aufsprung in die Bande: aus
          else this._ballPassed();
        }
        break;
      case 'rest':
        if (!R.decided) {
          const owner = this._halfOwner(e.pos[2]);
          if (owner === R.lastHitter) this._netError(e.pos);
          else this._ballPassed();
        }
        break;
      default: break;
    }
  }

  _halfOwner(z) { return this.players[0].side === (z >= 0 ? 1 : -1) ? 0 : 1; }

  _onBounce(e) {
    const R = this.rally, S = this.state;
    R.bounces++;
    const owner = this._halfOwner(e.pos[2]);
    const speed = e.speedIn;
    if (R.decided) { this._emit('bounce', { pos: e.pos, in: null, speed, index: R.bounces, dead: true }); return; }
    if (R.bounces === 1) {
      if (owner === R.lastHitter) {
        // Ball hat das Netz nicht überquert
        this._emit('bounce', { pos: e.pos, in: false, speed, index: 1 });
        this._netError(e.pos);
        return;
      }
      const margin = footprintRadius(e.vyIn);
      if (R.isServe) {
        const srvSide = this.players[S.server].side;
        const ok = inServiceBox(e.pos[0], e.pos[2], srvSide, S.serveBox, margin);
        const cc = this._closeCall(e.pos, margin, { serverSide: srvSide, box: S.serveBox });
        this._emit('bounce', { pos: e.pos, in: ok, speed, index: 1, serve: true });
        if (!ok) {
          describeServeMiss(e.pos[0], e.pos[2], srvSide, S.serveBox, margin, _md);
          const kind = _md.long > 0 ? 'long' : _md.wide > 0 ? 'wide' : 'centre';
          this._emit('line_call', { call: 'fault', pos: e.pos, distanceMm: Math.round(_md.distance * 1000), closeCall: cc });
          this._serveFault(kind, e.pos, cc);
          return;
        }
        if (R.serveTouchedNet) { this._serveLet(); return; }
        R.firstBounce = [e.pos[0], e.pos[1], e.pos[2]];
        R.closeCall = cc;
        return;
      }
      const ok = isInSingles(e.pos[0], e.pos[2], margin);
      const cc = this._closeCall(e.pos, margin, null);
      this._emit('bounce', { pos: e.pos, in: ok, speed, index: 1 });
      if (!ok) {
        describeMiss(e.pos[0], e.pos[2], margin, _md);
        this._emit('line_call', { call: 'out', pos: e.pos, distanceMm: Math.round(_md.distance * 1000), closeCall: cc });
        this._ballOut(e.pos, cc, _md.long > 0 ? 'long' : 'wide');
        return;
      }
      R.firstBounce = [e.pos[0], e.pos[1], e.pos[2]];
      R.closeCall = cc;
      if (e.rolling) this._ballPassed();
      return;
    }
    // zweiter Aufsprung
    this._emit('bounce', { pos: e.pos, in: null, speed, index: R.bounces });
    if (owner !== R.lastHitter) this._ballPassed();
    else this._netError(e.pos);
  }

  _closeCall(pos, margin, opts) {
    const o = this._ccOpts || (this._ccOpts = {});
    o.margin = margin;
    o.serverSide = opts ? opts.serverSide : 0; o.box = opts ? opts.box : undefined;
    lineDistance(pos[0], pos[2], o, _ld);
    if (Math.abs(_ld.dist) > 0.03) return null;
    return { pos: [pos[0], 0, pos[2]], distanceMm: Math.round(Math.abs(_ld.dist) * 10000) / 10, in: _ld.in, line: _ld.line, lineX: _ld.lineX, lineZ: _ld.lineZ, axis: _ld.axis };
  }

  // ---------------------------------------------------------------- Aufschlagfehler / Netz
  _serveFault(kind, pos, cc) {
    const R = this.rally, S = this.state;
    R.decided = true;
    const n = this.serveNo;
    const srv = this.players[S.server];
    const kmh = R.lastShot ? R.lastShot.kmh : 0;
    R.faultKmh = kmh;
    this._emit('fault', { n, player: srv.index, kind, pos, closeCall: cc });
    if (n === 1) {
      this.serveNo = 2; S.serveNo = 2;
      this._pauseServe(TIMING.faultPause);
      return;
    }
    this._emit('double_fault', { player: srv.index, closeCall: cc });
    this._decide(S.receiver, 'double_fault', { closeCall: cc, faultKmh: kmh });
  }

  _serveLet() {
    const S = this.state, R = this.rally;
    R.decided = true;
    this._emit('let', { player: S.server, serveNo: this.serveNo });
    this._pauseServe(TIMING.letPause);
  }

  _pauseServe(dur) {
    const S = this.state;
    // zurück in die Aufschlagphase (Ball fliegt aus, dann neuer Ball)
    S.prevPhase = S.phase; S.phase = 'serve'; this._phaseT = 0;
    this._emit('phase', { phase: 'serve', prev: S.prevPhase, pause: dur });
    const V = this.srv;
    V.state = 'pause'; V.t = 0; V.pause = dur;
    for (const p of this.players) { p.pending = null; p.charge = 0; p.plan = null; p.trajValid = false; if (p.stroke && p.stroke.done) p.stroke = null; }
    this.players[S.server].servePhase = 'follow';
  }

  /** Ball fliegt nach entschiedenem Punkt weiter (nur Ton/Optik-Ereignisse). */
  _stepBallFree(h) {
    if (this.ball.mode !== 'air' && this.ball.mode !== 'roll') return;
    const ev = this.ball.step(h);
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.type === 'bounce') this._emit('bounce', { pos: e.pos, in: null, speed: e.speedIn, index: e.index, dead: true });
      else if (e.type === 'net' || e.type === 'post') this._emit('net', { pos: e.pos, cord: !!e.cord, speed: e.speedIn, dead: true });
    }
  }

  // ---------------------------------------------------------------- Punktentscheidung
  /** Ball des letzten Schlägers ist aus (oder in die Bande). */
  _ballOut(pos, cc, how = 'long') {
    const R = this.rally;
    const hitter = R.lastHitter;
    const ls = R.lastShot;
    if (R.isServe) { this._serveFault(how, pos, cc); return; }
    this._error(hitter, 'out', cc, how);
  }

  /** Ball blieb im Netz / auf der eigenen Seite. */
  _netError(pos) {
    const R = this.rally;
    if (R.isServe) { this._serveFault('net', pos, null); return; }
    this._error(R.lastHitter, 'net', null, 'net');
  }

  _error(hitter, kind, cc, how) {
    const R = this.rally;
    const ls = R.lastShot;
    const forced = !!ls && ls.pressure >= 0.35;
    let reason;
    if (ls && ls.returnOfServe && forced) reason = 'service_winner';
    else if (forced) reason = 'forced_error';
    else reason = kind;   // 'net' | 'out' (unerzwungen)
    if (ls && ls.quality === 'frame' && !forced) reason = 'unforced_error';
    this._decide(1 - hitter, reason, { error: kind, how, forced, closeCall: cc });
  }

  /** Gegner hat den (guten) Ball nicht zurückgebracht. */
  _ballPassed() {
    const R = this.rally, S = this.state;
    const hitter = R.lastHitter;
    let reason;
    if (R.isServe) reason = 'ace';
    else {
      // Doppelter Aufsprung im Feld nach kurzem Ball (Stopp, Netzroller) – sonst klarer Winner
      const fb = R.firstBounce, lb = this.ball.lastBounce;
      reason = fb && Math.abs(fb[2]) < COURT.serviceLineZ + 0.5 && R.bounces >= 2 && isInSingles(lb[0], lb[2], 0) ? 'double_bounce' : 'winner';
    }
    this._decide(hitter, reason, { closeCall: R.closeCall });
  }

  _decide(winner, reason, extra = {}) {
    const R = this.rally, S = this.state;
    R.decided = true;
    const P = this.players;
    const atNet = [!!P[0].wentToNet, !!P[1].wentToNet];
    const pre = this.score.flags();
    const bigPoint = pre.breakPoint != null || pre.setPoint != null || pre.matchPoint != null;
    const detail = {
      reason, serve: this.serveNo, rally: R.hits, serveKmh: reason === 'double_fault' ? 0 : R.serveKmh,
      faultKmh: this.serveNo === 2 ? R.faultKmh : 0, atNet, forced: !!extra.forced,
    };
    const rulesEv = this.score.pointWon(winner, detail);
    const rp = rulesEv.find((e) => e.type === 'point');
    const point = {
      winner, loser: 1 - winner, reason, rally: R.hits, closeCall: extra.closeCall || null,
      error: extra.error || null, how: extra.how || null, forced: !!extra.forced, serveNo: this.serveNo,
      server: S.server, lastShot: R.lastShot, atNet, bigPoint,
      call: rp ? rp.call : this.score.lastCall, de: rp ? rp.de : null, score: this.score.view(),
      duration: this.time - (this._pointStart || this.time),
    };
    this._emit('point', point);
    let gameEv = null, setEv = null, matchEv = null;
    this.pendingChangeEnds = false;
    for (const e of rulesEv) {
      if (e.type === 'point') continue;
      if (e.type === 'change_ends') { this.pendingChangeEnds = true; continue; }   // eigene Phase
      if (e.type === 'game') gameEv = e;
      if (e.type === 'set') setEv = e;
      if (e.type === 'match') matchEv = e;
      const copy = Object.assign({}, e); delete copy.type;
      this._emit(e.type, copy);
    }
    S.pointWinner = winner; S.lastPoint = point;
    this.pointInfo = { winner, reason, point, big: !!(matchEv || setEv || (gameEv && gameEv.broken) || bigPoint), game: gameEv, set: setEv, match: matchEv };
    for (const p of this.players) { p.pending = null; p.charge = 0; p.plan = null; }
    this._enter('point_over');
  }

  // ---------------------------------------------------------------- Nach dem Punkt
  _movePlayersIdle(h) {
    for (const p of this.players) {
      p.applyMove(h, 0, 0);
      if (p.stroke && this.time >= p.stroke.contactTime + STROKES[p.stroke.type].follow) p.stroke = null;
      this._tickSplit(p, h);
    }
  }

  _tickPointOver(h) {
    this._stepBallFree(h);
    this._movePlayersIdle(h);
    const info = this.pointInfo;
    if (info && !info.emoted && this._phaseT >= 0.35) {
      info.emoted = true;
      this._chooseEmotes(info);
    }
    for (const p of this.players) { p.ready = Math.max(0, p.ready - h * 1.5); if (!p.stroke) p.mode = p.emote ? 'emote' : 'idle'; }
    const skip = this._humanSkip() && this._phaseT >= TIMING.pointOverMin;
    if (this._phaseT >= TIMING.pointOver || skip) {
      if (this.score.over) this._enter('match_over');
      else if (this.pendingChangeEnds) this._enter('change_ends');
      else this._enter('between_points');
    }
  }

  _chooseEmotes(info) {
    const w = this.players[info.winner], l = this.players[1 - info.winner];
    const r = info.reason;
    const rng = this.rng;
    let we = null, le = null;
    if (info.match || info.set) we = 'celebrate';
    else if (info.big) we = rng.chance(0.6) ? 'celebrate' : 'fistpump';
    else if (r === 'ace' || r === 'winner' || r === 'service_winner' || r === 'double_bounce') we = rng.chance(0.55) ? 'fistpump' : null;
    else if (info.point.rally >= 9) we = 'fistpump';
    const ls = info.point.lastShot;
    const cord = this.rally.netTouched && (r === 'winner' || r === 'double_bounce' || r === 'ace');
    if (cord) { le = 'shrug'; we = rng.chance(0.5) ? 'wave' : null; }
    else if (r === 'net' || r === 'out' || r === 'unforced_error' || r === 'double_fault') le = rng.chance(0.7) ? 'dejected' : 'shrug';
    else if (info.big) le = 'dejected';
    else if (r === 'winner' && rng.chance(0.3)) le = 'shrug';
    if (info.match) le = 'dejected';
    w.emote = we; l.emote = le;
    if (we) this._emit('emote', { player: w.index, name: we });
    if (le) this._emit('emote', { player: l.index, name: le });
  }

  _tickBetween(h) {
    if (this.instantReset) {
      // stehen bleiben (Emote läuft aus); beim nächsten pre_serve werden die Spieler direkt aufgestellt
      for (const p of this.players) {
        p.applyMove(h, 0, 0);
        p.mode = p.emote ? 'emote' : 'idle';
        p.ready = 0;
      }
    } else {
      // langsam zurück Richtung nächste Position
      const nextServer = this.score.server;
      for (const p of this.players) {
        const tz = p.side * (HL + (p.index === nextServer ? 0.3 : 1.2));
        const tx = clamp(p.pos[0] * 0.5, -2.5, 2.5);
        p.steerTo(h, tx, tz, 0.26);
        p.mode = Math.hypot(p.vel[0], p.vel[2]) > 0.3 ? 'walk' : 'idle';
        p.ready = 0;
      }
    }
    const skip = this._humanSkip() && this._phaseT >= TIMING.betweenMin;
    if (this._phaseT >= TIMING.betweenPoints || skip) this._enter('pre_serve');
  }

  _tickChangeEnds(h) {
    const T = this.instantReset ? TIMING.changeEndsQuick : TIMING.changeEnds;
    for (const p of this.players) {
      if (this.instantReset) p.applyMove(h, 0, 0);                       // stehen bleiben, die Blende übernimmt
      else p.steerTo(h, -(SW + 2.5), p.side * 2.6, 0.42);              // zur Bank (Westseite x < 0, z = ±2.6)
      p.mode = Math.hypot(p.vel[0], p.vel[2]) > 0.3 ? 'walk' : 'idle';
      p.ready = 0;
    }
    const skip = this._humanSkip() && this._phaseT >= TIMING.changeEndsMin;
    if (this._phaseT >= T || skip) {
      for (let i = 0; i < 2; i++) {
        const p = this.players[i];
        p.side = this.score.sides[i];
        p.pos[2] = -p.pos[2];
        p.vel[0] = p.vel[2] = 0;
        p.pos[2] = p.side * Math.abs(p.pos[2]);
      }
      this.pendingChangeEnds = false;
      this._enter('pre_serve');
    }
  }

  _tickMatchOver(h) {
    this._stepBallFree(h);
    this._movePlayersIdle(h);
    if (this._phaseT >= 0.5 && !this._finalEmotes) {
      this._finalEmotes = true;
      const w = this.score.winner;
      if (w != null) {
        this.players[w].emote = 'celebrate'; this.players[1 - w].emote = 'dejected';
      }
    }
  }

  // ---------------------------------------------------------------- Split-Step
  _scheduleSplit(p, contactTime) {
    if (Math.hypot(p.vel[0], p.vel[2]) > 3.2) return;
    p.splitAt = contactTime - 0.12;
    p.splitEnd = contactTime + 0.1;
    p.splitEmitted = false;
  }

  _splitActive(p) { return p.splitAt != null && this.time >= p.splitAt && this.time < p.splitEnd; }

  _tickSplit(p, h) {
    if (p.splitAt == null) { p.split = 0; return; }
    if (this.time >= p.splitAt && this.time < p.splitEnd) p.split = p.splitEnd - this.time;
    else p.split = 0;
    if (this.time >= p.splitEnd && !p.splitEmitted) {
      p.splitEmitted = true;
      p._splitBoost = 0.35;
      this._emit('split_step', { player: p.index, pos: [p.pos[0], 0, p.pos[2]] });
      p.splitAt = null;
    }
    if (p._splitBoost > 0) p._splitBoost -= h;
  }

  // ---------------------------------------------------------------- Blick / Gier
  _updateLook(h) {
    const S = this.state, b = this.ball.pos;
    for (const p of this.players) {
      const o = this.players[1 - p.index];
      const ph = S.phase;
      let target;
      const sp = Math.hypot(p.vel[0], p.vel[2]);
      if ((ph === 'between_points' || ph === 'change_ends' || ph === 'pre_serve') && sp > 0.8) {
        target = Math.atan2(p.vel[0], p.vel[2]);
        p.lookAt[0] = p.pos[0] + p.vel[0]; p.lookAt[1] = 1.5; p.lookAt[2] = p.pos[2] + p.vel[2];
      } else {
        target = p.netYaw;
        if (S.ball.visible && (ph === 'rally' || ph === 'serve' || ph === 'point_over')) { p.lookAt[0] = b[0]; p.lookAt[1] = b[1]; p.lookAt[2] = b[2]; }
        else { p.lookAt[0] = o.pos[0]; p.lookAt[1] = 1.5; p.lookAt[2] = o.pos[2]; }
      }
      if (p.stroke) target = p.netYaw;
      let d = target - p.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      const rate = (p.stroke ? 14 : 7) * h;
      p.yaw += clamp(d, -rate, rate);
      if (p.yaw > Math.PI) p.yaw -= 2 * Math.PI;
      if (p.yaw < -Math.PI) p.yaw += 2 * Math.PI;
    }
  }
}

const BNC = { t: 0, pos: new Float64Array(3), vel: new Float64Array(3), velIn: new Float64Array(3) };

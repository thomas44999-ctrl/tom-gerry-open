// Spieler: Zustand, Bewegung (Beschleunigung/Bremsen aus PLAYER_STATS), Abfangplanung
// (Treffpunkt-Kandidaten entlang der Ballvorhersage), Zielwahl aus der Eingabe und Schlagausführung
// (sichtbarer Zielkreis + Schlag-Löser, kein verdeckter Würfel). Reine Logik, deterministisch (Rng), node-testbar.

import { COURT } from '../sim/court.js';
import { STROKES, SHOT_TO_STROKE, PLAYER_STATS, HIT, RISK, strokeContactWorld } from '../sim/strokes.js';
import { Trajectory, RPM } from '../sim/ball.js';
import { solveShot, presetParams } from '../sim/shot.js';

const HL = COURT.halfLength;
const SW = COURT.singlesHalfWidth;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------- Zufall (deterministisch)
export class Rng {
  constructor(seed = 1) { this.s = (seed >>> 0) || 0x9e3779b9; this._spare = NaN; }
  /** mulberry32: gleichverteilt in [0, 1). */
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length) % arr.length]; }
  /** Standardnormalverteilt (Box-Muller). */
  gauss() {
    if (!Number.isNaN(this._spare)) { const v = this._spare; this._spare = NaN; return v; }
    let u = 0, v = 0;
    while (u < 1e-12) u = this.next();
    v = this.next();
    const m = Math.sqrt(-2 * Math.log(u));
    this._spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  }
  /** Begrenzte Normalverteilung (|x| <= lim Standardabweichungen). */
  gaussC(lim = 2.5) { return clamp(this.gauss(), -lim, lim); }
}

// ---------------------------------------------------------------- Schwierigkeit
// human*: Werte für menschlich gesteuerte Spieler (nur noch Aufschlag); ai*: für KI-Spieler (siehe ai.js).
// aiError wirkt nur noch auf den Aufschlag: Im Ballwechsel nutzt die KI denselben Zielkreis wie der Mensch.
// aiKeep: Risikobereitschaft – Abstand der Kreismitte zur Linie in Kreisradien (1 = Kreis ganz im Feld).
// aiPower: gewünschte Kraft (Powerbalken 0..1, Bereich), je nach Lage und Laufweg weniger.
export const DIFFICULTY = {
  easy: {
    name: 'easy',
    humanError: 0.72,
    aiError: 1.1, aiReaction: 0.3, aiRead: 0.15, aiAnticipate: 0.5, aiSpeed: 0.84, aiAggression: 0.25, aiPower: [0.25, 0.6],
    aiServeSigma: 0.07, aiNetRush: 0.04, aiSmart: 0.35, aiDrop: 0.03, aiLatePress: 0.08,
    aiServePower: [0.45, 0.75], aiMargin: 1.05, aiFhBias: 0.10, aiPosErr: 0.42, aiKeep: 0.55,
  },
  normal: {
    name: 'normal',
    humanError: 0.85,
    aiError: 1.0, aiReaction: 0.22, aiRead: 0.35, aiAnticipate: 0.8, aiSpeed: 0.93, aiAggression: 0.5, aiPower: [0.45, 0.85],
    aiServeSigma: 0.045, aiNetRush: 0.14, aiSmart: 0.72, aiDrop: 0.06, aiLatePress: 0.02,
    aiServePower: [0.6, 0.9], aiMargin: 0.8, aiFhBias: 0.22, aiPosErr: 0.28, aiKeep: 0.85,
  },
  hard: {
    name: 'hard',
    humanError: 0.92,
    aiError: 0.86, aiReaction: 0.15, aiRead: 0.55, aiAnticipate: 0.9, aiSpeed: 1.0, aiAggression: 0.66, aiPower: [0.6, 1.0],
    aiServeSigma: 0.028, aiNetRush: 0.24, aiSmart: 1.0, aiDrop: 0.08, aiLatePress: 0.0,
    aiServePower: [0.72, 1.0], aiMargin: 0.62, aiFhBias: 0.45, aiPosErr: 0.18, aiKeep: 1.05,
  },
};
export const difficultyOf = (d) => DIFFICULTY[d] || DIFFICULTY.normal;

/** Laufhilfe für menschliche Spieler (Einstellung, unabhängig vom Gegner): Zug zum idealen Standort. */
export const ASSIST = { off: 0, light: 0.3, strong: 0.7 };
export const assistOf = (a) => (typeof a === 'number' ? a : ASSIST[a] ?? ASSIST.light);

// ---------------------------------------------------------------- Zielwahl aus aim (lr, depth)
// Tiefe = Abstand des Ziels vom Netz (m) für aim.depth = -1 / 0 / +1 je Schlagart.
export const AIM_DEPTH = {
  topspin: [6.2, 9.4, 10.55], flat: [6.6, 9.6, 10.6], slice: [5.6, 8.9, 10.35], lob: [8.2, 9.7, 10.7],
  drop: [1.6, 2.6, 3.8], volley: [4.6, 8.4, 10.3], smash: [5.2, 7.8, 9.9],
};
const AIM_XMAX = { topspin: 3.55, flat: 3.5, slice: 3.5, lob: 3.2, drop: 3.3, volley: 3.6, smash: 3.5 };

/**
 * Zielpunkt (Landepunkt) aus Eingabe. lr/depth aus Sicht des Schlagenden (-1..1), side = Seite des Schlagenden,
 * hitX = x des Treffpunkts. Neutral (0,0) = tief, leicht cross (zurück zur Mitte).
 */
export function aimToTarget(side, hitX, lr, depth, shot = 'topspin', out = {}) {
  const D = AIM_DEPTH[shot] || AIM_DEPTH.topspin;
  const dp = clamp(depth, -1, 1);
  const d = dp >= 0 ? lerp(D[1], D[2], dp) : lerp(D[1], D[0], -dp);
  const xMax = AIM_XMAX[shot] || 3.5;
  const x0 = clamp(-hitX * 0.25, -1.2, 1.2);              // neutral: leicht cross
  const l = clamp(lr, -1, 1);
  const xs = side * l * xMax;                             // rechts des Spielers auf Seite s = +s·X
  out.x = lerp(x0, xs, Math.abs(l));
  out.z = -side * d;
  return out;
}

/** Umkehrung von aimToTarget (für die KI): gewünschter Landepunkt -> { lr, depth }. */
export function targetToAim(side, hitX, x, z, shot = 'topspin', out = {}) {
  const D = AIM_DEPTH[shot] || AIM_DEPTH.topspin;
  const d = Math.abs(z);
  out.depth = d >= D[1] ? clamp((d - D[1]) / (D[2] - D[1]), 0, 1) : -clamp((D[1] - d) / (D[1] - D[0]), 0, 1);
  const xMax = AIM_XMAX[shot] || 3.5;
  const x0 = clamp(-hitX * 0.25, -1.2, 1.2);
  // x = x0 + (s·l·xMax - x0)·|l|  -> nach l auflösen (monoton in l)
  let lo = -1, hi = 1;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    const xm = lerp(x0, side * m * xMax, Math.abs(m));
    if ((xm < x) === (side > 0)) lo = m; else hi = m;
  }
  out.lr = (lo + hi) / 2;
  return out;
}

// ---------------------------------------------------------------- Spieler
const TMP = new Float64Array(3);

export class Player {
  constructor(index, id, opts = {}) {
    this.index = index;
    this.id = id;
    this.stats = PLAYER_STATS[id] || PLAYER_STATS.tom;
    this.name = this.stats.name || id;
    this.scale = this.stats.reachScale || 1;
    this.human = !!opts.human;
    this.diff = difficultyOf(opts.difficulty);
    this.assist = assistOf(opts.assist);
    // --- öffentlicher Zustand (PlayerState, ARCHITECTURE §7)
    this.pos = [0, 0, 0];
    this.vel = [0, 0, 0];
    this.yaw = 0;
    this.side = 1;
    this.mode = 'idle';            // 'idle'|'walk'|'ready'|'move'|'stroke'|'serve'|'recover'|'emote'
    this.stroke = null;            // { type, shot, hand, start, windup, contactTime, contact:[x,y,z], power, rushed }
    this.emote = null;             // Emote-Vorschlag (character.playEmote)
    this.charge = 0;               // 0..1 Powerbalken (ab Tastendruck, friert beim Treffer ein; Kraft = dieser Wert)
    this.chargeShot = null;        // gewählte Schlagart während des Aufladens
    this.serveMeter = null;        // 0..1 während des Aufschlags (UI), sonst null
    this.serveMeterLocked = false;
    this.servePhase = null;        // 'ready'|'bounce'|'toss'|'swing'|'follow'|null (character.playServe)
    this.ready = 0;                // Bereitschaft 0..1 (character.setLocomotion)
    this.lookAt = [0, 1, 0];       // Blickziel (Ball/Gegner)
    this.split = 0;                // > 0: Split-Step läuft (Restzeit s)
    this.atNet = false;
    this.netMode = false;          // KI/Taktik: Netzangriff
    this.plan = null;              // aktueller Abfangplan (siehe planIntercept) oder null
    this.lastHit = null;           // { quality, shot, type, time, pressure }
    this.preview = { on: false, x: 0, z: 0, r: 0, red: false, net: false, quality: 'good' };   // Zielkreis beim Laden
    this.recover = 0;              // > 0: nach einem Rettungsschlag (s), langsamer
    // --- intern
    this.pending = null;           // { shot, pressTime }
    this._plan = makePlan();
    this._planAge = 1e9;
    this.traj = new Trajectory(900);
    this.trajValid = false;
    this.trajLaunch = 0;           // Matchzeit des Abflugs der vorhergesagten Bahn
    this._splitBoost = 0;
    this.walkTarget = null;        // [x, z] Ziel beim automatischen Gehen
    this.lastPressTime = -1;
  }

  /** Blickrichtung zum Netz (Gier). */
  get netYaw() { return this.side > 0 ? Math.PI : 0; }

  /** Zurücksetzen zwischen Punkten. */
  resetForPoint() {
    this.stroke = null; this.pending = null; this.charge = 0; this.chargeShot = null;
    this.plan = null; this._plan.valid = false; this.trajValid = false;
    this.split = 0; this._splitBoost = 0; this.netMode = false; this.lastHit = null;
    this.serveMeter = null; this.serveMeterLocked = false; this.servePhase = null;
    this.wentToNet = false; this.missed = false; this.splitAt = null; this.atNet = false;
    this.predBounceIn = true; this.predBounce = null;
    this.preview.on = false; this.recover = 0;
  }

  /**
   * Bewegung mit begrenzter Beschleunigung. (mx, mz) = gewünschte Richtung * Anteil (|m| <= 1) der Maximalgeschwindigkeit.
   * speedMul skaliert die Maximalgeschwindigkeit (z. B. beim Aufladen langsamer).
   */
  applyMove(h, mx, mz, speedMul = 1) {
    const S = this.stats;
    let m = Math.hypot(mx, mz);
    if (m > 1) { mx /= m; mz /= m; m = 1; }
    const boost = this._splitBoost > 0 ? 1.18 : 1;
    const vmax = S.maxSpeed * speedMul;
    const tx = mx * vmax, tz = mz * vmax;
    const vx = this.vel[0], vz = this.vel[2];
    let dvx = tx - vx, dvz = tz - vz;
    const sp = Math.hypot(vx, vz);
    let ax, az;
    if (sp > 0.05) {
      // Komponente entlang der aktuellen Bewegung: Bremsen (decel) oder Beschleunigen (accel); quer: accel
      const ux = vx / sp, uz = vz / sp;
      const along = dvx * ux + dvz * uz;
      const pxv = dvx - along * ux, pzv = dvz - along * uz;
      const ra = (along < 0 ? S.decel : S.accel * boost) * h;
      const a1 = clamp(along, -ra, ra);
      const pl = Math.hypot(pxv, pzv), rp = S.accel * boost * h * 0.9;
      const k = pl > rp ? rp / pl : 1;
      ax = a1 * ux + pxv * k; az = a1 * uz + pzv * k;
    } else {
      const l = Math.hypot(dvx, dvz), r = S.accel * boost * h;
      const k = l > r ? r / l : 1;
      ax = dvx * k; az = dvz * k;
    }
    this.vel[0] = vx + ax; this.vel[2] = vz + az;
    this.pos[0] += this.vel[0] * h; this.pos[2] += this.vel[2] * h;
    this.clampToArea();
  }

  /** Zum Punkt (x, z) gehen/laufen mit Ankunftsverhalten. Liefert Restabstand. */
  steerTo(h, x, z, speedFrac = 1, speedMul = 1) {
    const dx = x - this.pos[0], dz = z - this.pos[2];
    const d = Math.hypot(dx, dz);
    if (d < 0.02 && Math.hypot(this.vel[0], this.vel[2]) < 0.2) {
      this.applyMove(h, 0, 0, speedMul);
      return d;
    }
    const vmax = this.stats.maxSpeed * speedMul;
    const vArr = Math.sqrt(2 * this.stats.decel * 0.8 * d);
    const f = Math.min(speedFrac, vArr / vmax, 1);
    this.applyMove(h, (dx / (d || 1)) * f, (dz / (d || 1)) * f, speedMul);
    return d;
  }

  /** Spieler bleibt auf seiner Hälfte (darf etwas seitlich/hinter die Grundlinie). */
  clampToArea() {
    const s = this.side;
    const zMin = 0.45, zMax = HL + 5.6, xMax = SW + 3.3;
    let z = this.pos[2] * s;
    if (z < zMin) { z = zMin; if (this.vel[2] * s < 0) this.vel[2] = 0; }
    if (z > zMax) { z = zMax; if (this.vel[2] * s > 0) this.vel[2] = 0; }
    this.pos[2] = z * s;
    if (this.pos[0] > xMax) { this.pos[0] = xMax; if (this.vel[0] > 0) this.vel[0] = 0; }
    if (this.pos[0] < -xMax) { this.pos[0] = -xMax; if (this.vel[0] < 0) this.vel[0] = 0; }
  }

  /** Geschätzte Zeit, um (dx, dz) zurückzulegen (Beschleunigen/Bremsen, aktuelle Geschwindigkeit). */
  travelTime(dx, dz) {
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return 0;
    const S = this.stats, vmax = S.maxSpeed, a = 0.5 * (S.accel + S.decel);
    const vAlong = (this.vel[0] * dx + this.vel[2] * dz) / d;
    const dEff = Math.max(0, d - Math.max(0, vAlong) * 0.14) + Math.max(0, -vAlong) * 0.12;
    const dAcc = (vmax * vmax) / a;
    return dEff < dAcc ? 2 * Math.sqrt(dEff / a) : dEff / vmax + vmax / a;
  }

  /** Idealer Spielerstandort (x, z) für einen Treffpunkt bei Kontakt-Offset c (Spielerrahmen, Blick zum Netz). */
  idealPosFor(out, bx, bz, c) {
    const s = this.side, k = this.scale;
    out[0] = bx - s * c.right * k;
    out[1] = 0;
    out[2] = bz + s * c.forward * k;
    return out;
  }

  /** Schlägerposition (Welt) für Kontakt-Offset c bei aktueller Position. */
  racketPoint(out, c) { return strokeContactWorld(out, this.pos, this.netYaw, c, this.scale); }
}

// ---------------------------------------------------------------- Abfangplanung
function makePlan() {
  return {
    valid: false, t: 0, time: 0, family: 'ground', hand: 'fh', pre: false,
    contact: [0, 0, 0], pos: [0, 0, 0], ballVel: [0, 0, 0], height: 0,
    slack: 0, need: 0, avail: 0, dist: 0, feasible: false, score: 0, bounceIn: true,
  };
}

const C_GROUND = { fh: STROKES.forehand.contact, bh: STROKES.backhand.contact };
const C_VOLLEY = { fh: STROKES.forehand_volley.contact, bh: STROKES.backhand_volley.contact };
const C_SMASH = STROKES.smash.contact;
const H_GROUND = STROKES.forehand.height, H_VOLLEY = STROKES.forehand_volley.height, H_SMASH = STROKES.smash.height;

/** Kontakt-Offset für Familie/Hand. */
export function contactOffset(family, hand) {
  if (family === 'smash') return C_SMASH;
  if (family === 'volley') return C_VOLLEY[hand];
  return C_GROUND[hand];
}

/** Schlüssel in STROKES für Familie/Hand/Schlagart. */
export function strokeKey(family, hand, shot) {
  if (family === 'smash') return 'smash';
  if (family === 'volley') return hand === 'fh' ? 'forehand_volley' : 'backhand_volley';
  const m = SHOT_TO_STROKE[shot] || SHOT_TO_STROKE.topspin;
  return m[hand];
}

const _cp = new Float64Array(3), _cv = new Float64Array(3), _ip = new Float64Array(3);

/**
 * Sucht den besten Treffpunkt entlang der vorhergesagten Bahn (p.traj, t = 0 beim Abflug).
 * tRel = vergangene Zeit seit Abflug. o = { serveReturn, allowVolley, volleyBonus, fhBias, reaction, bounceIn, aggressive }.
 * Ergebnis in p._plan (valid=false wenn kein Kandidat), p.plan wird gesetzt.
 */
export function planIntercept(p, tRel, launchTime, o) {
  const tr = p.traj, plan = p._plan;
  const s = p.side, k = p.scale;
  const prevValid = plan.valid && p.plan === plan, prevT = plan.t, prevHand = plan.hand, prevFam = plan.family;
  plan.valid = false;
  p.plan = null;
  if (!p.trajValid || tr.count < 2) return null;
  const tb0 = tr.bounceTime(0);
  let tEnd = tr.duration;
  if (tb0 >= 0) {
    const b = tr.bounce(0, BNC);
    if (b.pos[2] * s < 0) return null;                       // Ball springt auf der Seite des Schlagenden (Netz)
    const tb1 = tr.bounceTime(1);
    if (tb1 >= 0) tEnd = tb1;
  }
  const bounceIn = o.bounceIn !== false;
  const reaction = o.reaction || 0;
  const volleyZ = o.volleyZ ?? COURT.serviceLineZ + 2.6;
  const fhBias = o.fhBias ?? 0.15;
  let best = -1e9, bestT = -1, bestFam = '', bestHand = 'fh', bestNeed = 0, bestAvail = 0, bestDist = 0, bestFeas = false;
  const step = 1 / 60;
  let t0 = Math.max(tRel + 0.06, 0);
  for (let t = t0; t <= tEnd - 0.01; t += step) {
    tr.positionAt(t, _cp);
    const bz = _cp[2] * s;
    if (bz < 0.35) continue;                                 // Ball noch nicht auf meiner Seite
    if (bz > HL + 6.2 || Math.abs(_cp[0]) > SW + 4.2) break; // Ball verlässt den erreichbaren Bereich
    const pre = tb0 < 0 || t < tb0;
    if (!pre && !bounceIn) break;                            // Aus: nach dem Aufsprung ist der Punkt vorbei
    const hgt = _cp[1];
    let fam;
    if (pre) {
      if (o.serveReturn) continue;
      if (hgt >= H_SMASH[0] * k && hgt <= H_SMASH[1] * k && bz < HL - 0.5 && (o.allowVolley || bz > HL - 3.5)) fam = 'smash';
      else if (o.allowVolley && hgt >= H_VOLLEY[0] * k && hgt <= H_VOLLEY[1] * k && bz <= volleyZ) fam = 'volley';
      else continue;
    } else {
      if (hgt >= H_GROUND[0] * k && hgt <= H_GROUND[1] * k) fam = 'ground';
      else if (hgt >= H_SMASH[0] * k && hgt <= H_SMASH[1] * k && !o.serveReturn) fam = 'smash';
      else continue;
    }
    // Vorhand/Rückhand: seitliche Lage des Balls relativ zum Spieler (rechte Achse = s·X)
    let hand = 'fh';
    if (fam !== 'smash') {
      const lat = (_cp[0] - p.pos[0]) * s;
      let thr = -fhBias;
      if (prevValid && Math.abs(t - prevT) < 0.2) thr += prevHand === 'fh' ? -0.18 : 0.18;   // Hysterese
      hand = lat > thr ? 'fh' : 'bh';
    }
    const c = contactOffset(fam, hand);
    p.idealPosFor(_ip, _cp[0], _cp[2], c);
    // Spieler darf nicht über das Netz
    let blocked = 0;
    if (_ip[2] * s < 0.5) { blocked = 0.5 - _ip[2] * s; _ip[2] = 0.5 * s; }
    const dx = _ip[0] - p.pos[0], dz = _ip[2] - p.pos[2];
    const dist = Math.hypot(dx, dz);
    const reach = STROKES[fam === 'smash' ? 'smash' : fam === 'volley' ? 'forehand_volley' : 'forehand'].reach * k;
    const lunge = reach * 0.5;
    const need = p.travelTime(dx * Math.max(0, 1 - lunge / Math.max(dist, 1e-3)), dz * Math.max(0, 1 - lunge / Math.max(dist, 1e-3))) + reaction;
    const avail = t - tRel;
    const slack = avail - need - blocked * 2;
    const feas = slack >= 0;
    // Bewertung
    const hIdeal = c.up * k;
    let sc;
    if (feas) {
      sc = 1.3 * Math.min(slack, 0.5) - 1.5 * Math.abs(hgt - hIdeal) - 0.2 * avail;
      if (fam === 'ground') {
        sc -= 0.45 * Math.max(0, bz - (HL + 0.8));            // tief hinter der Grundlinie: unangenehm
        if (o.aggressive) sc -= 0.35 * avail;                  // früh nehmen (auf dem Aufsteigen)
        if (hgt > 1.45 * k) sc -= 0.8 * (hgt - 1.45 * k);
      } else if (fam === 'volley') sc += (o.volleyBonus ?? 0.6);
      else sc += 0.5 + (o.volleyBonus ?? 0) * 0.5;
      if (prevValid && Math.abs(t - prevT) < 0.12 && fam === prevFam) sc += 0.2;
    } else {
      sc = -10 + slack * 4 - 0.5 * Math.abs(hgt - hIdeal);
    }
    if (sc > best) {
      best = sc; bestT = t; bestFam = fam; bestHand = hand; bestNeed = need; bestAvail = avail; bestDist = dist; bestFeas = feas;
    }
  }
  if (bestT < 0) return null;
  tr.positionAt(bestT, plan.contact);
  tr.velocityAt(bestT, _cv);
  plan.ballVel[0] = _cv[0]; plan.ballVel[1] = _cv[1]; plan.ballVel[2] = _cv[2];
  const c = contactOffset(bestFam, bestHand);
  p.idealPosFor(plan.pos, plan.contact[0], plan.contact[2], c);
  if (plan.pos[2] * s < 0.5) plan.pos[2] = 0.5 * s;
  plan.valid = true; plan.t = bestT; plan.time = launchTime + bestT;
  plan.family = bestFam; plan.hand = bestHand; plan.pre = tb0 < 0 || bestT < tb0;
  plan.height = plan.contact[1]; plan.need = bestNeed; plan.avail = bestAvail; plan.slack = bestAvail - bestNeed;
  plan.dist = bestDist; plan.feasible = bestFeas; plan.score = best; plan.bounceIn = bounceIn;
  p.plan = plan;
  return plan;
}
const BNC = { t: 0, pos: new Float64Array(3), vel: new Float64Array(3), velIn: new Float64Array(3) };

/**
 * Treffpunkt zur Bahnzeit tRel (s seit Abflug): Schlagfamilie/Hand nach denselben Regeln wie planIntercept, idealer
 * Standort und Abstand des Spielers dorthin. Für "jetzt zuschlagen, der Ball ist da" (Mensch, der nicht für den Plan
 * bereitsteht). o wie bei planIntercept. Liefert out = { family, hand, ball:[x,y,z], pos:[x,y,z], gap } oder null.
 */
export function contactAt(p, tRel, o, out) {
  const tr = p.traj, s = p.side, k = p.scale;
  if (!p.trajValid || tr.count < 2) return null;
  const tb0 = tr.bounceTime(0);
  if (tb0 >= 0) {
    const b = tr.bounce(0, BNC);
    if (b.pos[2] * s < 0) return null;
    const tb1 = tr.bounceTime(1);
    if (tb1 >= 0 && tRel >= tb1) return null;
  }
  const ball = tr.positionAt(tRel, out.ball);
  const bz = ball[2] * s;
  if (bz < 0.35) return null;
  const pre = tb0 < 0 || tRel < tb0;
  if (!pre && o.bounceIn === false) return null;
  const hgt = ball[1];
  let fam = null;
  if (pre) {
    if (o.serveReturn) return null;
    if (hgt >= H_SMASH[0] * k && hgt <= H_SMASH[1] * k && bz < HL - 0.5 && (o.allowVolley || bz > HL - 3.5)) fam = 'smash';
    else if (o.allowVolley && hgt >= H_VOLLEY[0] * k && hgt <= H_VOLLEY[1] * k && bz <= (o.volleyZ ?? COURT.serviceLineZ + 2.6)) fam = 'volley';
  } else if (hgt >= H_GROUND[0] * k && hgt <= H_GROUND[1] * k) fam = 'ground';
  else if (hgt >= H_SMASH[0] * k && hgt <= H_SMASH[1] * k && !o.serveReturn) fam = 'smash';
  if (!fam) return null;
  const hand = fam === 'smash' ? 'fh' : (ball[0] - p.pos[0]) * s > -(o.fhBias ?? 0.15) ? 'fh' : 'bh';
  p.idealPosFor(out.pos, ball[0], ball[2], contactOffset(fam, hand));
  if (out.pos[2] * s < 0.5) out.pos[2] = 0.5 * s;
  out.family = fam; out.hand = hand;
  out.gap = Math.hypot(out.pos[0] - p.pos[0], out.pos[2] - p.pos[2]);
  return out;
}

// ---------------------------------------------------------------- Schlagausführung
/**
 * Treffer am Kontakt. Treffer/Fehlschlag entscheidet allein der Abstand Ball <-> Schlägerpunkt nach dem Ausfallschritt
 * (HIT.radius; Höhe zählt nur außerhalb des Schlagfensters). Die Qualität kommt aus der Stellung beim Schwungstart
 * (st.gap = Abstand zum idealen Standort, st.gapFwd = Anteil nach vorn) bzw. aus zu spätem Drücken (st.rushed).
 * Liefert { quality, err, errN, lat, fwd, up, miss }.
 */
export function contactQuality(p, ballPos, key, st, out = {}) {
  const S = STROKES[key];
  p.racketPoint(TMP, S.contact);
  const s = p.side, k = p.scale;
  const ex = ballPos[0] - TMP[0], ey = ballPos[1] - TMP[1], ez = ballPos[2] - TMP[2];
  // Rahmen: right = s·X, forward = -s·Z
  out.lat = ex * s; out.fwd = -ez * s; out.up = ey;
  const h = ballPos[1], H = S.height;
  const ev = Math.max(0, h - H[1] * k, H[0] * k - h);
  out.err = Math.hypot(out.lat, out.fwd, ev);
  const R = hitRadius(p);
  out.errN = out.err / R;
  out.miss = out.err > R;
  out.quality = strokeQuality(st, out.errN);
  return out;
}

/** Trefferradius der Figur (HIT.radius bei reachScale = HIT.refScale, kleinere Figuren etwas weniger). */
export const hitRadius = (p) => HIT.radius * Math.min(1, p.scale / HIT.refScale);
/** Ausfallschritt der Figur (normal / Rettung), skaliert mit der Reichweite. */
export const lungeOf = (p, rescue = false) => (rescue ? HIT.rescueLunge : HIT.lunge) * p.scale / HIT.refScale;

/** Qualität aus Stellung beim Schwungstart (gap, gapFwd), Rettung und spätem Drücken; errN = Restfehler / Radius. */
export function strokeQuality(st, errN = 0) {
  if (errN > 0.8) return 'frame';
  if (st.rescue) return 'stretch';
  if (st.rushed) return 'late';
  const g = st.gap || 0;
  if (g <= HIT.perfect) return 'perfect';
  if (g > HIT.good) return 'stretch';
  const f = st.gapFwd || 0;
  if (f > 0.3) return 'late';      // Ball kam näher als gedacht: zu weit hinten gestanden
  if (f < -0.3) return 'early';    // zu nah dran / überlaufen
  return 'good';
}

/** Kurzform der Schlagart für Ziel/Löser (Familie + Taste). */
export function shotPreset(fam, shot) {
  if (fam === 'smash') return 'smash';
  if (fam === 'volley') return shot === 'drop' ? 'drop' : shot === 'lob' ? 'lob' : 'volley';
  return shot === 'flat' ? 'flat' : shot;
}
const aimShotOf = (fam, preset) => (fam === 'smash' ? 'smash' : fam === 'volley' && preset === 'volley' ? 'volley' : preset);

/**
 * Radius des Zielkreises (m) – das ganze Risiko eines Schlags, für Mensch und KI gleich.
 * lr/depth = Richtungseingabe (-1..1, depth > 0 = nach vorn/tief), runSpeed = Laufgeschwindigkeit beim Schlag (m/s).
 */
export function spreadRadius(p, preset, fam, power, lr, depth, quality, runSpeed = 0, incomingSpeed = 0, rescue = false) {
  const st = p.stats;
  let r = RISK.base + RISK.power * Math.pow(clamp01(power), RISK.powerExp) + RISK.depth * Math.max(0, depth)
    + RISK.angle * Math.abs(clamp(lr, -1, 1)) + RISK.run * runSpeed;
  r *= RISK.quality[quality] ?? 1;
  r *= 1.25 - 0.35 * (st.control ?? 0.8);
  if (preset === 'drop' || preset === 'lob') r *= 1.2 - 0.3 * (st.touch ?? 0.8);
  if (fam === 'volley') r *= 1.15 - 0.25 * (st.volley ?? 0.8);
  r *= 1 + Math.max(0, incomingSpeed - 20) / 50;
  if (rescue) r *= RISK.rescue;
  return Math.min(r, RISK.maxRadius);
}

/** Reicht der Kreis (Mitte x/z, Radius r) auf der Gegnerseite des Schlagenden (side) über eine Linie? */
export function circleRed(side, x, z, r) {
  const d = -side * z;                                    // Abstand vom Netz auf der Gegnerseite
  return Math.abs(x) + r > SW || d + r > HL || d - r < 0.3;
}

/** Netzfehler (sichtbar begründet): sehr tiefer Ball und fast volle Kraft bei Grundschlag/Volley. */
export function netRiskOf(p, preset, fam, power, h) {
  if (preset === 'lob' || fam === 'smash') return false;
  return h / p.scale < RISK.lowBall && power >= RISK.netPower;
}

/**
 * Zielkreis ohne Ausführung (Anzeige beim Laden, Entscheidungen der KI).
 * o = { shot, family, power, aim:[lr, depth], from:[x,y,z] (Treffpunkt), quality, runSpeed, incomingSpeed, rescue }
 * Ergebnis out = { x, z, r, red, net, preset }.
 */
export function previewShot(p, o, out = {}) {
  const preset = shotPreset(o.family, o.shot);
  const lr = o.aim ? clamp(o.aim[0], -1, 1) : 0, dp = o.aim ? clamp(o.aim[1], -1, 1) : 0;
  aimToTarget(p.side, o.from[0], lr, dp, aimShotOf(o.family, preset), out);
  out.r = spreadRadius(p, preset, o.family, o.power, lr, dp, o.quality || 'good', o.runSpeed || 0, o.incomingSpeed || 0, !!o.rescue);
  out.red = circleRed(p.side, out.x, out.z, out.r);
  out.net = netRiskOf(p, preset, o.family, o.power, o.from[1]);
  out.preset = preset;
  return out;
}

const _sol = { requested: {}, landing: {}, vel: new Float64Array(3), spin: new Float64Array(3) };
const _pp = {}, _spinReq = { top: 0, side: 0, rifle: 0 };

/**
 * Schlag berechnen. req = { p, rng, shot, family, key, from:[x,y,z], aim:[lr, depth] | null, target:{x,z} | null,
 *   quality, power, incomingSpeed, runSpeed, rescue }
 * Kraft = req.power (exakt der Balkenwert). Der Ball landet gleichverteilt im Zielkreis (Mitte = Zielpunkt aus der
 * Richtung, Radius = spreadRadius). Richtung nach vorn = härter/flacher/tiefer, nach hinten = kürzer/höher.
 * Netzfehler nur bei netRiskOf (tiefer Ball + volle Kraft).
 * Liefert { ok, vel, spin, speed, rpm, target:{x,z} (Landepunkt), aimTarget:{x,z} (Kreismitte), radius, red, power, preset, netDump }.
 */
export function resolveShot(req, out = {}) {
  const { p, rng } = req;
  const st = p.stats;
  const fam = req.family;
  const preset = shotPreset(fam, req.shot);
  const lr = req.aim ? clamp(req.aim[0], -1, 1) : 0, dp = req.aim ? clamp(req.aim[1], -1, 1) : 0;
  // --- Kreismitte
  const tgt = out.aimTarget || (out.aimTarget = {});
  if (req.target) { tgt.x = req.target.x; tgt.z = req.target.z; }
  else aimToTarget(p.side, req.from[0], lr, dp, aimShotOf(fam, preset), tgt);
  // --- Kraft (exakt)
  const power = clamp01(req.power ?? 0.5);
  const h = req.from[1];
  // --- Zielkreis + Landepunkt (gleichverteilt im Kreis)
  const q = req.quality || 'good';
  const r = spreadRadius(p, preset, fam, power, lr, dp, q, req.runSpeed || 0, req.incomingSpeed || 0, !!req.rescue);
  const u = rng.next(), a = rng.next() * 2 * Math.PI, rr = r * Math.sqrt(u);
  const target = out.target || (out.target = {});
  target.x = tgt.x + rr * Math.cos(a);
  let tz = tgt.z + rr * Math.sin(a);
  if (tz * -p.side < 0.6) tz = -p.side * 0.6;               // Landepunkt bleibt auf der Gegenseite
  target.z = tz;
  // --- Lösen
  let sol, flat = 0;
  if (preset === 'topspin' || preset === 'flat') {
    // Kraft + Richtung vorn -> flacher, schneller Drive; Richtung hinten -> höherer, sicherer Bogen
    const pp = presetParams('topspin', power, st, _pp);
    flat = clamp(0.72 * power + 0.3 * Math.max(0, dp) - 0.2 * Math.max(0, -dp) - 0.12 + (h / p.scale - 0.85) * 0.5 + (preset === 'flat' ? 0.25 : 0), 0, 0.85);
    _spinReq.top = pp.topRpm * (1 - 0.6 * flat); _spinReq.side = 0; _spinReq.rifle = 0;
    const speed = lerp(12.5, 30 * (0.7 + 0.35 * (st.power ?? 0.8)), power) * (1 + 0.1 * dp);
    sol = solveShot({ from: req.from, target, spin: _spinReq, speed, minClearance: 0.2 - 0.12 * flat }, _sol);
  } else if (preset === 'slice') {
    const pp = presetParams('slice', power, st, _pp);
    const clr = pp.netClearance * (1 - 0.3 * Math.max(0, dp)) + 0.3 * Math.max(0, -dp);
    sol = solveShot({ from: req.from, target, spin: 'slice', power, stats: st, netClearance: clr }, _sol);
  } else {
    sol = solveShot({ from: req.from, target, spin: preset, power, stats: st }, _sol);
  }
  out.ok = sol.ok;
  out.preset = preset;
  out.clearance = sol.netClearance;
  out.power = power;
  out.flat = flat;
  out.radius = r;
  out.red = circleRed(p.side, tgt.x, tgt.z, r);
  const vel = out.vel || (out.vel = new Float64Array(3));
  const spin = out.spin || (out.spin = new Float64Array(3));
  vel.set(sol.vel); spin.set(sol.spin);
  // Netzfehler: tiefer Ball voll durchgezogen -> ins Netz (Treffhöhe knapp unter dem Band)
  out.netDump = false;
  const dn = Math.abs(req.from[2]);
  if (netRiskOf(p, preset, fam, power, h) && dn > 0.8 && Number.isFinite(sol.netClearance)) {
    const want = -0.18 - 0.1 * (1 - h / p.scale / RISK.lowBall);
    rotateVel(vel, (want - sol.netClearance) / dn, 0);
    out.netDump = true;
  }
  out.speed = Math.hypot(vel[0], vel[1], vel[2]);
  out.rpm = Math.hypot(spin[0], spin[1], spin[2]) / RPM;
  return out;
}

/** Geschwindigkeit um dth (Elevation) und dph (Azimut) drehen. */
export function rotateVel(v, dth, dph) {
  const hz = Math.hypot(v[0], v[2]);
  if (hz < 1e-6) return v;
  const sp = Math.hypot(hz, v[1]);
  let th = Math.atan2(v[1], hz) + dth;
  let ph = Math.atan2(v[0], v[2]) + dph;
  const ch = Math.cos(th);
  v[0] = sp * ch * Math.sin(ph); v[1] = sp * Math.sin(th); v[2] = sp * ch * Math.cos(ph);
  return v;
}


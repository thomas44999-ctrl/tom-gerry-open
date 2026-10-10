// Spieler: Zustand, Bewegung (Beschleunigung/Bremsen aus PLAYER_STATS), Abfangplanung
// (Treffpunkt-Kandidaten entlang der Ballvorhersage), Zielwahl aus der Eingabe und Schlagausführung
// (Fehlermodell + Schlag-Löser). Reine Logik, deterministisch (Rng), node-testbar.

import { COURT } from '../sim/court.js';
import { STROKES, SHOT_TO_STROKE, PLAYER_STATS, strokeContactWorld } from '../sim/strokes.js';
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
// human*: Werte für menschlich gesteuerte Spieler; ai*: für KI-Spieler (siehe ai.js).
export const DIFFICULTY = {
  easy: {
    name: 'easy',
    humanError: 0.72, humanAssist: 0.85, humanReach: 1.35,
    aiError: 1.1, aiReaction: 0.3, aiRead: 0.15, aiAnticipate: 0.5, aiSpeed: 0.84, aiAggression: 0.25, aiChargeLead: [0.25, 0.6],
    aiServeSigma: 0.07, aiNetRush: 0.04, aiSmart: 0.35, aiDrop: 0.03, aiLatePress: 0.08,
    aiServePower: [0.45, 0.75], aiMargin: 1.05, aiFhBias: 0.10, aiPosErr: 0.42,
  },
  normal: {
    name: 'normal',
    humanError: 0.85, humanAssist: 0.62, humanReach: 1.22,
    aiError: 1.0, aiReaction: 0.22, aiRead: 0.35, aiAnticipate: 0.8, aiSpeed: 0.93, aiAggression: 0.5, aiChargeLead: [0.45, 0.85],
    aiServeSigma: 0.045, aiNetRush: 0.14, aiSmart: 0.72, aiDrop: 0.06, aiLatePress: 0.02,
    aiServePower: [0.6, 0.9], aiMargin: 0.8, aiFhBias: 0.22, aiPosErr: 0.28,
  },
  hard: {
    name: 'hard',
    humanError: 0.92, humanAssist: 0.45, humanReach: 1.12,
    aiError: 0.86, aiReaction: 0.15, aiRead: 0.55, aiAnticipate: 0.9, aiSpeed: 1.0, aiAggression: 0.66, aiChargeLead: [0.6, 1.0],
    aiServeSigma: 0.028, aiNetRush: 0.24, aiSmart: 1.0, aiDrop: 0.08, aiLatePress: 0.0,
    aiServePower: [0.72, 1.0], aiMargin: 0.62, aiFhBias: 0.45, aiPosErr: 0.18,
  },
};
export const difficultyOf = (d) => DIFFICULTY[d] || DIFFICULTY.normal;

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
    // --- öffentlicher Zustand (PlayerState, ARCHITECTURE §7)
    this.pos = [0, 0, 0];
    this.vel = [0, 0, 0];
    this.yaw = 0;
    this.side = 1;
    this.mode = 'idle';            // 'idle'|'walk'|'ready'|'move'|'stroke'|'serve'|'recover'|'emote'
    this.stroke = null;            // { type, shot, hand, start, windup, contactTime, contact:[x,y,z], power, rushed }
    this.emote = null;             // Emote-Vorschlag (character.playEmote)
    this.charge = 0;               // 0..1 (Aufladung der gedrückten Schlagtaste)
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

// ---------------------------------------------------------------- Schlagausführung
/** Kontaktqualität aus Abweichung Ball <-> Schlägerpunkt. Liefert { quality, errN, fwd, lat, up, miss }. */
export function contactQuality(p, ballPos, key, rushed, charge, out = {}) {
  const S = STROKES[key];
  p.racketPoint(TMP, S.contact);
  const s = p.side;
  const ex = ballPos[0] - TMP[0], ey = ballPos[1] - TMP[1], ez = ballPos[2] - TMP[2];
  const reach = S.reach * p.scale;
  // Rahmen: right = s·X, forward = -s·Z
  out.lat = ex * s; out.fwd = -ez * s; out.up = ey;
  const err = Math.hypot(ex, ey * 0.8, ez);
  out.errN = err / reach;
  out.miss = out.errN > (p.human ? p.diff.humanReach : 1.12);
  let q;
  if (out.errN > 0.92) q = 'frame';
  else if (rushed) q = 'late';
  else if (out.errN > 0.5) q = 'stretch';
  else if (out.fwd > 0.36 * reach) q = 'early';
  else if (out.fwd < -0.36 * reach) q = 'late';
  else if (out.errN < 0.2 && charge >= 0.3) q = 'perfect';
  else q = 'good';
  out.quality = q;
  return out;
}

const Q_ERR = { perfect: 0.6, good: 1.0, early: 1.3, late: 1.6, stretch: 1.8, frame: 3.5 };
const Q_POW = { perfect: 0.08, good: 0, early: -0.06, late: -0.22, stretch: -0.18, frame: -0.42 };

const _sol = { requested: {}, landing: {}, vel: new Float64Array(3), spin: new Float64Array(3) };
const _pp = {}, _spinReq = { top: 0, side: 0, rifle: 0 };
/** Grundwahrscheinlichkeit eines Netzfehlers je Kontaktqualität. */
export const P_DUMP = { perfect: 0.004, good: 0.02, early: 0.04, late: 0.07, stretch: 0.09, frame: 0.35 };

/**
 * Schlag berechnen. req = { p, rng, shot, family, key, from:[x,y,z], aim:[lr, depth] | null, target:{x,z} | null,
 *   quality, charge, incomingSpeed, incomingRpm, runSpeed, errMul, serve:{serverSide, box} | null, powerOverride }
 * Liefert { ok, vel, spin, speed, rpm, target:{x,z}, aimTarget:{x,z}, power, preset }.
 */
export function resolveShot(req, out = {}) {
  const { p, rng } = req;
  const st = p.stats;
  const shot = req.shot;
  const fam = req.family;
  let preset;
  if (fam === 'smash') preset = 'smash';
  else if (fam === 'volley') preset = shot === 'drop' ? 'drop' : shot === 'lob' ? 'lob' : 'volley';
  else preset = shot === 'flat' ? 'flat' : shot;
  const aimShot = fam === 'smash' ? 'smash' : fam === 'volley' && preset === 'volley' ? 'volley' : preset;
  // --- Ziel
  const tgt = out.aimTarget || (out.aimTarget = {});
  if (req.target) { tgt.x = req.target.x; tgt.z = req.target.z; }
  else aimToTarget(p.side, req.from[0], req.aim ? req.aim[0] : 0, req.aim ? req.aim[1] : 0, aimShot, tgt);
  // --- Kraft
  const q = req.quality || 'good';
  const charge = clamp01(req.charge || 0);
  let power = req.powerOverride ?? (fam === 'volley' ? 0.4 + 0.5 * charge : 0.38 + 0.6 * charge);
  power = clamp(power + Q_POW[q], 0.05, 1);
  // tiefe/hohe Bälle können nicht voll geschlagen werden
  const h = req.from[1];
  if (fam === 'ground' && (preset === 'topspin' || preset === 'flat')) {
    if (h < 0.6) power *= 0.8 + 0.33 * h;
  }
  // --- Fehlermodell
  let sig = 0.55 * (Q_ERR[q] || 1);
  sig *= 1.28 - 0.55 * (st.control ?? 0.8);
  sig *= 1.15 - 0.35 * charge;
  sig *= 1 + Math.max(0, (req.incomingSpeed || 0) - 20) / 28 + Math.abs(req.incomingRpm || 0) / 7000;
  sig *= 1 + 0.07 * (req.runSpeed || 0);
  sig *= 1 + 0.7 * Math.max(0, power - 0.6);
  if (preset === 'drop' || preset === 'lob') sig *= 1.25 - 0.4 * (st.touch ?? 0.8);
  if (fam === 'volley') sig *= 1.2 - 0.35 * (st.volley ?? 0.8);
  if (fam === 'ground') {
    const hk = h / p.scale;
    sig *= 1 + 0.9 * Math.max(0, 0.55 - hk) + 0.5 * Math.max(0, hk - 1.35);
  }
  sig *= req.errMul ?? 1;
  const ex = rng.gaussC(2.6) * sig * 0.7, ez = rng.gaussC(2.6) * sig * (preset === 'drop' ? 0.6 : 1.3);
  let tgz = tgt.z + ez;
  if (tgz * -p.side < 0.6) tgz = -p.side * 0.6;            // Ziel bleibt auf der Gegenseite
  const target = out.target || (out.target = {});
  target.x = tgt.x + ex; target.z = tgz;
  // --- Lösen. Topspin: hoher Treffpunkt + Aufladung -> flacher, schneller Drive (Rasen), tiefer Ball -> mehr Spin.
  let sol, flat = 0;
  if (preset === 'topspin') {
    const pp = presetParams('topspin', power, st, _pp);
    flat = clamp((charge - 0.45) * 1.1 + (h / p.scale - 0.85) * 0.9, 0, 0.75) * (Q_POW[q] < -0.1 ? 0.3 : 1);
    _spinReq.top = pp.topRpm * (1 - 0.5 * flat); _spinReq.side = 0; _spinReq.rifle = 0;
    sol = solveShot({ from: req.from, target, spin: _spinReq, speed: pp.speed * (1 + 0.1 * flat), minClearance: 0.12 }, _sol);
  } else {
    sol = solveShot({ from: req.from, target, spin: preset, power, stats: st }, _sol);
  }
  out.ok = sol.ok;
  out.preset = preset;
  out.clearance = sol.netClearance;
  out.power = power;
  out.flat = flat;
  const vel = out.vel || (out.vel = new Float64Array(3));
  const spin = out.spin || (out.spin = new Float64Array(3));
  vel.set(sol.vel); spin.set(sol.spin);
  // Schlägerwinkel-Fehler: Richtung/Länge (klein) + "ins Netz gezogen" (nur nach unten, abhängig von Höhe/Druck)
  const angSig = sig * 0.004 * (preset === 'lob' ? 0.6 : 1);
  rotateVel(vel, rng.gaussC(2.6) * angSig, rng.gaussC(2.6) * angSig * 0.5);
  // Netzfehler: explizite Wahrscheinlichkeit (Qualität, tiefer Ball, flacher Drive, Tempo des ankommenden Balls)
  const dn = Math.abs(req.from[2]);
  out.netDump = false;
  if (dn > 0.8 && preset !== 'lob' && Number.isFinite(sol.netClearance)) {
    let pn = (P_DUMP[q] ?? 0.015) * (1 + 2.0 * Math.max(0, 0.8 - h / p.scale)) * (1 + 1.2 * flat);
    pn *= (preset === 'drop' ? 2 : 1) * (fam === 'volley' ? 1.4 : 1) * (1.3 - 0.45 * (st.control ?? 0.8));
    pn *= (1 + Math.max(0, (req.incomingSpeed || 0) - 20) / 25) * (req.errMul ?? 1);
    if (rng.next() < pn) {
      // Ball ins Netz (Treffhöhe zwischen knapp unter dem Band und Netzmitte)
      const want = -rng.range(0.05, 0.45);
      rotateVel(vel, (want - sol.netClearance) / dn, 0);
      out.netDump = true;
    }
  }
  out.speed = Math.hypot(vel[0], vel[1], vel[2]);
  out.rpm = Math.hypot(spin[0], spin[1], spin[2]) / RPM;
  out.sigma = sig;
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


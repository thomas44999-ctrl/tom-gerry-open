// Bewegungsbibliothek (ANIM): prozedurale Fortbewegung (Fußplaner + Gangzyklus) und alle Clips
// (Bereitschaft, Lauf-Oberkörper, Schläge, Aufschlag, Emotes). Konsument: character.js.
//
// Konventionen
//   * Euler-Specs in Grad nach pose.js (Spickzettel dort). Modellraum: +Z vorn (Netz), +X links, Y oben.
//   * Beine werden NIE per Clip animiert: Füße setzt der FootPlanner (weltfest, kein Rutschen), Beine per IK.
//     Clips steuern Wurzel (Hüft-Gier), Becken (pelvisOffset, Meter für Tom; character.js skaliert je Figur),
//     Rumpf, Arme, Kopf.
//   * Schlag-Keys: t relativ zum Treffpunkt (t = 0 = Ballkontakt), Zeiten passen exakt zu STROKES[x].windup/follow.
//   * Fußarbeit von Schlägen: Schritte im "Schlagrahmen" (Ursprung = Körperposition beim Treffer, Achsen = Blickrichtung),
//     Koordinaten [x links, z vorn] in Metern (Tom-Maßstab).

import { STROKES, SERVE } from '../sim/strokes.js';
import { clamp, lerp, smoothstep, smootherstep, wrapAngle } from '../core/math.js';
import { poseFromEuler } from './pose.js';

const TAU = Math.PI * 2;
const frac = (x) => x - Math.floor(x);

// ============================================================================ Fußplaner

/**
 * Zwei Füße, jeweils "gepflanzt" (weltfest: Bodenpunkt unter dem Knöchel + Gier) oder "schwingend"
 * (Interpolation von -> nach mit Bogenhöhe). Ziele schwingender Füße dürfen bis `lock` (Anteil) nachgeführt werden.
 *   foot: { sgn (+1 links, -1 rechts), x, z, yaw, swing, t, dur, fx, fz, fyaw, tx, tz, tyaw, h, lift, pitch, heel }
 *   heel > 0: Ferse angehoben (Drehpunkt Fußballen), heel < 0: Zehen hoch (Drehpunkt Ferse); Bogenmaß.
 */
export class FootPlanner {
  constructor() {
    this.feet = [newFoot(1), newFoot(-1)];
    this.landed = [];
  }
  plant(i, x, z, yaw) {
    const f = this.feet[i];
    f.x = f.tx = f.fx = x; f.z = f.tz = f.fz = z; f.yaw = f.tyaw = f.fyaw = yaw;
    f.swing = false; f.lift = 0; f.pitch = 0; f.t = 0;
  }
  /** Schritt starten (oder laufenden Schritt umlenken). opts: { lock, landPitch, startPitch, air } */
  step(i, tx, tz, tyaw, dur, h, opts = null) {
    const f = this.feet[i];
    if (f.swing) {
      f.tx = tx; f.tz = tz; f.tyaw = tyaw;
      if (opts && opts.force) {
        f.dur = Math.max(f.t + 0.05, dur); f.h = Math.max(f.h, h); f.gait = false;
        if (opts.air) f.air = true;
        if (opts.landPitch !== undefined) f.landPitch = opts.landPitch;
      }
      return;
    }
    f.swing = true; f.t = 0; f.dur = Math.max(0.06, dur); f.h = h;
    f.fx = f.x; f.fz = f.z; f.fyaw = f.yaw;
    f.tx = tx; f.tz = tz; f.tyaw = tyaw;
    f.lock = opts && opts.lock !== undefined ? opts.lock : 0.8;
    f.landPitch = opts && opts.landPitch !== undefined ? opts.landPitch : -0.1;
    f.startPitch = opts && opts.startPitch !== undefined ? opts.startPitch : Math.max(f.heel, 0);
    f.air = !!(opts && opts.air);
    f.gait = false;
  }
  retarget(i, tx, tz, tyaw) {
    const f = this.feet[i];
    if (f.swing && f.t < f.dur * f.lock) { f.tx = tx; f.tz = tz; f.tyaw = tyaw; }
  }
  update(dt) {
    this.landed.length = 0;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      if (!f.swing) continue;
      f.t += dt;
      const u = f.t / f.dur;
      if (u >= 1) {
        f.swing = false; f.x = f.tx; f.z = f.tz; f.yaw = f.tyaw; f.lift = 0;
        f.heel = f.landPitch; f.pitch = 0; f.fx = f.x; f.fz = f.z; f.fyaw = f.yaw;
        this.landed.push(i);
        continue;
      }
      const e = smootherstep(0, 1, u);
      f.x = f.fx + (f.tx - f.fx) * e;
      f.z = f.fz + (f.tz - f.fz) * e;
      f.yaw = f.fyaw + wrapAngle(f.tyaw - f.fyaw) * e;
      f.lift = f.h * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.8)), 0.9);
      f.heel = lerp(f.startPitch, f.landPitch, smoothstep(0.1, 0.95, u));
    }
  }
}
function newFoot(sgn) {
  return { sgn, x: 0, z: 0, yaw: 0, swing: false, t: 0, dur: 0, fx: 0, fz: 0, fyaw: 0, tx: 0, tz: 0, tyaw: 0, h: 0,
    lift: 0, pitch: 0, heel: 0, lock: 0.8, landPitch: 0, startPitch: 0, air: false, gait: false };
}

// ============================================================================ Gangzyklus

/**
 * Gangarten. L(s) = Schrittzyklus-Länge (2 Schritte) in m bei Geschwindigkeit s (m/s), beta = Standphasenanteil,
 * width = Spurbreite, toeOut = Fußöffnung (rad), height = Schwunghöhe, heel = max. Fersenhub am Ende der Standphase,
 * offR = Phasenversatz rechter Fuß, ahead = Landepunkt vor der Körperposition (Anteil der Standstrecke),
 * bob = Beckenhub (+: hoch in der Standmitte = Gehen, -: tief = Laufen). Alle Längen für Tom (Skalierung je Figur).
 */
export const GAITS = {
  walk: { L: (s) => 0.5 + 0.55 * s, beta: 0.58, width: 0.2, toeOut: 0.12, height: 0.07, heel: 0.5, offR: 0.5, ahead: 0.4, bob: 0.016, crouch: 0.015 },
  run: { L: (s) => 1.0 + 0.34 * s, beta: 0.31, width: 0.13, toeOut: 0.05, height: 0.15, heel: 0.8, offR: 0.5, ahead: 0.36, bob: -0.035, crouch: 0.06 },
  sprint: { L: (s) => 1.05 + 0.3 * s, beta: 0.25, width: 0.12, toeOut: 0.03, height: 0.19, heel: 0.9, offR: 0.5, ahead: 0.34, bob: -0.04, crouch: 0.08 },
  shuffle: { L: (s) => Math.min(0.9, 0.32 + 0.3 * s), beta: 0.52, width: 0.5, toeOut: 0.3, height: 0.06, heel: 0.3, offR: 0.36, ahead: 0.3, bob: -0.025, crouch: 0.1 },
  back: { L: (s) => 0.45 + 0.36 * s, beta: 0.46, width: 0.27, toeOut: 0.16, height: 0.07, heel: 0.35, offR: 0.5, ahead: 0.36, bob: -0.02, crouch: 0.08 },
};
const GAIT_KEYS = ['walk', 'run', 'sprint', 'shuffle', 'back'];

/**
 * Prozeduraler Gang: Phase wird über die zurückgelegte Strecke getrieben, Füße heben bei Phase = beta ab und
 * landen am vorhergesagten Körperort (+ Spur/Vorlauf). Liefert Gewichte für die Oberkörper-Zyklen, Beckenhub, Fersenziele.
 */
export class Gait {
  constructor(planner, scale = 1) {
    this.P = planner;
    this.scale = scale;
    this.phase = 0;
    this.moving = false;
    this.offR = 0.5;
    this.speed = 0;
    this.w = { idle: 1, walk: 0, run: 0, sprint: 0, shuffle: 0, back: 0 };
    this.p = { L: 1, beta: 0.6, width: 0.2, toeOut: 0.1, height: 0.07, heel: 0.4, ahead: 0.4, bob: 0, crouch: 0 };
    this.bob = 0;
    this.cycleW = 0;        // 0..1: wie stark der Zyklus (Arme/Becken) wirkt
    this.leadSide = 1;
    this._dir = [0, 1];
    this._tgt = new Float64Array(3);
    this._pend = [false, false];
    this._lifted = [false, false];
  }
  reset() { this.moving = false; this.phase = 0; this.speed = 0; this.cycleW = 0; this._pend[0] = this._pend[1] = false; }
  /**
   * @param dt
   * @param o { x, z (Welt), vx, vz (Welt, geglättet), hipYaw (Welt), lateral (Hüftrahmen-Richtungsgewichte {fwd, lat, back}),
   *            latSign (+1 Bewegung nach links im Hüftrahmen), enabled (false: keine neuen Schritte) }
   */
  update(dt, o) {
    const S = this.scale;
    const s = Math.hypot(o.vx, o.vz);
    this.speed = s;
    // Gangart-Gewichte
    const sn = s / S;   // auf Tom normierte Geschwindigkeit (kleinere Figur: gleiche Kadenz-Logik)
    const fwd = o.fwd, lat = o.lat, back = o.back;
    const wRun = smoothstep(1.9, 3.0, sn) * (1 - smoothstep(4.6, 5.6, sn));
    const wSprint = smoothstep(4.6, 5.6, sn);
    const wWalk = 1 - smoothstep(1.9, 3.0, sn);
    const W = this.w;
    const mv = smoothstep(0.05, 0.45, s);
    W.idle = 1 - mv;
    W.walk = mv * fwd * wWalk; W.run = mv * fwd * wRun; W.sprint = mv * fwd * wSprint;
    W.shuffle = mv * lat; W.back = mv * back;
    // Parameter mischen
    const p = this.p;
    let tw = 0; p.L = 0; p.beta = 0; p.width = 0; p.toeOut = 0; p.height = 0; p.heel = 0; p.ahead = 0; p.bob = 0; p.crouch = 0;
    let offR = 0;
    for (const k of GAIT_KEYS) {
      let w = k === 'walk' ? fwd * wWalk : k === 'run' ? fwd * wRun : k === 'sprint' ? fwd * wSprint : k === 'shuffle' ? lat : back;
      if (w <= 1e-4) continue;
      const g = GAITS[k];
      p.L += g.L(Math.max(sn, 0.2)) * w; p.beta += g.beta * w; p.width += g.width * w; p.toeOut += g.toeOut * w;
      p.height += g.height * w; p.heel += g.heel * w; p.ahead += g.ahead * w; p.bob += g.bob * w; p.crouch += g.crouch * w;
      offR += (k === 'shuffle' ? (o.latSign > 0 ? 1 - g.offR : g.offR) : g.offR) * w;
      tw += w;
    }
    if (tw > 0) { const k = 1 / tw; p.L *= k; p.beta *= k; p.width *= k; p.toeOut *= k; p.height *= k; p.heel *= k; p.ahead *= k; p.bob *= k; p.crouch *= k; offR *= k; }
    // langsame Bewegung: kürzere Schritte statt sehr langsamer Kadenz (min. ~0.9 Zyklen/s)
    p.L = Math.min(p.L * S, Math.max(0.12, s / 0.9));
    this.offR += (offR - this.offR) * Math.min(1, dt * 8);
    // Start/Stopp
    const wasMoving = this.moving;
    if (!this.moving && s > 0.25 && o.enabled) {
      this.moving = true;
      if (s > 1e-3) { this._dir[0] = o.vx / s; this._dir[1] = o.vz / s; }
      // zuerst hebt: Shuffle -> führender Fuß; sonst der hintere Fuß
      const F = this.P.feet;
      const d0 = F[0].x * this._dir[0] + F[0].z * this._dir[1], d1 = F[1].x * this._dir[0] + F[1].z * this._dir[1];
      let first = lat > 0.5 ? (d0 > d1 ? 0 : 1) : (d0 < d1 ? 0 : 1);
      if (F[first].swing) first = 1 - first;
      const off = first === 0 ? 0 : this.offR;
      this.phase = frac(p.beta - off + 0.001);
      this._pend[first] = true; this._pend[1 - first] = false;
      this._lifted[first] = true; this._lifted[1 - first] = frac(this.phase + (first === 0 ? this.offR : 0)) >= p.beta;
    } else if (this.moving && (s < 0.15 || !o.enabled)) { this.moving = false; this._pend[0] = this._pend[1] = false; }
    this.cycleW += ((this.moving ? 1 : 0) - this.cycleW) * Math.min(1, dt * (this.moving ? 10 : 5));
    if (!this.moving) { this.bob += (0 - this.bob) * Math.min(1, dt * 8); return wasMoving; }
    if (s > 1e-3) { this._dir[0] = o.vx / s; this._dir[1] = o.vz / s; }
    // Phase
    this.phase = frac(this.phase + s * dt / Math.max(0.1, p.L));
    const cyc = p.L / Math.max(0.3, s);
    for (let i = 0; i < 2; i++) {
      const off = i === 0 ? 0 : this.offR;
      const f = this.P.feet[i];
      const lp = frac(this.phase + off);
      // je Zyklus genau ein Abheben, sobald die lokale Phase die Standphase verlässt (robust gegen beta/offR-Wechsel)
      if (lp < p.beta) this._lifted[i] = false;
      else if (!this._lifted[i]) { this._pend[i] = true; this._lifted[i] = true; }
      // Restzeit bis zur Landung laut Phase (Landung bei lokaler Phase 1)
      const rem = (1 - frac(this.phase + off)) * cyc;
      if (this._pend[i] && !f.swing) {
        // Gehen: nicht beide Füße gleichzeitig in der Luft
        const other = this.P.feet[1 - i];
        if (p.beta > 0.5 && other.swing && other.t < other.dur * 0.75) continue;
        this._pend[i] = false;
        const dur = clamp(rem, 0.09, 0.5);
        this._target(i, dur, o, this._tgt);
        this.P.step(i, this._tgt[0], this._tgt[1], this._tgt[2], dur, p.height * S * clamp(0.6 + 0.25 * sn, 0.6, 1.3), {
          lock: 0.75, landPitch: lerp(-0.18, 0.08, smoothstep(1.5, 3.5, sn)), startPitch: Math.max(f.heel, 0),
        });
        f.gait = true;
      } else if (f.swing) {
        // laufenden Gang-Schritt an Phase/Tempo anpassen
        if (f.gait && f.t < f.dur * 0.8 && frac(this.phase + off) > p.beta) {
          const want = f.t + clamp(rem, 0.03, 0.5);
          f.dur += clamp(want - f.dur, -dt * 2, dt * 2);
        }
        const r = Math.max(0, f.dur - f.t);
        this._target(i, r, o, this._tgt);
        this.P.retarget(i, this._tgt[0], this._tgt[1], this._tgt[2]);
      }
    }
    // Beckenhub: Standmitte bei Phase beta/2 (+ offR)
    const q = Math.cos(TAU * 2 * (this.phase - p.beta * 0.5));
    this.bob = p.bob * S * q * smoothstep(0.1, 1.0, s);
    return wasMoving;
  }
  /** Landeziel für Fuß i bei Restflugzeit rem. */
  _target(i, rem, o, out) {
    const p = this.p, S = this.scale;
    const s = this.speed;
    const sgn = i === 0 ? 1 : -1;
    const bx = o.x + o.vx * rem, bz = o.z + o.vz * rem;
    const ahead = p.beta * p.L * p.ahead;
    const dx = this._dir[0], dz = this._dir[1];
    // Hüftrahmen: links = (cos h, -sin h)
    const lx = Math.cos(o.hipYaw), lz = -Math.sin(o.hipYaw);
    const hw = p.width * S * 0.5;
    out[0] = bx + dx * ahead * smoothstep(0.1, 0.8, s) + lx * sgn * hw;
    out[1] = bz + dz * ahead * smoothstep(0.1, 0.8, s) + lz * sgn * hw;
    out[2] = o.hipYaw + sgn * p.toeOut;
    return out;
  }
}

/** Fersenhub-Ziel eines gepflanzten Fußes im Gangzyklus (late stance roll-off). */
export function gaitHeel(gait, i) {
  if (!gait.moving) return 0;
  const p = gait.p;
  const off = i === 0 ? 0 : gait.offR;
  const ph = frac(gait.phase + off);
  if (ph >= p.beta) return 0;
  const u = ph / p.beta;
  return p.heel * smoothstep(0.45, 1.0, u) * gait.cycleW;
}

// ============================================================================ Lokomotions-Posen (Euler)

/** Bereitschaftsstellung (Tom-Maße). Linke Hand liegt am Schlägerhals (Laufzeit-IK). */
export const READY = {
  pelvisOffset: [0, -0.09, 0], pelvis: [4, 0, 0],
  spine: [12, 0, 0], chest: [6, 0, 0], neck: [-6, 0, 0], head: [-9, 0, 0],
  shoulder_r: [-6, 0, 10], arm_r: [24, 20, -40], forearm_r: [62, -22, 0], hand_r: [-30, 0, -18],
  shoulder_l: [14, 0, -2], arm_l: [58, 22, -21], forearm_l: [44, 2, 0], hand_l: [-2, 0, 0],
};

/** Entspannte Haltung (zwischen den Punkten, Schläger locker in der Hand). */
export const RELAXED = {
  pelvisOffset: [0, -0.01, 0],
  spine: [3, 0, 0], chest: [1, 0, 0], neck: [-1, 0, 0], head: [-2, 0, 0],
  arm_r: [12, 8, -32], forearm_r: [32, -10, 0], hand_r: [-8, 0, -10],
  arm_l: [4, 6, -36], forearm_l: [18, 6, 0], hand_l: [0, 0, 6],
};

// Lauf-Oberkörper als Schleifen-Clips über die Gangphase (Dauer 1). t = 0: linker Fuß landet (rechter Arm vorn).
const walkA = {
  pelvis: [0, -6, -2], spine: [3, 3, 0], chest: [1, 4, 0], neck: [0, -2, 0], head: [-2, -2, 0], pelvisOffset: [0, 0, 0],
  arm_r: [24, 8, -34], forearm_r: [36, -10, 0], hand_r: [-8, 0, -10],
  arm_l: [-16, 6, -37], forearm_l: [16, 6, 0], hand_l: [0, 0, 6],
};
const runA = {
  pelvis: [4, -10, -3], spine: [8, 6, 0], chest: [4, 8, 0], neck: [-6, -4, 0], head: [-6, -4, 0], pelvisOffset: [0, 0, 0],
  shoulder_r: [6, 0, 4], arm_r: [42, 10, -20], forearm_r: [80, -25, 0], hand_r: [-18, 0, -14],
  shoulder_l: [-6, 0, 4], arm_l: [-38, 10, -26], forearm_l: [92, 10, 0], hand_l: [0, 0, 0],
};
const runB = {
  pelvis: [4, 10, 3], spine: [8, -6, 0], chest: [4, -8, 0], neck: [-6, 4, 0], head: [-6, 4, 0], pelvisOffset: [0, 0, 0],
  shoulder_r: [-4, 0, 4], arm_r: [-10, 12, -24], forearm_r: [74, -25, 0], hand_r: [-18, 0, -14],
  shoulder_l: [6, 0, 4], arm_l: [58, 10, -14], forearm_l: [86, 10, 0], hand_l: [0, 0, 0],
};
const sprintA = {
  pelvis: [8, -12, -3], spine: [14, 7, 0], chest: [6, 9, 0], neck: [-12, -4, 0], head: [-10, -4, 0],
  shoulder_r: [8, 0, 4], arm_r: [58, 10, -16], forearm_r: [86, -25, 0], hand_r: [-18, 0, -14],
  shoulder_l: [-8, 0, 4], arm_l: [-52, 10, -22], forearm_l: [96, 10, 0], hand_l: [0, 0, 0],
};
const sprintB = {
  pelvis: [8, 12, 3], spine: [14, -7, 0], chest: [6, -9, 0], neck: [-12, 4, 0], head: [-10, 4, 0],
  shoulder_r: [-6, 0, 4], arm_r: [-24, 12, -22], forearm_r: [80, -25, 0], hand_r: [-18, 0, -14],
  shoulder_l: [8, 0, 4], arm_l: [70, 10, -10], forearm_l: [90, 10, 0], hand_l: [0, 0, 0],
};
const mirrorArmsSpec = (a) => {
  // walkB = walkA mit vertauschter Arm-Phase (nur Rotationen um y/z an Rumpfknochen gespiegelt)
  const o = {};
  for (const k in a) o[k] = a[k].slice();
  for (const k of ['pelvis', 'spine', 'chest', 'neck', 'head']) if (o[k]) { o[k][1] = -o[k][1]; o[k][2] = -o[k][2]; }
  return o;
};
const walkB = (() => {
  const o = mirrorArmsSpec(walkA);
  o.arm_r = [-6, 8, -34]; o.forearm_r = [28, -10, 0];
  o.arm_l = [20, 6, -36]; o.forearm_l = [26, 6, 0];
  return o;
})();
const shuffleA = { ...READY, pelvis: [6, 0, 0], spine: [14, 0, 0], chest: [6, 0, 0] };
const shuffleB = { ...READY, pelvis: [6, 0, 0], spine: [15, 0, 0], chest: [7, 0, 0], pelvisOffset: [0, -0.1, 0] };
const backA = { ...READY, spine: [8, 3, 0], chest: [4, 2, 0], neck: [-4, 0, 0], head: [-6, 0, 0], pelvis: [2, -4, 0] };
const backB = { ...READY, spine: [8, -3, 0], chest: [4, -2, 0], neck: [-4, 0, 0], head: [-6, 0, 0], pelvis: [2, 4, 0] };

const cyc = (name, A, B) => ({ name, duration: 1, loop: true, keys: [{ t: 0, pose: A }, { t: 0.5, pose: B }] });
export const LOCO_CLIPS = {
  idle: { name: 'idle', duration: 1, keys: [{ t: 0, pose: RELAXED }] },
  ready: { name: 'ready', duration: 1, keys: [{ t: 0, pose: READY }] },
  walk: cyc('walk', walkA, walkB),
  run: cyc('run', runA, runB),
  sprint: cyc('sprint', sprintA, sprintB),
  shuffle: cyc('shuffle', shuffleA, shuffleB),
  back: cyc('back', backA, backB),
};

// ============================================================================ Schläge
// Keys: t relativ zum Treffer. steps: Fußarbeit im Schlagrahmen ({ foot, t (Start), dur, at:[x links, z vorn], yaw (Grad),
// h, reach (Anteil des seitlichen Ausfallschritts), wide (bei tiefen Bällen breiter) }). heel: Fersenhub je Fuß [[t, rad]].
// throat/grip: Gewicht der linken Hand am Schlägerhals bzw. am Griff (beidhändig) über die Zeit.
// add: additive Varianten (Euler) für tiefe/hohe/weite/enge Bälle und Schlagarten (lob/drop).

// ---------------------------------------------------------------------------- Schlag-Keys
// Erzeugt mit einer Autorenhilfe (Körper-Euler + Schläger-/Handziele -> Arm-Euler, Gelenkgrenzen), danach von Hand
// nachbearbeitet. Gelenkwinkel in Grad (pose.js-Konvention), Zeiten relativ zum Treffer.
const K_FOREHAND = [
  { t: -0.42, pose: { pelvisOffset: [0, -0.09, 0], pelvis: [4, 0, 0], spine: [12, 0, 0], chest: [6, 0, 0], neck: [-6, 0, 0], head: [-9, 0, 0], shoulder_r: [-6, 0, 10], arm_r: [24, 20, -40], forearm_r: [62, -22, 0], hand_r: [-30, 0, -18], shoulder_l: [14, 0, -2], arm_l: [58, 22, -21], forearm_l: [44, 2, 0], hand_l: [-2, 0, 0] } },
  { t: -0.3, pose: { pelvisOffset: [0, -0.1, 0], root: [0, -42, 0], pelvis: [4, 0, 0], spine: [12, -12, 0], chest: [6, -22, 0], neck: [-6, 0, 0], head: [-8, 0, 0], shoulder_r: [-2, 0, 0], arm_r: [38, -8, -21], forearm_r: [94, -10, 0], hand_r: [-35, 0, -27], shoulder_l: [-9, 0, -6], arm_l: [30, -17, -36], forearm_l: [119, -6, 0], hand_l: [5, 0, 2] } },
  { t: -0.18, pose: { pelvisOffset: [0, -0.13, 0], root: [0, -48, 0], pelvis: [4, 0, 0], spine: [14, -14, 4], chest: [6, -24, 0], neck: [-6, 0, 0], head: [-8, 0, 0], shoulder_r: [2, 0, -8], arm_r: [48, -45, -45], forearm_r: [61, -80, 0], hand_r: [-35, 0, -7], shoulder_l: [-4, 0, 1], arm_l: [52, -39, -35], forearm_l: [104, -6, 0], hand_l: [0, 0, 5] } },
  { t: -0.07, pose: { pelvisOffset: [0, -0.11, 0], root: [0, -20, 0], pelvis: [4, 0, 0], spine: [12, -6, 2], chest: [4, -10, 0], neck: [-6, 0, 0], head: [-8, 0, 0], shoulder_r: [-1, 0, 0], arm_r: [19, -33, -52], forearm_r: [52, -80, 0], hand_r: [-21, 0, -7], shoulder_l: [-2, 0, -4], arm_l: [15, -26, -49], forearm_l: [123, -7, 0], hand_l: [2, 0, -2] } },
  { t: 0, pose: { pelvisOffset: [0, -0.09, 0], root: [0, -4, 0], pelvis: [4, 0, 0], spine: [10, 2, -3], chest: [2, 6, 0], neck: [-6, 0, 0], head: [-8, 0, 0], shoulder_r: [4, 0, 9], arm_r: [50, -28, -12], forearm_r: [0, -80, 0], hand_r: [-24, 0, 49], shoulder_l: [-3, 0, -3], arm_l: [-20, -23, -55], forearm_l: [124, -7, 0], hand_l: [1, 0, -3] } },
  { t: 0.1, pose: { pelvisOffset: [0, -0.07, 0], root: [0, 14, 0], pelvis: [2, 0, 0], spine: [8, 8, -2], chest: [2, 14, 0], neck: [-6, 0, 0], head: [-8, 0, 0], shoulder_r: [-10, 0, 9], arm_r: [36, -8, 14], forearm_r: [57, -80, 0], hand_r: [-32, 0, 8], shoulder_l: [0, 0, -1], arm_l: [-24, -21, -55], forearm_l: [113, -6, 0], hand_l: [0, 0, -1] } },
  { t: 0.25, pose: { pelvisOffset: [0, -0.05, 0], root: [0, 26, 0], pelvis: [2, 0, 0], spine: [6, 14, 0], chest: [2, 24, 0], neck: [-6, 0, 0], head: [-8, 0, 0], shoulder_r: [-8, 0, 2], arm_r: [16, -27, 92], forearm_r: [113, -53, 0], hand_r: [-35, 0, -20], shoulder_l: [4, 0, 2], arm_l: [29, 15, -55], forearm_l: [127, -5, 0], hand_l: [0, 0, -3] } },
  { t: 0.55, pose: { pelvisOffset: [0, -0.06, 0], root: [0, 22, 0], pelvis: [3, 0, 0], spine: [8, 12, 0], chest: [3, 20, 0], neck: [-6, 0, 0], head: [-8, 0, 0], shoulder_r: [-5, 0, -9], arm_r: [23, -29, 104], forearm_r: [115, -54, 0], hand_r: [-35, 0, -18], shoulder_l: [-1, 0, -1], arm_l: [16, 12, -52], forearm_l: [137, -6, 0], hand_l: [1, 0, -2] } },
];
const K_BACKHAND = [
  { t: -0.44, pose: { pelvisOffset: [0, -0.09, 0], pelvis: [4, 0, 0], spine: [12, 0, 0], chest: [6, 0, 0], neck: [-6, 0, 0], head: [-9, 0, 0], shoulder_r: [-6, 0, 10], arm_r: [24, 20, -40], forearm_r: [62, -22, 0], hand_r: [-30, 0, -18], shoulder_l: [14, 0, -2], arm_l: [58, 22, -21], forearm_l: [44, 2, 0], hand_l: [-2, 0, 0] } },
  { t: -0.32, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.1, 0], root: [0, 42, 0], spine: [12, 12, 0], chest: [6, 22, 0], shoulder_r: [-7, 0, 6], arm_r: [7, 54, -55], forearm_r: [101, 62, 0], hand_r: [-35, 0, -32], shoulder_l: [-12, 0, -10], arm_l: [2, -32, -48], forearm_l: [133, -10, 0], hand_l: [8, 0, 4] } },
  { t: -0.18, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.13, 0], root: [0, 48, 0], spine: [14, 14, -4], chest: [6, 26, 0], shoulder_r: [16, 0, -10], arm_r: [25, 53, -55], forearm_r: [52, 100, 0], hand_r: [-35, 0, -28], shoulder_l: [0, 0, -2], arm_l: [-5, -46, -35], forearm_l: [74, -7, 0], hand_l: [-2, 0, 6] } },
  { t: -0.07, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.11, 0], root: [0, 34, 0], spine: [12, 8, -2], chest: [5, 12, 0], shoulder_r: [-2, 0, -8], arm_r: [17, 49, -55], forearm_r: [45, 100, 0], hand_r: [-35, 0, -27], shoulder_l: [-4, 0, -1], arm_l: [-28, -44, -54], forearm_l: [104, -9, 0], hand_l: [2, 0, 0] } },
  { t: 0, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.09, 0], root: [0, 20, 0], spine: [10, 6, 2], chest: [3, 6, 0], shoulder_r: [10, 0, -10], arm_r: [41, -3, -55], forearm_r: [0, 51, 0], hand_r: [-35, 0, -9], shoulder_l: [-6, 0, 1], arm_l: [-57, -64, -45], forearm_l: [77, -8, 0], hand_l: [-1, 0, 3] } },
  { t: 0.12, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.07, 0], root: [0, 22, 0], spine: [8, 6, 0], chest: [2, 8, 0], shoulder_r: [17, 0, 5], arm_r: [104, -23, -55], forearm_r: [0, 39, 0], hand_r: [-35, 0, 0], shoulder_l: [1, 0, 2], arm_l: [-52, -69, -27], forearm_l: [62, -7, 0], hand_l: [-1, 0, 3] } },
  { t: 0.3, pose: { neck: [-8, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.06, 0], root: [0, 20, 0], spine: [6, 4, 0], chest: [0, 4, 0], shoulder_r: [-3, 0, -8], arm_r: [128, -22, -31], forearm_r: [55, 39, 0], hand_r: [-35, 0, -13], shoulder_l: [0, 0, 0], arm_l: [-50, -69, -24], forearm_l: [52, -6, 0], hand_l: [-1, 0, 2] } },
  { t: 0.55, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.07, 0], root: [0, 18, 0], spine: [7, 4, 0], chest: [1, 4, 0], shoulder_r: [-2, 0, -6], arm_r: [122, -39, -16], forearm_r: [76, 48, 0], hand_r: [-35, 0, -16], shoulder_l: [0, 0, -1], arm_l: [-50, -66, -30], forearm_l: [59, -6, 0], hand_l: [0, 0, 0] } },
];
const K_BACKHAND2 = [
  { t: -0.44, pose: { pelvisOffset: [0, -0.09, 0], pelvis: [4, 0, 0], spine: [12, 0, 0], chest: [6, 0, 0], neck: [-6, 0, 0], head: [-9, 0, 0], shoulder_r: [-6, 0, 10], arm_r: [24, 20, -40], forearm_r: [62, -22, 0], hand_r: [-30, 0, -18], shoulder_l: [14, 0, -2], arm_l: [58, 22, -21], forearm_l: [44, 2, 0], hand_l: [-2, 0, 0] } },
  { t: -0.32, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.1, 0], root: [0, 44, 0], spine: [12, 12, 0], chest: [6, 24, 0], shoulder_r: [-7, 0, 3], arm_r: [8, 52, -55], forearm_r: [106, 62, 0], hand_r: [-35, 0, -28], shoulder_l: [-9, 0, 5], arm_l: [16, 28, 7], forearm_l: [121, -6, 0], hand_l: [6, 0, -6] } },
  { t: -0.18, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.13, 0], root: [0, 50, 0], spine: [14, 14, -4], chest: [6, 28, 0], shoulder_r: [2, 0, -10], arm_r: [26, 62, -55], forearm_r: [63, 100, 0], hand_r: [-35, 0, -37], shoulder_l: [-1, 0, 0], arm_l: [7, 28, 13], forearm_l: [89, -3, 0], hand_l: [0, 0, -2] } },
  { t: -0.07, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.11, 0], root: [0, 32, 0], spine: [12, 8, -2], chest: [5, 12, 0], shoulder_r: [-7, 0, -2], arm_r: [17, 46, -55], forearm_r: [56, 100, 0], hand_r: [-35, 0, -33], shoulder_l: [3, 0, -5], arm_l: [11, 40, -6], forearm_l: [70, -1, 0], hand_l: [-1, 0, -1] } },
  { t: 0, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.09, 0], root: [0, 14, 0], spine: [10, 2, 2], chest: [3, 0, 0], shoulder_r: [23, 0, -10], arm_r: [50, -25, -53], forearm_r: [10, 100, 0], hand_r: [-35, 0, -39], shoulder_l: [8, 0, -3], arm_l: [37, 26, 0], forearm_l: [38, 1, 0], hand_l: [-3, 0, 4] } },
  { t: 0.12, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.07, 0], root: [0, 0, 0], spine: [8, -4, 0], chest: [2, -10, 0], shoulder_r: [30, 0, 16], arm_r: [99, -71, -25], forearm_r: [0, 42, 0], hand_r: [-35, 0, -36], shoulder_l: [4, 0, 5], arm_l: [49, -33, 33], forearm_l: [49, -1, 0], hand_l: [-1, 0, 10] } },
  { t: 0.3, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.05, 0], root: [0, -12, 0], spine: [6, -8, 0], chest: [2, -20, 0], shoulder_r: [10, 0, 1], arm_r: [60, 4, 1], forearm_r: [109, -6, 0], hand_r: [25, 0, -24], shoulder_l: [1, 0, 1], arm_l: [72, -22, 44], forearm_l: [116, -5, 0], hand_l: [4, 0, 2] } },
  { t: 0.55, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.06, 0], root: [0, -10, 0], spine: [7, -8, 0], chest: [3, -18, 0], shoulder_r: [7, 0, -3], arm_r: [54, 17, -4], forearm_r: [114, -9, 0], hand_r: [22, 0, -8], shoulder_l: [0, 0, 0], arm_l: [74, -19, 46], forearm_l: [118, -5, 0], hand_l: [1, 0, 1] } },
];
const K_FOREHAND_SLICE = [
  { t: -0.4, pose: { pelvisOffset: [0, -0.09, 0], pelvis: [4, 0, 0], spine: [12, 0, 0], chest: [6, 0, 0], neck: [-6, 0, 0], head: [-9, 0, 0], shoulder_r: [-6, 0, 10], arm_r: [24, 20, -40], forearm_r: [62, -22, 0], hand_r: [-30, 0, -18], shoulder_l: [14, 0, -2], arm_l: [58, 22, -21], forearm_l: [44, 2, 0], hand_l: [-2, 0, 0] } },
  { t: -0.28, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.1, 0], root: [0, -44, 0], spine: [12, -12, 0], chest: [6, -22, 0], shoulder_r: [-4, 0, -3], arm_r: [48, -11, -55], forearm_r: [101, -40, 0], hand_r: [-35, 0, -12], shoulder_l: [-11, 0, -7], arm_l: [26, -24, -39], forearm_l: [119, -6, 0], hand_l: [5, 0, 3] } },
  { t: -0.12, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.12, 0], root: [0, -30, 0], spine: [12, -8, 0], chest: [5, -14, 0], shoulder_r: [-3, 0, 3], arm_r: [20, -7, -54], forearm_r: [98, -48, 0], hand_r: [-21, 0, 9], shoulder_l: [-7, 0, -6], arm_l: [3, -41, -55], forearm_l: [137, -9, 0], hand_l: [3, 0, 3] } },
  { t: 0, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.12, 0], root: [0, -12, 0], spine: [12, -2, -2], chest: [4, 0, 0], shoulder_r: [30, 0, -10], arm_r: [42, -39, -10], forearm_r: [11, -66, 0], hand_r: [-8, 0, 31], shoulder_l: [-12, 0, -10], arm_l: [-48, -90, -55], forearm_l: [107, -13, 0], hand_l: [3, 0, 5] } },
  { t: 0.15, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.1, 0], root: [0, 0, 0], spine: [12, 2, 0], chest: [4, 4, 0], shoulder_r: [30, 0, -8], arm_r: [40, -18, 16], forearm_r: [0, -51, 0], hand_r: [-27, 0, 11], shoulder_l: [0, 0, -2], arm_l: [-43, -86, -46], forearm_l: [78, -11, 0], hand_l: [-1, 0, 4] } },
  { t: 0.45, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.08, 0], root: [0, 0, 0], spine: [10, 2, 0], chest: [4, 4, 0], shoulder_r: [11, 0, 0], arm_r: [57, -5, -6], forearm_r: [0, -48, 0], hand_r: [-27, 0, -5], shoulder_l: [1, 0, -1], arm_l: [-38, -79, -53], forearm_l: [86, -11, 0], hand_l: [0, 0, 1] } },
];
const K_BACKHAND_SLICE = [
  { t: -0.4, pose: { pelvisOffset: [0, -0.09, 0], pelvis: [4, 0, 0], spine: [12, 0, 0], chest: [6, 0, 0], neck: [-6, 0, 0], head: [-9, 0, 0], shoulder_r: [-6, 0, 10], arm_r: [24, 20, -40], forearm_r: [62, -22, 0], hand_r: [-30, 0, -18], shoulder_l: [14, 0, -2], arm_l: [58, 22, -21], forearm_l: [44, 2, 0], hand_l: [-2, 0, 0] } },
  { t: -0.28, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.1, 0], root: [0, 46, 0], spine: [12, 12, 0], chest: [6, 24, 0], shoulder_r: [-12, 0, 9], arm_r: [103, 47, -20], forearm_r: [91, -80, 0], hand_r: [-35, 0, -15], shoulder_l: [-2, 0, -7], arm_l: [94, -5, -48], forearm_l: [106, -4, 0], hand_l: [3, 0, 2] } },
  { t: -0.12, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.12, 0], root: [0, 40, 0], spine: [12, 10, 0], chest: [5, 18, 0], shoulder_r: [-12, 0, 10], arm_r: [112, 95, -27], forearm_r: [84, -80, 0], hand_r: [-35, 0, 14], shoulder_l: [-11, 0, -6], arm_l: [-15, -14, -55], forearm_l: [117, -6, 0], hand_l: [3, 0, -3] } },
  { t: 0, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.12, 0], root: [0, 26, 0], spine: [12, 6, 2], chest: [4, 6, 0], shoulder_r: [27, 0, -3], arm_r: [52, 95, 19], forearm_r: [6, -73, 0], hand_r: [-23, 0, -10], shoulder_l: [-7, 0, 3], arm_l: [-49, -45, -27], forearm_l: [79, -4, 0], hand_l: [-2, 0, 3] } },
  { t: 0.15, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.1, 0], root: [0, 24, 0], spine: [11, 6, 0], chest: [3, 6, 0], shoulder_r: [31, 0, -10], arm_r: [51, 23, 30], forearm_r: [0, -80, 0], hand_r: [-30, 0, 13], shoulder_l: [-1, 0, 1], arm_l: [-52, -50, -19], forearm_l: [64, -3, 0], hand_l: [-2, 0, 3] } },
  { t: 0.45, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.08, 0], root: [0, 20, 0], spine: [10, 5, 0], chest: [3, 5, 0], shoulder_r: [30, 0, -4], arm_r: [55, 16, 18], forearm_r: [0, -80, 0], hand_r: [-32, 0, 6], shoulder_l: [-1, 0, 0], arm_l: [-54, -48, -25], forearm_l: [67, -3, 0], hand_l: [0, 0, 1] } },
];
const K_FOREHAND_VOLLEY = [
  { t: -0.2, pose: { pelvisOffset: [0, -0.09, 0], pelvis: [4, 0, 0], spine: [12, 0, 0], chest: [6, 0, 0], neck: [-6, 0, 0], head: [-9, 0, 0], shoulder_r: [-6, 0, 10], arm_r: [24, 20, -40], forearm_r: [62, -22, 0], hand_r: [-30, 0, -18], shoulder_l: [14, 0, -2], arm_l: [58, 22, -21], forearm_l: [44, 2, 0], hand_l: [-2, 0, 0] } },
  { t: -0.1, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.11, 0], root: [0, -28, 0], spine: [12, -6, 0], chest: [5, -10, 0], shoulder_r: [-8, 0, 4], arm_r: [31, 7, -55], forearm_r: [107, -12, 0], hand_r: [-26, 0, 16], shoulder_l: [-12, 0, -6], arm_l: [18, -27, -37], forearm_l: [118, -6, 0], hand_l: [5, 0, 3] } },
  { t: 0, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.12, 0], root: [0, -16, 0], spine: [13, -4, 0], chest: [5, -6, 0], shoulder_r: [30, 0, -10], arm_r: [58, -24, -33], forearm_r: [7, -23, 0], hand_r: [-9, 0, 42], shoulder_l: [-5, 0, -2], arm_l: [7, -44, -42], forearm_l: [120, -7, 0], hand_l: [2, 0, 3] } },
  { t: 0.1, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.12, 0], root: [0, -12, 0], spine: [13, -2, 0], chest: [5, -4, 0], shoulder_r: [27, 0, -5], arm_r: [67, -44, 11], forearm_r: [6, -29, 0], hand_r: [-4, 0, 21], shoulder_l: [-1, 0, -1], arm_l: [1, -45, -47], forearm_l: [121, -7, 0], hand_l: [1, 0, 1] } },
  { t: 0.3, pose: { pelvisOffset: [0, -0.09, 0], pelvis: [4, 0, 0], spine: [12, 0, 0], chest: [6, 0, 0], neck: [-6, 0, 0], head: [-9, 0, 0], shoulder_r: [-6, 0, 10], arm_r: [24, 20, -40], forearm_r: [62, -22, 0], hand_r: [-30, 0, -18], shoulder_l: [14, 0, -2], arm_l: [58, 22, -21], forearm_l: [44, 2, 0], hand_l: [-2, 0, 0] } },
];
const K_BACKHAND_VOLLEY = [
  { t: -0.2, pose: { pelvisOffset: [0, -0.09, 0], pelvis: [4, 0, 0], spine: [12, 0, 0], chest: [6, 0, 0], neck: [-6, 0, 0], head: [-9, 0, 0], shoulder_r: [-6, 0, 10], arm_r: [24, 20, -40], forearm_r: [62, -22, 0], hand_r: [-30, 0, -18], shoulder_l: [14, 0, -2], arm_l: [58, 22, -21], forearm_l: [44, 2, 0], hand_l: [-2, 0, 0] } },
  { t: -0.1, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.11, 0], root: [0, 34, 0], spine: [12, 8, 0], chest: [5, 14, 0], shoulder_r: [-10, 0, 7], arm_r: [25, 50, -55], forearm_r: [120, 36, 0], hand_r: [-35, 0, -22], shoulder_l: [0, 0, -5], arm_l: [73, 9, -34], forearm_l: [135, -6, 0], hand_l: [5, 0, 1] } },
  { t: 0, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.12, 0], root: [0, 26, 0], spine: [13, 6, 0], chest: [5, 8, 0], shoulder_r: [27, 0, -1], arm_r: [28, -4, 22], forearm_r: [15, 0, 0], hand_r: [-5, 0, -18], shoulder_l: [10, 0, -14], arm_l: [175, -79, -58], forearm_l: [131, -7, 0], hand_l: [-4, 0, 19] } },
  { t: 0.1, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.12, 0], root: [0, 24, 0], spine: [13, 6, 0], chest: [5, 8, 0], shoulder_r: [8, 0, 2], arm_r: [64, -24, 30], forearm_r: [14, -17, 0], hand_r: [-15, 0, -9], shoulder_l: [1, 0, -16], arm_l: [175, -82, -59], forearm_l: [122, -7, 0], hand_l: [-5, 0, 18] } },
  { t: 0.3, pose: { pelvisOffset: [0, -0.09, 0], pelvis: [4, 0, 0], spine: [12, 0, 0], chest: [6, 0, 0], neck: [-6, 0, 0], head: [-9, 0, 0], shoulder_r: [-6, 0, 10], arm_r: [24, 20, -40], forearm_r: [62, -22, 0], hand_r: [-30, 0, -18], shoulder_l: [14, 0, -2], arm_l: [58, 22, -21], forearm_l: [44, 2, 0], hand_l: [-2, 0, 0] } },
];
const K_SMASH = [
  { t: -0.5, pose: { pelvisOffset: [0, -0.09, 0], pelvis: [4, 0, 0], spine: [12, 0, 0], chest: [6, 0, 0], neck: [-6, 0, 0], head: [-9, 0, 0], shoulder_r: [-6, 0, 10], arm_r: [24, 20, -40], forearm_r: [62, -22, 0], hand_r: [-30, 0, -18], shoulder_l: [14, 0, -2], arm_l: [58, 22, -21], forearm_l: [44, 2, 0], hand_l: [-2, 0, 0] } },
  { t: -0.36, pose: { neck: [-12, 0, 0], head: [-14, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.07, 0], root: [0, -68, 0], spine: [0, -8, 4], chest: [-4, -8, 0], shoulder_r: [-1, 0, 0], arm_r: [72, 3, -48], forearm_r: [84, -45, 0], hand_r: [-35, 0, -23], shoulder_l: [-4, 0, -1], arm_l: [175, -59, -56], forearm_l: [20, 1, 0], hand_l: [-5, 0, 19] } },
  { t: -0.14, pose: { neck: [-14, 0, 0], head: [-14, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.1, 0], root: [0, -58, 0], spine: [-4, -6, 6], chest: [-6, -6, 0], shoulder_r: [27, 0, -8], arm_r: [79, -30, -55], forearm_r: [109, -35, 0], hand_r: [4, 0, -37], shoulder_l: [1, 0, -5], arm_l: [165, -69, -55], forearm_l: [53, -1, 0], hand_l: [1, 0, 8] } },
  { t: -0.05, pose: { neck: [-14, 0, 0], head: [-14, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.05, 0], root: [0, -36, 0], spine: [-4, -2, 4], chest: [-4, 0, 0], shoulder_r: [4, 0, 8], arm_r: [119, -10, -42], forearm_r: [47, -16, 0], hand_r: [-11, 0, -12], shoulder_l: [19, 0, 1], arm_l: [141, -90, -48], forearm_l: [118, -9, 0], hand_l: [7, 0, 11] } },
  { t: 0, pose: { neck: [-12, 0, 0], head: [-12, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, 0, 0], root: [0, -16, 0], spine: [-2, 0, -6], chest: [0, 4, -2], shoulder_r: [-13, 0, 29], arm_r: [126, -90, -57], forearm_r: [35, 102, 0], hand_r: [-40, 0, -25], shoulder_l: [31, 0, -11], arm_l: [133, -91, -56], forearm_l: [145, -12, 0], hand_l: [6, 0, 75] } },
  { t: 0.15, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.06, 0], root: [0, 4, 0], spine: [18, 4, 0], chest: [6, 4, 0], shoulder_r: [-12, 0, 5], arm_r: [96, -10, 12], forearm_r: [53, 100, 0], hand_r: [-35, 0, -59], shoulder_l: [30, 0, -11], arm_l: [82, -91, -56], forearm_l: [132, -12, 0], hand_l: [3, 0, 75] } },
  { t: 0.5, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], pelvisOffset: [0, -0.08, 0], root: [0, 14, 0], spine: [16, 6, 0], chest: [5, 6, 0], shoulder_r: [-1, 0, 3], arm_r: [108, 35, 67], forearm_r: [52, 100, 0], hand_r: [-35, 0, -43], shoulder_l: [28, 0, -11], arm_l: [44, -91, -56], forearm_l: [109, -13, 0], hand_l: [3, 0, 75] } },
];
const K_SERVE_IDLE = [
  { t: 0, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], root: [0, -72, 0], pelvisOffset: [0, -0.03, 0], spine: [8, 0, 0], chest: [4, 0, 0], shoulder_r: [5, 0, 7], arm_r: [49, 66, -24], forearm_r: [61, -27, 0], hand_r: [-35, 0, -19], shoulder_l: [-9, 0, 7], arm_l: [6, 31, 7], forearm_l: [72, 0, 0], hand_l: [2, 0, -5] } },
];
const K_SERVE_BOUNCE = [
  { t: 0, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], root: [0, -72, 0], pelvisOffset: [0, -0.06, 0], spine: [16, 0, 2], chest: [6, 0, 0], shoulder_r: [1, 0, 10], arm_r: [55, 60, -11], forearm_r: [62, -28, 0], hand_r: [-33, 0, -19], shoulder_l: [-6, 0, 5], arm_l: [11, 39, -2], forearm_l: [60, 1, 0], hand_l: [1, 0, -5] } },
  { t: 0.25, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], root: [0, -72, 0], pelvisOffset: [0, -0.05, 0], spine: [13, 0, 2], chest: [5, 0, 0], shoulder_r: [1, 0, 4], arm_r: [64, 77, -3], forearm_r: [59, -45, 0], hand_r: [-27, 0, -14], shoulder_l: [-4, 0, 4], arm_l: [0, 37, 10], forearm_l: [82, -1, 0], hand_l: [2, 0, -3] } },
  { t: 0.48, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], root: [0, -72, 0], pelvisOffset: [0, -0.04, 0], spine: [12, 0, 2], chest: [5, 0, 0], shoulder_r: [2, 0, 2], arm_r: [70, 86, 1], forearm_r: [58, -56, 0], hand_r: [-23, 0, -12], shoulder_l: [-2, 0, 1], arm_l: [-5, 37, 14], forearm_l: [84, -1, 0], hand_l: [1, 0, -2] } },
];
const K_SERVE_TOSS = [
  { t: 0, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], root: [0, -72, 0], pelvisOffset: [0, -0.03, 0], spine: [8, 0, 0], chest: [4, 0, 0], shoulder_r: [5, 0, 7], arm_r: [49, 66, -24], forearm_r: [61, -27, 0], hand_r: [-35, 0, -19], shoulder_l: [-9, 0, 7], arm_l: [6, 31, 7], forearm_l: [72, 0, 0], hand_l: [2, 0, -5] } },
  { t: 0.14, pose: { neck: [-6, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], root: [0, -76, 0], pelvisOffset: [0, -0.05, 0], spine: [6, 0, 2], chest: [3, 0, 0], shoulder_r: [2, 0, 2], arm_r: [49, 87, -12], forearm_r: [28, -20, 0], hand_r: [-29, 0, -14], shoulder_l: [-3, 0, 1], arm_l: [-12, 43, 5], forearm_l: [69, 1, 0], hand_l: [0, 0, -4] } },
  { t: 0.32, pose: { neck: [-12, 0, 0], head: [-14, 0, 0], pelvis: [4, 0, 0], root: [0, -80, 0], pelvisOffset: [0, -0.08, 0], spine: [-4, 0, 4], chest: [-2, 0, 2], shoulder_r: [3, 0, 6], arm_r: [58, 95, 36], forearm_r: [41, 100, 0], hand_r: [-11, 0, -9], shoulder_l: [-3, 0, 8], arm_l: [-23, -10, 54], forearm_l: [96, -3, 0], hand_l: [2, 0, 3] } },
  { t: 0.52, pose: { neck: [-16, 0, 0], head: [-16, 0, 0], pelvis: [4, 0, 0], root: [0, -84, 0], pelvisOffset: [0, -0.13, 0], spine: [-8, 0, 6], chest: [-4, 0, 3], shoulder_r: [-12, 0, 3], arm_r: [84, 95, 83], forearm_r: [0, 94, 0], hand_r: [-1, 0, -75], shoulder_l: [12, 0, 28], arm_l: [-4, -13, 72], forearm_l: [9, 0, 0], hand_l: [-5, 0, 12] } },
  { t: 0.74, pose: { neck: [-16, 0, 0], head: [-16, 0, 0], pelvis: [4, 0, 0], root: [0, -86, 0], pelvisOffset: [0, -0.17, 0], spine: [-10, 0, 7], chest: [-5, 0, 4], shoulder_r: [6, 0, -2], arm_r: [59, 80, 143], forearm_r: [0, 68, 0], hand_r: [-5, 0, -75], shoulder_l: [15, 0, 35], arm_l: [-5, -13, 66], forearm_l: [0, 2, 0], hand_l: [-7, 0, 15] } },
  { t: 2.4, pose: { neck: [-16, 0, 0], head: [-16, 0, 0], pelvis: [4, 0, 0], root: [0, -86, 0], pelvisOffset: [0, -0.17, 0], spine: [-10, 0, 7], chest: [-5, 0, 4], shoulder_r: [2, 0, -5], arm_r: [59, 77, 153], forearm_r: [0, 54, 0], hand_r: [-14, 0, -68], shoulder_l: [15, 0, 35], arm_l: [-5, -13, 66], forearm_l: [0, 4, 0], hand_l: [-7, 0, 16] } },
];
const K_SERVE_SWING = [
  { t: -0.3, pose: { neck: [-16, 0, 0], head: [-16, 0, 0], pelvis: [4, 0, 0], root: [0, -86, 0], pelvisOffset: [0, -0.17, 0], spine: [-10, 0, 7], chest: [-5, 0, 4], shoulder_r: [2, 0, -5], arm_r: [59, 77, 153], forearm_r: [0, 54, 0], hand_r: [-14, 0, -68], shoulder_l: [15, 0, 35], arm_l: [-5, -13, 66], forearm_l: [0, 4, 0], hand_l: [-7, 0, 16] } },
  { t: -0.15, pose: { neck: [-16, 0, 0], head: [-16, 0, 0], pelvis: [4, 0, 0], root: [0, -72, 0], pelvisOffset: [0, -0.1, 0], spine: [-8, 0, 5], chest: [-4, 0, 3], shoulder_r: [17, 0, -1], arm_r: [68, 44, 175], forearm_r: [99, -27, 0], hand_r: [11, 0, -75], shoulder_l: [-11, 0, -1], arm_l: [-34, -15, 63], forearm_l: [126, -5, 0], hand_l: [7, 0, 3] } },
  { t: -0.05, pose: { neck: [-14, 0, 0], head: [-14, 0, 0], pelvis: [4, 0, 0], root: [0, -42, 0], pelvisOffset: [0, -0.02, 0], spine: [-3, 0, 2], chest: [-2, 0, 0], shoulder_r: [-2, 0, 8], arm_r: [37, 95, 165], forearm_r: [43, 26, 0], hand_r: [-13, 0, -30], shoulder_l: [-6, 0, -6], arm_l: [-47, 20, 40], forearm_l: [136, -3, 0], hand_l: [3, 0, -6] } },
  { t: 0, pose: { neck: [-12, 0, 0], head: [-12, 0, 0], pelvis: [4, 0, 0], root: [0, -24, 0], pelvisOffset: [0, 0.03, 0], spine: [0, 0, -8], chest: [0, 5, -4], shoulder_r: [-2, 0, 37], arm_r: [37, 96, 95], forearm_r: [10, 101, 0], hand_r: [-39, 0, -22], shoulder_l: [1, 0, -4], arm_l: [-39, 30, 28], forearm_l: [134, -2, 0], hand_l: [0, 0, -4] } },
  { t: 0.12, pose: { neck: [-6, 0, 0], head: [-6, 0, 0], pelvis: [4, 0, 0], root: [0, -4, 0], pelvisOffset: [0, -0.04, 0], spine: [18, 4, 0], chest: [6, 4, 0], shoulder_r: [-12, 0, 22], arm_r: [48, 95, 166], forearm_r: [26, 100, 0], hand_r: [-35, 0, -49], shoulder_l: [2, 0, -2], arm_l: [-31, 29, 24], forearm_l: [117, -1, 0], hand_l: [-1, 0, -1] } },
  { t: 0.35, pose: { neck: [-8, 0, 0], head: [-8, 0, 0], pelvis: [4, 0, 0], root: [0, 10, 0], pelvisOffset: [0, -0.1, 0], spine: [20, 8, 0], chest: [6, 6, 0], shoulder_r: [10, 0, -5], arm_r: [111, 45, 80], forearm_r: [31, 100, 0], hand_r: [-35, 0, -34], shoulder_l: [2, 0, -1], arm_l: [-28, 28, 24], forearm_l: [98, 1, 0], hand_l: [-2, 0, 0] } },
  { t: 0.65, pose: { pelvisOffset: [0, -0.09, 0], pelvis: [4, 0, 0], spine: [12, 0, 0], chest: [6, 0, 0], neck: [-6, 0, 0], head: [-9, 0, 0], shoulder_r: [-6, 0, 10], arm_r: [24, 20, -40], forearm_r: [62, -22, 0], hand_r: [-30, 0, -18], shoulder_l: [14, 0, -2], arm_l: [58, 22, -21], forearm_l: [44, 2, 0], hand_l: [-2, 0, 0] } },
];

const RELAX_ARM_R = { arm_r: [12, 8, -32], forearm_r: [32, -10, 0], hand_r: [-8, 0, -10] };

export const STROKE_ANIMS = {
  forehand: {
    keys: K_FOREHAND,
    steps: [
      { foot: 'r', t: -0.4, dur: 0.18, at: [-0.4, -0.1], yaw: -40, h: 0.06, reach: 0.9, wide: 1 },
      { foot: 'l', t: -0.24, dur: 0.17, at: [0.2, 0.22], yaw: -20, h: 0.05, wide: 1 },
      { foot: 'r', t: 0.3, dur: 0.2, at: [-0.24, 0.12], yaw: -8, h: 0.06 },
    ],
    heel: { r: [[-0.05, 0], [0.12, 0.6], [0.28, 0.6], [0.32, 0]] },
    throat: [[-0.42, 1], [-0.3, 0.9], [-0.22, 0], [0.18, 0], [0.26, 0.85], [0.55, 0.85]],
    add: {
      low: { spine: [8, 0, -6], chest: [4, 0, -4], arm_r: [-6, 0, -10], hand_r: [0, 0, 10] },
      high: { spine: [-4, 0, 4], arm_r: [10, 0, 22], forearm_r: [-10, 0, 0] },
      reach: { spine: [4, -4, -8], chest: [0, -4, -4], arm_r: [0, 0, 8], forearm_r: [-10, 0, 0] },
      jam: { spine: [-2, 6, 4], arm_r: [-8, 0, -10], forearm_r: [18, 0, 0] },
      shot: { lob: { forearm_r: [0, 18, 0], hand_r: [0, 0, -10], arm_r: [-6, 0, -16] }, flat: { arm_r: [0, 0, -8] } },
    },
  },
  backhand: {
    keys: K_BACKHAND,
    steps: [
      { foot: 'l', t: -0.42, dur: 0.16, at: [0.32, -0.12], yaw: 35, h: 0.05, wide: 1 },
      { foot: 'r', t: -0.3, dur: 0.18, at: [0.08, 0.3], yaw: 55, h: 0.06, reach: 0.9 },
      { foot: 'l', t: 0.3, dur: 0.2, at: [0.26, 0.05], yaw: 10, h: 0.05 },
    ],
    heel: { l: [[-0.05, 0], [0.1, 0.55], [0.28, 0.5], [0.32, 0]] },
    throat: [[-0.44, 1], [-0.16, 1], [-0.09, 0], [0.55, 0]],
    add: {
      low: { spine: [8, 0, 6], chest: [4, 0, 4], arm_r: [-6, 0, -10] },
      high: { spine: [-4, 0, -4], arm_r: [10, 0, 20] },
      reach: { spine: [4, 4, 8], chest: [0, 4, 4], arm_r: [0, 0, 8] },
      jam: { spine: [-2, -6, -4], forearm_r: [15, 0, 0] },
      shot: { lob: { forearm_r: [0, -15, 0], arm_r: [-6, 0, -12] } },
    },
  },
  backhand2: {
    keys: K_BACKHAND2,
    steps: [
      { foot: 'l', t: -0.42, dur: 0.16, at: [0.32, -0.12], yaw: 35, h: 0.05, wide: 1 },
      { foot: 'r', t: -0.3, dur: 0.18, at: [0.1, 0.28], yaw: 45, h: 0.06, reach: 0.9 },
      { foot: 'l', t: 0.3, dur: 0.2, at: [0.26, 0.05], yaw: 10, h: 0.05 },
    ],
    heel: { l: [[-0.05, 0], [0.1, 0.5], [0.28, 0.5], [0.32, 0]] },
    throat: [[-0.44, 1], [-0.38, 0]],
    grip: [[-0.44, 0], [-0.36, 1], [0.42, 1], [0.55, 0.6]],
    add: {
      low: { spine: [8, 0, 6], chest: [4, 0, 4], arm_r: [-6, 0, -10] },
      high: { spine: [-4, 0, -4], arm_r: [10, 0, 16] },
      reach: { spine: [4, 4, 8], chest: [0, 4, 4] },
      jam: { spine: [-2, -6, -4], forearm_r: [12, 0, 0] },
      shot: { lob: { forearm_r: [0, -12, 0], arm_r: [-6, 0, -10] } },
    },
  },
  forehand_slice: {
    keys: K_FOREHAND_SLICE,
    steps: [
      { foot: 'r', t: -0.4, dur: 0.15, at: [-0.3, -0.05], yaw: -50, h: 0.05, reach: 0.6 },
      { foot: 'l', t: -0.3, dur: 0.2, at: [0.02, 0.34], yaw: -35, h: 0.06, reach: 0.4 },
      { foot: 'r', t: 0.25, dur: 0.2, at: [-0.22, 0.12], yaw: -10, h: 0.05 },
    ],
    heel: { r: [[-0.1, 0], [0.05, 0.4], [0.22, 0.4], [0.26, 0]] },
    throat: [[-0.4, 1], [-0.28, 0.8], [-0.18, 0], [0.45, 0]],
    add: {
      low: { spine: [10, 0, -6], chest: [4, 0, -4] },
      high: { arm_r: [8, 0, 18] },
      reach: { spine: [4, -4, -8], arm_r: [0, 0, 6] },
      jam: { forearm_r: [14, 0, 0] },
      shot: { drop: { forearm_r: [0, 12, 0], hand_r: [0, 0, -12] } },
    },
  },
  backhand_slice: {
    keys: K_BACKHAND_SLICE,
    steps: [
      { foot: 'l', t: -0.4, dur: 0.15, at: [0.3, -0.06], yaw: 45, h: 0.05, reach: 0.6 },
      { foot: 'r', t: -0.3, dur: 0.2, at: [0.04, 0.34], yaw: 50, h: 0.06, reach: 0.4 },
      { foot: 'l', t: 0.25, dur: 0.2, at: [0.24, 0.1], yaw: 10, h: 0.05 },
    ],
    heel: { l: [[-0.1, 0], [0.05, 0.4], [0.22, 0.4], [0.26, 0]] },
    throat: [[-0.4, 1], [-0.12, 1], [-0.05, 0], [0.45, 0]],
    add: {
      low: { spine: [10, 0, 6], chest: [4, 0, 4] },
      high: { arm_r: [8, 0, 16] },
      reach: { spine: [4, 4, 8] },
      jam: { forearm_r: [14, 0, 0] },
      shot: { drop: { forearm_r: [0, -12, 0], hand_r: [0, 0, 10] } },
    },
  },
  forehand_volley: {
    keys: K_FOREHAND_VOLLEY,
    steps: [
      { foot: 'l', t: -0.18, dur: 0.16, at: [0.0, 0.36], yaw: -25, h: 0.05, reach: 0.5 },
      { foot: 'r', t: 0.12, dur: 0.18, at: [-0.24, 0.1], yaw: -5, h: 0.05 },
    ],
    throat: [[-0.2, 1], [-0.12, 0.6], [-0.06, 0], [0.18, 0], [0.3, 0.8]],
    ikIn: 0.1, ikOut: 0.12, fadeOut: 0.12,
    add: {
      low: { spine: [10, 0, -6], chest: [6, 0, -4], arm_r: [-10, 0, -8] },
      high: { spine: [-4, 0, 4], arm_r: [16, 0, 24] },
      reach: { spine: [4, -4, -8], arm_r: [0, 0, 8] },
      jam: { forearm_r: [16, 0, 0] },
    },
  },
  backhand_volley: {
    keys: K_BACKHAND_VOLLEY,
    steps: [
      { foot: 'r', t: -0.18, dur: 0.16, at: [0.08, 0.36], yaw: 35, h: 0.05, reach: 0.5 },
      { foot: 'l', t: 0.12, dur: 0.18, at: [0.25, 0.08], yaw: 8, h: 0.05 },
    ],
    throat: [[-0.2, 1], [-0.04, 1], [0.0, 0], [0.2, 0], [0.3, 0.8]],
    ikIn: 0.1, ikOut: 0.12, fadeOut: 0.12,
    add: {
      low: { spine: [10, 0, 6], chest: [6, 0, 4], arm_r: [-10, 0, -8] },
      high: { spine: [-4, 0, -4], arm_r: [16, 0, 22] },
      reach: { spine: [4, 4, 8], arm_r: [0, 0, 8] },
      jam: { forearm_r: [16, 0, 0] },
    },
  },
  smash: {
    keys: K_SMASH,
    steps: [
      { foot: 'r', t: -0.48, dur: 0.16, at: [-0.3, -0.3], yaw: -80, h: 0.05 },
      { foot: 'l', t: -0.4, dur: 0.16, at: [0.14, 0.1], yaw: -40, h: 0.05 },
      { foot: 'r', t: 0.18, dur: 0.2, at: [-0.16, 0.32], yaw: -20, h: 0.08 },
    ],
    throat: [[-0.5, 1], [-0.42, 0]],
    hop: 0.06,
    add: { reach: { spine: [0, 0, -8], chest: [0, 0, -4] } },
  },
};

// ============================================================================ Aufschlag
export const SERVE_ANIM = {
  bouncePeriod: 0.62,
  stance: [{ foot: 'l', at: [0.06, 0.12], yaw: -45 }, { foot: 'r', at: [-0.24, -0.26], yaw: -88 }],
  idle: { name: 'serve_idle', duration: 1, keys: K_SERVE_IDLE },
  bounce: { name: 'serve_bounce', duration: 0.62, loop: true, keys: K_SERVE_BOUNCE },
  toss: { name: 'serve_toss', duration: 2.4, keys: K_SERVE_TOSS },
  swingKeys: K_SERVE_SWING,
  swingSteps: [{ foot: 'r', t: 0.24, dur: 0.22, at: [-0.2, 0.44], yaw: -12, h: 0.08 }],
  hop: 0.08, hopLand: [0.08, 0.46, -0.16, 0.06],
  W: STROKES.serve.windup, F: STROKES.serve.follow,
};

// ============================================================================ Emotes
// Euler-Keys (absolute Zeit). steps/heel/throat wie bei Schlägen; hop: { t0, t1, h } (Meter, Tom).
const RLX = { pelvisOffset: [0, -0.01, 0], spine: [3, 0, 0], chest: [1, 0, 0], neck: [-1, 0, 0], head: [-2, 0, 0], ...RELAX_ARM_R, arm_l: [4, 6, -36], forearm_l: [18, 6, 0], hand_l: [0, 0, 6] };
const pumpDown = { ...RLX, pelvisOffset: [0, -0.13, 0], spine: [18, 8, 0], chest: [8, 4, 0], neck: [6, 0, 0], head: [8, 0, 0], arm_l: [8, -10, -22], forearm_l: [132, 25, 0], hand_l: [0, 0, -10], arm_r: [4, 8, -30], forearm_r: [40, -10, 0] };
const pumpUp = { ...RLX, pelvisOffset: [0, -0.06, 0], spine: [2, 10, 0], chest: [-2, 4, 0], neck: [-6, 0, 0], head: [-10, 0, 0], arm_l: [62, -10, 18], forearm_l: [128, 20, 0], hand_l: [0, 0, -10] };
const armsUp = { pelvisOffset: [0, 0, 0], spine: [-10, 0, 0], chest: [-6, 0, 0], neck: [-12, 0, 0], head: [-12, 0, 0], shoulder_l: [0, 0, 10], shoulder_r: [0, 0, 10], arm_l: [8, 0, 116], arm_r: [8, 0, 114], forearm_l: [10, 0, 0], forearm_r: [14, -10, 0], hand_l: [0, 0, 0], hand_r: [-10, 0, 0] };
const crouchBack = { pelvisOffset: [0, -0.16, 0], spine: [22, 0, 0], chest: [8, 0, 0], neck: [-12, 0, 0], head: [-10, 0, 0], arm_l: [-34, 0, -30], arm_r: [-34, 0, -30], forearm_l: [20, 0, 0], forearm_r: [24, -10, 0], hand_r: [-8, 0, -10] };
const slump = { pelvisOffset: [0, -0.04, 0], spine: [14, 0, 0], chest: [10, 0, 0], neck: [22, 0, 0], head: [22, 0, 0], shoulder_l: [6, 0, -10], shoulder_r: [6, 0, -10], arm_l: [-4, 4, -42], forearm_l: [10, 6, 0], hand_l: [0, 0, 0], arm_r: [-6, 6, -44], forearm_r: [6, -10, 0], hand_r: [-20, 0, -24] };
const handHairA = { ...slump, neck: [4, 0, 0], head: [-6, 0, 0], arm_l: [96, 30, 18], forearm_l: [136, 50, 0], hand_l: [0, 0, 20] };
const handHairB = { ...slump, neck: [-6, 0, 0], head: [-14, 0, 0], arm_l: [96, 20, 64], forearm_l: [130, 40, 0], hand_l: [0, 0, 30] };
const shrugP = { ...RLX, shoulder_l: [0, 0, 20], shoulder_r: [0, 0, 20], arm_l: [10, -40, 0], forearm_l: [80, -70, 0], hand_l: [0, 0, 20], arm_r: [10, -30, -6], forearm_r: [70, -40, 0], neck: [0, 0, 8], head: [-4, 0, 10] };
const waveA = { ...RLX, spine: [0, 8, 0], arm_l: [30, 20, 104], forearm_l: [70, 0, 0], hand_l: [0, 0, 20] };
const waveB = { ...RLX, spine: [0, 8, 0], arm_l: [30, -20, 110], forearm_l: [60, 0, 0], hand_l: [0, 0, -10] };
const clapP = { ...RLX, spine: [6, 0, 0], arm_r: [40, 30, -30], forearm_r: [80, -40, 0], hand_r: [-20, 0, -10], arm_l: [40, 20, -20], forearm_l: [90, 0, 0] };
const bowP = { ...RLX, pelvisOffset: [0, -0.02, -0.04], spine: [26, 0, 0], chest: [16, 0, 0], neck: [12, 0, 0], head: [10, 0, 0], arm_l: [36, 30, -18], forearm_l: [118, 20, 0], arm_r: [-8, 0, -26], forearm_r: [20, -10, 0] };
const catchUp = { ...RLX, spine: [4, 6, 0], arm_l: [104, 0, 8], forearm_l: [22, -60, 0], hand_l: [0, 0, 20], neck: [-10, 0, 0], head: [-10, 0, 0] };
const catchIn = { ...RLX, arm_l: [36, 10, -20], forearm_l: [112, 0, 0], hand_l: [0, 0, 0] };

export const EMOTE_MOOD = { fistpump: 'happy', celebrate: 'happy', jump: 'happy', dejected: 'sad', shrug: 'neutral', wave: 'happy', clap: 'happy', bow: 'happy', catch_ball: 'neutral' };
export const EMOTE_ANIMS = {
  fistpump: { duration: 1.6, lookOff: 0.6, keys: [{ t: 0, pose: RLX }, { t: 0.22, pose: pumpUp }, { t: 0.42, pose: pumpDown, ease: 'out' }, { t: 0.6, pose: { ...pumpDown, arm_l: [30, -10, 0], forearm_l: [130, 20, 0], pelvisOffset: [0, -0.1, 0] } }, { t: 0.76, pose: pumpDown, ease: 'out' }, { t: 1.2, pose: { ...pumpDown, pelvisOffset: [0, -0.08, 0], spine: [12, 6, 0] } }, { t: 1.6, pose: RLX }] },
  celebrate: { duration: 2.4, lookOff: 0.85, hop: { t0: 0.3, t1: 0.82, h: 0.3 }, keys: [{ t: 0, pose: RLX }, { t: 0.22, pose: crouchBack }, { t: 0.36, pose: { ...armsUp, arm_l: [100, 0, 30], arm_r: [100, 0, 30], pelvisOffset: [0, -0.04, 0] } }, { t: 0.58, pose: armsUp }, { t: 0.86, pose: { ...armsUp, pelvisOffset: [0, -0.14, 0], spine: [8, 0, 0], arm_l: [20, 0, 118], arm_r: [20, 0, 118], forearm_l: [40, 0, 0], forearm_r: [40, -10, 0] } }, { t: 1.2, pose: armsUp }, { t: 1.5, pose: { ...armsUp, arm_l: [14, 0, 126], arm_r: [14, 0, 124] } }, { t: 2.0, pose: RLX }, { t: 2.4, pose: RLX }] },
  jump: { duration: 1.4, lookOff: 0.6, hop: { t0: 0.26, t1: 0.7, h: 0.22 }, keys: [{ t: 0, pose: RLX }, { t: 0.2, pose: crouchBack }, { t: 0.34, pose: { ...RLX, arm_l: [80, 0, 10], arm_r: [80, 0, 10], forearm_r: [40, -10, 0] } }, { t: 0.48, pose: { ...armsUp, arm_l: [60, 0, 80], arm_r: [60, 0, 80] } }, { t: 0.74, pose: { ...crouchBack, pelvisOffset: [0, -0.12, 0], arm_l: [20, 0, -10], arm_r: [20, 0, -10] } }, { t: 1.4, pose: RLX }] },
  dejected: { duration: 2.6, lookOff: 1, keys: [{ t: 0, pose: RLX }, { t: 0.45, pose: slump }, { t: 2.0, pose: slump }, { t: 2.6, pose: RLX }] },
  dejected_hair: { duration: 2.8, lookOff: 1, keys: [{ t: 0, pose: RLX }, { t: 0.4, pose: slump }, { t: 0.75, pose: handHairA }, { t: 1.15, pose: handHairB }, { t: 1.55, pose: slump }, { t: 2.2, pose: slump }, { t: 2.8, pose: RLX }] },
  shrug: { duration: 1.6, lookOff: 0.5, keys: [{ t: 0, pose: RLX }, { t: 0.35, pose: shrugP, ease: 'out' }, { t: 0.95, pose: shrugP }, { t: 1.6, pose: RLX }] },
  wave: { duration: 2.2, lookOff: 0.3, keys: [{ t: 0, pose: RLX }, { t: 0.4, pose: waveA }, { t: 0.62, pose: waveB }, { t: 0.84, pose: waveA }, { t: 1.06, pose: waveB }, { t: 1.28, pose: waveA }, { t: 1.6, pose: waveA }, { t: 2.2, pose: RLX }] },
  clap: { duration: 1.9, lookOff: 0.4, strings: [[0, 0], [0.35, 1], [1.5, 1], [1.8, 0]], tap: 3.2, keys: [{ t: 0, pose: RLX }, { t: 0.35, pose: clapP }, { t: 1.5, pose: clapP }, { t: 1.9, pose: RLX }] },
  bow: { duration: 2.3, lookOff: 1, keys: [{ t: 0, pose: RLX }, { t: 0.6, pose: bowP }, { t: 1.4, pose: bowP }, { t: 2.3, pose: RLX }] },
  catch_ball: { duration: 1.1, lookOff: 0.2, keys: [{ t: 0, pose: RLX }, { t: 0.32, pose: catchUp, ease: 'out' }, { t: 0.45, pose: catchUp }, { t: 0.75, pose: catchIn }, { t: 1.1, pose: RLX }] },
};

// ============================================================================ Gerry: Schwanz/Ohren (Euler je Glied)
export const TAIL_MOODS = {
  neutral: [[6, 0, 0], [4, 0, 2], [6, 0, 3], [8, 0, 3], [8, 0, 2], [6, 0, 0]],
  happy: [[40, 0, 0], [22, 0, 0], [16, 0, 4], [14, 0, 8], [24, 0, 18], [34, 0, 26]],
  sad: [[-34, 0, 0], [-14, 0, 0], [-6, 0, 2], [-4, 0, 2], [-2, 0, 0], [0, 0, 0]],
};
export const EAR_MOODS = { neutral: [0, 0, 0], perk: [8, 0, -6], flat: [-38, 0, 34] };

// ============================================================================ Aufbau je Figur
const _sets = new Map();
function addPoses(def, add) {
  if (!add) return null;
  const o = {};
  for (const k in add) {
    if (k === 'shot') { o.shot = {}; for (const s in add.shot) o.shot[s] = poseFromEuler(def, add.shot[s]); }
    else o[k] = poseFromEuler(def, add[k]);
  }
  return o;
}
function strokeClip(name, keys, W, F) {
  return { name, duration: W + F, keys: keys.map((k) => ({ t: clamp(k.t + W, 0, W + F), pose: k.pose, ease: k.ease })) };
}
/** Alle Clips/Definitionen für eine Figur (id 'tom' | 'gerry' | sonst) und ihr Skelett, zwischengespeichert. */
export function buildAnimSet(id, def) {
  let per = _sets.get(def);
  if (!per) _sets.set(def, (per = new Map()));
  if (per.has(id)) return per.get(id);
  const gerry = id === 'gerry';
  const set = { strokes: {}, serve: {}, emotes: {} };
  for (const type of Object.keys(STROKES)) {
    if (type === 'serve') continue;
    // Persönlichkeit: Gerry spielt die Rückhand beidhändig
    const src = (gerry && type === 'backhand') ? STROKE_ANIMS.backhand2 : STROKE_ANIMS[type];
    const W = STROKES[type].windup, F = STROKES[type].follow;
    set.strokes[type] = { ...src, W, F, clip: strokeClip(type, src.keys, W, F), add: addPoses(def, src.add) };
  }
  const SV = SERVE_ANIM;
  set.serve = {
    idle: SV.idle, bounce: SV.bounce, toss: SV.toss, stance: SV.stance, bouncePeriod: SV.bouncePeriod, W: SV.W,
    swing: strokeClip('serve_swing', SV.swingKeys, SV.W, SV.F),
    swingDef: { W: SV.W, F: SV.F, steps: SV.swingSteps, hop: SV.hop, hopLand: SV.hopLand, throat: null, add: null },
  };
  for (const name of Object.keys(EMOTE_MOOD)) {
    // Persönlichkeit: Tom fährt sich nach verlorenem Punkt durchs Haar, Gerry hüpft beim Jubeln
    let e = EMOTE_ANIMS[name];
    if (name === 'dejected' && id === 'tom') e = EMOTE_ANIMS.dejected_hair;
    e = { ...e };
    if (gerry && name === 'fistpump') e.hop = { t0: 0.3, t1: 0.62, h: 0.12 };
    if (gerry && name === 'celebrate') e.hop = { t0: 0.3, t1: 0.86, h: 0.36 };
    if (gerry && name === 'clap') e.hop = { t0: 1.0, t1: 1.28, h: 0.08 };
    set.emotes[name] = { ...e, clip: { name, duration: e.duration, keys: e.keys } };
  }
  per.set(id, set);
  return set;
}

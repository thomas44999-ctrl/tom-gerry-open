// Ballphysik: Schwerkraft, quadratischer Luftwiderstand (spinabhängig), Magnus-Auftrieb,
// Spin-Abbau, Aufsprung nach Cross/Brody (Gleiten/Haften), Netz (Masche, Netzband, Netzroller),
// Pfosten/Einzelstützen, Rückwände, Rollen bis zum Stillstand.
// Feste 120 Hz, RK4, kontinuierliche Kollisionserkennung (kein Tunneln auch bei 60 m/s).
// Deterministisch, ohne DOM, im Hot-Path allokationsfrei (predict()).

import { COURT, netHeightAt } from './court.js';

export const BALL = {
  mass: 0.057,
  radius: 0.0335,
  rho: 1.21,
  g: 9.81,
  cd: 0.55,          // Basis-Widerstandsbeiwert (hohe Geschwindigkeit)
  cdLow: 0.05,       // Zuschlag bei langsamen Bällen (< 25 m/s, linear bis 5 m/s)
  cdSpin: 1.0,       // Gewicht des Spin-Zusatzwiderstands (Goodwill et al. 2004)
  inertia: 0.55,     // I = α m r² (Filzball, Hohlkugel mit Wandstärke)
  spinDecay: 0.0045, // dω/dt = -k |v| ω  (pro m/s, pro s)
  dt: 1 / 120,
};

const R = BALL.radius;
const G = BALL.g;
const K_AIR = 0.5 * BALL.rho * Math.PI * R * R / BALL.mass;   // ≈ 0.0374 1/m
const NET = COURT.net;
const PX = NET.postX;

/** Umrechnung U/min <-> rad/s. */
export const RPM = (2 * Math.PI) / 60;
export const toRpm = (w) => w / RPM;

// Netz-Modellparameter (Netzroller-Heuristik, siehe _netResponse)
const Q_STOP = -0.1;       // Treffhöhe (in Ballradien relativ zur Bandoberkante) unter der der Ball im Netz hängen bleibt
const E_MESH = 0.05;       // Rückprall aus der Masche (pro m/s, gedeckelt)
const E_TAPE = 0.4;        // Stoßzahl weicher Kontakte mit dem Netzband (Tröpfeln)
const ROLL_VY = 0.35;      // unterhalb dieser Absprung-Vertikalgeschwindigkeit rollt der Ball
const REST_SPEED = 0.04;   // m/s: darunter liegt der Ball

const POSTS = [
  { x: -NET.postX, r: NET.postRadius, h: NET.postHeight + 0.03, which: 'post' },
  { x: NET.postX, r: NET.postRadius, h: NET.postHeight + 0.03, which: 'post' },
  { x: -NET.stickX, r: NET.stickRadius, h: NET.stickHeight, which: 'stick' },
  { x: NET.stickX, r: NET.stickRadius, h: NET.stickHeight, which: 'stick' },
];

// Ereigniscodes (intern)
export const EV = { NONE: 0, BOUNCE: 1, NET: 2, POST: 3, WALL: 4, REST: 5 };
const EV_NAMES = ['none', 'bounce', 'net', 'post', 'wall', 'rest'];

// ---------------------------------------------------------------- Aerodynamik
const _k1 = new Float64Array(3), _k2 = new Float64Array(3), _k3 = new Float64Array(3), _k4 = new Float64Array(3);

// Aerodynamische Beiwerte werden pro Integrationsschritt einmal aus dem Startzustand bestimmt
// (sie ändern sich auf einer Zeitskala von ~1 s); die RK4-Stufen nutzen sie mit aktueller Geschwindigkeit.
let _cd = BALL.cd, _cl = 0;

/** Bestimmt Cd und C_L für Geschwindigkeit v und Spin w (setzt _cd/_cl). */
function aeroCoeffs(vx, vy, vz, wx, wy, wz) {
  const v2 = vx * vx + vy * vy + vz * vz;
  const v = Math.sqrt(v2);
  let cd = BALL.cd;
  if (v < 25) cd += BALL.cdLow * (v > 5 ? (25 - v) / 20 : 1);
  _cl = 0;
  if (v > 1e-6) {
    const cx = wy * vz - wz * vy, cy = wz * vx - wx * vz, cz = wx * vy - wy * vx;
    const c = Math.sqrt(cx * cx + cy * cy + cz * cz);    // = ω⊥ · v
    if (c > 1e-5) {
      const ratio = v2 / (R * c);                        // v / (r ω⊥) = 1/S
      _cl = 1 / (2 + ratio);                             // C_L = 1/(2 + v/(rω))  (Goodwill et al.)
      cd += BALL.cdSpin / Math.pow(22.5 + 4.2 * ratio * ratio * Math.sqrt(ratio), 0.4);
    }
  }
  _cd = cd;
}

/** Beschleunigung aus Schwerkraft + Luftwiderstand + Magnus mit den aktuellen Beiwerten (_cd, _cl). */
function accel(vx, vy, vz, wx, wy, wz, a) {
  const v2 = vx * vx + vy * vy + vz * vz;
  let ax = 0, ay = -G, az = 0;
  if (v2 > 1e-12) {
    const v = Math.sqrt(v2);
    const kd = K_AIR * _cd * v;
    ax -= kd * vx; ay -= kd * vy; az -= kd * vz;
    if (_cl > 0) {
      const cx = wy * vz - wz * vy, cy = wz * vx - wx * vz, cz = wx * vy - wy * vx;
      const c2 = cx * cx + cy * cy + cz * cz;
      if (c2 > 1e-10) {
        const km = K_AIR * _cl * v2 / Math.sqrt(c2);     // a_M = K C_L v² (ω×v)/|ω×v|
        ax += km * cx; ay += km * cy; az += km * cz;
      }
    }
  }
  a[0] = ax; a[1] = ay; a[2] = az;
}

/** Ein RK4-Schritt (Spin während des Schritts konstant). p/v dürfen identisch mit po/vo sein. */
function rk4(p, v, w, h, po, vo) {
  const vx = v[0], vy = v[1], vz = v[2], wx = w[0], wy = w[1], wz = w[2];
  const h2 = h * 0.5;
  aeroCoeffs(vx, vy, vz, wx, wy, wz);
  accel(vx, vy, vz, wx, wy, wz, _k1);
  const v2x = vx + _k1[0] * h2, v2y = vy + _k1[1] * h2, v2z = vz + _k1[2] * h2;
  accel(v2x, v2y, v2z, wx, wy, wz, _k2);
  const v3x = vx + _k2[0] * h2, v3y = vy + _k2[1] * h2, v3z = vz + _k2[2] * h2;
  accel(v3x, v3y, v3z, wx, wy, wz, _k3);
  const v4x = vx + _k3[0] * h, v4y = vy + _k3[1] * h, v4z = vz + _k3[2] * h;
  accel(v4x, v4y, v4z, wx, wy, wz, _k4);
  const h6 = h / 6;
  po[0] = p[0] + h6 * (vx + 2 * v2x + 2 * v3x + v4x);
  po[1] = p[1] + h6 * (vy + 2 * v2y + 2 * v3y + v4y);
  po[2] = p[2] + h6 * (vz + 2 * v2z + 2 * v3z + v4z);
  vo[0] = vx + h6 * (_k1[0] + 2 * _k2[0] + 2 * _k3[0] + _k4[0]);
  vo[1] = vy + h6 * (_k1[1] + 2 * _k2[1] + 2 * _k3[1] + _k4[1]);
  vo[2] = vz + h6 * (_k1[2] + 2 * _k2[2] + 2 * _k3[2] + _k4[2]);
}

/** Spin-Abbau in der Luft über h Sekunden bei Geschwindigkeit |v|. */
function decaySpin(w, speed, h) {
  const k = 1 - BALL.spinDecay * speed * h;
  w[0] *= k; w[1] *= k; w[2] *= k;
}

/** Kubische Hermite-Nullstelle: Zeitanteil τ∈[0,1], an dem f(τ) = target (f0,f1 Werte, d0,d1 Ableitungen*h). */
function hermiteRoot(f0, d0, f1, d1, target) {
  let t = (f0 - target) / (f0 - f1);
  if (!(t >= 0 && t <= 1)) t = 0.5;
  for (let i = 0; i < 6; i++) {
    const t2 = t * t, t3 = t2 * t;
    const f = (2 * t3 - 3 * t2 + 1) * f0 + (t3 - 2 * t2 + t) * d0 + (-2 * t3 + 3 * t2) * f1 + (t3 - t2) * d1 - target;
    const df = (6 * t2 - 6 * t) * f0 + (3 * t2 - 4 * t + 1) * d0 + (-6 * t2 + 6 * t) * f1 + (3 * t2 - 2 * t) * d1;
    if (Math.abs(df) < 1e-12) break;
    const nt = t - f / df;
    t = nt < 0 ? 0 : nt > 1 ? 1 : nt;
    if (Math.abs(f) < 1e-7) break;
  }
  return t;
}
function hermite(f0, d0, f1, d1, t) {
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * f0 + (t3 - 2 * t2 + t) * d0 + (-2 * t3 + 3 * t2) * f1 + (t3 - t2) * d1;
}

/** Drallvektor (rad/s) aus lokalen Komponenten relativ zur horizontalen Flugrichtung d.
 *  top > 0 = Topspin (< 0 Slice/Unterschnitt), side > 0 = Kurve nach rechts (aus Sicht des Schlagenden),
 *  rifle = Drall um die Flugrichtung (beeinflusst nur den Absprung seitlich). */
export function spinFromLocal(out, dirX, dirZ, top, side = 0, rifle = 0) {
  const l = Math.hypot(dirX, dirZ) || 1, dx = dirX / l, dz = dirZ / l;
  // Topspin-Achse = ŷ × d = (dz, 0, -dx); Seitwärts: ω = -side·ŷ; Rifle: ω = rifle·d
  out[0] = top * dz + rifle * dx;
  out[1] = -side;
  out[2] = -top * dx + rifle * dz;
  return out;
}

/** Zerlegt einen Drallvektor in lokale Komponenten bzgl. der Flugrichtung (für Anzeige/Analyse). */
export function spinToLocal(w, dirX, dirZ, out = {}) {
  const l = Math.hypot(dirX, dirZ) || 1, dx = dirX / l, dz = dirZ / l;
  out.top = w[0] * dz - w[2] * dx;
  out.side = -w[1];
  out.rifle = w[0] * dx + w[2] * dz;
  return out;
}

// ---------------------------------------------------------------- Ball
const _p1 = new Float64Array(3), _v1 = new Float64Array(3);

export class Ball {
  constructor() {
    this.pos = new Float64Array([0, 1, 0]);
    this.vel = new Float64Array(3);
    this.spin = new Float64Array(3);        // Winkelgeschwindigkeit (rad/s)
    this.radius = R;
    this.mode = 'air';                      // 'air' | 'roll' | 'rest' | 'held'
    this.inPlay = false;                    // true nach launch(), false bei hold()/Stillstand (Spiellogik darf es setzen)
    this.surface = COURT.surface;
    this.collideNet = true;
    this.collidePosts = true;
    // Rückwände/Bande: halbe Ausdehnung der Spielfläche (Centre-Court-Auslauf). null = keine.
    this.walls = { halfX: COURT.doublesHalfWidth + COURT.runoffSide, halfZ: COURT.halfLength + COURT.runoffBack, height: 3.2, e: 0.32 };
    // Zähler seit dem letzten launch()
    this.bounces = 0;
    this.netTouches = 0;
    this.time = 0;
    this.lastBounce = new Float64Array(3);
    this.events = [];
    // intern
    this._ghost = false;                    // Netzband-Durchgang nach Netzroller
    this._cordDir = 0;                      // Abrollrichtung (±1 in z) für Tröpfeln auf dem Band
    this._ev = 0; this._evFlag = 0; this._evQ = 0; this._evGrip = false;
    this._evPos = new Float64Array(3);
    this._evVin = new Float64Array(3);
    this._nY = 0; this._nZ = 0; this._netKind = 0; this._postIdx = -1; this._wallAxis = 0;
  }

  /** Zustand setzen ohne Zähler zurückzusetzen. */
  set(pos, vel, spin) {
    if (pos) { this.pos[0] = pos[0]; this.pos[1] = pos[1]; this.pos[2] = pos[2]; }
    if (vel) { this.vel[0] = vel[0]; this.vel[1] = vel[1]; this.vel[2] = vel[2]; }
    if (spin) { this.spin[0] = spin[0]; this.spin[1] = spin[1]; this.spin[2] = spin[2]; }
    return this;
  }

  /** Schlag: neuer Flug ab pos mit vel/spin; Zähler (Aufsprünge, Netzkontakte, Zeit) werden zurückgesetzt. */
  launch(pos, vel, spin) {
    this.set(pos, vel, spin || ZERO3);
    this.mode = 'air';
    this.inPlay = true;
    this.bounces = 0; this.netTouches = 0; this.time = 0;
    this._ghost = false; this._cordDir = 0;
    return this;
  }

  /** Ball in der Hand / am Schläger: Physik ruht, Position folgt dem Aufrufer. */
  hold(pos) {
    if (pos) this.set(pos);
    this.vel.fill(0); this.spin.fill(0);
    this.mode = 'held';
    this.inPlay = false;
    return this;
  }

  copyFrom(b) {
    this.pos.set(b.pos); this.vel.set(b.vel); this.spin.set(b.spin);
    this.mode = b.mode; this.surface = b.surface; this.inPlay = b.inPlay;
    this.collideNet = b.collideNet; this.collidePosts = b.collidePosts; this.walls = b.walls;
    this.bounces = b.bounces; this.netTouches = b.netTouches; this.time = b.time;
    this.lastBounce.set(b.lastBounce);
    this._ghost = b._ghost; this._cordDir = b._cordDir;
    return this;
  }

  get speed() { return Math.hypot(this.vel[0], this.vel[1], this.vel[2]); }
  get rpm() { return Math.hypot(this.spin[0], this.spin[1], this.spin[2]) / RPM; }
  get inAir() { return this.mode === 'air'; }

  /**
   * Simuliert dt Sekunden (typisch 1/120). Gibt die Ereignisse dieses Schritts zurück
   * (Array wird wiederverwendet): {type:'bounce', pos, vel, velIn, speedIn, speedOut, vyIn, grip, index},
   * {type:'net', pos, cord, first, soft, speedIn, q}, {type:'post', pos, which, speedIn},
   * {type:'wall', pos, axis, speedIn}, {type:'rest', pos}.
   */
  step(dt = BALL.dt) {
    const ev = this.events; ev.length = 0;
    if (this.mode === 'held' || this.mode === 'rest') return ev;
    // Größere Schritte (z. B. 1/60) werden in <= 1/120-s-Teilschritte zerlegt (gleiche Genauigkeit wie predict()).
    const n = dt > BALL.dt * 1.0001 ? Math.ceil(dt / BALL.dt - 1e-6) : 1;
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      let rem = h;
      for (let i = 0; i < 12 && rem > 1e-10; i++) {
        rem -= this._advance(rem);
        if (this._ev) ev.push(this._makeEvent());
      }
      if (this.mode === 'rest') { this.inPlay = false; break; }
    }
    this.time += dt;
    return ev;
  }

  _makeEvent() {
    const pos = [this._evPos[0], this._evPos[1], this._evPos[2]];
    const vi = this._evVin;
    const speedIn = Math.hypot(vi[0], vi[1], vi[2]);
    switch (this._ev) {
      case EV.BOUNCE: return {
        type: 'bounce', pos, vel: [this.vel[0], this.vel[1], this.vel[2]], velIn: [vi[0], vi[1], vi[2]],
        speedIn, speedOut: this.speed, vyIn: vi[1], grip: this._evGrip, index: this.bounces, rolling: this.mode === 'roll',
      };
      case EV.NET: return { type: 'net', pos, cord: this._evFlag !== 0, soft: this._evFlag === 2, first: this.netTouches === 1, speedIn, q: this._evQ };
      case EV.POST: return { type: 'post', pos, which: POSTS[this._postIdx].which, speedIn };
      case EV.WALL: return { type: 'wall', pos, axis: this._wallAxis === 0 ? 'x' : 'z', speedIn };
      case EV.REST: return { type: 'rest', pos };
      default: return { type: EV_NAMES[this._ev] || 'unknown', pos };
    }
  }

  /** Integriert bis zum ersten Kontakt (oder h). Wendet Kontaktantwort an. Gibt verbrauchte Zeit zurück. */
  _advance(h) {
    this._ev = EV.NONE;
    if (this.mode === 'roll') return this._advanceRoll(h);
    if (this.mode !== 'air') return h;
    const p = this.pos, v = this.vel, w = this.spin;
    rk4(p, v, w, h, _p1, _v1);

    let tau = 2, kind = 0;
    // Boden
    if (_p1[1] < R) {
      if (p[1] <= R) { if (v[1] < 0) { tau = 0; kind = EV.BOUNCE; } }
      else { tau = hermiteRoot(p[1], v[1] * h, _p1[1], _v1[1] * h, R); kind = EV.BOUNCE; }
    }
    // Netz
    if (this.collideNet) {
      if (this._ghost) {
        // Netzroller: Ball rollt über das Band – keine Netzkollision bis er die Bandzone verlassen hat
        if (Math.abs(_p1[2]) >= R || _p1[1] < 0.2) this._ghost = false;
      } else {
        const tn = this._netTau(p, _p1);
        if (tn < tau) { tau = tn; kind = EV.NET; }
      }
    }
    // Pfosten / Einzelstützen
    if (this.collidePosts && (Math.abs(p[2]) < 0.2 || Math.abs(_p1[2]) < 0.2 || p[2] * _p1[2] < 0)) {
      const tp = this._postTau(p, _p1);
      if (tp < tau) { tau = tp; kind = EV.POST; }
    }
    // Wände
    if (this.walls) {
      const tw = this._wallTau(p, _p1);
      if (tw < tau) { tau = tw; kind = EV.WALL; }
    }

    if (!kind) {
      const sp = Math.hypot(v[0], v[1], v[2]);
      p[0] = _p1[0]; p[1] = _p1[1]; p[2] = _p1[2];
      v[0] = _v1[0]; v[1] = _v1[1]; v[2] = _v1[2];
      decaySpin(w, sp, h);
      return h;
    }
    // exakter Zustand zum Kontaktzeitpunkt
    const hc = tau * h;
    if (hc > 0) {
      const sp = Math.hypot(v[0], v[1], v[2]);
      rk4(p, v, w, hc, p, v);
      decaySpin(w, sp, hc);
    }
    this._evPos[0] = p[0]; this._evPos[1] = p[1]; this._evPos[2] = p[2];
    this._evVin[0] = v[0]; this._evVin[1] = v[1]; this._evVin[2] = v[2];
    this._ev = kind;
    if (kind === EV.BOUNCE) { p[1] = R; this._evPos[1] = R; this._bounce(); }
    else if (kind === EV.NET) this._netResponse();
    else if (kind === EV.POST) this._postResponse();
    else this._wallResponse();
    return hc;
  }

  // ---------------------------------------------------------------- Aufsprung (Cross/Brody)
  _bounce() {
    const v = this.vel, w = this.spin, S = this.surface;
    const vyIn = v[1] < 0 ? -v[1] : 0;
    let e = S.e0 - S.eSlope * vyIn;
    e = e < S.eMin ? S.eMin : e > S.eMax ? S.eMax : e;
    v[1] = e * vyIn;
    // Gleitgeschwindigkeit des Kontaktpunkts (unten): v + ω × (-r ŷ) = (vx + r ωz, ·, vz - r ωx)
    const ux = v[0] + R * w[2], uz = v[2] - R * w[0];
    const u = Math.hypot(ux, uz);
    let grip = false;
    if (u > 1e-6) {
      const a = BALL.inertia;
      const need = u * (a / (1 + a)) * (1 + S.ex);   // Impuls bis Rollen (+ leichte Rückstellung)
      const avail = S.mu * (1 + e) * vyIn;           // Coulomb-Grenze
      let J = need;
      if (avail < need) J = avail; else grip = true;
      const dvx = -J * ux / u, dvz = -J * uz / u;
      v[0] += dvx; v[2] += dvz;
      // Δω = -(ŷ × Δv)/(α r);  ŷ × (dvx,0,dvz) = (dvz, 0, -dvx)
      w[0] -= dvz / (a * R);
      w[2] += dvx / (a * R);
    }
    w[1] *= S.spinKeepY;
    this.bounces++;
    this.lastBounce[0] = this.pos[0]; this.lastBounce[1] = 0; this.lastBounce[2] = this.pos[2];
    this._evGrip = grip;
    this._ghost = false;
    if (v[1] < ROLL_VY) this._startRoll();
  }

  _startRoll() {
    const v = this.vel, w = this.spin;
    this.mode = 'roll';
    v[1] = 0; this.pos[1] = R;
    w[0] = v[2] / R; w[2] = -v[0] / R;
  }

  _advanceRoll(h) {
    const p = this.pos, v = this.vel, w = this.spin;
    const sp = Math.hypot(v[0], v[2]);
    if (sp < REST_SPEED) {
      v[0] = v[1] = v[2] = 0; w[0] = w[1] = w[2] = 0;
      this.mode = 'rest';
      this._ev = EV.REST;
      this._evPos.set(p); this._evVin.fill(0);
      return h;
    }
    const decel = this.surface.rollDecel + K_AIR * BALL.cd * sp * sp;
    const ns = Math.max(0, sp - decel * h), k = ns / sp;
    const oz = p[2];
    const avg = (1 + k) * 0.5 * h;
    p[0] += v[0] * avg; p[2] += v[2] * avg; p[1] = R;
    v[0] *= k; v[2] *= k;
    w[0] = v[2] / R; w[2] = -v[0] / R; w[1] *= 0.98;
    // rollt ins Netz -> bleibt liegen
    if (this.collideNet && Math.abs(p[0]) <= PX) {
      const s0 = oz >= 0 ? 1 : -1;
      if (oz * s0 >= R && p[2] * s0 < R) {
        p[2] = s0 * R;
        this._evPos.set(p); this._evVin.set(v);
        v[2] = -v[2] * E_MESH; v[0] *= 0.3;
        this.netTouches++;
        this._ev = EV.NET; this._evFlag = 0; this._evQ = -1;
      }
    }
    if (this.walls && !this._ev) {
      const W = this.walls;
      if (Math.abs(p[0]) > W.halfX - R) { p[0] = Math.sign(p[0]) * (W.halfX - R); this._evPos.set(p); this._evVin.set(v); v[0] = -v[0] * W.e; this._ev = EV.WALL; this._wallAxis = 0; }
      else if (Math.abs(p[2]) > W.halfZ - R) { p[2] = Math.sign(p[2]) * (W.halfZ - R); this._evPos.set(p); this._evVin.set(v); v[2] = -v[2] * W.e; this._ev = EV.WALL; this._wallAxis = 1; }
    }
    return h;
  }

  // ---------------------------------------------------------------- Netz
  /** Erster Kontaktzeitpunkt (Anteil 0..1) des linearen Wegs p0->p1 mit Netzfläche oder Netzband, sonst 2. */
  _netTau(p0, p1) {
    const z0 = p0[2], z1 = p1[2];
    if ((z0 > R && z1 > R) || (z0 < -R && z1 < -R)) return 2;
    const x0 = p0[0], y0 = p0[1], dx = p1[0] - x0, dy = p1[1] - y0, dz = z1 - z0;
    let tzc = 0.5;
    if (Math.abs(dz) > 1e-12) { tzc = -z0 / dz; tzc = tzc < 0 ? 0 : tzc > 1 ? 1 : tzc; }
    const xm = x0 + dx * tzc;
    if (Math.abs(xm) > PX + R) return 2;
    let best = 2;
    const s0 = z0 > 1e-9 ? 1 : z0 < -1e-9 ? -1 : (dz < 0 ? 1 : -1);
    // 1) Netzfläche (Masche + Bandvorderseite): Mittelpunkt erreicht |z| = R unterhalb der Oberkante
    if (dz * s0 < 0) {
      if (z0 * s0 >= R - 1e-9) {
        const tp = (s0 * R - z0) / dz;
        if (tp >= 0 && tp <= 1) {
          const xc = x0 + dx * tp, yc = y0 + dy * tp;
          if (Math.abs(xc) <= PX && yc <= netHeightAt(xc)) { best = tp; this._netKind = 1; this._nY = 0; this._nZ = s0; }
        }
      } else if (Math.abs(x0) <= PX && y0 <= netHeightAt(x0)) {
        // steckt bereits im Netzbereich (Sonderfall) -> sofortiger Maschenkontakt
        best = 0; this._netKind = 1; this._nY = 0; this._nZ = s0;
      }
    }
    // 2) Netzband-Oberkante (Linie y = h(x), z = 0)
    if (Math.abs(xm) <= PX) {
      const hN = netHeightAt(xm);
      const Y0 = y0 - hN;
      const a = dy * dy + dz * dz, b = 2 * (Y0 * dy + z0 * dz), c = Y0 * Y0 + z0 * z0 - R * R;
      if (c <= 0) {
        if (b < 0 && Y0 > 0 && best > 0) { best = 0; this._netKind = 2; this._nY = Y0 / R; this._nZ = z0 / R; }
      } else if (a > 1e-14) {
        const disc = b * b - 4 * a * c;
        if (disc >= 0) {
          const te = (-b - Math.sqrt(disc)) / (2 * a);
          if (te >= 0 && te <= 1 && te < best) {
            const Yc = Y0 + dy * te;
            if (Yc > 0) { best = te; this._netKind = 2; this._nY = Yc / R; this._nZ = (z0 + dz * te) / R; }
          }
        }
      }
    }
    return best;
  }

  _netResponse() {
    const p = this.pos, v = this.vel, w = this.spin;
    this.netTouches++;
    const s0 = this._nZ > 0 ? 1 : this._nZ < 0 ? -1 : (v[2] < 0 ? 1 : -1); // Seite, von der der Ball kommt
    this._evQ = this._netKind === 1 ? -1 : this._nY;
    if (this._netKind === 1) { this._meshResponse(s0); return; }
    // Netzband
    const hsp = Math.hypot(v[0], v[2]);
    const approaching = v[2] * s0 < 0;
    if (approaching && Math.abs(v[2]) > 2.5 && Math.abs(v[2]) > 0.8 * Math.abs(v[1])) {
      // Harter, überwiegend horizontaler Bandtreffer -> Netzroller-Heuristik über die Treffhöhe q
      const Yc = this._nY * R, zc = this._nZ * R;
      const tz = Math.abs(zc) / Math.abs(v[2]);
      const q = Math.max(-1, Math.min(1, (Yc + v[1] * tz) / R));
      this._evQ = q;
      if (q < Q_STOP) { this._meshResponse(s0); return; }
      const s = (q - Q_STOP) / (1 - Q_STOP);           // 0 = tief getroffen … 1 = nur gestreift
      const kf = -0.12 + 1.06 * Math.pow(s, 1.3);      // Erhalt der Vorwärtsgeschwindigkeit (< 0: fällt zurück)
      const pop = hsp * 0.15 * Math.pow(1 - s, 0.8);   // Band schleudert den Ball nach oben
      let vy = v[1] * (0.2 + 0.75 * s * s) + pop + (v[1] < 0 ? -v[1] * 0.25 * (1 - s) : 0);
      v[2] *= kf;
      v[0] *= 0.35 + 0.55 * s;
      // Drall: stark gedämpft, das Band "greift" unten -> etwas Vorwärtsdrall
      const keep = 0.25 + 0.55 * s;
      w[0] *= keep; w[1] *= keep; w[2] *= keep;
      const fz = -s0;                                   // Vorwärtsrichtung (z)
      const addTop = (1 - s) * hsp * 0.2 / R;           // Topspin-Achse für Richtung (0,0,fz): (fz,0,0)
      w[0] += addTop * fz;
      if (s < 0.6) {
        // tiefer Kontakt: Ball läuft über die Bandoberkante -> oben auf das Band setzen
        if (vy < 0.4) vy = 0.4;
        p[1] = netHeightAt(p[0]) + R * 1.0005;
        p[2] = (kf > 0.02 ? fz : kf < -0.02 ? s0 : (q > 0 ? fz : s0)) * 1e-4;
      } else {
        this._ghost = true;                              // gestreift: Ball passiert das Band
      }
      v[1] = vy;
      this._cordDir = kf > 0.02 ? fz : kf < -0.02 ? s0 : (q > 0 ? fz : s0);
      this._evFlag = 1;
      return;
    }
    // Weicher Kontakt (Tröpfeln auf dem Band, Ball fällt aufs Band)
    const nY = this._nY, nZ = this._nZ;
    const vn = v[1] * nY + v[2] * nZ;
    if (vn < 0) {
      const tY = v[1] - vn * nY, tZ = v[2] - vn * nZ;     // tangential (in y-z)
      const vnOut = -E_TAPE * vn;
      v[1] = tY * 0.85 + vnOut * nY;
      v[2] = tZ * 0.85 + vnOut * nZ;
      v[0] *= 0.85;
      w[0] *= 0.6; w[1] *= 0.6; w[2] *= 0.6;
      // fast mittig auf dem Band: deterministisch in Abrollrichtung schubsen
      if (Math.abs(nZ) < 0.3) {
        const dir = this._cordDir || (p[2] >= 0 ? 1 : -1);
        v[2] += dir * 0.35;
      }
    }
    this._evFlag = 2;
  }

  _meshResponse(s0) {
    const p = this.pos, v = this.vel, w = this.spin;
    // Netzmasche gibt nach und schluckt die Energie: Ball fällt auf der Seite des Schlagenden herunter
    const vin = Math.abs(v[2]);
    v[2] = s0 * Math.min(0.15 + vin * E_MESH, 1.4);
    v[0] *= 0.3;
    v[1] = v[1] * 0.3;
    w[0] *= 0.3; w[1] *= 0.3; w[2] *= 0.3;
    p[2] = s0 * R;
    this._evFlag = 0;
    this._cordDir = s0;
  }

  // ---------------------------------------------------------------- Pfosten / Stützen
  _postTau(p0, p1) {
    let best = 2;
    const dx = p1[0] - p0[0], dz = p1[2] - p0[2], dy = p1[1] - p0[1];
    const a = dx * dx + dz * dz;
    if (a < 1e-14) return 2;
    for (let i = 0; i < POSTS.length; i++) {
      const P = POSTS[i];
      const X0 = p0[0] - P.x, Z0 = p0[2];
      const rr = R + P.r;
      const c = X0 * X0 + Z0 * Z0 - rr * rr;
      if (c <= 0) continue;
      const b = 2 * (X0 * dx + Z0 * dz);
      if (b >= 0) continue;
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t >= 0 && t <= 1 && t < best && p0[1] + dy * t <= P.h) { best = t; this._postIdx = i; }
    }
    return best;
  }

  _postResponse() {
    const P = POSTS[this._postIdx], p = this.pos, v = this.vel, w = this.spin;
    let nx = p[0] - P.x, nz = p[2];
    const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
    const vn = v[0] * nx + v[2] * nz;
    if (vn < 0) {
      const tx = v[0] - vn * nx, tz = v[2] - vn * nz;
      v[0] = tx * 0.85 - 0.5 * vn * nx;
      v[2] = tz * 0.85 - 0.5 * vn * nz;
      v[1] *= 0.9;
    }
    w[0] *= 0.5; w[1] *= 0.5; w[2] *= 0.5;
  }

  // ---------------------------------------------------------------- Wände
  _wallTau(p0, p1) {
    const W = this.walls;
    let best = 2;
    const hx = W.halfX - R, hz = W.halfZ - R;
    if (Math.abs(p1[0]) > hx && Math.abs(p0[0]) <= hx) {
      const s = p1[0] > 0 ? 1 : -1;
      const t = (s * hx - p0[0]) / (p1[0] - p0[0]);
      if (t >= 0 && t <= 1 && p0[1] + (p1[1] - p0[1]) * t < W.height) { best = t; this._wallAxis = 0; }
    }
    if (Math.abs(p1[2]) > hz && Math.abs(p0[2]) <= hz) {
      const s = p1[2] > 0 ? 1 : -1;
      const t = (s * hz - p0[2]) / (p1[2] - p0[2]);
      if (t >= 0 && t <= 1 && t < best && p0[1] + (p1[1] - p0[1]) * t < W.height) { best = t; this._wallAxis = 1; }
    }
    return best;
  }

  _wallResponse() {
    const v = this.vel, w = this.spin, e = this.walls.e;
    if (this._wallAxis === 0) { v[0] = -v[0] * e; v[2] *= 0.6; } else { v[2] = -v[2] * e; v[0] *= 0.6; }
    v[1] *= 0.6;
    w[0] *= 0.3; w[1] *= 0.3; w[2] *= 0.3;
  }
}
const ZERO3 = new Float64Array(3);

// ---------------------------------------------------------------- Vorhersage
/**
 * Vorhergesagte Flugbahn (wiederverwendbare Puffer). Samples bei festen Schritten plus exakte
 * Ereignis-Samples (je zwei bei Kontakt: vor/nach der Antwort, gleiche Zeit).
 */
export class Trajectory {
  constructor(capacity = 512) {
    this._alloc(capacity);
    this.evCap = 24;
    this.evType = new Int8Array(this.evCap);
    this.evT = new Float64Array(this.evCap);
    this.evP = new Float64Array(this.evCap * 3);
    this.evVin = new Float64Array(this.evCap * 3);
    this.evVout = new Float64Array(this.evCap * 3);
    this.evFlag = new Int8Array(this.evCap);
    this.reset();
  }
  _alloc(cap) {
    const ot = this.t, op = this.p, ov = this.v, n = this.n || 0;
    this.cap = cap;
    this.t = new Float64Array(cap); this.p = new Float64Array(cap * 3); this.v = new Float64Array(cap * 3);
    if (ot && n) { this.t.set(ot.subarray(0, n)); this.p.set(op.subarray(0, n * 3)); this.v.set(ov.subarray(0, n * 3)); }
  }
  reset() {
    this.n = 0; this.evN = 0; this.bounceCount = 0;
    this.netT = -1; this.netX = 0; this.netY = 0; this.netClearance = 0;
    this.netHit = false; this.netCord = false;
    this.apexT = 0; this.apexY = -1;
    this.restT = -1;
    return this;
  }
  _push(t, p, v) {
    if (this.n >= this.cap) this._alloc(this.cap * 2);
    const i = this.n++, k = i * 3;
    this.t[i] = t;
    this.p[k] = p[0]; this.p[k + 1] = p[1]; this.p[k + 2] = p[2];
    this.v[k] = v[0]; this.v[k + 1] = v[1]; this.v[k + 2] = v[2];
  }
  _event(type, t, p, vin, vout, flag) {
    if (this.evN >= this.evCap) return;
    const i = this.evN++, k = i * 3;
    this.evType[i] = type; this.evT[i] = t; this.evFlag[i] = flag;
    this.evP[k] = p[0]; this.evP[k + 1] = p[1]; this.evP[k + 2] = p[2];
    this.evVin[k] = vin[0]; this.evVin[k + 1] = vin[1]; this.evVin[k + 2] = vin[2];
    this.evVout[k] = vout[0]; this.evVout[k + 1] = vout[1]; this.evVout[k + 2] = vout[2];
    if (type === EV.BOUNCE) this.bounceCount++;
    else if (type === EV.NET) { if (flag) this.netCord = true; else this.netHit = true; }
  }
  get count() { return this.n; }
  get duration() { return this.n ? this.t[this.n - 1] : 0; }

  /** Index i des Intervalls [t_i, t_{i+1}) mit t_i <= t (binäre Suche). */
  _seg(t) {
    let lo = 0, hi = this.n - 1;
    if (t <= this.t[0]) return 0;
    if (t >= this.t[hi]) return hi - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.t[m] <= t) lo = m; else hi = m; }
    return lo;
  }

  /** Position zur Zeit t (kubische Hermite-Interpolation; geklemmt an Anfang/Ende). */
  positionAt(t, out = new Float64Array(3)) {
    const n = this.n;
    if (n === 0) return out;
    if (n === 1 || t <= this.t[0]) { out[0] = this.p[0]; out[1] = this.p[1]; out[2] = this.p[2]; return out; }
    if (t >= this.t[n - 1]) { const k = (n - 1) * 3; out[0] = this.p[k]; out[1] = this.p[k + 1]; out[2] = this.p[k + 2]; return out; }
    const i = this._seg(t), j = i + 1, a = i * 3, b = j * 3;
    const h = this.t[j] - this.t[i];
    if (h <= 1e-12) { out[0] = this.p[b]; out[1] = this.p[b + 1]; out[2] = this.p[b + 2]; return out; }
    const u = (t - this.t[i]) / h;
    for (let c = 0; c < 3; c++) out[c] = hermite(this.p[a + c], this.v[a + c] * h, this.p[b + c], this.v[b + c] * h, u);
    return out;
  }

  /** Geschwindigkeit zur Zeit t (linear interpoliert). */
  velocityAt(t, out = new Float64Array(3)) {
    const n = this.n;
    if (n === 0) return out;
    if (n === 1 || t <= this.t[0]) { out[0] = this.v[0]; out[1] = this.v[1]; out[2] = this.v[2]; return out; }
    if (t >= this.t[n - 1]) { const k = (n - 1) * 3; out[0] = this.v[k]; out[1] = this.v[k + 1]; out[2] = this.v[k + 2]; return out; }
    const i = this._seg(t), j = i + 1, a = i * 3, b = j * 3;
    const h = this.t[j] - this.t[i];
    const u = h > 1e-12 ? (t - this.t[i]) / h : 1;
    for (let c = 0; c < 3; c++) out[c] = this.v[a + c] + (this.v[b + c] - this.v[a + c]) * u;
    return out;
  }

  /** Erster Zeitpunkt >= after, an dem die Ballmitte Höhe h kreuzt (descending: fallend; false: steigend; null: beides). -1 wenn nie. */
  timeToHeight(h, after = 0, descending = true) {
    return this._cross(1, h, after, descending);
  }
  /** Erster Zeitpunkt >= after, an dem der Ball die Ebene z = zPlane kreuzt. -1 wenn nie. */
  timeToZ(zPlane, after = 0) { return this._cross(2, zPlane, after, null); }
  /** Erster Zeitpunkt >= after, an dem der Ball die Ebene x = xPlane kreuzt. -1 wenn nie. */
  timeToX(xPlane, after = 0) { return this._cross(0, xPlane, after, null); }

  _cross(c, val, after, dir) {
    const n = this.n;
    if (n < 2) return -1;
    let i = after > this.t[0] ? this._seg(after) : 0;
    for (; i < n - 1; i++) {
      const a = i * 3 + c, b = (i + 1) * 3 + c;
      const f0 = this.p[a] - val, f1 = this.p[b] - val;
      const h = this.t[i + 1] - this.t[i];
      if (h <= 1e-12) continue;
      if ((f0 > 0 && f1 <= 0 && dir !== false) || (f0 < 0 && f1 >= 0 && dir !== true)) {
        const u = hermiteRoot(this.p[a], this.v[a] * h, this.p[b], this.v[b] * h, val);
        const t = this.t[i] + u * h;
        if (t >= after - 1e-9) return t;
      }
    }
    return -1;
  }

  /** Sample i als Objekt { t, pos, vel } (out wird wiederverwendet). */
  sample(i, out = null) {
    out = out || { t: 0, pos: new Float64Array(3), vel: new Float64Array(3) };
    const k = i * 3;
    out.t = this.t[i];
    out.pos[0] = this.p[k]; out.pos[1] = this.p[k + 1]; out.pos[2] = this.p[k + 2];
    out.vel[0] = this.v[k]; out.vel[1] = this.v[k + 1]; out.vel[2] = this.v[k + 2];
    return out;
  }

  /** Höchster Punkt im Zeitfenster [t0, t1] (z. B. Absprunghöhe zwischen 1. und 2. Aufsprung): out = { t, y }. */
  maxHeightBetween(t0, t1, out = { t: 0, y: -1 }) {
    out.t = t0; out.y = -1;
    const n = this.n;
    for (let i = 0; i < n - 1; i++) {
      const ta = this.t[i], tb = this.t[i + 1];
      if (tb < t0 || ta > t1) continue;
      const vy0 = this.v[i * 3 + 1], vy1 = this.v[i * 3 + 4];
      let tc = ta, yc = this.p[i * 3 + 1];
      if (vy0 > 0 && vy1 <= 0 && tb - ta > 1e-12) {
        // Scheitel im Intervall: vy ist nahezu linear
        const u = vy0 / (vy0 - vy1), h = tb - ta;
        tc = ta + u * h;
        yc = hermite(this.p[i * 3 + 1], vy0 * h, this.p[i * 3 + 4], vy1 * h, u);
      } else if (this.p[i * 3 + 4] > yc) { tc = tb; yc = this.p[i * 3 + 4]; }
      if (tc >= t0 && tc <= t1 && yc > out.y) { out.y = yc; out.t = tc; }
    }
    return out;
  }

  /** Ereignis i: Typ-Code (EV.*), Zeit, Position, Geschwindigkeit vor/nach. */
  eventType(i) { return this.evType[i]; }
  eventTime(i) { return this.evT[i]; }

  /** i-ter Aufsprung (0-basiert) als Objekt { t, pos, vel, velIn } oder null. out wird wiederverwendet. */
  bounce(i = 0, out = null) {
    let k = -1;
    for (let e = 0, b = 0; e < this.evN; e++) if (this.evType[e] === EV.BOUNCE) { if (b === i) { k = e; break; } b++; }
    if (k < 0) return null;
    out = out || { t: 0, pos: new Float64Array(3), vel: new Float64Array(3), velIn: new Float64Array(3) };
    out.t = this.evT[k];
    for (let c = 0; c < 3; c++) { out.pos[c] = this.evP[k * 3 + c]; out.vel[c] = this.evVout[k * 3 + c]; out.velIn[c] = this.evVin[k * 3 + c]; }
    return out;
  }
  /** Zeit des i-ten Aufsprungs oder -1. */
  bounceTime(i = 0) {
    for (let e = 0, b = 0; e < this.evN; e++) if (this.evType[e] === EV.BOUNCE) { if (b === i) return this.evT[e]; b++; }
    return -1;
  }
  /** Alle Aufsprünge als Array (Komfort; allokiert). */
  findBounces() {
    const res = [];
    for (let i = 0; i < this.bounceCount; i++) res.push(this.bounce(i));
    return res;
  }
  /** Alle Ereignisse als Objekte (Komfort; allokiert). */
  events() {
    const res = [];
    for (let e = 0; e < this.evN; e++) {
      const k = e * 3;
      res.push({ type: EV_NAMES[this.evType[e]], t: this.evT[e], pos: [this.evP[k], this.evP[k + 1], this.evP[k + 2]],
        velIn: [this.evVin[k], this.evVin[k + 1], this.evVin[k + 2]], vel: [this.evVout[k], this.evVout[k + 1], this.evVout[k + 2]], flag: this.evFlag[e] });
    }
    return res;
  }
}

const _pb = new Ball();
const _sharedTraj = new Trajectory(720);

/**
 * Sagt den Ballflug voraus (identische Physik wie Ball.step inkl. Netz/Aufsprung).
 * Rückgabe: Trajectory (geteilter Puffer – gültig bis zum nächsten predict()-Aufruf, außer opts.out ist gesetzt).
 * opts: { out: Trajectory, maxBounces: Anzahl Aufsprünge nach denen abgebrochen wird (Standard ∞),
 *         stopAtRest: true }
 */
export function predict(ball, tMax = 3, dt = BALL.dt, opts = null) {
  const tr = (opts && opts.out) || _sharedTraj;
  const maxB = (opts && opts.maxBounces != null) ? opts.maxBounces : Infinity;
  const b = _pb;
  b.copyFrom(ball);
  tr.reset();
  const startBounces = b.bounces;
  tr._push(0, b.pos, b.vel);
  if (b.mode === 'held' || b.mode === 'rest') return tr;
  let t = 0;
  let apexDone = false;
  tr.apexY = b.pos[1]; tr.apexT = 0;
  let pz = b.pos[2], px = b.pos[0], py = b.pos[1], pt = 0;
  outer:
  while (t < tMax - 1e-9) {
    // Sample-Abstand dt; integriert wird (wie in Ball.step) in Teilschritten <= 1/120 s -> identische Bahn
    const span = Math.min(dt, tMax - t);
    const ns = span > BALL.dt * 1.0001 ? Math.ceil(span / BALL.dt - 1e-6) : 1;
    const hs = span / ns;
    for (let s = 0; s < ns; s++) {
      let rem = hs;
      for (let k = 0; k < 12 && rem > 1e-10; k++) {
        const used = b._advance(rem);
        rem -= used; t += used;
        if (b._ev) {
          tr._push(t, b._evPos, b._evVin);
          tr._event(b._ev, t, b._evPos, b._evVin, b.vel, b._ev === EV.NET ? b._evFlag : (b._ev === EV.BOUNCE ? (b._evGrip ? 1 : 0) : 0));
          tr._push(t, b.pos, b.vel);
          if (b._ev === EV.BOUNCE) { apexDone = true; if (b.bounces - startBounces >= maxB) break outer; }
          if (b._ev === EV.REST) { tr.restT = t; break outer; }
        }
      }
    }
    // Netzdurchgang (Mittelpunkt kreuzt z = 0)
    const z = b.pos[2];
    if (tr.netT < 0 && ((pz > 0 && z <= 0) || (pz < 0 && z >= 0)) && b.mode === 'air') {
      const u = pz / (pz - z);
      tr.netT = pt + (t - pt) * u;
      tr.netX = px + (b.pos[0] - px) * u;
      tr.netY = py + (b.pos[1] - py) * u;
      tr.netClearance = tr.netY - R - netHeightAt(tr.netX);
    }
    if (!apexDone && b.pos[1] > tr.apexY) { tr.apexY = b.pos[1]; tr.apexT = t; }
    pz = z; px = b.pos[0]; py = b.pos[1]; pt = t;
    tr._push(t, b.pos, b.vel);
    if (b.mode === 'rest') { tr.restT = t; break; }
  }
  return tr;
}

// Freie Hilfsfunktionen (Vertragsform aus ARCHITECTURE.md §6; delegieren an die Trajectory-Methoden)
/** Alle Aufsprünge einer Vorhersage: [{ t, pos, vel, velIn }] (allokiert). */
export const findBounces = (traj) => traj.findBounces();
/** Erster Zeitpunkt >= after, an dem die Ballmitte die Höhe h kreuzt (Standard: fallend). -1 wenn nie. */
export const timeToHeight = (traj, h, after = 0, descending = true) => traj.timeToHeight(h, after, descending);
/** Position zur Zeit t (Hermite-interpoliert). */
export const positionAt = (traj, t, out) => traj.positionAt(t, out);

// ---------------------------------------------------------------- Freier Flug (für den Schlag-Löser)
/**
 * Integriert den freien Flug (ohne Netz/Wände) bis zum ersten Bodenkontakt (Ballmitte auf Höhe r).
 * Identischer Integrator wie Ball (RK4, gleiche dt). Ergebnis in res (wiederverwendbar):
 * { landed, t, x, z, vx, vy, vz, netT, netX, netY (Mittelpunkthöhe bei z=0, NaN wenn kein Durchgang),
 *   apexY, apexT, steps }
 */
const _fp = new Float64Array(3), _fv = new Float64Array(3), _fw = new Float64Array(3);
const _fp1 = new Float64Array(3), _fv1 = new Float64Array(3);
export function simulateFlight(p0, v0, w0, res, tMax = 6, dt = BALL.dt) {
  _fp[0] = p0[0]; _fp[1] = p0[1]; _fp[2] = p0[2];
  _fv[0] = v0[0]; _fv[1] = v0[1]; _fv[2] = v0[2];
  _fw[0] = w0[0]; _fw[1] = w0[1]; _fw[2] = w0[2];
  res.landed = false; res.netT = -1; res.netX = 0; res.netY = NaN;
  res.apexY = _fp[1]; res.apexT = 0;
  let t = 0, steps = 0;
  if (_fp[1] < R) _fp[1] = R;
  while (t < tMax) {
    const sp = Math.hypot(_fv[0], _fv[1], _fv[2]);
    rk4(_fp, _fv, _fw, dt, _fp1, _fv1);
    steps++;
    // Scheitel (vy wechselt Vorzeichen)
    if (_fv[1] > 0 && _fv1[1] <= 0) {
      const u = _fv[1] / (_fv[1] - _fv1[1]);               // vy ist im Schritt nahezu linear
      const y = hermite(_fp[1], _fv[1] * dt, _fp1[1], _fv1[1] * dt, u);
      if (y > res.apexY) { res.apexY = y; res.apexT = t + u * dt; }
    }
    // Netzebene
    if (res.netT < 0 && ((_fp[2] > 0 && _fp1[2] <= 0) || (_fp[2] < 0 && _fp1[2] >= 0))) {
      const u = hermiteRoot(_fp[2], _fv[2] * dt, _fp1[2], _fv1[2] * dt, 0);
      res.netT = t + u * dt;
      res.netX = hermite(_fp[0], _fv[0] * dt, _fp1[0], _fv1[0] * dt, u);
      res.netY = hermite(_fp[1], _fv[1] * dt, _fp1[1], _fv1[1] * dt, u);
    }
    // Boden
    if (_fp1[1] <= R && _fv1[1] < 0) {
      const u = hermiteRoot(_fp[1], _fv[1] * dt, _fp1[1], _fv1[1] * dt, R);
      res.landed = true;
      res.t = t + u * dt;
      res.x = hermite(_fp[0], _fv[0] * dt, _fp1[0], _fv1[0] * dt, u);
      res.z = hermite(_fp[2], _fv[2] * dt, _fp1[2], _fv1[2] * dt, u);
      res.vx = _fv[0] + (_fv1[0] - _fv[0]) * u;
      res.vy = _fv[1] + (_fv1[1] - _fv[1]) * u;
      res.vz = _fv[2] + (_fv1[2] - _fv[2]) * u;
      res.steps = steps;
      return res;
    }
    _fp[0] = _fp1[0]; _fp[1] = _fp1[1]; _fp[2] = _fp1[2];
    _fv[0] = _fv1[0]; _fv[1] = _fv1[1]; _fv[2] = _fv1[2];
    decaySpin(_fw, sp, dt);
    t += dt;
  }
  res.t = t; res.x = _fp[0]; res.z = _fp[2]; res.vx = _fv[0]; res.vy = _fv[1]; res.vz = _fv[2];
  res.steps = steps;
  return res;
}

/** Luftbeschleunigung für Debug/Tests: (v, ω) -> a. */
export function airAccel(v, w, out = new Float64Array(3)) {
  aeroCoeffs(v[0], v[1], v[2], w[0], w[1], w[2]);
  accel(v[0], v[1], v[2], w[0], w[1], w[2], out);
  return out;
}
/** Aerodynamische Beiwerte { cd, cl } für Geschwindigkeit v und Spin w (Debug/Tests/Anzeige). */
export function aeroAt(v, w, out = {}) {
  aeroCoeffs(v[0], v[1], v[2], w[0], w[1], w[2]);
  out.cd = _cd; out.cl = _cl;
  return out;
}

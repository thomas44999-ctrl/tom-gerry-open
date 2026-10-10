// Schlag-Löser: findet Abfluggeschwindigkeit/-winkel, sodass der Ball (mit echter Physik: Luftwiderstand,
// Magnus, Spin-Abbau – identischer Integrator wie Ball/predict) exakt im Zielpunkt landet.
// Schießverfahren: Sekante/Newton auf (Tempo, Abflugwinkel), Azimut per Seitenfehler-Korrektur.
// Modi: 'speed' (Tempo vorgegeben), 'clearance' (Netzabstand vorgegeben), 'apex' (Scheitelhöhe vorgegeben).

import { BALL, RPM, simulateFlight, spinFromLocal } from './ball.js';
import { COURT, netHeightAt, serviceBoxRect } from './court.js';

const R = BALL.radius;
const G = BALL.g;
const K_AIR = 0.5 * BALL.rho * Math.PI * R * R / BALL.mass;
const DEG = Math.PI / 180;
const MAX_SPEED = 72, MIN_SPEED = 2;
const TOL = 0.004;                       // Zielgenauigkeit (m) für Landepunkt / Netzabstand / Scheitel

const FALLBACK_SPEEDS = [24, 32, 16, 42, 11];
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Schlag-Presets. Tempo in m/s (Abfluggeschwindigkeit), Spin in U/min (top > 0 Topspin, < 0 Unterschnitt;
 * side > 0 = Kurve nach rechts aus Sicht des Schlagenden; rifle = Drall um die Flugrichtung, nur beim Absprung wirksam).
 * Bereiche werden mit power (0..1, Aufladung) interpoliert und mit Spielerwerten skaliert.
 * mode: welche Größe vorgegeben wird; minClearance: Mindestabstand Ballunterkante–Netzband (Rückfall bei zu hohem Tempo).
 */
export const SHOT_PRESETS = {
  // Arcade-Tempo (Prototyp 2): deutlich langsamer als Profitennis, höhere Bögen -> mehr Zeit zum Reagieren.
  // Profi-Werte zum Vergleich: Topspin 21–35 m/s, Aufschlag flach 42–58 m/s.
  topspin:     { mode: 'speed',     speed: [15, 25],   top: [1300, 2900],  side: [0, 0],        rifle: [0, 0],       minClearance: 0.2,  stat: 'power' },
  flat:        { mode: 'speed',     speed: [17, 29],   top: [300, 900],    side: [0, 0],        rifle: [0, 0],       minClearance: 0.1,  stat: 'power' },
  slice:       { mode: 'clearance', clearance: [0.95, 0.5], top: [-700, -1400], side: [0, 0],  rifle: [0, 0],       minClearance: 0.1,  stat: 'control' },
  lob:         { mode: 'apex',      apex: [5.4, 7.8],  top: [700, 1700],   side: [0, 0],        rifle: [0, 0],       minClearance: 0.5,  stat: 'touch' },
  drop:        { mode: 'clearance', clearance: [0.58, 0.36], top: [-1400, -2300], side: [0, 0], rifle: [0, 0],       minClearance: 0.1,  stat: 'touch' },
  volley:      { mode: 'speed',     speed: [11, 19],   top: [-250, -800],  side: [0, 0],        rifle: [0, 0],       minClearance: 0.1,  stat: 'volley' },
  smash:       { mode: 'speed',     speed: [22, 32],   top: [300, 900],    side: [0, 0],        rifle: [0, 0],       minClearance: 0.12, stat: 'power' },
  serve_flat:  { mode: 'speed',     speed: [30, 41],   top: [500, 1100],   side: [-150, -300],  rifle: [0, 0],       minClearance: 0.08, stat: 'serve' },
  serve_kick:  { mode: 'speed',     speed: [26, 33],   top: [2600, 3800],  side: [-400, -650],  rifle: [800, 1400],  minClearance: 0.3,  stat: 'serve' },
  serve_slice: { mode: 'speed',     speed: [28, 36],   top: [250, 600],    side: [-1300, -2100], rifle: [0, 0],      minClearance: 0.12, stat: 'serve' },
};

/**
 * Konkrete Schlagparameter eines Presets für power (0..1) und Spielerwerte (PLAYER_STATS-Eintrag).
 * Rückgabe { type, mode, speed?, netClearance?, apexHeight?, topRpm, sideRpm, rifleRpm, minClearance }.
 */
export function presetParams(type, power = 0.6, stats = null, out = {}) {
  const P = SHOT_PRESETS[type];
  if (!P) throw new Error('unknown shot preset ' + type);
  const pw = clamp01(power);
  const statV = stats ? (stats[P.stat] ?? 0.8) : 0.8;
  const spinV = stats ? (stats.spin ?? 0.8) : 0.8;
  out.type = type; out.mode = P.mode; out.minClearance = P.minClearance;
  out.speed = undefined; out.netClearance = undefined; out.apexHeight = undefined;
  if (P.mode === 'speed') out.speed = lerp(P.speed[0], P.speed[1] * (0.88 + 0.14 * statV), pw);
  else if (P.mode === 'clearance') out.netClearance = lerp(P.clearance[0], P.clearance[1], pw * (0.6 + 0.4 * statV));
  else out.apexHeight = lerp(P.apex[0], P.apex[1], pw);
  const spinScale = 0.82 + 0.3 * spinV;
  const st = clamp01(0.35 + 0.65 * pw);
  out.topRpm = lerp(P.top[0], P.top[1], st) * spinScale;
  out.sideRpm = lerp(P.side[0], P.side[1], st) * spinScale;
  out.rifleRpm = lerp(P.rifle[0], P.rifle[1], st) * spinScale;
  return out;
}

// ---------------------------------------------------------------- interner Kontext
const ctx = {
  fx: 0, fy: 0, fz: 0, ux: 0, uz: 0, D: 0, crosses: false,
  top: 0, side: 0, rifle: 0, worldSpin: null,
  phi: 0, sims: 0, tMax: 6,
  // letzte Auswertung
  eA: 0, lat: 0, clr: NaN, apex: 0, landed: false, t: 0, lx: 0, lz: 0, netX: 0, along: 0,
};
const _fr = {};
const _p0 = new Float64Array(3), _v0 = new Float64Array(3), _w0 = new Float64Array(3);

function setVelSpin(v, th, ph, vel, w) {
  const ch = Math.cos(th), sp = Math.sin(ph), cp = Math.cos(ph);
  vel[0] = v * ch * sp; vel[1] = v * Math.sin(th); vel[2] = v * ch * cp;
  if (ctx.worldSpin) { w[0] = ctx.worldSpin[0]; w[1] = ctx.worldSpin[1]; w[2] = ctx.worldSpin[2]; }
  else spinFromLocal(w, sp, cp, ctx.top, ctx.side, ctx.rifle);
}

/** Simuliert (v, θ, φ) und setzt Residuen im Kontext. */
function evalShot(v, th, ph) {
  setVelSpin(v, th, ph, _v0, _w0);
  simulateFlight(_p0, _v0, _w0, _fr, ctx.tMax);
  ctx.sims++;
  ctx.landed = _fr.landed;
  const Lx = _fr.x - ctx.fx, Lz = _fr.z - ctx.fz;
  ctx.lx = _fr.x; ctx.lz = _fr.z; ctx.t = _fr.t;
  ctx.along = Lx * ctx.ux + Lz * ctx.uz;
  ctx.eA = _fr.landed ? ctx.along - ctx.D : 1e3;
  ctx.lat = Lx * ctx.uz - Lz * ctx.ux;               // > 0: zu weit in +φ-Richtung
  ctx.apex = _fr.apexY;
  ctx.netX = _fr.netX;
  ctx.clr = _fr.netT >= 0 ? _fr.netY - R - netHeightAt(_fr.netX) : NaN;
  return ctx.eA;
}

function correctPhi() {
  const a = Math.max(ctx.along, 0.5);
  ctx.phi -= Math.atan2(ctx.lat, a);
}

// ---------------------------------------------------------------- Startschätzungen (Vakuum + Korrekturen)
function dragFactor(D, v) {
  // horizontale Geschwindigkeit fällt etwa exponentiell mit der Strecke: v(s) = v0 e^{-k s}
  const k = K_AIR * (v > 25 ? 0.62 : 0.68);
  const kd = k * D;
  return kd > 1e-6 ? kd / (Math.exp(kd) - 1) : 1;   // v_eff / v0
}
function gEff(v) {
  // Magnus vertikal (grob): Topspin drückt nach unten, Unterschnitt trägt
  const w = Math.abs(ctx.top);
  if (w < 1) return G;
  const cl = 1 / (2 + v / (R * w));
  const am = K_AIR * cl * v * v * 0.8;
  return Math.max(2.5, G + (ctx.top > 0 ? am : -am));
}
function guessSpeedMode(v, high) {
  const D = ctx.D, y0 = ctx.fy;
  const ve = v * dragFactor(D, v) * 0.97;
  const g = gEff(v * 0.85);
  const A = g * D * D / (2 * ve * ve);
  const disc = D * D - 4 * A * (R - y0 + A);
  if (disc < 0) return high ? 55 * DEG : 32 * DEG;
  const T = (D + (high ? 1 : -1) * Math.sqrt(disc)) / (2 * A);
  return Math.atan(T);
}
function guessClearance(c) {
  const D = ctx.D, y0 = ctx.fy;
  const dn = ctx.dn;
  const yn = netHeightAt(ctx.netXGuess) + R + c;
  let T, Gc;
  if (ctx.crosses && dn > 0.05 && dn < D - 0.05) {
    T = ((yn - y0) * D * D - (R - y0) * dn * dn) / (dn * D * (D - dn));
    Gc = (T * dn - (yn - y0)) / (dn * dn);
  } else { T = 0.15; Gc = (T * D - (R - y0)) / (D * D); }
  if (!(Gc > 1e-5)) Gc = 1e-3;
  let v = 25;
  for (let i = 0; i < 3; i++) {
    const vh = Math.sqrt(gEff(v * 0.85) / (2 * Gc));
    v = (vh / dragFactor(D, vh)) * Math.sqrt(1 + T * T);
  }
  return [Math.min(Math.max(v, MIN_SPEED + 1), MAX_SPEED), Math.atan(T)];
}
function guessApex(H) {
  const D = ctx.D, y0 = ctx.fy;
  const h = Math.max(H - y0, 0.3);
  const g = gEff(15) * 1.08;
  const vy = Math.sqrt(2 * g * h);
  const tt = vy / g + Math.sqrt(2 * Math.max(H - R, 0.1) / g);
  let vh = D / tt;
  vh = vh / dragFactor(D, vh);
  return [Math.hypot(vh, vy), Math.atan2(vy, vh)];
}

// ---------------------------------------------------------------- Löser je Modus
/**
 * Tempo fest: gesucht ist θ mit Landeweite = Distanz. Variable s = ±θ, sodass die Weite auf dem
 * relevanten Ast (flache Lösung: unterhalb des Maximalweiten-Winkels; hohe Lösung: oberhalb) mit s steigt.
 * Sichere Sekante mit Klammerung; erkennt "jenseits des Maximums" und meldet NaN, wenn die Maximalweite
 * nicht reicht (zu langsam).
 */
function solveSpeed(v, high) {
  const sg = high ? -1 : 1;
  const sMin = high ? -86 * DEG : -76 * DEG, sMax = high ? -2 * DEG : 76 * DEG;
  let s = sg * guessSpeedMode(v, high);
  if (s < sMin + DEG) s = sMin + DEG; else if (s > sMax - DEG) s = sMax - DEG;
  let a = -Infinity, fa = 0, b = Infinity, fb = 0, cap = Infinity;
  let sPrev = NaN, fPrev = NaN;
  for (let it = 0; it < 34; it++) {
    const f = evalShot(v, sg * s, ctx.phi);
    correctPhi();
    if (Math.abs(f) < TOL && Math.abs(ctx.lat) < TOL) return sg * s;
    if (f < 0) {
      if (s > a) {
        if (isFinite(a) && f < fa) { if (s < cap) cap = s; }   // fällt trotz größerem s -> jenseits des Maximums
        else { a = s; fa = f; }
      }
    } else if (s < b) { b = s; fb = f; }
    let sN;
    const secOk = !isNaN(sPrev) && Math.abs(s - sPrev) > 1e-10 && (f - fPrev) / (s - sPrev) > 0;
    const sec = secOk ? s - f * (s - sPrev) / (f - fPrev) : NaN;
    if (isFinite(a) && isFinite(b)) {
      sN = (sec > a && sec < b) ? sec : 0.5 * (a + b);
      // Stagnation vermeiden: sehr kleine Schritte nahe einem Rand -> Bisektion
      if (it > 6 && (b - a) > 0.2 * DEG && Math.abs(sN - s) < 1e-5) sN = 0.5 * (a + b);
    } else if (isFinite(b)) {
      sN = isFinite(sec) ? Math.max(sec, s - 10 * DEG) : b - 4 * DEG;
      if (sN >= b) sN = b - 2 * DEG;
    } else if (isFinite(a)) {
      if (isFinite(cap)) {
        if (cap - a < 0.3 * DEG) return NaN;               // Maximalweite < Distanz
        sN = 0.5 * (a + cap);
      } else {
        sN = isFinite(sec) ? Math.min(sec, s + 10 * DEG) : a + 4 * DEG;
        if (sN <= a) sN = a + 2 * DEG;
      }
    } else sN = s + (f < 0 ? 2 : -2) * DEG;
    if (sN < sMin) sN = sMin;
    if (sN > sMax) { if (s >= sMax - 1e-9) return NaN; sN = sMax; }
    sPrev = s; fPrev = f; s = sN;
  }
  return NaN;
}

/** Kleinstes Tempo (> vLow), bei dem solveSpeed eine Lösung findet (Bisektion, ±2 %). -1 wenn keins <= MAX_SPEED. */
function minSpeedSearch(vLow) {
  let lo = vLow, hi = Math.max(vLow * 1.6, 8);
  const phi0 = ctx.phi;
  while (isNaN(solveSpeed(hi, false))) {
    lo = hi; hi *= 1.6;
    if (hi > MAX_SPEED) { if (isNaN(solveSpeed(MAX_SPEED, false))) { ctx.phi = phi0; return -1; } hi = MAX_SPEED; break; }
  }
  while (hi - lo > 0.02 * hi) {
    const m = 0.5 * (lo + hi);
    if (isNaN(solveSpeed(m, false))) lo = m; else hi = m;
  }
  return hi;
}

/** Zwei Bedingungen (Landeweite + Netzabstand bzw. Scheitelhöhe): Newton mit Differenzen-Jacobi. */
function solve2D(v, th, which, target) {
  const sec = () => (which === 'clr' ? (isNaN(ctx.clr) ? 0 : ctx.clr) : ctx.apex) - target;
  evalShot(v, th, ctx.phi);
  let fa = ctx.eA, fb = sec();
  for (let it = 0; it < 16; it++) {
    const ph = ctx.phi;
    correctPhi();
    if (Math.abs(fa) < TOL && Math.abs(fb) < TOL && Math.abs(ctx.lat) < TOL) return [v, th, true];
    const dv = 0.04, dth = 0.0015;
    evalShot(v + dv, th, ph); const a1 = ctx.eA, b1 = sec();
    evalShot(v, th + dth, ph); const a2 = ctx.eA, b2 = sec();
    const J00 = (a1 - fa) / dv, J01 = (a2 - fa) / dth, J10 = (b1 - fb) / dv, J11 = (b2 - fb) / dth;
    const det = J00 * J11 - J01 * J10;
    let sv, st;
    if (Math.abs(det) < 1e-12) { sv = -fa / (J00 || 1); st = 0; }
    else { sv = -(fa * J11 - fb * J01) / det; st = -(J00 * fb - J10 * fa) / det; }
    // Schrittbegrenzung
    const k = Math.min(1, 10 / (Math.abs(sv) + 1e-9), (12 * DEG) / (Math.abs(st) + 1e-9));
    sv *= k; st *= k;
    const n0 = Math.hypot(fa, fb);
    let accepted = false;
    for (let ls = 0; ls < 5; ls++) {
      const nv = Math.min(Math.max(v + sv, MIN_SPEED), MAX_SPEED), nth = Math.min(Math.max(th + st, -80 * DEG), 85 * DEG);
      evalShot(nv, nth, ctx.phi);
      const na = ctx.eA, nb = sec();
      if (Math.hypot(na, nb) < n0 * (1 - 0.1 * (ls ? 1 : 0)) || ls === 4 || n0 < 0.05) {
        v = nv; th = nth; fa = na; fb = nb; accepted = true; break;
      }
      sv *= 0.5; st *= 0.5;
    }
    if (!accepted) break;
  }
  correctPhi();
  return [v, th, Math.abs(fa) < 0.03 && Math.abs(fb) < 0.03];
}

// ---------------------------------------------------------------- öffentliche API
function makeResult() {
  return {
    ok: false, adjusted: false, reason: '', mode: '',
    vel: new Float64Array(3), spin: new Float64Array(3),
    speed: 0, elevation: 0, azimuth: 0,
    landing: { x: 0, z: 0 }, landingError: 0,
    netClearance: NaN, netX: 0, flightTime: 0, apex: 0,
    requested: { speed: NaN, netClearance: NaN, apexHeight: NaN },
    iterations: 0, ms: 0,
  };
}

const _pp = {};

/**
 * Löst einen Schlag.
 * req = { from: [x,y,z], target: {x,z} | [x,z],
 *         spin: Preset-Name ('topspin'|'flat'|'slice'|'lob'|'drop'|'volley'|'smash'|'serve_flat'|'serve_kick'|'serve_slice')
 *               | { top, side, rifle } in U/min (lokal) | Float-Array Weltdrall (rad/s),
 *         speed? | netClearance? | apexHeight?   (sonst aus Preset + power + stats),
 *         power?: 0..1, stats?: PLAYER_STATS-Eintrag, high?: hohe Lösung im Tempo-Modus,
 *         minClearance?: m, allowAdjust?: true (bei Unmöglichkeit nächstbeste machbare Variante liefern) }
 * Ergebnis (out wird wiederverwendet falls übergeben):
 * { ok, adjusted, reason: ''|'net'|'too_slow'|'no_convergence'|'same_side', mode, vel, spin, speed, elevation, azimuth,
 *   landing:{x,z}, landingError, netClearance (Ballunterkante über Netzband, m), netX, flightTime, apex, iterations, ms }
 */
export function solveShot(req, out = null) {
  const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
  const res = out || makeResult();
  res.ok = false; res.adjusted = false; res.reason = '';
  const from = req.from;
  const tx = Array.isArray(req.target) || ArrayBuffer.isView(req.target) ? req.target[0] : req.target.x;
  const tz = Array.isArray(req.target) || ArrayBuffer.isView(req.target) ? req.target[1] : req.target.z;
  if (!(Number.isFinite(from[0]) && Number.isFinite(from[1]) && Number.isFinite(from[2]) && Number.isFinite(tx) && Number.isFinite(tz))) {
    res.reason = 'invalid'; res.ms = 0; res.iterations = 0;
    return res;
  }
  ctx.fx = from[0]; ctx.fy = Math.max(from[1], R); ctx.fz = from[2];
  _p0[0] = ctx.fx; _p0[1] = ctx.fy; _p0[2] = ctx.fz;
  const dx = tx - ctx.fx, dz = tz - ctx.fz;
  ctx.D = Math.max(Math.hypot(dx, dz), 0.3);
  ctx.ux = dx / ctx.D; ctx.uz = dz / ctx.D;
  ctx.phi = Math.atan2(ctx.ux, ctx.uz);
  ctx.crosses = (ctx.fz > 0 && tz < 0) || (ctx.fz < 0 && tz > 0);
  ctx.dn = ctx.crosses ? ctx.D * (ctx.fz / (ctx.fz - tz)) : 0;
  ctx.netXGuess = ctx.crosses ? ctx.fx + dx * (ctx.fz / (ctx.fz - tz)) : 0;
  ctx.sims = 0;

  // Spin + Modus bestimmen
  let mode, speed = req.speed, clr = req.netClearance, apexH = req.apexHeight;
  let minClr = req.minClearance;
  ctx.worldSpin = null;
  if (typeof req.spin === 'string') {
    const pp = presetParams(req.spin, req.power ?? 0.6, req.stats || null, _pp);
    ctx.top = pp.topRpm * RPM; ctx.side = pp.sideRpm * RPM; ctx.rifle = pp.rifleRpm * RPM;
    if (speed == null && clr == null && apexH == null) { speed = pp.speed; clr = pp.netClearance; apexH = pp.apexHeight; }
    if (minClr == null) minClr = pp.minClearance;
  } else if (req.spin && (Array.isArray(req.spin) || ArrayBuffer.isView(req.spin))) {
    ctx.worldSpin = req.spin;
    ctx.top = 0; ctx.side = 0; ctx.rifle = 0;
    // grobe Topspin-Komponente für die Startschätzung
    ctx.top = req.spin[0] * ctx.uz - req.spin[2] * ctx.ux;
  } else {
    const s = req.spin || {};
    ctx.top = (s.top || 0) * RPM; ctx.side = (s.side || 0) * RPM; ctx.rifle = (s.rifle || 0) * RPM;
  }
  if (minClr == null) minClr = 0.1;
  if (speed != null) mode = 'speed'; else if (clr != null) mode = 'clearance'; else if (apexH != null) mode = 'apex';
  else { mode = 'clearance'; clr = 0.9; }
  res.requested.speed = speed ?? NaN; res.requested.netClearance = clr ?? NaN; res.requested.apexHeight = apexH ?? NaN;
  ctx.tMax = 7;
  const allowAdjust = req.allowAdjust !== false;
  let v = 0, th = 0, ok = false;

  if (mode === 'speed') {
    v = Math.min(Math.max(speed, MIN_SPEED), MAX_SPEED);
    th = solveSpeed(v, !!req.high);
    if (isNaN(th)) {
      res.reason = 'too_slow';
      if (allowAdjust) {
        // nächstbeste Variante: kleinstes Tempo, mit dem das Ziel noch erreichbar ist (+3 %) -> hoher, weicher Ball
        const vMin = minSpeedSearch(v);
        if (vMin > 0) {
          v = Math.min(vMin * 1.03, MAX_SPEED);
          th = solveSpeed(v, false);
          ok = !isNaN(th);
          if (ok && ctx.crosses && !(ctx.clr >= minClr - 1e-3)) ok = false;
        }
        if (!ok) {
          const g = guessClearance(Math.max(minClr, 1.2));
          const r2 = solve2D(g[0], g[1], 'clr', Math.max(minClr, 1.2));
          v = r2[0]; th = r2[1]; ok = r2[2];
        }
        res.adjusted = true;
      }
    } else {
      ok = true;
      if (ctx.crosses && !(ctx.clr >= minClr - 1e-3)) {
        res.reason = 'net';
        ok = false;
        if (allowAdjust) {
          const g = guessClearance(minClr);
          const r2 = solve2D(Math.min(v, g[0] * 1.05), g[1], 'clr', minClr);
          v = r2[0]; th = r2[1]; ok = r2[2]; res.adjusted = true;
        }
      }
    }
  } else if (mode === 'clearance') {
    if (!ctx.crosses) {
      res.reason = 'same_side';
      th = solveSpeed(v = 15, false); ok = !isNaN(th);
    } else {
      const g = guessClearance(clr);
      const r2 = solve2D(g[0], g[1], 'clr', clr);
      v = r2[0]; th = r2[1]; ok = r2[2];
    }
  } else {
    const g = guessApex(apexH);
    const r2 = solve2D(g[0], g[1], 'apex', apexH);
    v = r2[0]; th = r2[1]; ok = r2[2];
  }

  // Letzte Rückfallebene (z. B. Slice/Stopp aus Überkopfhöhe: gewünschter Netzabstand nur mit unendlichem Tempo):
  // Tempo-Modus mit typischen Tempi, Netzabstand >= minClearance.
  if (!ok && allowAdjust && mode !== 'speed') {
    for (let i = 0; i < FALLBACK_SPEEDS.length && !ok; i++) {
      const vTry = FALLBACK_SPEEDS[i], thTry = solveSpeed(vTry, false);
      if (!isNaN(thTry) && (!ctx.crosses || ctx.clr >= minClr - 1e-3)) { v = vTry; th = thTry; ok = true; res.adjusted = true; }
    }
  }

  // Endauswertung mit finalen Parametern
  evalShot(v, th, ctx.phi);
  setVelSpin(v, th, ctx.phi, res.vel, res.spin);
  res.mode = mode;
  res.speed = v; res.elevation = th; res.azimuth = ctx.phi;
  res.landing.x = ctx.lx; res.landing.z = ctx.lz;
  res.landingError = Math.hypot(ctx.lx - tx, ctx.lz - tz);
  res.netClearance = ctx.clr; res.netX = ctx.netX;
  res.flightTime = ctx.t; res.apex = ctx.apex;
  res.iterations = ctx.sims;
  if (ok && res.landingError > 0.03) ok = false;
  if (!ok && !res.reason) res.reason = 'no_convergence';
  res.ok = ok;
  res.ms = (typeof performance !== 'undefined') ? performance.now() - t0 : 0;
  return res;
}

/**
 * Machbarkeitsprüfung: ist der gewünschte Schlag physikalisch möglich?
 * Rückgabe { feasible, reason, solution, alternative: null | { speed, netClearance, target:{x,z} } }.
 * alternative = nächstgelegene machbare Variante (z.B. langsamer, damit der Ball über das Netz geht).
 */
export function checkShot(req) {
  const sol = solveShot(Object.assign({}, req, { allowAdjust: true }));
  const feasible = sol.ok && !sol.adjusted;
  return {
    feasible, reason: feasible ? '' : sol.reason, solution: sol,
    alternative: feasible ? null : (sol.ok ? { speed: sol.speed, netClearance: sol.netClearance, target: { x: sol.landing.x, z: sol.landing.z } } : null),
  };
}

/**
 * Höchstes Tempo, mit dem ein Ziel bei Mindest-Netzabstand erreichbar ist (m/s).
 * MAX_SPEED (72 m/s), wenn selbst das schnellste Tempo noch über das Netz passt; NaN, wenn unmöglich.
 */
export function maxSpeedFor(from, target, spin = 'topspin', minClearance = 0.1, power = 0.6, stats = null) {
  const r = solveShot({ from, target, spin, power, stats, netClearance: minClearance, allowAdjust: false });
  if (r.ok) return r.speed;
  const q = solveShot({ from, target, spin, power, stats, speed: MAX_SPEED, minClearance, allowAdjust: false });
  return q.ok ? MAX_SPEED : NaN;
}

/**
 * Zielpunkt aus Spieler-Eingabe (aim aus Sicht des Schlagenden): lr -1 = links … +1 = rechts, depth -1 = kurz … +1 = lang.
 * side = Seite des Schlagenden (+1/-1). Liefert {x, z} in der gegnerischen Hälfte, passend zum Schlagtyp.
 */
export function aimTarget(side, lr, depth, shot = 'topspin', out = {}) {
  const ranges = {
    topspin: [6.8, 10.9], flat: [7.2, 11.0], slice: [6.0, 10.6], lob: [8.4, 11.0],
    drop: [1.4, 3.6], volley: [5.5, 10.6], smash: [5.5, 10.4],
  };
  const r = ranges[shot] || ranges.topspin;
  const d = lerp(r[0], r[1], (Math.max(-1, Math.min(1, depth)) + 1) * 0.5);
  const xMax = shot === 'drop' ? 3.4 : 3.55;
  out.x = side * Math.max(-1, Math.min(1, lr)) * xMax;   // rechts des Spielers auf Seite s = +s·X
  out.z = -side * d;
  return out;
}

/**
 * Aufschlag-Zielpunkt im korrekten Feld. lr aus Sicht des Aufschlägers (-1 links … +1 rechts), depth 0..1 (1 = an der Linie).
 */
export function serveTarget(serverSide, box, lr, depth = 0.85, out = {}) {
  const rect = serviceBoxRect(serverSide, box);
  const inset = 0.3;
  const x0 = rect.xMin + inset, x1 = rect.xMax - inset;
  const t = (Math.max(-1, Math.min(1, lr)) * serverSide + 1) * 0.5; // rechts des Aufschlägers = +s·X
  out.x = lerp(x0, x1, t);
  out.z = -serverSide * lerp(3.6, COURT.serviceLineZ - 0.35, clamp01(depth));
  return out;
}

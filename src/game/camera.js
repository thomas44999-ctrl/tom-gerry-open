// Kameras (ARCHITECTURE §4.3, §8): TV-Übertragungskamera (BroadcastCamera), Kamera-Posen, kinematische
// Einstellungen (Spline/Dolly, Orbit, Kran, Verfolgung, Schärfeverlagerung, Handkamera) und deren Abfolge
// (ShotSequence mit Schnitt / weicher Überblendung / Abblende). Dazu Geometrie-Schutz: Kameras landen nie
// in Tribünen, Mauern, Dach, Netz oder Schiedsrichterstuhl.
import { vec3, clamp, lerp, catmullRom, DEG, noise3, saturate } from '../core/math.js';
import { COURT } from '../sim/court.js';
import { LAYOUT, sdRoundRect, roofUnderY } from '../world/layout.js';

const HL = COURT.halfLength;

// ============================================================================ Kamera-Objekt & Pose

/** Neues Kamera-Objekt gemäß §4.3. */
export function createCamera(opts = {}) {
  return {
    position: vec3.fromValues(0, 8, 21), target: vec3.fromValues(0, 0, -2), up: [0, 1, 0],
    fov: opts.fov ?? 0.75, near: opts.near ?? 0.1, far: opts.far ?? 900, dof: null,
    _dof: { focus: 10, aperture: 0 },
  };
}

/** Kamera-Zustand für Mischungen: Position, Ziel, fov (vertikal, rad), Rollwinkel, Schärfe (Abstand, Blende). */
export class CamPose {
  constructor() {
    this.pos = vec3.fromValues(0, 8, 21); this.tgt = vec3.fromValues(0, 0, 0);
    this.fov = 0.75; this.roll = 0; this.focus = 10; this.aperture = 0;
  }
  set(pos, tgt, fov) {
    if (pos) vec3.copy(this.pos, pos);
    if (tgt) vec3.copy(this.tgt, tgt);
    if (fov !== undefined) this.fov = fov;
    return this;
  }
  copy(o) {
    vec3.copy(this.pos, o.pos); vec3.copy(this.tgt, o.tgt);
    this.fov = o.fov; this.roll = o.roll; this.focus = o.focus; this.aperture = o.aperture;
    return this;
  }
  /** this = a + (b - a) * t (Ziel wird über Blickrichtung gemischt, damit Schwenks nicht "durchsacken"). */
  lerp(a, b, t) {
    for (let k = 0; k < 3; k++) this.pos[k] = a.pos[k] + (b.pos[k] - a.pos[k]) * t;
    // Blickrichtungen mischen (Länge interpolieren) -> ruhige Drehung auch bei sehr verschiedenen Zielabständen
    const ax = a.tgt[0] - a.pos[0], ay = a.tgt[1] - a.pos[1], az = a.tgt[2] - a.pos[2];
    const bx = b.tgt[0] - b.pos[0], by = b.tgt[1] - b.pos[1], bz = b.tgt[2] - b.pos[2];
    const la = Math.hypot(ax, ay, az) || 1, lb = Math.hypot(bx, by, bz) || 1;
    let dx = ax / la + (bx / lb - ax / la) * t, dy = ay / la + (by / lb - ay / la) * t, dz = az / la + (bz / lb - az / la) * t;
    const ld = Math.hypot(dx, dy, dz) || 1, L = la + (lb - la) * t;
    dx *= L / ld; dy *= L / ld; dz *= L / ld;
    this.tgt[0] = this.pos[0] + dx; this.tgt[1] = this.pos[1] + dy; this.tgt[2] = this.pos[2] + dz;
    this.fov = a.fov + (b.fov - a.fov) * t;
    this.roll = a.roll + (b.roll - a.roll) * t;
    this.focus = a.focus + (b.focus - a.focus) * t;
    this.aperture = a.aperture + (b.aperture - a.aperture) * t;
    return this;
  }
}

/** Pose auf ein Kamera-Objekt übertragen (Rollwinkel -> up-Vektor, Schärfe -> camera.dof). */
export function applyPose(cam, pose, dofEnabled = true) {
  vec3.copy(cam.position, pose.pos);
  vec3.copy(cam.target, pose.tgt);
  cam.fov = pose.fov;
  if (!cam.up) cam.up = [0, 1, 0];
  if (Math.abs(pose.roll) > 1e-5) {
    let fx = pose.tgt[0] - pose.pos[0], fy = pose.tgt[1] - pose.pos[1], fz = pose.tgt[2] - pose.pos[2];
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    // r = f x Y, u = r x f
    let rx = -fz, rz = fx; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
    const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
    const c = Math.cos(pose.roll), sn = Math.sin(pose.roll);
    cam.up[0] = ux * c + rx * sn; cam.up[1] = uy * c; cam.up[2] = uz * c + rz * sn;
  } else { cam.up[0] = 0; cam.up[1] = 1; cam.up[2] = 0; }
  if (dofEnabled && pose.aperture > 0.01) {
    const d = cam._dof || (cam._dof = { focus: 10, aperture: 0 });
    d.focus = pose.focus; d.aperture = pose.aperture;
    cam.dof = d;
  } else cam.dof = null;
  return cam;
}

// ============================================================================ Geometrie-Schutz

/** Mindesthöhe einer Kamera über (x, z): Boden, Mauer, Tribünen (+Zuschauerköpfe), Gebäude, Umgebung. */
export function minCameraY(x, z) {
  const L = LAYOUT;
  const d = sdRoundRect(x, z, L.wallX, L.wallZ, L.cornerR);      // > 0: hinter der Mauer-Innenkante
  if (d < -0.05) {
    let y = 0.1;
    // Netz (inkl. Pfosten) und Schiedsrichterstuhl
    if (Math.abs(z) < 0.4 && Math.abs(x) < 6.7) y = Math.max(y, 1.35);
    if (x < -6.4 && x > -8.3 && Math.abs(z) < 0.95) y = Math.max(y, 3.55);
    return y;
  }
  // Stirnseite (N/S-Pavillon) nur im geraden Mittelstück, sonst Längstribüne
  const prof = Math.abs(x) <= L.wallX - L.cornerR ? L.end : L.grand;
  if (d < L.wallThick + 0.05) return prof.wallH + 0.45;
  if (d < prof.depthC) {
    const k = Math.floor((d - L.wallThick) / L.rowDepth);
    return prof.floor0 + Math.max(0, k) * prof.rise + 1.9;
  }
  const R = L.roof;
  if (sdRoundRect(x, z, R.outerX, R.outerZ, R.outerR) < 1.0) return R.yOut + R.thick + 2.0;   // Umgang/Gebäude unter dem Dach
  return 14;    // Umgebung (Bäume, Plätze)
}

/** Kamera-Position aus der Geometrie heraushalten (in place). Gibt true zurück, wenn korrigiert wurde. */
export function safeCameraPos(p) {
  let moved = false;
  const L = LAYOUT, R = L.roof;
  const minY = minCameraY(p[0], p[2]);
  if (p[1] < minY) { p[1] = minY; moved = true; }
  // Dachring: entweder darunter oder darüber
  const dIn = sdRoundRect(p[0], p[2], R.innerX, R.innerZ, R.innerR);
  const dOut = sdRoundRect(p[0], p[2], R.outerX, R.outerZ, R.outerR);
  if (dIn > -0.8 && dOut < 0.8) {
    // Fahnen auf der Innenblende (bis ~4.5 m über dem Dach) -> dort höher ausweichen
    const under = roofUnderY(p[0], p[2]) - 0.7, over = dIn < 2.5 ? R.yIn + R.thick + 6.5 : R.yOut + R.thick + 1.6;
    if (p[1] > under && p[1] < over) {
      p[1] = (p[1] - under < over - p[1] && under >= minY) ? under : over;
      moved = true;
    }
  }
  return moved;
}

/**
 * Kamera auf dem Strahl zum Subjekt heranziehen, bis sie frei steht (Netz, Stuhl, Mauer, Tribüne).
 * Hält das Subjekt im Bild statt die Kamera anzuheben. Gibt true zurück, wenn verschoben wurde.
 */
export function pullIn(p, subj, minDist = 0.9) {
  let moved = false;
  for (let k = 0; k < 12; k++) {
    if (minCameraY(p[0], p[2]) <= p[1] + 1e-3) break;
    const dx = p[0] - subj[0], dz = p[2] - subj[2], d = Math.hypot(dx, dz);
    if (d <= minDist) break;
    const f = Math.max(minDist / d, 0.86);
    p[0] = subj[0] + dx * f; p[2] = subj[2] + dz * f;
    moved = true;
  }
  return moved;
}

/** Abstand eines Punktes zu Spielern (vertikale Kapseln) einhalten: schiebt horizontal weg. */
export function keepAwayFromPlayers(p, players, minDist = 0.75) {
  if (!players) return false;
  let moved = false;
  for (const pl of players) {
    if (!pl || !pl.pos) continue;
    if (p[1] > 2.3) continue;
    const dx = p[0] - pl.pos[0], dz = p[2] - pl.pos[2];
    const d = Math.hypot(dx, dz);
    if (d < minDist) {
      const k = d > 1e-4 ? minDist / d : 0;
      if (k) { p[0] = pl.pos[0] + dx * k; p[2] = pl.pos[2] + dz * k; } else p[2] += minDist;
      moved = true;
    }
  }
  return moved;
}

// ============================================================================ Hilfen

const HEAD_H = { tom: 1.08, gerry: 1.0 };
/** Augen-/Kopfhöhe eines Spielers (m) nach id. */
export function headHeightOf(p) { return (p && HEAD_H[p.id]) || 1.65; }

/**
 * Kopfposition (Welt) eines Spielers: bevorzugt aus der Figur (getBoneWorld / skeleton), sonst Position + Kopfhöhe.
 */
export function headPosOf(view, i, out) {
  const c = view && view.characters ? view.characters[i] : null;
  if (c) {
    try {
      if (typeof c.getBoneWorld === 'function') { const r = c.getBoneWorld('head', out); if (r !== false && isFinite(out[1]) && out[1] > 0.3) return out; }
      if (typeof c.getHeadWorld === 'function') { c.getHeadWorld(out); if (isFinite(out[1]) && out[1] > 0.3) return out; }
      if (c.skeleton && c.model && typeof c.skeleton.getWorldPos === 'function') { c.skeleton.getWorldPos('head', out, c.model); if (out[1] > 0.3) return out; }
    } catch (e) { /* Fallback unten */ }
  }
  const p = view && view.players ? view.players[i] : null;
  if (!p) return vec3.set(out, 0, 1.6, 0);
  out[0] = p.pos[0]; out[1] = (p.pos[1] || 0) + headHeightOf(p); out[2] = p.pos[2];
  return out;
}

/**
 * Kritisch gedämpfte Feder (skalar), exakte Lösung pro Schritt (stabil bei jedem dt). Anders als smoothDamp
 * ohne "Anhalten am Ziel" -> Geschwindigkeit bleibt stetig (kein Ruck, wenn ein bewegtes Ziel eingeholt wird).
 * smoothTime ≈ Zeit bis ~80 % erreicht; maxSpeed begrenzt die Auslenkung (wie smoothDamp).
 */
export class Spring {
  constructor(v = 0) { this.v = v; this.s = { v: 0 }; }
  update(target, smoothTime, dt, maxSpeed = Infinity) {
    if (dt <= 0) return this.v;
    const w = 2 / Math.max(1e-4, smoothTime);
    let d = this.v - target;
    const md = maxSpeed * smoothTime;
    if (d > md) d = md; else if (d < -md) d = -md;
    const tmp = (this.s.v + w * d) * dt, e = Math.exp(-w * dt);
    this.v = target + (d + tmp) * e;
    this.s.v = (this.s.v - w * tmp) * e;
    return this.v;
  }
  snap(v) { this.v = v; this.s.v = 0; return v; }
}

/** Zentriertes, glattes Rauschen (-0.5..0.5) mit 2 Oktaven. */
function wobble(t, seed) {
  return (noise3(t, seed, 0.37) - 0.5) * 0.7 + (noise3(t * 2.13, seed + 17.1, 4.1) - 0.5) * 0.3;
}

// ============================================================================ TV-Übertragungskamera

/**
 * Klassische TV-Tennisperspektive hinter/über der Grundlinie des menschlichen Spielers.
 * - Seite `side` (+1: Kamera bei z > 0). Wechselt die Seite, schneidet die Kamera hart (snap).
 * - Bildaufbau per Löser: nahe Grundlinie/Spielerfüße unten, ferner Spieler (Kopf + Luft) und Ball (Lob) oben;
 *   fov (Zoom) und Neigung werden daraus bestimmt, kritisch gedämpft geglättet. Horizont bleibt waagerecht.
 * - Seitliche Verfolgung (Kamerafahrt + Schwenk) mit Ball-Vorausschau, Dolly mit der Tiefe des nahen Spielers,
 *   Aufschlag-Bildaufbau (etwas näher, zur Seite des Aufschlägers).
 */
export class BroadcastCamera {
  constructor(o = {}) {
    this.side = o.side ?? 1;
    // tiefer und näher als klassisches TV-Tennis (8.4 / 10.4): Chibi-Figuren bleiben groß und lesbar
    this.height = o.height ?? 5.2;        // m über dem Boden
    this.back = o.back ?? 6.4;            // m hinter der Grundlinie
    this.fovMin = o.fovMin ?? 36 * DEG;
    this.fovMax = o.fovMax ?? 54 * DEG;
    this.marginBottom = o.marginBottom ?? 0.8;   // NDC-Abstand der unteren Bildkante (Füße nah)
    this.marginTop = o.marginTop ?? 0.64;         // NDC der oberen Grenze (Kopf fern / Ball)
    this.marginSide = o.marginSide ?? 0.86;
    this.lookAhead = o.lookAhead ?? 0.3;          // s Ball-Vorausschau
    this.aspect = 16 / 9;
    this.pose = new CamPose();
    this.trauma = 0;
    this.time = 0;
    this._snap = true;
    this._cx = new Spring(); this._ax = new Spring(); this._back = new Spring(this.back);
    this._pitch = new Spring(-0.4); this._fov = new Spring(44 * DEG); this._h = new Spring(this.height);
    this._ballY = new Spring(1);
    this._pre = { cx: 0, ax: 0, back: this.back, h: this.height, pitch: -0.4, fov: 44 * DEG };
    this.debug = { fovNeed: 0, pitch: 0 };
  }

  /** Kameraende setzen (+1/-1). Ein Wechsel erzeugt einen sauberen Schnitt. */
  setSide(s) { s = s < 0 ? -1 : 1; if (s !== this.side) { this.side = s; this._snap = true; } }
  /** Nächstes Update ohne Glättung (Schnitt). */
  cut() { this._snap = true; }
  /** Erschütterung (0..1, addiert, klingt ab). */
  shake(amount = 0.5) { this.trauma = Math.min(1, this.trauma + amount); }

  /**
   * view = { phase, ball: {pos, vel, visible}, players: [{pos, side, id}], humanIndex?, humanSide?, server? }
   */
  update(dt, view) {
    this.time += dt;
    const s = this.side;
    const P = (view && view.players) || [];
    // naher Spieler = auf Kameraseite
    let ni = 0;
    if (P.length > 1) ni = (P[0].side === s) ? 0 : (P[1].side === s ? 1 : (view.humanIndex ?? 0));
    const near = P[ni], far = P[1 - ni];
    const nx = near ? near.pos[0] * s : 0;
    // Tiefe des nahen Spielers mit Vorausschau, wenn er nach hinten läuft (Füße bleiben im Bild)
    const nz = near ? near.pos[2] * s + Math.max(0, (near.vel ? near.vel[2] * s : 0) * 0.45) : HL;
    const fx = far ? far.pos[0] * s : 0, fz = far ? far.pos[2] * s : -HL;
    const hF = headHeightOf(far) + 0.35;
    const ph = view ? view.phase : 'rally';
    const serving = ph === 'pre_serve' || ph === 'serve';
    const srvIdx = view && view.server != null ? view.server : (view && view.state ? view.state.server : null);

    // ---- Ball (Vorausschau, auf den Platzbereich begrenzt)
    const B = view && view.ball;
    const ballOn = !!(B && B.visible !== false && B.pos && !serving);
    let bx = 0, by = 1, bz = 0;
    if (ballOn) {
      const v = B.vel || [0, 0, 0], la = this.lookAhead;
      bx = clamp((B.pos[0] + v[0] * la) * s, -7.0, 7.0);
      bz = clamp((B.pos[2] + v[2] * la) * s, -15, 15);
      by = B.pos[1];
    }

    // ---- seitlicher Fokus
    let focusX;
    if (serving && srvIdx != null && P[srvIdx] && P[1 - srvIdx]) {
      const sx = P[srvIdx].pos[0] * s, rx = P[1 - srvIdx].pos[0] * s;
      focusX = 0.62 * sx + 0.38 * rx;
    } else if (ballOn) focusX = 0.5 * bx + 0.3 * nx + 0.2 * fx;
    else focusX = 0.55 * nx + 0.45 * fx;
    const cxT = clamp(0.38 * focusX, -2.4, 2.4);
    const axT = clamp(0.8 * focusX, -3.6, 3.6);

    // ---- Dolly: tiefer naher Spieler -> zurück; Aufschlag des nahen Spielers -> etwas näher
    let backT = this.back + Math.max(0, nz - 12.4) * 0.75;
    if (serving) backT -= (srvIdx === ni ? 0.7 : 0.35);
    backT = clamp(backT, this.back - 1.0, this.back + 3.2);
    const hT = this.height + (backT - this.back) * 0.12;

    // ---- Bildaufbau (Löser) für die Ziel-Kameraposition
    const camX = cxT, camY = hT, camZ = HL + backT;
    const aimZ = -2.0;
    const fdx = axT - camX, fdz = aimZ - camZ, fl = Math.hypot(fdx, fdz);
    const ux = fdx / fl, uz = fdz / fl;                            // Blickrichtung (horizontal)
    // Vorwärts-/Seitenabstand eines Bodenpunkts relativ zur Kamera (Blick horizontal (ux, uz))
    // unten: Boden kurz vor der nahen Grundlinie bzw. die Füße des nahen Spielers (wenn tiefer)
    const deep = nz + 0.35 > HL - 0.6;
    const zb = deep ? nz + 0.35 : HL - 0.6, xb = deep ? nx : 0;
    const eBot = Math.atan2(-camY, Math.max(0.5, (xb - camX) * ux + (zb - camZ) * uz));
    // oben: Kopf des fernen Spielers, ferne Grundlinie (+Luft), Ball (bei Lobs begrenzt)
    const fzc = Math.min(fz, -0.5);
    let eTop = Math.atan2(hF - camY, (fx - camX) * ux + (fzc - camZ) * uz);
    eTop = Math.max(eTop, Math.atan2(1.4 - camY, (0 - camX) * ux + (-HL - 0.6 - camZ) * uz));
    if (ballOn) {
      const byS = this._ballY.update(Math.min(by + 0.5, 6.5), 0.35, dt);
      const fb = (bx - camX) * ux + (bz - camZ) * uz;
      if (fb > 2) eTop = Math.max(eTop, Math.atan2(byS - camY, fb));
    } else this._ballY.snap(1);
    // vertikal benötigtes T = tan(fov/2): atan(mT T) + atan(mB T) = eTop - eBot
    const span = Math.max(0.05, eTop - eBot);
    let lo = 0.05, hi = 2.0;
    for (let k = 0; k < 24; k++) {
      const m = 0.5 * (lo + hi);
      if (Math.atan(this.marginTop * m) + Math.atan(this.marginBottom * m) < span) lo = m; else hi = m;
    }
    let T = hi;
    // horizontal: beide Spieler (±0.7 m) im Bild
    const asp = Math.max(0.4, this.aspect || 16 / 9);
    const pitchGuess = eBot + Math.atan(this.marginBottom * T);
    const cp = Math.cos(pitchGuess), sp = Math.sin(pitchGuess);
    for (let k = 0; k < 2; k++) {
      const x = k ? fx : nx, z = k ? fz : nz;
      const f = (x - camX) * ux + (z - camZ) * uz, l = Math.abs((x - camX) * -uz + (z - camZ) * ux) + 0.7;
      const zc = f * cp + (1.0 - camY) * sp;
      if (zc > 1) T = Math.max(T, l / (zc * asp * this.marginSide));
    }
    const Tmin = Math.tan(this.fovMin / 2), Tmax = Math.tan(this.fovMax / 2);
    const Tc = clamp(T, Tmin, Tmax);
    let pitchT;
    if (T <= Tmax) pitchT = eBot + Math.atan(this.marginBottom * Tc);           // unten verankert, Rest oben
    else pitchT = 0.5 * ((eBot + Math.atan(this.marginBottom * Tc)) + (eTop - Math.atan(this.marginTop * Tc)));
    const fovT = 2 * Math.atan(Tc);
    this.debug.fovNeed = 2 * Math.atan(T) / DEG; this.debug.pitch = pitchT / DEG;

    // ---- Vorfilter (exponentiell): Sprünge der Zielgrößen werden zu Rampen -> stetige Beschleunigung der Federn
    const F = this._pre, kf = this._snap ? 1 : 1 - Math.exp(-dt / 0.22);
    F.cx += (cxT - F.cx) * kf; F.ax += (axT - F.ax) * kf; F.back += (backT - F.back) * kf;
    F.h += (hT - F.h) * kf; F.pitch += (pitchT - F.pitch) * kf; F.fov += (fovT - F.fov) * kf;
    // ---- Glätten (kritisch gedämpft)
    if (this._snap || dt <= 0 && !this._init) {
      this._cx.snap(cxT); this._ax.snap(axT); this._back.snap(backT); this._h.snap(hT);
      this._pitch.snap(pitchT); this._fov.snap(fovT);
      this._snap = false; this._init = true;
    } else {
      this._cx.update(F.cx, 0.95, dt, 3.0);
      this._ax.update(F.ax, 0.55, dt, 6.0);
      this._back.update(F.back, 0.85, dt, 2.5);
      this._h.update(F.h, 1.2, dt, 1.0);
      this._pitch.update(F.pitch, 0.42, dt, 0.7);
      this._fov.update(F.fov, 0.75, dt, 0.35);
    }

    // ---- Pose (lokal -> Welt)
    const pose = this.pose;
    const px = this._cx.v, py = this._h.v, pz = HL + this._back.v;
    const tx = this._ax.v, tz = aimZ;
    const dist = Math.hypot(tx - px, tz - pz);
    const ty = py + Math.tan(this._pitch.v) * dist;
    vec3.set(pose.pos, px * s, py, pz * s);
    vec3.set(pose.tgt, tx * s, ty, tz * s);
    pose.fov = this._fov.v; pose.roll = 0; pose.aperture = 0; pose.focus = dist;

    // ---- Erschütterung (Schmetterball): nur Position/Ziel, kein Rollen (Horizont bleibt waagerecht)
    if (this.trauma > 0.001) {
      const a = this.trauma * this.trauma, t = this.time * 17;
      pose.pos[0] += wobble(t, 1) * 0.16 * a; pose.pos[1] += wobble(t, 2) * 0.12 * a;
      pose.tgt[0] += wobble(t, 3) * 0.3 * a; pose.tgt[1] += wobble(t, 4) * 0.25 * a;
      this.trauma = Math.max(0, this.trauma - dt * 1.4);
    }
    return pose;
  }
}

// ============================================================================ Kinematische Einstellungen

export const EASE = {
  linear: (t) => t,
  inOut: (t) => t * t * (3 - 2 * t),
  inOut2: (t) => t * t * t * (t * (t * 6 - 15) + 10),
  out: (t) => 1 - (1 - t) * (1 - t) * (1 - t),
  in: (t) => t * t,
  // langsamer Start, sanftes Auslaufen (für Kranfahrten)
  glide: (t) => { const a = t * t * (3 - 2 * t); return 0.35 * t + 0.65 * a; },
};
const easeOf = (e) => (typeof e === 'function' ? e : EASE[e] || EASE.inOut);

const _v1 = vec3.create();
const resolve = (v, ctx, out) => (typeof v === 'function' ? v(ctx, out) : vec3.copy(out, v));

/**
 * Basis einer Einstellung. opts: { name, dur, trans: 'cut'|'blend'|'dip' | { type, time }, cue, ease,
 *   fov, roll, handheld (m Amplitude), dof: { aperture, focus?: number | (ctx)=>vec3 (Schärfe auf Subjekt),
 *   rack?: [fromDist|null, toSubject…] }, begin?(ctx, shot), update?(dt, ctx, shot) }
 * Unterklassen implementieren frame(u, t, ctx, pose) (u = geglättete 0..1-Zeit).
 */
let _shotSeed = 3.7;
export class Shot {
  constructor(o = {}) {
    this.o = o;
    this.name = o.name || 'shot';
    this.dur = o.dur ?? 4;
    const tr = o.trans || 'cut';
    this.trans = typeof tr === 'string' ? { type: tr, time: tr === 'blend' ? 1.0 : tr === 'dip' ? 0.7 : 0 } : { type: tr.type || 'cut', time: tr.time ?? 0.8 };
    this.cue = o.cue || null;
    this.ease = easeOf(o.ease || 'inOut');
    this.seed = o.seed ?? (_shotSeed = (_shotSeed + 7.31) % 97);
  }
  begin(ctx) { if (this.o.begin) this.o.begin(ctx, this); }
  update(dt, ctx) { if (this.o.update) this.o.update(dt, ctx, this); }
  end(ctx) { if (this.o.end) this.o.end(ctx, this); }
  /** Pose zur lokalen Zeit t (s) berechnen. */
  eval(t, ctx, pose) {
    const u = this.ease(saturate(t / Math.max(1e-3, this.dur)));
    pose.roll = 0; pose.aperture = 0; pose.fov = 0.75;
    this.frame(u, t, ctx, pose);
    const o = this.o;
    if (o.fov !== undefined) pose.fov = Array.isArray(o.fov) ? lerp(o.fov[0], o.fov[1], u) : o.fov;
    if (o.roll) pose.roll = Array.isArray(o.roll) ? lerp(o.roll[0], o.roll[1], u) : o.roll;
    if (o.handheld) this._handheld(t, pose, o.handheld);
    if (o.dof) this._dof(u, t, ctx, pose, o.dof);
    if (o.post) o.post(u, t, ctx, pose, this);
    return pose;
  }
  frame(u, t, ctx, pose) { /* Unterklassen */ }
  _handheld(t, pose, amp) {
    const f = 0.55;
    pose.pos[0] += wobble(t * f, this.seed + 1) * amp; pose.pos[1] += wobble(t * f, this.seed + 2) * amp * 0.7;
    pose.pos[2] += wobble(t * f, this.seed + 3) * amp;
    pose.tgt[0] += wobble(t * f * 1.2, this.seed + 4) * amp * 1.4; pose.tgt[1] += wobble(t * f * 1.2, this.seed + 5) * amp * 1.0;
    pose.roll += wobble(t * f * 0.8, this.seed + 6) * amp * 0.25;
  }
  _distTo(f, ctx, pose) {
    if (typeof f === 'number') return f;
    if (typeof f === 'function') { f(ctx, _v1); return vec3.distance(pose.pos, _v1); }
    if (f && f.length === 3) return vec3.distance(pose.pos, f);
    return vec3.distance(pose.pos, pose.tgt);
  }
  _dof(u, t, ctx, pose, d) {
    pose.aperture = Array.isArray(d.aperture) ? lerp(d.aperture[0], d.aperture[1], u) : (d.aperture ?? 0.5);
    if (d.rack) {
      // Schärfeverlagerung: rack = [vonFokus, nachFokus, t0, t1] (Abstand | Punkt | (ctx,out)=>Punkt; t in s lokaler Zeit)
      const r = d.rack, t0 = r[2] ?? this.dur * 0.3, t1 = r[3] ?? this.dur * 0.6;
      const k = EASE.inOut(saturate((t - t0) / Math.max(1e-3, t1 - t0)));
      pose.focus = lerp(this._distTo(r[0], ctx, pose), this._distTo(r[1], ctx, pose), k);
    } else pose.focus = this._distTo(d.focus, ctx, pose);
  }
}

/** Kamerafahrt entlang Catmull-Rom-Splines: pos: [vec3…], tgt: [vec3…] (oder ein Punkt / Funktion). */
export class SplineShot extends Shot {
  frame(u, t, ctx, pose) {
    const o = this.o;
    if (typeof o.pos === 'function') o.pos(ctx, pose.pos, u); else if (o.pos.length > 1 && o.pos[0].length) catmullRom(pose.pos, o.pos, u); else vec3.copy(pose.pos, o.pos);
    if (typeof o.tgt === 'function') o.tgt(ctx, pose.tgt, u); else if (o.tgt.length > 1 && o.tgt[0].length) catmullRom(pose.tgt, o.tgt, u); else vec3.copy(pose.tgt, o.tgt);
  }
}

/** Dolly/Kran zwischen zwei Posen: from/to = { pos, tgt, fov? }. */
export function dolly(o) {
  const fov = o.fov ?? (o.from.fov !== undefined && o.to.fov !== undefined ? [o.from.fov, o.to.fov] : undefined);
  return new SplineShot({ ...o, pos: [o.from.pos, o.to.pos], tgt: [o.from.tgt, o.to.tgt], fov });
}
/** Kranfahrt: wie dolly, aber mit "glide"-Kurve (sanfter Anlauf, langes Ausschweben). */
export function crane(o) { return dolly({ ease: 'glide', ...o }); }
/** Spline-Fahrt: pos/tgt als Stützpunktlisten. */
export function spline(o) { return new SplineShot(o); }

/** Orbit um ein (ggf. bewegtes) Zentrum: radius/height/angle/look als Zahl oder [von, bis]. */
export class OrbitShot extends Shot {
  constructor(o) { super(o); this._c = vec3.create(); }
  frame(u, t, ctx, pose) {
    const o = this.o;
    const c = resolve(o.center || [0, 0, 0], ctx, this._c);
    const r = Array.isArray(o.radius) ? lerp(o.radius[0], o.radius[1], u) : (o.radius ?? 10);
    const h = Array.isArray(o.height) ? lerp(o.height[0], o.height[1], u) : (o.height ?? 2);
    const a = Array.isArray(o.angle) ? lerp(o.angle[0], o.angle[1], u) : (o.angle ?? 0);
    const ly = Array.isArray(o.look) ? lerp(o.look[0], o.look[1], u) : (o.look ?? 0);
    vec3.set(pose.pos, c[0] + Math.sin(a) * r, c[1] + h, c[2] + Math.cos(a) * r);
    vec3.set(pose.tgt, c[0], c[1] + ly, c[2]);
    if (o.safe) pullIn(pose.pos, c);
  }
}
export function orbit(o) { return new OrbitShot(o); }

/**
 * Verfolgung eines bewegten Subjekts mit gedämpfter Kamera: subject(ctx, out) -> vec3;
 * place(ctx, subject, u, outPos, outTgt) setzt Wunsch-Position/-Ziel; smooth (s) Glättung der Position.
 */
export class TrackShot extends Shot {
  constructor(o) {
    super(o);
    this._s = vec3.create(); this._p = vec3.create(); this._t = vec3.create();
    this._sp = [new Spring(), new Spring(), new Spring()]; this._st = [new Spring(), new Spring(), new Spring()];
    this._init = false; this._lastT = 0;
  }
  begin(ctx) { this._init = false; this._lastT = 0; super.begin(ctx); }
  frame(u, t, ctx, pose) {
    const o = this.o;
    o.subject(ctx, this._s);
    o.place(ctx, this._s, u, this._p, this._t, this);
    const dt = Math.max(0, t - this._lastT); this._lastT = t;
    const sp = o.smooth ?? 0.5, st = o.smoothTarget ?? sp * 0.6;
    for (let k = 0; k < 3; k++) {
      if (!this._init) { this._sp[k].snap(this._p[k]); this._st[k].snap(this._t[k]); }
      else { this._sp[k].update(this._p[k], sp, dt); this._st[k].update(this._t[k], st, dt); }
      pose.pos[k] = this._sp[k].v; pose.tgt[k] = this._st[k].v;
    }
    this._init = true;
  }
}
export function track(o) { return new TrackShot(o); }

/** Beliebige Einstellung: frame(u, t, ctx, pose). */
export function custom(o) { const s = new Shot(o); s.frame = o.frame; return s; }

// ============================================================================ Abfolge von Einstellungen

/**
 * Spielt Shots nacheinander ab (optional in Schleife). Übergänge je Shot (trans des EINTRETENDEN Shots):
 * 'cut' (hart), 'blend' (Kamerafahrt von der alten in die neue Einstellung), 'dip' (Abblende über Schwarz).
 * update() liefert die Pose; `fade` (0..1) = Abblendgrad für die Darstellung.
 */
export class ShotSequence {
  constructor(shots, o = {}) {
    this.shots = shots;
    this.loop = !!o.loop;
    this.name = o.name || 'seq';
    this.index = -1; this.t = 0; this.done = false; this.fade = 0;
    this.prev = null; this.prevT = 0; this.blendT = 0;
    this._a = new CamPose(); this._b = new CamPose();
    this.onShot = o.onShot || null;
    this.entryDip = !!o.entryDip;
    this.time = 0;
  }
  get shot() { return this.shots[this.index] || null; }
  start(ctx) { this._enter(0, ctx, true); return this; }
  _enter(i, ctx, first = false) {
    const old = this.shot;
    if (old) old.end(ctx);
    this.prev = first ? null : old; this.prevT = this.t;
    this.index = i; this.t = 0; this.blendT = 0;
    const sh = this.shots[i];
    sh.begin(ctx);
    if (this.onShot) this.onShot(sh, i);
  }
  /** Nächste Einstellung (z.B. Teil-Überspringen). */
  next(ctx) {
    if (this.index + 1 < this.shots.length) this._enter(this.index + 1, ctx);
    else if (this.loop) this._enter(0, ctx);
    else this.done = true;
  }
  update(dt, ctx, out) {
    if (this.done || this.index < 0) return out;
    this.time += dt;
    let sh = this.shot;
    sh.update(dt, ctx);
    this.t += dt;
    if (this.t >= sh.dur) {
      const ni = this.index + 1;
      if (ni < this.shots.length || this.loop) { this._enter(ni % this.shots.length, ctx); sh = this.shot; sh.update(0, ctx); }
      else { this.t = sh.dur; this.done = true; }
    }
    sh.eval(this.t, ctx, out);
    // Überblendung aus der vorigen Einstellung
    const tr = sh.trans;
    if (this.prev && tr.type === 'blend' && this.t < tr.time) {
      this.prevT += dt;
      this.prev.eval(Math.min(this.prevT, this.prev.dur + 2), ctx, this._a);
      this._b.copy(out);
      out.lerp(this._a, this._b, EASE.inOut2(saturate(this.t / tr.time)));
    }
    // Abblende: Ende der aktuellen (wenn der nächste Shot 'dip' hat) und Anfang (wenn dieser 'dip' hat)
    let f = 0;
    if (tr.type === 'dip' && (this.prev || this.entryDip)) f = Math.max(f, 1 - saturate(this.t / (tr.time * 0.5)));
    const nx = this.index + 1 < this.shots.length ? this.shots[this.index + 1] : (this.loop ? this.shots[0] : null);
    if (nx && nx.trans.type === 'dip') f = Math.max(f, saturate((this.t - (sh.dur - nx.trans.time * 0.5)) / (nx.trans.time * 0.5)));
    this.fade = f;
    return out;
  }
}

/**
 * Kinematische Kamera: spielt eine Liste von Shots (spline/dolly/crane/orbit/track/custom) ab und schreibt in ein
 * Kamera-Objekt. Für eigene Einsätze außerhalb der Regie (z.B. Menü-Hintergründe).
 *   const cc = new CinematicCamera(); cc.play([crane({...}), orbit({...})], { loop: true });
 *   cc.update(dt, ctx); applyPose(camera, cc.pose)   // bzw. cc.apply(camera)
 */
export class CinematicCamera {
  constructor() { this.pose = new CamPose(); this.seq = null; }
  play(shots, opts = {}, ctx = {}) { this.seq = new ShotSequence(shots, opts).start(ctx); return this; }
  update(dt, ctx = {}) { if (this.seq) this.seq.update(dt, ctx, this.pose); return this.pose; }
  apply(camera) { return applyPose(camera, this.pose); }
  stop() { this.seq = null; }
  get done() { return !this.seq || this.seq.done; }
  get fade() { return this.seq ? this.seq.fade : 0; }
}

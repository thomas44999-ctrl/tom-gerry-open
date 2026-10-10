// Wiederholungen (ARCHITECTURE §8): Ringpuffer-Aufzeichnung von Ball + Figuren (Position, Blickrichtung,
// capturePose()) mit Markern (Treffer, Aufsprünge, Netz …), Ausschnitte (Recording) und Abspieler mit
// Interpolation zwischen den Bildern (Ball: Hermite über Geschwindigkeiten, Posen: lineare/nlerp-Mischung).
// Speicher: vorab allozierte Float32/Float64-Pools, record() alloziert nicht (außer einmalig beim ersten Pose-Format).

const BALL_STRIDE = 10;          // pos3 vel3 spin3 visible1
const CHAR_STRIDE = 4;           // pos3 yaw1
const G = 9.81;

const lerpAngle = (a, b, t) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

/** Pose-Layout einer Figur (Anzahl führender Quaternionen im capturePose()-Array) – optionaler Hinweis. */
function poseLayoutOf(c) {
  if (!c) return 0;
  const l = c.capturePoseLayout || c.poseLayout || null;
  if (l && typeof l.quats === 'number') return l.quats | 0;
  return 0;
}

/**
 * Pose-Interpolation a->b (t 0..1) nach out. Die ersten `quats` Quaternionen (je 4 Werte) werden
 * hemisphärenrichtig normalisiert gemischt (nlerp), der Rest linear.
 */
export function lerpPoseArray(out, a, aOff, b, bOff, n, t, quats = 0) {
  const qn = Math.min(quats * 4, n);
  for (let k = 0; k < qn; k += 4) {
    const ax = a[aOff + k], ay = a[aOff + k + 1], az = a[aOff + k + 2], aw = a[aOff + k + 3];
    let bx = b[bOff + k], by = b[bOff + k + 1], bz = b[bOff + k + 2], bw = b[bOff + k + 3];
    if (ax * bx + ay * by + az * bz + aw * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
    const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t, w = aw + (bw - aw) * t;
    const l = Math.hypot(x, y, z, w) || 1;
    out[k] = x / l; out[k + 1] = y / l; out[k + 2] = z / l; out[k + 3] = w / l;
  }
  for (let k = qn; k < n; k++) out[k] = a[aOff + k] + (b[bOff + k] - a[aOff + k]) * t;
  return out;
}

/** Welche Spielereignisse als Marker gespeichert werden. */
const MARKER_TYPES = new Set(['hit', 'bounce', 'net', 'point', 'serve_toss', 'line_call', 'fault', 'let', 'wall', 'miss']);

/**
 * Ein abgeschlossener, eigenständiger Ausschnitt (Kopie aus dem Ringpuffer).
 * times: Float64Array(n) (Spielzeit s), ball: Float32Array(n*10), chars[i]: { tr: Float32Array(n*4),
 * pose: Float32Array(n*poseSize) | null, poseSize, quats }, markers: [{ t, kind, pos, player, ev }].
 */
export class Recording {
  constructor(n, charSpecs) {
    this.n = n;
    this.times = new Float64Array(n);
    this.ball = new Float32Array(n * BALL_STRIDE);
    this.chars = charSpecs.map((s) => ({
      tr: new Float32Array(n * CHAR_STRIDE),
      pose: s.poseSize > 0 ? new Float32Array(n * s.poseSize) : null,
      poseSize: s.poseSize, quats: s.quats,
    }));
    this.markers = [];
  }
  get t0() { return this.n ? this.times[0] : 0; }
  get t1() { return this.n ? this.times[this.n - 1] : 0; }
  get duration() { return this.t1 - this.t0; }

  /** Bildindex i und Anteil f (zwischen i und i+1) für Zeit t (geklemmt). Ergebnis in out[0], out[1]. */
  locate(t, out) {
    const T = this.times, n = this.n;
    if (n < 2 || t <= T[0]) { out[0] = 0; out[1] = 0; return out; }
    if (t >= T[n - 1]) { out[0] = n - 2 < 0 ? 0 : n - 2; out[1] = 1; return out; }
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
    const span = T[hi] - T[lo];
    out[0] = lo; out[1] = span > 1e-9 ? (t - T[lo]) / span : 0;
    return out;
  }

  /** Marker eines Typs (optional Filter) – letzter vor `before` bzw. erster nach `after`. */
  lastMarker(kind, before = Infinity, filter = null) {
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const m = this.markers[i];
      if (m.kind === kind && m.t <= before && (!filter || filter(m))) return m;
    }
    return null;
  }
  firstMarker(kind, after = -Infinity, filter = null) {
    for (const m of this.markers) if (m.kind === kind && m.t >= after && (!filter || filter(m))) return m;
    return null;
  }

  /**
   * Automatischer Höhepunkt: entscheidender Schlag + folgender Aufsprung/Netzkontakt.
   * Liefert { t, t0, t1, player, pos, kind } – [t0, t1] = Zeitlupenfenster.
   */
  highlight() {
    const pt = this.lastMarker('point');
    const before = pt ? pt.t + 0.01 : Infinity;
    const hit = this.lastMarker('hit', before);
    if (!hit) {
      const b = this.lastMarker('bounce', before);
      const t = b ? b.t : this.t1 - 0.8;
      return { t, t0: t - 0.5, t1: t + 0.5, player: -1, pos: b ? b.pos : null, kind: b ? 'bounce' : 'none' };
    }
    const after = (k) => this.firstMarker(k, hit.t + 1e-4);
    const b = after('bounce'), nt = after('net');
    let end = b ? b.t : hit.t + 0.7;
    if (nt && nt.t < end) end = nt.t;
    end = Math.min(end, hit.t + 1.6);
    // Bei Assen/Gewinnern den Ball noch am Gegner vorbeifliegen lassen
    const reason = pt && pt.ev ? pt.ev.reason : null;
    const tail = reason === 'ace' || reason === 'winner' || reason === 'service_winner' ? 0.45 : 0.3;
    const closeBounce = b && b.ev && (b.ev.in === false || (pt && pt.ev && pt.ev.closeCall)) ? b : null;
    return {
      t: closeBounce ? closeBounce.t : hit.t, hitT: hit.t, bounceT: b ? b.t : null,
      t0: hit.t - 0.3, t1: Math.min(this.t1, end + tail), player: hit.player ?? -1,
      pos: hit.pos, bouncePos: b ? b.pos : null, kind: closeBounce ? 'bounce' : 'hit', reason,
    };
  }
}

/** Ringpuffer-Aufzeichnung (Standard 15 s bei 60 Hz). */
export class Recorder {
  /** opts = { seconds: 15, hz: 60, maxChars: 2, maxMarkers: 256 } */
  constructor(opts = {}) {
    this.hz = opts.hz || 60;
    this.cap = Math.ceil((opts.seconds || 15) * this.hz) + 2;
    this.maxChars = opts.maxChars || 2;
    this.maxMarkers = opts.maxMarkers || 256;
    this.times = new Float64Array(this.cap);
    this.ball = new Float32Array(this.cap * BALL_STRIDE);
    this.tr = [];
    for (let i = 0; i < this.maxChars; i++) this.tr.push(new Float32Array(this.cap * CHAR_STRIDE));
    this.pose = new Array(this.maxChars).fill(null);     // lazy (Größe erst beim ersten capturePose bekannt)
    this.poseSize = new Array(this.maxChars).fill(0);
    this.quats = new Array(this.maxChars).fill(0);
    this._scratch = new Array(this.maxChars).fill(null);
    this.markers = [];
    this.enabled = true;
    this.reset();
  }

  reset() {
    this.head = 0;          // nächster Schreibindex
    this.count = 0;
    this.lastT = -Infinity;
    this.markers.length = 0;
    this.charCount = 0;
  }

  get t0() { return this.count ? this.times[(this.head - this.count + this.cap) % this.cap] : 0; }
  get t1() { return this.count ? this.times[(this.head - 1 + this.cap) % this.cap] : 0; }
  get duration() { return this.t1 - this.t0; }

  /**
   * Ein Bild aufzeichnen. ball = { pos, vel?, spin?, visible? }; characters = [{ position|pos, yaw, capturePose? }].
   * Zu dichte Aufrufe (> hz) werden übersprungen; Zeitsprung rückwärts setzt den Puffer zurück.
   */
  record(t, ball, characters) {
    if (!this.enabled) return false;
    if (t < this.lastT - 1e-3) this.reset();
    if (t - this.lastT < 0.75 / this.hz) return false;
    const i = this.head, B = this.ball, o = i * BALL_STRIDE;
    this.times[i] = t;
    if (ball && ball.pos) {
      const p = ball.pos, v = ball.vel, w = ball.spin;
      B[o] = p[0]; B[o + 1] = p[1]; B[o + 2] = p[2];
      if (v) { B[o + 3] = v[0]; B[o + 4] = v[1]; B[o + 5] = v[2]; } else { B[o + 3] = 0; B[o + 4] = 0; B[o + 5] = 0; }
      if (w) { B[o + 6] = w[0]; B[o + 7] = w[1]; B[o + 8] = w[2]; } else { B[o + 6] = 0; B[o + 7] = 0; B[o + 8] = 0; }
      B[o + 9] = ball.visible === false ? 0 : 1;
    } else {
      B[o + 9] = 0;
    }
    const nc = characters ? Math.min(characters.length, this.maxChars) : 0;
    this.charCount = Math.max(this.charCount, nc);
    for (let c = 0; c < nc; c++) {
      const ch = characters[c];
      if (!ch) continue;
      const p = ch.position || ch.pos, T = this.tr[c], q = i * CHAR_STRIDE;
      if (p) { T[q] = p[0]; T[q + 1] = p[1]; T[q + 2] = p[2]; }
      T[q + 3] = ch.yaw || 0;
      if (typeof ch.capturePose === 'function') {
        let arr = ch.capturePose(this._scratch[c] || undefined);
        if (arr && arr.length) {
          if (this.poseSize[c] !== arr.length) {
            // erstes Bild (oder Formatwechsel): Pool anlegen
            this.poseSize[c] = arr.length;
            this.pose[c] = new Float32Array(this.cap * arr.length);
            this._scratch[c] = new Float32Array(arr.length);
            this.quats[c] = poseLayoutOf(ch);
          }
          this.pose[c].set(arr, i * arr.length);
        }
      }
    }
    this.head = (i + 1) % this.cap;
    this.count = Math.min(this.cap, this.count + 1);
    this.lastT = t;
    this._trimMarkers();
    return true;
  }

  /** Marker hinzufügen: kind ('hit'|'bounce'|'net'|'point'|…), Zeit, Daten { pos?, player?, ev? }. */
  mark(kind, t, data = {}) {
    const m = { t, kind, pos: data.pos ? [data.pos[0], data.pos[1], data.pos[2]] : null, player: data.player ?? -1, ev: data.ev || null };
    this.markers.push(m);
    if (this.markers.length > this.maxMarkers) this.markers.shift();
    return m;
  }

  /** Spielereignisse (GameEvents) als Marker übernehmen. t = Zeit, falls Ereignis keine eigene `time` hat. */
  addEvents(events, t) {
    if (!events) return;
    for (const e of events) {
      const kind = e.type || e.event;
      if (!MARKER_TYPES.has(kind)) continue;
      this.mark(kind, e.time ?? t, { pos: e.pos, player: e.player ?? (kind === 'point' ? e.winner : -1), ev: e });
    }
  }

  _trimMarkers() {
    const t0 = this.t0;
    let k = 0;
    while (k < this.markers.length && this.markers[k].t < t0 - 0.5) k++;
    if (k) this.markers.splice(0, k);
  }

  lastMarker(kind, before = Infinity, filter = null) {
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const m = this.markers[i];
      if (m.kind === kind && m.t <= before && (!filter || filter(m))) return m;
    }
    return null;
  }

  /** Ausschnitt [from, to] als eigenständige Recording (Kopie). Ohne Argumente: alles. */
  clip(from = -Infinity, to = Infinity) {
    const cap = this.cap, start = (this.head - this.count + cap) % cap;
    let a = -1, b = -1;
    for (let k = 0; k < this.count; k++) {
      const t = this.times[(start + k) % cap];
      if (t >= from - 1e-6 && a < 0) a = k;
      if (t <= to + 1e-6) b = k;
    }
    // ein Bild Rand mitnehmen, damit Interpolation an den Grenzen sauber ist
    if (a < 0) a = this.count;
    if (a > 0) a--;
    if (b >= 0 && b < this.count - 1) b++;
    const n = Math.max(0, b - a + 1);
    const specs = [];
    for (let c = 0; c < this.charCount; c++) specs.push({ poseSize: this.poseSize[c], quats: this.quats[c] });
    const R = new Recording(n, specs);
    for (let k = 0; k < n; k++) {
      const i = (start + a + k) % cap;
      R.times[k] = this.times[i];
      R.ball.set(this.ball.subarray(i * BALL_STRIDE, (i + 1) * BALL_STRIDE), k * BALL_STRIDE);
      for (let c = 0; c < this.charCount; c++) {
        R.chars[c].tr.set(this.tr[c].subarray(i * CHAR_STRIDE, (i + 1) * CHAR_STRIDE), k * CHAR_STRIDE);
        const ps = this.poseSize[c];
        if (ps && R.chars[c].pose) R.chars[c].pose.set(this.pose[c].subarray(i * ps, (i + 1) * ps), k * ps);
      }
    }
    const t0 = n ? R.times[0] : 0, t1 = n ? R.times[n - 1] : 0;
    for (const m of this.markers) if (m.t >= t0 - 1e-6 && m.t <= t1 + 1e-6) R.markers.push(m);
    return R;
  }

  /** Den letzten Punkt ausschneiden: vom Aufschlag (serve_toss/hit) bis jetzt (+ optional tail). */
  clipLastPoint(maxLen = 9, tail = 0) {
    const pt = this.lastMarker('point');
    const end = Math.min(this.t1, pt ? pt.t + 1.2 + tail : this.t1);
    let start = end - maxLen;
    const toss = this.lastMarker('serve_toss', end);
    const serveHit = this.lastMarker('hit', end, (m) => m.ev && m.ev.serve);
    const s0 = toss ? toss.t - 0.2 : serveHit ? serveHit.t - 0.8 : start;
    start = Math.max(start, s0, this.t0);
    return this.clip(start, end);
  }
}

/** Abspieler für eine Recording. seek(t, targets) überträgt Ball- und Figurenzustand. */
export class ReplayPlayer {
  constructor(recording) {
    this.rec = recording;
    this.ballState = { pos: new Float32Array(3), vel: new Float32Array(3), spin: new Float32Array(3), visible: false };
    this.chars = recording.chars.map((c) => ({
      pos: new Float32Array(3), yaw: 0, pose: c.poseSize ? new Float32Array(c.poseSize) : null,
    }));
    this.time = recording.t0;
    this._loc = [0, 0];
  }
  get t0() { return this.rec.t0; }
  get t1() { return this.rec.t1; }
  get duration() { return this.rec.duration; }

  /** Ballzustand zur Zeit t (Hermite über Geschwindigkeiten, an Knicken linear). */
  sampleBall(t, out = this.ballState) {
    const R = this.rec, L = R.locate(t, this._loc), i = L[0], f = L[1];
    const B = R.ball, a = i * BALL_STRIDE, j = Math.min(i + 1, R.n - 1), b = j * BALL_STRIDE;
    if (!R.n) { out.visible = false; return out; }
    const va = B[a + 9] > 0.5, vb = B[b + 9] > 0.5;
    if (!va || !vb) {
      const s = f < 0.5 || !vb ? a : b;
      out.visible = (f < 0.5 ? va : vb);
      for (let k = 0; k < 3; k++) { out.pos[k] = B[s + k]; out.vel[k] = B[s + 3 + k]; out.spin[k] = B[s + 6 + k]; }
      return out;
    }
    const h = R.times[j] - R.times[i];
    // Konsistenzprüfung: passt v_b zu v_a + g*h (keine Kollision dazwischen)? Dann kubisch, sonst linear
    const ex = B[b + 3] - B[a + 3], ey = B[b + 4] - B[a + 4] + G * h, ez = B[b + 5] - B[a + 5];
    const smooth = h > 0 && ex * ex + ey * ey + ez * ez < 4.0;
    const f2 = f * f, f3 = f2 * f;
    const h00 = 2 * f3 - 3 * f2 + 1, h10 = f3 - 2 * f2 + f, h01 = -2 * f3 + 3 * f2, h11 = f3 - f2;
    for (let k = 0; k < 3; k++) {
      const pa = B[a + k], pb = B[b + k];
      out.pos[k] = smooth ? h00 * pa + h10 * h * B[a + 3 + k] + h01 * pb + h11 * h * B[b + 3 + k] : pa + (pb - pa) * f;
      out.vel[k] = B[a + 3 + k] + (B[b + 3 + k] - B[a + 3 + k]) * f;
      out.spin[k] = B[a + 6 + k] + (B[b + 6 + k] - B[a + 6 + k]) * f;
    }
    out.visible = true;
    return out;
  }

  /** Figur c zur Zeit t: Position/Yaw (und Pose-Puffer) in this.chars[c]. */
  sampleChar(c, t) {
    const R = this.rec, C = R.chars[c], S = this.chars[c];
    if (!C || !R.n) return S;
    const L = R.locate(t, this._loc), i = L[0], f = L[1], j = Math.min(i + 1, R.n - 1);
    const T = C.tr, a = i * CHAR_STRIDE, b = j * CHAR_STRIDE;
    for (let k = 0; k < 3; k++) S.pos[k] = T[a + k] + (T[b + k] - T[a + k]) * f;
    S.yaw = lerpAngle(T[a + 3], T[b + 3], f);
    if (S.pose && C.pose) lerpPoseArray(S.pose, C.pose, i * C.poseSize, C.pose, j * C.poseSize, C.poseSize, f, C.quats);
    return S;
  }

  /**
   * Zustand zur Zeit t anwenden. targets = { characters?: [Character], ball?: BallVisual | {pos,vel,spin,visible}, dt? }.
   * Character: position/yaw werden gesetzt, applyCapturedPose(arr) aufgerufen (falls aufgezeichnet).
   * BallVisual: update(dt, ballState); sonst werden pos/vel/spin/visible in das Objekt kopiert.
   */
  seek(t, targets = {}) {
    this.time = t;
    const bs = this.sampleBall(t);
    const ball = targets.ball;
    if (ball) {
      if (typeof ball.update === 'function') ball.update(targets.dt ?? 0, bs);
      else {
        if (ball.pos) { ball.pos[0] = bs.pos[0]; ball.pos[1] = bs.pos[1]; ball.pos[2] = bs.pos[2]; }
        if (ball.vel) { ball.vel[0] = bs.vel[0]; ball.vel[1] = bs.vel[1]; ball.vel[2] = bs.vel[2]; }
        if (ball.spin) { ball.spin[0] = bs.spin[0]; ball.spin[1] = bs.spin[1]; ball.spin[2] = bs.spin[2]; }
        ball.visible = bs.visible;
      }
    }
    const chars = targets.characters;
    for (let c = 0; c < this.chars.length; c++) {
      const S = this.sampleChar(c, t);
      const ch = chars && chars[c];
      if (!ch) continue;
      const p = ch.position || ch.pos;
      if (p) { p[0] = S.pos[0]; p[1] = S.pos[1]; p[2] = S.pos[2]; }
      ch.yaw = S.yaw;
      if (S.pose && typeof ch.applyCapturedPose === 'function') ch.applyCapturedPose(S.pose);
    }
    return this;
  }
}

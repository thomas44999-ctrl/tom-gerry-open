// Publikum & Stadion-Atmosphäre (laufzeitseitig):
//  * Gemurmel-Bett: zwei vorberechnete Loops (ruhig/aufgeregt), überblendet nach Aufregung,
//    gedämpft ("Hush") vor Aufschlag und während des Ballwechsels.
//  * Granularer Layer: einzelne Plauder-Phrasen naher Zuschauer, zufällig verteilt (nie identisch).
//  * Reaktionen: Applaus (Texturen + nahe Einzelklatscher, An- und Abschwellen, Ausdünnen),
//    "Ooh", "Aah", "Aww", Jubel/Gebrüll, stehende Ovationen, La-Ola, Lachen, Pfiffe, Rufe, "Psst".
//  * Open-Air-Ambience: Wind mit Böen, ferne Stadt, Vögel (vor allem im Titelbildschirm).
import { rnd, jit, pick, chance, clamp01, gainNode, filterNode, noiseSource, envAD, gauss, normalizeBuffer } from './dsp.js';
import { synthApplause, synthClap, bakeBabble, bakeExclaim, bakeShouts, bakePhrases, stereoBuffer, monoBuffer } from './crowdbake.js';

// Pegel-Trims (über die Audio-Testszene kalibriert)
const LV = {
  bed: 0.18, grain: 0.065, applause: 0.36, near: 0.09, ooh: 0.19, aah: 0.24, aww: 0.18, gasp: 0.115, laugh: 0.137, cheer: 0.3,
  shout: 0.42, whistle: 0.047, shh: 0.09, wind: 0.035, city: 0.03, birds: 0.05,
};
const PHASE_HUSH = { pre_serve: 0.55, serve: 1, rally: 1, point_over: 0, between_points: 0, change_ends: 0, match_over: 0 };

export class Crowd {
  constructor() {
    this.G = null; this.ac = null;
    this.tex = { calm: null, excited: null, dense: null, medium: null, sparse: null, claps: [], ooh: [], aah: [], aww: [], gasp: [], laugh: [], cheer: [], shouts: [], phrases: [] };
    this.baked = false; this.baking = null; this.bakeTimes = {};
    this.mode = 'match';
    this.active = true;       // false → keine Grains/Ereignisse planen (stumm/Lautstärke 0)
    this.murmur = 0.2; this.excite = 0.2; this.hush = 0; this.hushTarget = 0; this.chatter = 0;
    this._autoHushAt = 0;
    this._applause = []; this._clappers = [];
    this._grainNext = 0; this._shoutNext = 0; this._whistleNext = 0; this._birdNext = 0;
    this._ctl = 0; this._windCtl = 0;
    this._bedSrc = {}; this._bedG = {};
  }

  attach(G) {
    this.G = G; const ac = this.ac = G.ac;
    this.out = gainNode(ac, 1);                      // Publikum gesamt (Ducking bei Durchsagen)
    this.out.connect(G.bus.crowd);
    const send = gainNode(ac, 0.32); this.out.connect(send); send.connect(G.wet.crowd);
    this.bed = gainNode(ac, 1);
    this.bedLP = filterNode(ac, 'lowpass', 6000, 0.5);
    this.bed.connect(this.bedLP); this.bedLP.connect(this.out);
    this.rx = gainNode(ac, 1); this.rx.connect(this.out);   // Reaktionen
    this.amb = gainNode(ac, 1); this.amb.connect(G.bus.crowd);
    const asend = gainNode(ac, 0.12); this.amb.connect(asend); asend.connect(G.wet.crowd);
    this._startAmbience();
    if (this.tex.calm) this._startBed();
  }

  // ------------------------------------------------------------ Vorberechnung
  /** Erzeugt alle Texturen (asynchron, schrittweise). onProgress(p 0..1, name). */
  bake(onProgress) {
    if (this.baking) return this.baking;
    const T = this.tex;
    const steps = [
      ['claps', async () => { for (let i = 0; i < 24; i++) T.claps.push(monoBuffer(synthClap())); }],
      ['murmur', async () => { T.calm = await bakeBabble(12, 26); if (this.G) this._startBed(); }],
      ['applause', async () => { T.medium = stereoBuffer(await synthApplause(6, 70, { near: 0.08 })); normalizeBuffer(T.medium, 0.12); }],
      ['applause+', async () => { T.dense = stereoBuffer(await synthApplause(6.5, 230, { near: 0.04, wash: 0.05 })); normalizeBuffer(T.dense, 0.16); }],
      ['applause-', async () => { T.sparse = stereoBuffer(await synthApplause(7, 13, { near: 0.25 })); normalizeBuffer(T.sparse, 0.05); }],
      ['ooh', async () => { T.ooh = await bakeExclaim('ooh', 3, 30, 2.3); }],
      ['phrases', async () => { T.phrases = await bakePhrases(16); }],
      ['shouts', async () => { T.shouts = await bakeShouts(); }],
      ['cheer', async () => { T.cheer = await bakeExclaim('cheer', 2, 44, 4.2); }],
      ['aah', async () => { T.aah = await bakeExclaim('aah', 2, 26, 2.2); }],
      ['aww', async () => { T.aww = await bakeExclaim('aww', 2, 26, 1.9); }],
      ['murmur+', async () => { T.excited = await bakeBabble(10, 30, { excited: true }); if (this.G) this._startBed(); }],
      ['gasp', async () => { T.gasp = await bakeExclaim('gasp', 2, 28, 0.8); }],
      ['laugh', async () => { T.laugh = await bakeExclaim('laugh', 2, 16, 2.4); }],
    ];
    this.baking = (async () => {
      for (let k = 0; k < steps.length; k++) {
        const t0 = now();
        try { await steps[k][1](); } catch (e) { this.bakeError = e; }
        this.bakeTimes[steps[k][0]] = Math.round(now() - t0);
        onProgress?.((k + 1) / steps.length, steps[k][0]);
      }
      this.baked = true;
      return this.tex;
    })();
    return this.baking;
  }

  // ------------------------------------------------------------ Steuerung
  setMode(mode) { this.mode = mode; }
  /** Spielphase → Stille-Ziel (Hush). */
  setPhase(phase) {
    if (phase in PHASE_HUSH) { this.hushTarget = PHASE_HUSH[phase]; this._autoHushAt = 0; }
  }
  /** Sofortige Ruhe (Aufwurf beim Aufschlag). Bei lautem Publikum vereinzelt "Psst". */
  hushNow() {
    if (this.hushTarget < 1 && this.murmur > 0.32 && this.G && this.mode === 'match') {
      const n = chance(0.5) ? 1 : 2;
      for (let k = 0; k < n; k++) this._shh(this.ac.currentTime + rnd(0.05, 0.6));
    }
    this.hushTarget = 1; this._autoHushAt = 0;
  }
  /** Nach dem Punkt: Gespräch frei, nach einer Weile automatisch wieder ruhiger (falls keine Phasen kommen). */
  release(chat = 0.25) {
    this.hushTarget = 0; this.chatter = Math.max(this.chatter, chat);
    if (this.ac) this._autoHushAt = this.ac.currentTime + 7.5;
  }
  /** Lautstärke-Absenkung während Schiedsrichter-Durchsagen. */
  duck(on) {
    if (!this.G) return;
    this.out.gain.setTargetAtTime(on ? 0.6 : 1, this.ac.currentTime, on ? 0.12 : 0.45);
  }

  /**
   * Reaktion auslösen. kind: 'applause' | 'ooh' | 'aah' | 'aww' | 'gasp' | 'laugh' | 'cheer' | 'standing' | 'wave' |
   * 'quiet' | 'murmur' | 'tension' | 'whistle' | 'shout'. intensity 0..1. opts: { delay, hold }
   */
  react(kind, intensity = 0.6, opts = {}) {
    if (!this.G) return;
    const i = clamp01(intensity), t = this.ac.currentTime + 0.02 + (opts.delay ?? 0);
    switch (kind) {
      case 'applause': this._applauseAt(t, i, opts); this.release(0.15 + 0.25 * i); break;
      case 'ooh': case 'aah': case 'aww': case 'gasp': case 'laugh': this._exclaim(kind, t, i); break;
      case 'cheer':
        this._exclaim('cheer', t, i);
        this._applauseAt(t + 0.15, Math.max(i, 0.75), { hold: opts.hold ?? 2.2 + 2.2 * i });
        for (let k = 0, n = 1 + Math.round(3 * i); k < n; k++) this._whistle(t + rnd(0.3, 2.8));
        for (let k = 0, n = Math.round(2 * i); k < n; k++) this._shout(t + rnd(0.6, 3.0), i);
        this.release(0.35 + 0.2 * i); break;
      case 'standing':
        this._exclaim('cheer', t, 1); this._exclaim('cheer', t + rnd(2.2, 3.0), 0.8);
        this._applauseAt(t + 0.1, 1, { hold: opts.hold ?? 8 });
        this._applauseAt(t + 0.6, 0.9, { hold: (opts.hold ?? 8) - 1 });
        for (let k = 0; k < 7; k++) this._whistle(t + rnd(0.4, 7));
        for (let k = 0; k < 5; k++) this._shout(t + rnd(0.8, 7), 1);
        this.release(0.6); break;
      case 'wave': this._wave(t, i); break;
      case 'quiet': this.hushNow(); break;
      case 'murmur': this.release(0.2 + 0.35 * i); break;
      case 'tension':
        this.chatter = Math.max(this.chatter, 0.2 + 0.25 * i);
        for (let k = 0, n = 1 + Math.round(2 * i); k < n; k++) this._shout(t + rnd(0.3, 2.5), i);
        if (i > 0.7) this._whistle(t + rnd(0.5, 2));
        break;
      case 'whistle': this._whistle(t); break;
      case 'shout': this._shout(t, i); break;
      default: break;
    }
  }

  /** Pro Frame: Pegel nachführen, Grains/Klatscher/Vögel planen. st = { excitement, active } */
  update(dt, st = {}) {
    if (!this.G) return;
    const now = this.ac.currentTime;
    if (st.excitement != null) this.excite += (clamp01(st.excitement) - this.excite) * (1 - Math.exp(-dt * 1.5));
    if (st.active != null) this.active = st.active;
    this.chatter = Math.max(0, this.chatter - dt * 0.07);
    if (this._autoHushAt && now > this._autoHushAt) { this.hushTarget = Math.max(this.hushTarget, 0.55); this._autoHushAt = 0; }
    const ht = this.hushTarget;
    this.hush += (ht - this.hush) * (1 - Math.exp(-dt * (ht > this.hush ? 1.8 : 0.7)));
    let target;
    if (this.mode === 'title') target = 0.3;
    else target = Math.min(1, 0.14 + 0.42 * this.excite + this.chatter) * (1 - 0.9 * this.hush);
    this.murmur += (target - this.murmur) * (1 - Math.exp(-dt * (target > this.murmur ? 1.4 : 0.9)));

    this._ctl -= dt;
    if (this._ctl <= 0) { this._ctl = 1 / 15; this._applyLevels(now); }
    this._windCtl -= dt;
    if (this._windCtl <= 0) { this._windCtl = 0.25; this._updateWind(now); }
    if (this.active) this._scheduleUntil(now + 0.3, now);
  }

  /** Plant alle zeitlich verteilten Ereignisse bis tEnd (auch für Offline-Rendering nutzbar). */
  _scheduleUntil(tEnd, now = this.ac.currentTime) {
    // nahe Einzelklatscher
    for (let k = this._clappers.length - 1; k >= 0; k--) {
      const c = this._clappers[k];
      if (c.next < now - 0.1) c.next = now + Math.random() * c.period;
      while (c.next < tEnd && c.next < c.until) { this._clap(c.next, c); c.next += c.period * (1 + gauss() * 0.04); }
      if (c.next >= c.until) this._clappers.splice(k, 1);
    }
    // granulare Plauder-Phrasen
    const rate = this.tex.phrases.length && this.murmur > 0.04 ? this.murmur * (1.0 + 4.5 * this.excite) : 0;
    if (this._grainNext < now) this._grainNext = now + (rate > 0 ? -Math.log(1 - Math.random()) / rate : 0.3);
    while (this._grainNext < tEnd) {
      if (rate <= 0) { this._grainNext = tEnd + 0.2; break; }
      this._grain(this._grainNext);
      this._grainNext += -Math.log(1 - Math.random()) / rate;
    }
    // vereinzelte Rufe/Pfiffe zwischen den Punkten
    if (this.mode === 'match') {
      const free = this.hush < 0.3 && this.murmur > 0.18;
      const sr = free ? 0.025 + 0.12 * this.excite * this.excite : 0;
      if (this._shoutNext < now) this._shoutNext = now + (sr > 0 ? -Math.log(1 - Math.random()) / sr : 1);
      if (this._shoutNext < tEnd && sr > 0) { this._shout(this._shoutNext, this.excite); this._shoutNext += -Math.log(1 - Math.random()) / sr; }
      const wr = free ? 0.01 + 0.05 * this.excite : 0;
      if (this._whistleNext < now) this._whistleNext = now + (wr > 0 ? -Math.log(1 - Math.random()) / wr : 1);
      if (this._whistleNext < tEnd && wr > 0) { this._whistle(this._whistleNext); this._whistleNext += -Math.log(1 - Math.random()) / wr; }
    }
    // Vögel (Titel häufig, im Match nur in stillen Momenten selten)
    const br = this.mode === 'title' ? 0.32 : 0.02 + 0.04 * this.hush;
    if (this._birdNext < now) this._birdNext = now + -Math.log(1 - Math.random()) / br;
    if (this._birdNext < tEnd) { this._bird(this._birdNext); this._birdNext += -Math.log(1 - Math.random()) / br; }
  }

  // ------------------------------------------------------------ intern: Pegel
  _applyLevels(now) {
    const m = this.murmur, e = this.excite, tau = 0.12;
    if (this._bedG.calm) this._bedG.calm.gain.setTargetAtTime(LV.bed * m * (this._bedG.excited ? 1 - 0.65 * e : 1), now, tau);
    if (this._bedG.excited) this._bedG.excited.gain.setTargetAtTime(LV.bed * m * e * 1.05, now, tau);
    this.bedLP.frequency.setTargetAtTime(2200 + 5000 * (1 - this.hush), now, 0.2);
    const title = this.mode === 'title';
    if (this.cityG) this.cityG.gain.setTargetAtTime(LV.city * (title ? 1 : 0.55), now, 0.5);
  }
  _startBed() {
    const ac = this.ac, t = ac.currentTime;
    for (const key of ['calm', 'excited']) {
      const buf = this.tex[key];
      if (!buf || this._bedSrc[key]) continue;
      const s = ac.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = jit(1, 0.015);
      const g = gainNode(ac, 0);
      s.connect(g); g.connect(this.bed);
      s.start(t + 0.02, Math.random() * buf.duration);
      this._bedSrc[key] = s; this._bedG[key] = g;
    }
  }
  _startAmbience() {
    const ac = this.ac, t = ac.currentTime, nz = this.G.noise;
    this.wind = [];
    for (const pan of [-0.65, 0.65]) {
      const s = ac.createBufferSource(); s.buffer = nz.pink; s.loop = true; s.playbackRate.value = jit(1, 0.1);
      const bp = filterNode(ac, 'bandpass', 500, 0.45), lp = filterNode(ac, 'lowpass', 1500, 0.5);
      const g = gainNode(ac, 0), p = ac.createStereoPanner(); p.pan.value = pan;
      s.connect(bp); bp.connect(lp); lp.connect(g); g.connect(p); p.connect(this.amb);
      s.start(t, Math.random() * 5);
      this.wind.push({ bp, g, gust: 0.4, target: 0.4 });
    }
    const c = ac.createBufferSource(); c.buffer = nz.brown; c.loop = true;
    const clp = filterNode(ac, 'lowpass', 170, 0.6);
    this.cityG = gainNode(ac, 0);
    c.connect(clp); clp.connect(this.cityG); this.cityG.connect(this.amb);
    c.start(t, Math.random() * 5);
  }
  _updateWind(now) {
    const title = this.mode === 'title';
    for (const w of this.wind) {
      if (Math.random() < 0.18) w.target = Math.min(1, Math.max(0.12, w.target + gauss() * 0.3));
      w.gust += (w.target - w.gust) * 0.25;
      w.g.gain.setTargetAtTime(LV.wind * (title ? 1 : 0.55) * w.gust, now, 0.7);
      w.bp.frequency.setTargetAtTime(280 + 650 * w.gust, now, 0.9);
    }
  }

  // ------------------------------------------------------------ intern: Klänge
  _src(buf, t, rate = 1, loop = false, tEnd = 0) {
    const s = this.ac.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate;
    if (loop) { s.loop = true; s.start(t, Math.random() * buf.duration); if (tEnd) s.stop(tEnd); }
    else s.start(t, 0, buf._activeDur ?? buf.duration);
    return s;
  }
  _chain(src, dest, gain, { pan = null, cutoff = 0 } = {}) {
    const ac = this.ac;
    const g = gainNode(ac, gain);
    let last = src;
    if (cutoff) { const f = filterNode(ac, 'lowpass', cutoff, 0.5); last.connect(f); last = f; }
    last.connect(g);
    if (pan != null) { const p = ac.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(dest); } else g.connect(dest);
    return g;
  }

  _applauseAt(t, i, o = {}) {
    const T = this.tex, ac = this.ac;
    const main = i > 0.55 ? (T.dense || T.medium) : (T.medium || T.dense);
    if (!main) return;
    // höchstens drei gleichzeitige Applaus-Instanzen: älteste schnell ausblenden
    this._applause = this._applause.filter((a) => a.end > ac.currentTime);
    while (this._applause.length >= 3) { const a = this._applause.shift(); for (const g of a.gains) g.gain.setTargetAtTime(0, ac.currentTime, 0.25); }
    const peak = (0.2 + 0.8 * Math.pow(i, 1.2)) * LV.applause * jit(1, 0.06);
    const swell = (0.65 - 0.35 * i) * jit(1, 0.15);
    const hold = (o.hold ?? (0.6 + 3.0 * i)) * jit(1, 0.15);
    const rel = (1.5 + 1.6 * i) * jit(1, 0.12);
    const tOff = t + swell + hold, tEnd = tOff + rel * 2.4;
    const gains = [];
    const layer = (buf, amp, start) => {
      const s = this._src(buf, start, jit(1, 0.025), true, tEnd);
      const g = this._chain(s, this.rx, 0);
      g.gain.setValueAtTime(0, start);
      gains.push(g);
      return g;
    };
    const g1 = layer(main, peak, t);
    g1.gain.setTargetAtTime(peak, t, swell / 2.5); g1.gain.setTargetAtTime(0, tOff, rel / 3);
    if (i > 0.8 && T.dense) {
      const g2 = layer(T.dense, peak, t + rnd(0.02, 0.12));
      g2.gain.setTargetAtTime(peak * 0.5, t, swell / 2); g2.gain.setTargetAtTime(0, tOff - 0.2, rel / 3.4);
    }
    if (T.sparse) {
      // Ausdünnen: während der dichte Applaus abfällt, klatschen einige länger weiter
      const g3 = layer(T.sparse, peak, tOff - 0.3);
      g3.gain.setTargetAtTime(peak * 0.9, tOff - 0.3, rel / 5); g3.gain.setTargetAtTime(0, tOff + rel * 0.5, rel / 2.6);
    }
    this._applause.push({ end: tEnd, gains });
    // nahe Einzelklatscher (Vordergrund, klar ortbar)
    if (T.claps.length) {
      const n = Math.min(10 - this._clappers.length, Math.round(1 + 6 * i));
      for (let k = 0; k < n; k++) {
        this._clappers.push({
          next: t + rnd(0.02, swell * 1.3), until: tOff + rnd(-0.2, rel * 0.9), period: 1 / rnd(3.6, 5.4),
          gain: LV.near * rnd(0.4, 1) * (0.5 + 0.5 * i), pan: rnd(-0.85, 0.85), buf: pick(T.claps), cut: rnd(5000, 11000),
        });
      }
    }
  }
  _clap(t, c) {
    const s = this._src(Math.random() < 0.8 ? c.buf : pick(this.tex.claps), t, jit(1, 0.05));
    this._chain(s, this.rx, c.gain * rnd(0.7, 1), { pan: c.pan, cutoff: c.cut });
  }
  _exclaim(kind, t, i) {
    const list = this.tex[kind];
    if (!list || !list.length) return;
    const lv = LV[kind] ?? 0.8;
    const a = pick(list);
    const s = this._src(a, t, jit(1, 0.035));
    this._chain(s, this.rx, (0.3 + 0.7 * i) * lv * jit(1, 0.08), { cutoff: 3000 + 5000 * i });
    if (i > 0.7 && list.length > 1) {
      const b = list[(list.indexOf(a) + 1) % list.length];
      const s2 = this._src(b, t + rnd(0.03, 0.1), jit(1, 0.04));
      this._chain(s2, this.rx, (0.3 + 0.7 * i) * lv * 0.55, { cutoff: 2500 + 4000 * i });
    }
  }
  _grain(t) {
    const s = this._src(pick(this.tex.phrases), t, jit(1, 0.08));
    this._chain(s, this.bed, LV.grain * rnd(0.35, 1) * Math.sqrt(this.murmur), { pan: rnd(-0.9, 0.9), cutoff: rnd(1600, 4500) });
  }
  _shout(t, i = 0.5) {
    if (!this.tex.shouts.length) return;
    const dist = rnd(6, 35);
    const s = this._src(pick(this.tex.shouts), t, jit(1, 0.05));
    this._chain(s, this.rx, LV.shout * (0.6 + 0.4 * i) / (1 + dist / 12), { pan: rnd(-0.85, 0.85), cutoff: 9000 / (1 + dist / 25) });
  }
  _shh(t) {
    const ac = this.ac, d = rnd(0.5, 0.9), dist = rnd(6, 30);
    const n = noiseSource(ac, 'white', t, d + 0.4);
    const bp = filterNode(ac, 'bandpass', rnd(2700, 4200), 2.4);
    const g = ac.createGain(); envAD(g.gain, t, 0.07, 1, 0.09, d * 0.6);
    n.connect(bp); bp.connect(g);
    this._chain(g, this.rx, LV.shh / (1 + dist / 15), { pan: rnd(-0.8, 0.8), cutoff: 9000 / (1 + dist / 25) });
  }
  _whistle(t) {
    const ac = this.ac, dist = rnd(8, 40), wolf = Math.random() < 0.3;
    const env = gainNode(ac, 0);
    this._chain(env, this.rx, LV.whistle / (1 + dist / 12) * jit(1, 0.2), { pan: rnd(-0.85, 0.85), cutoff: 10000 / (1 + dist / 30) });
    const o = ac.createOscillator();
    const lfo = ac.createOscillator(); lfo.frequency.value = rnd(4.5, 7);
    const lg = gainNode(ac, rnd(10, 30)); lfo.connect(lg); lg.connect(o.detune);
    let d;
    if (!wolf) {
      const f = rnd(2200, 3400); d = rnd(0.35, 1.0);
      o.frequency.setValueAtTime(f * 0.72, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.06);
      o.frequency.setValueAtTime(f, t + d * 0.8); o.frequency.exponentialRampToValueAtTime(f * 0.93, t + d);
      env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(1, t + 0.03); env.gain.setValueAtTime(1, t + d - 0.06); env.gain.linearRampToValueAtTime(0, t + d);
    } else {
      d = 0.95;
      o.frequency.setValueAtTime(1500, t); o.frequency.exponentialRampToValueAtTime(3100, t + 0.22);
      o.frequency.setValueAtTime(1600, t + 0.36); o.frequency.exponentialRampToValueAtTime(3300, t + 0.55); o.frequency.exponentialRampToValueAtTime(1300, t + 0.92);
      env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(0.9, t + 0.04); env.gain.setValueAtTime(0.9, t + 0.2); env.gain.linearRampToValueAtTime(0, t + 0.26);
      env.gain.setValueAtTime(0, t + 0.35); env.gain.linearRampToValueAtTime(1, t + 0.4); env.gain.setValueAtTime(1, t + 0.82); env.gain.linearRampToValueAtTime(0, t + 0.94);
    }
    o.connect(env); o.start(t); o.stop(t + d + 0.05); lfo.start(t); lfo.stop(t + d + 0.05);
    // Luftgeräusch der Pfeife
    const n = noiseSource(ac, 'white', t, d + 0.05);
    const bp = filterNode(ac, 'bandpass', 3000, 5); const ng = gainNode(ac, 0.12);
    n.connect(bp); bp.connect(ng); ng.connect(env);
  }
  _wave(t, i) {
    const list = this.tex.cheer;
    if (!list.length) return;
    const ac = this.ac;
    for (let k = 0; k < 2; k++) {
      const t0 = t + k * 3.4;
      const s = this._src(pick(list), t0, jit(0.95, 0.03));
      const g = gainNode(ac, 0), p = ac.createStereoPanner();
      p.pan.setValueAtTime(-0.95, t0); p.pan.linearRampToValueAtTime(0.95, t0 + 3.2);
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime((0.4 + 0.5 * i) * LV.cheer, t0 + 1.2); g.gain.linearRampToValueAtTime(0, t0 + 3.4);
      s.connect(g); g.connect(p); p.connect(this.rx);
    }
    this._applauseAt(t + 4, 0.5 * i);
  }
  _bird(t) {
    const ac = this.ac, dist = rnd(20, 80);
    const out = this._chainNode(LV.birds / (1 + dist / 30), rnd(-1, 1), 9000);
    const sp = Math.random();
    if (sp < 0.45) {
      const n = 2 + (Math.random() * 4 | 0), f0 = rnd(3400, 5200);
      let tt = t;
      for (let k = 0; k < n; k++) {
        const o = ac.createOscillator(), g = gainNode(ac, 0);
        o.frequency.setValueAtTime(f0 * 0.8, tt); o.frequency.exponentialRampToValueAtTime(f0 * 1.25, tt + 0.05); o.frequency.exponentialRampToValueAtTime(f0 * jit(1, 0.05), tt + 0.085);
        envAD(g.gain, tt, 0.005, 1, 0.025, 0.03);
        o.connect(g); g.connect(out); o.start(tt); o.stop(tt + 0.2);
        tt += rnd(0.09, 0.16);
      }
    } else if (sp < 0.75) {
      const d = rnd(0.35, 0.7), f = rnd(4000, 6000);
      const o = ac.createOscillator(), g = gainNode(ac, 0);
      o.frequency.value = f;
      const fm = ac.createOscillator(); fm.frequency.value = rnd(20, 30);
      const fg = gainNode(ac, rnd(300, 700)); fm.connect(fg); fg.connect(o.frequency);
      envAD(g.gain, t, 0.02, 0.8, d / 4, d * 0.5);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + d * 1.6); fm.start(t); fm.stop(t + d * 1.6);
    } else {
      let tt = t, f = rnd(2200, 3100);
      for (let k = 0, n = 2 + (Math.random() * 2 | 0); k < n; k++) {
        const d = rnd(0.14, 0.24), o = ac.createOscillator(), g = gainNode(ac, 0);
        o.frequency.setValueAtTime(f, tt); o.frequency.exponentialRampToValueAtTime(f * rnd(0.82, 0.95), tt + d);
        envAD(g.gain, tt, 0.02, 0.9, d / 3, d * 0.4);
        o.connect(g); g.connect(out); o.start(tt); o.stop(tt + d * 2);
        tt += d + rnd(0.05, 0.12); f *= rnd(0.85, 1.12);
      }
    }
  }
  _chainNode(gain, pan, cutoff) {
    const ac = this.ac;
    const g = gainNode(ac, gain), f = filterNode(ac, 'lowpass', cutoff, 0.5), p = ac.createStereoPanner();
    p.pan.value = pan; g.connect(f); f.connect(p); p.connect(this.amb);
    return g;
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

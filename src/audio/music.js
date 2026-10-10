// Musik: kurze Broadcast-Stings (Glocke/Pluck/Pad, D-Dur) für Matchbeginn, Spiel-, Satz- und
// Matchgewinn sowie ein ruhiges, endlos generiertes Ambient-Pad für den Titelbildschirm.
// Alle Instrumente sind kleine Synthesizer aus Oszillatoren/Filtern (offline renderbar).
import { rnd, jit, pick, gainNode, filterNode, noiseSource, envAD, midiHz } from './dsp.js';

const LEVEL = 0.34;
// Pegel je Sting (im Audio-Labor kalibriert)
const STING_GAIN = { match_start: 0.75, game: 1.35, game_neg: 1.0, break: 0.9, set: 0.9, match: 0.7 };

// Akkorde (MIDI) für das Titel-Pad: Dmaj9 – Bm9 – Gmaj7(#11) – A6sus
const TITLE_CHORDS = [
  [50, 57, 64, 66, 73], [47, 54, 61, 62, 69], [43, 50, 57, 59, 66], [45, 52, 59, 62, 66],
];
const PENTA = [74, 76, 78, 81, 83, 86, 88];

export class Music {
  constructor() { this.G = null; this.titleOn = false; this._next = 0; this._sparkNext = 0; this._idx = 0; }

  attach(G) {
    this.G = G; const ac = this.ac = G.ac;
    this.out = gainNode(ac, LEVEL);
    this.out.connect(G.bus.music);
    const send = gainNode(ac, 0.45); this.out.connect(send); send.connect(G.wet.music);
    this.titleBus = gainNode(ac, 0);
    const warm = filterNode(ac, 'lowpass', 5200, 0.5);
    this.titleBus.connect(warm); warm.connect(this.out);
  }

  // ------------------------------------------------------------ Instrumente
  /** FM-Glocke (inharmonisch, Broadcast-"Ding"). */
  bell(t, m, vel = 0.5, dur = 2.5, dest = this.out) {
    const ac = this.ac, f = midiHz(m);
    const c = ac.createOscillator(), mo = ac.createOscillator();
    c.frequency.value = f; mo.frequency.value = f * 3.5;
    const mg = ac.createGain();
    mg.gain.setValueAtTime(f * 2.4 * vel, t); mg.gain.setTargetAtTime(f * 0.15, t, dur / 6);
    mo.connect(mg); mg.connect(c.frequency);
    const g = ac.createGain(); envAD(g.gain, t, 0.002, 0.2 * vel, dur / 4);
    c.connect(g); g.connect(dest);
    const o2 = ac.createOscillator(); o2.frequency.value = f * 2.001;
    const g2 = ac.createGain(); envAD(g2.gain, t, 0.002, 0.05 * vel, dur / 7);
    o2.connect(g2); g2.connect(dest);
    const end = t + dur * 1.6;
    for (const o of [c, mo, o2]) { o.start(t); o.stop(end); }
  }
  /** Gezupfter Ton (Harfen-/Pluck-Charakter) mit Filterhüllkurve. */
  pluck(t, m, vel = 0.5, dest = this.out) {
    const ac = this.ac, f = midiHz(m);
    const a = ac.createOscillator(), b = ac.createOscillator();
    a.type = 'triangle'; b.type = 'sawtooth'; a.frequency.value = f; b.frequency.value = f; b.detune.value = jit(5, 0.5);
    const bg = gainNode(ac, 0.35);
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(Math.min(12000, f * 9), t); lp.frequency.setTargetAtTime(f * 1.4, t, 0.12);
    const g = ac.createGain(); envAD(g.gain, t, 0.002, 0.2 * vel, 0.42);
    a.connect(lp); b.connect(bg); bg.connect(lp); lp.connect(g); g.connect(dest);
    for (const o of [a, b]) { o.start(t); o.stop(t + 3); }
  }
  /** Warmes Pad aus verstimmten Sägezähnen. */
  pad(t, notes, dur, vel = 0.4, dest = this.out, attack = 0) {
    const ac = this.ac;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.6;
    lp.frequency.setValueAtTime(500, t); lp.frequency.linearRampToValueAtTime(1700, t + dur * 0.45); lp.frequency.linearRampToValueAtTime(900, t + dur);
    const g = ac.createGain();
    const at = attack || Math.max(0.2, dur * 0.28);
    const amp = vel * 0.075 / Math.sqrt(notes.length);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + at);
    g.gain.setValueAtTime(amp, t + dur * 0.7); g.gain.setTargetAtTime(0, t + dur * 0.7, dur * 0.16);
    lp.connect(g); g.connect(dest);
    const end = t + dur * 1.5;
    for (const m of notes) {
      for (const dt of [-8, 7]) {
        const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midiHz(m); o.detune.value = dt + rnd(-2, 2);
        o.connect(lp); o.start(t); o.stop(end);
      }
    }
  }
  /** Weiche Pauke/Bassdrum. */
  boom(t, vel = 0.6, dest = this.out) {
    const ac = this.ac;
    const o = ac.createOscillator(); o.frequency.setValueAtTime(64, t); o.frequency.exponentialRampToValueAtTime(44, t + 0.35);
    const g = ac.createGain(); envAD(g.gain, t, 0.004, 0.55 * vel, 0.3);
    o.connect(g); g.connect(dest); o.start(t); o.stop(t + 2);
    const n = noiseSource(ac, 'white', t, 0.4);
    const lp = filterNode(ac, 'lowpass', 200, 0.7), ng = ac.createGain(); envAD(ng.gain, t, 0.003, 0.35 * vel, 0.05);
    n.connect(lp); lp.connect(ng); ng.connect(dest);
  }
  /** Rückwärts-Becken-Swell, endet auf dem Downbeat (t + dur). */
  shimmer(t, dur, vel = 0.5, dest = this.out) {
    const ac = this.ac;
    const n = noiseSource(ac, 'white', t, dur + 0.4);
    const hp = filterNode(ac, 'highpass', 4500, 0.7), bp = filterNode(ac, 'bandpass', 8500, 0.6);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.06 * vel, t + dur); g.gain.setTargetAtTime(0, t + dur, 0.06);
    n.connect(hp); hp.connect(bp); bp.connect(g); g.connect(dest);
  }
  /** Sinus-Sub-Bass. */
  sub(t, m, dur, vel = 0.5, dest = this.out) {
    const ac = this.ac;
    const o = ac.createOscillator(); o.frequency.value = midiHz(m);
    const g = ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.18 * vel, t + 0.05); g.gain.setTargetAtTime(0, t + dur * 0.6, dur * 0.2);
    o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur * 1.6);
  }

  // ------------------------------------------------------------ Stings
  /**
   * name: 'match_start' | 'game' | 'set' | 'match' | 'break'. opts: { positive=true, delay=0 }
   * @returns {number} Dauer (s)
   */
  sting(name, opts = {}) {
    if (!this.G) return 0;
    const pos = opts.positive !== false;
    // eigener Pegel je Sting: Instrumente spielen während des Aufbaus in einen Zwischenknoten
    const main = this.out, g = gainNode(this.ac, (STING_GAIN[name === 'game' && !pos ? 'game_neg' : name] ?? 1) * (opts.gain ?? 1));
    g.connect(main);
    this.out = g;
    try { return this._sting(name, this.ac.currentTime + 0.03 + (opts.delay ?? 0), pos); } finally { this.out = main; }
  }
  _sting(name, t0, pos) {
    switch (name) {
      case 'match_start': {
        const T = t0 + 0.55;
        this.shimmer(t0, 0.55, 0.7);
        this.boom(T, 0.7); this.sub(T, 38, 2.2, 0.6);
        this.pad(T, [50, 57, 62, 66, 69], 1.7, 0.55, this.out, 0.08);
        this.bell(T, 74, 0.55, 3);
        [74, 78, 81, 86].forEach((m, k) => this.pluck(T + 0.12 + k * 0.1, m, 0.45));
        this.bell(T + 0.6, 78, 0.4, 2.5); this.bell(T + 0.9, 81, 0.45, 3);
        this.pad(T + 1.4, [55, 62, 67, 71], 1.3, 0.45);
        this.pad(T + 2.4, [50, 57, 62, 66, 69], 1.8, 0.5);
        this.bell(T + 2.4, 86, 0.35, 3);
        return 4.2;
      }
      case 'game': {
        if (pos) {
          this.pluck(t0, 69, 0.42); this.pluck(t0 + 0.09, 74, 0.48);
          this.bell(t0 + 0.18, 78, 0.32, 1.6);
          this.pad(t0, [62, 69], 1.4, 0.25, this.out, 0.06);
        } else {
          this.pluck(t0, 66, 0.38); this.pluck(t0 + 0.1, 71, 0.42);
          this.bell(t0 + 0.2, 74, 0.26, 1.5);
          this.pad(t0, [59, 66], 1.3, 0.22, this.out, 0.06);
        }
        return 1.8;
      }
      case 'break': {
        this.boom(t0, 0.4);
        this.pluck(t0, 71, 0.4); this.pluck(t0 + 0.09, 74, 0.45); this.pluck(t0 + 0.18, 78, 0.5);
        this.bell(t0 + 0.27, 83, 0.32, 2);
        this.pad(t0, [59, 66, 71], 0.9, 0.3, this.out, 0.06); this.pad(t0 + 0.8, [55, 62, 67, 71], 1.4, 0.3);
        return 2.4;
      }
      case 'set': {
        const T = t0 + 0.35;
        this.shimmer(t0, 0.35, 0.5);
        this.boom(T, 0.55);
        [74, 78, 81, 86].forEach((m, k) => this.pluck(T + k * 0.085, m, 0.45));
        this.bell(T + 0.35, 86, 0.42, 2.4); this.bell(T + 0.35, 81, 0.28, 2.2);
        this.pad(T, [47, 54, 57, 62], 0.95, 0.45, this.out, 0.06);
        this.pad(T + 0.8, [43, 55, 59, 62, 66], 0.95, 0.45);
        this.pad(T + 1.6, [45, 57, 62, 66, 69], 1.6, 0.5);
        this.sub(T + 1.6, 38, 1.6, 0.4);
        return 3.4;
      }
      case 'match': {
        const T = t0 + 0.7;
        this.shimmer(t0, 0.7, 0.8);
        this.boom(T, 0.9); this.boom(T + 1.6, 0.55); this.boom(T + 2.4, 0.85);
        [74, 78, 81].forEach((m, k) => this.bell(T + k * 0.27, m, 0.42, 2.2));
        this.bell(T + 0.95, 86, 0.5, 3.2);
        this.pad(T, [50, 57, 62, 66], 0.95, 0.5, this.out, 0.06);
        this.pad(T + 0.8, [43, 55, 59, 62, 67], 0.95, 0.5);
        this.pad(T + 1.6, [45, 57, 61, 64, 69], 0.95, 0.55);
        this.pad(T + 2.4, [38, 50, 57, 62, 66, 69], 2.6, 0.6, this.out, 0.1);
        [74, 78, 81, 86].forEach((m) => this.bell(T + 2.4, m, 0.22, 3.4));
        [86, 81, 78, 74, 69].forEach((m, k) => this.pluck(T + 2.45 + k * 0.07, m, 0.4));
        this.sub(T + 2.4, 38, 2.4, 0.6);
        this.shimmer(T + 1.9, 0.5, 0.4);
        return 5.6;
      }
      default: return 0;
    }
  }

  // ------------------------------------------------------------ Titel-Pad
  /** Ambient-Pad im Titelbildschirm an/aus (weich ein-/ausgeblendet). */
  title(on) {
    if (!this.G) { this.titleOn = !!on; return; }
    const t = this.ac.currentTime;
    if (on && !this.titleOn) { this._next = t + 0.1; this._sparkNext = t + 2.5; }
    this.titleOn = !!on;
    this.titleBus.gain.setTargetAtTime(on ? 1 : 0, t, on ? 1.2 : 0.6);
  }
  update(dt) {
    if (!this.G || !this.titleOn) return;
    const now = this.ac.currentTime;
    if (this._next < now - 1) this._next = now + 0.1;
    // Akkorde mit Überlappung → nahtlos, endlos
    while (this._next < now + 1.2) {
      const ch = TITLE_CHORDS[this._idx++ % TITLE_CHORDS.length];
      this.pad(this._next, ch, 7.5, 0.5, this.titleBus, 2.4);
      this.sub(this._next, ch[0] - 12, 6, 0.25, this.titleBus);
      this._next += 6;
    }
    if (this._sparkNext < now - 1) this._sparkNext = now + 1;
    while (this._sparkNext < now + 0.5) {
      this.bell(this._sparkNext, pick(PENTA), rnd(0.1, 0.2), rnd(2, 3.5), this.titleBus);
      this._sparkNext += rnd(1.4, 3.8);
    }
  }
}

// Physikalisch motivierte Einzelklänge (Modalsynthese + gefilterte Rauschimpulse):
// Schlägertreffer, Ballaufsprung, Netz, Bande, Pfosten, Rollen, Schritte, Schwung, UI.
// Jede Methode: (t, params, pos) – t = AudioContext-Zeit, pos = Weltposition (oder null = Referenz/Mitte).
// Kein Klang ist zweimal identisch: alle Parameter werden leicht zufällig variiert.
// Pegel sind über das Audio-Labor (test/scenes/audio.js) auf Mischziele kalibriert → TRIM.
import { rnd, jit, clamp01, gainNode, filterNode, noiseSource, osc, envAD, mode, midiHz } from './dsp.js';

/** Pegel-Trims je Klangfamilie (lineare Faktoren, kalibriert gegen L100-Ziele im Audio-Labor). */
export const TRIM = {
  hit: 0.55, bounce: 0.4, net: 0.75, wall: 0.24, post: 0.23, roll: 0.5,
  step: 0.26, squeak: 0.5, whoosh: 0.33, toss: 0.11, ui: 0.22,
};

export class Sfx {
  constructor(G) { this.G = G; this.ac = G.ac; }

  /** Rauschimpuls mit Filterkette [[typ, f, q, gainDb?], …]. */
  _noise(dest, t, { kind = 'white', attack = 0.0005, amp = 1, tau = 0.004, hold = 0, filters = [], rate = 1 }) {
    const ac = this.ac;
    const dur = attack + hold + tau * 7 + 0.01;
    const s = noiseSource(ac, kind, t, dur, rate);
    let last = s;
    for (const f of filters) { const n = filterNode(ac, f[0], f[1], f[2] ?? 0.7, f[3] ?? 0); last.connect(n); last = n; }
    const g = ac.createGain();
    envAD(g.gain, t, attack, amp, tau, hold);
    last.connect(g); g.connect(dest);
    return g;
  }

  // ---------------------------------------------------------------- Schlägertreffer
  /**
   * Das ikonische "Pock" aus fünf Schichten:
   *  1. Kontakt-Klick: Filz trifft gespannte Saiten (1–2 ms Breitband, je härter desto heller)
   *  2. Ball-"Pock": Hohlkugel-Resonanz des Druckballs (~1.1–1.3 kHz, sehr kurz) – der Vokal-"o"-Charakter
   *  3. Saitenbett-Ping: Membranmoden (Kreismembran 1 : 1.59 : 2.14 : 2.30) um 540–640 Hz je nach Spannung/Tempo
   *  4. Rahmen: erste Biegemode (~150 Hz) – kaum bei Sweetspot-Treffern, kräftig bei Mis-Hits; Rahmentreffer
   *     klingen inharmonisch und "klonkig" (Rahmenmoden, kaum Saitenbett)
   *  5. Spin: Saiten bürsten über den Filz (Slice: weich & bürstig, Topspin: kurzes Zischeln)
   * p = { power 0..1, quality 'perfect'|'good'|'early'|'late'|'stretch'|'frame', kind 'ground'|'serve'|'volley'|'smash', slice, spin }
   */
  hit(t, p = {}, pos = null) {
    const ac = this.ac;
    const kind = p.kind || 'ground', q = p.quality || 'good';
    const power = clamp01(p.power ?? 0.6), slice = !!p.slice;
    const frame = q === 'frame', perfect = q === 'perfect', off = q === 'early' || q === 'late' || q === 'stretch';
    const volley = kind === 'volley', serve = kind === 'serve', smash = kind === 'smash';
    let level = (0.3 + 0.7 * power) * TRIM.hit;
    if (serve) level *= 0.9; else if (smash) level *= 1.05; else if (volley) level *= 0.95;
    if (perfect) level *= 0.9; if (frame) level *= 0.62; if (off) level *= 0.92; if (slice) level *= 0.85;
    if (p.strong) level *= 1.22;                     // starker Treffer (Treffer-Stopp): kräftiger
    level *= jit(1, 0.06);
    const out = this.G.strip('sfx', pos, level, serve || smash ? 0.32 : 0.26);
    // Härte des Kontakts: schneller Schlag → kürzerer Kontakt → hellerer Klick
    const hard = clamp01(0.3 + 0.7 * power) * (slice ? 0.65 : 1) * (frame ? 0.55 : 1) * (off ? 0.85 : 1);

    // 1) Kontakt-Klick
    this._noise(out, t, {
      amp: (0.65 + 0.7 * hard) * (perfect ? 1.2 : 1), attack: 0.00025, tau: (0.0019 - 0.0009 * hard) * jit(1, 0.15),
      filters: [['highpass', jit(650, 0.1), 0.6], ['peaking', jit(2600 + 1800 * hard, 0.08), 0.8, 5 + 3 * hard]],
    });
    // 2) Ball-Pock (Hohlkugel): Sinusmode + schmalbandiger Rauschanteil (macht es "hölzern-hohl" statt tonal)
    const fb = jit(1180, 0.06) * (1 + 0.07 * hard);
    const pa = (frame ? 0.25 : slice ? 0.42 : 0.6) * (0.75 + 0.35 * hard);
    mode(ac, out, t, fb, pa, jit(0.0075, 0.12), fb * 1.12, 0.004);
    mode(ac, out, t, fb * jit(2.05, 0.03), pa * 0.28, 0.004);
    this._noise(out, t, { amp: 2.2 * pa, attack: 0.0003, tau: 0.0055, filters: [['bandpass', fb, 3.2]] });

    // 3) Saitenbett-Ping
    if (!frame) {
      const fs = jit(slice ? 545 : 585, 0.04) * (off ? 0.94 : 1) * (1 + 0.05 * power);
      let a = perfect ? 0.36 : off ? 0.18 : 0.27;
      if (slice) a *= 0.7; if (volley) a *= 0.8;
      let tau = (perfect ? 0.022 : off ? 0.011 : 0.016) * jit(1, 0.1);
      if (volley) tau *= 0.7;
      mode(ac, out, t, fs, a, tau, fs * 1.04, 0.005);
      mode(ac, out, t, fs * jit(1.594, 0.01), a * 0.55, tau * 0.75);
      mode(ac, out, t, fs * jit(2.136, 0.01), a * 0.4, tau * 0.6);
      mode(ac, out, t, fs * jit(2.296, 0.01), a * 0.3, tau * 0.55);
      if (off) mode(ac, out, t, jit(1480, 0.05), 0.12, 0.016);   // Rahmen schwingt mit
    } else {
      // Rahmentreffer: inharmonische Rahmenmoden – "klonk" mit Nachschwingen
      mode(ac, out, t, jit(205, 0.06), 0.38, 0.04 * jit(1, 0.15), 290, 0.01);
      mode(ac, out, t, jit(1450, 0.05), 0.32, 0.028);
      mode(ac, out, t, jit(2380, 0.05), 0.24, 0.02);
      mode(ac, out, t, jit(3900, 0.05), 0.14, 0.012);
      mode(ac, out, t, jit(620, 0.05), 0.1, 0.012);
    }

    // 4) Rahmen-Thump (Biegemode)
    const fth = jit(150, 0.08);
    let ta = (0.08 + 0.16 * power) * (off ? 1.7 : 1) * (frame ? 1.6 : 1);
    if (smash) ta *= 2.0; else if (serve) ta *= 1.5; else if (volley) ta *= 0.8;
    mode(ac, out, t, fth, ta, (smash ? 0.022 : 0.014) * jit(1, 0.12), fth * 1.6, 0.007);
    // 4b) starker Treffer: tiefer Körper-Wumms (fällt von ~140 auf ~70 Hz)
    if (p.strong) mode(ac, out, t, jit(72, 0.05), 0.55, 0.05, 140, 0.03);

    // 5) Spin: Bürsten der Saiten über den Filz
    if (slice) this._noise(out, t, { amp: 0.16, attack: 0.003, hold: 0.006, tau: jit(0.016, 0.2), filters: [['bandpass', jit(3600, 0.12), 0.8]] });
    else if (!frame) this._noise(out, t + 0.0015, { amp: 0.06 + 0.06 * power, attack: 0.0015, tau: jit(0.008, 0.2), filters: [['bandpass', jit(5200, 0.12), 0.9]] });
    return 0.3;
  }

  // ---------------------------------------------------------------- Ball
  /**
   * Aufsprung. Rasen: gedämpftes "Tup" – Halme & Boden schlucken die Höhen, der Ball-Pock bleibt leise hörbar.
   * Umrandung/harter Boden: heller, mehr Hüllenresonanz und ein kurzer Klick.
   * p = { speed m/s, surface 'grass'|'hard', soft (Ball-Tippen vor dem Aufschlag) }
   */
  bounce(t, p = {}, pos = null) {
    const ac = this.ac;
    const v = clamp01(((p.speed ?? 14) - 1.5) / 26);
    const surface = p.surface || surfaceAt(pos);
    const level = (0.25 + 0.75 * Math.pow(v, 0.9)) * TRIM.bounce * jit(1, 0.08) * (p.soft ? 1.1 : 1);
    const out = this.G.strip('sfx', pos, level, 0.16);
    const fb = jit(1080, 0.06);
    if (surface === 'grass') {
      const f = jit(235, 0.08);
      mode(ac, out, t, f, 0.5, jit(0.011, 0.15), f * 1.45, 0.007);                                   // Boden-Thud
      this._noise(out, t, { amp: 1.1, attack: 0.0006, tau: jit(0.0055, 0.15), filters: [['lowpass', jit(1100 + 700 * v, 0.12), 0.7]] });
      mode(ac, out, t, fb, 0.16 + 0.12 * v, 0.0045, fb * 1.1, 0.003);                                 // gedämpfter Pock
      this._noise(out, t, { amp: 0.7, attack: 0.0004, tau: 0.004, filters: [['bandpass', fb, 2.5]] });
      this._noise(out, t + 0.001, { amp: 0.05 + 0.05 * v, attack: 0.002, tau: 0.012, filters: [['bandpass', jit(5200, 0.15), 0.8]] });   // Halme
    } else {
      const f = jit(260, 0.08);
      mode(ac, out, t, f, 0.35, 0.009, f * 1.4, 0.006);
      this._noise(out, t, { amp: 0.6, attack: 0.0003, tau: 0.0018, filters: [['highpass', 900, 0.7], ['peaking', jit(3000, 0.1), 0.8, 4]] });
      mode(ac, out, t, fb * 1.08, 0.42, 0.0075, fb * 1.2, 0.004);
      this._noise(out, t, { amp: 1.4, attack: 0.0003, tau: 0.005, filters: [['bandpass', fb * 1.08, 3]] });
    }
    return 0.12;
  }

  /** Netz: cord = Netzkante (Tick + Rattern), sonst Ball ins Netz (dumpfer Thump + Rattern). */
  net(t, p = {}, pos = null) {
    const ac = this.ac;
    const v = clamp01(((p.speed ?? 20) - 3) / 30);
    const level = (0.3 + 0.7 * v) * TRIM.net * jit(1, 0.08) * (p.cord ? 1.12 : 1);
    const out = this.G.strip('sfx', pos, level, 0.24);
    if (p.cord) {
      // Netzband (Kunststoff über Stahlseil): heller Tick, Ball-Pock, leise klingendes Seil, Rattern der Maschen
      this._noise(out, t, { amp: 0.9, attack: 0.0003, tau: 0.0014, filters: [['highpass', 1800, 0.7], ['peaking', 3800, 1, 5]] });
      mode(ac, out, t, jit(1150, 0.05), 0.35, 0.006, 1300, 0.003);
      mode(ac, out, t, jit(2350, 0.05), 0.2, 0.005);
      mode(ac, out, t, jit(640, 0.08), 0.2, 0.012);
      mode(ac, out, t, jit(392, 0.03), 0.05, 0.16, 0, 0, 'triangle');   // Netzkabel
      this._rattle(out, t + 0.004, 0.55, jit(0.32, 0.15));
    } else {
      this._noise(out, t, { amp: 0.9, attack: 0.002, tau: jit(0.018, 0.15), filters: [['lowpass', jit(900, 0.12), 0.8]] });
      mode(ac, out, t, jit(125, 0.1), 0.45, 0.026, 175, 0.012);
      mode(ac, out, t, jit(1000, 0.06), 0.14, 0.005);
      this._rattle(out, t + 0.008, 0.85, jit(0.5, 0.15));
    }
    return 0.7;
  }
  /** Netzmaschen-Rattern: Rauschen, amplitudenmoduliert (viele kleine Schnurkontakte), abklingend. */
  _rattle(dest, t, amp, dur) {
    const ac = this.ac;
    const n = noiseSource(ac, 'white', t, dur * 2.2);
    const bp = filterNode(ac, 'bandpass', jit(1250, 0.15), 0.7);
    const am = gainNode(ac, 0.5);
    const lfo = ac.createOscillator(); lfo.type = 'square';
    lfo.frequency.setValueAtTime(jit(46, 0.15), t); lfo.frequency.exponentialRampToValueAtTime(jit(22, 0.15), t + dur * 2);
    const lg = gainNode(ac, 0.45); lfo.connect(lg); lg.connect(am.gain);
    lfo.start(t); lfo.stop(t + dur * 2.2);
    const env = ac.createGain(); envAD(env.gain, t, 0.004, amp, dur / 4.5);
    n.connect(bp); bp.connect(am); am.connect(env); env.connect(dest);
    // feines Maschen-Zischeln
    this._noise(dest, t, { amp: amp * 0.3, attack: 0.008, tau: dur / 5, filters: [['highpass', 3500, 0.7]] });
  }

  /** Ball gegen Bande/Rückwand: hölzernes Klopfen (Plattenmoden). */
  wall(t, p = {}, pos = null) {
    const ac = this.ac;
    const v = clamp01(((p.speed ?? 15) - 2) / 25);
    const out = this.G.strip('sfx', pos, (0.25 + 0.75 * v) * TRIM.wall * jit(1, 0.08), 0.3);
    this._noise(out, t, { amp: 0.7, attack: 0.0004, tau: 0.002, filters: [['bandpass', jit(2400, 0.1), 0.9]] });
    mode(ac, out, t, jit(185, 0.06), 0.45, 0.03, 240, 0.01);
    mode(ac, out, t, jit(420, 0.06), 0.4, 0.024);
    mode(ac, out, t, jit(880, 0.06), 0.3, 0.015);
    mode(ac, out, t, jit(1150, 0.05), 0.25, 0.006);   // Ball-Pock
    mode(ac, out, t, jit(1740, 0.06), 0.15, 0.009);
    return 0.3;
  }

  /** Ball gegen Netzpfosten (Stahlrohr): metallisches "Tonk" mit inharmonischen Rohrmoden. */
  post(t, p = {}, pos = null) {
    const ac = this.ac;
    const v = clamp01(((p.speed ?? 15) - 2) / 25);
    const out = this.G.strip('sfx', pos, (0.25 + 0.75 * v) * TRIM.post * jit(1, 0.08), 0.3);
    this._noise(out, t, { amp: 0.6, attack: 0.0003, tau: 0.0015, filters: [['bandpass', jit(3000, 0.1), 0.8]] });
    const f = jit(540, 0.05);
    mode(ac, out, t, jit(170, 0.06), 0.4, 0.016, 240, 0.008);   // Ball-Thump
    mode(ac, out, t, jit(1150, 0.05), 0.25, 0.006);             // Ball-Pock
    mode(ac, out, t, f, 0.22, 0.2);
    mode(ac, out, t, f * 2.76, 0.16, 0.12);
    mode(ac, out, t, f * 5.4, 0.08, 0.07);
    mode(ac, out, t, f * 8.93, 0.04, 0.045);
    return 0.6;
  }

  /** Ball rollt über den Rasen aus: leises, pulsierendes Rascheln, das langsamer wird. p = { speed, dur } */
  roll(t, p = {}, pos = null) {
    const ac = this.ac;
    const speed = Math.max(0.3, p.speed ?? 3), dur = p.dur ?? 1.6;
    const out = this.G.strip('sfx', pos, (0.5 + 0.5 * Math.min(1, speed / 6)) * TRIM.roll * 0.25, 0.1);
    const n = noiseSource(ac, 'pink', t, dur + 0.2);
    const bp = filterNode(ac, 'bandpass', jit(1500, 0.15), 0.6);
    const am = gainNode(ac, 0.6);
    const lfo = ac.createOscillator();
    lfo.frequency.setValueAtTime(speed * 4.75, t); lfo.frequency.exponentialRampToValueAtTime(Math.max(0.5, speed * 0.6), t + dur);
    const lg = gainNode(ac, 0.4); lfo.connect(lg); lg.connect(am.gain); lfo.start(t); lfo.stop(t + dur + 0.2);
    const env = ac.createGain();
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(1, t + 0.05); env.gain.setTargetAtTime(0, t + dur * 0.3, dur / 3);
    n.connect(bp); bp.connect(am); am.connect(env); env.connect(out);
    return dur;
  }

  // ---------------------------------------------------------------- Spieler
  /**
   * Schritt auf Rasen: dumpfer Sohlen-Stoß (Erde gibt nach) + Halme knicken/Sohle wischt (weiches Rauschen
   * 1.5–4 kHz). p = { intensity 0..1, surface }
   */
  footstep(t, p = {}, pos = null) {
    const ac = this.ac;
    const i = clamp01(p.intensity ?? 0.5);
    const out = this.G.strip('sfx', pos, (0.3 + 0.7 * i) * TRIM.step * jit(1, 0.15), 0.06);
    const f = jit(120, 0.12);
    mode(ac, out, t, f, 0.3, 0.016, f * 1.5, 0.008);
    this._noise(out, t, { amp: 0.9, attack: jit(0.0015, 0.3), tau: jit(0.01, 0.25), filters: [['lowpass', jit(520, 0.2), 0.8]] });
    // Halme: leicht verzögert und länger
    this._noise(out, t + rnd(0.002, 0.01), { amp: 0.32 * (0.5 + i), attack: jit(0.005, 0.3), tau: jit(0.022, 0.25), filters: [['bandpass', jit(2600, 0.25), 0.7]] });
    if ((p.surface || surfaceAt(pos)) === 'hard') this._noise(out, t, { amp: 0.25, attack: 0.0004, tau: 0.002, filters: [['highpass', 2500, 0.7]] });
    return 0.1;
  }
  /** Split-Step: beide Füße landen fast gleichzeitig. */
  splitStep(t, p = {}, pos = null) {
    this.footstep(t, { intensity: 0.7 }, pos);
    this.footstep(t + rnd(0.012, 0.03), { intensity: 0.55 }, pos);
    return 0.12;
  }
  /** Schnelle kleine Seitwärts-Schritte (Shuffle). */
  shuffle(t, p = {}, pos = null) {
    const n = 2 + (Math.random() * 2 | 0);
    for (let k = 0; k < n; k++) this.footstep(t + k * rnd(0.07, 0.11), { intensity: 0.4 }, pos);
    return 0.35;
  }
  /** Schuh-Quietschen/Rutschen bei hartem Abstoppen (auf Rasen selten und kurz). */
  squeak(t, p = {}, pos = null) {
    const ac = this.ac;
    const d = jit(0.14, 0.25);
    const out = this.G.strip('sfx', pos, (0.4 + 0.6 * clamp01(p.intensity ?? 0.6)) * TRIM.squeak, 0.15);
    // Rutschen über Rasen (Rauschen, das heller wird) + kurzer Gummi-Quietscher
    const n = noiseSource(ac, 'white', t, d + 0.1);
    const bp = filterNode(ac, 'bandpass', 1300, 3);
    bp.frequency.setValueAtTime(jit(1100, 0.1), t); bp.frequency.exponentialRampToValueAtTime(jit(2400, 0.1), t + d);
    const g = ac.createGain(); envAD(g.gain, t, 0.015, 0.6, d / 3, d * 0.4);
    n.connect(bp); bp.connect(g); g.connect(out);
    const o = osc(ac, 'sine', jit(2700, 0.08), t, d + 0.1, jit(1900, 0.08), d * 0.8);
    const fm = ac.createOscillator(); fm.frequency.value = jit(42, 0.2);
    const fg = gainNode(ac, 110); fm.connect(fg); fg.connect(o.frequency); fm.start(t); fm.stop(t + d + 0.1);
    const og = gainNode(ac, 0); envAD(og.gain, t + 0.02, 0.01, 0.05, d / 3, d * 0.3);   // Start 0: Oszillator läuft schon ab t
    o.connect(og); og.connect(out);
    return d;
  }
  /** Schlägerschwung: Luftrauschen, Spitze am Treffpunkt tc. p = { power, dur } */
  whoosh(tc, p = {}, pos = null) {
    const ac = this.ac;
    const power = clamp01(p.power ?? 0.6), dur = (p.dur ?? 0.26) * jit(1, 0.1);
    const t = Math.max(ac.currentTime, tc - dur * 0.72);
    const out = this.G.strip('sfx', pos, (0.2 + 0.8 * power) * TRIM.whoosh * 0.5, 0.1);
    const n = noiseSource(ac, 'pink', t, dur + 0.15);
    const bp = filterNode(ac, 'bandpass', 380, 1.2);
    bp.frequency.setValueAtTime(jit(340, 0.1), t);
    bp.frequency.exponentialRampToValueAtTime(jit(1300 + 900 * power, 0.1), tc);
    bp.frequency.exponentialRampToValueAtTime(jit(600, 0.1), tc + dur * 0.4);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, tc); g.gain.setTargetAtTime(0, tc, 0.035);
    n.connect(bp); bp.connect(g); g.connect(out);
    return dur;
  }
  /** Aufwurf: leises "Fwip" der Wurfhand + Ball verlässt die Finger. */
  toss(t, p = {}, pos = null) {
    const out = this.G.strip('sfx', pos, TRIM.toss, 0.1);
    this._noise(out, t, { kind: 'pink', amp: 0.8, attack: 0.025, tau: 0.04, filters: [['bandpass', jit(1800, 0.15), 0.9]] });
    return 0.15;
  }

  // ---------------------------------------------------------------- UI
  /** Weiche, moderne UI-Klänge (ohne Hall, nicht vom Pausenfilter betroffen). */
  ui(name, t = this.ac.currentTime) {
    const ac = this.ac, dest = this.G.bus.ui;
    const out = gainNode(ac, TRIM.ui); out.connect(dest);
    const note = (tt, m, a, tau, type = 'sine') => { const f = midiHz(m); mode(ac, out, tt, f, a, tau, 0, 0, type); mode(ac, out, tt, f * 2, a * 0.18, tau * 0.4); };
    const click = (tt, a = 0.06) => this._noise(out, tt, { amp: a, attack: 0.0003, tau: 0.0009, filters: [['highpass', 3500, 0.7]] });
    switch (name) {
      case 'hover': mode(ac, out, t, jit(2000, 0.02), 0.12, 0.008); break;
      case 'move': note(t, 84 + (Math.random() < 0.5 ? 0 : 0.15), 0.3, 0.02); click(t, 0.05); break;
      case 'select': note(t, 81, 0.16, 0.07); note(t + 0.055, 88, 0.17, 0.1); click(t); break;
      case 'back': note(t, 88, 0.15, 0.06); note(t + 0.055, 81, 0.16, 0.09); click(t); break;
      case 'toggle': note(t, 86, 0.22, 0.015); note(t + 0.04, 86, 0.16, 0.015); break;
      case 'start': {
        [74, 78, 81, 86, 90].forEach((m, k) => note(t + k * 0.045, m, 0.135 - k * 0.012, 0.28));
        this._noise(out, t, { amp: 0.06, attack: 0.12, tau: 0.25, filters: [['bandpass', 6500, 0.8]] });
        break;
      }
      case 'pause': {
        mode(ac, out, t, 260, 0.22, 0.09, 520, 0.12);
        this._noise(out, t, { amp: 0.15, attack: 0.002, tau: 0.02, filters: [['lowpass', 420, 0.7]] });
        break;
      }
      case 'resume': mode(ac, out, t, 520, 0.24, 0.09, 260, 0.1); click(t, 0.04); break;
      case 'error': note(t, 55, 0.22, 0.08, 'triangle'); note(t + 0.09, 54, 0.22, 0.1, 'triangle'); break;
      case 'tick': mode(ac, out, t, 1760, 0.22, 0.008); break;
      case 'score': note(t, 86, 0.12, 0.2); note(t + 0.07, 93, 0.1, 0.24); break;
      default: note(t, 84, 0.12, 0.02);
    }
    return 0.4;
  }
}

/** Untergrund an einer Position: Platz-Rasen vs. hellerer Auslauf/Umrandung. */
export function surfaceAt(pos) {
  if (!pos) return 'grass';
  return Math.abs(pos[0]) <= 6.2 && Math.abs(pos[2]) <= 13.2 ? 'grass' : 'hard';
}

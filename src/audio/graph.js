// Mischpult: Busse (sfx / crowd / voice / music / ui), Stadion-Hall, Bus-Kompressor, Soft-Limiter,
// Pausen-Tiefpass und eine einfache "Broadcast-Mikrofon"-Räumlichkeit (Panorama, Entfernung, Luftdämpfung).
// Funktioniert mit AudioContext und OfflineAudioContext (Testszene rendert denselben Graphen offline).
import { noiseBank, bufferFrom, gainNode, filterNode } from './dsp.js';
import { stadiumIR, plateIR } from './reverb.js';

export const BUSES = ['sfx', 'crowd', 'voice', 'music', 'ui'];

// Impulsantworten je Abtastrate nur einmal berechnen (AudioBuffer sind kontextunabhängig)
const irCache = new Map();
function irBuffer(ac, kind) {
  const key = kind + ac.sampleRate;
  let b = irCache.get(key);
  if (!b) { b = bufferFrom(ac, kind === 'plate' ? plateIR(ac.sampleRate) : stadiumIR(ac.sampleRate), ac.sampleRate); irCache.set(key, b); }
  return b;
}

/** Weiche Sättigungskurve: linear bis 0.9, darüber tanh-Knie bis max. 1.0 (Eingang ±2 abgebildet). */
function softClipCurve(n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = (i / (n - 1)) * 4 - 2;  // Eingang nach 0.5-Vorverstärkung → tatsächlich ±2
    const a = Math.abs(u);
    const y = a <= 0.9 ? a : 0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1);
    c[i] = Math.sign(u) * y;
  }
  return c;
}

export class AudioGraph {
  /**
   * @param {BaseAudioContext} ac
   * @param {object} [opts] { limiter=true, destination, reverb=true }
   */
  constructor(ac, opts = {}) {
    this.ac = ac;
    this.sr = ac.sampleRate;
    this.noise = noiseBank(ac);
    this.listener = { pos: [0, 7.5, 21.5], dir: [0, -0.33, -0.94], right: [1, 0, 0] };

    // Ausgang: masterIn → Pausen-Tiefpass → post → DC/Subsonic-Hochpass → Bus-Kompressor ("Glue") → Soft-Clip → out → Ziel
    // Der Kompressor greift nur bei lauten Spitzen (Aufschlag, Jubel); Chrome addiert automatisch Makeup-Gain
    // (≈ +2 dB bei diesen Werten) – in den Pegel-Trims der Klänge berücksichtigt (Audio-Labor misst nach der Kette).
    this.out = gainNode(ac, 1);
    this.out.connect(opts.destination || ac.destination);
    this.post = gainNode(ac, 1);
    const hpf = filterNode(ac, 'highpass', 24, 0.6);
    this.post.connect(hpf);
    if (opts.limiter !== false) {
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 2.5;
      comp.attack.value = 0.003; comp.release.value = 0.25;
      const pre = gainNode(ac, 0.5);
      const clip = ac.createWaveShaper(); clip.curve = softClipCurve(); clip.oversample = '2x';
      hpf.connect(comp); comp.connect(pre); pre.connect(clip); clip.connect(this.out);
      this.comp = comp;
    } else hpf.connect(this.out);

    this.pauseLP = filterNode(ac, 'lowpass', 20000, 0.5);
    this.masterIn = gainNode(ac, 1);
    this.masterIn.connect(this.pauseLP); this.pauseLP.connect(this.post);

    // Busse + je ein Hall-Send-Bus (gleiche Lautstärke wie der Bus, damit Hall mit dem Fader geht)
    this.bus = {}; this.wet = {};
    for (const name of BUSES) {
      const b = gainNode(ac, 1);
      b.connect(name === 'ui' ? this.post : this.masterIn);  // UI umgeht den Pausenfilter
      this.bus[name] = b;
      if (name !== 'ui') this.wet[name] = gainNode(ac, 1);
    }

    // Stadion-Hall
    this.reverbIn = gainNode(ac, 1);
    if (opts.reverb !== false) {
      const conv = ac.createConvolver(); conv.normalize = false;
      conv.buffer = irBuffer(ac, 'stadium');
      const hp = filterNode(ac, 'highpass', 170, 0.6);
      this.reverbOut = gainNode(ac, 1);
      this.reverbIn.connect(conv); conv.connect(hp); hp.connect(this.reverbOut); this.reverbOut.connect(this.masterIn);
      for (const name of ['sfx', 'crowd', 'voice']) this.wet[name].connect(this.reverbIn);
      // Musik bekommt einen eigenen, weicheren Hall
      const plate = ac.createConvolver(); plate.normalize = false;
      plate.buffer = irBuffer(ac, 'plate');
      const php = filterNode(ac, 'highpass', 220, 0.6);
      this.wet.music.connect(plate); plate.connect(php); php.connect(this.masterIn);
    }
    this._sp = { pan: 0, gain: 1, cutoff: 20000, wet: 1, dist: 0 };
  }

  setListener(pos, dir) {
    const L = this.listener;
    if (pos) { L.pos[0] = pos[0]; L.pos[1] = pos[1]; L.pos[2] = pos[2]; }
    if (dir) {
      const h = Math.hypot(dir[0], dir[2]);
      if (h > 1e-4) { L.dir[0] = dir[0]; L.dir[1] = dir[1]; L.dir[2] = dir[2]; L.right[0] = -dir[2] / h; L.right[1] = 0; L.right[2] = dir[0] / h; }
    }
  }

  /** Räumliche Parameter für eine Weltposition (allokationsfrei; Ergebnisobjekt wird wiederverwendet). */
  spatial(pos) {
    const s = this._sp;
    if (!pos) { s.pan = 0; s.gain = 1; s.cutoff = 20000; s.wet = 1; s.dist = 0; return s; }
    const L = this.listener;
    const rx = pos[0] - L.pos[0], ry = (pos[1] ?? 0) - L.pos[1], rz = pos[2] - L.pos[2];
    const d = Math.hypot(rx, ry, rz);
    const lat = rx * L.right[0] + rz * L.right[2];
    // Broadcast-Mischung: Platzmikrofone halten auch ferne Schläge präsent → sanfte Abschwächung
    s.dist = d;
    s.pan = Math.max(-0.82, Math.min(0.82, (lat / Math.max(d, 3)) * 1.25));
    s.gain = d <= 6 ? 1 : 1 / (1 + (d - 6) / 15);
    s.cutoff = 19000 / (1 + d / 28);
    s.wet = 0.65 + d / 30;
    return s;
  }

  /**
   * Kanalzug für einen Einzelklang: input → [Tiefpass] → Panner → Bus (+ Hall-Send).
   * @returns {GainNode} Eingang (gain enthält bereits die Entfernungsdämpfung × gain)
   */
  strip(busName, pos, gain = 1, send = 0.2) {
    const ac = this.ac, sp = this.spatial(pos);
    const input = gainNode(ac, gain * sp.gain);
    let last = input;
    if (sp.cutoff < 15000) { const f = filterNode(ac, 'lowpass', sp.cutoff, 0.5); input.connect(f); last = f; }
    const p = ac.createStereoPanner(); p.pan.value = sp.pan;
    last.connect(p); p.connect(this.bus[busName]);
    if (send > 0 && this.wet[busName]) { const s = gainNode(ac, send * sp.wet); p.connect(s); s.connect(this.wet[busName]); }
    return input;
  }

  /** Kanalzug mit festem Panorama (ohne Weltposition). */
  stripPan(busName, pan, gain = 1, send = 0.2, cutoff = 0) {
    const ac = this.ac;
    const input = gainNode(ac, gain);
    let last = input;
    if (cutoff > 0) { const f = filterNode(ac, 'lowpass', cutoff, 0.5); input.connect(f); last = f; }
    const p = ac.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan));
    last.connect(p); p.connect(this.bus[busName]);
    if (send > 0 && this.wet[busName]) { const s = gainNode(ac, send); p.connect(s); s.connect(this.wet[busName]); }
    return input;
  }

  /** Bus-Lautstärke (inkl. Hall-Send) weich setzen. */
  setBusGain(name, v, tau = 0.05) {
    const t = this.ac.currentTime;
    this.bus[name]?.gain.setTargetAtTime(v, t, tau);
    this.wet[name]?.gain.setTargetAtTime(v, t, tau);
  }
}

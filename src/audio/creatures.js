// Figuren-Stimmen: Gerrys Miauen/Trillern/Schnurren/Grummeln/Fauchen und Toms Ausatmen bei harten
// Schlägen. Formant-Synthese (siehe voice.js) mit Tonhöhen-Gleiten; sparsam eingesetzt.
import { rnd, jit, clamp01, noiseSource, filterNode, gainNode, envAD } from './dsp.js';
import { vocal } from './voice.js';

// Pegel je Laut (kalibriert im Audio-Labor: Miauen ≈ 1 dB unter einem Grundschlag, Rest leiser)
const LV = { meow: 0.065, grumble: 0.11, hiss: 0.044, purr: 0.09, exhale: 0.26 };

export class Creatures {
  constructor(G) { this.G = G; this.ac = G.ac; }

  /**
   * Gerry miaut. kind: 'happy' ("mi-aa-ou"), 'trill' ("mrrr-iau", freudig), 'mew' (kurz, niedlich), 'proud' (lang, Sieg).
   */
  meow(t, kind = 'happy', pos = null) {
    const out = this.G.strip('voice', pos, LV.meow * jit(1, 0.08) * (kind === 'mew' ? 0.85 : kind === 'proud' ? 1.1 : 1), 0.22);
    const k = jit(1, 0.07);
    if (kind === 'mew') {
      const d = rnd(0.22, 0.32);
      return vocal(this.ac, out, t, {
        dur: d, tilt: 1.05, scale: 1.62, breath: 0.05, vibrato: [7, 14], jitter: 5, bw: [130, 170, 240], fgain: [1, 0.9, 0.5],
        f0: [[0, 620 * k], [0.06, 880 * k], [d * 0.7, 820 * k], [d, 690 * k]],
        vowels: [[0, 'i', 0.01], [0.06, 'e', 0.03], [d * 0.6, 'ae', 0.04]],
        amp: [[0, 0], [0.03, 0.8], [d * 0.6, 0.9], [d, 0]],
        lp: [[0, 2500], [0.05, 8000], [d * 0.8, 4000]],
      }) - t;
    }
    const proud = kind === 'proud', trill = kind === 'trill' || proud;
    const d = proud ? rnd(0.95, 1.15) : rnd(0.58, 0.78);
    const tr = trill ? rnd(0.14, 0.2) : 0;   // "mrrr"-Vorschlag
    const pk = (proud ? 820 : 760) * k * jit(1, 0.04);
    return vocal(this.ac, out, t, {
      dur: d + tr, tilt: 1.1, scale: 1.45, breath: 0.06, vibrato: [6.5, proud ? 26 : 18], jitter: 6,
      bw: [120, 160, 220], fgain: [1, 0.85, 0.5],
      rough: trill ? { rate: jit(27, 0.1), depth: 0.85, from: 0, to: tr } : null,
      f0: [[0, 400 * k], [tr + 0.06, 520 * k], [tr + d * 0.35, pk], [tr + d * 0.6, pk * 0.92], [tr + d * 0.9, 480 * k], [tr + d, 420 * k]],
      vowels: [[0, 'm', 0.01], [tr + 0.05, 'i', 0.03], [tr + d * 0.3, 'ae', 0.05], [tr + d * 0.5, 'a', 0.05], [tr + d * 0.72, 'o', 0.05], [tr + d * 0.88, 'u', 0.04]],
      amp: [[0, 0], [0.025, 0.3], [tr + 0.07, 0.45], [tr + 0.12, 1], [tr + d * 0.7, 0.9], [tr + d * 0.93, 0.15], [tr + d, 0]],
      lp: [[0, 900], [tr + 0.08, 7000], [tr + d * 0.75, 5000], [tr + d * 0.92, 1800]],
    }) - t;
  }

  /** Kleines unzufriedenes Grummeln ("mrrrm") mit geschlossenem Maul. */
  grumble(t, pos = null) {
    const out = this.G.strip('voice', pos, LV.grumble * jit(1, 0.1), 0.18);
    const d = rnd(0.5, 0.75), k = jit(1, 0.08);
    return vocal(this.ac, out, t, {
      dur: d, tilt: 0.9, scale: 1.35, breath: 0.1, jitter: 10, bw: [110, 150, 220],
      rough: { rate: jit(33, 0.12), depth: 0.9 },
      f0: [[0, 205 * k], [d * 0.3, 235 * k], [d, 172 * k]],
      vowels: [[0, 'm', 0.01], [d * 0.5, 'u', 0.08]],
      amp: [[0, 0], [0.08, 0.8], [d * 0.6, 1], [d, 0]],
      lp: [[0, 750], [d * 0.4, 1100], [d, 700]],
    }) - t;
  }

  /** Fauchen (selten): Luftstrom durch gefletschte Zähne. */
  hiss(t, pos = null) {
    const ac = this.ac;
    const out = this.G.strip('voice', pos, LV.hiss, 0.2);
    const d = rnd(0.45, 0.65);
    const n = noiseSource(ac, 'white', t, d + 0.3);
    const hp = filterNode(ac, 'highpass', 2200, 0.7), pk = filterNode(ac, 'peaking', jit(5600, 0.1), 1.2, 9);
    const am = gainNode(ac, 0.8);
    const lfo = ac.createOscillator(); lfo.frequency.value = jit(60, 0.2);
    const lg = gainNode(ac, 0.2); lfo.connect(lg); lg.connect(am.gain); lfo.start(t); lfo.stop(t + d + 0.3);
    const g = ac.createGain(); envAD(g.gain, t, 0.04, 0.9, 0.07, d - 0.1);
    n.connect(hp); hp.connect(pk); pk.connect(am); am.connect(g); g.connect(out);
    return d + 0.2;
  }

  /** Schnurren: tiefe Pulsfolge (~26 Hz) durch geschlossenen Vokaltrakt, Atemzyklen. */
  purr(t, dur = 2.4, pos = null) {
    const out = this.G.strip('voice', pos, LV.purr, 0.12);
    const amp = [[0, 0]], f0 = [[0, jit(25, 0.08)]];
    const cyc = rnd(0.7, 0.85);
    let tt = 0, inhale = false;
    while (tt < dur - 0.1) {
      const a = inhale ? 0.55 : 1;
      amp.push([tt + 0.12, a]); amp.push([tt + cyc - 0.12, a * 0.9]); amp.push([tt + cyc - 0.02, 0.15]);
      f0.push([tt + cyc * 0.5, jit(inhale ? 22 : 27, 0.05)]);
      tt += cyc; inhale = !inhale;
    }
    amp.push([tt + 0.08, 0]);
    return vocal(this.ac, out, t, {
      dur: tt + 0.1, tilt: 0.5, scale: 1.3, breath: 0.25, jitter: 20, bw: [120, 180, 250], fgain: [1, 0.5, 0.25],
      f0, vowels: [[0, 'm']], amp, lp: [[0, 650]], gain: 1.4,
    }) - t;
  }

  /** Toms Ausatmen bei harten Schlägen ("hah"): überwiegend Hauch, wenig Stimme, kurz. */
  exhale(t, power = 0.8, pos = null) {
    const p = clamp01(power);
    const out = this.G.strip('voice', pos, LV.exhale * (0.5 + 0.5 * p), 0.15);
    const d = rnd(0.2, 0.28);
    return vocal(this.ac, out, t, {
      dur: d, tilt: 1.5, scale: jit(1, 0.04), voiced: 0.3 + 0.25 * p, jitter: 12,
      breath: [[0, 1.4], [d * 0.5, 0.9], [d, 0.5]],
      f0: [[0, jit(150, 0.08)], [d, jit(112, 0.08)]],
      vowels: [[0, 'A'], [d * 0.6, 'a', 0.05]],
      amp: [[0, 0], [0.012, 1], [0.07, 0.75], [d, 0]],
      lp: [[0, 3500], [d, 1800]],
    }) - t;
  }
}

// Formant-Stimmsynthese (Quelle-Filter-Modell): Glottis-Welle + Hauchrauschen → drei parallele
// Formantfilter (Vokaltrakt) → Hüllkurve. Grundlage für Publikumsstimmen, Rufe, Linienrichter-
// Ersatzruf und Gerrys Miauen. Funktioniert mit jedem BaseAudioContext.
import { glottalWave, noiseSource, gainNode, filterNode, rnd, jit, pick } from './dsp.js';

// Formanten (Hz) erwachsener Männerstimme (Peterson & Barney, gerundet). Frauen: scale ≈ 1.17.
export const VOWELS = {
  i: [270, 2290, 3010], I: [390, 1990, 2550], e: [530, 1840, 2480], ae: [660, 1720, 2410],
  a: [730, 1090, 2440], o: [570, 840, 2410], U: [440, 1020, 2240], u: [300, 870, 2240],
  A: [640, 1190, 2390], er: [490, 1350, 1690],
  // Näherungen für Nasale/Liquide (stark gedämpft über amp/lp)
  m: [280, 1000, 2200], n: [280, 1650, 2550], l: [380, 950, 2600],
};
const BABBLE_VOWELS = ['a', 'e', 'i', 'o', 'u', 'A', 'ae', 'I', 'U', 'er', 'e', 'A', 'a'];
const EXCITED_VOWELS = ['a', 'ae', 'e', 'A', 'o', 'a', 'ae', 'i'];

const fOf = (v, k, scale) => (typeof v === 'string' ? (VOWELS[v] || VOWELS.A)[k] : v[k]) * scale;

/**
 * Spielt eine synthetische Stimme. Zeiten in spec sind relativ zu t0 (Sekunden).
 * spec = { dur, f0:[[t,hz]…], vowels:[[t,vokal|[F1,F2,F3],tau?]…], amp:[[t,a]…],
 *          breath: Zahl | [[t,a]…], voiced: Zahl (Stimmanteil, Std. 1), tilt: 1.3, scale: 1,
 *          bw:[F1,F2,F3 Bandbreite Hz], fgain:[…], vibrato:[Hz,Cent], jitter: Cent,
 *          rough:{rate,depth,from,to}, fric:[{t,dur,f,q,amp}], lp:[[t,hz]…], gain }
 * @returns {number} Endzeit (absolut)
 */
export function vocal(ac, dest, t0, spec) {
  const dur = spec.dur;
  const tEnd = t0 + dur + 0.08;
  const scale = spec.scale ?? 1;
  const out = gainNode(ac, 1);
  const gain = spec.gain ?? 1;

  // --- Quelle
  const src = ac.createOscillator();
  src.setPeriodicWave(glottalWave(ac, spec.tilt ?? 1.3));
  const f0 = spec.f0;
  src.frequency.setValueAtTime(f0[0][1], t0 + f0[0][0]);
  for (let i = 1; i < f0.length; i++) src.frequency.exponentialRampToValueAtTime(Math.max(10, f0[i][1]), t0 + f0[i][0]);
  src.start(t0); src.stop(tEnd);
  if (spec.vibrato && spec.vibrato[1] > 0) {
    const lfo = ac.createOscillator(); lfo.frequency.value = jit(spec.vibrato[0], 0.1);
    const lg = gainNode(ac, spec.vibrato[1]);
    lfo.connect(lg); lg.connect(src.detune); lfo.start(t0); lfo.stop(tEnd);
  }
  if ((spec.jitter ?? 0) > 0) {
    // langsames Zittern der Tonhöhe (natürlicher als reines Vibrato)
    const n = noiseSource(ac, 'brown', t0, dur + 0.08, 0.5 + Math.random() * 0.5);
    const ng = gainNode(ac, spec.jitter * 3);
    n.connect(ng); ng.connect(src.detune);
  }
  const voiced = gainNode(ac, spec.voiced ?? 1);
  src.connect(voiced);

  // --- Hauch (Aspiration) durch denselben Vokaltrakt
  const br = spec.breath ?? 0.05;
  const breath = gainNode(ac, typeof br === 'number' ? br : 0);
  if (typeof br !== 'number') { breath.gain.setValueAtTime(br[0][1], t0 + br[0][0]); for (let i = 1; i < br.length; i++) breath.gain.linearRampToValueAtTime(br[i][1], t0 + br[i][0]); }
  if (br !== 0) { const ns = noiseSource(ac, 'white', t0, dur + 0.08); ns.connect(breath); }

  // --- Formanten
  const bw = spec.bw || [90, 110, 160];
  const fg = spec.fgain || [1, 0.75, 0.4];
  const vw = spec.vowels;
  const sum = gainNode(ac, 1);
  for (let k = 0; k < 3; k++) {
    const f = ac.createBiquadFilter(); f.type = 'bandpass';
    const fv0 = fOf(vw[0][1], k, scale);
    f.frequency.setValueAtTime(fv0, t0);
    f.Q.value = Math.max(1.5, fv0 / (bw[k] * Math.sqrt(scale)));
    for (let i = 1; i < vw.length; i++) f.frequency.setTargetAtTime(fOf(vw[i][1], k, scale), t0 + vw[i][0], vw[i][2] ?? 0.03);
    const g = gainNode(ac, fg[k] * (k === 0 ? 2.2 : 3.2));
    voiced.connect(f); breath.connect(f); f.connect(g); g.connect(sum);
  }

  // --- Amplitudenhülle (+ optionale Rauigkeit: Schnurren, Trillern, Knurren)
  const env = gainNode(ac, 0);
  const amp = spec.amp;
  env.gain.setValueAtTime(0, t0);
  for (let i = 0; i < amp.length; i++) env.gain.linearRampToValueAtTime(amp[i][1] * gain, t0 + amp[i][0]);
  let last = sum;
  if (spec.rough) {
    // Amplitudenmodulation: gain = (1 - d/2) + lfo * d/2, optional nur im Fenster [from, to]
    const r = spec.rough, d = r.depth ?? 0.7, from = r.from ?? 0, to = r.to ?? dur;
    const am = gainNode(ac, 1);
    const lfo = ac.createOscillator(); lfo.type = r.type || 'sine'; lfo.frequency.value = r.rate;
    const lg = gainNode(ac, 0);
    lfo.connect(lg); lg.connect(am.gain); lfo.start(t0); lfo.stop(tEnd);
    am.gain.setValueAtTime(1, t0); lg.gain.setValueAtTime(0, t0);
    am.gain.setTargetAtTime(1 - d * 0.5, t0 + from, 0.01); lg.gain.setTargetAtTime(d * 0.5, t0 + from, 0.01);
    if (to < dur) { am.gain.setTargetAtTime(1, t0 + to, 0.03); lg.gain.setTargetAtTime(0, t0 + to, 0.03); }
    last.connect(am); last = am;
  }
  if (spec.lp) {
    const lp = filterNode(ac, 'lowpass', spec.lp[0][1], 0.7);
    for (let i = 1; i < spec.lp.length; i++) lp.frequency.setTargetAtTime(spec.lp[i][1], t0 + spec.lp[i][0], 0.025);
    last.connect(lp); last = lp;
  }
  last.connect(env); env.connect(out);

  // --- Frikative/Plosive (direkt, ohne Vokaltrakt)
  if (spec.fric && spec.fric.length) {
    const ns = noiseSource(ac, 'white', t0, dur + 0.08);
    const bp = filterNode(ac, 'bandpass', spec.fric[0].f, spec.fric[0].q ?? 1);
    const fgn = gainNode(ac, 0);
    ns.connect(bp); bp.connect(fgn); fgn.connect(out);
    for (const fr of spec.fric) {
      const t = t0 + fr.t, a = (fr.amp ?? 0.4) * gain * 2.5;
      bp.frequency.setValueAtTime(fr.f, t); bp.Q.setValueAtTime(fr.q ?? 1, t);
      fgn.gain.setValueAtTime(0, t);
      fgn.gain.linearRampToValueAtTime(a, t + Math.min(0.012, fr.dur * 0.3));
      fgn.gain.setTargetAtTime(0, t + fr.dur * 0.55, fr.dur * 0.22);
    }
  }
  out.connect(dest);
  return tEnd;
}

// ------------------------------------------------------------------ Wort-/Ruf-Bausteine
/** Kurze gerufene Wörter (Publikum, Linienrichter-Ersatz). female: höhere Stimme. */
export function shoutSpec(word, { female = false, pitch = 1, energy = 1 } = {}) {
  const p = (female ? 1.55 : 1) * pitch * jit(1, 0.06);
  const sc = female ? 1.17 : 1;
  const base = { tilt: 0.95 - 0.1 * energy, scale: sc, breath: 0.16, vibrato: [5.5, 12], jitter: 6, bw: [110, 130, 180], fgain: [1, 0.9, 0.55] };
  switch (word) {
    case 'out': return { ...base, dur: 0.46,
      f0: [[0, 205 * p], [0.07, 262 * p], [0.2, 248 * p], [0.33, 182 * p]],
      vowels: [[0, 'a', 0.015], [0.13, 'a', 0.03], [0.2, 'U', 0.04], [0.27, 'u', 0.03]],
      amp: [[0.005, 0], [0.03, 1], [0.21, 0.92], [0.3, 0.45], [0.34, 0]],
      fric: [{ t: 0.39, dur: 0.035, f: 4300, q: 1.1, amp: 0.45 }] };
    case 'fault': return { ...base, dur: 0.56,
      f0: [[0, 235 * p], [0.1, 238 * p], [0.17, 276 * p], [0.32, 232 * p], [0.43, 190 * p]],
      vowels: [[0, 'o', 0.02], [0.3, 'o', 0.03], [0.35, 'l', 0.03]],
      amp: [[0.085, 0], [0.11, 1], [0.31, 0.88], [0.39, 0.4], [0.42, 0]],
      fric: [{ t: 0, dur: 0.1, f: 3600, q: 0.55, amp: 0.3 }, { t: 0.49, dur: 0.035, f: 4300, q: 1.1, amp: 0.45 }] };
    case 'net': return { ...base, dur: 0.42,
      f0: [[0, 240 * p], [0.08, 270 * p], [0.25, 200 * p]],
      vowels: [[0, 'n', 0.01], [0.05, 'e', 0.02], [0.25, 'e', 0.03]],
      amp: [[0, 0], [0.02, 0.4], [0.06, 1], [0.24, 0.8], [0.28, 0]],
      fric: [{ t: 0.34, dur: 0.035, f: 4300, q: 1.1, amp: 0.4 }] };
    case 'comeon': return { ...base, dur: 0.62,
      f0: [[0, 225 * p], [0.12, 245 * p], [0.18, 285 * p], [0.3, 318 * p], [0.48, 232 * p]],
      vowels: [[0, 'A', 0.01], [0.11, 'm', 0.015], [0.17, 'o', 0.02], [0.44, 'n', 0.03]],
      amp: [[0.025, 0], [0.04, 0.85], [0.11, 0.8], [0.14, 0.35], [0.18, 1], [0.42, 0.85], [0.5, 0.3], [0.58, 0]],
      fric: [{ t: 0, dur: 0.035, f: 2200, q: 1.3, amp: 0.55 }] };
    case 'yeah': return { ...base, dur: 0.55,
      f0: [[0, 255 * p], [0.15, 335 * p], [0.32, 320 * p], [0.5, 238 * p]],
      vowels: [[0, 'i', 0.01], [0.07, 'e', 0.03], [0.18, 'ae', 0.05], [0.45, 'A', 0.05]],
      amp: [[0, 0], [0.04, 0.8], [0.12, 1], [0.38, 0.85], [0.52, 0]] };
    case 'allez': return { ...base, dur: 0.58,
      f0: [[0, 250 * p], [0.12, 270 * p], [0.22, 340 * p], [0.4, 315 * p], [0.55, 240 * p]],
      vowels: [[0, 'a', 0.01], [0.12, 'l', 0.015], [0.17, 'e', 0.02], [0.5, 'e', 0.03]],
      amp: [[0, 0], [0.03, 0.9], [0.11, 0.85], [0.15, 0.4], [0.2, 1], [0.44, 0.85], [0.56, 0]] };
    case 'woo': return { ...base, dur: 0.95, vibrato: [5.2, 28],
      f0: [[0, 290 * p], [0.25, 430 * p], [0.7, 395 * p], [0.92, 320 * p]],
      vowels: [[0, 'u', 0.01], [0.6, 'U', 0.1]],
      amp: [[0, 0], [0.12, 0.9], [0.6, 0.8], [0.92, 0]] };
    case 'letsgo': return { ...base, dur: 0.66,
      f0: [[0, 245 * p], [0.12, 260 * p], [0.3, 312 * p], [0.48, 300 * p], [0.62, 228 * p]],
      vowels: [[0, 'l', 0.01], [0.04, 'e', 0.02], [0.28, 'o', 0.02], [0.45, 'U', 0.05]],
      amp: [[0, 0], [0.03, 0.6], [0.06, 1], [0.13, 0.8], [0.15, 0], [0.27, 0], [0.3, 1], [0.5, 0.85], [0.63, 0]],
      fric: [{ t: 0.15, dur: 0.1, f: 6200, q: 1.4, amp: 0.4 }, { t: 0.265, dur: 0.03, f: 1800, q: 1.2, amp: 0.4 }] };
    default: return shoutSpec('yeah', { female, pitch, energy });
  }
}

// ------------------------------------------------------------------ Publikums-Stimmen
/**
 * Plaudernde Stimme über `len` Sekunden: Phrasen aus Silben mit Betonung, Deklination, Pausen,
 * Konsonanten-Rauschen. excited: höher, schneller, offener.
 */
export function babbleSpec(len, { female = Math.random() < 0.45, excited = false, startAt = rnd(0, 1.2), single = false } = {}) {
  const base = (female ? rnd(170, 235) : rnd(92, 138)) * (excited ? rnd(1.18, 1.35) : 1);
  const f0 = [[0, base]], vowels = [[0, 'A']], amp = [[0, 0]], fric = [];
  let t = startAt;
  const vs = excited ? EXCITED_VOWELS : BABBLE_VOWELS;
  while (t < len - 0.4) {
    const nSyl = excited ? (2 + (Math.random() * 5 | 0)) : (2 + (Math.random() * 8 | 0));
    let pitch = base * rnd(1.0, 1.14);
    amp.push([t, 0]);
    for (let s = 0; s < nSyl; s++) {
      const sd = excited ? rnd(0.1, 0.21) : rnd(0.12, 0.25);
      if (t + sd > len - 0.15) break;
      const stress = Math.random() < 0.3;
      const p = pitch * (stress ? rnd(1.08, 1.28) : rnd(0.95, 1.05));
      f0.push([t + 0.005, p]); f0.push([t + sd * 0.85, p * rnd(0.93, 1.0)]);
      vowels.push([t, pick(vs), 0.025]);
      const pk = stress ? 1 : rnd(0.5, 0.82);
      if (Math.random() < 0.38) fric.push({ t: Math.max(0, t - 0.03), dur: rnd(0.03, 0.08), f: pick([5200, 6500, 2600, 1900, 3800]), q: 1.4, amp: rnd(0.06, 0.18) * pk });
      amp.push([t + 0.03, pk]); amp.push([t + sd - 0.045, pk * rnd(0.7, 0.9)]); amp.push([t + sd - 0.005, pk * 0.18]);
      t += sd;
      pitch *= 0.975;
    }
    amp.push([t + 0.04, 0]);
    if (single) break;
    t += excited ? rnd(0.12, 0.7) : rnd(0.3, 1.6);
  }
  amp.push([len, 0]);
  return { dur: len, f0, vowels, amp, fric, breath: 0.07, tilt: excited ? 1.1 : 1.35, scale: female ? rnd(1.12, 1.22) : rnd(0.95, 1.06), jitter: 8, vibrato: [5, 0] };
}

/**
 * Gemeinsamer Ausruf einer Stimme aus einer Menge: kind 'ooh' | 'aah' | 'aww' | 'cheer' | 'gasp' | 'laugh'.
 * Zeiten relativ; Variation über Zufall.
 */
export function exclaimSpec(kind, { female = Math.random() < 0.45, onset = 0 } = {}) {
  const fem = female ? rnd(1.6, 1.85) : 1;
  const sc = female ? rnd(1.12, 1.2) : rnd(0.96, 1.05);
  const o = onset;
  switch (kind) {
    case 'ooh': {
      const d = rnd(1.0, 1.6), b = rnd(118, 150) * fem, pk = rnd(1.15, 1.32);
      const tp = d * rnd(0.32, 0.45);
      return { dur: o + d + 0.1, tilt: 1.45, scale: sc, breath: 0.12, vibrato: [rnd(4.5, 6), rnd(6, 16)], jitter: 10,
        f0: [[0, b], [o, b], [o + tp, b * pk], [o + d * 0.8, b * pk * 0.82], [o + d, b * 0.78]],
        vowels: [[0, 'u'], [o + d * 0.5, 'o', 0.15], [o + d * 0.85, 'U', 0.1]],
        amp: [[o, 0], [o + rnd(0.12, 0.28), rnd(0.75, 1)], [o + d * 0.55, 0.85], [o + d, 0]] };
    }
    case 'aah': {
      const d = rnd(1.1, 1.7), b = rnd(115, 145) * fem;
      return { dur: o + d + 0.1, tilt: 1.3, scale: sc, breath: 0.14, vibrato: [rnd(4.5, 6), rnd(8, 18)], jitter: 10,
        f0: [[0, b], [o, b * 1.05], [o + d * 0.35, b * rnd(1.2, 1.35)], [o + d, b * 0.85]],
        vowels: [[0, 'a'], [o + d * 0.7, 'A', 0.2]],
        amp: [[o, 0], [o + rnd(0.1, 0.25), rnd(0.75, 1)], [o + d * 0.6, 0.75], [o + d, 0]] };
    }
    case 'aww': {
      const d = rnd(0.9, 1.4), b = rnd(130, 160) * fem;
      return { dur: o + d + 0.1, tilt: 1.4, scale: sc, breath: 0.15, vibrato: [5, 10], jitter: 10,
        f0: [[0, b * 1.25], [o, b * 1.25], [o + d * 0.2, b * 1.28], [o + d, b * 0.72]],
        vowels: [[0, 'a'], [o + d * 0.3, 'o', 0.12]],
        amp: [[o, 0], [o + 0.12, rnd(0.7, 1)], [o + d * 0.5, 0.7], [o + d, 0]] };
    }
    case 'cheer': {
      const d = rnd(1.2, 3.2), b = rnd(165, 240) * (female ? rnd(1.45, 1.7) : 1), pk = rnd(1.15, 1.45);
      const vw = pick([['i', 'ae', 'A'], ['u', 'u', 'U'], ['a', 'a', 'A'], ['e', 'ae', 'a'], ['o', 'a', 'A']]);
      return { dur: o + d + 0.1, tilt: rnd(0.85, 1.05), scale: sc, breath: 0.22, vibrato: [rnd(4.5, 6.5), rnd(15, 40)], jitter: 14,
        f0: [[0, b], [o, b], [o + rnd(0.15, 0.4), b * pk], [o + d * 0.7, b * pk * rnd(0.9, 1.0)], [o + d, b * 0.8]],
        vowels: [[0, vw[0]], [o + 0.08, vw[1], 0.05], [o + d * 0.6, vw[2], 0.2]],
        amp: [[o, 0], [o + rnd(0.05, 0.2), 1], [o + d * 0.65, rnd(0.7, 0.95)], [o + d, 0]] };
    }
    case 'gasp': {
      const d = rnd(0.28, 0.45);
      return { dur: o + d + 0.1, tilt: 1.6, scale: sc, voiced: 0.0, breath: 1, jitter: 0,
        f0: [[0, 150]], vowels: [[0, 'A'], [o + d * 0.5, 'o', 0.06]],
        amp: [[o, 0], [o + 0.05, 1], [o + d * 0.4, 0.6], [o + d, 0]] };
    }
    case 'laugh': {
      const n = 3 + (Math.random() * 4 | 0), rate = rnd(4.2, 5.8), b = rnd(140, 190) * fem;
      const f0 = [[0, b * 1.2]], amp = [[o, 0]], vowels = [[0, pick(['a', 'ae', 'A'])]], breath = [[0, 0.3]];
      let t = o;
      for (let i = 0; i < n; i++) {
        const sd = 1 / rate, pp = b * (1.25 - i * 0.07);
        f0.push([t + 0.01, pp]); f0.push([t + sd * 0.7, pp * 0.92]);
        breath.push([t, 0.9]); breath.push([t + 0.04, 0.12]);
        amp.push([t + 0.03, 0.9 - i * 0.08]); amp.push([t + sd * 0.6, 0.6 - i * 0.05]); amp.push([t + sd * 0.95, 0.05]);
        t += sd;
      }
      amp.push([t + 0.05, 0]);
      return { dur: t + 0.15, tilt: 1.2, scale: sc, breath, f0, vowels, amp, jitter: 10 };
    }
    default: return exclaimSpec('ooh', { female, onset });
  }
}

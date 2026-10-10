// Vorberechnung der Publikums-Texturen beim Start (asynchron, blockiert nicht):
//  * Applaus: granular in JS – hunderte Klatscher mit eigenem Rhythmus, Handform (Resonanz),
//    Entfernung und Position; nahtlos loopbar (Zeitachse wird umgebrochen).
//  * Stimmen: Formant-Synthese vieler Einzelstimmen im OfflineAudioContext (Gemurmel, "Ooh",
//    "Aah", "Aww", Jubel, Lachen, Rufe, Phrasen-Grains für den granularen Gemurmel-Layer).
// Abtastrate 32 kHz reicht für ferne Menschenmengen und halbiert Speicher & Rechenzeit.
import { renderOffline, renderSlots, makeSeamless, normalizeBuffer, createBuffer, Biquad, NOISE_TABLE, NOISE_MASK, rnd, gauss, yieldTask, gainNode, filterNode, noiseSource } from './dsp.js';
import { vocal, babbleSpec, exclaimSpec, shoutSpec } from './voice.js';

export const BAKE_SR = 32000;

/**
 * Applaus-Textur. people: Anzahl Klatscher; Rückgabe [L, R] Float32Array (nahtlos loopbar).
 * o = { sr, near (Anteil naher Personen), rate (Klatschtempo-Faktor), wash (Pegel ferner Masse) }
 */
export async function synthApplause(seconds, people, o = {}) {
  const sr = o.sr ?? BAKE_SR, n = Math.floor(seconds * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  const bq = new Biquad();
  const nearFrac = o.near ?? 0.06;
  for (let p = 0; p < people; p++) {
    const near = p < people * nearFrac;
    const dist = near ? rnd(2.5, 7) : rnd(8, 55);
    const g = 1 / (1 + dist / 5);
    const pan = near ? rnd(-0.9, 0.9) : rnd(-1, 1);
    const gl = Math.cos((pan + 1) * Math.PI / 4) * g, gr = Math.sin((pan + 1) * Math.PI / 4) * g;
    // Handform: hohl (tief, resonant, "plopp") vs. flach (hell, rauschig)
    const cupped = Math.random() < 0.4;
    const f = cupped ? rnd(650, 1300) : rnd(1200, 2700), q = cupped ? rnd(2.5, 5.5) : rnd(1, 2.4);
    bq.set('bandpass', f, q, sr);
    const dry = cupped ? 0.18 : 0.42;
    const fc = 14000 / (1 + dist / 14), a = Math.exp(-2 * Math.PI * fc / sr);
    const period = 1 / (rnd(3.3, 5.6) * (o.rate ?? 1));
    const tau = rnd(0.0032, 0.0075);
    const len = Math.floor(tau * 5.5 * sr), att = Math.max(2, Math.floor(0.0006 * sr));
    const dec = Math.exp(-1 / (tau * sr));
    const resGain = 1 / Math.max(0.25, Math.sqrt(1 / q));   // Bandpass-Ausgang angleichen
    let t = rnd(0, period * 1.5);
    while (t < seconds) {
      const amp = rnd(0.55, 1.0) * resGain;
      const idx = Math.floor(t * sr);
      let env = amp, lp = 0;
      const off = (Math.random() * 65536) | 0;
      bq.reset();
      for (let i = 0; i < len; i++) {
        const x = NOISE_TABLE[(off + i) & NOISE_MASK] * env * (i < att ? i / att : 1);
        const y = bq.process(x) + x * dry;
        lp = y + (lp - y) * a;
        let j = idx + i; if (j >= n) j -= n;
        L[j] += lp * gl; R[j] += lp * gr;
        env *= dec;
      }
      t += period * (1 + gauss() * 0.045);
      if (Math.random() < 0.006) t += rnd(0.25, 1.0);   // kurz aussetzen
    }
    if ((p & 15) === 15) await yieldTask();
  }
  // ferne Masse (Tausende) als dichter, gefärbter Rauschteppich
  if (o.wash) {
    const b1 = new Biquad().set('bandpass', 1500, 0.6, sr), b2 = new Biquad().set('bandpass', 1500, 0.6, sr);
    let off1 = (Math.random() * 65536) | 0, off2 = (Math.random() * 65536) | 0;
    for (let i = 0; i < n; i++) {
      L[i] += b1.process(NOISE_TABLE[(off1 + i * 7) & NOISE_MASK]) * o.wash;
      R[i] += b2.process(NOISE_TABLE[(off2 + i * 5) & NOISE_MASK]) * o.wash;
    }
  }
  return [L, R];
}

/** Einzelner naher Klatscher (Grain für Vordergrund-Klatscher). */
export function synthClap(sr = BAKE_SR) {
  const cupped = Math.random() < 0.45;
  const f = cupped ? rnd(700, 1300) : rnd(1300, 2600), q = cupped ? rnd(2.5, 5) : rnd(1, 2.2);
  const tau = rnd(0.0035, 0.007), len = Math.floor(0.045 * sr), att = Math.floor(0.0005 * sr);
  const bq = new Biquad().set('bandpass', f, q, sr);
  const d = new Float32Array(len);
  const dec = Math.exp(-1 / (tau * sr));
  let env = 1, off = (Math.random() * 65536) | 0, peak = 0;
  for (let i = 0; i < len; i++) {
    const x = NOISE_TABLE[(off + i) & NOISE_MASK] * env * (i < att ? i / att : 1);
    d[i] = bq.process(x) + x * (cupped ? 0.2 : 0.45);
    env *= dec;
    const a = Math.abs(d[i]); if (a > peak) peak = a;
  }
  const k = 0.8 / (peak || 1);
  for (let i = 0; i < len; i++) d[i] *= k;
  return d;
}

/** Stimmen-Ensemble in einen Zielknoten (je Stimme Entfernung, Tiefpass, Panorama). */
function ensemble(oac, dest, t0, count, specFn, { distMin = 6, distMax = 40, width = 0.95, lp = 6500 } = {}) {
  for (let v = 0; v < count; v++) {
    const dist = rnd(distMin, distMax);
    const ch = gainNode(oac, 1 / (1 + dist / 9));
    const f = filterNode(oac, 'lowpass', lp / (1 + dist / 22), 0.6);
    const pan = oac.createStereoPanner(); pan.pan.value = rnd(-width, width);
    ch.connect(f); f.connect(pan); pan.connect(dest);
    vocal(oac, ch, t0, specFn(v));
  }
}

/** Gemurmel-Loop (nahtlos). */
export async function bakeBabble(len, voices, { excited = false, sr = BAKE_SR } = {}) {
  const xf = 1.2;
  let ref = null;
  const buf = await renderOffline(2, len + xf, sr, (oac, dest) => {
    ref = oac;
    ensemble(oac, dest, 0, voices, () => babbleSpec(len + xf, { excited }), { distMin: 5, distMax: 45 });
    // diffuse Masse sehr vieler ferner Stimmen
    const n = noiseSource(oac, 'pink', 0, len + xf);
    const bp = filterNode(oac, 'bandpass', 480, 0.7), lp = filterNode(oac, 'lowpass', 1600, 0.6);
    const g = gainNode(oac, excited ? 0.05 : 0.035);
    n.connect(bp); bp.connect(lp); lp.connect(g); g.connect(dest);
  });
  const loop = makeSeamless(ref, buf, xf);
  normalizeBuffer(loop, excited ? 0.14 : 0.12);
  return loop;
}

/** Varianten eines Ausrufs (ooh/aah/aww/cheer/gasp/laugh). */
export async function bakeExclaim(kind, variants, voices, slot, sr = BAKE_SR) {
  const bufs = await renderSlots(variants, slot, 2, sr, (oac, dest, t0) => {
    const spread = kind === 'cheer' ? 0.35 : kind === 'gasp' ? 0.06 : kind === 'laugh' ? 0.5 : 0.14;
    ensemble(oac, dest, t0 + 0.02, voices, () => exclaimSpec(kind, { onset: Math.abs(gauss()) * spread * 0.6 }),
      { distMin: 5, distMax: 42, lp: kind === 'cheer' ? 7500 : 6000 });
    if (kind === 'cheer') {
      // Rausch-Anteil: Gebrüll vieler ferner Kehlen
      const n = noiseSource(oac, 'pink', t0, slot);
      const bp = filterNode(oac, 'bandpass', 900, 0.8);
      const g = oac.createGain();
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.08, t0 + 0.3); g.gain.setTargetAtTime(0, t0 + slot * 0.55, slot * 0.15);
      n.connect(bp); bp.connect(g); g.connect(dest);
    }
  });
  for (const b of bufs) { fadeTail(b, 0.12); normalizeBuffer(b, kind === 'gasp' ? 0.1 : 0.13); }
  return bufs;
}

/** Einzelne Rufe ("Come on!", "Yeah!", "Allez!" …) – je eine Stimme, mono. */
export async function bakeShouts(sr = BAKE_SR) {
  const words = ['comeon', 'comeon', 'yeah', 'yeah', 'allez', 'woo', 'woo', 'letsgo', 'comeon', 'allez'];
  const bufs = await renderSlots(words.length, 1.1, 1, sr, (oac, dest, t0, i) => {
    const g = gainNode(oac, 1); g.connect(dest);
    vocal(oac, g, t0 + 0.01, shoutSpec(words[i], { female: i % 3 === 1, pitch: rnd(0.92, 1.1) }));
  });
  for (const b of bufs) { fadeTail(b, 0.05); normalizeBuffer(b, 0.12); }
  return bufs;
}

/** Kurze Plauder-Phrasen einzelner Zuschauer für den granularen Gemurmel-Layer (mono). */
export async function bakePhrases(count = 16, sr = BAKE_SR) {
  const bufs = await renderSlots(count, 2.0, 1, sr, (oac, dest, t0, i) => {
    const g = gainNode(oac, 1); g.connect(dest);
    vocal(oac, g, t0, babbleSpec(2.0, { excited: i % 4 === 3, startAt: 0.02, single: true }));
  });
  for (const b of bufs) { trimSilence(b); fadeTail(b, 0.04); normalizeBuffer(b, 0.1); }
  return bufs;
}

function fadeTail(b, sec) {
  const n = Math.min(b.length, Math.floor(sec * b.sampleRate));
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) d[b.length - 1 - i] *= i / n;
  }
}
/** Stille am Ende abschneiden (in-place Kopie in kürzeren Puffer ist nicht nötig: nur Länge merken). */
function trimSilence(b) {
  const d = b.getChannelData(0);
  let end = d.length - 1;
  while (end > 0 && Math.abs(d[end]) < 1e-4) end--;
  b._activeDur = (end + 1) / b.sampleRate;
}

/** AudioBuffer aus [L, R]. */
export function stereoBuffer(LR, sr = BAKE_SR) {
  const b = createBuffer(null, 2, LR[0].length, sr);
  b.getChannelData(0).set(LR[0]); b.getChannelData(1).set(LR[1]);
  return b;
}
export function monoBuffer(d, sr = BAKE_SR) {
  const b = createBuffer(null, 1, d.length, sr);
  b.getChannelData(0).set(d);
  return b;
}

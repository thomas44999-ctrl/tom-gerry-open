// Gemeinsame DSP-Bausteine für das prozedurale Audio. Keine Audiodateien: alles wird berechnet.
// Alles hier funktioniert mit jedem BaseAudioContext (live AudioContext oder OfflineAudioContext),
// damit die Testszene dieselbe Synthese offline rendern und vermessen kann.

export const rnd = (a = 0, b = 1) => a + (b - a) * Math.random();
/** x mit relativer Zufallsabweichung ±amt. */
export const jit = (x, amt) => x * (1 + (Math.random() * 2 - 1) * amt);
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];
export const chance = (p) => Math.random() < p;
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(1e-12, Math.abs(g)));
export const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
/** Normalverteilte Zufallszahl (Box-Muller). */
export const gauss = () => { let u = 0; while (u === 0) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307 * Math.random()); };

export const hasWebAudio = () => typeof AudioContext !== 'undefined' || (typeof window !== 'undefined' && typeof window.webkitAudioContext !== 'undefined');

function makeBuffer(channels, length, sampleRate) {
  if (typeof AudioBuffer !== 'undefined') {
    try { return new AudioBuffer({ numberOfChannels: channels, length: Math.max(1, length), sampleRate }); } catch { /* Fallback unten */ }
  }
  return null;
}
/** Kontextunabhängiger AudioBuffer (auch zwischen Offline- und Live-Kontext teilbar). */
export function createBuffer(ac, channels, length, sampleRate = ac.sampleRate) {
  return makeBuffer(channels, length, sampleRate) || ac.createBuffer(channels, Math.max(1, length), sampleRate);
}
/** AudioBuffer aus Float32Arrays. */
export function bufferFrom(ac, chans, sampleRate) {
  const b = createBuffer(ac, chans.length, chans[0].length, sampleRate);
  for (let c = 0; c < chans.length; c++) b.copyToChannel ? b.copyToChannel(chans[c], c) : b.getChannelData(c).set(chans[c]);
  return b;
}

// ------------------------------------------------------------------ Rauschbänke (pro Kontext gecacht)
// AudioBuffer sind kontextunabhängig → Cache pro Abtastrate (Offline-Bakes teilen sich die Puffer).
const noiseCache = new Map();
/** { white, pink, brown } – Mono-Loops, normiert auf RMS ≈ 0.3. Zufälliger Startpunkt bei Nutzung. */
export function noiseBank(ac) {
  const sr = ac.sampleRate;
  let bank = noiseCache.get(sr);
  if (bank) return bank;
  const white = createBuffer(ac, 1, Math.floor(sr * 3), sr);
  const pink = createBuffer(ac, 1, Math.floor(sr * 7), sr);
  const brown = createBuffer(ac, 1, Math.floor(sr * 7), sr);
  fillWhite(white.getChannelData(0));
  fillPink(pink.getChannelData(0));
  fillBrown(brown.getChannelData(0));
  bank = { white, pink, brown };
  noiseCache.set(sr, bank);
  return bank;
}
function normRms(d, target) {
  let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i];
  const k = target / Math.sqrt(s / d.length || 1e-12);
  for (let i = 0; i < d.length; i++) d[i] *= k;
}
function fillWhite(d) { for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; normRms(d, 0.3); }
function fillPink(d) {
  // Paul Kellet ("refined") – rosa Rauschen, -3 dB/Oktave
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
    d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
  }
  removeDc(d); seamEdges(d); normRms(d, 0.3);
}
function fillBrown(d) {
  let last = 0;
  for (let i = 0; i < d.length; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) * 0.997; d[i] = last; }
  removeDc(d); seamEdges(d); normRms(d, 0.3);
}
function removeDc(d) { let m = 0; for (let i = 0; i < d.length; i++) m += d[i]; m /= d.length; for (let i = 0; i < d.length; i++) d[i] -= m; }
/** Schleifennaht weich machen (Ende in Anfang überblenden). */
function seamEdges(d) {
  const x = Math.min(4096, d.length >> 3), n = d.length;
  for (let i = 0; i < x; i++) { const g = i / x; d[i] = d[i] * Math.sqrt(g) + d[n - x + i] * Math.sqrt(1 - g); }
}

/** Gemeinsame Rauschtabelle für JS-seitige Synthese (Applaus usw.). */
export const NOISE_TABLE = (() => { const t = new Float32Array(1 << 16); for (let i = 0; i < t.length; i++) t[i] = Math.random() * 2 - 1; return t; })();
export const NOISE_MASK = (1 << 16) - 1;

// ------------------------------------------------------------------ Glottis-Wellenformen (pro Kontext)
const waveCache = new WeakMap();
/** PeriodicWave mit Obertönen 1/n^tilt (tilt 0.9 = gepresst/hell, 1.8 = weich/hauchig). */
export function glottalWave(ac, tilt = 1.3) {
  let m = waveCache.get(ac);
  if (!m) { m = new Map(); waveCache.set(ac, m); }
  const key = Math.round(tilt * 10);
  let w = m.get(key);
  if (!w) {
    const n = 48, re = new Float32Array(n), im = new Float32Array(n);
    for (let k = 1; k < n; k++) im[k] = 1 / Math.pow(k, key / 10);
    w = ac.createPeriodicWave(re, im);
    m.set(key, w);
  }
  return w;
}

// ------------------------------------------------------------------ Node-Helfer
export function gainNode(ac, v = 1) { const g = ac.createGain(); g.gain.value = v; return g; }
export function filterNode(ac, type, freq, q = 0.707, gainDb = 0) {
  const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; if (gainDb) f.gain.value = gainDb; return f;
}
/** Rausch-Quelle (Loop, zufälliger Offset), startet bei t, stoppt bei t+dur. */
export function noiseSource(ac, kind, t, dur, rate = 1) {
  const bank = noiseBank(ac);
  const buf = bank[kind] || bank.white;
  const s = ac.createBufferSource();
  s.buffer = buf; s.loop = true; s.playbackRate.value = rate;
  s.start(t, Math.random() * (buf.duration - 0.05));
  s.stop(t + dur);
  return s;
}
/** Sinus/Oszillator mit optionalem Tonhöhen-Gleiten. */
export function osc(ac, type, freq, t, dur, freqFrom = 0, glide = 0) {
  const o = ac.createOscillator();
  o.type = type;
  if (freqFrom > 0 && glide > 0) {
    o.frequency.setValueAtTime(freqFrom, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + glide);
  } else o.frequency.setValueAtTime(freq, t);
  o.start(t); o.stop(t + dur);
  return o;
}
/** Hüllkurve: linearer Anstieg, optional halten, exponentieller Abfall (tau). */
export function envAD(param, t, attack, peak, tau, hold = 0) {
  // Wichtig: Abklingen darf erst NACH dem Rampenende beginnen, sonst bleibt der Wert auf `peak` stehen.
  const a = Math.max(0.0005, attack);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  if (hold > 0) param.setValueAtTime(peak, t + a + hold);
  param.setTargetAtTime(0, t + a + hold, Math.max(0.0005, tau));
}
/** Abklingende Mode (Sinus mit exponentiellem Abfall) – Baustein der Modalsynthese. */
export function mode(ac, dest, t, freq, amp, tau, freqFrom = 0, glide = 0, type = 'sine') {
  if (amp <= 0.0005) return;
  const dur = Math.min(4, tau * 7 + 0.01);
  const o = osc(ac, type, freq, t, dur, freqFrom, glide);
  const g = ac.createGain();
  envAD(g.gain, t, 0.0004, amp, tau);
  o.connect(g); g.connect(dest);
}
/** Breitbandiger Rauschimpuls durch Filter (z.B. Kontakt-Transient). */
export function noiseBurst(ac, dest, t, { kind = 'white', attack = 0.0005, amp = 1, tau = 0.004, hold = 0, type = 'bandpass', freq = 3000, q = 0.8, type2 = null, freq2 = 0, q2 = 0.7, rate = 1 } = {}) {
  const dur = attack + hold + tau * 7 + 0.01;
  const s = noiseSource(ac, kind, t, dur, rate);
  const f = filterNode(ac, type, freq, q);
  let last = f; s.connect(f);
  if (type2) { const f2 = filterNode(ac, type2, freq2, q2); f.connect(f2); last = f2; }
  const g = ac.createGain();
  envAD(g.gain, t, attack, amp, tau, hold);
  last.connect(g); g.connect(dest);
  return g;
}

// ------------------------------------------------------------------ JS-DSP (für Vorberechnung & Analyse)
/** Biquad nach RBJ-Cookbook, transponierte Direktform II. */
export class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(type, f, q, sr, gainDb = 0) {
    const w0 = 2 * Math.PI * Math.min(f, sr * 0.49) / sr, c = Math.cos(w0), s = Math.sin(w0), al = s / (2 * q);
    const A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lowpass': b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case 'highpass': b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case 'bandpass': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case 'peaking': b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; break;
      case 'highshelf': {
        const sq = 2 * Math.sqrt(A) * al;
        b0 = A * ((A + 1) + (A - 1) * c + sq); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sq);
        a0 = (A + 1) - (A - 1) * c + sq; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sq; break;
      }
      default: b0 = 1; b1 = 0; b2 = 0; a0 = 1; a1 = 0; a2 = 0;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  reset() { this.z1 = 0; this.z2 = 0; return this; }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** Macht einen Puffer nahtlos loopbar: das Ende (xfade s) wird gleichleistungs-überblendet in den Anfang gelegt. */
export function makeSeamless(ac, buf, xfade) {
  const sr = buf.sampleRate, n = buf.length, x = Math.min(Math.floor(xfade * sr), n >> 1), outLen = n - x;
  const out = createBuffer(ac, buf.numberOfChannels, outLen, sr);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c), dst = out.getChannelData(c);
    dst.set(src.subarray(0, outLen));
    for (let i = 0; i < x; i++) {
      const g = (i / x) * Math.PI * 0.5;
      dst[i] = src[i] * Math.sin(g) + src[outLen + i] * Math.cos(g);
    }
  }
  return out;
}

/** Normiert einen Puffer auf Ziel-RMS (über alle Kanäle). Gibt den Faktor zurück. */
export function normalizeBuffer(buf, targetRms, maxPeak = 0.95) {
  let s = 0, peak = 0, n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const v = d[i]; s += v * v; const a = v < 0 ? -v : v; if (a > peak) peak = a; }
    n += d.length;
  }
  const rms = Math.sqrt(s / Math.max(1, n));
  if (rms < 1e-9) return 1;
  let k = targetRms / rms;
  if (peak * k > maxPeak) k = maxPeak / peak;
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k; }
  return k;
}

/** Rendert einen Graphen offline. build(oac, dest) darf Promise liefern. */
export async function renderOffline(channels, seconds, sampleRate, build) {
  const oac = new OfflineAudioContext(channels, Math.max(1, Math.ceil(seconds * sampleRate)), sampleRate);
  await build(oac, oac.destination);
  return oac.startRendering();
}

/** Mehrere Varianten in einem Offline-Durchlauf rendern (je ein Zeitfenster) und in Einzelpuffer schneiden. */
export async function renderSlots(count, slotSec, channels, sampleRate, buildSlot, trimSec = slotSec) {
  const oac = new OfflineAudioContext(channels, Math.ceil(count * slotSec * sampleRate), sampleRate);
  for (let i = 0; i < count; i++) buildSlot(oac, oac.destination, i * slotSec, i);
  const full = await oac.startRendering();
  const out = [], len = Math.floor(trimSec * sampleRate), step = Math.floor(slotSec * sampleRate);
  for (let i = 0; i < count; i++) {
    const b = createBuffer(oac, channels, len, sampleRate);
    for (let c = 0; c < channels; c++) b.getChannelData(c).set(full.getChannelData(c).subarray(i * step, i * step + len));
    out.push(b);
  }
  return out;
}

/** Kleiner Pausen-Helfer für schrittweise JS-Berechnungen (kein Ruckeln). */
export const yieldTask = () => new Promise((r) => setTimeout(r, 0));

/** Begrenzung gleichzeitiger Stimmen pro Kategorie (CPU-Schutz). */
export class VoiceLimiter {
  constructor(limits = {}) { this.limits = limits; this.active = new Map(); }
  acquire(cat, now, dur) {
    const lim = this.limits[cat] ?? 24;
    let arr = this.active.get(cat);
    if (!arr) { arr = []; this.active.set(cat, arr); }
    let n = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] > now) arr[n++] = arr[i];
    arr.length = n;
    if (n >= lim) return false;
    arr.push(now + dur);
    return true;
  }
  count(cat, now) { const arr = this.active.get(cat); if (!arr) return 0; let n = 0; for (const e of arr) if (e > now) n++; return n; }
}

// Audio-Labor (dev.html?scene=audio) – Prüfstand für das prozedurale Audio ohne Ohren:
//  (a) Offline-Selbsttest: jeder Klang wird mit DERSELBEN Synthese (Sfx/Crowd/Music/Creatures/Umpire auf einem
//      AudioGraph) in einem OfflineAudioContext gerendert und vermessen: Spitze, Lautheit (K-gewichtet, LUFS-ähnlich,
//      Momentan-Max über 400 ms), DC, NaN, Dauer, Attack, Spektralschwerpunkt, spektrale Flachheit, Tonalität,
//      Variation (nie zweimal identisch). Dazu Relationstests (Aufsprung dunkler als Treffer, Aufschlag lauter als Volley …).
//  (b) Wellenform + Spektrogramm (log. Frequenzachse) je Klang – per Screenshot prüfbar.
//  (c) Live-Knöpfe für jeden Klang, Match-Demo als echte Ereignisfolge über audio.handle(), Mischpult.
//
// URL: &check=0 (kein Offline-Test) &only=hit,crowd (Filter: id-Präfix oder Gruppe) &cols=6 &live=1 (Live-Systemtest)
// Ergebnis: window.__audioLab = { done, summary, results, live }
import { AudioSystem } from '../../src/audio/audio.js';
import { AudioGraph } from '../../src/audio/graph.js';
import { Sfx } from '../../src/audio/sfx.js';
import { Crowd } from '../../src/audio/crowd.js';
import { Music } from '../../src/audio/music.js';
import { Creatures } from '../../src/audio/creatures.js';
import { Umpire } from '../../src/audio/umpire.js';

const SR = 48000;
const P = new URLSearchParams(location.search);
const NEAR = [1.2, 1.0, 10.8], FAR = [-1.0, 1.0, -11.2];

// ------------------------------------------------------------------ Kategorien & Mischziele
// L = Ziel-Lautheit je Klang als "L100": K-gewichtet (BS.1770), Maximum über 100-ms-Fenster, nach der kompletten
// Masterkette (Hall, Kompressor, Soft-Clip). Toleranz ±3 dB (Hinweis), ±6 dB (Fehler). Bezug: naher Spieler.
// Anker: Grundschlag-Spitze ≈ -7 dBFS (Transienten haben ~16 dB Crest → L100 ≈ -23), Aufschlag ≈ -4 dBFS.
// Alles andere ist relativ dazu gemischt (Broadcast-Balance: Ball klar vorne, Publikum trägt, UI dezent).
const CATS = {
  hit:      { name: 'Schläger',      color: '#f2c14e' },
  ball:     { name: 'Ball',          color: '#9bd17a' },
  player:   { name: 'Spieler',       color: '#7fc8d6' },
  creature: { name: 'Figuren',       color: '#f08a5d' },
  crowd:    { name: 'Publikum',      color: '#c792ea' },
  amb:      { name: 'Atmosphäre',    color: '#8aa1b1' },
  voice:    { name: 'Linienrichter', color: '#ff9fb2' },
  music:    { name: 'Musik',         color: '#80cbc4' },
  ui:       { name: 'UI',            color: '#e0e0e0' },
};

// ------------------------------------------------------------------ Katalog
// fn(S, t): S = { ac, G, sfx, cr, crowd, music, umpire } – identisch für Offline-Render und Live-Wiedergabe.
// setup/step: Zustand bzw. Steuer-Takt (Ambience/Bett/Pad), sched: Publikum-Planung vorab, x: weitere Erwartungen.
const hit = (o) => (S, t) => S.sfx.hit(t, o, null);
const HIT_X = { attack: 3, centroid: [900, 2600], dryDur: [0.04, 0.16] };
const CATALOG = [
  // Schläger
  { id: 'hit_ground', cat: 'hit', L: -23, label: 'Grundschlag (Topspin)', dur: 0.7, fn: hit({ power: 0.6, quality: 'good', kind: 'ground' }), x: HIT_X },
  { id: 'hit_perfect', cat: 'hit', L: -21.5, label: 'Perfekter Treffer', dur: 0.7, fn: hit({ power: 0.85, quality: 'perfect', kind: 'ground' }), x: HIT_X },
  { id: 'hit_soft', cat: 'hit', L: -31, label: 'Weicher Schlag / Stopp', dur: 0.7, fn: hit({ power: 0.12, quality: 'good', kind: 'ground', slice: true }), x: { attack: 4 } },
  { id: 'hit_slice', cat: 'hit', L: -25, label: 'Slice', dur: 0.7, fn: hit({ power: 0.5, quality: 'good', kind: 'ground', slice: true }), x: { attack: 4 } },
  { id: 'hit_late', cat: 'hit', L: -25, label: 'Zu spät / gestreckt', dur: 0.7, fn: hit({ power: 0.5, quality: 'late', kind: 'ground' }), x: { attack: 3 } },
  { id: 'hit_frame', cat: 'hit', L: -24, label: 'Rahmentreffer', dur: 0.8, fn: hit({ power: 0.5, quality: 'frame', kind: 'ground' }), x: { attack: 3 } },
  { id: 'hit_volley', cat: 'hit', L: -24.5, label: 'Volley', dur: 0.7, fn: hit({ power: 0.45, quality: 'good', kind: 'volley' }), x: { attack: 3, dryDur: [0.03, 0.12] } },
  { id: 'hit_serve', cat: 'hit', L: -19.5, label: 'Aufschlag (voll)', dur: 0.8, fn: hit({ power: 1, quality: 'perfect', kind: 'serve' }), x: { attack: 3 } },
  { id: 'hit_smash', cat: 'hit', L: -19.5, label: 'Schmetterball', dur: 0.8, fn: hit({ power: 1, quality: 'good', kind: 'smash' }), x: { attack: 3 } },
  { id: 'hit_far', cat: 'hit', L: -29, label: 'Treffer Gegner (fern)', dur: 0.8, fn: (S, t) => S.sfx.hit(t, { power: 0.6, quality: 'good', kind: 'ground' }, FAR), x: { attack: 4 } },
  // Ball
  { id: 'bounce_grass', cat: 'ball', L: -29, label: 'Aufsprung Rasen (schnell)', dur: 0.6, fn: (S, t) => S.sfx.bounce(t, { speed: 24 }, null), x: { centroid: [300, 900], attack: 6 } },
  { id: 'bounce_grass_slow', cat: 'ball', L: -35, label: 'Aufsprung Rasen (langsam)', dur: 0.6, fn: (S, t) => S.sfx.bounce(t, { speed: 7 }, null), x: { centroid: [250, 900] } },
  { id: 'bounce_hard', cat: 'ball', L: -29, label: 'Aufsprung Umrandung', dur: 0.6, fn: (S, t) => S.sfx.bounce(t, { speed: 18, surface: 'hard' }, null), x: { centroid: [600, 2200] } },
  { id: 'bounce_tap', cat: 'ball', L: -38, label: 'Ball tippen (Aufschlag)', dur: 0.5, fn: (S, t) => S.sfx.bounce(t, { speed: 4.5, soft: true }, null), x: {} },
  { id: 'net', cat: 'ball', L: -26, label: 'Ball ins Netz', dur: 1.2, fn: (S, t) => S.sfx.net(t, { cord: false, speed: 25 }, [0.5, 0.6, 0]), x: {} },
  { id: 'net_cord', cat: 'ball', L: -27, label: 'Netzkante', dur: 1.0, fn: (S, t) => S.sfx.net(t, { cord: true, speed: 25 }, [0.5, 0.9, 0]), x: {} },
  { id: 'wall', cat: 'ball', L: -28, label: 'Bande / Rückwand', dur: 0.8, fn: (S, t) => S.sfx.wall(t, { speed: 16 }, null), x: {} },
  { id: 'post', cat: 'ball', L: -28, label: 'Netzpfosten', dur: 1.4, fn: (S, t) => S.sfx.post(t, { speed: 18 }, null), x: {} },
  { id: 'roll', cat: 'ball', L: -38, label: 'Ball rollt aus', dur: 2.2, fn: (S, t) => S.sfx.roll(t, { speed: 3, dur: 1.6 }, null), x: { flatMin: 0.05 } },
  // Spieler
  { id: 'step', cat: 'player', L: -36, label: 'Schritt (Rasen)', dur: 0.4, fn: (S, t) => S.sfx.footstep(t, { intensity: 0.6 }, null), x: { centroid: [300, 2200] } },
  { id: 'split', cat: 'player', L: -35, label: 'Split-Step', dur: 0.4, fn: (S, t) => S.sfx.splitStep(t, {}, null), x: {} },
  { id: 'shuffle', cat: 'player', L: -35, label: 'Shuffle', dur: 0.7, fn: (S, t) => S.sfx.shuffle(t, {}, null), x: {} },
  { id: 'run', cat: 'player', L: -34, label: 'Sprint (Schrittfolge)', dur: 1.6, fn: (S, t) => { for (let k = 0; k < 6; k++) S.sfx.footstep(t + k * 0.21, { intensity: 0.85 }, null); }, x: {} },
  { id: 'squeak', cat: 'player', L: -36, label: 'Schuh-Quietschen', dur: 0.6, fn: (S, t) => S.sfx.squeak(t, { intensity: 0.7 }, null), x: {} },
  { id: 'whoosh', cat: 'player', L: -35, label: 'Schlägerschwung', dur: 0.6, fn: (S, t) => S.sfx.whoosh(t + 0.25, { power: 0.9 }, null), x: {} },
  { id: 'toss', cat: 'player', L: -42, label: 'Ballwurf', dur: 0.4, fn: (S, t) => S.sfx.toss(t, {}, null), x: {} },
  // Figuren
  { id: 'meow_happy', cat: 'creature', L: -24, label: 'Gerry: Miau (froh)', dur: 1.2, fn: (S, t) => S.cr.meow(t, 'happy', null), x: { centroid: [500, 3500] } },
  { id: 'meow_trill', cat: 'creature', L: -24, label: 'Gerry: Mrrr-iau', dur: 1.3, fn: (S, t) => S.cr.meow(t, 'trill', null), x: {} },
  { id: 'meow_mew', cat: 'creature', L: -26, label: 'Gerry: Mew', dur: 0.8, fn: (S, t) => S.cr.meow(t, 'mew', null), x: {} },
  { id: 'meow_proud', cat: 'creature', L: -23, label: 'Gerry: Siegesmiau', dur: 1.8, fn: (S, t) => S.cr.meow(t, 'proud', null), x: {} },
  { id: 'grumble', cat: 'creature', L: -28, label: 'Gerry: Grummeln', dur: 1.1, fn: (S, t) => S.cr.grumble(t, null), x: {} },
  { id: 'hiss', cat: 'creature', L: -31, label: 'Gerry: Fauchen', dur: 1.0, fn: (S, t) => S.cr.hiss(t, null), x: {} },
  { id: 'purr', cat: 'creature', L: -31, label: 'Gerry: Schnurren', dur: 3.0, fn: (S, t) => S.cr.purr(t, 2.4, null), x: {} },
  { id: 'exhale', cat: 'creature', L: -31, label: 'Tom: Ausatmen', dur: 0.6, fn: (S, t) => S.cr.exhale(t, 0.9, null), x: {} },
  // Publikum
  { id: 'applause_lo', cat: 'crowd', L: -28, label: 'Applaus (höflich)', dur: 5.5, fn: (S, t) => S.crowd.react('applause', 0.3), sched: true, x: { flatMin: 0.18, tonalMax: 26 } },
  { id: 'applause_mid', cat: 'crowd', L: -22, label: 'Applaus (kräftig)', dur: 7, fn: (S, t) => S.crowd.react('applause', 0.65), sched: true, x: { flatMin: 0.18, tonalMax: 26 } },
  { id: 'applause_hi', cat: 'crowd', L: -18, label: 'Applaus (frenetisch)', dur: 8, fn: (S, t) => S.crowd.react('applause', 1), sched: true, x: { flatMin: 0.18, tonalMax: 26 } },
  { id: 'ooh', cat: 'crowd', L: -22, label: '„Ooh“', dur: 2.5, fn: (S, t) => S.crowd.react('ooh', 0.7), x: { centroid: [250, 1800] } },
  { id: 'aah', cat: 'crowd', L: -22, label: '„Aah“', dur: 2.5, fn: (S, t) => S.crowd.react('aah', 0.7), x: {} },
  { id: 'aww', cat: 'crowd', L: -24, label: '„Aww“ (Enttäuschung)', dur: 2.2, fn: (S, t) => S.crowd.react('aww', 0.7), x: {} },
  { id: 'gasp', cat: 'crowd', L: -27, label: 'Raunen / Gasp', dur: 1.2, fn: (S, t) => S.crowd.react('gasp', 0.7), x: {} },
  { id: 'laugh', cat: 'crowd', L: -27, label: 'Lachen', dur: 2.6, fn: (S, t) => S.crowd.react('laugh', 0.6), x: {} },
  { id: 'cheer', cat: 'crowd', L: -18, label: 'Jubel', dur: 8, fn: (S, t) => S.crowd.react('cheer', 0.9), sched: true, x: {} },
  { id: 'standing', cat: 'crowd', L: -16, label: 'Stehende Ovationen', dur: 12, fn: (S, t) => S.crowd.react('standing', 1), sched: true, x: {} },
  { id: 'whistle', cat: 'crowd', L: -31, label: 'Pfiff', dur: 1.3, fn: (S, t) => S.crowd.react('whistle', 0.7), x: {} },
  { id: 'shout', cat: 'crowd', L: -28, label: 'Ruf („Come on!“)', dur: 1.3, fn: (S, t) => S.crowd.react('shout', 0.9), x: {} },
  { id: 'shh', cat: 'crowd', L: -38, label: '„Psst“ (Ruhe)', dur: 1.4, fn: (S, t) => S.crowd._shh(t), x: {} },
  { id: 'wave', cat: 'crowd', L: -20, label: 'La-Ola', dur: 9, fn: (S, t) => S.crowd.react('wave', 0.8), sched: true, x: {} },
  // Atmosphäre
  { id: 'bed_calm', cat: 'amb', L: -34, label: 'Gemurmel (ruhig)', dur: 6, setup: (S) => { S.crowd.murmur = 0.3; S.crowd.excite = 0.15; S.crowd.setPhase('between_points'); }, step: (S, t, dt) => S.crowd.update(dt, { excitement: 0.15 }), x: {} },
  { id: 'bed_excited', cat: 'amb', L: -28, label: 'Gemurmel (aufgeregt)', dur: 6, setup: (S) => { S.crowd.murmur = 0.6; S.crowd.excite = 0.85; S.crowd.chatter = 0.35; S.crowd.setPhase('between_points'); }, step: (S, t, dt) => S.crowd.update(dt, { excitement: 0.85 }), x: {} },
  { id: 'bed_hush', cat: 'amb', L: -31, label: 'Ruhe vor Aufschlag (Absenkung)', dur: 5, setup: (S) => { S.crowd.murmur = 0.45; S.crowd.excite = 0.4; S.crowd.setPhase('between_points'); }, step: (S, t, dt) => { if (t > 1 && !S._h) { S._h = 1; S.crowd.hushNow(); } S.crowd.update(dt, { excitement: 0.4 }); }, x: {} },
  { id: 'title_amb', cat: 'amb', L: -36, label: 'Titel: Wind, Vögel, Stadt', dur: 8, setup: (S) => { S.crowd.setMode('title'); S.crowd.murmur = 0.3; }, step: (S, t, dt) => S.crowd.update(dt, { excitement: 0.1 }), x: {} },
  // Linienrichter (synthetischer Ruf, falls keine Sprachausgabe)
  { id: 'call_out', cat: 'voice', L: -21, label: 'Linienrichter „Out!“ (synth.)', dur: 1.2, fn: (S, t) => S.umpire.lineCall('out', [4.2, 0, -9]), x: {} },
  { id: 'call_fault', cat: 'voice', L: -21, label: 'Linienrichter „Fault!“ (synth.)', dur: 1.2, fn: (S, t) => S.umpire.lineCall('fault', [0, 0, -6.6]), x: {} },
  { id: 'call_net', cat: 'voice', L: -22, label: 'Netzrichter „Net!“ (synth.)', dur: 1.0, fn: (S, t) => S.umpire.lineCall('net', [0, 1, 0]), x: {} },
  // Musik
  { id: 'sting_start', cat: 'music', L: -21, label: 'Sting: Matchbeginn', dur: 5.5, fn: (S) => S.music.sting('match_start'), x: { dur: [2, 6] } },
  { id: 'sting_game', cat: 'music', L: -24, label: 'Sting: Spielgewinn', dur: 3, fn: (S) => S.music.sting('game', { positive: true }), x: { dur: [1, 4] } },
  { id: 'sting_game_neg', cat: 'music', L: -25, label: 'Sting: Spiel verloren', dur: 3, fn: (S) => S.music.sting('game', { positive: false }), x: { dur: [1, 4] } },
  { id: 'sting_break', cat: 'music', L: -23, label: 'Sting: Break', dur: 3.5, fn: (S) => S.music.sting('break'), x: { dur: [1.2, 4] } },
  { id: 'sting_set', cat: 'music', L: -22, label: 'Sting: Satzgewinn', dur: 5, fn: (S) => S.music.sting('set', { positive: true }), x: { dur: [1.5, 5] } },
  { id: 'sting_match', cat: 'music', L: -20, label: 'Sting: Matchgewinn', dur: 7.5, fn: (S) => S.music.sting('match', { positive: true }), x: { dur: [2.5, 7.5] } },
  { id: 'title_pad', cat: 'music', L: -31, label: 'Titel-Pad (Loop)', dur: 14, setup: (S) => S.music.title(true), step: (S, t, dt) => S.music.update(dt), x: {} },
  // UI
  ...[['move', -33, 0.5], ['select', -28, 1], ['back', -29, 1], ['start', -26, 2.6], ['pause', -29, 1], ['resume', -30, 1], ['toggle', -33, 0.6],
    ['error', -29, 1], ['tick', -37, 0.4], ['score', -29, 1.4], ['hover', -41, 0.4]].map(([n, L, dur]) => ({
    id: 'ui_' + n, cat: 'ui', L, label: 'UI: ' + n, dur, fn: (S, t) => S.sfx.ui(n, t), x: {},
  })),
];

// ------------------------------------------------------------------ DSP-Analyse
class FFT {
  constructor(n) {
    this.n = n; this.re = new Float32Array(n); this.im = new Float32Array(n);
    this.cos = new Float32Array(n / 2); this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(-2 * Math.PI * i / n); this.sin[i] = Math.sin(-2 * Math.PI * i / n); }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.win = new Float32Array(n); for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  }
  /** Leistungsspektrum (n/2+1) eines Fensters ab src[off]. */
  power(src, off, out) {
    const n = this.n, re = this.re, im = this.im;
    for (let i = 0; i < n; i++) { const j = off + i; re[this.rev[i]] = (j >= 0 && j < src.length ? src[j] : 0) * this.win[i]; im[i] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let s = 0; s < n; s += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step], si = this.sin[k * step];
          const a = s + k, b = a + half;
          const tr = re[b] * c - im[b] * si, ti = re[b] * si + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    // Normierung: Vollaussteuerungs-Sinus → 1.0
    const k = 4 / (n * n * 0.25);
    for (let i = 0; i <= n / 2; i++) out[i] = (re[i] * re[i] + im[i] * im[i]) * k;
    return out;
  }
}
const FFT_N = 1024, HOP = 256;
const DRY = ['hit', 'ball', 'player', 'creature', 'voice', 'ui'];
const fft = new FFT(FFT_N);
const db = (x) => 10 * Math.log10(Math.max(1e-20, x));
const db20 = (x) => 20 * Math.log10(Math.max(1e-10, x));

// K-Gewichtung (ITU-R BS.1770, 48 kHz)
function kWeight(x) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0, w1 = 0, w2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const s1 = 1.53512485958697 * v - 2.69169618940638 * x1 + 1.19839281085285 * x2 + 1.69065929318241 * y1 - 0.73248077421585 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = s1;
    const s2 = s1 - 2 * z1 + z2 + 1.99004745483398 * w1 - 0.99007225036621 * w2;
    z2 = z1; z1 = s1; w2 = w1; w1 = s2;
    y[i] = s2;
  }
  return y;
}

function analyze(buf) {
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L, n = L.length;
  const mono = new Float32Array(n);
  let peak = 0, peakIdx = 0, nan = 0, sum = 0, hot = 0;
  for (let i = 0; i < n; i++) {
    let l = L[i], r = R[i];
    if (!Number.isFinite(l) || !Number.isFinite(r)) { nan++; l = 0; r = 0; }
    const al = Math.abs(l), ar = Math.abs(r), a = al > ar ? al : ar;
    if (a > peak) { peak = a; peakIdx = i; }
    if (a > 0.9) hot++;
    sum += l + r;
    mono[i] = 0.5 * (l + r);
  }
  const dc = sum / (2 * n);
  // Hüllkurve (2.5-ms-Blöcke)
  const blk = 120, nb = Math.ceil(n / blk), env = new Float32Array(nb);
  let envMax = 0;
  for (let b = 0; b < nb; b++) {
    let s = 0; const e = Math.min(n, (b + 1) * blk);
    for (let i = b * blk; i < e; i++) s += L[i] * L[i] + R[i] * R[i];
    env[b] = Math.sqrt(s / (2 * (e - b * blk) || 1)); if (env[b] > envMax) envMax = env[b];
  }
  let on = 0; while (on < nb && env[on] < envMax * 0.03) on++;
  let end = nb - 1; while (end > on && env[end] < envMax * 0.0056) end--;   // -45 dB
  // Attack: erste Probe > 10 % Spitze → Spitze
  let a0 = 0; while (a0 < n && Math.abs(L[a0]) < peak * 0.1 && Math.abs(R[a0]) < peak * 0.1) a0++;
  const attack = Math.max(0, (peakIdx - a0) / SR * 1000);
  // Lautheit: Momentan (400 ms, Schritt 50 ms), Max
  const kl = kWeight(L), kr = buf.numberOfChannels > 1 ? kWeight(R) : kl;
  const win = Math.floor(0.4 * SR), hop = Math.floor(0.05 * SR);
  let mMax = -Infinity, rms = 0, cnt = 0;
  // Präfixsumme der K-gewichteten Energie → schnelle Fenster
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + kl[i] * kl[i] + kr[i] * kr[i];
  const winMax = (w, h) => { let mx = -Infinity; for (let s = -w + h; s < n; s += h) { const a = Math.max(0, s), b = Math.min(n, s + w); const lu = -0.691 + db((cs[b] - cs[a]) / w); if (lu > mx) mx = lu; } return mx; };
  mMax = winMax(win, hop);
  const l100 = winMax(Math.floor(0.1 * SR), Math.floor(0.01 * SR));
  for (let b = on; b <= end; b++) { rms += env[b] * env[b]; cnt++; }
  rms = Math.sqrt(rms / Math.max(1, cnt));
  // STFT (Spektrogramm + Spektral-Kennzahlen über aktive Frames)
  const frames = Math.max(1, Math.ceil(n / HOP)), bins = FFT_N / 2 + 1;
  const spec = new Float32Array(frames * bins), pw = new Float32Array(bins), avg = new Float64Array(bins);
  let cNum = 0, cDen = 0, flatW = 0, flatAcc = 0, specMax = 0;
  const b50 = Math.round(50 * FFT_N / SR), b16k = Math.round(16000 * FFT_N / SR), b200 = Math.round(200 * FFT_N / SR), b10k = Math.round(10000 * FFT_N / SR);
  const bands = [0, 0, 0, 0]; const edges = [250, 1000, 4000];
  for (let f = 0; f < frames; f++) {
    fft.power(mono, f * HOP - FFT_N / 2, pw);
    let e = 0;
    for (let k = 0; k < bins; k++) { spec[f * bins + k] = pw[k]; if (pw[k] > specMax) specMax = pw[k]; }
    for (let k = b50; k <= b16k; k++) e += pw[k];
    if (e < 1e-12) continue;
    for (let k = b50; k <= b16k; k++) {
      const hz = k * SR / FFT_N; cNum += hz * pw[k]; cDen += pw[k]; avg[k] += pw[k];
      bands[hz < edges[0] ? 0 : hz < edges[1] ? 1 : hz < edges[2] ? 2 : 3] += pw[k];
    }
    let lg = 0, ar = 0, m = 0;
    for (let k = b200; k <= b10k; k++) { lg += Math.log(pw[k] + 1e-20); ar += pw[k]; m++; }
    flatAcc += (Math.exp(lg / m) / (ar / m + 1e-20)) * e; flatW += e;
  }
  const bandTot = bands[0] + bands[1] + bands[2] + bands[3] || 1;
  // Tonalität: Spitze vs. Median des gemittelten Spektrums (200 Hz–10 kHz), in dB
  const sl = Array.from(avg.slice(b200, b10k + 1)).sort((x, y) => x - y);
  const tonal = db(sl[sl.length - 1] / (sl[sl.length >> 1] || 1e-20));
  return {
    peak: db20(peak), hot, nan, dc, rms: db20(rms), lufs: mMax, lk: l100, attack,
    onset: on * blk / SR, dur: (end - on + 1) * blk / SR, centroid: cDen > 0 ? cNum / cDen : 0,
    flat: flatW > 0 ? flatAcc / flatW : 0, tonal, bands: bands.map((b) => b / bandTot),
    spec, frames, bins, specMax, env, envMax, mono,
  };
}

// ------------------------------------------------------------------ Offline-Rendering mit dem echten Graphen
let TEX = null;   // gebackene Publikums-Texturen (einmal)
function makeSystems(ac, G) {
  const S = { ac, G, sfx: new Sfx(G), cr: new Creatures(G), music: new Music(), crowd: new Crowd(), umpire: new Umpire({ synthLineCalls: true }) };
  S.music.attach(G); S.umpire.attach(G);
  if (TEX) { S.crowd.tex = TEX; S.crowd.baked = true; }
  S.crowd.attach(G);
  return S;
}
// Vorlauf: Chromes DynamicsCompressor startet mit reduzierter Verstärkung (~9 dB in den ersten ~0.3 s) –
// deshalb wird jeder Klang erst nach PRE ausgelöst und nur der Teil ab PRE ausgewertet.
const PRE = 0.6;
async function renderItem(item, dry = false) {
  const len = Math.ceil((item.dur + PRE) * SR);
  const oac = new OfflineAudioContext(2, len, SR);
  const G = new AudioGraph(oac, dry ? { reverb: false, limiter: false } : {});
  const S = makeSystems(oac, G);
  const q = (t) => Math.round(t * SR / 128) * 128 / SR;
  oac.suspend(q(PRE)).then(() => {
    try {
      item.setup?.(S);
      if (item.fn) item.fn(S, q(PRE) + 0.02);
      if (item.sched) S.crowd._scheduleUntil(q(PRE) + item.dur, q(PRE));
    } catch (e) { item.err = String(e); }
    oac.resume();
  });
  if (item.step) {
    const dt = 1 / 30;
    for (let t = PRE + dt; t < PRE + item.dur - 0.05; t += dt) {
      const tt = q(t);
      oac.suspend(tt).then(() => { try { item.step(S, tt - q(PRE), dt); } catch (e) { item.err = String(e); } oac.resume(); });
    }
  }
  const full = await oac.startRendering();
  const off = Math.round(q(PRE) * SR), n = full.length - off;
  const buf = new AudioBuffer({ numberOfChannels: 2, length: n, sampleRate: SR });
  for (let c = 0; c < 2; c++) buf.getChannelData(c).set(full.getChannelData(c).subarray(off));
  return buf;
}
/** Gesamtverstärkung der Masterkette (Kompressor-Makeup) mit Testsinus bei -30 dBFS. */
async function chainGain() {
  const oac = new OfflineAudioContext(2, SR, SR);
  const G = new AudioGraph(oac, { reverb: false });
  const o = oac.createOscillator(); o.frequency.value = 1000;
  const g = oac.createGain(); g.gain.value = Math.pow(10, -30 / 20);
  o.connect(g); g.connect(G.bus.sfx); o.start(0); o.stop(1);
  const b = await oac.startRendering();
  const d = b.getChannelData(0); let s = 0;
  for (let i = SR / 2; i < SR; i++) s += d[i] * d[i];
  return db20(Math.sqrt(s / (SR / 2)) * Math.SQRT2) + 30;
}

// ------------------------------------------------------------------ Prüfregeln
function judge(item, m, other) {
  const x = item.x || {}, fails = [], warns = [];
  if (m.nan) fails.push(`${m.nan} NaN`);
  if (m.peak > -0.3) fails.push(`Clipping ${m.peak.toFixed(1)} dBFS`); else if (m.peak > -1) warns.push(`Spitze ${m.peak.toFixed(1)} dBFS`);
  if (m.hot > 0) warns.push(`${m.hot} Proben im Soft-Clip`);
  if (Math.abs(m.dc) > 0.002) fails.push(`DC ${m.dc.toFixed(4)}`);
  if (!(m.lk > -70)) fails.push('stumm');
  const dL = m.lk - item.L;
  if (Math.abs(dL) > 6) fails.push(`Lautheit ${m.lk.toFixed(1)} (Ziel ${item.L}, ${dL > 0 ? '+' : ''}${dL.toFixed(1)} dB)`);
  else if (Math.abs(dL) > 3) warns.push(`Lautheit ${m.lk.toFixed(1)} (Ziel ${item.L}, ${dL > 0 ? '+' : ''}${dL.toFixed(1)} dB)`);
  if (x.attack != null && m.attack > x.attack) warns.push(`Attack ${m.attack.toFixed(1)} ms > ${x.attack}`);
  if (x.centroid && (m.centroid < x.centroid[0] || m.centroid > x.centroid[1])) warns.push(`Schwerpunkt ${m.centroid | 0} Hz (${x.centroid[0]}…${x.centroid[1]})`);
  if (x.flatMin != null && m.flat < x.flatMin) warns.push(`zu tonal: Flachheit ${m.flat.toFixed(2)} < ${x.flatMin}`);
  if (x.tonalMax != null && m.tonal > x.tonalMax) warns.push(`Tonspitze ${m.tonal.toFixed(0)} dB > ${x.tonalMax}`);
  const d = x.dur;
  if (d && (m.dur < d[0] || m.dur > d[1])) warns.push(`Dauer ${m.dur.toFixed(2)} s (${d[0]}…${d[1]})`);
  if (other && other.dryEnd > item.dur - 0.02) fails.push(`klingt nicht aus (trocken ${other.dryDur.toFixed(2)} s)`);
  if (other && x.dryDur && (other.dryDur < x.dryDur[0] || other.dryDur > x.dryDur[1])) warns.push(`Dauer trocken ${other.dryDur.toFixed(3)} s (${x.dryDur[0]}…${x.dryDur[1]})`);
  if (other && other.diff < 0.03) fails.push(`identisch wiederholt (Δ ${(other.diff * 100).toFixed(1)} %)`);
  if (item.err) fails.push(item.err);
  return { fails, warns };
}
function relations(R) {
  const g = (id) => R.find((r) => r.id === id)?.m;
  const out = [];
  const rel = (name, ok, info) => out.push({ name, ok: !!ok, info });
  const hg = g('hit_ground'), bg = g('bounce_grass'), bh = g('bounce_hard'), hs = g('hit_serve'), hv = g('hit_volley'), hp = g('hit_perfect'), hf = g('hit_frame');
  const hsoft = g('hit_soft'), hfar = g('hit_far'), al = g('applause_lo'), ah = g('applause_hi'), ooh = g('ooh'), bslow = g('bounce_grass_slow');
  if (hg && bg) rel('Aufsprung (Rasen) dunkler als Treffer', bg.centroid < hg.centroid * 0.6, `${bg.centroid | 0} vs ${hg.centroid | 0} Hz`);
  if (bh && bg) rel('Umrandung heller als Rasen', bh.centroid > bg.centroid * 1.15, `${bh.centroid | 0} vs ${bg.centroid | 0} Hz`);
  if (hg && bg) rel('Aufsprung leiser als Treffer', bg.lk < hg.lk - 3, `${bg.lk.toFixed(1)} vs ${hg.lk.toFixed(1)}`);
  if (bg && bslow) rel('langsamer Aufsprung leiser', bslow.lk < bg.lk - 3, `${bslow.lk.toFixed(1)} vs ${bg.lk.toFixed(1)}`);
  if (hs && hv) rel('Aufschlag lauter als Volley', hs.lk > hv.lk + 2, `${hs.lk.toFixed(1)} vs ${hv.lk.toFixed(1)}`);
  if (hp && hg) rel('Perfekt ≥ normal', hp.lk >= hg.lk, `${hp.lk.toFixed(1)} vs ${hg.lk.toFixed(1)}`);
  if (hsoft && hg) rel('Weich deutlich leiser', hsoft.lk < hg.lk - 3, `${hsoft.lk.toFixed(1)} vs ${hg.lk.toFixed(1)}`);
  if (hfar && hg) rel('Ferner Treffer leiser & dunkler', hfar.lk < hg.lk - 2 && hfar.centroid < hg.centroid, `${hfar.lk.toFixed(1)} / ${hfar.centroid | 0} Hz`);
  if (hf && hg) rel('Rahmen klingt anders (Bandverteilung)', Math.abs(hf.bands[1] - hg.bands[1]) + Math.abs(hf.bands[2] - hg.bands[2]) > 0.08, `mid ${hf.bands[1].toFixed(2)}/${hg.bands[1].toFixed(2)}`);
  if (al && ah) rel('Applaus skaliert mit Intensität', ah.lk > al.lk + 4, `${ah.lk.toFixed(1)} vs ${al.lk.toFixed(1)}`);
  const hush = R.find((r) => r.id === 'bed_hush')?.mm;
  if (hush) {
    const e = hush.env, blk = 120 / SR;
    const lvl = (a, b) => { let s = 0, n = 0; for (let i = Math.floor(a / blk); i < Math.floor(b / blk) && i < e.length; i++) { s += e[i] * e[i]; n++; } return db(s / Math.max(1, n)); };
    const d = lvl(3.4, 4.9) - lvl(0, 1);
    rel('„Ruhe bitte“ senkt Gemurmel ≥ 8 dB', d < -8, `${d.toFixed(1)} dB`);
  }
  if (ah && ooh) rel('„Ooh“ tonaler als Applaus', ooh.flat < ah.flat, `${ooh.flat.toFixed(2)} vs ${ah.flat.toFixed(2)}`);
  return out;
}

// ------------------------------------------------------------------ Zeichnen
const MAGMA = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
const LUT = (() => {
  const t = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const u = i / 255 * (MAGMA.length - 1), k = Math.min(MAGMA.length - 2, Math.floor(u)), f = u - k;
    for (let c = 0; c < 3; c++) t[i * 3 + c] = MAGMA[k][c] + (MAGMA[k + 1][c] - MAGMA[k][c]) * f;
  }
  return t;
})();
function drawSpec(cv, m, frames = m.frames, dry = false) {
  const W = cv.width, H = cv.height, g = cv.getContext('2d');
  const img = g.createImageData(W, H), d = img.data;
  const top = db(m.specMax), range = 80, fMin = 40, fMax = 16000;
  for (let y = 0; y < H; y++) {
    const hz = fMin * Math.pow(fMax / fMin, 1 - y / (H - 1)), bin = hz * FFT_N / SR, b0 = Math.floor(bin), bf = bin - b0;
    for (let x = 0; x < W; x++) {
      const f0 = Math.floor(x / W * frames), f1 = Math.max(f0 + 1, Math.floor((x + 1) / W * frames));
      let v = 0;
      for (let f = f0; f < f1 && f < frames; f++) { const o = f * m.bins; const p = m.spec[o + b0] * (1 - bf) + m.spec[o + b0 + 1] * bf; if (p > v) v = p; }
      const u = Math.max(0, Math.min(255, ((db(v) - top + range) / range) * 255)) | 0;
      const o = (y * W + x) * 4;
      d[o] = LUT[u * 3]; d[o + 1] = LUT[u * 3 + 1]; d[o + 2] = LUT[u * 3 + 2]; d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = 'rgba(255,255,255,.35)'; g.font = '9px ui-monospace,monospace';
  for (const hz of [100, 1000, 10000]) { const y = (1 - Math.log(hz / fMin) / Math.log(fMax / fMin)) * (H - 1); g.fillRect(0, y, 4, 1); g.fillText(hz >= 1000 ? hz / 1000 + 'k' : hz, 6, y + 3); }
  g.textAlign = 'right'; g.fillText(dry ? `trocken ${Math.round(frames * HOP / SR * 1000)} ms` : `${(frames * HOP / SR).toFixed(1)} s`, W - 3, 10); g.textAlign = 'left';
}
function drawWave(cv, m, color) {
  const W = cv.width, H = cv.height, g = cv.getContext('2d'), x = m.mono, n = x.length;
  g.fillStyle = '#0d1014'; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(0, H / 2, W, 1);
  // logarithmische Hüllkurve (dB, -60…0) als Schatten, lineare Wellenform darüber
  g.fillStyle = color + '33';
  for (let px = 0; px < W; px++) {
    const b = Math.floor(px / W * m.env.length), v = m.env[b] || 0;
    const h = Math.max(0, (db20(v) + 60) / 60) * H / 2;
    g.fillRect(px, H / 2 - h, 1, 2 * h);
  }
  g.fillStyle = color;
  for (let px = 0; px < W; px++) {
    const i0 = Math.floor(px / W * n), i1 = Math.floor((px + 1) / W * n);
    let lo = 0, hi = 0;
    for (let i = i0; i < i1; i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    g.fillRect(px, H / 2 - hi * H / 2, 1, Math.max(1, (hi - lo) * H / 2));
  }
}

// ------------------------------------------------------------------ Seite
const CSS = `
.al{position:fixed;inset:0;overflow:auto;z-index:50;background:#14171c;color:#d9dee5;font:13px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.al *{box-sizing:border-box}
.al canvas{position:static!important;inset:auto!important;width:100%!important;height:auto!important;display:block}
.al header{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;padding:12px 18px;background:rgba(20,23,28,.94);backdrop-filter:blur(8px);border-bottom:1px solid #262b33}
.al h1{font-size:17px;margin:0;font-weight:650;letter-spacing:.2px}.al h1 span{color:#f2c14e}
.al button{font:inherit;color:#e8ecf1;background:#232831;border:1px solid #343b46;border-radius:7px;padding:5px 11px;cursor:pointer}
.al button:hover{background:#2c333e;border-color:#4a5462}.al button.on{background:#f2c14e;color:#111;border-color:#f2c14e}
.al label{display:flex;align-items:center;gap:6px;color:#9aa5b3;font-size:12px}.al input[type=range]{width:90px;accent-color:#f2c14e}
.al .sum{padding:12px 18px;display:grid;grid-template-columns:minmax(300px,1.2fr) minmax(320px,1fr);gap:18px;border-bottom:1px solid #262b33}
.al .stat{font-size:13px;color:#aeb8c4}.al .stat b{font-size:20px;color:#fff;margin-right:4px}
.al .ok{color:#7ddc8a}.al .warn{color:#f2c14e}.al .fail{color:#ff6b6b}
.al .rel{font-size:12px;columns:2;column-gap:18px}.al .rel div{break-inside:avoid;padding:1px 0}
.al .grp{padding:10px 18px 4px;font-weight:650;font-size:14px;display:flex;align-items:center;gap:8px}
.al .grp i{width:10px;height:10px;border-radius:3px;display:inline-block}
.al .grid{display:grid;gap:10px;padding:4px 18px 10px}
.al .card{background:#1b1f26;border:1px solid #272d36;border-radius:9px;padding:7px;display:flex;flex-direction:column;gap:5px;min-width:0}
.al .card.fail{border-color:#7a2f35}.al .card.warn{border-color:#6b5a23}
.al .card .t{display:flex;align-items:center;gap:6px;font-weight:600;font-size:12.5px;white-space:nowrap;overflow:hidden}
.al .card .t span{overflow:hidden;text-overflow:ellipsis;flex:1}.al .card .t button{padding:1px 8px;font-size:12px}
.al .card canvas{width:100%;display:block;border-radius:4px;background:#0d1014}
.al .card .m{font:10.5px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:#97a3b1}
.al .card .n{font-size:10.5px;line-height:1.25}
.al canvas.chart{width:100%;height:auto;border-radius:6px;background:#0f1216}
.al .live{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
`;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'style') e.style.cssText = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'class') e.className = v; else e.setAttribute(k, v); }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

// ------------------------------------------------------------------ Live-System & Match-Demo
function liveFns(audio) {
  const t = () => audio.ctx.currentTime + 0.03;
  const S = () => ({ ac: audio.ctx, G: audio.G, sfx: audio.sfx, cr: audio.creatures, music: audio.music, crowd: audio.crowd, umpire: audio.umpire });
  return {
    play(item) {
      if (!audio.G) return;
      if (item.id === 'bed_calm') { liveState.excite = 0.15; return; }
      if (item.id === 'bed_excited') { liveState.excite = 0.9; audio.crowd.release(0.4); return; }
      if (item.id === 'bed_hush') { audio.crowd.hushNow(); return; }
      if (item.id === 'title_amb' || item.id === 'title_pad') { audio.setMode(audio.mode === 'title' ? 'match' : 'title'); return; }
      if (item.cat === 'voice') { audio.umpire.lineCall(item.id.slice(5), null); return; }
      if (item.cat === 'ui') { audio.ui(item.id.slice(3)); return; }
      item.fn(S(), t());
    },
  };
}
const liveState = { excite: 0.3 };

/** Skriptete Ballwechsel-Ereignisse (echtes GameEvent-Format) → audio.handle(). */
function demoRally(audio, done) {
  const players = [{ id: 'tom', name: 'Tom', pos: [0.6, 0, 12.2] }, { id: 'gerry', name: 'Gerry', pos: [-0.4, 0, -12.0] }];
  const C = { players, humans: [0], score: { call: () => 'Fifteen love' } };
  const seq = [
    [0.0, { type: 'phase', phase: 'pre_serve' }],
    [0.4, { type: 'ball_tap', player: 0 }], [1.0, { type: 'ball_tap', player: 0 }],
    [1.8, { type: 'serve_toss', player: 0 }],
    [2.3, { type: 'stroke_start', player: 0, stroke: 'serve', windup: 0.3, power: 0.95 }],
    [2.6, { type: 'hit', player: 0, stroke: 'serve', shot: 'flat', quality: 'perfect', speed: 52, pos: [0.4, 2.6, 12.0] }],
    [2.62, { type: 'serve_speed', kmh: 191 }],
    [3.05, { type: 'bounce', pos: [-1.6, 0, -5.2], in: true, speed: 38 }],
    [3.3, { type: 'stroke_start', player: 1, stroke: 'backhand', windup: 0.44, power: 0.6 }],
    [3.74, { type: 'hit', player: 1, stroke: 'backhand', shot: 'topspin', quality: 'good', speed: 27, pos: [-1.8, 0.9, -11.5] }],
    [3.9, { type: 'footstep', player: 0, pos: [0.4, 0, 12] }], [4.12, { type: 'footstep', player: 0, pos: [0.9, 0, 11.9] }], [4.33, { type: 'footstep', player: 0, pos: [1.5, 0, 11.8] }],
    [4.5, { type: 'split_step', player: 0 }],
    [4.62, { type: 'bounce', pos: [1.9, 0, 8.4], in: true, speed: 21 }],
    [4.6, { type: 'stroke_start', player: 0, stroke: 'forehand', windup: 0.42, power: 0.8 }],
    [5.02, { type: 'hit', player: 0, stroke: 'forehand', shot: 'topspin', quality: 'good', speed: 33, pos: [2.4, 1.0, 11.4] }],
    [5.78, { type: 'bounce', pos: [-3.4, 0, -9.8], in: true, speed: 23 }],
    [5.6, { type: 'stroke_start', player: 1, stroke: 'forehand_slice', windup: 0.4, power: 0.5 }],
    [6.0, { type: 'hit', player: 1, stroke: 'forehand_slice', shot: 'slice', quality: 'stretch', speed: 22, pos: [-3.9, 0.6, -11.0] }],
    [6.75, { type: 'net', pos: [-0.5, 0.88, 0], cord: true, speed: 18 }],
    [7.1, { type: 'bounce', pos: [-0.3, 0, 1.4], in: true, speed: 6 }],
    [7.2, { type: 'squeak', player: 0 }],
    [7.6, { type: 'bounce', pos: [-0.2, 0, 2.1], in: true, speed: 3 }],
    [7.62, { type: 'point', winner: 1, reason: 'double_bounce', rally: 4, closeCall: false }],
    [7.7, { type: 'phase', phase: 'point_over' }],
  ];
  playSeq(seq, audio, C, done);
}
function demoMatchPoint(audio, done) {
  const players = [{ id: 'tom', name: 'Tom', pos: [0.6, 0, 12.2] }, { id: 'gerry', name: 'Gerry', pos: [-0.4, 0, -12.0] }];
  const C = { players, humans: [0], score: { call: () => 'Game, set and match, Gerry' } };
  const seq = [
    [0, { type: 'pressure', kind: 'match_point' }],
    [0.6, { type: 'serve_toss', player: 1 }],
    [1.1, { type: 'stroke_start', player: 1, stroke: 'serve', windup: 0.3, power: 1 }],
    [1.4, { type: 'hit', player: 1, stroke: 'serve', shot: 'flat', quality: 'perfect', speed: 55, pos: [0, 2.5, -12] }],
    [1.42, { type: 'serve_speed', kmh: 205 }],
    [1.85, { type: 'bounce', pos: [0.1, 0, 6.35], in: true, speed: 40 }],
    [2.3, { type: 'bounce', pos: [0.9, 0, 15.5], in: true, speed: 30 }],
    [2.5, { type: 'wall', pos: [1, 0.5, 18], speed: 25 }],
    [2.52, { type: 'point', winner: 1, reason: 'ace', rally: 1, closeCall: true }],
    [2.52, { type: 'game', winner: 1 }], [2.52, { type: 'set', winner: 1 }], [2.52, { type: 'match', winner: 1 }],
    [3.5, { type: 'emote', player: 1, name: 'celebrate' }],
  ];
  playSeq(seq, audio, C, done);
}
function playSeq(seq, audio, C, done) {
  const t0 = performance.now();
  let i = 0;
  const tick = () => {
    const now = (performance.now() - t0) / 1000;
    while (i < seq.length && seq[i][0] <= now) {
      const ev = seq[i++][1];
      if (ev.type === 'phase') audio.update(0, { phase: ev.phase });
      else audio.handle(ev, C);
    }
    if (i < seq.length) setTimeout(tick, 10); else done?.();
  };
  tick();
}

// ------------------------------------------------------------------ Einstieg
export async function run(ctx = {}) {
  const lab = window.__audioLab = { done: false, summary: null, results: [], live: null };
  document.head.append(el('style', {}, CSS));
  const root = el('div', { class: 'al' });
  document.body.append(root);
  const only = (P.get('only') || '').split(',').filter(Boolean);
  const items = only.length ? CATALOG.filter((it) => only.some((o) => it.id.startsWith(o) || it.cat === o)) : CATALOG;
  const cols = +(P.get('cols') || 0);

  // --- Live-System
  const audio = new AudioSystem({ titleMusic: true });
  window.__audio = audio;
  const live = liveFns(audio);
  let raf = 0, last = performance.now();
  const loop = () => {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
    audio.update(dt, { excitement: liveState.excite });
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  // --- Kopfzeile
  const status = el('span', { class: 'stat' }, 'Audio aus – Klick startet');
  const ensure = async () => { const ok = await audio.unlock(); status.textContent = ok ? `Audio läuft (${audio.ctx.sampleRate} Hz)` : 'Audio blockiert'; return ok; };
  const slider = (name, v) => el('label', {}, name, el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: v, oninput: (e) => audio.setVolume(name, +e.target.value) }));
  const btn = (txt, fn, cls = '') => el('button', { class: cls, onclick: async (e) => { await ensure(); fn(e); } }, txt);
  const muteB = btn('Stumm', (e) => { audio.mute(!audio.muted); e.target.classList.toggle('on', audio.muted); });
  const pauseB = btn('Pause', (e) => { audio.setPaused(!audio.paused); e.target.classList.toggle('on', audio.paused); });
  const titleB = btn('Titelmodus', (e) => { audio.setMode(audio.mode === 'title' ? 'match' : 'title'); e.target.classList.toggle('on', audio.mode === 'title'); });
  const ex = el('label', {}, 'Aufregung', el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: liveState.excite, oninput: (e) => { liveState.excite = +e.target.value; } }));
  root.append(el('header', {},
    el('h1', {}, 'Tom & Gerry Open — ', el('span', {}, 'Audio-Labor')), status,
    el('div', { class: 'live' },
      btn('▶ Ballwechsel-Demo', () => demoRally(audio)), btn('▶ Matchball → Sieg', () => demoMatchPoint(audio)),
      btn('Schiedsrichter', () => audio.umpire.say('Thirty fifteen')), titleB, pauseB, muteB, ex,
      slider('master', 0.9), slider('sfx', 1), slider('crowd', 0.85), slider('voice', 1), slider('music', 0.6)),
  ));
  const sumBox = el('div', { class: 'sum' });
  root.append(sumBox);
  const sumL = el('div', {}, el('div', { class: 'stat' }, 'Offline-Selbsttest läuft …'));
  const chart = el('canvas', { class: 'chart', width: 760, height: 10 });
  sumBox.append(sumL, el('div', {}, chart));

  // --- Karten
  const cards = new Map();
  const groups = [...new Set(items.map((i) => i.cat))];
  for (const c of groups) {
    root.append(el('div', { class: 'grp' }, el('i', { style: `background:${CATS[c].color}` }), CATS[c].name));
    const grid = el('div', { class: 'grid', style: `grid-template-columns:repeat(${cols || 'auto-fill'}, minmax(${cols ? 0 : 230}px, 1fr))` });
    root.append(grid);
    for (const it of items.filter((i) => i.cat === c)) {
      const wave = el('canvas', { width: 300, height: 40 }), spec = el('canvas', { width: 300, height: 64 });
      const m = el('div', { class: 'm' }, '…'), n = el('div', { class: 'n' });
      const card = el('div', { class: 'card' },
        el('div', { class: 't' }, el('span', { title: it.id }, it.label), el('button', { onclick: async () => { await ensure(); live.play(it); } }, '▶')),
        wave, spec, m, n);
      grid.append(card);
      cards.set(it.id, { card, wave, spec, m, n });
    }
  }

  // Live-Systemtest (headless: Autoplay erlaubt) – alle Ereignistypen durch audio.handle()
  const liveTest = async () => {
    const r = { ok: false, errors: [], bakeMs: 0 };
    try {
      const t0 = performance.now();
      const ok = await audio.unlock();
      if (!ok) { r.errors.push('AudioContext nicht gestartet'); return r; }
      status.textContent = `Audio läuft (${audio.ctx.sampleRate} Hz)`;
      await audio.bakePromise;
      r.bakeMs = Math.round(performance.now() - t0);
      r.bakeTimes = audio.crowd.bakeTimes;
      const C = { players: [{ id: 'tom', name: 'Tom', pos: [0, 0, 12] }, { id: 'gerry', name: 'Gerry', pos: [0, 0, -12] }], humans: [0], score: { call: () => 'Fifteen love', gamesCall: () => 'Tom leads one game to love' } };
      const evs = [
        { type: 'stroke_start', player: 0, stroke: 'forehand', windup: 0.42, power: 0.7 }, { type: 'hit', player: 0, stroke: 'forehand', shot: 'topspin', quality: 'good', speed: 30, spin: [0, 0, 200], pos: [0, 1, 12] },
        { type: 'serve_toss', player: 0 }, { type: 'bounce', pos: [1, 0, -5], in: true, speed: 20 }, { type: 'bounce', pos: [1, 0, -5], speedIn: 20, vel: [0, 3, 10] },
        { type: 'net', pos: [0, 0.9, 0], cord: true }, { type: 'net', pos: [0, 0.5, 0], cord: false, speedIn: 20 }, { type: 'let' }, { type: 'fault', n: 1 }, { type: 'double_fault' },
        { type: 'line_call', call: 'out', pos: [4.2, 0, -10] }, { type: 'line_call', call: 'fault', pos: [0, 0, -6.45] },
        { type: 'point', winner: 0, reason: 'winner', rally: 9, closeCall: true }, { type: 'game', winner: 0 }, { type: 'set', winner: 0 }, { type: 'match', winner: 0 },
        { type: 'change_ends' }, { type: 'serve_speed', kmh: 210 }, { type: 'pressure', kind: 'break_point' }, { type: 'pressure', kind: 'match_point' },
        { type: 'footstep', player: 0 }, { type: 'post', pos: [6.4, 0.8, 0], speedIn: 15 }, { type: 'wall', pos: [0, 0.5, 18], speedIn: 12 }, { type: 'rest', pos: [0, 0, 18] },
        { type: 'emote', player: 1, name: 'celebrate' }, { type: 'unknown_thing' }, null, {},
      ];
      for (const e of evs) { try { audio.handle(e, C); } catch (err) { r.errors.push(`${e?.type}: ${err.message}`); } }
      for (const n of ['move', 'select', 'back', 'start', 'pause']) { try { audio.ui(n); } catch (err) { r.errors.push(`ui ${n}: ${err.message}`); } }
      for (const [k, v] of [['master', 0.5], ['sfx', 0.8], ['crowd', 0.7], ['voice', 0.9], ['music', 0.4], ['bogus', 1]]) audio.setVolume(k, v);
      audio.mute(true); audio.mute(false); audio.setPaused(true); audio.setPaused(false);
      audio.setVolume('master', 0); audio.update(0.016, { excitement: 0.5 }); audio.setVolume('master', 0.9);
      audio.update(0.016, { listenerPos: [0, 7, 20], listenerDir: [0, -0.3, -1], excitement: 0.5, phase: 'serve' });
      await new Promise((res) => setTimeout(res, 400));
      audio.umpire.cancel();
      r.stats = audio.stats();
      r.ok = r.errors.length === 0;
    } catch (err) { r.errors.push(String(err && err.stack || err)); }
    return r;
  };

  // --- Offline-Selbsttest
  const check = async () => {
    const tb = performance.now();
    const bakeCrowd = new Crowd();
    sumL.firstChild.textContent = 'Publikums-Texturen werden gebacken …';
    await bakeCrowd.bake((p, name) => { sumL.firstChild.textContent = `Backe Publikum: ${name} (${Math.round(p * 100)} %)`; });
    TEX = bakeCrowd.tex;
    const bakeMs = Math.round(performance.now() - tb);
    const gain = await chainGain();
    const results = lab.results;
    let k = 0;
    for (const it of items) {
      sumL.firstChild.textContent = `Rendere ${++k}/${items.length}: ${it.label}`;
      const t1 = performance.now();
      let buf, m, other = null;
      try {
        buf = await renderItem(it);
        m = analyze(buf);
        if (DRY.includes(it.cat)) {
          // trocken (ohne Hall/Limiter) zweimal: echte Ausklingdauer + Variation (nie identisch)
          const d1 = await renderItem(it, true), d2 = await renderItem(it, true);
          const a = d1.getChannelData(0), b = d2.getChannelData(0);
          let s = 0, e = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; e += a[i] * a[i]; }
          const md = analyze(d1);
          other = { diff: it.cat === 'ui' ? 1 : Math.sqrt(s / (e || 1e-20)), dryDur: md.dur, dryEnd: md.onset + md.dur, dryPeak: md.peak, md };
        }
      } catch (err) { it.err = String(err); m = null; }
      const ms = Math.round(performance.now() - t1);
      const c = cards.get(it.id);
      if (!m) { c.card.classList.add('fail'); c.n.innerHTML = `<span class="fail">${it.err}</span>`; results.push({ id: it.id, cat: it.cat, fails: [it.err], warns: [] }); continue; }
      const j = judge(it, m, other);
      drawWave(c.wave, m, CATS[it.cat].color);
      if (other) drawSpec(c.spec, other.md, Math.min(other.md.frames, Math.ceil((other.dryEnd + 0.06) * SR / HOP)), true); else drawSpec(c.spec, m);
      c.m.textContent = `pk ${m.peak.toFixed(1)}  L100 ${m.lk.toFixed(1)} (${it.L})  L400 ${m.lufs.toFixed(1)}  att ${m.attack.toFixed(1)}ms\nsc ${m.centroid | 0}Hz  fl ${m.flat.toFixed(2)}  ton ${m.tonal.toFixed(0)}dB  ${other ? 'Δ' + (other.diff * 100).toFixed(0) + '% dry ' + other.dryDur.toFixed(2) + 's' : ''} ${ms}ms`;
      c.m.style.whiteSpace = 'pre';
      c.n.innerHTML = [...j.fails.map((f) => `<span class="fail">✗ ${f}</span>`), ...j.warns.map((w) => `<span class="warn">! ${w}</span>`)].join('<br>') || '<span class="ok">✓ ok</span>';
      c.card.classList.toggle('fail', j.fails.length > 0); c.card.classList.toggle('warn', !j.fails.length && j.warns.length > 0);
      const { spec, env, mono, ...rest } = m;
      results.push({ id: it.id, cat: it.cat, L: it.L, m: { ...rest, bands: m.bands.map((b) => +b.toFixed(3)) }, diff: other?.diff, dryDur: other?.dryDur, fails: j.fails, warns: j.warns, ms });
      results[results.length - 1].mm = m;
      await new Promise((r) => setTimeout(r, 0));
    }
    const rel = relations(results);
    const nFail = results.filter((r) => r.fails.length).length, nWarn = results.filter((r) => !r.fails.length && r.warns.length).length;
    const relFail = rel.filter((r) => !r.ok).length;
    lab.live = P.get('live') === '0' ? null : await liveTest();
    lab.summary = { items: results.length, fails: nFail, warns: nWarn, relFail, bakeMs, chainGainDb: +gain.toFixed(2), live: lab.live };
    for (const r of results) delete r.mm;
    // Zusammenfassung zeichnen
    sumL.innerHTML = '';
    sumL.append(
      el('div', { class: 'stat' }, el('b', { class: nFail ? 'fail' : 'ok' }, String(results.length - nFail - nWarn)), 'ok  ',
        el('b', { class: 'warn' }, String(nWarn)), 'Hinweise  ', el('b', { class: nFail ? 'fail' : 'ok' }, String(nFail)), 'Fehler  ',
        el('b', { class: relFail ? 'fail' : 'ok' }, `${rel.length - relFail}/${rel.length}`), 'Relationen'),
      el('div', { class: 'stat', style: 'margin:4px 0 8px' }, `Publikum gebacken in ${bakeMs} ms · Masterkette ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB @ −30 dBFS · Live-Test: `,
        el('span', { class: lab.live ? (lab.live.ok ? 'ok' : 'fail') : 'warn' }, lab.live ? (lab.live.ok ? `ok (Bake live ${lab.live.bakeMs} ms, Stimme: ${lab.live.stats?.voice ?? '—'})` : lab.live.errors.join('; ')) : 'aus')),
      el('div', { class: 'rel' }, ...rel.map((r) => el('div', { class: r.ok ? 'ok' : 'fail' }, `${r.ok ? '✓' : '✗'} ${r.name} `, el('span', { style: 'color:#7d8896' }, r.info)))),
    );
    drawChart(chart, results);
    lab.relations = rel;
    lab.done = true;
  };
  if (P.get('check') !== '0') check().catch((e) => { sumL.textContent = 'Fehler: ' + e; lab.error = String(e); lab.done = true; });
  else lab.done = true;
  return { dispose() { cancelAnimationFrame(raf); audio.dispose(); root.remove(); } };
}

/** Lautheitsübersicht: je Klang ein Balken (Momentan-Max), Zielband je Kategorie hinterlegt. */
function drawChart(cv, results) {
  const rows = results.filter((r) => r.m);
  const W = 760, rowH = 7, top = 18, H = top + rows.length * rowH + 16;
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#0f1216'; g.fillRect(0, 0, W, H);
  const x0 = 120, x1 = W - 10, lo = -55, hi = -5, X = (v) => x0 + (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (x1 - x0);
  g.font = '10px ui-monospace,monospace'; g.fillStyle = '#7d8896';
  for (let v = lo; v <= hi; v += 10) { g.fillRect(X(v), top - 4, 1, H - top); g.fillText(v + '', X(v) - 8, 11); }
  g.fillText('L100 vs. Ziel ±3', x0 - 116, 11);
  rows.forEach((r, i) => {
    const y = top + i * rowH, c = CATS[r.cat];
    g.fillStyle = c.color + '22'; g.fillRect(X(r.L - 3), y, X(r.L + 3) - X(r.L - 3), rowH - 1);
    g.fillStyle = r.fails.length ? '#ff6b6b' : r.warns.length ? '#c9a640' : c.color; g.fillRect(X(lo), y + 1, X(r.m.lk) - X(lo), rowH - 3);
    g.fillStyle = '#fff'; g.fillRect(X(r.L), y, 1, rowH - 1);
    if (i % 1 === 0) { g.fillStyle = '#8b96a3'; g.font = '7px ui-monospace,monospace'; g.fillText(r.id.slice(0, 20), 2, y + 6); }
  });
}

// Stuhlschiedsrichter & Linienrichter über speechSynthesis (en-GB bevorzugt, z.B. "Daniel").
// Eigene Warteschlange: Durchsagen überlappen nie, Verzögerungen (Applaus abwarten), Watchdog gegen
// hängende Sprachausgabe, Abbruch bei Pause/Menü. Linienrichter-Rufe ("Out!", "Fault!") haben
// Vorrang; ohne Sprachausgabe wird ein synthetischer Ruf (Formant-Synthese) im Stadion gespielt.
// Ohne speechSynthesis: keine Fehler, Punkte-Ansagen entfallen still.
import { vocal, shoutSpec } from './voice.js';
import { jit } from './dsp.js';

// Pegel der synthetischen Linienrichter-Rufe (im Audio-Labor kalibriert)
const SHOUT_GAIN = { out: 0.33, fault: 0.26, net: 0.18 };
const NOVELTY = /albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|pipe|junior|ralph|kathy|princess|fred/i;
const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

/** Ansagetext sprechbar machen: "Fifteen–Love" → "Fifteen love", Ziffern → Wörter. */
export function speakable(text) {
  return String(text)
    .replace(/(\d+)/g, (m) => (+m <= 20 ? NUM[+m] : m))
    .replace(/\s*[–—]\s*/g, ' ')
    .replace(/(\w)-(\w)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

export class Umpire {
  constructor(opts = {}) {
    const w = typeof window !== 'undefined' ? window : null;
    this.synth = w && w.speechSynthesis && typeof w.SpeechSynthesisUtterance !== 'undefined' ? w.speechSynthesis : null;
    this.allowRemote = !!opts.allowRemoteVoices;     // nur lokale Stimmen (keine Netzwerk-TTS)
    this.preferSynthShout = !!opts.synthLineCalls;   // Linienrichter immer synthetisch rufen lassen
    this.queue = []; this.current = null;
    this.voice = null; this.lineVoice = null;
    this.volume = 1; this.muted = false; this.enabled = true;
    this.rate = 0.95; this.pitch = 0.9;
    this.G = null;
    this.onStart = null; this.onEnd = null;   // Ducking-Hooks
    this.blocked = false;                      // Sprachausgabe vom Browser verweigert
    this._timer = 0; this._watch = 0;
    this.lastSpoken = '';
    if (this.synth) {
      this._pickVoices();
      try { this.synth.addEventListener('voiceschanged', () => this._pickVoices()); } catch { /* ältere Browser */ }
    }
  }

  attach(G) { this.G = G; }
  /** true, wenn eine passende Stimme vorhanden ist. */
  get available() { return !!(this.synth && this.voice && !this.blocked); }

  _pickVoices() {
    let vs = [];
    try { vs = this.synth.getVoices() || []; } catch { vs = []; }
    const en = vs.filter((v) => /^en([-_]|$)/i.test(v.lang || '') && !NOVELTY.test(v.name || ''));
    const pool = en.filter((v) => v.localService !== false);
    const use = pool.length ? pool : this.allowRemote ? en : [];
    if (!use.length) { this.voice = null; this.lineVoice = null; return; }
    const score = (v, line) => {
      const n = v.name || '', gb = /en[-_]gb/i.test(v.lang);
      let s = gb ? 50 : /en[-_](au|ie|nz)/i.test(v.lang) ? 15 : 5;
      if (!line) { if (/daniel/i.test(n)) s += 100; if (/arthur|oliver|george|male/i.test(n)) s += 30; }
      else { if (/kate|serena|martha|stephanie|hazel|female|samantha|karen/i.test(n)) s += 40; if (/daniel/i.test(n)) s -= 30; }
      if (/enhanced|premium/i.test(n)) s += 10;
      if (/google/i.test(n)) s -= 5;
      return s;
    };
    this.voice = use.slice().sort((a, b) => score(b, false) - score(a, false))[0];
    const others = use.filter((v) => v !== this.voice);
    this.lineVoice = others.length ? others.sort((a, b) => score(b, true) - score(a, true))[0] : this.voice;
  }

  /** Bei Nutzergeste aufrufen (Chrome verlangt eine Aktivierung für speak()). */
  prime() {
    if (!this.synth || this._primed) return;
    this._primed = true;
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; this.synth.speak(u); } catch { /* egal */ }
  }

  /**
   * Schiedsrichter-Ansage einreihen. opts: { delay (s), rate, pitch, replace (gleichartige ersetzen), tag }
   */
  say(text, opts = {}) {
    if (!text || !this.enabled) return;
    const at = now() + (opts.delay ?? 0) * 1000;
    if (opts.tag) { const old = this.queue.find((q) => q.tag === opts.tag); if (old) { old.text = text; old.at = Math.max(old.at, at); return; } }
    this.queue.push({ text: speakable(text), at, rate: opts.rate ?? this.rate, pitch: opts.pitch ?? this.pitch, voice: 'umpire', tag: opts.tag || null });
    this._kick();
  }

  /** Linienrichter-Ruf ('out' | 'fault' | 'net'), sofort, mit Vorrang. pos: Weltposition (für Ersatzruf). */
  lineCall(word, pos = null) {
    if (!this.enabled) return;
    const text = word === 'fault' ? 'Fault!' : word === 'net' ? 'Net!' : 'Out!';
    const item = { text, at: now(), rate: 1.2, pitch: 1.25, voice: 'line', word, pos, shout: true };
    if (this.current && this.current.voice === 'umpire') this._abortCurrent();
    this.queue.unshift(item);
    this._kick();
  }

  /** Alles abbrechen (Pause, Menü, Neustart). */
  cancel() {
    this.queue.length = 0;
    clearTimeout(this._timer); clearTimeout(this._watch);
    if (this.current) { this.current = null; this.onEnd?.(); }
    if (this.synth) { try { this.synth.cancel(); } catch { /* egal */ } }
  }
  setMuted(m) { this.muted = !!m; if (m) this.cancel(); }
  get busy() { return !!this.current || this.queue.length > 0; }

  _abortCurrent() {
    clearTimeout(this._watch);
    this.current = null;
    if (this.synth) { try { this.synth.cancel(); } catch { /* egal */ } }
  }

  _kick() {
    clearTimeout(this._timer);
    if (this.current || !this.queue.length) return;
    const it = this.queue[0], wait = it.at - now();
    if (wait > 5) { this._timer = setTimeout(() => this._kick(), wait); return; }
    this.queue.shift();
    this._speak(it);
  }

  _speak(it) {
    if (this.muted) { this._kick(); return; }
    this.current = it;
    if (this.available && !(it.shout && this.preferSynthShout)) {
      const u = new SpeechSynthesisUtterance(it.text);
      const v = it.voice === 'line' ? this.lineVoice : this.voice;
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = it.rate; u.pitch = it.pitch; u.volume = Math.max(0, Math.min(1, this.volume));
      let done = false;
      const fin = (err) => {
        if (done) return; done = true;
        if (err && (err.error === 'not-allowed')) this.blocked = true;
        if (this.current === it) this._finish();
      };
      u.onstart = () => this.onStart?.(it);
      u.onend = () => fin(null);
      u.onerror = (e) => fin(e);
      it.utterance = u;   // Referenz halten (Chrome-GC-Bug: onend feuert sonst nicht)
      try {
        if (this.synth.speaking && !this.synth.pending) this.synth.cancel();
        this.synth.speak(u);
        this.lastSpoken = it.text;
      } catch { fin(null); return; }
      // Watchdog: geschätzte Dauer × 2 + Reserve
      const est = (0.4 + it.text.length * 0.075 / it.rate) * 1000;
      this._watch = setTimeout(() => { if (this.current === it) { try { this.synth.cancel(); } catch { /* egal */ } fin(null); } }, est * 2 + 1500);
      return;
    }
    // Ersatz ohne Sprachausgabe: Linienrichter-Ruf synthetisch, Punkte-Ansagen still
    let dur = 0.05;
    if (it.shout && this.G) {
      const ac = this.G.ac, t = ac.currentTime + 0.01;
      const out = this.G.strip('voice', it.pos || null, SHOUT_GAIN[it.word] ?? 0.3, 0.55);
      const spec = shoutSpec(it.word || 'out', { female: false, pitch: jit(1, 0.05) });
      vocal(ac, out, t, spec);
      dur = spec.dur + 0.1;
      this.onStart?.(it);
      this.lastSpoken = it.text;
    }
    this._watch = setTimeout(() => { if (this.current === it) this._finish(); }, dur * 1000);
  }

  _finish() {
    clearTimeout(this._watch);
    this.current = null;
    this.onEnd?.();
    this._timer = setTimeout(() => this._kick(), 180);
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

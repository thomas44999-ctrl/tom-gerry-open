// Kleine gemeinsame Helfer (ohne DOM-Pflicht, damit auch in Node nutzbar).

/** Minimaler Event-Emitter. */
export class Emitter {
  constructor() { this._h = new Map(); }
  on(type, fn) { if (!this._h.has(type)) this._h.set(type, new Set()); this._h.get(type).add(fn); return () => this.off(type, fn); }
  once(type, fn) { const off = this.on(type, (e) => { off(); fn(e); }); return off; }
  off(type, fn) { this._h.get(type)?.delete(fn); }
  emit(type, e) { this._h.get(type)?.forEach((fn) => fn(e)); this._h.get('*')?.forEach((fn) => fn(type, e)); }
}

/** URL-Parameter (im Browser), in Node leer. params.get('scene'), params.num('t', 0), params.bool('demo') */
const _search = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams('');
export const params = {
  get: (k, d = null) => (_search.has(k) ? _search.get(k) : d),
  has: (k) => _search.has(k),
  num: (k, d = 0) => (_search.has(k) && _search.get(k) !== '' && !isNaN(+_search.get(k)) ? +_search.get(k) : d),
  bool: (k, d = false) => (_search.has(k) ? !['0', 'false', 'no', 'off'].includes(_search.get(k)) : d),
  list: (k, d = []) => (_search.has(k) ? _search.get(k).split(',').map((s) => (isNaN(+s) ? s : +s)) : d),
};

/** Wartet einen Animationsframe (oder 0 ms in Node) – für schrittweises Laden mit Fortschrittsanzeige. */
export const nextFrame = () => new Promise((r) => (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Einfacher Zähler für Lade-Fortschritt über mehrere Schritte. */
export function progressTracker(onProgress, steps) {
  let done = 0;
  return {
    step(label) { done++; onProgress?.(Math.min(1, done / steps), label); return nextFrame(); },
    sub(fraction, label) { onProgress?.(Math.min(1, (done + fraction) / steps), label); },
  };
}

/** Fester Ringpuffer für Float-Daten (z.B. Ballspur, Replays). */
export class Ring {
  constructor(capacity, stride = 1) { this.cap = capacity; this.stride = stride; this.data = new Float32Array(capacity * stride); this.head = 0; this.size = 0; }
  push(...vals) { const o = this.head * this.stride; for (let i = 0; i < this.stride; i++) this.data[o + i] = vals[i] ?? 0; this.head = (this.head + 1) % this.cap; this.size = Math.min(this.size + 1, this.cap); }
  /** i = 0 ist der älteste Eintrag. Gibt Offset in this.data zurück. */
  offset(i) { return ((this.head - this.size + i + this.cap * 2) % this.cap) * this.stride; }
  clear() { this.head = 0; this.size = 0; }
}

export const isBrowser = typeof window !== 'undefined';

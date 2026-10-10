// Kleine DOM-Helfer für die UI-Schicht (keine Abhängigkeiten).

/** Element erzeugen: h('div', 'klasse', '<b>html</b>') */
export function h(tag, cls, html) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html != null) el.innerHTML = html;
  return el;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** HTML-Escaping für fremde Texte (Spielernamen etc.). */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Farbe in CSS-String: '#hex' | 'rgb()' bleibt, [r,g,b] (0..1 oder 0..255) wird umgerechnet. */
export function cssColor(c, fallback = '#ffffff') {
  if (c == null) return fallback;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) || ArrayBuffer.isView(c)) {
    const big = c[0] > 1 || c[1] > 1 || c[2] > 1;
    const k = big ? 1 : 255;
    return `rgb(${Math.round(c[0] * k)}, ${Math.round(c[1] * k)}, ${Math.round(c[2] * k)})`;
  }
  return fallback;
}

/** WAAPI-Animation mit Promise; ohne WAAPI sofort fertig. */
export function animate(el, keyframes, opts) {
  if (!el || typeof el.animate !== 'function') return Promise.resolve();
  const a = el.animate(keyframes, opts);
  return a.finished.then(() => a, () => a);
}

/** Wartet ms Millisekunden. */
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Zahl deutsch formatieren (Dezimalkomma). */
export const deNum = (v, digits = 0) => (Number.isFinite(v) ? v.toFixed(digits).replace('.', ',') : '–');

/** Sekunden -> "m:ss" bzw. "h:mm:ss". */
export function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  sec = Math.round(sec);
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${p2(mm)}:${p2(ss)}` : `${mm}:${p2(ss)}`;
}

/** Bevorzugt reduzierte Bewegung? */
export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

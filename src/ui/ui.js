// UI-Schicht "Tom & Gerry Open": DOM-Overlay über dem Canvas (deutsche Texte).
// API siehe ARCHITECTURE §10 + Erweiterungen (Intro, Hawk-Eye-Panel, Seitenwechsel, Replay-Badge …).

import { Emitter } from '../core/util.js';
import { PLAYER_STATS } from '../sim/strokes.js';
import { h, esc, cssColor, animate, wait, reducedMotion } from './dom.js';
import { icon } from './icons.js';
import { logoSVG, portraitSVG, emblemSVG } from './logo.js';
import { injectStyles } from './styles.js';
import { Hud } from './hud.js';
import { MenuNav, TitleMenu, PauseMenu, ControlsOverlay, MatchEndScreen, loadSettings, saveSettings, resolveSettings, DEFAULT_SETTINGS, OPTIONS, FORMAT_RULES, GAME_PACE } from './menus.js';

export { loadSettings, saveSettings, resolveSettings, DEFAULT_SETTINGS, OPTIONS, FORMAT_RULES, GAME_PACE };

const TIPS = [
  'Drück die Schlagtaste früh – je länger du lädst, desto mehr Druck bekommt der Ball.',
  'Halte beim Treffer eine Richtung, um gezielt in die Ecken zu spielen.',
  'Auf Rasen bleibt der Slice flach – ideal, um den Gegner aus dem Rhythmus zu bringen.',
  'Klebt dein Gegner am Netz? Ein hoher Lob über seinen Kopf ist die beste Antwort.',
  'Ein Stoppball wirkt Wunder gegen Spieler, die tief hinter der Grundlinie stehen.',
  'Aufschlag: erst werfen, dann im höchsten Punkt schlagen – der Timing-Balken zeigt den perfekten Moment.',
  'Gerry ist schneller auf den Pfoten, Tom hat den härteren Aufschlag.',
  'Linien gehören zum Feld: Berührt der Ball die Linie, ist er drin.',
  'Seitenwechsel nach jedem ungeraden Spiel – im Tiebreak alle sechs Punkte.',
  'Bei Einstand brauchst du zwei Punkte in Folge, um das Spiel zu gewinnen.',
  'Läufst du ans Netz, spielst du automatisch Volley – kurze Wege, schnelle Hände.',
  'Achte auf das Feedback am Spieler: „Zu früh“ oder „Zu spät“ kostet Kontrolle.',
];

const BANNER_KIND = {
  ace: { size: 'lg', ac: '#F3D98A', fx: 'burst', dur: 2100 },
  winner: { size: 'lg', ac: '#F3D98A', fx: 'burst', dur: 2000 },
  break: { size: 'lg', ac: '#FF7A6B', band: 'rgba(58,12,10,.9)', fx: 'burst', player: true, dur: 2200 },
  doublefault: { size: 'lg', ac: '#FF7A6B', band: 'rgba(58,12,10,.9)', dur: 2000 },
  fault: { size: 'md', ac: '#FF7A6B', band: 'rgba(58,12,10,.88)', dur: 1300 },
  out: { size: 'md', ac: '#FF7A6B', band: 'rgba(58,12,10,.88)', dur: 1300 },
  call: { size: 'md', ac: '#FF7A6B', band: 'rgba(58,12,10,.88)', dur: 1300 },
  let: { size: 'md', ac: '#F6EFDF', dur: 1300 },
  game: { size: 'lg', ac: '#F3D98A', player: true, dur: 2200 },
  set: { size: 'xl', ac: '#F3D98A', player: true, fx: 'burst', dur: 2800 },
  match: { size: 'xl', ac: '#F3D98A', player: true, fx: 'confetti', dur: 3600 },
  deuce: { size: 'md', ac: '#F6EFDF', dur: 1600 },
  advantage: { size: 'md', ac: '#F3D98A', player: true, dur: 1600 },
  tiebreak: { size: 'lg', ac: '#F3D98A', dur: 2200 },
  changeends: { size: 'md', ac: '#F3D98A', dur: 1800 },
  pressure: { size: 'md', ac: '#FF7A6B', player: true, dur: 1700 },
  info: { size: 'md', ac: '#F6EFDF', dur: 1600 },
};

/** Banner-Arten aus anderen Modulen (rules.js bannerDE/eventLabelDE, GameEvents) auf eigene Arten abbilden. */
function normKind(kind, title) {
  const k = String(kind || 'info').toLowerCase().replace(/[_-]/g, '');
  const t = title.toLowerCase();
  if (k === 'deuce' && t.startsWith('vorteil')) return 'advantage';
  if (k === 'fault' && t.startsWith('doppelfehler')) return 'doublefault';
  if (k === 'info' && t.startsWith('seitenwechsel')) return 'changeends';
  if (k === 'call') return 'out';
  if (k === 'point' || k === 'breakpoint' || k === 'setpoint' || k === 'matchpoint') return k === 'point' ? 'info' : 'pressure';
  return BANNER_KIND[k] ? k : 'info';
}

const ANNOUNCE = {
  ace: () => 'Ass!', winner: () => 'Winner!', doublefault: () => 'Doppelfehler', fault: () => 'Fehler',
  out: () => 'Aus', let: () => 'Netz', break: () => 'Break!', game: (n) => `Spiel ${n}`, set: (n) => `Satz ${n}`,
  match: () => 'Matchgewinn', deuce: () => 'Einstand', advantage: (n) => `Vorteil ${n}`, tiebreak: () => 'Tiebreak',
  changeends: () => 'Seitenwechsel',
};

const PROFILES = {
  tom: { nick: 'Der Kanonier', seed: 'Nr. 1 der Setzliste', facts: ['1,34 m', 'Rechtshänder', 'Grundlinien-Power'] },
  gerry: { nick: 'Die Samtpfote', seed: 'Nr. 2 der Setzliste', facts: ['1,17 m + Ohren', 'Rechte Pfote', 'Flinker Allrounder'] },
};

// ------------------------------------------------------------------ Loader

class Loader {
  constructor(ui) {
    this.ui = ui;
    this.el = h('div', 'tg-loader');
    this.el.setAttribute('role', 'progressbar');
    this.el.setAttribute('aria-valuemin', '0');
    this.el.setAttribute('aria-valuemax', '100');
    this.el.innerHTML = `
      <div class="tg-loader-bg"><i class="tg-loader-beam"></i><i class="tg-loader-beam tg-loader-beam-2"></i></div>
      <div class="tg-loader-center">
        <div class="tg-loader-logo">${logoSVG({ layout: 'stacked' })}</div>
        <div class="tg-loader-bar"><i class="tg-loader-fill"></i><i class="tg-loader-head"></i></div>
        <div class="tg-loader-row"><span class="tg-loader-label">Vorbereitung</span><span class="tg-loader-pct">0 %</span></div>
      </div>
      <div class="tg-loader-tip"><span class="tg-loader-k">Tipp</span><span class="tg-loader-t"></span></div>`;
    this.fill = this.el.querySelector('.tg-loader-fill');
    this.head = this.el.querySelector('.tg-loader-head');
    this.label = this.el.querySelector('.tg-loader-label');
    this.pct = this.el.querySelector('.tg-loader-pct');
    this.tip = this.el.querySelector('.tg-loader-t');
    this.target = 0; this.shown = 0; this._pctInt = -1; this._raf = 0; this.visible = false;
    this._tipIdx = Math.floor(Math.random() * TIPS.length);
  }

  show() {
    if (this.visible) return;
    this.visible = true;
    this.el.classList.remove('is-out');
    this.el.classList.add('is-on');
    this.tip.textContent = TIPS[this._tipIdx];
    clearInterval(this._tipTimer);
    this._tipTimer = setInterval(() => this._nextTip(), 5200);
    this._loop();
  }

  _nextTip() {
    this._tipIdx = (this._tipIdx + 1) % TIPS.length;
    animate(this.tip, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-.4em)' }], { duration: 260, easing: 'ease-in' }).then(() => {
      this.tip.textContent = TIPS[this._tipIdx];
      animate(this.tip, [{ opacity: 0, transform: 'translateY(.4em)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.16,1,.3,1)' });
    });
  }

  _loop() {
    if (this._raf) return;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      this.shown += (this.target - this.shown) * (1 - Math.exp(-dt * 7));
      if (this.target - this.shown < 0.0005) this.shown = this.target;
      this._apply();
      this._raf = this.visible ? requestAnimationFrame(step) : 0;
    };
    this._raf = requestAnimationFrame(step);
  }

  _apply() {
    const p = this.shown;
    this.fill.style.transform = `scaleX(${p.toFixed(4)})`;
    this.head.style.transform = `translateX(${(p * 100).toFixed(2)}%)`;
    const pi = Math.round(p * 100);
    if (pi !== this._pctInt) { this._pctInt = pi; this.pct.textContent = `${pi} %`; this.el.setAttribute('aria-valuenow', String(pi)); }
  }

  /** Fortschritt 0..1 + Stufenbeschriftung. */
  set(p, label) {
    this.show();
    this.target = Math.max(this.target, Math.min(1, Math.max(0, +p || 0)));
    if (label) this.label.textContent = label;
    // falls der Main-Thread blockiert ist (schwere Build-Schritte), sofort zumindest den Zielwert sichtbar machen
    if (this.target - this.shown > 0.25) { this.shown = this.target - 0.12; this._apply(); }
  }

  /** Ausblenden (Promise nach Ende der Animation). */
  hide() {
    if (!this.visible) return Promise.resolve();
    this.target = 1; this.shown = 1; this._apply();
    this.el.classList.add('is-out');
    clearInterval(this._tipTimer);
    return wait(reducedMotion() ? 10 : 820).then(() => {
      this.visible = false;
      this.el.classList.remove('is-on', 'is-out');
    });
  }
}

// ------------------------------------------------------------------ UI

export class UI {
  constructor(rootEl = document.body) {
    injectStyles(document);
    this.events = new Emitter();
    this.root = h('div', 'tg-ui');
    if (rootEl === document.body || rootEl === document.documentElement) this.root.classList.add('is-fixed');
    rootEl.appendChild(this.root);
    this.nav = new MenuNav((type, e) => this.events.emit(type, e));

    // Ebenen (Reihenfolge = Stapelung)
    this.lbTop = h('div', 'tg-lb tg-lb-t'); this.lbBot = h('div', 'tg-lb tg-lb-b');
    this.hud = new Hud(this);
    this.bannerLayer = h('div', 'tg-banners');
    this.bannerLayer.setAttribute('aria-live', 'polite');
    this.toastLayer = h('div', 'tg-toasts');
    this.toastLayer.setAttribute('aria-live', 'polite');
    this.replayEl = h('div', 'tg-replay-badge tg-glass', `<i class="tg-rec"></i>${icon('replay')}<span class="tg-replay-t"><b>Wiederholung</b><small>Zeitlupe</small></span>`);
    this.hawkEl = h('div', 'tg-hawk tg-glass');
    this.introEl = h('div', 'tg-intro');
    this.changeEl = h('div', 'tg-change');
    this.title = new TitleMenu(this);
    this.pause = new PauseMenu(this);
    this.end = new MatchEndScreen(this);
    this.controls = new ControlsOverlay(this);
    this.loader = new Loader(this);
    this.fadeEl = h('div', 'tg-fade');

    this.root.append(
      this.hud.el, this.lbTop, this.lbBot, this.replayEl, this.hawkEl, this.introEl, this.bannerLayer, this.toastLayer,
      this.changeEl, this.title.el, this.pause.el, this.end.el, this.controls.el, this.loader.el, this.fadeEl,
    );

    this.nav.onChange = () => {
      const st = this.nav.stack;
      this.root.classList.toggle('is-modal', st.includes(this.pause.screen) || st.includes(this.controls.screen) || st.includes(this.end.screen));
    };
    this._bq = []; this._bCur = null;
    this._toasts = [];
    this._fadeAnim = null; this._fadeLevel = 0;
    this._hawkTimer = 0; this._introTimer = 0;
  }

  // ---------------------------------------------------------------- Allgemein

  /**
   * Event-Abo. 'sound' -> Name passend zu audio.ui(name): move|select|back|toggle|start|pause|resume|score|tick
   * (Verdrahtung: ui.on('sound', (n) => audio.ui(n))). 'banner' -> { kind, title, sub } beim Einblenden eines Banners.
   */
  on(type, fn) { return this.events.on(type, fn); }

  /** true, solange ein Menü/Overlay Tastatur & Gamepad abfängt (Spiel-Input dann ignorieren). */
  get menuOpen() { return this.nav.open; }
  get blocksInput() { return this.nav.open; }

  /** Optional pro Frame aufrufen; ansonsten pollt die UI selbst, solange ein Menü offen ist. */
  pollGamepad() { this.nav.pollGamepad(performance.now()); }

  /** Kein Touch-Layout im Vertical Slice; nur Klasse für zukünftige Anpassungen. */
  setTouchMode(on) { this.root.classList.toggle('is-touch', !!on); }

  /** Glas-Unschärfe abschalten (z. B. Grafik 'low'). */
  setReducedEffects(on) { this.root.classList.toggle('is-lowfx', !!on); }

  /** Darstellungsrelevante Einstellungen selbst anwenden (Grafik 'low' -> keine Glas-Unschärfe). */
  _applySettings(s) { if (s) this.setReducedEffects(s.quality === 'low'); }

  loadSettings() { return loadSettings(); }
  saveSettings(s) { saveSettings(s); }

  get _lastScore() { return this.hud._norm && this.hud._norm.games ? this.hud._norm : null; }

  _playersChanged() { /* Platzhalter für abhängige Elemente */ }

  _scoreSummaryHTML() {
    const n = this._lastScore, P = this.hud.players;
    if (!n) return '<span class="tg-ps-meta">Centre Court · Finale</span>';
    const nm = (i) => `<span class="tg-ps-n" style="--pc:${P[i].color}">${esc(String(P[i].name).toUpperCase())}</span>`;
    const sets = n.sets.length ? `<span class="tg-ps-meta">Sätze ${n.sets.map((s) => `${s[0]}:${s[1]}`).join(' ')}</span>` : '';
    return `<div class="tg-ps-line">${nm(0)}<b>${n.games[0]}</b><i>:</i><b>${n.games[1]}</b>${nm(1)}</div>
      <div class="tg-ps-line tg-ps-pts">${n.tiebreak ? 'Tiebreak ' : ''}<b>${esc(n.pts[0])}</b><i>:</i><b>${esc(n.pts[1])}</b>${sets}</div>`;
  }

  // ---------------------------------------------------------------- Titel / Pause / Ende / Steuerung

  showTitle(settings, handlers = {}) {
    this.hud.hide();
    this.title.show(settings, handlers);
  }

  hideTitle() { this.title.hide(); }

  showPause(opts = {}) { this.pause.show(opts); }
  hidePause() { this.pause.hide(); }

  /** stats: siehe Report (winner, sets, duration, longestRally, p:[{aces,…},{…}]). */
  showMatchEnd(stats, handlers = {}) {
    this.hud.hide();
    this.end.show(stats || {}, handlers);
  }

  hideMatchEnd() { this.end.hide(); }

  /** Steuerungs-Overlay (Promise beim Schließen). */
  showControls() { return this.controls.show(); }
  hideControls() { this.controls.hide(); }

  // ---------------------------------------------------------------- Banner

  /**
   * Großes kinetisches Banner. kind: ace|winner|break|doublefault|fault|out|let|game|set|match|deuce|
   * advantage|tiebreak|changeends|pressure|info. opts: { player, color, duration, hold }.
   * Mehrere Banner werden nacheinander gezeigt. Gibt Promise (Ende) zurück.
   */
  banner(title, sub = '', kind = 'info', opts = {}) {
    // Erlaubt auch direkt { title, sub, kind } (z. B. Score.bannerDE / eventLabelDE aus rules.js)
    if (title && typeof title === 'object') { opts = sub && typeof sub === 'object' ? sub : opts; ({ title, sub = '', kind = 'info' } = title); }
    title = String(title ?? '');
    kind = normKind(kind, title);
    return new Promise((resolve) => {
      this._bq.push({ title, sub: sub ? String(sub) : '', kind, opts: opts || {}, resolve });
      if (this._bq.length > 3) { const drop = this._bq.splice(0, this._bq.length - 3); drop.forEach((b) => b.resolve()); }
      this._pumpBanner();
    });
  }

  /** Standard-Ansagen auf Deutsch: announce('game', { player: 0, sub: '4 : 3' }). */
  announce(kind, { player, sub = '', duration } = {}) {
    const name = player != null && this.hud.players[player] ? this.hud.players[player].name : '';
    const t = (ANNOUNCE[kind] || (() => kind))(name);
    return this.banner(t, sub, kind, { player, duration });
  }

  clearBanners() {
    this._bq.forEach((b) => b.resolve()); this._bq.length = 0;
    if (this._bCur) this._exitBanner(this._bCur, true);
  }

  _pumpBanner() {
    const cur = this._bCur;
    if (cur) {
      if (this._bq.length && !cur.exiting) {
        const minEnd = cur.start + 950;
        clearTimeout(cur.timer);
        cur.timer = setTimeout(() => this._exitBanner(cur), Math.max(0, minEnd - performance.now()));
      }
      return;
    }
    const b = this._bq.shift();
    if (!b) return;
    this._bCur = b;
    b.el = this._buildBanner(b);
    this.bannerLayer.appendChild(b.el);
    // Lange Titel (z. B. "Spiel, Satz und Sieg") auf die Bildschirmbreite einpassen (einmalige Messung, kein Hot-Path)
    const t = b.el.querySelector('.tg-banner-title');
    const avail = (this.root.clientWidth || innerWidth) * 0.9;
    if (t && t.offsetWidth > avail) t.style.fontSize = `${(parseFloat(getComputedStyle(t).fontSize) * avail / t.offsetWidth).toFixed(1)}px`;
    b.start = performance.now();
    const def = BANNER_KIND[b.kind] || BANNER_KIND.info;
    if (b.kind === 'match' || b.kind === 'set') this.events.emit('sound', 'score');
    this.events.emit('banner', { kind: b.kind, title: b.title, sub: b.sub });
    if (!b.opts.hold) {
      const dur = b.opts.duration ?? def.dur;
      b.timer = setTimeout(() => this._exitBanner(b), this._bq.length ? 950 : dur);
    }
  }

  _exitBanner(b, fast = false) {
    if (b.exiting) return;
    b.exiting = true;
    clearTimeout(b.timer);
    b.el.classList.add('is-out');
    setTimeout(() => {
      b.el.remove();
      b.resolve();
      if (this._bCur === b) this._bCur = null;
      this._pumpBanner();
    }, fast ? 120 : 430);
  }

  _buildBanner(b) {
    const def = BANNER_KIND[b.kind] || BANNER_KIND.info;
    let ac = def.ac;
    let pIdx = b.opts.player;
    if (pIdx == null && def.player) {
      // Spieler aus dem Titel ableiten, sonst aus dem Untertitel (erstes Vorkommen)
      const find = (txt) => {
        const up = txt.toUpperCase();
        let best = -1, at = Infinity;
        this.hud.players.forEach((p, i) => { const k = up.indexOf(String(p.name).toUpperCase()); if (k >= 0 && k < at) { at = k; best = i; } });
        return best;
      };
      pIdx = find(b.title);
      if (pIdx < 0 && b.sub) pIdx = find(b.sub);
    }
    const pc = pIdx != null && pIdx >= 0 && this.hud.players[pIdx] ? this.hud.players[pIdx].color : null;
    if (b.opts.color) ac = cssColor(b.opts.color, ac);
    else if (pc && (b.kind === 'game' || b.kind === 'advantage')) ac = pc;
    const el = h('div', `tg-banner tg-b-${b.kind} tg-b-${def.size}`);
    el.setAttribute('role', 'status');
    el.style.setProperty('--ac', ac);
    if (pc) el.style.setProperty('--pc', pc);
    if (def.band) el.style.setProperty('--band', def.band);
    const text = b.title.toUpperCase();
    // Wörter zusammenhalten (kein Umbruch mitten im Wort), Buchstaben einzeln animieren
    let i = 0;
    const letters = text.split(' ').map((w) => `<span class="tg-bw">${[...w].map((ch) => `<span class="tg-bl" style="--i:${i++}">${esc(ch)}</span>`).join('')}</span>`).join('<span class="tg-bsp"> </span>');
    let fx = '';
    if (def.fx === 'burst') fx = '<i class="tg-burst"></i><i class="tg-burst tg-burst-2"></i>';
    else if (def.fx === 'confetti') {
      fx = '<i class="tg-burst"></i><span class="tg-confetti">' + Array.from({ length: 36 }, (_, k) => {
        const a = (k / 36) * Math.PI * 2 + (k % 4) * 0.21, r = 10 + ((k * 53) % 13);
        const cols = ['#F3D98A', '#D9B45A', '#F6EFDF', pc || '#8CCBF2', '#D7EE4B'];
        return `<i style="--dx:${(Math.cos(a) * r * 1.4).toFixed(2)}em;--dy:${(Math.sin(a) * r * 0.7 - 2).toFixed(2)}em;--r:${(k * 113) % 720}deg;--d:${(k % 6) * 35}ms;--c:${cols[k % cols.length]}"></i>`;
      }).join('') + '</span>';
    }
    el.innerHTML = `<div class="tg-banner-in">
      <div class="tg-banner-fx">${fx}</div>
      <div class="tg-banner-band"><span class="tg-banner-echo" aria-hidden="true">${esc(text)}</span><i class="tg-banner-sweep"></i></div>
      <i class="tg-banner-line tg-banner-line-t"></i><i class="tg-banner-line tg-banner-line-b"></i>
      ${b.kind === 'match' || b.kind === 'set' ? `<div class="tg-banner-kick">${b.kind === 'match' ? (/satz und sieg/i.test(b.title) ? 'Matchgewinn' : 'Spiel, Satz und Sieg') : 'Satzgewinn'}</div>` : ''}
      <div class="tg-banner-title" aria-label="${esc(b.title)}">${pc && def.player ? `<span class="tg-banner-pc">${portraitSVG(this.hud.players[pIdx].id || (pIdx ? 'gerry' : 'tom'))}</span>` : ''}${letters}</div>
      ${b.sub ? `<div class="tg-banner-sub">${esc(b.sub)}</div>` : ''}
    </div>`;
    el.style.setProperty('--n', String(i));
    return el;
  }

  // ---------------------------------------------------------------- Toast

  /** Kleine Meldung oben mittig. icon: Name aus icons.js (optional). */
  toast(text, { icon: ico = 'info', duration = 2400 } = {}) {
    const el = h('div', 'tg-toast tg-glass', `${icon(ico)}<span>${esc(text)}</span>`);
    el.setAttribute('role', 'status');
    this.toastLayer.appendChild(el);
    this._toasts.push(el);
    while (this._toasts.length > 3) this._dropToast(this._toasts[0]);
    el._t = setTimeout(() => this._dropToast(el), duration);
    return el;
  }

  _dropToast(el) {
    const i = this._toasts.indexOf(el);
    if (i < 0) return;
    this._toasts.splice(i, 1);
    clearTimeout(el._t);
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 360);
  }

  // ---------------------------------------------------------------- Fade

  /** Schwarzblende: fade(true, 400) -> schwarz, fade(false, 400) -> sichtbar. */
  fade(toBlack = true, ms = 400) {
    const to = toBlack ? 1 : 0;
    const from = this._fadeAnim ? +getComputedStyle(this.fadeEl).opacity : this._fadeLevel;
    this._fadeAnim?.cancel();
    this._fadeLevel = to;
    if (!ms || typeof this.fadeEl.animate !== 'function') { this.fadeEl.style.opacity = String(to); this._fadeAnim = null; return Promise.resolve(); }
    const a = this.fadeEl.animate([{ opacity: from }, { opacity: to }], { duration: ms, easing: 'cubic-bezier(.45,0,.55,1)', fill: 'forwards' });
    this._fadeAnim = a;
    return a.finished.then(() => {
      if (this._fadeAnim === a) { this.fadeEl.style.opacity = String(to); a.cancel(); this._fadeAnim = null; }
    }, () => {});
  }

  // ---------------------------------------------------------------- Replay

  /** Replay-Kennzeichnung mit Letterbox. label z. B. 'Zeitlupe' | 'Andere Perspektive'. */
  replayBadge(on, label = 'Zeitlupe') {
    if (on) this.replayEl.querySelector('small').textContent = label;
    this.root.classList.toggle('is-replay', !!on);
    this.hud.setReplay(!!on);
  }

  // ---------------------------------------------------------------- Hawk-Eye

  /**
   * Linienkamera-Panel. data: { verdict: 'IN'|'AUS', distanceMm, line?: 'Grundlinie'|'Seitenlinie'|'Aufschlaglinie', duration?, hold? }
   * distanceMm: IN = Überlappung des Balls mit der Linie, AUS = Abstand zur Linie. null blendet aus.
   */
  hawkeye(data) {
    clearTimeout(this._hawkTimer);
    if (!data) { this._hideHawk(); return Promise.resolve(); }
    const isIn = /^(in|true)$/i.test(String(data.verdict));
    const mm = Math.max(0, Math.round(Math.abs(+data.distanceMm || 0)));
    const line = data.line || 'Linie';
    // Draufsicht: Feld links, Linie (50 mm) in der Mitte, Aus rechts; Ballabdruck 67 mm (in Flugrichtung gestreckt).
    // Alles in mm mit Ursprung an der Innenkante der Linie; Maßstab passt sich an, damit nichts abgeschnitten wird.
    const vis = Math.min(mm, 110);
    const b0 = isIn ? 50 - Math.max(vis, 0.6) : 50 + Math.max(vis, 0.6); // linker Rand des Abdrucks
    const lo = Math.min(0, b0), hi = Math.max(50, b0 + 67);
    const S = Math.min(1.05, 188 / (hi - lo));
    // zentrieren, aber die Linie möglichst rechts von der "IM FELD"-Beschriftung halten
    const x0 = Math.min(Math.max(110 - ((lo + hi) / 2) * S, 64, 8 - lo * S), 212 - hi * S);
    const X = (v) => (x0 + v * S).toFixed(1);
    const R = 33.5 * S, cx = X(b0 + 33.5), cy = 56;
    const oe = X(50), be = X(b0);
    const gapA = isIn ? be : oe, gapB = isIn ? oe : be;
    const gw = Math.abs(gapB - gapA), a = +gapA, b = +gapB;
    // Maßkette: bei kleinen Abständen Pfeile von außen (→| |←), sonst innen (|←→|)
    const arrows = gw < 16
      ? `M${(a - 15).toFixed(1)} 107 H${a} M${(a - 4).toFixed(1)} 104 L${a} 107 L${(a - 4).toFixed(1)} 110 M${(b + 15).toFixed(1)} 107 H${b} M${(b + 4).toFixed(1)} 104 L${b} 107 L${(b + 4).toFixed(1)} 110`
      : `M${a} 107 H${b} M${(a + 4).toFixed(1)} 104 L${a} 107 L${(a + 4).toFixed(1)} 110 M${(b - 4).toFixed(1)} 104 L${b} 107 L${(b - 4).toFixed(1)} 110`;
    const measure = mm > 0
      ? `<rect x="${gapA}" y="13" width="${Math.max(0.8, gw).toFixed(1)}" height="90" class="tg-hk-gap"/>
         <path d="M${a} 101 V113 M${b} 101 V113 ${arrows}" class="tg-hk-meas"/>`
      : '';
    this.hawkEl.className = `tg-hawk tg-glass ${isIn ? 'is-v-in' : 'is-v-out'}`;
    this.hawkEl.innerHTML = `
      <div class="tg-hawk-head">${icon('eye')}<span>Linienkamera</span><em>${esc(line)}</em></div>
      <div class="tg-hawk-view"><svg viewBox="0 0 220 120" aria-hidden="true">
        <defs><linearGradient id="tgHkG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2F8A4C"/><stop offset="1" stop-color="#1F6537"/></linearGradient>
          <radialGradient id="tgHkB" cx=".42" cy=".4" r=".6"><stop offset="0" stop-color="#F1FA8A" stop-opacity=".98"/><stop offset=".7" stop-color="#D2E640" stop-opacity=".88"/><stop offset="1" stop-color="#A9C424" stop-opacity=".75"/></radialGradient>
          <linearGradient id="tgHkL" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#E9E6DA"/><stop offset=".5" stop-color="#FBFAF4"/><stop offset="1" stop-color="#E4E0D2"/></linearGradient></defs>
        <rect width="220" height="120" fill="url(#tgHkG)"/>
        <g opacity=".1">${[0, 1, 2, 3, 4, 5, 6].map((k) => `<rect x="0" y="${k * 18}" width="220" height="9" fill="#fff"/>`).join('')}</g>
        <rect x="${oe}" y="0" width="${(220 - oe).toFixed(1)}" height="120" fill="#000" opacity=".16"/>
        <rect x="${X(0)}" y="0" width="${(50 * S).toFixed(1)}" height="120" fill="url(#tgHkL)"/>
        <text x="8" y="10" class="tg-hk-lbl">‹ IM FELD</text>
        <text x="212" y="10" text-anchor="end" class="tg-hk-lbl">AUS ›</text>
        <g class="tg-hk-ball">
          <ellipse cx="${cx}" cy="${cy + 2}" rx="${(R * 1.04).toFixed(1)}" ry="${(R * 1.24).toFixed(1)}" fill="#000" opacity=".18"/>
          <ellipse cx="${cx}" cy="${cy}" rx="${R.toFixed(1)}" ry="${(R * 1.22).toFixed(1)}" fill="url(#tgHkB)" stroke="#F6FCB0" stroke-width="1.1"/>
        </g>
        ${measure}
      </svg></div>
      <div class="tg-hawk-verdict"><span class="tg-hk-v">${isIn ? 'IN' : 'AUS'}</span><span class="tg-hk-d">${mm} <small>mm</small></span></div>
      <div class="tg-hawk-note">${isIn ? (mm > 0 ? `Ball berührt die ${esc(line)}` : 'Ball berührt die Linie hauchdünn') : `Ball verfehlt die ${esc(line)}`}</div>`;
    this.hawkEl.classList.add('is-on');
    this.events.emit('sound', 'tick');
    return new Promise((resolve) => {
      this._hawkResolve = resolve;
      if (!data.hold) this._hawkTimer = setTimeout(() => this._hideHawk(), data.duration ?? 4200);
    });
  }

  _hideHawk() {
    if (!this.hawkEl.classList.contains('is-on')) return;
    this.hawkEl.classList.add('is-out');
    setTimeout(() => { this.hawkEl.classList.remove('is-on', 'is-out'); }, 380);
    const r = this._hawkResolve; this._hawkResolve = null; r?.();
  }

  // ---------------------------------------------------------------- Seitenwechsel

  /**
   * Seitenwechsel-Übergang (Wischblende). opts: { sub, onMid, cover = true }.
   * onMid wird aufgerufen, wenn das Bild vollständig verdeckt ist (Kamera-Schnitt). Promise am Ende.
   */
  changeEnds(opts = {}) {
    const { sub = '', onMid = null, cover = true } = opts;
    const el = this.changeEl, P = this.hud.players;
    el.className = `tg-change${cover ? ' is-cover' : ''}`;
    el.innerHTML = `<i class="tg-change-wipe"></i><i class="tg-change-edge"></i><i class="tg-change-edge tg-change-edge-2"></i>
      <div class="tg-change-c">
        <div class="tg-change-swap">
          <span class="tg-cs-p tg-cs-a" style="--pc:${P[0].color}">${portraitSVG(P[0].id || 'tom')}</span>
          <span class="tg-change-arrows"><span class="tg-ca">${icon('swap')}</span></span>
          <span class="tg-cs-p tg-cs-b" style="--pc:${P[1].color}">${portraitSVG(P[1].id || 'gerry')}</span>
        </div>
        <div class="tg-change-t">Seitenwechsel</div>
        ${sub ? `<div class="tg-change-s">${esc(sub)}</div>` : ''}
      </div>`;
    void el.offsetWidth;
    el.classList.add('is-on');
    this.events.emit('sound', 'tick');
    const total = reducedMotion() ? 600 : 2700;
    if (onMid) setTimeout(() => { try { onMid(); } catch (e) { setTimeout(() => { throw e; }); } }, total * 0.32);
    return wait(total).then(() => { el.classList.remove('is-on'); el.innerHTML = ''; });
  }

  // ---------------------------------------------------------------- Intro

  /**
   * Spieler-Vorstellung beim Einlaufen. players: [{ id, name, color, nick?, seed?, facts?[] }, …] oder ein einzelnes Objekt.
   * opts: { duration = 5200, hold, subtitle = 'Finale · Centre Court' }. Promise nach dem Ausblenden.
   */
  showIntro(players, opts = {}) {
    clearTimeout(this._introTimer);
    const list = (Array.isArray(players) ? players : [players]).filter(Boolean).slice(0, 2);
    const card = (p, side, idx) => {
      const id = p.id || (String(p.name).toLowerCase().includes('gerry') ? 'gerry' : 'tom');
      const prof = PROFILES[id] || {};
      const st = PLAYER_STATS[id] || {};
      const color = cssColor(p.color, this.hud.players[idx]?.color || '#fff');
      const facts = p.facts || prof.facts || [];
      const attrs = [
        ['Aufschlag', st.serve], ['Power', st.power], ['Spin', st.spin],
        ['Tempo', st.maxSpeed ? Math.min(1, st.maxSpeed / 7.2) : undefined], ['Gefühl', st.touch],
      ].filter((a) => Number.isFinite(a[1]));
      return `<div class="tg-intro-card tg-glass tg-intro-${side}" style="--pc:${color};--d:${idx * 260}ms">
        <i class="tg-intro-stripe"></i>
        <div class="tg-intro-portrait">${portraitSVG(id)}</div>
        <div class="tg-intro-body">
          <div class="tg-intro-seed">${esc(p.seed || prof.seed || '')}</div>
          <div class="tg-intro-name">${esc(String(p.name || id).toUpperCase())}</div>
          <div class="tg-intro-nick">„${esc(p.nick || prof.nick || '')}“</div>
          <div class="tg-intro-facts">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</div>
          <div class="tg-intro-attrs">${attrs.map(([l, v], k) => `<span class="tg-at-l">${l}</span><span class="tg-at-b"><i style="--v:${v.toFixed(3)};--k:${k}"></i></span><span class="tg-at-v">${Math.round(v * 100)}</span>`).join('')}</div>
        </div>
      </div>`;
    };
    const two = list.length === 2;
    this.introEl.className = `tg-intro${two ? ' is-two' : ''}`;
    const top = two ? `<div class="tg-intro-top tg-glass">${emblemSVG({ text: false, cls: 'tg-intro-em' })}<div><b>Tom &amp; Gerry Open</b><span>${esc(opts.subtitle || 'Finale · Centre Court')}</span></div></div>` : '';
    this.introEl.innerHTML = `${top}<div class="tg-intro-row">${two
      ? `${card(list[0], 'l', 0)}<div class="tg-intro-vs"><span>VS</span></div>${card(list[1], 'r', 1)}`
      : card(list[0], 'l', list[0]?.index ?? (String(list[0]?.id) === 'gerry' ? 1 : 0))}</div>`;
    void this.introEl.offsetWidth;
    this.introEl.classList.add('is-on');
    this.events.emit('sound', 'tick');
    return new Promise((resolve) => {
      this._introResolve = resolve;
      if (!opts.hold) this._introTimer = setTimeout(() => this.hideIntro(), opts.duration ?? 5200);
    });
  }

  hideIntro() {
    clearTimeout(this._introTimer);
    if (!this.introEl.classList.contains('is-on')) return;
    this.introEl.classList.add('is-out');
    setTimeout(() => { this.introEl.classList.remove('is-on', 'is-out'); this.introEl.innerHTML = ''; }, 520);
    const r = this._introResolve; this._introResolve = null; r?.();
  }

  // ---------------------------------------------------------------- Aufräumen

  destroy() {
    this.nav.destroy();
    clearInterval(this.loader._tipTimer);
    this.root.remove();
  }
}

// Menüs: Einstellungsmodell (persistiert), Menü-Navigation (Tastatur/Maus/Gamepad),
// Titelbildschirm, Pausenmenü, Steuerungs-Overlay und Match-Ende mit Statistik.

import { h, esc, animate, fmtDuration } from './dom.js';
import { icon } from './icons.js';
import { logoSVG, trophySVG, portraitSVG } from './logo.js';
import { normSets } from './hud.js';

// ------------------------------------------------------------------ Einstellungen

export const DEFAULT_SETTINGS = Object.freeze({
  player: 'tom', difficulty: 'normal', format: 'short', mode: 'single', pace: 'normal',
  quality: 'auto', sound: true, voice: true,
});

/** Optionen je Einstellung: [Wert, Anzeigetext]. */
export const OPTIONS = {
  player: [['tom', 'Tom'], ['gerry', 'Gerry']],
  difficulty: [['easy', 'Leicht'], ['normal', 'Mittel'], ['hard', 'Schwer']],
  format: [['tiebreak', 'Tiebreak (bis 7)'], ['short', 'Kurzer Satz (bis 4)'], ['set', 'Ein Satz (bis 6)'], ['bo3', 'Best of 3']],
  mode: [['single', 'Einzel gegen CPU'], ['watch', 'Zuschauen (CPU gegen CPU)']],
  pace: [['relaxed', 'Gemütlich'], ['normal', 'Normal'], ['brisk', 'Flott']],
  quality: [['auto', 'Auto'], ['low', 'Niedrig'], ['medium', 'Mittel'], ['high', 'Hoch'], ['ultra', 'Ultra']],
  sound: [[true, 'An'], [false, 'Aus']],
  voice: [[true, 'An'], [false, 'Aus']],
};

/** Spieltempo: Zeitfaktor für Ballwechsel (Ball, Spieler, Animation). Normal = Arcade-Tempo der Schlag-Presets. */
export const GAME_PACE = Object.freeze({ relaxed: 0.8, normal: 1, brisk: 1.2 });

/** Format-Schlüssel -> Regel-Format für rules.js (ARCHITECTURE §6). */
export const FORMAT_RULES = {
  tiebreak: { sets: 1, games: 6, tiebreakAt: 6, shortTiebreak: 7, startGames: [6, 6] },
  short: { sets: 1, games: 4, tiebreakAt: 4, shortTiebreak: 7 },
  set: { sets: 1, games: 6, tiebreakAt: 6, shortTiebreak: 7 },
  bo3: { sets: 3, games: 6, tiebreakAt: 6, shortTiebreak: 7 },
};

const STORE_KEY = 'tg-open.settings.v1';
const PLAYER_IDS = ['tom', 'gerry'];

export function sanitizeSettings(o) {
  const s = { ...DEFAULT_SETTINGS };
  if (o && typeof o === 'object') {
    if (o.umpireVoice !== undefined && o.voice === undefined) o = { ...o, voice: o.umpireVoice };
    for (const k of Object.keys(OPTIONS)) if (OPTIONS[k].some(([v]) => v === o[k])) s[k] = o[k];
  }
  return s;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return sanitizeSettings(JSON.parse(raw));
  } catch { /* privater Modus o. ä. */ }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(sanitizeSettings(s))); } catch { /* ignorieren */ }
}

/** Abgeleitete Werte für den Spielstart (wird an onStart übergeben). */
export function resolveSettings(s) {
  const humanIndex = PLAYER_IDS.indexOf(s.player);
  return {
    ...s,
    players: PLAYER_IDS.slice(),
    humanIndex: s.mode === 'watch' ? -1 : humanIndex,
    humans: s.mode === 'watch' ? [] : [humanIndex],
    formatRules: { ...FORMAT_RULES[s.format] },
    umpireVoice: s.voice,
  };
}

export const optionLabel = (key, val) => (OPTIONS[key].find(([v]) => v === val) || OPTIONS[key][0])[1];

// ------------------------------------------------------------------ Menü-Bausteine

function buttonItem(label, ico, cls = '') {
  const el = h('button', `tg-item ${cls}`);
  el.type = 'button';
  el.setAttribute('role', 'menuitem');
  el.innerHTML = `<span class="tg-item-ico">${icon(ico)}</span><span class="tg-item-l">${label}</span>`;
  return el;
}

function optionItem(label, ico) {
  const el = h('button', 'tg-item tg-item-opt');
  el.type = 'button';
  el.setAttribute('role', 'menuitem');
  el.innerHTML = `<span class="tg-item-ico">${icon(ico)}</span><span class="tg-item-l">${label}</span>
    <span class="tg-opt"><i class="tg-opt-a tg-opt-prev" data-dir="-1">${icon('chevL')}</i><span class="tg-opt-v"></span><i class="tg-opt-a tg-opt-next" data-dir="1">${icon('chevR')}</i></span>`;
  return el;
}

/** Ein Menü-"Bildschirm" mit fokussierbaren Einträgen. */
class Screen {
  constructor(nav, { el, items, onBack, onStartButton, horizontal = false, keys = null, backSound = 'back' }) {
    this.nav = nav; this.el = el; this.items = items; this.index = 0; this.backSound = backSound;
    this.onBack = onBack; this.onStartButton = onStartButton; this.horizontal = horizontal; this.keys = keys;
    items.forEach((it, i) => {
      it.el.tabIndex = -1;
      it.el.addEventListener('pointerenter', () => { if (this.nav.top === this && this.index !== i) this.focus(i); });
      it.el.addEventListener('click', (e) => {
        if (e.detail === 0) return; // Tastatur-Klick: wird über keydown behandelt
        if (this.nav.top !== this) return;
        this.focus(i, true);
        const a = e.target.closest?.('[data-dir]');
        if (it.adjust && a) it.adjust(+a.dataset.dir);
        else if (it.adjust && !it.activate) it.adjust(1);
        else this.activate();
      });
    });
  }

  focus(i, silent = false) {
    const n = this.items.length;
    if (!n) return;
    i = ((i % n) + n) % n;
    const prev = this.items[this.index];
    if (prev) prev.el.classList.remove('is-focus');
    this.index = i;
    const it = this.items[i];
    it.el.classList.add('is-focus');
    try { it.el.focus({ preventScroll: true }); } catch { /* ignorieren */ }
    if (!silent) this.nav.sound('move');
  }

  move(d) {
    const n = this.items.length;
    let i = this.index;
    for (let k = 0; k < n; k++) { i = (i + d + n) % n; if (!this.items[i].disabled) break; }
    this.focus(i);
  }

  adjust(d) {
    const it = this.items[this.index];
    if (it?.adjust) { it.adjust(d); return; }
    if (this.horizontal) this.move(d);
  }

  activate() {
    const it = this.items[this.index];
    if (!it) return;
    if (it.activate) { this.nav.sound(it.sound || 'select'); it.activate(); }
    else if (it.adjust) it.adjust(1);
  }

  back() { if (this.onBack) { this.nav.sound(this.backSound); this.onBack(); } }
}

/** Verwaltet den Menü-Stapel und leitet Tastatur/Gamepad an den obersten Bildschirm. */
export class MenuNav {
  constructor(emit) {
    this.stack = [];
    this.emit = emit;
    this._pad = { primed: false, prev: [], dir: 0, axis: '', next: 0 };
    this._raf = 0;
    this._onKey = (e) => this._key(e);
    window.addEventListener('keydown', this._onKey, true);
  }

  get top() { return this.stack[this.stack.length - 1] || null; }
  get open() { return this.stack.length > 0; }

  sound(name) { this.emit?.('sound', name); }

  screen(opts) { return new Screen(this, opts); }

  push(scr, index = 0) {
    if (this.stack.includes(scr)) this.stack.splice(this.stack.indexOf(scr), 1);
    this.stack.push(scr);
    scr.focus(index, true);
    this._pad.primed = false;
    this._startPad();
    this.onChange?.();
  }

  remove(scr) {
    const i = this.stack.indexOf(scr);
    if (i < 0) return;
    this.stack.splice(i, 1);
    scr.items.forEach((it) => it.el.classList.remove('is-focus'));
    const t = this.top;
    if (t) t.focus(t.index, true);
    else { try { document.activeElement?.blur?.(); } catch { /* ignorieren */ } }
    this.onChange?.();
  }

  _key(e) {
    const t = this.top;
    if (!t) return;
    const k = e.key, c = e.code;
    let used = true;
    if (t.keys && t.keys[c]) t.keys[c](e);
    else if (k === 'ArrowUp' || c === 'KeyW') t.move(-1);
    else if (k === 'ArrowDown' || c === 'KeyS') t.move(1);
    else if (k === 'ArrowLeft' || c === 'KeyA') t.adjust(-1);
    else if (k === 'ArrowRight' || c === 'KeyD') t.adjust(1);
    else if (k === 'Enter' || k === ' ' || c === 'Space' || c === 'NumpadEnter') { if (!e.repeat) t.activate(); }
    else if (k === 'Escape' || k === 'Backspace') { if (!e.repeat) t.back(); }
    else if (k === 'Tab') t.move(e.shiftKey ? -1 : 1);
    else used = false;
    if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
  }

  _startPad() {
    if (this._raf || typeof navigator === 'undefined' || !navigator.getGamepads) return;
    const loop = (now) => {
      if (!this.open) { this._raf = 0; return; }
      this.pollGamepad(now);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  /** Gamepad abfragen (wird intern per RAF aufgerufen, solange ein Menü offen ist; extern optional). */
  pollGamepad(now = performance.now()) {
    const t = this.top;
    if (!t || !navigator.getGamepads) return;
    let pad = null;
    for (const p of navigator.getGamepads()) if (p && p.connected) { pad = p; break; }
    if (!pad) return;
    const P = this._pad;
    const b = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    const cur = [b(0), b(1), b(9), b(8)];
    if (!P.primed) { P.prev = cur; P.primed = true; return; }
    const edge = (i) => cur[i] && !P.prev[i];
    if (edge(0)) t.activate();
    else if (edge(1)) t.back();
    else if (edge(2)) { if (t.onStartButton) { this.sound('select'); t.onStartButton(); } else t.activate(); }
    P.prev = cur;
    // Richtungen (Steuerkreuz + linker Stick) mit Wiederholung
    const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
    let dir = '';
    if (b(12) || ay < -0.55) dir = 'u'; else if (b(13) || ay > 0.55) dir = 'd';
    else if (b(14) || ax < -0.55) dir = 'l'; else if (b(15) || ax > 0.55) dir = 'r';
    if (!dir) { P.axis = ''; return; }
    if (dir !== P.axis) { P.axis = dir; P.next = now + 380; }
    else if (now >= P.next) P.next = now + 130;
    else return;
    const top = this.top;
    if (!top) return;
    if (dir === 'u') top.move(-1); else if (dir === 'd') top.move(1);
    else if (dir === 'l') top.adjust(-1); else top.adjust(1);
  }

  destroy() { window.removeEventListener('keydown', this._onKey, true); cancelAnimationFrame(this._raf); }
}

// ------------------------------------------------------------------ Titel

/** Titelbildschirm über dem Live-3D-Hintergrund. */
export class TitleMenu {
  constructor(ui) {
    this.ui = ui;
    this.el = h('div', 'tg-title');
    this.el.innerHTML = `
      <div class="tg-title-scrim"></div>
      <div class="tg-title-panel">
        <div class="tg-title-logo">${logoSVG({ layout: 'horizontal' })}</div>
        <div class="tg-title-card tg-glass">
          <div class="tg-menu" role="menu" aria-label="Hauptmenü"></div>
        </div>
        <div class="tg-hints">
          <span><kbd>↑</kbd><kbd>↓</kbd> Auswahl</span><span><kbd>←</kbd><kbd>→</kbd> Ändern</span><span><kbd>Enter</kbd> Bestätigen</span>
          <span class="tg-hints-pad">${icon('gamepad')} Gamepad unterstützt</span>
        </div>
      </div>
      <div class="tg-title-foot"><span>Echtzeit-3D · 100 % aus Code generiert</span></div>`;
    this.menu = this.el.querySelector('.tg-menu');
    this.settings = loadSettings();
    this.handlers = {};

    const start = buttonItem('Match starten', 'play', 'tg-item-primary');
    start.insertAdjacentHTML('beforeend', '<span class="tg-item-sub"></span><span class="tg-item-shine"></span>');
    this.startSub = start.querySelector('.tg-item-sub');
    const sep = h('div', 'tg-menu-sep', '<span>Einstellungen</span>');
    const rows = [
      ['player', 'Spieler', 'user'], ['difficulty', 'Gegner', 'gauge'], ['format', 'Format', 'court'], ['pace', 'Spieltempo', 'bolt'],
      ['mode', 'Modus', 'eye'], ['quality', 'Grafik', 'sparkle'], ['sound', 'Ton', 'sound'], ['voice', 'Schiedsrichter-Stimme', 'voice'],
    ];
    this.optEls = {};
    const items = [{ el: start, activate: () => this._start(), sound: 'start' }];
    this.menu.append(start, sep);
    for (const [key, label, ico] of rows) {
      const el = optionItem(label, ico);
      el.dataset.key = key;
      this.optEls[key] = el;
      this.menu.appendChild(el);
      items.push({ el, adjust: (d) => this._cycle(key, d) });
    }
    const ctr = buttonItem('Steuerung', 'gamepad');
    ctr.insertAdjacentHTML('beforeend', `<span class="tg-item-go">${icon('chevR')}</span>`);
    this.menu.appendChild(ctr);
    items.push({ el: ctr, activate: () => this.ui.showControls() });
    this.screen = ui.nav.screen({ el: this.el, items, onBack: null, onStartButton: () => this._start() });
    this._render();
  }

  _cycle(key, d) {
    const opts = OPTIONS[key];
    const i = opts.findIndex(([v]) => v === this.settings[key]);
    this.settings[key] = opts[(i + d + opts.length) % opts.length][0];
    saveSettings(this.settings);
    this.ui.nav.sound('toggle');
    this._render(key, d);
    this.ui._applySettings?.(this.settings);
    this.handlers.onChange?.({ ...this.settings });
  }

  _render(changedKey, d = 1) {
    const s = this.settings;
    for (const key of Object.keys(this.optEls)) {
      const el = this.optEls[key];
      const v = el.querySelector('.tg-opt-v');
      let html = esc(optionLabel(key, s[key])).replace(/\s*\((.+)\)$/, ' <small>($1)</small>');
      if (key === 'player') html = `<span class="tg-chip tg-chip-${s.player}"></span>${html}`;
      v.innerHTML = html;
      if (key === changedKey) animate(v, [{ transform: `translateX(${d * 0.6}em)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.16,1,.3,1)' });
    }
    this.optEls.sound.querySelector('.tg-item-ico').innerHTML = icon(s.sound ? 'sound' : 'mute');
    const watch = s.mode === 'watch';
    this.optEls.player.classList.toggle('is-dim', watch);
    const opp = s.player === 'tom' ? 'Gerry' : 'Tom';
    this.startSub.textContent = watch
      ? `Tom gegen Gerry · ${optionLabel('format', s.format)}`
      : `Du als ${optionLabel('player', s.player)} gegen ${opp} (${optionLabel('difficulty', s.difficulty)}) · ${optionLabel('format', s.format)}`;
  }

  show(settings, handlers = {}) {
    if (settings && typeof settings === 'object') this.settings = sanitizeSettings({ ...loadSettings(), ...settings });
    this.handlers = handlers;
    this._render();
    this.ui._applySettings?.(this.settings);
    this.el.classList.remove('is-out');
    this.el.classList.add('is-on');
    this.ui.nav.push(this.screen, 0);
  }

  hide() {
    this.ui.nav.remove(this.screen);
    if (!this.el.classList.contains('is-on')) return;
    this.el.classList.add('is-out');
    clearTimeout(this._t);
    this._t = setTimeout(() => this.el.classList.remove('is-on', 'is-out'), 520);
  }

  _start() {
    const s = resolveSettings(this.settings);
    saveSettings(this.settings);
    this.handlers.onStart?.(s);
  }
}

// ------------------------------------------------------------------ Pause

export class PauseMenu {
  constructor(ui) {
    this.ui = ui;
    this.el = h('div', 'tg-pause');
    this.el.innerHTML = `<div class="tg-pause-panel tg-glass" role="dialog" aria-label="Pause">
      <div class="tg-pause-head"><span class="tg-pause-ico">${icon('pause')}</span><span>Pause</span></div>
      <div class="tg-pause-score"></div>
      <div class="tg-menu" role="menu"></div>
      <div class="tg-pause-foot"><kbd>Esc</kbd> Weiter</div></div>`;
    this.menu = this.el.querySelector('.tg-menu');
    this.scoreEl = this.el.querySelector('.tg-pause-score');
    this.h = {};
    this.settings = loadSettings();
    const resume = buttonItem('Weiter', 'play', 'tg-item-primary tg-item-compact');
    const restart = buttonItem('Neustart', 'restart');
    const controls = buttonItem('Steuerung', 'gamepad');
    const pace = optionItem('Spieltempo', 'bolt'); pace.dataset.key = 'pace';
    const quality = optionItem('Grafik', 'sparkle'); quality.dataset.key = 'quality';
    const sound = optionItem('Ton', 'sound'); sound.dataset.key = 'sound';
    const quit = buttonItem('Hauptmenü', 'home');
    this.optEls = { pace, quality, sound };
    this.restartEl = restart; this.quitEl = quit;
    this.menu.append(resume, restart, controls, pace, quality, sound, quit);
    this.screen = ui.nav.screen({
      el: this.el,
      items: [
        { el: resume, activate: () => this._resume(), sound: 'resume' },
        { el: restart, activate: () => this._confirm(restart, 'Neustart', () => this.h.onRestart?.()) },
        { el: controls, activate: () => this.ui.showControls() },
        { el: pace, adjust: (d) => this._cycle('pace', d) },
        { el: quality, adjust: (d) => this._cycle('quality', d) },
        { el: sound, adjust: (d) => this._cycle('sound', d) },
        { el: quit, activate: () => this._confirm(quit, 'Hauptmenü', () => this.h.onQuit?.()) },
      ],
      onBack: () => this._resume(),
      backSound: 'resume',
      onStartButton: () => this._resume(),
      keys: { KeyP: (e) => { if (!e.repeat) { this.ui.nav.sound('resume'); this._resume(); } } },
    });
  }

  _confirm(el, label, fn) {
    if (el.classList.contains('is-confirm')) {
      el.classList.remove('is-confirm');
      el.querySelector('.tg-item-l').textContent = label;
      fn();
      return;
    }
    el.classList.add('is-confirm');
    el.querySelector('.tg-item-l').textContent = `${label}? Nochmal bestätigen`;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.classList.remove('is-confirm'); el.querySelector('.tg-item-l').textContent = label; }, 3000);
  }

  _cycle(key, d) {
    const opts = OPTIONS[key];
    const i = opts.findIndex(([v]) => v === this.settings[key]);
    this.settings[key] = opts[(i + d + opts.length) % opts.length][0];
    saveSettings({ ...loadSettings(), [key]: this.settings[key] });
    this.ui.nav.sound('toggle');
    this._render(key, d);
    this.ui._applySettings?.(this.settings);
    this.h.onChange?.({ ...this.settings });
  }

  _render(changedKey, d = 1) {
    for (const key of Object.keys(this.optEls)) {
      const v = this.optEls[key].querySelector('.tg-opt-v');
      v.textContent = optionLabel(key, this.settings[key]);
      if (key === changedKey) animate(v, [{ transform: `translateX(${d * 0.6}em)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.16,1,.3,1)' });
    }
    this.optEls.sound.querySelector('.tg-item-ico').innerHTML = icon(this.settings.sound ? 'sound' : 'mute');
  }

  _resume() { this.h.onResume?.(); }

  show(handlers = {}) {
    this.h = handlers;
    this.settings = sanitizeSettings({ ...loadSettings(), ...(handlers.settings || {}) });
    for (const el of [this.restartEl, this.quitEl]) {
      el.classList.remove('is-confirm');
      el.querySelector('.tg-item-l').textContent = el === this.restartEl ? 'Neustart' : 'Hauptmenü';
    }
    this._render();
    this.scoreEl.innerHTML = this.ui._scoreSummaryHTML();
    const wasOn = this.el.classList.contains('is-on') && !this.el.classList.contains('is-out');
    this.el.classList.remove('is-out');
    this.el.classList.add('is-on');
    this.ui.nav.push(this.screen, 0);
    if (!wasOn) this.ui.nav.sound('pause');
  }

  hide() {
    this.ui.nav.remove(this.screen);
    if (!this.el.classList.contains('is-on')) return;
    this.el.classList.add('is-out');
    clearTimeout(this._t);
    this._t = setTimeout(() => this.el.classList.remove('is-on', 'is-out'), 320);
  }
}

// ------------------------------------------------------------------ Steuerung

const key = (k, cls = '') => `<kbd class="tg-key ${cls}">${k}</kbd>`;

export class ControlsOverlay {
  constructor(ui) {
    this.ui = ui;
    this.el = h('div', 'tg-controls');
    const act = (k, name, color) => `<div class="tg-act" style="--ac:${color}">${key(k)}<span>${name}</span></div>`;
    this.el.innerHTML = `<div class="tg-controls-panel tg-glass" role="dialog" aria-label="Steuerung">
      <header class="tg-controls-head">
        <div class="tg-controls-title">${icon('gamepad')}<span>Steuerung</span></div>
        <button class="tg-close" type="button" aria-label="Schließen">${icon('close')}</button>
      </header>
      <div class="tg-controls-grid">
        <section class="tg-cs tg-cs-kb">
          <h3>${icon('keyboard')} Tastatur</h3>
          <div class="tg-kb">
            <div class="tg-kb-group">
              <div class="tg-kb-cluster">
                <div class="tg-kb-row">${key('W')}</div>
                <div class="tg-kb-row">${key('A')}${key('S')}${key('D')}</div>
              </div>
              <span class="tg-kb-or">oder</span>
              <div class="tg-kb-cluster">
                <div class="tg-kb-row">${key('↑')}</div>
                <div class="tg-kb-row">${key('←')}${key('↓')}${key('→')}</div>
              </div>
              <div class="tg-kb-cap">Bewegen</div>
            </div>
            <div class="tg-kb-acts">
              ${act('J', 'Topspin', '#47D18C')}${act('K', 'Slice', '#E5544B')}${act('L', 'Lob', '#F2C94C')}${act('I', 'Stopp', '#5AA9F0')}
            </div>
            <div class="tg-kb-extra">
              <div class="tg-act" style="--ac:#47D18C">${key('Leertaste', 'tg-key-wide')}<span>Topspin</span></div>
              <div class="tg-act" style="--ac:#F6EFDF">${key('Esc')}${key('P')}<span>Pause</span></div>
            </div>
            <div class="tg-kb-group tg-kb-serve">
              <div class="tg-kb-step">${key('J')}<span>1× Ballwurf</span></div>
              <span class="tg-kb-arrow">${icon('chevR')}</span>
              <div class="tg-kb-step">${key('J')}<span>2× Schlag</span></div>
              <div class="tg-kb-cap">Aufschlag</div>
            </div>
          </div>
        </section>
        <section class="tg-cs tg-cs-pad">
          <h3>${icon('gamepad')} Gamepad</h3>
          ${gamepadSVG()}
        </section>
      </div>
      <div class="tg-tips">
        <div class="tg-tip">${icon('ball')}<div><b>Aufschlag</b><span>Taste drücken = Ballwurf, nochmal drücken = Schlag. Triff im goldenen Bereich des Timing-Balkens.</span></div></div>
        <div class="tg-tip">${icon('target')}<div><b>Zielen</b><span>Richtung beim Schlag halten: links/rechts für die Ecken, vor/zurück für Länge.</span></div></div>
        <div class="tg-tip">${icon('bolt')}<div><b>Kraft</b><span>Früh drücken = mehr Kraft. Der Ring am Spieler zeigt die Ladung.</span></div></div>
        <div class="tg-tip">${icon('user')}<div><b>Laufen</b><span>Du läufst selbst – Vorhand, Rückhand, Volley und Schmetterball wählt das Spiel automatisch.</span></div></div>
      </div>
      <footer class="tg-controls-foot"><span><kbd>Esc</kbd> / ${icon('gamepad')} <b>B</b> Zurück</span></footer>
    </div>`;
    const close = this.el.querySelector('.tg-close');
    this.screen = ui.nav.screen({ el: this.el, items: [{ el: close, activate: () => this.hide() }], onBack: () => this.hide() });
    this.el.addEventListener('click', (e) => { if (e.target === this.el) this.hide(); });
    this._resolve = null;
  }

  show() {
    this.el.classList.remove('is-out');
    this.el.classList.add('is-on');
    this.ui.nav.push(this.screen, 0);
    this.ui.nav.sound('select');
    return new Promise((r) => { this._resolve = r; });
  }

  hide() {
    this.ui.nav.remove(this.screen);
    if (!this.el.classList.contains('is-on')) return;
    this.el.classList.add('is-out');
    clearTimeout(this._t);
    this._t = setTimeout(() => this.el.classList.remove('is-on', 'is-out'), 300);
    const r = this._resolve; this._resolve = null; r?.();
  }
}

function gamepadSVG() {
  // Pad-Zeichnung (ohne Beschriftungslinien) + HTML-Legende darunter -> skaliert sauber und bleibt lesbar.
  const btn = (cx, cy, l, c) => `<g><circle cx="${cx}" cy="${cy}" r="9.5" fill="${c}" fill-opacity=".22" stroke="${c}" stroke-width="1.8"/><text x="${cx}" y="${cy + 3.7}" text-anchor="middle" font-size="10.5" font-weight="800" fill="${c}">${l}</text></g>`;
  const pad = `<svg class="tg-pad" viewBox="44 36 272 142" aria-hidden="true">
    <defs>
      <linearGradient id="tgPadG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#335A48"/><stop offset=".55" stop-color="#173A2A"/><stop offset="1" stop-color="#0B2218"/></linearGradient>
      <linearGradient id="tgPadS" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F6EFDF" stop-opacity=".22"/><stop offset="1" stop-color="#F6EFDF" stop-opacity="0"/></linearGradient>
    </defs>
    <path d="M96 52 q8 -12 26 -12 h14 q8 0 10 8 M264 52 q-8 -12 -26 -12 h-14 q-8 0 -10 8" fill="none" stroke="rgba(246,239,223,.3)" stroke-width="5" stroke-linecap="round"/>
    <path d="M118 52 H242 C270 52 286 66 292 92 L304 144 C308 164 290 176 274 166 L248 146 C242 141 236 139 228 139 H132 C124 139 118 141 112 146 L86 166 C70 176 52 164 56 144 L68 92 C74 66 90 52 118 52Z" fill="url(#tgPadG)" stroke="rgba(246,239,223,.3)" stroke-width="1.4"/>
    <path d="M120 55 H240 C262 55 276 64 283 80 C240 70 120 70 77 80 C84 64 98 55 120 55Z" fill="url(#tgPadS)"/>
    <circle cx="122" cy="92" r="16" fill="#071811" stroke="rgba(243,217,138,.75)" stroke-width="1.6"/><circle cx="122" cy="92" r="9.5" fill="#2A5242"/><circle cx="122" cy="92" r="4" fill="#F3D98A" fill-opacity=".85"/>
    <path d="M112 118 h6 v-6 h6 v6 h6 v6 h-6 v6 h-6 v-6 h-6z" fill="#21473A" stroke="rgba(243,217,138,.55)"/>
    <circle cx="214" cy="122" r="12" fill="#071811" stroke="rgba(246,239,223,.2)"/><circle cx="214" cy="122" r="7" fill="#1E3D31"/>
    <rect x="186" y="80" width="13" height="6.5" rx="3.2" fill="#F6EFDF" fill-opacity=".85"/>
    <rect x="161" y="80" width="13" height="6.5" rx="3.2" fill="#F6EFDF" fill-opacity=".25"/>
    ${btn(248, 106, 'A', '#47D18C')}${btn(269, 85, 'B', '#E5544B')}${btn(227, 85, 'X', '#5AA9F0')}${btn(248, 64, 'Y', '#F2C94C')}
  </svg>`;
  const chip = (l, c, wide = false) => `<span class="tg-pb${wide ? ' tg-pb-wide' : ''}" style="--ac:${c}">${l}</span>`;
  const row = (k, label) => `<div class="tg-pl">${k}<span>${label}</span></div>`;
  return `${pad}<div class="tg-pad-legend">
    ${row(chip('A', '#47D18C'), 'Topspin')}${row(chip('B', '#E5544B'), 'Slice')}
    ${row(chip('Y', '#F2C94C'), 'Lob')}${row(chip('X', '#5AA9F0'), 'Stopp')}
    ${row(chip('L', '#F3D98A'), 'Stick / Kreuz: Bewegen')}${row(chip('Start', '#F6EFDF', true), 'Pause')}
  </div>`;
}

// ------------------------------------------------------------------ Match-Ende

const num = (v) => (Number.isFinite(+v) ? +v : null);
const first = (o, ...keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; return undefined; };

/** Statistik-Zeilen: liefert pro Spieler { text, sub, value (für Balken 0..1 relativ), raw }. */
// Feldnamen entsprechen MatchStats (src/sim/rules.js); Alternativnamen werden ebenfalls akzeptiert.
const STAT_ROWS = [
  { label: 'Asse', count: (p) => first(p, 'aces', 'ace') },
  { label: 'Doppelfehler', count: (p) => first(p, 'doubleFaults', 'doubleFault', 'dfs'), lower: true },
  { label: 'Winner', count: (p) => { const w = num(first(p, 'winners', 'winner')); return w == null ? undefined : w + (num(p.serviceWinners) || 0); } },
  { label: 'Unforced Errors', count: (p) => first(p, 'unforcedErrors', 'unforced', 'ues'), lower: true },
  { label: '1. Aufschlag', pct: (p) => [first(p, 'firstServeIn', 'firstServesIn', 'firstIn'), first(p, 'firstServeTotal', 'firstServes', 'firstServeAttempts', 'serves')], direct: (p) => first(p, 'firstServePct') },
  { label: 'Punkte nach 1. Aufschlag', pct: (p) => [first(p, 'firstServeWon', 'firstServePointsWon', 'firstWon'), first(p, 'firstServePlayed', 'firstServePoints', 'firstServeIn', 'firstServesIn')] },
  { label: 'Punkte nach 2. Aufschlag', pct: (p) => [first(p, 'secondServeWon', 'secondServePointsWon', 'secondWon'), first(p, 'secondServePlayed', 'secondServePoints', 'secondServeTotal', 'secondServes')] },
  { label: 'Breakbälle genutzt', frac: (p) => [first(p, 'breakPointsWon', 'breaksWon', 'bpWon'), first(p, 'breakPointsTotal', 'breakPoints', 'bpTotal')] },
  { label: 'Schnellster Aufschlag', count: (p) => { const v = num(first(p, 'fastestServe', 'fastestServeKmh', 'maxServeSpeed')); return v > 0 ? v : undefined; }, unit: 'km/h', round: true },
  { label: 'Längster Ballwechsel', match: 'longestRally', unit: 'Schläge' },
  { label: 'Gesamtpunkte', count: (p) => first(p, 'pointsWon', 'totalPoints', 'points') },
];

function statCells(row, a, b, stats) {
  const out = [{}, {}];
  if (row.match) {
    const v = longestRallyOf(stats);
    const pa = num(first(a, row.match)), pb = num(first(b, row.match));
    if (pa != null || pb != null) {
      out[0] = { text: pa ?? '–', v: pa ?? 0 }; out[1] = { text: pb ?? '–', v: pb ?? 0 };
      const mx = Math.max(pa || 0, pb || 0) || 1; out[0].bar = (pa || 0) / mx; out[1].bar = (pb || 0) / mx;
      return out;
    }
    return { single: v != null ? `${v} ${row.unit}` : '–' };
  }
  [a, b].forEach((p, i) => {
    if (row.count) {
      const v = num(row.count(p));
      out[i] = { text: v == null ? '–' : row.round ? Math.round(v) : v, v: v ?? 0, has: v != null };
      if (row.unit && v != null) out[i].unit = row.unit;
    } else if (row.pct) {
      const d = row.direct ? num(row.direct(p)) : null;
      const [x, n] = row.pct(p).map(num);
      if (d != null) out[i] = { text: `${Math.round(d)}%`, v: d / 100, has: true };
      else if (x != null && n) out[i] = { text: `${Math.round((100 * x) / n)}%`, sub: `${x}/${n}`, v: x / n, has: true };
      else out[i] = { text: '–', v: 0 };
      out[i].pctRow = true;
    } else if (row.frac) {
      const [x, n] = row.frac(p).map(num);
      if (x != null && n != null) out[i] = { text: `${x}/${n}`, sub: n ? `${Math.round((100 * x) / n)}%` : '', v: n ? x / n : 0, has: true, raw: x };
      else out[i] = { text: '–', v: 0 };
    }
  });
  if (row.pct) { out[0].bar = out[0].v; out[1].bar = out[1].v; }
  else {
    const va = row.frac ? out[0].raw ?? 0 : out[0].v, vb = row.frac ? out[1].raw ?? 0 : out[1].v;
    const mx = Math.max(va, vb) || 1;
    out[0].bar = va / mx; out[1].bar = vb / mx;
  }
  const A = row.frac ? out[0].raw : out[0].v, B = row.frac ? out[1].raw : out[1].v;
  if (out[0].has && out[1].has && A !== B) {
    const better = row.lower ? (A < B ? 0 : 1) : (A > B ? 0 : 1);
    out[better].best = true;
  }
  return out;
}

const isStatObj = (o) => !!o && typeof o === 'object' && ('aces' in o || 'pointsWon' in o || 'winners' in o);

/** Statistik-Objekt in Spieler-Arrays zerlegen (mehrere Formen werden akzeptiert, auch MatchStats direkt). */
function splitStats(stats, depth = 0) {
  if (!stats || typeof stats !== 'object') return [{}, {}];
  const cand = first(stats, 'p', 'perPlayer', 'playerStats');
  if (Array.isArray(cand)) return cand;
  if (Array.isArray(stats.players) && isStatObj(stats.players[0])) return stats.players;
  if (stats.tom || stats.gerry) return [stats.tom || {}, stats.gerry || {}];
  if (depth < 2 && stats.stats && typeof stats.stats === 'object') {
    if (Array.isArray(stats.stats)) return stats.stats;
    return splitStats(stats.stats, depth + 1);
  }
  return [{}, {}];
}

/** Längster Ballwechsel aus verschiedenen Formen (auch verschachteltes MatchStats). */
const longestRallyOf = (stats) => num(first(stats, 'longestRally', 'longestRallyShots')) ?? num(stats?.stats?.longestRally);

export class MatchEndScreen {
  constructor(ui) {
    this.ui = ui;
    this.el = h('div', 'tg-end');
    this.screen = null;
  }

  show(stats = {}, handlers = {}) {
    const ui = this.ui;
    const players = ui.hud.players.map((p, i) => ({ ...p, ...(stats.players?.[i]?.name ? { name: stats.players[i].name } : {}), ...(stats.players?.[i]?.color ? { color: stats.players[i].color } : {}) }));
    let winner = stats.winner ?? stats.score?.winner ?? stats.view?.winner;
    if (typeof winner === 'string') {
      const w = winner.toLowerCase();
      winner = players.findIndex((p) => String(p.name).toLowerCase() === w || String(p.id).toLowerCase() === w);
    }
    const [A, B] = splitStats(stats);
    const sets = normSets(stats.sets || stats.setScores || stats.score?.sets || stats.view?.sets || ui._lastScore?.sets || []);
    if (winner !== 0 && winner !== 1 && sets.length) {
      // ohne Angabe: Sieger aus den Sätzen ableiten
      let a = 0; for (const st of sets) a += st[0] > st[1] ? 1 : -1;
      winner = a >= 0 ? 0 : 1;
    }
    winner = winner === 1 ? 1 : 0;
    const W = players[winner];
    const setsHTML = sets.map((s) => {
      const w = s[winner], l = s[1 - winner];
      const tb = Number.isFinite(s[2]) ? `<sup>${s[2]}</sup>` : '';
      return `<span class="tg-end-set${w > l ? ' is-won' : ''}"><b>${w}</b><i>:</i><b>${l}</b>${tb}</span>`;
    }).join('');
    const meta = [];
    if (Number.isFinite(stats.duration)) meta.push(`Spielzeit ${fmtDuration(stats.duration)}`);
    meta.push('Centre Court · Finale');

    const rowsHTML = STAT_ROWS.map((row, ri) => {
      const c = statCells(row, A, B, stats);
      if (c.single !== undefined) {
        return `<div class="tg-stat tg-stat-single" style="--i:${ri}"><div class="tg-stat-l">${row.label}</div><div class="tg-stat-one">${esc(c.single)}</div></div>`;
      }
      const cell = (x, side) => `<div class="tg-stat-v tg-stat-${side}${x.best ? ' is-best' : ''}"><b>${esc(x.text)}${x.unit ? `<small> ${x.unit}</small>` : ''}</b>${x.sub ? `<small class="tg-stat-sub">${esc(x.sub)}</small>` : ''}</div>`;
      return `<div class="tg-stat" style="--i:${ri}">
        ${cell(c[0], 'a')}
        <div class="tg-stat-mid"><div class="tg-stat-l">${row.label}</div>
          <div class="tg-stat-bars"><i class="tg-bar tg-bar-a${c[0].best ? ' is-best' : ''}" style="--w:${(c[0].bar || 0).toFixed(3)}"></i><i class="tg-bar tg-bar-b${c[1].best ? ' is-best' : ''}" style="--w:${(c[1].bar || 0).toFixed(3)}"></i></div></div>
        ${cell(c[1], 'b')}</div>`;
    }).join('');

    const confetti = Array.from({ length: 46 }, (_, i) => {
      const a = (i / 46) * Math.PI * 2 + (i % 3) * 0.3, r = 9 + (i * 37) % 14;
      const cols = ['#F3D98A', '#D9B45A', '#F6EFDF', W.color, '#D7EE4B'];
      return `<i style="--dx:${(Math.cos(a) * r).toFixed(2)}em;--dy:${(Math.sin(a) * r * 0.8 - 4).toFixed(2)}em;--r:${(i * 97) % 720}deg;--d:${(i % 7) * 40}ms;--c:${cols[i % cols.length]}"></i>`;
    }).join('');

    this.el.innerHTML = `
      <div class="tg-end-scrim"></div>
      <div class="tg-end-wrap">
        <div class="tg-end-hero" style="--wc:${W.color}">
          <div class="tg-end-rays"></div>
          <div class="tg-end-confetti">${confetti}</div>
          <div class="tg-end-trophy">${trophySVG()}<i class="tg-end-glint"></i></div>
          <div class="tg-end-kicker"><span>Matchgewinn</span></div>
          <div class="tg-end-name"><span class="tg-end-portrait">${portraitSVG(W.id || (winner ? 'gerry' : 'tom'))}</span><span class="tg-end-name-t">${esc(String(W.name).toUpperCase())}</span></div>
          <div class="tg-end-sets">${setsHTML}</div>
          <div class="tg-end-meta">${esc(meta.join(' · '))}</div>
        </div>
        <div class="tg-end-side">
          <div class="tg-end-stats tg-glass">
            <div class="tg-stat-head">
              <div class="tg-sh tg-sh-a" style="--pc:${players[0].color}">${portraitSVG(players[0].id || 'tom', 'tg-sh-p')}<span>${esc(String(players[0].name).toUpperCase())}</span></div>
              <div class="tg-sh-mid">Statistik</div>
              <div class="tg-sh tg-sh-b" style="--pc:${players[1].color}"><span>${esc(String(players[1].name).toUpperCase())}</span>${portraitSVG(players[1].id || 'gerry', 'tg-sh-p')}</div>
            </div>
            <div class="tg-stat-list" style="--ca:${players[0].color};--cb:${players[1].color}">${rowsHTML}</div>
          </div>
          <div class="tg-end-actions" role="menu"></div>
        </div>
      </div>`;
    const actions = this.el.querySelector('.tg-end-actions');
    const rematch = buttonItem('Revanche', 'restart', 'tg-item-primary tg-item-compact');
    const menu = buttonItem('Hauptmenü', 'home', 'tg-item-compact');
    actions.append(rematch, menu);
    if (this.screen) ui.nav.remove(this.screen);
    this.screen = ui.nav.screen({
      el: this.el, horizontal: true,
      items: [
        { el: rematch, activate: () => handlers.onRematch?.(), sound: 'start' },
        { el: menu, activate: () => handlers.onMenu?.() },
      ],
      onBack: null,
    });
    this.el.classList.remove('is-out');
    this.el.classList.add('is-on');
    ui.nav.push(this.screen, 0);
    ui.nav.sound('score');
  }

  hide() {
    if (this.screen) this.ui.nav.remove(this.screen);
    if (!this.el.classList.contains('is-on')) return;
    this.el.classList.add('is-out');
    clearTimeout(this._t);
    this._t = setTimeout(() => { this.el.classList.remove('is-on', 'is-out'); this.el.innerHTML = ''; }, 450);
  }
}

// Eingabe: Tastatur + Gamepad-API -> kamerarelative Absicht (Bildschirm: rechts/oben) -> PlayerInput in Weltkoordinaten.
//
// Einzelspieler (mode 'single'):
//   Bewegen  WASD oder Pfeiltasten        Topspin  J oder Leertaste     Slice  K
//   Lob      L                              Stopp    I                   Pause  Esc / P
//   Weiter (Pausen überspringen)  Enter oder eine Schlagtaste
//   Gamepad: linker Stick / Steuerkreuz, A = Topspin, B = Slice, Y = Lob, X = Stopp, Start = Pause
// Versus (mode 'versus', zwei Menschen an einer Tastatur, gemeinsame Kamera hinter Slot 0):
//   Slot 0: WASD bewegen, F Topspin, G Slice, R Lob, T Stopp, Esc Pause, Tab weiter
//   Slot 1: Pfeiltasten bewegen, J/Num1 Topspin, K/Num2 Slice, L/Num3 Lob, I/Num4 Stopp, Enter weiter
//   Gamepad 1 -> Slot 0, Gamepad 2 -> Slot 1.  Steuerung bildschirmrelativ (oben = vom Betrachter weg).
//
// Weltabbildung (ARCHITECTURE §3/§7): Kamera hinter Seite s: Bildschirm-oben = Welt -s·Z, rechts = Welt +s·X.
// aim: lr = Bildschirm-rechts aus Sicht des Schlagenden, depth = Bildschirm-oben (tiefer) – für den Spieler
// auf der Kameraseite identisch, für den Gegenüber gespiegelt.

const SHOTS = ['topspin', 'slice', 'lob', 'drop'];

const KEYS_SINGLE = {
  up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  topspin: ['KeyJ', 'Space'], slice: ['KeyK'], lob: ['KeyL'], drop: ['KeyI'],
  skip: ['Enter', 'NumpadEnter'], pause: ['Escape', 'KeyP'],
};
const KEYS_VS = [
  {
    up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
    topspin: ['KeyF'], slice: ['KeyG'], lob: ['KeyR'], drop: ['KeyT'], skip: ['Tab'], pause: ['Escape'],
  },
  {
    up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
    topspin: ['KeyJ', 'Numpad1'], slice: ['KeyK', 'Numpad2'], lob: ['KeyL', 'Numpad3'], drop: ['KeyI', 'Numpad4'],
    skip: ['Enter', 'NumpadEnter'], pause: ['KeyP'],
  },
];
// Standard-Gamepad-Layout
const PAD = { a: 0, b: 1, x: 2, y: 3, back: 8, start: 9, up: 12, down: 13, left: 14, right: 15 };
const PAD_SHOT = { topspin: PAD.a, slice: PAD.b, lob: PAD.y, drop: PAD.x };
const DEAD = 0.2;

const BLOCK_DEFAULT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

/** Leere Absicht (Bildschirmraum). */
function makeIntent() {
  return { x: 0, y: 0, buttons: { topspin: false, slice: false, lob: false, drop: false }, skip: false, pause: false };
}

export class InputManager {
  /** target: EventTarget für Tastatur (window). opts = { mode: 'single'|'versus' } */
  constructor(target = (typeof window !== 'undefined' ? window : null), opts = {}) {
    this.target = target;
    this.mode = opts.mode || 'single';
    this.enabled = true;
    this.keys = new Set();
    this.intents = [makeIntent(), makeIntent()];
    this._pausePrev = false;
    this._pauseEdge = false;
    this.lastDevice = 'keyboard';
    this.gamepadConnected = false;
    this._out = [makeOut(), makeOut()];
    this._onDown = (e) => {
      if (!this.enabled) return;
      if (e.repeat && this.keys.has(e.code)) { if (BLOCK_DEFAULT.has(e.code)) e.preventDefault(); return; }
      this.keys.add(e.code);
      this.lastDevice = 'keyboard';
      if (BLOCK_DEFAULT.has(e.code)) e.preventDefault();
    };
    this._onUp = (e) => { this.keys.delete(e.code); };
    this._onBlur = () => { this.keys.clear(); };
    if (target) this.attach();
  }

  attach() {
    const t = this.target;
    if (!t || this._attached) return;
    t.addEventListener('keydown', this._onDown);
    t.addEventListener('keyup', this._onUp);
    t.addEventListener('blur', this._onBlur);
    this._attached = true;
  }

  detach() {
    const t = this.target;
    if (!t || !this._attached) return;
    t.removeEventListener('keydown', this._onDown);
    t.removeEventListener('keyup', this._onUp);
    t.removeEventListener('blur', this._onBlur);
    this._attached = false;
    this.keys.clear();
  }

  /** Eingabe sperren (z. B. solange ein Menü offen ist); gehaltene Tasten werden vergessen. */
  setEnabled(on) { this.enabled = !!on; if (!on) this.keys.clear(); }
  setMode(mode) { this.mode = mode === 'versus' ? 'versus' : 'single'; }

  /** Einmal pro Bild aufrufen: liest Tastatur- und Gamepad-Zustand in die Absichten (Bildschirmraum). */
  poll() {
    const I0 = this.intents[0], I1 = this.intents[1];
    reset(I0); reset(I1);
    if (this.enabled) {
      if (this.mode === 'versus') { this._keys(I0, KEYS_VS[0]); this._keys(I1, KEYS_VS[1]); }
      else this._keys(I0, KEYS_SINGLE);
      this._pads();
    }
    for (const I of this.intents) {
      const l = Math.hypot(I.x, I.y);
      if (l > 1) { I.x /= l; I.y /= l; }
    }
    const p = I0.pause || I1.pause;
    this._pauseEdge = this._pauseEdge || (p && !this._pausePrev);
    this._pausePrev = p;
  }

  _keys(I, map) {
    const k = this.keys;
    const any = (list) => { for (const c of list) if (k.has(c)) return true; return false; };
    if (any(map.right)) I.x += 1;
    if (any(map.left)) I.x -= 1;
    if (any(map.up)) I.y += 1;
    if (any(map.down)) I.y -= 1;
    for (const s of SHOTS) if (any(map[s])) I.buttons[s] = true;
    if (any(map.skip)) I.skip = true;
    if (any(map.pause)) I.pause = true;
  }

  _pads() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
    let pads;
    try { pads = navigator.getGamepads(); } catch { return; }
    let slot = 0;
    this.gamepadConnected = false;
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      this.gamepadConnected = true;
      const I = this.intents[this.mode === 'versus' ? Math.min(slot, 1) : 0];
      slot++;
      const b = (i) => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5));
      let ax = gp.axes[0] || 0, ay = -(gp.axes[1] || 0);
      const m = Math.hypot(ax, ay);
      if (m < DEAD) { ax = 0; ay = 0; } else { const k = Math.min(1, (m - DEAD) / (1 - DEAD)) / m; ax *= k; ay *= k; }
      if (b(PAD.right)) ax = 1; if (b(PAD.left)) ax = -1;
      if (b(PAD.up)) ay = 1; if (b(PAD.down)) ay = -1;
      let used = Math.abs(ax) > 0 || Math.abs(ay) > 0;
      I.x += ax; I.y += ay;
      for (const s of SHOTS) if (b(PAD_SHOT[s])) { I.buttons[s] = true; used = true; }
      if (b(PAD.back)) { I.skip = true; used = true; }
      if (b(PAD.start)) { I.pause = true; used = true; }
      if (used) this.lastDevice = 'gamepad';
    }
  }

  /** Pause-Taste seit dem letzten Aufruf gedrückt? (Flanke, wird zurückgesetzt) */
  consumePause() { const p = this._pauseEdge; this._pauseEdge = false; return p; }

  /** Irgendeine Taste/Knopf gedrückt (z. B. "Weiter" in Menüs)? */
  anyHeld() {
    for (const I of this.intents) if (I.skip || I.buttons.topspin || I.buttons.slice || I.buttons.lob || I.buttons.drop) return true;
    return false;
  }

  /**
   * PlayerInput (ARCHITECTURE §7) für einen Slot in Weltkoordinaten.
   * side = Spielfeldseite des Spielers, camSide = Seite, hinter der die Kamera steht (Standard: side).
   */
  getPlayerInput(slot, side, camSide = side, out = null) {
    const I = this.intents[slot] || this.intents[0];
    return intentToPlayerInput(I, side, camSide, out || this._out[slot] || makeOut());
  }
}

/** Bildschirm-Absicht -> PlayerInput (rein, testbar). */
export function intentToPlayerInput(I, side, camSide, out) {
  const cs = camSide || side;
  out.move[0] = cs * I.x;          // rechts = +cs·X
  out.move[1] = -cs * I.y;         // oben = -cs·Z
  const k = side === cs ? 1 : -1;  // Gegenüber: aus seiner Sicht gespiegelt
  out.aim[0] = k * I.x;
  out.aim[1] = k * I.y;
  out.buttons.topspin = I.buttons.topspin; out.buttons.slice = I.buttons.slice;
  out.buttons.lob = I.buttons.lob; out.buttons.drop = I.buttons.drop;
  out.skip = I.skip;
  return out;
}

function makeOut() { return { move: [0, 0], aim: [0, 0], buttons: { topspin: false, slice: false, lob: false, drop: false }, skip: false }; }
function reset(I) {
  I.x = 0; I.y = 0; I.skip = false; I.pause = false;
  I.buttons.topspin = I.buttons.slice = I.buttons.lob = I.buttons.drop = false;
}

/** Steuerungsübersicht (deutsch) für UI/Hilfe. */
export const CONTROLS_DE = {
  single: [
    ['Bewegen', 'WASD / Pfeiltasten', 'Linker Stick / Steuerkreuz'],
    ['Topspin', 'J / Leertaste', 'A'], ['Slice', 'K', 'B'], ['Lob', 'L', 'Y'], ['Stopp', 'I', 'X'],
    ['Laden', 'Schlagtaste früh drücken: Balken füllt sich (Kraft), Laufen langsamer', 'A/B/X/Y früh drücken'],
    ['Zielen', 'Richtung halten: vor = hart/tief, zurück = sicher, seitlich = Winkel', 'Stick'],
    ['Aufschlag', 'Taste = Ballwurf, nochmal = Schlag (Anzeige voll)', 'A, nochmal A'],
    ['Pause', 'Esc / P', 'Start'], ['Weiter', 'Enter / Schlagtaste', 'A'],
  ],
  versus: [
    ['Spieler 1', 'WASD, F Topspin, G Slice, R Lob, T Stopp', 'Gamepad 1'],
    ['Spieler 2', 'Pfeile, J Topspin, K Slice, L Lob, I Stopp', 'Gamepad 2'],
  ],
};

// AudioSystem – zentrale Fassade (ARCHITECTURE §10). Vollständig prozedural (WebAudio + speechSynthesis).
//
//   const audio = new AudioSystem();           // AudioContext wird erst bei unlock() erzeugt
//   audio.unlock();                            // bei erster Nutzergeste (passiert auch automatisch)
//   audio.handle(event, ctx);                  // GameEvents aus Match.drainEvents() direkt
//   audio.update(dt, { listenerPos, listenerDir, excitement, phase });
//   audio.crowd.react('applause', 0.8); audio.umpire.say('Deuce'); audio.ui('select');
//   audio.setVolume('master'|'sfx'|'crowd'|'voice'|'music', v); audio.mute(true); audio.setPaused(true);
//   audio.setMode('title'|'match'|'menu');
import { AudioGraph } from './graph.js';
import { Sfx } from './sfx.js';
import { Crowd } from './crowd.js';
import { Umpire } from './umpire.js';
import { Music } from './music.js';
import { Creatures } from './creatures.js';
import { hasWebAudio, chance, rnd, pick, clamp01, VoiceLimiter } from './dsp.js';
import { STROKES } from '../sim/strokes.js';

const REASON_BASE = { ace: 0.62, service_winner: 0.5, winner: 0.68, forced_error: 0.5, unforced_error: 0.3, double_fault: 0.2, net: 0.32, out: 0.32, double_bounce: 0.55 };
const UNLOCK_EVENTS = ['pointerdown', 'mousedown', 'keydown', 'touchend'];
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const micro = typeof queueMicrotask === 'function' ? queueMicrotask : (f) => Promise.resolve().then(f);

/** Ballgeschwindigkeit eines Ereignisses in m/s (akzeptiert speed m/s oder km/h, vel-Vektor). */
function speedOf(ev, dflt = 15) {
  let v = ev.speedIn ?? ev.speed;
  if (v == null && ev.velIn) v = Math.hypot(ev.velIn[0], ev.velIn[1], ev.velIn[2]);
  if (v == null && ev.vel) v = Math.hypot(ev.vel[0], ev.vel[1], ev.vel[2]);
  if (v == null && ev.kmh != null) v = ev.kmh / 3.6;
  if (v == null) return dflt;
  return v > 90 ? v / 3.6 : v;
}
/** Schlagart (Ereignisse können `stroke`, `strokeType` oder – mit `event` als Diskriminator – `type` tragen). */
function strokeOf(ev) {
  return ev.stroke || ev.strokeType || (ev.event ? ev.type : null) || 'forehand';
}
/** Abstand eines Aufsprungpunkts zur nächsten relevanten Linie (m). */
export function lineDistance(pos, serve = false) {
  const x = Math.abs(pos[0]), z = Math.abs(pos[2]);
  let d = Math.abs(x - 4.115);
  d = Math.min(d, Math.abs(z - (serve ? 6.4 : 11.885)));
  if (serve) d = Math.min(d, x);
  return d;
}

export class AudioSystem {
  /**
   * @param {object} [opts] { autoUnlock=true, titleMusic=true, allowRemoteVoices=false, synthLineCalls=false, onBakeProgress }
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.ctx = null; this.G = null; this.sfx = null; this.creatures = null;
    this.crowd = new Crowd();
    this.umpire = new Umpire(opts);
    this.music = new Music();
    this.volumes = { master: 0.9, sfx: 1, crowd: 0.85, voice: 1, music: 0.6 };
    this.muted = false; this.paused = false; this.mode = 'match';
    this.ready = false; this.baked = false; this.bakePromise = null;
    this.excitement = 0.25;
    this.lim = new VoiceLimiter({ hit: 6, bounce: 6, footstep: 8, net: 3, whoosh: 4, misc: 8, squeak: 1 });
    this.s = {
      rally: 0, faults: 0, pressure: null, excite: 0.22, boost: 0, lastLine: -1e9, lastThanks: -1e9, phase: null,
      ids: ['tom', 'gerry'], names: ['Tom', 'Gerry'], human: 0, positions: [null, null],
    };
    this._ctx = null; this._batch = null; this._lastCreature = -1e9; this._faultTimer = 0; this._wasRunning = false;
    this.umpire.onStart = () => this.crowd.duck(true);
    this.umpire.onEnd = () => this.crowd.duck(false);
    if (opts.autoUnlock !== false && typeof window !== 'undefined' && window.addEventListener) {
      const h = () => { this.unlock().then((ok) => { if (ok) this._removeUnlock?.(); }); };
      this._removeUnlock = () => { for (const e of UNLOCK_EVENTS) window.removeEventListener(e, h, true); this._removeUnlock = null; };
      for (const e of UNLOCK_EVENTS) window.addEventListener(e, h, true);
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
      this._onVis = () => this._visibility();
      document.addEventListener('visibilitychange', this._onVis);
    }
  }

  // ------------------------------------------------------------ Lebenszyklus
  /** Erzeugt/aktiviert den AudioContext (bei Nutzergeste aufrufen). Promise<boolean running>. */
  unlock() {
    if (!hasWebAudio()) return Promise.resolve(false);
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      try { this.ctx = new AC({ latencyHint: 'interactive' }); } catch { try { this.ctx = new AC(); } catch { return Promise.resolve(false); } }
      this._build();
    }
    this.umpire.prime();
    if (this.ctx.state === 'running') { this.ready = true; return Promise.resolve(true); }
    return this.ctx.resume().then(() => (this.ready = this.ctx.state === 'running')).catch(() => false);
  }
  _build() {
    const G = this.G = new AudioGraph(this.ctx);
    this.sfx = new Sfx(G); this.creatures = new Creatures(G);
    this.crowd.attach(G); this.umpire.attach(G); this.music.attach(G);
    this.crowd.setMode(this.mode === 'title' ? 'title' : 'match');
    this.music.title(this.mode === 'title' && this.opts.titleMusic !== false);
    this._applyVolumes(true);
    this.bakePromise = this.crowd.bake(this.opts.onBakeProgress).then(() => { this.baked = true; });
  }
  /** Alles freigeben. */
  dispose() {
    this._removeUnlock?.();
    if (this._onVis) document.removeEventListener('visibilitychange', this._onVis);
    this.umpire.cancel();
    if (this.ctx) { try { this.ctx.close(); } catch { /* egal */ } }
    this.ctx = null; this.G = null; this.ready = false;
  }

  // ------------------------------------------------------------ Mischung
  setVolume(name, v) {
    if (!(name in this.volumes)) return this;
    this.volumes[name] = clamp01(+v || 0);
    this._applyVolumes(false);
    return this;
  }
  getVolume(name) { return this.volumes[name]; }
  mute(on = true) { this.muted = !!on; this.umpire.setMuted(this.muted); this._applyVolumes(false); return this; }
  /** Pause: dumpfer Tiefpass über Spielgeräusche & Publikum, Durchsagen abbrechen. UI bleibt klar. */
  setPaused(on) {
    this.paused = !!on;
    if (on) this.umpire.cancel();
    if (!this.G) return this;
    const t = this.ctx.currentTime;
    this.G.pauseLP.frequency.setTargetAtTime(on ? 650 : 20000, t, on ? 0.08 : 0.25);
    this.G.masterIn.gain.setTargetAtTime(on ? 0.6 : 1, t, 0.15);
    return this;
  }
  pause(on = true) { return this.setPaused(on); }
  /** 'title' (Wind, Vögel, Stadt, Ambient-Pad) | 'match' | 'menu' | 'replay' */
  setMode(mode) {
    this.mode = mode;
    this.crowd.setMode(mode === 'title' ? 'title' : 'match');
    this.music.title(mode === 'title' && this.opts.titleMusic !== false);
    if (mode === 'title' || mode === 'menu') this.umpire.cancel();
    return this;
  }
  _applyVolumes(immediate) {
    this.umpire.volume = this.volumes.voice * this.volumes.master;
    this.crowd.active = !this.muted && this.volumes.crowd > 0.001 && this.volumes.master > 0.001;
    const G = this.G; if (!G) return;
    const t = this.ctx.currentTime, tau = immediate ? 0.002 : 0.05;
    G.out.gain.setTargetAtTime(this.muted ? 0 : this.volumes.master, t, tau);
    for (const b of ['sfx', 'crowd', 'voice', 'music']) G.setBusGain(b, this.volumes[b], tau);
    G.setBusGain('ui', 0.9 * this.volumes.sfx, tau);
  }

  // ------------------------------------------------------------ pro Frame
  /** st = { listenerPos, listenerDir, excitement (0..1), phase (Match-Phase, optional) } */
  update(dt, st = {}) {
    if (st.phase !== undefined && st.phase !== this.s.phase) this._onPhase(st.phase);
    if (!this.G) return;
    if (st.listenerPos || st.listenerDir) this.G.setListener(st.listenerPos, st.listenerDir);
    this.s.boost = Math.max(0, this.s.boost - dt * 0.025);
    const ext = st.excitement != null ? clamp01(st.excitement) : 0;
    this.excitement = clamp01(Math.max(ext, this.s.excite) + this.s.boost);
    this.crowd.update(dt, { excitement: this.excitement });
    this.music.update(dt);
  }
  _onPhase(phase) {
    this.s.phase = phase;
    this.crowd.setPhase(phase);
    if (phase === 'pre_serve' || phase === 'serve') this.s.rally = 0;
    if (phase === 'serve' && this.G && this.mode === 'match' && !this.muted) {
      const t = now();
      if (this.crowd.murmur > 0.3 && t - this.s.lastThanks > 90000 && chance(0.6)) {
        this.s.lastThanks = t;
        this.umpire.say(chance(0.6) ? 'Thank you.' : 'Quiet, please.', { delay: 0.15 });
      }
    }
  }

  // ------------------------------------------------------------ Spielereignisse
  /**
   * GameEvent (ARCHITECTURE §7) verarbeiten. ctx (optional): Match-State oder
   * { players:[{id,name,pos}], humans:[i] | human, call (Ansagetext | Funktion), score (mit call()), listenerPos, listenerDir }
   */
  handle(ev, ctx) {
    if (!ev) return;
    const type = ev.event || ev.type;
    if (!type) return;
    if (ctx) this._readCtx(ctx);
    const on = !!this.G && !this.muted;
    const t = on ? this.ctx.currentTime + 0.004 : 0;
    const sfx = this.sfx;
    switch (type) {
      case 'stroke_start': if (on) this._strokeStart(ev, t); break;
      case 'hit': this._hit(ev, t, on); break;
      case 'serve_toss':
        this.s.rally = 0;
        if (on) sfx.toss(t, null, ev.pos || this._pos(ev.player));
        this.crowd.hushNow();
        break;
      case 'bounce':
        if (on && this.lim.acquire('bounce', t, 0.1)) sfx.bounce(t, { speed: speedOf(ev), surface: ev.surface, soft: !!ev.soft }, ev.pos);
        break;
      case 'serve_bounce': case 'ball_tap':
        if (on) sfx.bounce(t, { speed: speedOf(ev, 4.5), soft: true }, ev.pos || this._pos(ev.player));
        break;
      case 'net':
        if (on && this.lim.acquire('net', t, 0.4)) {
          sfx.net(t, { cord: !!ev.cord, speed: speedOf(ev, 20) }, ev.pos);
          if (ev.cord && this.s.rally >= 1) this.crowd.react('ooh', 0.45, { delay: 0.12 });
        }
        break;
      case 'let':
        this.umpire.say(this.s.faults > 0 ? 'Let. Second serve.' : 'Let. First serve.', { delay: 0.35 });
        if (on) this.crowd.react('murmur', 0.25);
        break;
      case 'fault':
        this.s.faults = ev.n ?? this.s.faults + 1;
        if ((ev.n ?? 1) < 2) this._faultCheck();
        break;
      case 'double_fault': this.s.faults = 0; this._batchAdd('double_fault', ev); break;
      case 'line_call': this._lineCall(ev, on); break;
      case 'point': case 'game': case 'set': case 'match': this._batchAdd(type, ev); break;
      case 'change_ends':
        if (on) { this.crowd.react('applause', 0.28, { delay: 0.3 }); this.crowd.react('murmur', 0.5); }
        break;
      case 'serve_speed':
        if (on && (ev.kmh ?? 0) > 198) this.crowd.react('ooh', 0.2 + clamp01((ev.kmh - 198) / 25) * 0.35, { delay: 0.2 });
        break;
      case 'pressure': {
        const k = ev.kind || 'break_point';
        this.s.pressure = k;
        this.s.boost = Math.min(0.55, this.s.boost + (k === 'match_point' ? 0.35 : k === 'set_point' ? 0.25 : 0.16));
        if (on) this.crowd.react('tension', k === 'match_point' ? 1 : k === 'set_point' ? 0.8 : 0.55, { delay: 0.8 });
        break;
      }
      case 'footstep':
        if (on && this.lim.acquire('footstep', t, 0.09)) sfx.footstep(t, { intensity: ev.intensity ?? clamp01((ev.speed ?? 3) / 7), surface: ev.surface }, ev.pos || this._pos(ev.player));
        break;
      case 'split_step':
        if (on && this.lim.acquire('footstep', t, 0.1)) sfx.splitStep(t, ev, ev.pos || this._pos(ev.player));
        break;
      case 'shuffle':
        if (on && this.lim.acquire('footstep', t, 0.3)) sfx.shuffle(t, ev, ev.pos || this._pos(ev.player));
        break;
      case 'skid': case 'squeak':
        if (on && this.lim.acquire('squeak', t, 0.4) && chance(ev.chance ?? 0.6)) sfx.squeak(t, ev, ev.pos || this._pos(ev.player));
        break;
      case 'wall': if (on && this.lim.acquire('misc', t, 0.3)) sfx.wall(t, { speed: speedOf(ev) }, ev.pos); break;
      case 'post': if (on && this.lim.acquire('misc', t, 0.3)) sfx.post(t, { speed: speedOf(ev) }, ev.pos); break;
      case 'roll': if (on && this.lim.acquire('misc', t, 1)) sfx.roll(t, { speed: speedOf(ev, 3), dur: ev.dur }, ev.pos); break;
      case 'emote': if (on) this._emote(ev); break;
      case 'match_start':
        if (on) { this.music.sting('match_start'); this.crowd.react('applause', 0.75); }
        break;
      default: break;
    }
  }

  _readCtx(c) {
    this._ctx = c;
    const pl = c.players;
    if (pl) for (let i = 0; i < 2; i++) {
      const p = pl[i]; if (!p) continue;
      if (typeof p === 'string') { this.s.ids[i] = p; continue; }
      if (p.id) this.s.ids[i] = p.id;
      if (p.name) this.s.names[i] = p.name;
      if (p.pos) this.s.positions[i] = p.pos;
    }
    if (c.names) for (let i = 0; i < 2; i++) if (c.names[i]) this.s.names[i] = c.names[i];
    if (c.humans && c.humans.length) this.s.human = c.humans[0]; else if (typeof c.human === 'number') this.s.human = c.human;
    if (this.G && (c.listenerPos || c.listenerDir)) this.G.setListener(c.listenerPos, c.listenerDir);
  }
  _pos(i) { return i != null ? this.s.positions[i] ?? null : null; }

  _strokeStart(ev, t) {
    const stroke = strokeOf(ev);
    const windup = ev.windup ?? STROKES[stroke]?.windup ?? 0.4;
    const power = clamp01(ev.power ?? 0.6);
    const pos = ev.contact || this._pos(ev.player);
    const tc = t + Math.max(0.05, windup);
    if (this.lim.acquire('whoosh', t, windup + 0.3)) this.sfx.whoosh(tc, { power: stroke === 'serve' || stroke === 'smash' ? Math.max(power, 0.8) : power }, pos);
    const id = this.s.ids[ev.player ?? -1];
    if (id === 'tom') {
      const p = stroke === 'serve' ? (power > 0.55 ? 0.5 : 0.15) : stroke === 'smash' ? 0.7 : power > 0.85 ? 0.2 : 0;
      if (p > 0 && chance(p)) this.creatures.exhale(tc + 0.012, power, this._pos(ev.player) || pos);
    }
  }

  _hit(ev, t, on) {
    const stroke = strokeOf(ev);
    this.s.rally++;
    this.crowd.setPhase('rally');
    this.s.excite = Math.min(0.6, 0.22 + this.s.rally * 0.012);
    if (!on || !this.lim.acquire('hit', t, 0.25)) return;
    const v = speedOf(ev, 25);
    const power = Math.max(clamp01((v - 8) / 42), ev.power != null ? clamp01(ev.power) * 0.9 : 0);
    const kind = stroke === 'serve' ? 'serve' : /volley/.test(stroke) ? 'volley' : stroke === 'smash' ? 'smash' : 'ground';
    const slice = ev.shot === 'slice' || ev.shot === 'drop' || /slice/.test(stroke);
    this.sfx.hit(t, { power, quality: ev.quality || 'good', kind, slice, strong: !!ev.strong }, ev.pos || this._pos(ev.player));
    if (this.s.rally >= 4 && ev.quality === 'stretch' && chance(0.35)) this.crowd.react('ooh', 0.3 + Math.min(0.3, this.s.rally * 0.02), { delay: 0.15 });
  }

  _lineCall(ev, on) {
    const word = ev.call === 'fault' ? 'fault' : ev.call === 'net' ? 'net' : 'out';
    this.s.lastLine = now();
    this.umpire.lineCall(word, ev.pos || null);
    if (on && ev.pos && lineDistance(ev.pos, word === 'fault') < 0.12) this.crowd.react(chance(0.6) ? 'ooh' : 'gasp', 0.5, { delay: 0.25 });
  }
  _faultCheck() {
    clearTimeout(this._faultTimer);
    this._faultTimer = setTimeout(() => { if (now() - this.s.lastLine > 900) this.umpire.say('Fault.'); }, 350);
  }

  _batchAdd(kind, ev) {
    if (!this._batch) { this._batch = {}; micro(() => this._flush()); }
    this._batch[kind] = ev;
  }
  /** Alle im selben Frame eingetroffenen Punkt/Spiel/Satz/Match-Ereignisse gemeinsam auflösen. */
  _flush() {
    const b = this._batch; this._batch = null;
    if (!b) return;
    clearTimeout(this._faultTimer);
    const s = this.s, on = !!this.G && !this.muted;
    const p = b.point, df = b.double_fault;
    const winner = p?.winner ?? b.match?.winner ?? b.set?.winner ?? b.game?.winner ?? null;
    const reason = p?.reason ?? (df ? 'double_fault' : null);
    const rally = p?.rally ?? s.rally;
    const pressureWas = s.pressure;
    const imp = b.match ? 1 : b.set ? 0.8 : b.game ? 0.4 : 0;
    const humanWon = winner != null && winner === s.human;
    s.faults = 0; s.rally = 0; s.pressure = null; s.excite = 0.22;
    s.boost = Math.min(0.6, s.boost + 0.04 + imp * 0.22 + (pressureWas ? 0.1 : 0) + Math.min(0.15, rally * 0.01));
    const inten = clamp01((REASON_BASE[reason] ?? 0.45) + Math.min(0.3, rally * 0.022) + (pressureWas ? 0.15 : 0) + imp * 0.2 + (humanWon ? 0.04 : 0));
    if (on) {
      const err = reason === 'unforced_error' || reason === 'double_fault' || reason === 'net' || reason === 'out';
      const cr = this.crowd;
      if (b.match) cr.react('standing', 1);
      else if (b.set) cr.react('cheer', Math.max(0.85, inten));
      else if (p || df) {
        if (reason === 'ace') cr.react('ooh', 0.45);
        if (p?.closeCall) cr.react('ooh', 0.55);
        if (err && (pressureWas || reason === 'double_fault')) {
          cr.react('aww', reason === 'double_fault' ? 0.45 : 0.6);
          cr.react('applause', Math.max(0.25, inten * 0.7), { delay: 0.7 });
        } else if (inten > 0.8) cr.react('cheer', inten);
        else cr.react('applause', inten, { delay: p?.closeCall ? 0.4 : 0.05 });
      } else if (b.game) cr.react('applause', 0.5);
      if (b.match) this.music.sting('match', { delay: 0.6, positive: humanWon || winner == null });
      else if (b.set) this.music.sting('set', { delay: 0.5, positive: humanWon });
      else if (b.game) this.music.sting(pressureWas === 'break_point' ? 'break' : 'game', { delay: 0.9, positive: humanWon });
      this._creatureReact(winner, reason, b, rally);
    }
    if (df) this.umpire.say('Double fault.', { delay: 0.45 });
    const text = this._callText(b, winner);
    if (text) this.umpire.say(text, { delay: (b.match ? 2.2 : b.set ? 1.8 : 1.0) + inten * 0.8, tag: 'score' });
  }

  _callText(b, winner) {
    const ev = b.match || b.set || b.game || b.point || b.double_fault;
    if (ev && typeof ev.call === 'string') return ev.call;
    const c = this._ctx;
    if (c) {
      try {
        if (typeof c.call === 'string') return c.call;
        if (typeof c.call === 'function') return c.call();
        if (c.score && typeof c.score.call === 'function') return c.score.call();
      } catch { /* Fallback unten */ }
    }
    const name = winner != null ? this.s.names[winner] : null;
    if (!name) return null;
    if (b.match) return `Game, set and match, ${name}.`;
    if (b.set) return `Game and set, ${name}.`;
    if (b.game) return `Game, ${name}.`;
    return null;
  }

  _creatureReact(winner, reason, b, rally) {
    const gi = this.s.ids.indexOf('gerry');
    if (gi < 0 || winner == null || !this.creatures) return;
    const pos = this._pos(gi);
    const t = this.ctx.currentTime + rnd(0.35, 0.7);
    if (winner === gi) {
      const p = b.match ? 1 : b.set ? 0.9 : b.game ? 0.45 : reason === 'ace' || reason === 'winner' ? 0.25 + Math.min(0.3, rally * 0.02) : 0.08;
      if (chance(p) && this._creatureOk(!!(b.match || b.set))) {
        this.creatures.meow(t, b.match ? 'proud' : b.set ? 'trill' : pick(['happy', 'trill', 'happy', 'mew']), pos);
        if (b.match) this.creatures.purr(t + 1.5, 2.6, pos);
        if (b.match || b.set || chance(0.5)) this.crowd.react('laugh', 0.35, { delay: 0.9 });
      }
    } else {
      const p = b.match || b.set ? 0.6 : reason === 'double_fault' ? 0.3 : reason === 'unforced_error' ? 0.15 : 0.04;
      if (chance(p) && this._creatureOk(false)) {
        if (reason === 'double_fault' && chance(0.35)) this.creatures.hiss(t, pos); else this.creatures.grumble(t, pos);
      }
    }
  }
  _creatureOk(force) {
    const t = now();
    if (!force && t - this._lastCreature < 6000) return false;
    this._lastCreature = t;
    return true;
  }
  _emote(ev) {
    const id = this.s.ids[ev.player ?? -1], name = ev.name || ev.emote;
    const pos = this._pos(ev.player);
    const t = this.ctx.currentTime + 0.15;
    if (id === 'gerry') {
      if ((name === 'celebrate' || name === 'jump' || name === 'fistpump') && chance(0.5) && this._creatureOk(false)) this.creatures.meow(t, chance(0.5) ? 'trill' : 'happy', pos);
      else if (name === 'dejected' && chance(0.35) && this._creatureOk(false)) this.creatures.grumble(t, pos);
    }
    if (name === 'wave' || name === 'bow') this.crowd.react('applause', 0.45);
  }

  _visibility() {
    if (!this.ctx) return;
    if (document.hidden) {
      this._wasRunning = this.ctx.state === 'running';
      this.umpire.cancel();
      this.ctx.suspend().catch(() => {});
    } else if (this._wasRunning) this.ctx.resume().catch(() => {});
  }

  // ------------------------------------------------------------ UI & Direktzugriff
  /** UI-Klang: 'move' | 'select' | 'back' | 'start' | 'pause' | 'resume' | 'toggle' | 'error' | 'tick' | 'score' | 'hover' */
  ui(name) { if (this.G && !this.muted) this.sfx.ui(name); }
  /** Direkt einen Klang spielen (Dev/Test/Sonderfälle). */
  play(name, o = {}) {
    if (!this.G) return;
    const t = this.ctx.currentTime + 0.01, pos = o.pos || null, sfx = this.sfx, cr = this.creatures;
    switch (name) {
      case 'hit': return sfx.hit(t, o, pos);
      case 'bounce': return sfx.bounce(t, o, pos);
      case 'net': return sfx.net(t, { ...o, cord: false }, pos);
      case 'net_cord': return sfx.net(t, { ...o, cord: true }, pos);
      case 'wall': return sfx.wall(t, o, pos);
      case 'roll': return sfx.roll(t, o, pos);
      case 'footstep': return sfx.footstep(t, o, pos);
      case 'split_step': return sfx.splitStep(t, o, pos);
      case 'shuffle': return sfx.shuffle(t, o, pos);
      case 'squeak': return sfx.squeak(t, o, pos);
      case 'whoosh': return sfx.whoosh(t + 0.2, o, pos);
      case 'toss': return sfx.toss(t, o, pos);
      case 'meow': return cr.meow(t, o.kind || 'happy', pos);
      case 'grumble': return cr.grumble(t, pos);
      case 'hiss': return cr.hiss(t, pos);
      case 'purr': return cr.purr(t, o.dur ?? 2.4, pos);
      case 'exhale': return cr.exhale(t, o.power ?? 0.8, pos);
      default:
        if (['match_start', 'game', 'set', 'match', 'break'].includes(name)) return this.music.sting(name, o);
        return this.crowd.react(name, o.intensity ?? 0.7, o);
    }
  }
  /** Debug-Zustand. */
  stats() {
    return {
      state: this.ctx?.state ?? 'none', baked: this.baked, bakeTimes: this.crowd.bakeTimes,
      murmur: +this.crowd.murmur.toFixed(3), hush: +this.crowd.hush.toFixed(3), excitement: +this.excitement.toFixed(3),
      voice: this.umpire.voice?.name ?? null, lineVoice: this.umpire.lineVoice?.name ?? null, speaking: this.umpire.busy,
    };
  }
}

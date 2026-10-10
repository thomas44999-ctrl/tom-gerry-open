// Spielablauf (ARCHITECTURE §11): Titel -> Einlauf -> Match -> Pause -> Matchende, Demo/Zuschauen.
// Verdrahtet Match (120 Hz) mit Figuren (über CharSync), Welt, Regie (Kamera, Nahaufnahmen, Zeitlupen, Hawk-Eye), UI und Audio.
// Schlagkern-Anzeige: Powerbalken + Zielkreis am menschlichen Spieler, Treffer-Stopp und Blitz bei starken Treffern.
//
//   const game = new Game({ renderer, ui, audio, world, chars: [tom, gerry], director, canvas, quality });
//   game.start();      // eigene RAF-Schleife
//   window.__TG = { game, match, director, renderer, setPhase, forceScore, skip, perf }
import { clamp, lerp } from '../core/math.js';
import { params } from '../core/util.js';
import { Match, TIMING } from './match.js';
import { InputManager } from './input.js';
import { PLAYER_STATS, HIT } from '../sim/strokes.js';
import { CharSync } from './charsync.js';
import { eventLabelDE } from '../sim/rules.js';
import { loadSettings, resolveSettings, FORMAT_RULES, GAME_PACE } from '../ui/ui.js';

const IDS = ['tom', 'gerry'];
const HUD_PLAYERS = [
  { id: 'tom', name: 'Tom', color: '#8CCBF2' },
  { id: 'gerry', name: 'Gerry', color: '#F08A2B' },
];
const LINE_DE = { baseline: 'Grundlinie', sideline: 'Seitenlinie', service: 'Aufschlaglinie', centre: 'Mittellinie' };
const QUALITIES = ['low', 'medium', 'high', 'ultra'];
const SERVE_SWEET = [0.786, 1.0];          // Messwert >= 0.786 entspricht Timing 'good' (|dtc| <= 0.09 s)
const ZERO3 = [0, 0, 0];
const AIM_SEG = 28;                         // Punkte des Zielkreis-Polygons
const POW_HOLD = 1.1;                       // s: eingefrorener Balken + km/h nach dem Treffer
const EMPTY_VIEW = { phase: 'idle', ball: null, players: [], humanIndex: 0, humanSide: 1, events: null, characters: null, time: 0, server: 0 };

export class Game {
  constructor({ renderer, ui, audio, world, chars, director, canvas, quality = 'auto' }) {
    this.renderer = renderer; this.ui = ui; this.audio = audio; this.world = world;
    this.chars = chars; this.director = director; this.canvas = canvas;
    this.quality = quality;
    this.state = 'boot';
    this.match = null;
    this.settings = resolveSettings(loadSettings());
    this.humanIdx = 0; this.camIdx = 0; this.camSide = 1;
    this.input = new InputManager(window, { mode: 'single' });
    this.inputs = [null, null];
    this.time = 0;
    this.pace = 1;                    // Spieltempo (Menü): Zeitfaktor während Aufschlag/Ballwechsel

    // Szene: Welt + Ball + Figuren
    const scene = this.scene = { drawables: [...world.drawables, ...world.ball.drawables], time: 0 };
    for (const c of chars) scene.drawables.push(...c.drawables);
    world.applyTo(scene);
    this.baseExposure = scene.exposure ?? 1;

    // Laufzeit-Zustand (wiederverwendet, keine Allokationen pro Bild)
    this.sync = new CharSync(null, chars);
    this._hitStop = 0;                // Treffer-Stopp (Echtzeit-Sekunden)
    this._flash = 0;                  // Belichtungs-Puls (0..1)
    this._pow = { t: -1, v: 0, kmh: 0 };            // eingefrorener Powerbalken nach dem Treffer
    this._aimHold = { t: -1, x: 0, z: 0, r: 0, red: false, lx: 0, lz: 0 };   // Zielkreis + Landepunkt nach dem Treffer
    this._aimPts = new Float32Array(AIM_SEG * 2);
    this._aimLand = [0, 0];
    this._v3 = new Float32Array(3);
    this.ballVis = { pos: new Float32Array(3), vel: ZERO3, spin: ZERO3, visible: false };
    this.view = { phase: 'idle', ball: this.ballVis, players: [], humanIndex: 0, humanSide: 1, events: null, characters: chars, time: 0, server: 0, state: null };
    this._scr = { x: 0, y: 0, visible: false };
    this._tmp = new Float32Array(3);
    this._lpos = new Float32Array(3); this._ldir = new Float32Array(3);
    this._audioSt = { listenerPos: this._lpos, listenerDir: this._ldir, excitement: 0, phase: null };
    this._worldCtx = { time: 0, ballPos: null, events: null, excitement: 0.3, camera: director.camera };
    this._pending = null;             // Regie-Entscheidung nach dem Punkt
    this.hold = false;                // Match angehalten (Hawk-Eye / Wiederholung)
    this.hideBall = false;
    this._cc = null;                  // knappe Linienentscheidung im laufenden Ballwechsel
    this._cord = false;               // Netzroller im laufenden Ballwechsel
    this._pointN = 0; this._lastReplay = -9;
    this._wipe = false;
    this._anyPrev = true;
    this._lb = false;
    this._endT = -1;
    this._perf = { gameMs: 0, frames: 0 };
    this._raf = 0; this._last = 0;
    this._lastView = null;

    ui.hud.setPlayers(HUD_PLAYERS);
    ui.on('sound', (n) => audio.ui(n));
    director.on('cue', (c) => this._onCue(c));
    this._applySettings(this.settings, true);

    // Klick/Tippen überspringt Sequenzen (Einlauf, Wiederholung)
    this._clickSkip = false;
    canvas.addEventListener('pointerdown', () => { this._clickSkip = true; canvas.focus(); });

    window.__TG = {
      game: this, director, renderer, world, chars, ui, audio,
      get match() { return this.game.match; },
      setPhase: (p) => this.setPhase(p),
      forceScore: (o) => this.forceScore(o),
      skip: () => this.skip(),
      perf: () => this.perf(),
    };
  }

  // ================================================================== Ablauf
  start() {
    const demo = params.bool('demo', false);
    const skip = params.bool('skip', false);
    const s = { ...loadSettings() };
    for (const k of ['player', 'difficulty', 'format', 'pace']) if (params.has(k)) s[k] = params.get(k);
    if (!FORMAT_RULES[s.format]) s.format = 'short';
    if (!IDS.includes(s.player)) s.player = 'tom';
    if (demo) s.mode = 'watch';
    this.settings = resolveSettings(s);
    if (demo || skip) this.startMatch(this.settings, { intro: !skip });
    else this.showTitle();
    this._last = performance.now();
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, Math.max(0, (now - this._last) / 1000));
      this._last = now;
      this.frame(dt);
    };
    this._raf = requestAnimationFrame(loop);
  }

  showTitle() {
    const { ui, director, audio } = this;
    this.state = 'title';
    this.match = null;
    this._resetTransient();
    ui.hud.hide(); ui.hidePause(); ui.hideMatchEnd?.(); ui.hideIntro(); ui.clearBanners(); ui.replayBadge(false); ui.hawkeye(null);
    this._setCharsVisible(false);
    this.world.ball.update(0, { visible: false });
    director.autoRecord = false;
    director.play('title_flyover', {});
    audio.setMode('title');
    this.input.setEnabled(false);
    ui.showTitle(loadSettings(), {
      onStart: (s) => { this.settings = s; this._applySettings(s); this.startMatch(s, { intro: true }); },
      onChange: (s) => this._applySettings(resolveSettings(s)),
    });
  }

  /** Neues Match. s = resolveSettings(...); opts.intro = Einlauf zeigen. */
  startMatch(s, { intro = true } = {}) {
    const { ui, director, audio } = this;
    this.settings = s;
    this._applySettings(s);
    ui.hideTitle(); ui.hidePause(); ui.hideMatchEnd?.(); ui.clearBanners(); ui.replayBadge(false); ui.hawkeye(null);
    this._resetTransient();
    const watch = s.mode === 'watch' || !s.humans || !s.humans.length;
    this.humanIdx = watch ? -1 : (s.humanIndex >= 0 ? s.humanIndex : 0);
    this.camIdx = this.humanIdx >= 0 ? this.humanIdx : 0;
    const seed = params.has('seed') ? params.num('seed', 1) : ((Math.random() * 1e9) >>> 0);
    const m = this.match = new Match({
      players: IDS.slice(), humans: this.humanIdx >= 0 ? [this.humanIdx] : [],
      difficulty: s.difficulty || 'normal', format: s.formatRules || FORMAT_RULES.short, seed,
      assist: s.assist || 'light', breakOnHit: true,
    });
    this.inputs[0] = this.inputs[1] = null;
    this.camSide = m.players[this.camIdx].side;
    this._setCharsVisible(true);
    this.sync.setMatch(m);
    this.sync.placeAll();
    const v = m.score.view();
    ui.hud.update(v);
    this.world.scoreboard.set(v);
    this._lastView = v;
    audio.setMode('match');
    director.autoRecord = true;
    director.cut();
    this.input.setEnabled(true);
    if (intro) this._startIntro();
    else { director.skip(); this._beginPlay(); }
  }

  _startIntro() {
    const m = this.match, { ui, director } = this;
    this.state = 'intro';
    ui.hud.hide();
    // Einlauf von den Bänken (Westseite) zu den Ausgangspositionen
    this._intro = { t: 0, start: [[-7.4, 0, 2.2 * m.players[0].side], [-7.4, 0, 2.2 * m.players[1].side]] };
    for (let i = 0; i < 2; i++) {
      const p = m.players[i], st = this._intro.start[i];
      p.pos[0] = st[0]; p.pos[2] = st[2]; p.vel[0] = p.vel[2] = 0;
      this.sync.place(i);
    }
    this.ballVis.visible = false;
    this._introDone = false;
    director.play('intro', {}).then(() => { if (this.state === 'intro') this._beginPlay(); });
  }

  _beginPlay() {
    const { ui } = this;
    this.state = 'match';
    ui.hideIntro();
    ui.hud.show();
    if (this.match) { ui.hud.update(this.match.score.view()); this.sync.clock = this.match.time; }
    if (this.humanIdx >= 0 && !this._toldControls) {
      this._toldControls = true;
      ui.toast('Schlagtaste früh drücken = Balken lädt (Kraft) · Kreis = Landezone, vor = hart, zurück = sicher · Pause: Esc', { icon: 'info', duration: 6500 });
    }
  }

  pause() {
    if (this.state !== 'match' || !this.match) return;
    const { ui, audio } = this;
    this._prevState = this.state;
    this.state = 'paused';
    audio.setPaused(true);
    this.input.setEnabled(false);
    this._hudOff();
    ui.showPause({
      onResume: () => this.resume(),
      onRestart: () => { audio.setPaused(false); this.startMatch(this.settings, { intro: false }); },
      onQuit: () => { audio.setPaused(false); this.showTitle(); },
      settings: loadSettings(),
      onChange: (s) => this._applySettings(resolveSettings(s)),
    });
  }

  resume() {
    if (this.state !== 'paused') return;
    this.ui.hidePause();
    this.audio.setPaused(false);
    this.input.setEnabled(true);
    this.input.consumePause();
    this.state = this._prevState || 'match';
  }

  _matchOver(winner) {
    const { ui, director } = this;
    this.state = 'match_over';
    this._pending = null;
    ui.hud.hide(); this._hudOff();
    director.play('match_end', { winner, loop: true });
    this._endT = 3.4;
    this._endWinner = winner;
  }

  _showMatchEnd() {
    const m = this.match, { ui } = this;
    const v = m.score.view();
    ui.showMatchEnd({ winner: this._endWinner ?? v.winner, sets: v.sets, duration: m.time, stats: m.score.stats }, {
      onRematch: () => this.startMatch(this.settings, { intro: false }),
      onMenu: () => this.showTitle(),
    });
    if (this.humanIdx < 0 && params.bool('demo', false)) this._endT = -12;   // Demo: nach 12 s Revanche
  }

  // ================================================================== Bild
  frame(dt) {
    const t0 = performance.now();
    this.time += dt;
    this._lastDt = dt;
    this.input.poll();
    const any = this.input.anyHeld() || this._clickSkip;
    const anyEdge = any && !this._anyPrev;
    this._anyPrev = this.input.anyHeld();
    this._clickSkip = false;

    switch (this.state) {
      case 'title': this._titleFrame(dt); break;
      case 'intro': this._introFrame(dt, anyEdge); break;
      case 'match': this._matchFrame(dt, anyEdge); break;
      case 'match_over': this._matchFrame(dt, false); break;
      case 'paused': this.director.update(0, null); break;
      default: break;
    }
    this._render(dt);
    const ms = performance.now() - t0;
    this._perf.gameMs = this._perf.gameMs * 0.95 + ms * 0.05;
    this._perf.frames++;
  }

  _render(dt) {
    const { scene, director, renderer, ui } = this;
    if (this.state !== 'paused') scene.time += dt;
    director.applyToScene(scene, this.baseExposure);
    if (this._flash > 0) { scene.exposure *= 1 + 0.32 * this._flash; this._flash = Math.max(0, this._flash - dt / 0.16); }
    const lb = director.letterbox > 0.5 && !director.replaying;
    if (lb !== this._lb) {
      this._lb = lb;
      ui.lbTop.style.transform = ui.lbBot.style.transform = lb ? 'none' : '';
    }
    renderer.render(scene, director.camera);
  }

  _titleFrame(dt) {
    const { director, world } = this;
    director.update(dt, EMPTY_VIEW);
    const W = this._worldCtx;
    W.time = this.time; W.ballPos = null; W.events = null; W.excitement = 0.15;
    world.update(dt, W);
    this._audioFrame(dt, 'idle', 0.1);
  }

  _introFrame(dt, anyEdge) {
    const m = this.match, { director, world } = this;
    const I = this._intro;
    I.t += dt;
    // Einlauf-Animation (Match läuft noch nicht)
    const T = 2.7;                    // fertig vor den Nahaufnahmen (ab 3.8 s)
    for (let i = 0; i < 2; i++) {
      const p = m.players[i], st = I.start[i], g = p.walkTarget;
      const k = clamp((I.t - 0.15 - i * 0.35) / T, 0, 1), e = k * k * (3 - 2 * k);
      const nx = lerp(st[0], g[0], e), nz = lerp(st[2], g[2], e);
      if (dt > 0) { p.vel[0] = (nx - p.pos[0]) / dt; p.vel[2] = (nz - p.pos[2]) / dt; }
      p.pos[0] = nx; p.pos[2] = nz;
      const sp = Math.hypot(p.vel[0], p.vel[2]);
      const want = sp > 0.25 ? Math.atan2(p.vel[0], p.vel[2]) : p.netYaw;
      let d = want - p.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      p.yaw += clamp(d, -6 * dt, 6 * dt);
      p.mode = sp > 0.25 ? 'walk' : 'idle'; p.ready = 0; p.stroke = null; p.emote = null;
      p.lookAt[0] = m.players[1 - i].pos[0]; p.lookAt[1] = 1.5; p.lookAt[2] = m.players[1 - i].pos[2];
    }
    this._updateChars(dt, false);
    this.ballVis.visible = false;
    this._fillView(null);
    director.update(dt, this.view);
    const W = this._worldCtx;
    W.time = this.time; W.ballPos = null; W.events = null; W.excitement = 0.35;
    world.update(dt, W);
    this.world.ball.update(dt, this.ballVis);
    this._lod();
    this._audioFrame(dt, 'pre_serve', 0.3);
    if (anyEdge || this.input.consumePause()) { director.skip(); this.ui.hideIntro(); if (this.state === 'intro') this._beginPlay(); }
  }

  _matchFrame(dt, anyEdge) {
    const m = this.match, S = m.state, { director, ui, world } = this;
    const P = m.players;
    if (this.state === 'match' && !ui.blocksInput && this.input.consumePause()) { this.pause(); return; }

    // laufende Sequenz (Wiederholung, Hawk-Eye, Nahaufnahme) mit Schlagtaste/Klick überspringen
    if (anyEdge && this.state === 'match') {
      const pl = director.playing;
      if (pl === 'replay' || pl === 'hawkeye' || pl === 'closeup' || pl === 'change_ends') director.skip();
    }

    // Eingabe (kamerarelativ; Kameraseite wechselt erst nach dem Seitenwechsel-Gang)
    if (S.phase !== 'change_ends') this.camSide = P[this.camIdx].side;
    const h = this.humanIdx;
    if (h >= 0) this.inputs[h] = this.state === 'match' && !ui.blocksInput ? this.input.getPlayerInput(0, P[h].side, this.camSide) : null;

    // Match-Takt (intern 120 Hz). Spieltempo verlangsamt/beschleunigt nur Aufschlag und Ballwechsel – Ball, Spieler
    // und Animation laufen auf derselben Uhr (CharSync: Figuren folgen der Match-Zeit). Ein Treffer beendet den Takt-
    // Durchlauf (breakOnHit): dieses Bild zeigt den Kontakt; starke Treffer halten es kurz an (Treffer-Stopp).
    const active = S.phase === 'serve' || S.phase === 'rally';
    const k = director.timeScale * (active ? this.pace : 1);
    const stopped = this._hitStop > 0;
    if (stopped) this._hitStop -= dt;
    else if (!this.hold && !director.replaying) m.step(dt * k, this.inputs);
    const events = m.drainEvents();
    for (let i = 0; i < events.length; i++) this._route(events[i]);

    // Figuren + Ball
    if (!director.replaying && !stopped) {
      if (this.hold) this.sync.update(dt, true);
      else this.sync.advance();
    }
    this._updateBall();

    // Regie
    this._fillView(events);
    director.update(dt, this.view);

    // Welt
    const W = this._worldCtx;
    W.time = this.time; W.events = events; W.excitement = 0.3 + 0.7 * (S.excitement || 0);
    if (director.replaying && director.replayState) {
      const rb = director.replayState.ball;
      W.ballPos = rb && rb.visible !== false ? rb.pos : null;
    } else W.ballPos = this.ballVis.visible ? this.ballVis.pos : null;
    world.update(dt, W);
    if (world.ball.setView) world.ball.setView(director.camera, this.canvas.clientHeight || 720);
    if (!director.replaying) world.ball.update(this.hold || stopped ? 0 : dt * k, this.ballVis);
    this._lod();

    // UI am Spieler (Powerbalken, Zielkreis, Aufschlag-Messer), Spielstand
    this._hudFrame();
    this._phaseWatch(dt);
    this._direct(dt);
    this._audioFrame(dt, S.phase, W.excitement);
    if (this._endT > 0) { this._endT -= dt; if (this._endT <= 0) { this._endT = 0; this._showMatchEnd(); } }
    else if (this._endT < 0) { this._endT += dt; if (this._endT >= 0) { this._endT = 0; this.startMatch(this.settings, { intro: false }); } }
  }

  // ================================================================== Ereignisse
  _route(e) {
    const m = this.match, { ui, audio } = this;
    audio.handle(e, m.state);
    this.sync.event(e);
    switch (e.type) {
      case 'hit': {
        const human = e.player === this.humanIdx && this.humanIdx >= 0;
        if (human && !e.serve) {
          ui.hud.timing(e.rescue ? 'rescue' : e.quality, this._headScreen(e.player, -0.05), e.player);
          // Balken einfrieren (Kraft = Wert), km/h dazu; Zielkreis + Landepunkt kurz stehen lassen
          this._pow.t = POW_HOLD; this._pow.v = e.power; this._pow.kmh = e.kmh;
          const A = this._aimHold;
          A.t = 0.9; A.x = e.target.x; A.z = e.target.z; A.r = e.radius; A.red = e.red; A.lx = e.landing.x; A.lz = e.landing.z;
        }
        // starker Treffer: Treffer-Stopp (Echtzeit), Blitz, Belichtungs-Puls (Ton: audio, ev.strong)
        if (e.strong && this.state === 'match') {
          const pw = Math.min(1, Math.max(0, (e.power - 0.7) / 0.3));
          this._hitStop = HIT.stopMin + (HIT.stopMax - HIT.stopMin) * pw;
          this._flash = 1;
          const v = this._v3; v[0] = e.pos[0]; v[1] = e.pos[1]; v[2] = e.pos[2];
          const sp = this.renderer.worldToScreen(this.director.camera, v, this._scr);
          if (sp.visible) ui.hud.impact(sp, 0.6 + 0.4 * pw);
        }
        break;
      }
      case 'miss':
        if (e.player === this.humanIdx && this.humanIdx >= 0 && !e.serve) ui.hud.timing('miss', this._headScreen(e.player, -0.05), e.player);
        break;
      case 'serve_speed': if (e.kmh > 40) ui.hud.serveSpeed(e.kmh); break;
      case 'net': if (e.cord && !e.dead) this._cord = true; break;
      case 'line_call':
        if (e.closeCall) this._cc = e.closeCall;
        if (e.call === 'out' && !e.closeCall) ui.banner('Aus', '', 'out', { duration: 800 });
        break;
      case 'fault':
        if (e.n === 1) {
          const b = eventLabelDE(e, m.score.names);
          if (b) ui.banner(b.title, b.sub, b.kind);
          if (e.closeCall && !this._pending) this._pending = { kind: 'hawkeye', t: 0, cc: e.closeCall, fault: true };
        }
        break;
      case 'double_fault': case 'let': {
        const b = eventLabelDE(e, m.score.names);
        if (b) ui.banner(b.title, b.sub, b.kind);
        break;
      }
      case 'point': {
        const b = eventLabelDE(e, m.score.names);
        if (b) ui.banner(b.title, b.sub, b.kind);
        if (e.de) ui.banner(e.de.title, e.de.sub, e.de.kind);
        this._onPoint(e);
        this._scoreChanged();
        break;
      }
      case 'game': case 'set': case 'tiebreak_start': case 'pressure':
        if (e.de) ui.banner(e.de.title, e.de.sub, e.de.kind, { player: e.winner ?? e.player });
        this._scoreChanged();
        break;
      case 'match':
        if (e.de) ui.banner(e.de.title, e.de.sub, e.de.kind, { player: e.winner });
        this._scoreChanged();
        this._pending = { kind: 'match_end', t: 0, winner: e.winner };
        break;
      case 'change_ends':
        this._pending = null;
        if (!m.instantReset) this.director.play('change_ends', { player: this.camIdx });
        break;
      case 'phase':
        if (e.phase === 'pre_serve') {
          this._cc = null; this._cord = false;
          if (m.instantReset && (e.prev === 'between_points' || e.prev === 'change_ends')) this._newPointCut();
        }
        break;
      default: break;
    }
  }

  /** Neuer Punkt: Spieler stehen bereits auf ihren Positionen -> Figuren umsetzen, Schnitt mit kurzer Aufblende. */
  _newPointCut() {
    const d = this.director;
    this.sync.placeAll();
    if (d.playing === 'closeup' || d.playing === 'change_ends') d.skip();
    else if (!d.playing) { d.cut(); d.dip(0.3); }
  }

  _scoreChanged() {
    const v = this.match.score.view();
    if (v === this._lastView) return;
    this._lastView = v;
    this.ui.hud.update(v);
    this.world.scoreboard.set(v);
  }

  _onPoint(e) {
    const cc = e.closeCall || this._cc;
    this._cc = null;
    const ls = e.lastShot;
    const great = e.reason === 'ace' || e.reason === 'service_winner' || e.reason === 'winner' || e.reason === 'double_bounce';
    const smash = great && ls && ls.type === 'smash';
    const cord = great && this._cord;
    const worthy = e.reason === 'ace' || (great && e.rally >= 6) || smash || cord;
    this._cord = false;
    this._pointN++;
    let kind = 'closeup', who = e.winner, walk = false;
    if (cc) kind = 'hawkeye';
    else if (worthy && (this._pointN - this._lastReplay >= 2 || e.bigPoint || smash || cord)) { kind = 'replay'; this._lastReplay = this._pointN; }
    else if (e.reason === 'double_fault') { who = e.loser; walk = true; }
    this._pending = { kind, t: 0, who, walk, cc, fault: false };
  }

  _onCue(c) {
    const { ui } = this;
    switch (c.name) {
      case 'wide':
        if (c.seq === 'intro' && this.match) ui.showIntro(HUD_PLAYERS.map((p, i) => ({ ...p, index: i })), { hold: true });
        break;
      case 'player': if (c.seq === 'intro') ui.hideIntro(); break;
      case 'replay_start': ui.clearBanners(); ui.replayBadge(true, 'Zeitlupe'); break;
      case 'replay_angle': ui.replayBadge(true, 'Andere Perspektive'); break;
      case 'replay_end': ui.replayBadge(false); break;
      case 'verdict': {
        const d = c.data || {};
        const cc = this._hkCC;
        ui.hawkeye({ verdict: d.verdict === 'in' ? 'IN' : 'AUS', distanceMm: d.distanceMm ?? (cc ? cc.distanceMm : 0), line: cc ? LINE_DE[cc.line] || 'Linie' : 'Linie', duration: 2600 });
        break;
      }
      default: break;
    }
  }

  /** Regie-Entscheidungen zwischen den Punkten (Nahaufnahme, Zeitlupe, Hawk-Eye, Matchende). */
  _direct(dt) {
    const p = this._pending;
    if (!p) return;
    const m = this.match, S = m.state, d = this.director;
    if (p.kind === 'match_end') {
      p.t += dt;
      if (p.t > 1.5 && !this.hold) { this._pending = null; this._matchOver(p.winner); }
      return;
    }
    if (d.playing || this.hold) return;
    p.t += dt;
    const between = S.phase === 'point_over' || S.phase === 'between_points' || (p.fault && S.phase === 'serve');
    if (!between) { this._pending = null; return; }
    if (p.kind === 'closeup' && p.t > 0.3) {
      // kurz halten: endet, bevor die Spieler zur Grundlinie zurückgehen (sonst Rückenansicht)
      this._pending = null;
      d.play('closeup', { player: p.who, emote: m.players[p.who].emote, walk: p.walk, dur: p.walk ? 2.8 : 2.0 });
    } else if (p.kind === 'hawkeye' && p.t > 0.35) {
      this._pending = null;
      this.hold = true; this.hideBall = true;
      this._hkCC = p.cc;
      d.play('hawkeye', { pos: p.cc.pos, verdict: p.cc.in ? 'in' : 'out', distanceMm: p.cc.distanceMm, dur: 4.2 }).then(() => {
        this.hold = false; this.hideBall = false; this.ui.hawkeye(null);
      });
    } else if (p.kind === 'replay' && p.t > 0.9) {
      this._pending = null;
      this.hold = true;
      this.ui.hud.charge(0, null); this.ui.hud.charge(1, null);
      d.play('replay', {}).then(() => { this.hold = false; this.ui.replayBadge(false); });
    }
  }

  /** Phasenabhängige UI (Seitenwechsel-Blende). */
  _phaseWatch() {
    const m = this.match, S = m.state;
    if (S.phase === 'change_ends') {
      // ohne Gang zur Bank: Blende sofort; der Schnitt auf die neue Seite fällt in die voll deckende Mitte
      const at = m.instantReset ? 0 : TIMING.changeEnds - 1.0;
      if (!this._wipe && S.phaseTime >= at) {
        this._wipe = true;
        const v = this.match.score.view();
        this.ui.changeEnds({ sub: `${v.names[0]} ${v.games[0]} : ${v.games[1]} ${v.names[1]}` });
      }
    } else this._wipe = false;
  }

  // ================================================================== Figuren & Ball
  _updateChars(dt, frozen) { this.sync.update(dt, frozen); }

  _updateBall() {
    const m = this.match, S = m.state, b = this.ballVis;
    b.visible = !!S.ball.visible && !this.hideBall;
    b.vel = S.ball.vel; b.spin = S.ball.spin;
    const hand = this.sync.ballPos(b.pos);
    if (hand) b.spin = ZERO3;
  }

  _fillView(events) {
    const m = this.match, S = m.state, v = this.view;
    v.phase = this.hold ? 'point_over' : S.phase;
    v.players = m.players;
    v.humanIndex = this.camIdx;
    v.humanSide = m.players[this.camIdx].side;
    v.events = events;
    v.time = m.time;
    v.server = S.server;
    v.state = S;
  }

  _setCharsVisible(on) {
    for (const c of this.chars) for (const d of c.drawables) d.visible = on;
    this._charsVisible = on;
  }

  /** Fell-LOD nach Bildgröße der Figur. */
  _lod() {
    const cam = this.director.camera, H = this.canvas.clientHeight || 720;
    const t = Math.tan((cam.fov || 0.75) * 0.5);
    for (const c of this.chars) {
      const dx = cam.position[0] - c.position[0], dy = cam.position[1] - 0.9, dz = cam.position[2] - c.position[2];
      const dist = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));
      c.setLod(H * 1.6 / (2 * dist * t));
    }
  }

  /** Bildschirmposition der Körpermitte eines Spielers (CSS-Pixel), Anker für den Powerbalken. */
  _bodyScreen(i) {
    const p = this.match.players[i], st = PLAYER_STATS[p.id] || PLAYER_STATS.tom;
    const v = this._tmp;
    v[0] = p.pos[0]; v[1] = st.height * 0.55; v[2] = p.pos[2];
    return this.renderer.worldToScreen(this.director.camera, v, this._scr);
  }

  /** Bildschirmposition über dem Kopf eines Spielers (CSS-Pixel). */
  _headScreen(i, extra = 0.25) {
    const p = this.match.players[i], st = PLAYER_STATS[p.id] || PLAYER_STATS.tom;
    const v = this._tmp;
    v[0] = p.pos[0]; v[1] = st.height + extra; v[2] = p.pos[2];
    return this.renderer.worldToScreen(this.director.camera, v, this._scr);
  }

  _hudOff() {
    const hud = this.ui.hud;
    hud.power(0, null); hud.power(1, null); hud.aimCircle(0, null); hud.aimCircle(1, null); hud.serveMeter(null);
    this._pow.t = -1; this._aimHold.t = -1;
  }

  /** Zielkreis (Welt, Mitte x/z, Radius r) als Bildschirm-Polygon; false, wenn nicht sichtbar. */
  _projectCircle(x, z, r) {
    const pts = this._aimPts, v = this._v3, cam = this.director.camera;
    for (let i = 0; i < AIM_SEG; i++) {
      const a = (i / AIM_SEG) * Math.PI * 2;
      v[0] = x + Math.cos(a) * r; v[1] = 0.02; v[2] = z + Math.sin(a) * r;
      const s = this.renderer.worldToScreen(cam, v, this._scr);
      if (!s.visible) return false;
      pts[2 * i] = s.x; pts[2 * i + 1] = s.y;
    }
    return true;
  }

  _hudFrame() {
    const m = this.match, S = m.state, ui = this.ui, h = this.humanIdx;
    if (h < 0 || this.state !== 'match' || this.director.mode !== 'broadcast' || m.state.phase === 'change_ends') {
      this._hudOff();
      return;
    }
    const p = m.players[h];
    const dt = this._lastDt || 0;
    // Powerbalken: lädt ab Tastendruck, nach dem Treffer eingefroren mit km/h
    const pv = p.preview;
    if (this._pow.t > 0) {
      this._pow.t -= dt;
      const s = this._bodyScreen(h);
      ui.hud.power(h, this._pow.v, s.visible ? s : null, { frozen: true, kmh: this._pow.kmh });
    } else if (p.pending && (S.phase === 'rally' || S.phase === 'serve')) {
      // angezeigt wird die Kraft, die ausgeführt würde (Rettungsschlag: gedeckelt)
      const s = this._bodyScreen(h);
      ui.hud.power(h, pv.on ? pv.power : p.charge, s.visible ? s : null, { net: pv.on && pv.net });
    } else ui.hud.power(h, null);
    // Zielkreis: beim Laden (Vorschau), nach dem Treffer kurz mit Landepunkt
    const A = this._aimHold;
    if (A.t > 0) {
      A.t -= dt;
      if (this._projectCircle(A.x, A.z, A.r)) {
        const v = this._v3; v[0] = A.lx; v[1] = 0.02; v[2] = A.lz;
        const s = this.renderer.worldToScreen(this.director.camera, v, this._scr);
        this._aimLand[0] = s.x; this._aimLand[1] = s.y;
        ui.hud.aimCircle(h, this._aimPts, { red: A.red, land: s.visible ? this._aimLand : null, fade: Math.max(0, 1 - A.t / 0.35) });
      } else ui.hud.aimCircle(h, null);
    } else if (pv.on && S.phase === 'rally' && this._projectCircle(pv.x, pv.z, pv.r)) {
      ui.hud.aimCircle(h, this._aimPts, { red: pv.red || pv.net });
    } else ui.hud.aimCircle(h, null);
    if (p.serveMeter != null) {
      const s = this._headScreen(h, -0.4);
      this._scr2 = this._scr2 || [0, 0];
      this._scr2[0] = s.x + 70; this._scr2[1] = s.y;
      ui.hud.serveMeter(p.serveMeter, SERVE_SWEET, this._scr2);
    } else ui.hud.serveMeter(null);
  }

  _audioFrame(dt, phase, excitement) {
    const cam = this.director.camera, A = this._audioSt;
    const lp = this._lpos, ld = this._ldir;
    lp[0] = cam.position[0]; lp[1] = cam.position[1]; lp[2] = cam.position[2];
    let x = cam.target[0] - lp[0], y = cam.target[1] - lp[1], z = cam.target[2] - lp[2];
    const l = Math.hypot(x, y, z) || 1;
    ld[0] = x / l; ld[1] = y / l; ld[2] = z / l;
    A.excitement = excitement; A.phase = phase;
    this.audio.update(dt, A);
  }

  // ================================================================== Einstellungen & Debug
  _applySettings(s, initial = false) {
    if (!s) return;
    this.pace = GAME_PACE[s.pace] ?? 1;
    if (this.match && s.assist) this.match.setAssist(s.assist);
    this.audio.mute(s.sound === false);
    this.audio.setVolume('voice', s.voice === false ? 0 : 1);
    if (!initial && s.quality && s.quality !== this.quality) {
      this.quality = s.quality;
      const q = QUALITIES.includes(s.quality) ? s.quality : 'high';
      if (q !== this.renderer.q.name) this.renderer.setQuality(q);
    }
  }

  _resetTransient() {
    this._pending = null; this.hold = false; this.hideBall = false; this._cc = null; this._cord = false;
    this._endT = 0; this._wipe = false; this._hitStop = 0; this._flash = 0;
    if (this.director.playing) this.director.skip();
    this._hudOff();
  }

  /** Debug: Spielzustand ('title'|'match'|'paused') oder Match-Phase erzwingen. */
  setPhase(p) {
    if (p === 'title') return this.showTitle();
    if (p === 'paused') return this.pause();
    if (p === 'match') { if (!this.match) this.startMatch(this.settings, { intro: false }); else { this.director.skip(); this._beginPlay(); } return; }
    if (this.match) this.match.setPhase(p);
  }

  /** Debug: Spielstand setzen (rules.Score.force), z. B. { games: [3, 2], points: [3, 0] }. */
  forceScore(o) {
    if (!this.match) this.startMatch(this.settings, { intro: false });
    this.match.forceScore(o);
    this._pending = null;
    if (this.director.playing) this.director.skip();
    this.sync.placeAll();
    this._lastView = null;
    this._scoreChanged();
    if (this.state === 'intro') this._beginPlay();
  }

  /** Laufende Sequenz/Einlauf überspringen. */
  skip() {
    if (this.state === 'intro') { this.director.skip(); this._beginPlay(); return; }
    if (this.director.playing) this.director.skip();
  }

  perf() {
    const s = this.renderer.stats;
    return {
      fps: +s.fps.toFixed(1), frameMs: +s.frameMs.toFixed(2), cpuMs: +(s.cpuMs || 0).toFixed(2), gpuMs: +(s.gpuMs || 0).toFixed(2),
      gameMs: +this._perf.gameMs.toFixed(2), worldMs: +(this.world.updateMs || 0).toFixed(2),
      drawCalls: s.drawCalls, triangles: s.triangles, renderScale: s.renderScale, quality: this.renderer.q.name,
      contactErrCm: this.sync.stats.hits ? +(this.sync.stats.sum / this.sync.stats.hits * 100).toFixed(1) : null, contactMaxCm: +(this.sync.stats.max * 100).toFixed(1), hits: this.sync.stats.hits,
      state: this.state, phase: this.match ? this.match.state.phase : null, director: this.director.playing || this.director.mode,
    };
  }
}

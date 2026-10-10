// KI-Gegner: erzeugt PlayerInput wie ein Mensch (Bewegungsrichtung, Zielrichtung, Tastendrücke).
// Reaktionszeit, Vorhersage (Abfangplan aus match/player), Positionsspiel (Abfangpunkt + Erholung zur
// taktischen Grundposition), Schlagwahl nach Situation, Aufschlagvariation. Schwierigkeit easy/normal/hard.

import { COURT } from '../sim/court.js';
import { STROKES } from '../sim/strokes.js';
import { Rng, difficultyOf, targetToAim, strokeKey } from './player.js';

const HL = COURT.halfLength;
const SW = COURT.singlesHalfWidth;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const sgn = (x) => (x < 0 ? -1 : 1);

/** Zielrichtung für aimToTarget passend zu Familie/Schlagart (wie resolveShot). */
export function aimShotFor(family, shot) {
  if (family === 'smash') return 'smash';
  if (family === 'volley') return shot === 'drop' ? 'drop' : shot === 'lob' ? 'lob' : 'volley';
  return shot;
}

export class AIController {
  constructor(match, index, difficulty, seed = 1) {
    this.m = match;
    this.i = index;
    this.d = difficultyOf(difficulty);
    this.rng = new Rng(seed);
    this.input = { move: [0, 0], aim: [0, 0], buttons: { topspin: false, slice: false, lob: false, drop: false }, skip: false };
    this.reactAt = 0;
    this.dec = null;           // Schlagentscheidung für den ankommenden Ball
    this.decShot = -1;
    this.base = [0, 0, 0];
    this.baseX0 = 0;
    this.antic = null;
    this.serve = null;
    this.approachNext = false;
    this.lastMove = [0, 0];
    this.standPos = null;      // angestrebter Standort beim Schlag (Abfangpunkt + Positionsfehler)
    this._stand = [0, 0, 0];
    this.stats = { approaches: 0, lobs: 0, drops: 0, slices: 0, passes: 0 };
  }

  get me() { return this.m.players[this.i]; }
  get opp() { return this.m.players[1 - this.i]; }

  /** Verbleibende Reaktionszeit (für die Planung). */
  reactionLeft() { return Math.max(0, this.reactAt - this.m.time); }
  /** Bälle früh (auf dem Aufsteigen) nehmen? */
  wantsEarly() { return this.d.aiAggression > 0.6 && !!this.dec && this.dec.attack; }

  onNewPoint() {
    this.dec = null; this.decShot = -1; this.serve = null; this.approachNext = false;
    this.reactAt = 0;
  }

  /** Nach jedem Schlag (hitter = Index des Schlagenden). */
  onShot(hitter) {
    const m = this.m, me = this.me;
    if (hitter !== this.i) {
      const r = this.d.aiReaction * this.rng.range(0.8, 1.25);
      this.reactAt = m.time + r;
      this.dec = null;
      return;
    }
    // eigener Schlag: Netzangriff? (Serve-and-Volley auf Rasen nach dem 1. Aufschlag)
    if (m.rally.isServe && m.serveNo === 1 && this.rng.chance(this.d.aiNetRush * 1.3)) this.approachNext = true;
    if (this.approachNext) { me.netMode = true; this.approachNext = false; this.stats.approaches++; }
    this._computeBase();
  }

  _computeBase() {
    const me = this.me, m = this.m, s = me.side;
    this.antic = null;
    const tgt = m.state.target;
    const tx = tgt ? tgt.x : 0;
    if (me.netMode) {
      this.base[0] = clamp(tx * 0.45, -2.2, 2.2);
      this.baseX0 = this.base[0];
      this.base[2] = s * lerp(3.2, 2.4, this.d.aiAggression);
    } else {
      this.base[0] = clamp(tx * 0.3, -1.6, 1.6);
      this.baseX0 = this.base[0];
      const ls = m.state.lastShot;
      const deep = ls && ls.preset === 'lob' ? 0.4 : ls && ls.preset === 'drop' ? -1.0 : 0.85 - 0.4 * this.d.aiAggression;
      this.base[2] = s * (HL + deep);
    }
  }

  // ================================================================ pro Takt
  update(h) {
    const m = this.m, S = m.state, inp = this.input;
    inp.buttons.topspin = inp.buttons.slice = inp.buttons.lob = inp.buttons.drop = false;
    inp.move[0] = 0; inp.move[1] = 0; inp.skip = false;
    switch (S.phase) {
      case 'serve': if (S.server === this.i) this._serve(); break;
      case 'rally': this._rally(h); break;
      default: break;
    }
    return inp;
  }

  // ---------------------------------------------------------------- Aufschlag
  _serve() {
    const m = this.m, V = m.srv, inp = this.input, rng = this.rng, d = this.d;
    if (V.state === 'ready') {
      if (!this.serve || this.serve.done) this._planServe();
      if (V.t >= this.serve.delay) { inp.buttons.topspin = true; this.serve.tossed = true; }
      inp.aim[0] = this.serve.lr;
    } else if (V.state === 'toss') {
      const sv = this.serve || this._planServe();
      if (sv.pressAt == null) {
        const sig = d.aiServeSigma * (m.serveNo === 2 ? 0.7 : 1);
        sv.pressAt = V.idealPress + rng.gaussC(2.5) * sig + (m.serveNo === 2 ? 0 : 0.004);
      }
      if (m.time >= sv.pressAt) { inp.buttons[sv.button] = true; sv.done = true; }
      inp.aim[0] = sv.lr;
    } else if (V.state === 'swing') {
      inp.aim[0] = this.serve ? this.serve.lr : 0;
    }
  }

  _planServe() {
    const m = this.m, rng = this.rng, d = this.d;
    const box = m.state.serveBox;
    const wideLr = box === 'deuce' ? -1 : 1;           // aus Sicht des Aufschlägers: Deuce weit = links
    const r = rng.next();
    let lr, button;
    if (m.serveNo === 1) {
      lr = r < 0.36 ? wideLr * rng.range(0.75, 1) : r < 0.76 ? -wideLr * rng.range(0.75, 1) : rng.range(-0.25, 0.25);
      const k = rng.next();
      button = k < 0.55 ? 'topspin' : k < 0.85 ? 'slice' : 'lob';
      if (button === 'slice' && lr * wideLr < 0) button = rng.chance(0.5) ? 'topspin' : 'slice';
    } else {
      // (match.js staucht lr beim 2. Aufschlag auf 55 %)
      lr = r < 0.35 ? wideLr * rng.range(0.55, 1) : r < 0.75 ? -wideLr * rng.range(0.55, 1) : rng.range(-0.35, 0.35);
      button = rng.chance(0.7) ? 'lob' : 'slice';
    }
    this.serve = { lr, button, delay: rng.range(0.55, 1.35), pressAt: null, done: false, tossed: false };
    return this.serve;
  }

  // ---------------------------------------------------------------- Ballwechsel
  _rally(h) {
    const m = this.m, R = m.rally, me = this.me, inp = this.input, d = this.d;
    const incoming = R.active && !R.decided && R.lastHitter === 1 - this.i;
    if (!incoming || (me.stroke && me.stroke.done)) this.standPos = null;
    if (me.stroke && !me.stroke.done) {
      // im Schwung: Ziel halten
      if (this.dec) this._applyAim(this.dec, me.stroke.contact[0]);
      return;
    }
    if (incoming) {
      const plan = me.plan;
      if (m.time < this.reactAt) { this._recover(h, 0.6); return; }
      if (!plan || !plan.valid) { this._recover(h, 0.8); return; }
      if (!this.dec || this.decShot !== R.shotId) { this.dec = this._decide(plan); this.decShot = R.shotId; }
      const dec = this.dec;
      if (dec.letGo) {
        // Ball geht aus: aus dem Weg / Position halten
        this._recover(h, 0.5);
        return;
      }
      // Lauf zum (leicht ungenauen) Standort
      const tl = plan.time - m.time;
      const sp = this._stand, s = me.side;
      const kOff = clamp(tl / 0.7, 0.3, 1);          // späte Feinkorrektur
      sp[0] = plan.pos[0] + s * dec.offLat * kOff; sp[2] = plan.pos[2] - s * dec.offFwd * kOff;
      if (sp[2] * s < 0.5) sp[2] = 0.5 * s;
      this.standPos = sp;
      this._steer(sp[0], sp[2], tl, 1);
      // Taste drücken (Aufladen) – hoffnungslose Bälle nicht anschwingen
      if (!me.pending && plan.slack > -0.06 - 0.12 * (1 - d.aiSmart)) {
        const key = strokeKey(plan.family, plan.hand, dec.shot);
        const W = STROKES[key].windup;
        let pressAt = plan.time - W - dec.charge;
        if (dec.late) pressAt = plan.time - W * 0.55;
        if (m.time >= pressAt) { inp.buttons[dec.shot] = true; this._countShot(dec); }
      }
      this._applyAim(dec, plan.contact[0]);
    } else {
      // nach dem eigenen Schlag kurz nachsehen, dann zurück; während des gegnerischen Ausholens antizipieren
      const opp = this.opp;
      if (R.lastHitter === this.i && opp.stroke && !opp.stroke.done) this._anticipate();
      else this.antic = null;
      if (me.lastHit && m.time - me.lastHit.time < 0.12) return;
      this._recover(h, 0.8);
    }
  }

  /** Während des gegnerischen Ausholens: Richtung lesen/raten und vorverlagern. */
  _anticipate() {
    const m = this.m, opp = this.opp, me = this.me, d = this.d, rng = this.rng;
    if (!this.antic || this.antic.shot !== opp.stroke.start) {
      const cx = opp.stroke.contact[0];
      let gx;
      if (rng.chance(d.aiRead)) {
        // richtig gelesen: tatsächliche Zielrichtung des Gegners
        const oi = m._cur[opp.index];
        const oai = m.ai[opp.index];
        gx = oai && oai.dec ? oai.dec.tx : (oi && oi.aim ? opp.side * oi.aim[0] * 3.2 : 0);
      } else {
        // raten: meist cross
        gx = rng.chance(0.68) ? -Math.sign(cx || 1) * 2.6 : Math.sign(cx || 1) * 2.6;
      }
      this.antic = { shot: opp.stroke.start, dx: clamp(gx * 0.32, -1.1, 1.1) * d.aiAnticipate };
    }
    this.base[0] = clamp(this.baseX0 + this.antic.dx, -2.8, 2.8);
  }

  _countShot(dec) {
    if (dec.shot === 'lob') this.stats.lobs++;
    else if (dec.shot === 'drop') this.stats.drops++;
    else if (dec.shot === 'slice') this.stats.slices++;
    if (dec.pass) this.stats.passes++;
  }

  _applyAim(dec, hitX) {
    const me = this.me;
    const a = targetToAim(me.side, hitX, dec.tx, dec.tz, aimShotFor(dec.family, dec.shot), this._aim || (this._aim = {}));
    this.input.aim[0] = a.lr; this.input.aim[1] = a.depth;
  }

  /** Erholung zur Grundposition. */
  _recover(h, urgency) {
    const m = this.m, me = this.me;
    if (!this._baseValid(me)) this._computeBase();
    const opp = this.opp;
    // Zeit bis zum gegnerischen Treffer (falls bekannt)
    let tl = 1.2;
    if (opp.stroke && !opp.stroke.done) tl = Math.max(0.15, opp.stroke.contactTime - m.time);
    else if (opp.plan && opp.plan.valid) tl = Math.max(0.2, opp.plan.time - m.time);
    this._steer(this.base[0], this.base[2], tl, urgency);
  }

  _baseValid(me) { return this.base[2] * me.side > 0.5; }

  /** Bewegung zum Punkt mit Ankunftsverhalten, Tempo nach verfügbarer Zeit. */
  _steer(tx, tz, timeLeft, urgency) {
    const me = this.me, inp = this.input;
    const dx = tx - me.pos[0], dz = tz - me.pos[2];
    const d = Math.hypot(dx, dz);
    if (d < 0.06) { inp.move[0] = 0; inp.move[1] = 0; return; }
    const S = me.stats, vmax = S.maxSpeed;
    const need = d / Math.max(0.08, timeLeft - 0.06);
    const vArr = Math.sqrt(2 * S.decel * 0.8 * d);
    let v = Math.max(need * 1.25, Math.min(3.2, vmax) * urgency);
    v = Math.min(v, vArr, vmax * this.d.aiSpeed);
    const f = clamp(v / vmax, 0, 1);
    inp.move[0] = (dx / d) * f; inp.move[1] = (dz / d) * f;
  }

  // ---------------------------------------------------------------- Schlagwahl
  _decide(plan) {
    const m = this.m, me = this.me, opp = this.opp, rng = this.rng, d = this.d;
    const s = me.side;
    const cz = Math.abs(plan.contact[2]);
    const ox = opp.pos[0], oz = Math.abs(opp.pos[2]);
    const oppNet = oz < 6.6 || opp.netMode;
    const oppDeep = oz > HL + 0.9;
    // Ungeduld in langen Ballwechseln: kleinere Sicherheitsabstände, mehr Angriffe
    const impatience = clamp((m.rally.hits - 6) / 10, 0, 0.6);
    const margin = d.aiMargin * (1 - 0.65 * impatience);
    const aggr = Math.min(1, d.aiAggression + impatience);
    const dec = { shot: 'topspin', family: plan.family, tx: 0, tz: 0, charge: 0.5, letGo: false, late: false, attack: false, pass: false, offLat: 0, offFwd: 0 };
    // Positionsfehler (Spieler steht nie perfekt): größer bei wenig Zeit
    const pe = d.aiPosErr * (0.7 + 0.7 * clamp(1 - plan.slack / 0.6, 0, 1));
    dec.offLat = rng.gaussC(2.2) * pe; dec.offFwd = rng.gaussC(2.2) * pe * 1.2;
    // Ball geht aus? -> laufen lassen (Profis erkennen das, leichte KI irrt öfter)
    if (me.predBounceIn === false) {
      if (rng.chance(0.25 + 0.75 * d.aiSmart)) { dec.letGo = true; return dec; }
    }
    if (me.netMode && cz > 8.5 && plan.family === 'ground') me.netMode = false;   // überlobt
    const lead = rng.range(d.aiChargeLead[0], d.aiChargeLead[1]);
    const tAvail = plan.time - Math.max(m.time, this.reactAt);
    // weiter Weg: spät drücken (Aufladen bremst den Lauf)
    const runFactor = clamp((plan.slack - 0.05) / 0.45, 0.15, 1);
    dec.charge = clamp(Math.min(lead * runFactor, tAvail - 0.45), 0, 1);
    dec.late = rng.chance(d.aiLatePress);
    const openSide = Math.abs(ox) > 0.6 ? -sgn(ox) : (rng.chance(0.5) ? 1 : -1);    // Weltseite (x-Vorzeichen) des offenen Platzes
    const zOpp = (dist) => -s * dist;
    const xIn = (side, m0) => side * clamp(SW - m0, 0.6, SW - 0.25);
    const fam = plan.family;
    const stretched = plan.slack < 0.12 || !plan.feasible;
    if (fam === 'smash') {
      dec.shot = 'topspin'; dec.tx = xIn(openSide, 0.7 * margin + 0.3); dec.tz = zOpp(rng.range(7.0, 9.0)); dec.charge = clamp(dec.charge + 0.3, 0, 1);
      dec.attack = true;
      return dec;
    }
    if (fam === 'volley') {
      dec.attack = true;
      if (oppNet) { dec.tx = clamp(ox * 0.4, -1.5, 1.5); dec.tz = zOpp(rng.range(5.0, 6.5)); }
      else if (oppDeep && rng.chance(d.aiDrop * 2.5) && plan.height > 0.6) {
        dec.shot = 'drop'; dec.tx = xIn(openSide, 1.2); dec.tz = zOpp(rng.range(2.0, 3.0));
      } else {
        dec.tx = xIn(openSide, 0.6 * margin + 0.4); dec.tz = zOpp(rng.range(6.5, 9.5));
      }
      return dec;
    }
    // ---- Grundschlag
    const hitX = plan.contact[0];
    if (stretched) {
      const veryStretched = plan.slack < -0.05;
      if (oppNet && rng.chance(0.55)) { dec.shot = 'lob'; dec.tx = clamp(-ox * 0.6, -2.4, 2.4); dec.tz = zOpp(10.2); dec.pass = true; }
      else if (veryStretched && rng.chance(0.4)) { dec.shot = 'lob'; dec.tx = rng.range(-1.2, 1.2); dec.tz = zOpp(10.0); }
      else if (rng.chance(0.5)) { dec.shot = 'slice'; dec.tx = xIn(-sgn(hitX || 1), 1.5 * margin + 0.3); dec.tz = zOpp(9.2); }
      else { dec.shot = 'topspin'; dec.tx = xIn(-sgn(hitX || 1), 1.4 * margin + 0.3); dec.tz = zOpp(8.8); }
      dec.charge = Math.min(dec.charge, 0.35);
      return dec;
    }
    if (oppNet) {
      dec.pass = true;
      if (oz < 4.0 && rng.chance(0.35)) {
        dec.shot = 'lob'; dec.tx = clamp(-ox, -2.6, 2.6); dec.tz = zOpp(10.0);
      } else {
        // Passierschlag zur offenen Seite: longline tief, cross kürzer
        const sideX = openSide;
        const longline = sgn(hitX || 1) === sideX;               // gleiche Seite wie Treffpunkt = longline
        dec.shot = rng.chance(0.15) ? 'slice' : 'topspin';
        dec.tx = xIn(sideX, 0.55 * margin + 0.15);
        dec.tz = zOpp(longline ? rng.range(9.0, 10.3) : rng.range(6.5, 8.2));
        dec.charge = clamp(dec.charge + 0.15, 0, 1);
      }
      return dec;
    }
    // Gegner aus der Position gedrängt: zur offenen Seite angreifen
    const displaced = Math.abs(ox) > 2.1 && plan.slack > 0.1 && plan.height > 0.55 * me.scale;
    if (displaced && rng.chance(0.25 + 0.6 * d.aiSmart * (0.5 + aggr))) {
      dec.attack = true;
      dec.shot = 'topspin';
      dec.tx = xIn(openSide, 0.6 * margin + 0.25);
      dec.tz = zOpp(rng.chance(0.5) ? rng.range(9.2, 10.3) : rng.range(6.8, 8.0));
      dec.charge = clamp(dec.charge + 0.3, 0, 1);
      if (cz < HL - 1.5 && rng.chance(d.aiNetRush * 2)) this.approachNext = true;
      return dec;
    }
    const short = cz < HL - 3.0 && plan.height > 0.6 * me.scale && plan.slack > 0.2;
    if (short && rng.chance(0.35 + 0.6 * aggr)) {
      // Angriff: zur offenen Seite, evtl. Netzangriff
      dec.attack = true;
      dec.shot = rng.chance(0.2) ? 'slice' : 'topspin';
      dec.tx = xIn(openSide, 0.7 * margin + 0.2);
      dec.tz = zOpp(rng.range(9.3, 10.4));
      dec.charge = clamp(dec.charge + 0.25, 0, 1);
      if (rng.chance(d.aiNetRush * 2.6)) this.approachNext = true;
      return dec;
    }
    if (oppDeep && cz < HL + 0.3 && plan.height > 0.5 && plan.slack > 0.15 && rng.chance(d.aiDrop)) {
      dec.shot = 'drop'; dec.tx = rng.range(-2.4, 2.4); dec.tz = zOpp(rng.range(1.8, 3.0));
      return dec;
    }
    if (rng.chance(d.aiNetRush * 0.35) && cz < HL + 0.5) this.approachNext = true;   // Serve-and-volley-artiger Überraschungsangriff
    // Grundlinien-Rallye
    const r = rng.next();
    const offCentre = Math.abs(ox) > 1.4 && rng.chance(d.aiSmart);
    let side;
    if (offCentre) side = openSide;
    else if (r < 0.58) side = -sgn(hitX || (rng.chance(0.5) ? 1 : -1));        // cross
    else if (r < 0.78) side = sgn(hitX || 1);                                    // longline
    else side = 0;                                                               // Mitte
    const backhand = plan.hand === 'bh';
    const sliceP = (backhand ? 0.22 : 0.08) + (plan.height < 0.7 ? 0.12 : 0);
    dec.shot = rng.chance(sliceP) ? 'slice' : 'topspin';
    const lm = lerp(1.7, 0.75, aggr) * margin + 0.2;
    dec.tx = side === 0 ? rng.range(-1.0, 1.0) : xIn(side, lm + rng.range(-0.3, 0.3));
    dec.tz = zOpp(clamp(rng.range(8.6, 10.2) + aggr * 0.4 - (margin - 0.8) * 0.8, 7.5, 10.6));
    dec.charge = clamp(dec.charge + impatience * 0.5, 0, 1);
    return dec;
  }
}

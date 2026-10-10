// Figuren-Synchronisation: Match (Spiellogik, 120 Hz) -> Figuren (Animation) und gezeichneter Ball.
// Ohne DOM/WebGL, damit game.js und Node-Tests dieselbe Kopplung nutzen.
//
//   const sync = new CharSync(match, [tom, gerry]);
//   sync.event(e)                 // jedes Match-Ereignis (vor update), u. a. stroke_start / hit
//   sync.update(dt, frozen)       // Figuren fortschreiben; dt in Match-Sekunden (frozen: Match angehalten, Echtzeit)
//   sync.advance()                // dt = Match-Zeit seit dem letzten Aufruf (Normalfall im Spiel)
//   sync.ballPos(out)             // gezeichneter Ball: Kontaktbild (Ball am Schläger) + Ballmagnet (<= HIT.magnet)
//   sync.stats                    // Abstand Schläger-Sweet-Spot <-> gezeichneter Ball in Kontaktbildern
//
// Schnittstelle Spiellogik -> Figur (Prototyp 3):
//   Ladung      p.charge + p.pending  -> c.setCharge(v, { stroke, shot })   (Ausholpose ab Tastendruck)
//   Schwung     'stroke_start'        -> c.playStroke(type, { timeToContact, contactWorld, shot, power, lunge })
//   Kontakt     'hit'                 -> c.alignContact(pos, dt)  (Kontakt exakt auf das Bild des Treffers)
// Match muss mit breakOnHit laufen, damit ein Bild genau auf dem Kontakt endet.
import { SERVE, HIT } from '../sim/strokes.js';
import { TIMING } from './match.js';
import { strokeKey } from './player.js';

const ZERO3 = [0, 0, 0];
const WINNER_EMOTES = ['fistpump', 'wave', 'celebrate', 'bow'];
const LOSER_EMOTES = ['clap', 'shrug', 'clap'];

export class CharSync {
  constructor(match, chars) {
    this.chars = chars;
    this._sp = [null, null];          // letzte Aufschlagphase je Figur
    this._em = [null, null];          // letztes Emote je Figur
    this._emT = [0, 0]; this._emN = [0, 0];
    this._tmp = new Float32Array(3);
    this._sweet = new Float32Array(3);
    this.snap = null;                 // { pos, time, player } Kontaktbild
    this._hitFrame = -1;              // Spieler, dessen Treffer in diesem Bild liegt
    this.stats = { hits: 0, sum: 0, max: 0, list: [], raw: [] };   // raw: Abstand ohne Ballmagnet
    this.setMatch(match);
  }

  setMatch(m) {
    this.m = m;
    this.clock = m ? m.time : 0;
    this.snap = null;
    this._hitFrame = -1;
  }

  /** Figur i sofort an die Spielerposition setzen (Teleport, neuer Punkt). */
  place(i) {
    const p = this.m.players[i], c = this.chars[i];
    c.position[0] = p.pos[0]; c.position[1] = 0; c.position[2] = p.pos[2];
    c.yaw = p.yaw;
    c.stopAction();
    c.setCharge(null);
    c.reset();
    this._sp[i] = null; this._em[i] = null;
  }
  placeAll() { for (let i = 0; i < this.chars.length; i++) this.place(i); }

  /** Match-Ereignis (vor update() im selben Bild). */
  event(e) {
    const c = e.player != null ? this.chars[e.player] : null;
    if (e.type === 'stroke_start' && c) {
      const ttc = Math.max(0.03, (e.contactTime ?? this.clock + (e.windup || 0.3)) - this.clock);
      // Nur der Aufschlag setzt die gemerkte Aufschlagphase (sonst ersetzt ein späteres 'follow' den Grundschlag)
      if (e.stroke === 'serve') { c.playServe('swing', { timeToContact: ttc, contactWorld: e.contact, shot: e.shot, power: e.power }); this._sp[e.player] = 'swing'; }
      else c.playStroke(e.stroke, { timeToContact: ttc, contactWorld: e.contact, shot: e.shot, power: e.power, lunge: e.rescue ? 1 : 0 });
    } else if (e.type === 'hit' && c) {
      // Kontaktbild: Figur trifft genau mit dem Ende dieses Bildes, Ball wird am Treffpunkt gezeichnet
      c.alignContact(e.pos, this.m.time - this.clock);
      this.snap = { pos: [e.pos[0], e.pos[1], e.pos[2]], time: this.m.time, player: e.player };
      this._hitFrame = e.player;
    }
  }

  /** Figuren bis zur aktuellen Match-Zeit fortschreiben. */
  advance() {
    const dt = Math.max(0, this.m.time - this.clock);
    this.update(dt, false);
  }

  /** Figuren fortschreiben (dt Sekunden). frozen: Match steht (Hawk-Eye), Figuren atmen weiter ohne Fortbewegung. */
  update(dt, frozen = false) {
    const m = this.m, S = m.state, P = m.players;
    if (!frozen) this.clock = m.time;
    for (let i = 0; i < 2; i++) {
      const p = P[i], c = this.chars[i];
      const dx = p.pos[0] - c.position[0], dz = p.pos[2] - c.position[2];
      if (dx * dx + dz * dz > 2.25 && !(p.stroke && p.stroke.rescue)) this.place(i);   // Teleport (Seitenwechsel, Debug)
      c.position[0] = p.pos[0]; c.position[1] = 0; c.position[2] = p.pos[2];
      c.yaw = p.yaw;
      c.setLocomotion(frozen ? ZERO3 : p.vel, p.ready, null);
      if (!frozen && p.split > 0) c.splitStep(p.split);
      c.lookAt(p.lookAt);
      // Ausholen: ab Tastendruck bis zum Schwungstart
      if (p.pending && !p.stroke && (S.phase === 'rally' || S.phase === 'serve')) {
        const key = p.plan && p.plan.valid ? strokeKey(p.plan.family, p.plan.hand, p.pending.shot) : 'forehand';
        c.setCharge(p.charge, { stroke: key, shot: p.pending.shot });
      } else c.setCharge(null);
      // Aufschlag-Phasen
      const sp = p.servePhase;
      if (sp !== this._sp[i]) {
        this._sp[i] = sp;
        if (sp === 'bounce') c.playServe('bounce', { period: TIMING.bouncePeriod });
        else if (sp === 'toss') c.playServe('toss');
        else if (sp === 'follow') c.playServe('follow');
      }
      const isServer = i === S.server && (S.phase === 'serve' || S.phase === 'pre_serve');
      if (!isServer && c.busy === 'serve' && c.action && c.action.sub !== 'swing') c.stopAction();
      // Emotes (nach Matchende im Wechsel wiederholen: Sieger jubelt, Verlierer applaudiert)
      if (p.emote !== this._em[i]) {
        this._em[i] = p.emote;
        if (p.emote) { c.playEmote(p.emote); this._emT[i] = 0; }
      } else if (S.phase === 'match_over' && p.emote && !c.busy && (this._emT[i] += dt) > 1.2) {
        const list = p.emote === 'dejected' ? LOSER_EMOTES : WINNER_EMOTES;
        c.playEmote(list[(this._emN[i]++) % list.length]);
        this._emT[i] = 0;
      }
      c.update(dt);
    }
  }

  /**
   * Gezeichnete Ballposition (Welt) nach update(): Kontaktbild (Ball am Treffpunkt, solange die Match-Zeit steht –
   * auch während des Treffer-Stopps), sonst Simulation + Ballmagnet (zieht den Ball in den letzten Momenten vor dem
   * Treffer um höchstens HIT.magnet zum Sweet-Spot). Liefert true, wenn der Ball in der Hand des Aufschlägers ist.
   */
  ballPos(out) {
    const m = this.m, S = m.state;
    let hand = false;
    if (S.ball.held) {
      const srv = m.players[S.server];
      const sp = srv.servePhase;
      if (S.phase === 'pre_serve' || sp === 'bounce' || sp === 'ready') hand = true;
      else if (sp === 'toss') hand = m.time - m.srv.tossTime < SERVE.tossRelease;
      if (hand) { this.chars[S.server].heldBallPos(out); return true; }
    }
    if (this.snap && m.time > this.snap.time + 1e-9) this.snap = null;
    const sn = this.snap;
    const b = sn ? sn.pos : S.ball.pos;
    out[0] = b[0]; out[1] = b[1]; out[2] = b[2];
    if (this._hitFrame >= 0 && this.stats.raw.length < 4000) {
      const sw = this.chars[this._hitFrame].getRacketSweetSpot(this._sweet);
      this.stats.raw.push(Math.hypot(sw[0] - out[0], sw[1] - out[1], sw[2] - out[2]));
    }
    // Ballmagnet: laufender Schlag (kein Fehlschlag) kurz vor dem Treffer bzw. im Kontaktbild
    for (let i = 0; i < 2; i++) {
      const p = m.players[i];
      const st = p.stroke;
      let w = 0;
      if (this._hitFrame === i || (sn && sn.player === i)) w = 1;
      else if (st && !st.done && !st.miss && S.phase === 'rally') {
        const tl = st.contactTime - m.time;
        w = tl < 0.12 ? 1 - Math.max(0, tl) / 0.12 : 0;
      }
      if (w <= 0) continue;
      const sw = this.chars[i].getRacketSweetSpot(this._sweet);
      const dx = sw[0] - out[0], dy = sw[1] - out[1], dz = sw[2] - out[2];
      const d = Math.hypot(dx, dy, dz);
      if (d < 1e-6) continue;
      const k = Math.min(d, HIT.magnet) * w / d;
      out[0] += dx * k; out[1] += dy * k; out[2] += dz * k;
    }
    // Messung im Kontaktbild: Sweet-Spot <-> gezeichneter Ball
    if (this._hitFrame >= 0) {
      const sw = this.chars[this._hitFrame].getRacketSweetSpot(this._sweet);
      const d = Math.hypot(sw[0] - out[0], sw[1] - out[1], sw[2] - out[2]);
      const st = this.stats;
      st.hits++; st.sum += d; if (d > st.max) st.max = d;
      if (st.list.length < 4000) st.list.push(d);
      this._hitFrame = -1;
    }
    return false;
  }
}


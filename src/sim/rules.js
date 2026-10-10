// Tennis-Zählweise nach ITF-Regeln: Punkte (0/15/30/40), Einstand/Vorteil, Spiele, Sätze, Tiebreak,
// Match-Tiebreak, Aufschlagrotation (inkl. Tiebreak), Aufschlagfeld, Seitenwechsel, Druckpunkte
// (Breakball/Satzball/Matchball), Schiedsrichter-Ansagen (Englisch), Banner-Texte (Deutsch), Statistik.
// Reine Logik, deterministisch, node-testbar.

export const DEFAULT_FORMAT = {
  sets: 3,                 // Gewinnsätze: 1 -> 1, 3 -> 2, 5 -> 3
  games: 6,                // Spiele pro Satz (mit 2 Spielen Vorsprung)
  tiebreakAt: 6,           // Tiebreak bei tiebreakAt:tiebreakAt (null = Vorteilssatz ohne Tiebreak)
  tiebreakTo: 7,           // Tiebreak bis 7 (2 Punkte Vorsprung)
  finalSet: 'tiebreak',    // Entscheidungssatz: 'tiebreak' | 'advantage' | 'match_tiebreak'
  matchTiebreakTo: 10,     // Match-Tiebreak (statt Entscheidungssatz) bis 10
  noAd: false,             // true: bei 40:40 entscheidender Punkt
  startGames: null,        // z. B. [3, 3]: erster Satz beginnt bei 3:3 (Schnellmodus)
  firstServer: 0,
  startSides: [1, -1],     // Spielfeldseite von Spieler 0/1 zu Beginn (+1 = Hälfte mit z > 0)
};

/** Format normalisieren (akzeptiert auch die Aliase shortTiebreak und superTiebreakOnly aus ARCHITECTURE.md). */
export function normalizeFormat(f = {}) {
  f = f || {};
  const o = Object.assign({}, DEFAULT_FORMAT, f);
  if (f.tiebreakTo == null && f.shortTiebreak != null) o.tiebreakTo = f.shortTiebreak;
  // superTiebreakOnly: Entscheidungssatz = Match-Tiebreak (bei sets: 1 besteht das ganze Match aus einem Match-Tiebreak)
  if (f.superTiebreakOnly) o.finalSet = 'match_tiebreak';
  o.games = Math.max(1, o.games | 0);
  if (f.tiebreakAt === undefined) o.tiebreakAt = o.games;   // Tiebreak bei 6:6 bzw. 4:4 (Kurzsätze); null = Vorteilssatz
  o.tiebreakTo = Math.max(1, o.tiebreakTo | 0);
  o.matchTiebreakTo = Math.max(1, o.matchTiebreakTo | 0);
  o.sets = Math.max(1, o.sets | 0);
  o.setsToWin = Math.floor(o.sets / 2) + 1;
  o.firstServer = o.firstServer ? 1 : 0;
  o.startSides = [o.startSides[0] >= 0 ? 1 : -1, o.startSides[0] >= 0 ? -1 : 1];
  return o;
}

const POINT_WORDS = ['Love', 'Fifteen', 'Thirty', 'Forty'];
const POINT_TEXT = ['0', '15', '30', '40'];
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'];
const ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const DE_COUNT = ['null', 'ein', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn'];
const DASH = '–';

/** Zahl als englisches Wort (Tiebreak-Ansagen). */
export function numberWord(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
  return String(n);
}
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// ---------------------------------------------------------------- Zustand (reine Funktionen)
function newState(F) {
  const st = {
    sets: [], setsWon: [0, 0], games: [0, 0], points: [0, 0],
    server: F.firstServer ? 1 : 0, tiebreak: false, matchTiebreak: false, tbFirst: 0,
    sides: [F.startSides[0], F.startSides[1]], over: false, winner: null,
    gamesPlayed: 0, pointsPlayed: 0,
  };
  if (F.startGames) {
    const a = F.startGames[0] | 0, b = F.startGames[1] | 0, n = a + b;
    st.games = [a, b];
    st.gamesPlayed = n;
    st.server = n % 2 === 0 ? st.server : 1 - st.server;
    if (Math.floor((n + 1) / 2) % 2 === 1) flipSides(st);   // Seitenwechsel nach Spiel 1, 3, 5 …
    if (tiebreakAllowed(st, F) && a === F.tiebreakAt && b === F.tiebreakAt) { st.tiebreak = true; st.tbFirst = st.server; }
  }
  if (F.sets === 1 && F.finalSet === 'match_tiebreak') { st.tiebreak = true; st.matchTiebreak = true; st.tbFirst = st.server; }
  return st;
}

function cloneState(st) {
  return {
    sets: st.sets.map((s) => ({ games: s.games.slice(), tiebreak: s.tiebreak ? s.tiebreak.slice() : null, winner: s.winner })),
    setsWon: st.setsWon.slice(), games: st.games.slice(), points: st.points.slice(),
    server: st.server, tiebreak: st.tiebreak, matchTiebreak: st.matchTiebreak, tbFirst: st.tbFirst,
    sides: st.sides.slice(), over: st.over, winner: st.winner,
    gamesPlayed: st.gamesPlayed, pointsPlayed: st.pointsPlayed,
  };
}

function flipSides(st) { st.sides[0] = -st.sides[0]; st.sides[1] = -st.sides[1]; }

/** Aufschläger für den nächsten Punkt. Tiebreak: erster Punkt A, dann je zwei Punkte abwechselnd. */
function serverOf(st) {
  if (!st.tiebreak) return st.server;
  const n = st.points[0] + st.points[1];
  if (n === 0) return st.tbFirst;
  return Math.floor((n - 1) / 2) % 2 === 0 ? 1 - st.tbFirst : st.tbFirst;
}

function serveBoxOf(st) { return (st.points[0] + st.points[1]) % 2 === 0 ? 'deuce' : 'ad'; }

function isDecidingSet(st, F) { return st.sets.length === F.sets - 1; }
function tiebreakAllowed(st, F) { return F.tiebreakAt != null && !(isDecidingSet(st, F) && F.finalSet === 'advantage'); }

function applyPoint(st, F, w, ev) {
  if (st.over) return;
  const o = 1 - w;
  const server = serverOf(st);
  st.pointsPlayed++;
  if (ev) ev.push({ type: 'point', winner: w, server });
  st.points[w]++;
  if (st.tiebreak) {
    const to = st.matchTiebreak ? F.matchTiebreakTo : F.tiebreakTo;
    if (st.points[w] >= to && st.points[w] - st.points[o] >= 2) {
      const tb = st.points.slice();
      st.games[w]++;
      st.gamesPlayed++;
      if (ev) ev.push({ type: 'game', winner: w, server: st.tbFirst, broken: false, love: tb[o] === 0, games: st.games.slice(), setIndex: st.sets.length, tiebreak: true, matchTiebreak: st.matchTiebreak });
      endSet(st, F, w, tb, ev);
    } else if ((st.points[0] + st.points[1]) % 6 === 0) {
      flipSides(st);
      if (ev) ev.push({ type: 'change_ends', sides: st.sides.slice(), reason: 'tiebreak' });
    }
    return;
  }
  const pw = st.points[w], po = st.points[o];
  const won = (pw >= 4 && pw - po >= 2) || (F.noAd && pw >= 4);
  if (won) endGame(st, F, w, ev);
}

function endGame(st, F, w, ev) {
  const o = 1 - w, server = st.server;
  const love = st.points[o] === 0;
  st.games[w]++;
  st.points[0] = st.points[1] = 0;
  st.gamesPlayed++;
  if (ev) ev.push({ type: 'game', winner: w, server, broken: w !== server, love, games: st.games.slice(), setIndex: st.sets.length, tiebreak: false });
  const gw = st.games[w], go = st.games[o];
  if (gw >= F.games && gw - go >= 2) { endSet(st, F, w, null, ev); return; }
  st.server = 1 - st.server;
  if ((st.games[0] + st.games[1]) % 2 === 1) {
    flipSides(st);
    if (ev) ev.push({ type: 'change_ends', sides: st.sides.slice(), reason: 'game' });
  }
  if (tiebreakAllowed(st, F) && st.games[0] === F.tiebreakAt && st.games[1] === F.tiebreakAt) {
    st.tiebreak = true; st.matchTiebreak = false; st.tbFirst = st.server;
    if (ev) ev.push({ type: 'tiebreak_start', match: false, server: st.server, games: st.games.slice() });
  }
}

function endSet(st, F, w, tb, ev) {
  const games = st.games.slice();
  const wasTb = st.tiebreak, tbFirst = st.tbFirst, wasMatchTb = st.matchTiebreak;
  const serverLast = st.server;
  st.sets.push({ games, tiebreak: tb, winner: w, matchTiebreak: wasMatchTb });
  st.setsWon[w]++;
  st.tiebreak = false; st.matchTiebreak = false;
  st.points[0] = st.points[1] = 0;
  if (ev) ev.push({ type: 'set', winner: w, setIndex: st.sets.length - 1, games, tiebreak: tb, matchTiebreak: wasMatchTb, setsWon: st.setsWon.slice() });
  if (st.setsWon[w] >= F.setsToWin) {
    st.over = true; st.winner = w;
    if (ev) ev.push({ type: 'match', winner: w, sets: st.sets.map((s) => ({ games: s.games.slice(), tiebreak: s.tiebreak ? s.tiebreak.slice() : null, winner: s.winner })), setsWon: st.setsWon.slice() });
    return;
  }
  // Wer im Tiebreak zuerst aufschlug, RETOURNIERT im ersten Spiel des nächsten Satzes.
  st.server = wasTb ? 1 - tbFirst : 1 - serverLast;
  // Seitenwechsel am Satzende nur bei ungerader Spielsumme (Tiebreak zählt als ein Spiel)
  if ((games[0] + games[1]) % 2 === 1) {
    flipSides(st);
    if (ev) ev.push({ type: 'change_ends', sides: st.sides.slice(), reason: 'set' });
  }
  st.games[0] = st.games[1] = 0;
  if (isDecidingSet(st, F) && F.finalSet === 'match_tiebreak') {
    st.tiebreak = true; st.matchTiebreak = true; st.tbFirst = st.server;
    if (ev) ev.push({ type: 'tiebreak_start', match: true, server: st.server, games: [0, 0] });
  }
}

/** Was passiert, wenn p den nächsten Punkt gewinnt? -> { game, set, match } (jeweils von p gewonnen). */
function lookahead(st, F, p) {
  const c = cloneState(st);
  const games0 = c.games[p] + c.sets.length * 100, sets0 = c.setsWon[p];
  applyPoint(c, F, p, null);
  const set = c.setsWon[p] > sets0;
  const game = set || (c.games[p] + c.sets.length * 100 > games0);
  return { game, set, match: c.over && c.winner === p };
}

// ---------------------------------------------------------------- Statistik
function blankStats() {
  return {
    pointsWon: 0, aces: 0, doubleFaults: 0, serviceWinners: 0, winners: 0, unforcedErrors: 0, forcedErrors: 0,
    firstServes: 0, firstServesIn: 0, secondServes: 0, secondServesIn: 0,
    firstServePoints: 0, firstServePointsWon: 0, secondServePoints: 0, secondServePointsWon: 0,
    servicePoints: 0, servicePointsWon: 0, returnPoints: 0, returnPointsWon: 0,
    breakPointsWon: 0, breakPointsTotal: 0, breakPointsFaced: 0, breakPointsSaved: 0,
    fastestServeKmh: 0, firstServeKmhSum: 0, firstServeKmhN: 0,
    netPoints: 0, netPointsWon: 0, gamesWon: 0, streak: 0, maxStreak: 0,
  };
}

/** Statistik-Akkumulator (wird von Score.pointWon automatisch gefüttert). */
export class MatchStats {
  constructor() { this.reset(); }
  reset() {
    this.players = [blankStats(), blankStats()];
    this.longestRally = 0; this.rallies = 0; this.rallyShots = 0; this.pointsPlayed = 0;
  }
  /**
   * Punkt verbuchen. d = { reason, serve: 1|2, rally, serveKmh, faultKmh, atNet: [bool,bool], forced } (alles optional).
   * reason: 'ace'|'service_winner'|'winner'|'forced_error'|'unforced_error'|'double_fault'|'net'|'out'|'double_bounce'
   */
  record(w, server, d, pre) {
    const P = this.players, S = P[server], Rv = P[1 - server], W = P[w], L = P[1 - w];
    d = d || {};
    const reason = d.reason || '';
    const df = reason === 'double_fault';
    const serveNo = df ? 2 : (d.serve === 2 ? 2 : 1);
    this.pointsPlayed++;
    W.pointsWon++;
    // Aufschläge
    S.firstServes++;
    if (serveNo === 1) S.firstServesIn++;
    else { S.secondServes++; if (!df) S.secondServesIn++; }
    if (serveNo === 1) { S.firstServePoints++; if (w === server) S.firstServePointsWon++; }
    else { S.secondServePoints++; if (w === server) S.secondServePointsWon++; }
    S.servicePoints++; Rv.returnPoints++;
    if (w === server) S.servicePointsWon++; else Rv.returnPointsWon++;
    // Punktart
    switch (reason) {
      case 'ace': if (w === server) S.aces++; break;
      case 'double_fault': S.doubleFaults++; break;
      case 'service_winner': W.serviceWinners++; break;
      case 'winner': case 'double_bounce': W.winners++; break;
      case 'forced_error': L.forcedErrors++; break;
      case 'unforced_error': case 'net': case 'out': if (d.forced) L.forcedErrors++; else L.unforcedErrors++; break;
      default: break;
    }
    // Breakbälle (Lage VOR dem Punkt)
    if (pre && pre.breakPoint != null) {
      const b = pre.breakPoint;
      P[b].breakPointsTotal++; P[1 - b].breakPointsFaced++;
      if (w === b) P[b].breakPointsWon++; else P[1 - b].breakPointsSaved++;
    }
    // Ballwechsel
    if (d.rally > 0) { this.rallies++; this.rallyShots += d.rally; if (d.rally > this.longestRally) this.longestRally = d.rally; }
    // Aufschlagtempo
    const kmh = +d.serveKmh || 0, fk = +d.faultKmh || 0;
    const top = Math.max(kmh, fk);
    if (top > S.fastestServeKmh) S.fastestServeKmh = top;
    if (kmh > 0 && serveNo === 1) { S.firstServeKmhSum += kmh; S.firstServeKmhN++; }
    else if (fk > 0) { S.firstServeKmhSum += fk; S.firstServeKmhN++; }
    // Netzpunkte
    if (d.atNet) for (let i = 0; i < 2; i++) if (d.atNet[i]) { P[i].netPoints++; if (w === i) P[i].netPointsWon++; }
    // Serien
    W.streak++; L.streak = 0; if (W.streak > W.maxStreak) W.maxStreak = W.streak;
  }
  /** Zeilen für die Statistik-Tafel (deutsch, formatiert). */
  summaryDE() {
    const [a, b] = this.players;
    const pct = (n, d) => (d > 0 ? Math.round((100 * n) / d) + '%' : '–');
    const frac = (n, d) => `${n}/${d}`;
    const row = (label, f, better = 'high') => ({ label, values: [f(a), f(b)], better });
    return [
      row('Asse', (p) => String(p.aces)),
      row('Doppelfehler', (p) => String(p.doubleFaults), 'low'),
      row('1. Aufschlag', (p) => pct(p.firstServesIn, p.firstServes)),
      row('Punkte 1. Aufschlag', (p) => pct(p.firstServePointsWon, p.firstServePoints)),
      row('Punkte 2. Aufschlag', (p) => pct(p.secondServePointsWon, p.secondServePoints)),
      row('Schnellster Aufschlag', (p) => (p.fastestServeKmh > 0 ? Math.round(p.fastestServeKmh) + ' km/h' : '–')),
      row('Winner', (p) => String(p.winners + p.serviceWinners)),
      row('Unerzwungene Fehler', (p) => String(p.unforcedErrors), 'low'),
      row('Erzwungene Fehler', (p) => String(p.forcedErrors), 'low'),
      row('Breakbälle genutzt', (p) => frac(p.breakPointsWon, p.breakPointsTotal)),
      row('Netzpunkte', (p) => frac(p.netPointsWon, p.netPoints)),
      row('Punkte gesamt', (p) => String(p.pointsWon)),
      { label: 'Längster Ballwechsel', values: [String(this.longestRally), String(this.longestRally)], shared: true },
    ];
  }
}

// ---------------------------------------------------------------- Score
export class Score {
  /** names: ['Tom', 'Gerry']; format: siehe DEFAULT_FORMAT (Aliase shortTiebreak/superTiebreakOnly erlaubt). */
  constructor(names = ['Tom', 'Gerry'], format = {}) {
    this.names = names.slice();
    this.format = normalizeFormat(format);
    this.stats = new MatchStats();
    this.reset();
  }

  reset() {
    this._ver = (this._ver || 0) + 1;
    this.st = newState(this.format);
    this.stats.reset();
    this.lastCall = '';
    this.lastEvents = [];
    this.history = [];
    return this;
  }

  // ---- Lage
  get server() { return serverOf(this.st); }
  get receiver() { return 1 - serverOf(this.st); }
  /** Aufschlagfeld aus Sicht des Aufschlägers: 'deuce' (rechts) | 'ad' (links). */
  get serveBox() { return serveBoxOf(this.st); }
  /** Spielfeldseite des Aufschlägers (+1/-1). */
  get serverSide() { return this.st.sides[serverOf(this.st)]; }
  get sides() { return this.st.sides; }
  sideOf(player) { return this.st.sides[player]; }
  get over() { return this.st.over; }
  get winner() { return this.st.winner; }
  get isTiebreak() { return this.st.tiebreak; }
  get setIndex() { return this.st.sets.length; }

  /** Druck-/Spielstandsflags für den NÄCHSTEN Punkt (gecacht bis zur nächsten Änderung; nicht verändern). */
  flags() {
    if (this._flags && this._flagsVer === this._ver) return this._flags;
    this._flags = this._computeFlags(); this._flagsVer = this._ver;
    return this._flags;
  }

  _computeFlags() {
    const st = this.st, F = this.format;
    const f = { gamePoint: null, breakPoint: null, setPoint: null, matchPoint: null, deuce: false, advantage: null, decidingPoint: false, count: 0 };
    if (st.over) return f;
    const p = st.points, srv = serverOf(st);
    if (!st.tiebreak) {
      if (p[0] >= 3 && p[1] >= 3) {
        if (p[0] === p[1]) { f.deuce = true; f.decidingPoint = !!F.noAd; }
        else f.advantage = p[0] > p[1] ? 0 : 1;
      }
    }
    for (let i = 0; i < 2; i++) {
      const la = lookahead(st, F, i);
      if (la.match) f.matchPoint = f.matchPoint == null ? i : f.matchPoint;
      else if (la.set) f.setPoint = f.setPoint == null ? i : f.setPoint;
      if (la.game && !st.tiebreak) {
        if (f.gamePoint == null || i === 1 - srv) f.gamePoint = f.decidingPoint ? f.gamePoint ?? i : i;
        if (i !== srv) f.breakPoint = i;
      }
    }
    if (f.decidingPoint) f.gamePoint = null;
    // Anzahl Chancen (z. B. 15:40 = zwei Breakbälle, 6:3 im Tiebreak = drei Satzbälle, 6:0 = sechs)
    const holder = f.matchPoint ?? f.setPoint ?? f.breakPoint ?? f.gamePoint;
    if (holder != null) f.count = f.decidingPoint ? 1 : Math.max(1, p[holder] - p[1 - holder]);
    return f;
  }

  /**
   * Punkt für Spieler w. detail (optional, für Statistik): { reason, serve: 1|2, rally, serveKmh, faultKmh, atNet:[b,b], forced }.
   * Liefert Ereignisse in Reihenfolge: point, game, set, match, change_ends, tiebreak_start, pressure.
   * Jedes Ereignis trägt call (Englisch, Schiedsrichter) und de (Banner { title, sub, kind } oder null).
   */
  pointWon(w, detail = null) {
    const st = this.st, F = this.format;
    if (st.over) return [];
    w = w ? 1 : 0;
    const pre = this.flags();
    const server = serverOf(st);
    this.history.push(cloneState(st));
    if (this.history.length > 600) this.history.shift();
    this.stats.record(w, server, detail, pre);
    const ev = [];
    applyPoint(st, F, w, ev);
    this._ver++;
    for (const e of ev) if (e.type === 'game') this.stats.players[e.winner].gamesWon++;
    // Ansage
    this.lastCall = this._callFromEvents(ev);
    // Druckpunkte für den nächsten Punkt
    if (!st.over) {
      const f = this.flags();
      let kind = null, player = null;
      if (f.matchPoint != null) { kind = 'match_point'; player = f.matchPoint; }
      else if (f.setPoint != null) { kind = 'set_point'; player = f.setPoint; }
      else if (f.breakPoint != null) { kind = 'break_point'; player = f.breakPoint; }
      if (kind) ev.push({ type: 'pressure', kind, player, count: f.count, breakPoint: f.breakPoint != null && f.breakPoint === player });
    }
    for (const e of ev) {
      e.call = e.type === 'point' ? this.lastCall : this._eventCall(e);
      e.de = this.bannerDE(e);
    }
    this.lastEvents = ev;
    return ev;
  }

  /** Letzten Punkt zurücknehmen (Statistik bleibt unverändert). */
  undo() {
    if (!this.history.length) return false;
    this.st = this.history.pop();
    this._ver++;
    this.lastCall = this._pointCall();
    return true;
  }

  /** Debug: Spielstand setzen. { sets: [[6,4],[3,6]], games:[5,5], points:[3,2], server, tiebreak, sides } */
  force(o = {}) {
    const st = this.st, F = this.format;
    if (o.sets) {
      st.sets = o.sets.map((g) => ({ games: [g[0], g[1]], tiebreak: g[2] ? g[2].slice() : null, winner: g[0] > g[1] ? 0 : 1 }));
      st.setsWon = [0, 0];
      for (const s of st.sets) st.setsWon[s.winner]++;
    }
    if (o.games) st.games = o.games.slice();
    st.points = o.points ? o.points.slice() : [0, 0];
    if (o.server != null) st.server = o.server;
    st.tiebreak = o.tiebreak ?? (F.tiebreakAt != null && st.games[0] === F.tiebreakAt && st.games[1] === F.tiebreakAt);
    st.matchTiebreak = !!o.matchTiebreak;
    if (st.matchTiebreak) st.tiebreak = true;
    st.tbFirst = o.tbFirst ?? st.server;
    if (o.sides) st.sides = o.sides.slice();
    st.over = false; st.winner = null;
    this._ver++;
    this.lastCall = this._pointCall();
    return this;
  }

  snapshot() { return cloneState(this.st); }
  restore(snap) { this.st = cloneState(snap); this._ver++; this.lastCall = this._pointCall(); return this; }

  // ---- Ansagen (Englisch)
  /** Schiedsrichter-Ansage nach dem letzten Punkt ("Fifteen–Love", "Deuce", "Game, Gerry", …). */
  call() { return this.lastCall; }

  /** Spielstand-Ansage nach einem Spiel ("Tom leads four games to two", "Three games all"). */
  gamesCall() {
    const st = this.st, n = this.names;
    const g = st.games;
    if (g[0] === 0 && g[1] === 0 && st.sets.length > 0 && !st.over) {
      const s = st.setsWon;
      if (s[0] === s[1]) return `${numberWord(s[0])} set${s[0] === 1 ? '' : 's'} all`;
      const l = s[0] > s[1] ? 0 : 1;
      return `${n[l]} leads ${lower(numberWord(s[l]))} sets to ${lower(numberWord(s[1 - l]))}`;
    }
    if (g[0] === g[1]) return `${numberWord(g[0])} game${g[0] === 1 ? '' : 's'} all`;
    const l = g[0] > g[1] ? 0 : 1;
    return `${n[l]} leads ${lower(numberWord(g[l]))} game${g[l] === 1 ? '' : 's'} to ${lower(numberWord(g[1 - l]))}`;
  }

  _pointCall() {
    const st = this.st, n = this.names, F = this.format;
    if (st.over) return `Game, set and match, ${n[st.winner]}`;
    const p = st.points;
    if (st.tiebreak) {
      if (p[0] === p[1]) return `${numberWord(p[0])} All`;
      const l = p[0] > p[1] ? 0 : 1;
      return `${numberWord(p[l])}${DASH}${numberWord(p[1 - l])}, ${n[l]}`;
    }
    const s = serverOf(st), r = 1 - s;
    if (p[0] >= 3 && p[1] >= 3) {
      if (p[0] === p[1]) return F.noAd ? 'Deuce, deciding point' : 'Deuce';
      return `Advantage ${n[p[0] > p[1] ? 0 : 1]}`;
    }
    if (p[0] === p[1]) return `${POINT_WORDS[p[0]]} All`;
    return `${POINT_WORDS[p[s]]}${DASH}${POINT_WORDS[p[r]]}`;
  }

  _callFromEvents(ev) {
    for (let i = ev.length - 1; i >= 0; i--) {
      if (ev[i].type === 'match' || ev[i].type === 'set' || ev[i].type === 'game') return this._eventCall(ev[i]);
    }
    return this._pointCall();
  }

  _eventCall(e) {
    const n = this.names;
    switch (e.type) {
      case 'match': return `Game, set and match, ${n[e.winner]}`;
      case 'set': return this.st.over && this.st.winner === e.winner && e.setIndex === this.st.sets.length - 1
        ? `Game, set and match, ${n[e.winner]}`
        : `Game and ${ORDINALS[e.setIndex] || 'next'} set, ${n[e.winner]}`;
      case 'game': {
        const setEv = this.st.sets[e.setIndex];
        if (setEv && setEv.winner === e.winner && setEv.games[e.winner] === e.games[e.winner] && setEv.games[1 - e.winner] === e.games[1 - e.winner]) {
          return this.st.over && e.setIndex === this.st.sets.length - 1 ? `Game, set and match, ${n[e.winner]}` : `Game and ${ORDINALS[e.setIndex] || 'next'} set, ${n[e.winner]}`;
        }
        return `Game, ${n[e.winner]}`;
      }
      case 'tiebreak_start': return e.match ? 'Match tiebreak' : 'Tiebreak';
      case 'change_ends': return 'Time';
      case 'pressure': return e.kind === 'match_point' ? 'Match point' : e.kind === 'set_point' ? 'Set point' : 'Break point';
      default: return this._pointCall();
    }
  }

  // ---- Deutsch (Banner, Anzeigen)
  /** Banner-Text { title, sub, kind } für ein Ereignis oder null. kind: 'point'|'deuce'|'game'|'break'|'set'|'match'|'tiebreak'|'info'|'pressure'. */
  bannerDE(e) {
    const n = this.names;
    switch (e.type) {
      case 'point': {
        if (this.st.over) return null;
        const f = this.flags();
        if (f.decidingPoint) return { title: 'Entscheidender Punkt', sub: '', kind: 'deuce' };
        if (f.deuce) return { title: 'Einstand', sub: '', kind: 'deuce' };
        if (f.advantage != null) return { title: `Vorteil ${n[f.advantage]}`, sub: '', kind: 'deuce' };
        return null;
      }
      case 'game':
        if (e.tiebreak) return null;   // Satz-Banner übernimmt
        if (this.st.sets[e.setIndex] && this.st.sets[e.setIndex].games[0] === e.games[0] && this.st.sets[e.setIndex].games[1] === e.games[1]) return null;
        return { title: `Spiel ${n[e.winner]}`, sub: e.broken ? `Break! ${e.games[0]}:${e.games[1]}` : `${e.games[0]}:${e.games[1]}${e.love ? ' · zu null' : ''}`, kind: e.broken ? 'break' : 'game' };
      case 'set': {
        const g = e.games, tb = e.tiebreak;
        const score = e.matchTiebreak ? `${tb[0]}:${tb[1]}` : `${g[0]}:${g[1]}${tb ? ` (${Math.min(tb[0], tb[1])})` : ''}`;
        if (this.st.over && e.setIndex === this.st.sets.length - 1) return null;   // Match-Banner übernimmt
        return { title: `Satz ${n[e.winner]}`, sub: score, kind: 'set' };
      }
      case 'match': return { title: 'Spiel, Satz und Sieg', sub: `${n[e.winner]} gewinnt ${this.scorelineDE(e.winner)}`, kind: 'match' };
      case 'tiebreak_start': return { title: e.match ? 'Match-Tiebreak' : 'Tiebreak', sub: e.match ? `bis ${this.format.matchTiebreakTo}` : `${e.games[0]}:${e.games[1]}`, kind: 'tiebreak' };
      case 'change_ends': return { title: 'Seitenwechsel', sub: '', kind: 'info' };
      case 'pressure': {
        const base = e.kind === 'match_point' ? 'Matchball' : e.kind === 'set_point' ? 'Satzball' : 'Breakball';
        const title = e.count > 1 ? `${cap(DE_COUNT[e.count] || String(e.count))} ${base.replace('ball', 'bälle')}` : base;
        return { title, sub: n[e.player], kind: 'pressure' };
      }
      default: return null;
    }
  }

  /** Ergebnis aus Sicht des Spielers p, z. B. "6:4 3:6 7:6 (5)". */
  scorelineDE(p = 0) {
    return this.st.sets.map((s) => {
      if (s.matchTiebreak) return `[${s.tiebreak[p]}:${s.tiebreak[1 - p]}]`;
      return `${s.games[p]}:${s.games[1 - p]}${s.tiebreak ? ` (${Math.min(s.tiebreak[0], s.tiebreak[1])})` : ''}`;
    }).join(' ');
  }

  /** Aktueller Punktestand als deutscher Text ("15:30", "Einstand", "Vorteil Tom", Tiebreak "3:2"). Aufschläger zuerst. */
  scoreTextDE() {
    const st = this.st, n = this.names;
    if (st.over) return `Sieg ${n[st.winner]}`;
    const p = st.points, s = serverOf(st), r = 1 - s;
    if (st.tiebreak) return `${p[s]}:${p[r]}`;
    if (p[0] >= 3 && p[1] >= 3) {
      if (p[0] === p[1]) return this.format.noAd ? 'Entscheidender Punkt' : 'Einstand';
      return `Vorteil ${n[p[0] > p[1] ? 0 : 1]}`;
    }
    return `${POINT_TEXT[p[s]]}:${POINT_TEXT[p[r]]}`;
  }

  /** Anzeige-Objekt für HUD/Anzeigetafel (gecacht bis zur nächsten Änderung; nicht verändern). */
  view() {
    if (this._view && this._viewVer === this._ver && this._view.call === this.lastCall) return this._view;
    this._view = this._computeView(); this._viewVer = this._ver;
    return this._view;
  }

  _computeView() {
    const st = this.st, F = this.format;
    const f = this.flags();
    const p = st.points;
    let pointsText;
    if (st.tiebreak) pointsText = [String(p[0]), String(p[1])];
    else if (p[0] >= 3 && p[1] >= 3) {
      if (p[0] === p[1]) pointsText = ['40', '40'];
      else pointsText = p[0] > p[1] ? ['AD', '40'] : ['40', 'AD'];
    } else pointsText = [POINT_TEXT[Math.min(p[0], 3)], POINT_TEXT[Math.min(p[1], 3)]];
    const pointsTextDE = pointsText.map((t) => (t === 'AD' ? 'V' : t));
    const srv = serverOf(st);
    let pressure = null;
    if (f.matchPoint != null) pressure = { kind: 'match_point', player: f.matchPoint, count: f.count };
    else if (f.setPoint != null) pressure = { kind: 'set_point', player: f.setPoint, count: f.count };
    else if (f.breakPoint != null) pressure = { kind: 'break_point', player: f.breakPoint, count: f.count };
    return {
      names: this.names.slice(),
      server: srv, receiver: 1 - srv,
      serveBox: serveBoxOf(st), serverSide: st.sides[srv], sides: st.sides.slice(),
      // tb = Tiebreak-Punkte des Satzverlierers (Anzeige "7:6 (5)"), null ohne Tiebreak
      sets: st.sets.map((s) => ({ games: s.games.slice(), tiebreak: s.tiebreak ? s.tiebreak.slice() : null, tb: s.tiebreak ? Math.min(s.tiebreak[0], s.tiebreak[1]) : null, winner: s.winner, matchTiebreak: !!s.matchTiebreak })),
      setsWon: st.setsWon.slice(), games: st.games.slice(), points: p.slice(),
      pointsText, pointsTextDE,
      tiebreak: st.tiebreak, matchTiebreak: st.matchTiebreak,
      deuce: f.deuce, advantage: f.advantage, decidingPoint: f.decidingPoint,
      gamePoint: f.gamePoint, breakPoint: f.breakPoint, setPoint: f.setPoint, matchPoint: f.matchPoint, pressure,
      pressureCount: pressure ? pressure.count : 0,
      flags: { deuce: f.deuce, advantage: f.advantage, decidingPoint: f.decidingPoint, gamePoint: f.gamePoint, breakPoint: f.breakPoint,
        setPoint: f.setPoint, matchPoint: f.matchPoint, tiebreak: st.tiebreak, count: f.count },
      over: st.over, winner: st.winner,
      setIndex: st.sets.length, gameNumber: st.games[0] + st.games[1] + 1, pointInGame: p[0] + p[1] + 1,
      gamesPlayed: st.gamesPlayed, pointsPlayed: st.pointsPlayed,
      call: this.lastCall, scoreDE: this.scoreTextDE(),
      format: { sets: F.sets, games: F.games, tiebreakAt: F.tiebreakAt, tiebreakTo: F.tiebreakTo, finalSet: F.finalSet, noAd: F.noAd },
    };
  }
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Deutsche Kurzbezeichnungen (für UI/Banner). */
export const LABELS_DE = {
  deuce: 'Einstand', advantage: 'Vorteil', game: 'Spiel', set: 'Satz', match: 'Spiel, Satz und Sieg',
  breakPoint: 'Breakball', setPoint: 'Satzball', matchPoint: 'Matchball', tiebreak: 'Tiebreak',
  matchTiebreak: 'Match-Tiebreak', changeEnds: 'Seitenwechsel', break: 'Break', ace: 'Ass',
  doubleFault: 'Doppelfehler', fault: 'Fehler', secondServe: 'Zweiter Aufschlag', let: 'Netz – Wiederholung',
  out: 'Aus', net: 'Netz', winner: 'Winner', decidingPoint: 'Entscheidender Punkt', serve: 'Aufschlag',
  server: 'Aufschlag', challenge: 'Challenge', in: 'Drin',
};

/** Banner-Text für Spielereignisse, die nicht aus dem Score stammen (Match-Ereignisse aus §7). */
export function eventLabelDE(e, names = ['Tom', 'Gerry']) {
  switch (e.type) {
    case 'fault': return { title: e.n === 2 ? 'Doppelfehler' : 'Fehler', sub: e.n === 2 ? '' : 'Zweiter Aufschlag', kind: 'fault' };
    case 'double_fault': return { title: 'Doppelfehler', sub: names[e.player] ?? '', kind: 'fault' };
    case 'let': return { title: 'Netz', sub: 'Aufschlag wiederholen', kind: 'info' };
    case 'line_call': return { title: e.call === 'fault' ? 'Fehler' : 'Aus', sub: '', kind: 'call' };
    case 'point':
      if (e.reason === 'ace') return { title: 'Ass!', sub: names[e.winner] ?? '', kind: 'ace' };
      if (e.reason === 'winner' || e.reason === 'double_bounce') return { title: 'Winner', sub: names[e.winner] ?? '', kind: 'winner' };
      return null;
    default: return null;
  }
}

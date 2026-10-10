// Tests für src/sim/rules.js: Zählweise, Einstand/Vorteil, Tiebreak-Rotation, Seitenwechsel, Formate,
// Ansagen (Englisch), Banner (Deutsch), Flags, Statistik, view(). Aufruf: node test/rules.test.mjs
import { Score, MatchStats, normalizeFormat, numberWord, LABELS_DE, eventLabelDE } from '../src/sim/rules.js';
import { makeRng } from '../src/core/math.js';

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; failures.push(`✗ ${name}\n    ${e.message}`); }
}
function eq(a, b, msg = '') {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg} erwartet ${sb}, erhalten ${sa}`);
}
function ok(c, msg = 'Bedingung verletzt') { if (!c) throw new Error(msg); }

const T = 0, G = 1;                       // Tom, Gerry
/** Spielt eine Folge von Punktgewinnern ("TTGG…" oder [0,1,…]) und gibt alle Ereignisse zurück. */
function play(s, seq) {
  const all = [];
  for (const c of (typeof seq === 'string' ? seq.split('') : seq)) {
    const w = c === 'T' || c === 0 ? T : G;
    for (const e of s.pointWon(w)) all.push(e);
  }
  return all;
}
const hold = (s) => play(s, Array(4).fill(s.server));            // Aufschläger gewinnt das Spiel zu null
const brk = (s) => play(s, Array(4).fill(1 - s.server));         // Rückschläger gewinnt das Spiel zu null
const winGame = (s, p) => play(s, [p, p, p, p]);
const types = (ev) => ev.map((e) => e.type);

// ------------------------------------------------------------------ Punkte & Ansagen
test('Punktansagen: Aufschläger zuerst', () => {
  const s = new Score(['Tom', 'Gerry']);
  eq(s.server, T, 'Erster Aufschläger');
  s.pointWon(G); eq(s.call(), 'Love–Fifteen');
  s.pointWon(T); eq(s.call(), 'Fifteen All');
  s.pointWon(T); eq(s.call(), 'Thirty–Fifteen');
  s.pointWon(T); eq(s.call(), 'Forty–Fifteen');
  const ev = s.pointWon(T); eq(s.call(), 'Game, Tom');
  eq(types(ev), ['point', 'game', 'change_ends']);
  // Gerry schlägt auf: seine Punkte zuerst
  eq(s.server, G);
  s.pointWon(T); eq(s.call(), 'Love–Fifteen', 'Rückschläger gewinnt -> Love–Fifteen');
  s.pointWon(G); s.pointWon(G); eq(s.call(), 'Thirty–Fifteen');
  s.pointWon(T); s.pointWon(T); eq(s.call(), 'Thirty–Forty');
});

test('Einstand / Vorteil / Spiel', () => {
  const s = new Score(['Tom', 'Gerry']);
  play(s, 'TTTGGG'); eq(s.call(), 'Deuce'); eq(s.view().pointsText, ['40', '40']); ok(s.view().deuce);
  s.pointWon(T); eq(s.call(), 'Advantage Tom'); eq(s.view().pointsText, ['AD', '40']); eq(s.view().advantage, T);
  s.pointWon(G); eq(s.call(), 'Deuce');
  s.pointWon(G); eq(s.call(), 'Advantage Gerry'); eq(s.view().pointsText, ['40', 'AD']); eq(s.view().breakPoint, G);
  s.pointWon(G); eq(s.call(), 'Game, Gerry'); eq(s.view().games, [0, 1]);
  eq(s.view().pointsText, ['0', '0']);
});

test('Lange Einstandsfolge', () => {
  const s = new Score();
  play(s, 'TTTGGG' + 'TG'.repeat(20));
  eq(s.call(), 'Deuce'); eq(s.view().games, [0, 0]);
  play(s, 'TT'); eq(s.view().games, [1, 0]);
});

test('Deutsche Punktanzeige (scoreDE)', () => {
  const s = new Score(['Tom', 'Gerry']);
  play(s, 'TG'); eq(s.view().scoreDE, '15:15');
  play(s, 'GG'); eq(s.view().scoreDE, '15:40');
  play(s, 'TT'); eq(s.view().scoreDE, 'Einstand');
  play(s, 'G'); eq(s.view().scoreDE, 'Vorteil Gerry'); eq(s.view().pointsTextDE, ['40', 'V']);
});

// ------------------------------------------------------------------ Spiele, Aufschlag, Seiten
test('Aufschlagwechsel jedes Spiel, Aufschlagfeld deuce/ad', () => {
  const s = new Score();
  for (let g = 0; g < 5; g++) {
    eq(s.server, g % 2, `Spiel ${g + 1} Aufschläger`);
    eq(s.serveBox, 'deuce');
    s.pointWon(s.server); eq(s.serveBox, 'ad');
    s.pointWon(s.server); eq(s.serveBox, 'deuce');
    s.pointWon(s.server); s.pointWon(s.server);
  }
});

test('Seitenwechsel nach Spiel 1, 3, 5 …', () => {
  const s = new Score();
  eq(s.sides, [1, -1]);
  const changes = [];
  for (let g = 1; g <= 8; g++) {
    const ev = hold(s);
    if (ev.some((e) => e.type === 'change_ends')) changes.push(g);
  }
  eq(changes, [1, 3, 5, 7]);
  eq(s.view().games, [4, 4]);
  eq(s.sides, [1, -1]);
});

test('Satzende 6:4 ohne Seitenwechsel, dann nach Spiel 1 des 2. Satzes', () => {
  const s = new Score(['Tom', 'Gerry'], { sets: 3 });
  // Tom schlägt Spiele 1,3,…,9 auf und hält; Gerry hält 2,4,6,8; Break in Spiel 10 -> 6:4
  for (let g = 0; g < 10; g++) { if (g === 9) brk(s); else hold(s); }
  eq(s.view().setsWon, [1, 0]);
  eq(s.view().sets[0].games, [6, 4]);
  // Satz mit 10 Spielen -> kein Wechsel am Satzende; Spiel 10 war gerade
  // Seitenwechsel bisher: nach 1,3,5,7,9 -> 5 Wechsel -> Tom auf -1
  eq(s.sideOf(T), -1);
  // letzter Aufschläger (Spiel 10) war Gerry -> Tom eröffnet Satz 2
  eq(s.server, T);
  const ev = hold(s);
  ok(ev.some((e) => e.type === 'change_ends'), 'Wechsel nach Spiel 1 des neuen Satzes');
  eq(s.sideOf(T), 1);
});

test('Satzende 6:3: Wechsel am Satzende UND nach Spiel 1 des nächsten Satzes', () => {
  const s = new Score();
  // 6:3 Tom: Tom gewinnt alle seine Aufschlagspiele + 1 Break
  let n = 0; const order = [];
  while (s.view().setsWon[0] === 0) { const sv = s.server; winGame(s, sv === T || n === 1 ? T : G); order.push(sv); n++; }
  eq(s.view().sets[0].games, [6, 3]);
  // 9 Spiele: Wechsel nach 1,3,5,7,9(Satzende) -> 5 Wechsel
  eq(s.sideOf(T), -1);
  const ev = hold(s);
  ok(ev.some((e) => e.type === 'change_ends'), 'Wechsel nach Spiel 1');
  eq(s.sideOf(T), 1);
});

// ------------------------------------------------------------------ Tiebreak
function toSixAll(s) { for (let g = 0; g < 12; g++) hold(s); }

test('Tiebreak bei 6:6: Start-Ereignis, Aufschlagrotation 1-2-2, Feld, Seitenwechsel alle 6 Punkte', () => {
  const s = new Score(['Tom', 'Gerry']);
  let ev = [];
  for (let g = 0; g < 12; g++) ev = hold(s);
  ok(ev.some((e) => e.type === 'tiebreak_start'), 'tiebreak_start');
  ok(!ev.some((e) => e.type === 'change_ends'), 'kein Wechsel bei 6:6 (12 Spiele)');
  ok(s.isTiebreak);
  const first = s.server;
  eq(first, T, 'Tom eröffnet den Tiebreak (Spiel 13)');
  const servers = [], boxes = [], changesAfter = [];
  for (let i = 0; i < 12; i++) {
    servers.push(s.server); boxes.push(s.serveBox);
    const e = s.pointWon(i % 2 === 0 ? T : G);   // 6:6 nach 12 Punkten
    if (e.some((x) => x.type === 'change_ends')) changesAfter.push(i + 1);
  }
  eq(servers, [T, G, G, T, T, G, G, T, T, G, G, T]);
  eq(boxes, ['deuce', 'ad', 'deuce', 'ad', 'deuce', 'ad', 'deuce', 'ad', 'deuce', 'ad', 'deuce', 'ad']);
  eq(changesAfter, [6, 12]);
  eq(s.call(), 'Six All');
  s.pointWon(G); eq(s.call(), 'Seven–Six, Gerry');
  eq(s.view().setPoint, G);
  s.pointWon(T); eq(s.call(), 'Seven All');
  play(s, 'TT');
  eq(s.view().sets[0].games, [7, 6]);
  eq(s.view().sets[0].tiebreak, [9, 7]);
  eq(s.view().sets[0].tb, 7);
});

test('Nach Tiebreak: Rückschläger des 1. Tiebreak-Punkts schlägt im neuen Satz auf; Wechsel (13 Spiele)', () => {
  const s = new Score();
  toSixAll(s);
  const tbFirst = s.server;
  const sideBefore = s.sideOf(T);
  const ev = play(s, 'TTTTTTT');     // 7:0 – Seitenwechsel nach 6 Punkten, dann Satzende
  eq(types(ev).filter((t) => t === 'change_ends').length, 2);
  eq(ev.find((e) => e.type === 'game').tiebreak, true);
  eq(s.sideOf(T), sideBefore, 'zwei Wechsel -> gleiche Seite');
  eq(s.server, 1 - tbFirst);
  eq(s.view().games, [0, 0]);
  eq(s.view().sets[0].games, [7, 6]);
  // Ansage am Satzende
  eq(ev.findLast((e) => e.type === 'point').call, 'Game and first set, Tom');
});

test('Tiebreak-Ansagen', () => {
  const s = new Score(['Tom', 'Gerry']);
  toSixAll(s);
  s.pointWon(T); eq(s.call(), 'One–Zero, Tom');
  s.pointWon(G); eq(s.call(), 'One All');
  play(s, 'GGG'); eq(s.call(), 'Four–One, Gerry');
  play(s, 'TT'); eq(s.call(), 'Four–Three, Gerry');
  eq(s.view().pointsText, ['3', '4']);
  eq(s.view().scoreDE.length > 0, true);
});

test('Tiebreak: Satzbälle zählen (6:3 = drei, 6:0 = sechs)', () => {
  const s = new Score(['Tom', 'Gerry'], { sets: 3 });
  toSixAll(s);
  play(s, 'TTTTTTGGG');
  eq(s.view().setPoint, T); eq(s.view().pressure.count, 3);
  const s2 = new Score(); toSixAll(s2); play(s2, 'TTTTTT');
  eq(s2.flags().count, 6);
  const ev = s2.lastEvents.find((e) => e.type === 'pressure');
  eq(ev.de.title, 'Sechs Satzbälle');
});

// ------------------------------------------------------------------ Satz / Match
test('Best of 3: Match nach 2 Sätzen, Ansagen und Ereignisse', () => {
  const s = new Score(['Tom', 'Gerry'], { sets: 3 });
  let ev = [];
  for (let g = 0; g < 6; g++) ev = winGame(s, T);
  eq(ev.findLast((e) => e.type === 'point').call, 'Game and first set, Tom');
  eq(types(s.lastEvents), ['point', 'game', 'set']);
  for (let g = 0; g < 6; g++) ev = winGame(s, G);
  eq(s.lastCall, 'Game and second set, Gerry');
  eq(s.view().setsWon, [1, 1]);
  for (let g = 0; g < 5; g++) winGame(s, T);
  eq(s.view().matchPoint, null);
  play(s, 'TTT');
  eq(s.view().matchPoint, T); eq(s.view().pressure.count, 3);
  ev = play(s, 'T');
  ok(s.over); eq(s.winner, T);
  eq(s.call(), 'Game, set and match, Tom');
  ok(types(ev).includes('match'));
  eq(ev.find((e) => e.type === 'match').de.title, 'Spiel, Satz und Sieg');
  eq(s.pointWon(G), [], 'nach Matchende keine Punkte mehr');
  eq(s.scorelineDE(T), '6:0 0:6 6:0');
});

test('Best of 1 inkl. Tiebreak-Satz', () => {
  const s = new Score(['Tom', 'Gerry'], { sets: 1 });
  toSixAll(s);
  const ev = play(s, 'GGGGGGG');
  ok(s.over); eq(s.winner, G);
  eq(s.call(), 'Game, set and match, Gerry');
  eq(s.view().sets[0].games, [6, 7]);
  ok(types(ev).includes('set') && types(ev).includes('match'));
});

test('7:5-Satz (kein Tiebreak)', () => {
  const s = new Score();
  for (let g = 0; g < 10; g++) hold(s);   // 5:5
  winGame(s, T); winGame(s, T);
  eq(s.view().sets[0].games, [7, 5]);
});

test('Kurzsätze: games 4 → Tiebreak bei 4:4', () => {
  const s = new Score(['Tom', 'Gerry'], { sets: 3, games: 4 });
  for (let g = 0; g < 8; g++) hold(s);
  ok(s.isTiebreak, 'Tiebreak bei 4:4');
  play(s, 'TTTTTTT');
  eq(s.view().sets[0].games, [5, 4]);
  const s2 = new Score(['Tom', 'Gerry'], { sets: 1, games: 4 });
  for (let g = 0; g < 4; g++) winGame(s2, G);
  ok(s2.over); eq(s2.view().sets[0].games, [0, 4]);
});

test('Match-Tiebreak im Entscheidungssatz (bis 10)', () => {
  const s = new Score(['Tom', 'Gerry'], { sets: 3, finalSet: 'match_tiebreak' });
  for (let g = 0; g < 6; g++) winGame(s, T);
  const ev0 = []; for (let g = 0; g < 6; g++) ev0.push(...winGame(s, G));
  ok(ev0.some((e) => e.type === 'tiebreak_start' && e.match), 'match tiebreak start');
  ok(s.isTiebreak); eq(s.view().matchTiebreak, true);
  play(s, 'TGTGTGTGTGTGTGTGTG');   // 9:9
  eq(s.over, false);
  play(s, 'TT');
  ok(s.over); eq(s.winner, T);
  const v = s.view();
  eq(v.sets[2].tiebreak, [11, 9]);
  eq(s.scorelineDE(T), '6:0 0:6 [11:9]');
});

test('superTiebreakOnly + sets 1: ganzes Match = Match-Tiebreak', () => {
  const s = new Score(['Tom', 'Gerry'], { sets: 1, superTiebreakOnly: true });
  ok(s.isTiebreak);
  play(s, 'TTTTTTTTT'); eq(s.over, false);
  play(s, 'T'); ok(s.over);
});

test('Vorteils-Entscheidungssatz (finalSet: advantage)', () => {
  const s = new Score(['Tom', 'Gerry'], { sets: 1, finalSet: 'advantage' });
  for (let g = 0; g < 12; g++) hold(s);
  ok(!s.isTiebreak, 'kein Tiebreak');
  hold(s); hold(s); hold(s); hold(s);
  eq(s.view().games, [8, 8]);
  eq(s.server, T, 'Spiel 17: Tom schlägt auf');
  brk(s); ok(!s.over, '8:9 – Satz läuft weiter'); hold(s);   // Gerry bricht und hält -> 8:10
  ok(s.over); eq(s.winner, G); eq(s.scorelineDE(G), '10:8');
});

test('Tiebreak-Format: tiebreakTo 10, tiebreakAt null (Vorteilssätze)', () => {
  const s = new Score(['Tom', 'Gerry'], { sets: 1, tiebreakTo: 10 });
  toSixAll(s);
  play(s, 'TTTTTTTTT'); ok(!s.over);
  play(s, 'T'); ok(s.over);
  const s2 = new Score(['Tom', 'Gerry'], { sets: 1, tiebreakAt: null });
  for (let g = 0; g < 14; g++) hold(s2);
  ok(!s2.isTiebreak); eq(s2.view().games, [7, 7]);
  // Alias shortTiebreak
  eq(normalizeFormat({ shortTiebreak: 5 }).tiebreakTo, 5);
});

test('No-Ad: entscheidender Punkt', () => {
  const s = new Score(['Tom', 'Gerry'], { noAd: true });
  play(s, 'TTTGGG');
  eq(s.call(), 'Deuce, deciding point');
  ok(s.view().decidingPoint);
  eq(s.view().scoreDE, 'Entscheidender Punkt');
  s.pointWon(G); eq(s.view().games, [0, 1]);
});

test('startGames [3,3]: Aufschläger und Seiten passend', () => {
  const s = new Score(['Tom', 'Gerry'], { startGames: [3, 3] });
  eq(s.view().games, [3, 3]);
  eq(s.server, T, 'nach 6 Spielen wieder Tom');
  // Wechsel nach 1,3,5 -> 3 Wechsel -> Tom auf -1
  eq(s.sideOf(T), -1);
  const s2 = new Score(['Tom', 'Gerry'], { startGames: [6, 6] });
  ok(s2.isTiebreak);
  const s3 = new Score(['Tom', 'Gerry'], { startGames: [2, 3] });
  eq(s3.server, G);
  eq(s3.sideOf(T), -1);   // Wechsel nach 1,3,5 -> 3 Wechsel
});

test('firstServer 1, startSides', () => {
  const s = new Score(['Tom', 'Gerry'], { firstServer: 1, startSides: [-1, 1] });
  eq(s.server, G); eq(s.sides, [-1, 1]); eq(s.serverSide, 1);
});

// ------------------------------------------------------------------ Flags & Banner
test('Breakbälle zählen, Banner deutsch', () => {
  const s = new Score(['Tom', 'Gerry']);
  let ev = play(s, 'GG'); ok(!ev.some((e) => e.type === 'pressure'));
  ev = play(s, 'G');
  const p = ev.find((e) => e.type === 'pressure');
  eq(p.kind, 'break_point'); eq(p.player, G); eq(p.count, 3);
  eq(p.de.title, 'Drei Breakbälle');
  eq(s.view().breakPoint, G); eq(s.view().pressure, { kind: 'break_point', player: G, count: 3 });
  play(s, 'T'); eq(s.view().pressure.count, 2);
  ev = play(s, 'T'); eq(ev.find((e) => e.type === 'pressure').de.title, 'Breakball');
  ev = play(s, 'T'); eq(ev.find((e) => e.type === 'point').de.title, 'Einstand');
  ev = play(s, 'T'); eq(ev.find((e) => e.type === 'point').de.title, 'Vorteil Tom');
  eq(s.view().gamePoint, T); eq(s.view().breakPoint, null);
  ev = play(s, 'T');
  const g = ev.find((e) => e.type === 'game');
  eq(g.de.title, 'Spiel Tom'); eq(g.broken, false);
  ev = brk(s);
  const gb = ev.find((e) => e.type === 'game');
  eq(gb.broken, true); eq(gb.de.kind, 'break'); eq(gb.de.title, 'Spiel Tom');
});

test('Satzball / Matchball / Tiebreak-Banner', () => {
  const s = new Score(['Tom', 'Gerry'], { sets: 1 });
  for (let g = 0; g < 5; g++) winGame(s, T);
  const ev = play(s, 'TTT');
  const p = ev.find((e) => e.type === 'pressure');
  eq(p.kind, 'match_point'); eq(p.de.title, 'Drei Matchbälle'); eq(p.de.sub, 'Tom');
  const s2 = new Score(['Tom', 'Gerry'], { sets: 3 });
  for (let g = 0; g < 5; g++) winGame(s2, T);
  const ev2 = play(s2, 'TTTG');
  eq(s2.view().setPoint, T); eq(s2.view().pressure.count, 2);
  ok(ev2.some((e) => e.type === 'pressure' && e.de.title === 'Zwei Satzbälle'));
  const s3 = new Score();
  let ev3 = [];
  for (let g = 0; g < 12; g++) ev3 = hold(s3);
  eq(ev3.find((e) => e.type === 'tiebreak_start').de.title, 'Tiebreak');
  eq(ev3.find((e) => e.type === 'tiebreak_start').de.sub, '6:6');
  // Satz-Banner
  const ev4 = play(s3, 'GGGGGGG');
  eq(ev4.find((e) => e.type === 'set').de, { title: 'Satz Gerry', sub: '6:7 (0)', kind: 'set' });
});

test('Matchball auch als Breakball markiert (beide Flags)', () => {
  const t = new Score(['Tom', 'Gerry'], { sets: 1 });
  for (let g = 0; g < 10; g++) hold(t);      // 5:5, Tom schlägt auf (Spiel 11)
  brk(t);                                     // 5:6 Gerry
  eq(t.server, G);
  play(t, 'TTT');                             // Tom hat Breakbälle bei 0:40 (Gerry schlägt auf, 5:6)
  eq(t.view().breakPoint, T); eq(t.view().matchPoint, null);
  const u = new Score(['Tom', 'Gerry'], { sets: 1 });
  for (let g = 0; g < 9; g++) hold(u);        // 5:4 Tom, Gerry schlägt auf (Spiel 10)
  eq(u.server, G);
  play(u, 'TTT');
  eq(u.view().matchPoint, T); eq(u.view().breakPoint, T); eq(u.view().pressure.kind, 'match_point');
});

test('LABELS_DE und eventLabelDE', () => {
  eq(LABELS_DE.deuce, 'Einstand'); eq(LABELS_DE.breakPoint, 'Breakball'); eq(LABELS_DE.setPoint, 'Satzball');
  eq(LABELS_DE.matchPoint, 'Matchball'); eq(LABELS_DE.tiebreak, 'Tiebreak');
  eq(eventLabelDE({ type: 'fault', n: 1 }).title, 'Fehler');
  eq(eventLabelDE({ type: 'double_fault', player: 1 }).sub, 'Gerry');
  eq(eventLabelDE({ type: 'point', reason: 'ace', winner: 0 }).title, 'Ass!');
  eq(numberWord(7), 'Seven'); eq(numberWord(12), 'Twelve'); eq(numberWord(21), 'Twenty-One');
});

test('gamesCall', () => {
  const s = new Score(['Tom', 'Gerry']);
  hold(s); eq(s.gamesCall(), 'Tom leads one game to zero');
  hold(s); eq(s.gamesCall(), 'One game all');
  winGame(s, G); eq(s.gamesCall(), 'Gerry leads two games to one');
});

// ------------------------------------------------------------------ Statistik
test('Statistik: Asse, Doppelfehler, Aufschlagquote, Breakbälle, Tempo, Ballwechsel', () => {
  const s = new Score(['Tom', 'Gerry']);
  s.pointWon(T, { reason: 'ace', serve: 1, serveKmh: 201 });
  s.pointWon(G, { reason: 'double_fault', faultKmh: 188 });
  s.pointWon(T, { reason: 'winner', serve: 2, rally: 7, serveKmh: 150 });
  s.pointWon(G, { reason: 'unforced_error', serve: 1, rally: 12, serveKmh: 190 });
  s.pointWon(G, { reason: 'forced_error', serve: 1, rally: 3, serveKmh: 185 });   // 30:40 Breakball danach
  s.pointWon(G, { reason: 'winner', serve: 1, rally: 4, serveKmh: 192 });          // Breakball genutzt
  const [t, g] = s.stats.players;
  eq(t.aces, 1); eq(t.doubleFaults, 1); eq(t.winners, 1); eq(g.winners, 1);
  eq(t.firstServes, 6); eq(t.firstServesIn, 4);
  eq(t.secondServePoints, 2); eq(t.secondServePointsWon, 1);
  eq(t.firstServePoints, 4); eq(t.firstServePointsWon, 1);
  eq(t.unforcedErrors, 1); eq(g.unforcedErrors, 0);
  eq(t.forcedErrors, 1);
  eq(t.fastestServeKmh, 201);
  eq(g.breakPointsTotal, 1); eq(g.breakPointsWon, 1); eq(t.breakPointsFaced, 1);
  eq(s.stats.longestRally, 12);
  eq(t.pointsWon + g.pointsWon, 6); eq(g.pointsWon, 4);
  eq(g.gamesWon, 1);
  const rows = s.stats.summaryDE();
  ok(rows.find((r) => r.label === 'Asse').values[0] === '1');
  ok(rows.find((r) => r.label === 'Breakbälle genutzt').values[1] === '1/1');
});

test('MatchStats separat nutzbar', () => {
  const m = new MatchStats();
  m.record(0, 0, { reason: 'ace', serveKmh: 210 }, null);
  eq(m.players[0].aces, 1); eq(m.players[0].fastestServeKmh, 210);
});

// ------------------------------------------------------------------ view(), undo, force
test('view(): Felder, Cache, Satzhistorie', () => {
  const s = new Score(['Tom', 'Gerry']);
  const v0 = s.view(); ok(v0 === s.view(), 'Cache liefert dasselbe Objekt');
  s.pointWon(T);
  const v1 = s.view(); ok(v1 !== v0, 'neues Objekt nach Punkt');
  eq(v1.names, ['Tom', 'Gerry']); eq(v1.points, [1, 0]); eq(v1.pointsText, ['15', '0']);
  eq(v1.server, T); eq(v1.serveBox, 'ad'); eq(v1.serverSide, 1); eq(v1.call, 'Fifteen–Love');
  for (const k of ['sets', 'setsWon', 'games', 'tiebreak', 'deuce', 'advantage', 'breakPoint', 'setPoint', 'matchPoint', 'flags', 'over', 'winner', 'scoreDE', 'format'])
    ok(k in v1, 'Feld ' + k);
});

test('undo / force / snapshot', () => {
  const s = new Score();
  play(s, 'TTT'); s.undo(); eq(s.view().points, [2, 0]);
  s.force({ sets: [[6, 4]], games: [5, 5], points: [3, 2], server: 1 });
  eq(s.view().setsWon, [1, 0]); eq(s.view().games, [5, 5]); eq(s.server, 1); eq(s.view().gamePoint, 0);
  const snap = s.snapshot(); play(s, 'G'); s.restore(snap); eq(s.view().points, [3, 2]);
});

// ------------------------------------------------------------------ Zufalls-Matches gegen ein unabhängiges Referenzmodell
/** Bewusst anders formuliertes Referenzmodell: Aufschlag wechselt jedes Spiel (Tiebreak zählt als ein Spiel). */
class Oracle {
  constructor(F) {
    this.F = normalizeFormat(F);
    this.gameNo = 0;              // laufende Spielnummer im Match (inkl. Tiebreaks)
    this.sets = [0, 0]; this.g = [0, 0]; this.p = [0, 0];
    this.end = this.F.startSides[0];   // Seite von Spieler 0
    this.tb = false; this.mtb = false; this.over = false;
    if (this.F.sets === 1 && this.F.finalSet === 'match_tiebreak') { this.tb = true; this.mtb = true; }
  }
  gameServer() { return (this.F.firstServer + this.gameNo) % 2; }
  server() {
    if (!this.tb) return this.gameServer();
    const n = this.p[0] + this.p[1];
    return ((n + 1) >> 1) % 2 === 0 ? this.gameServer() : 1 - this.gameServer();
  }
  box() { return (this.p[0] + this.p[1]) % 2 ? 'ad' : 'deuce'; }
  point(w) {
    const F = this.F, o = 1 - w;
    this.p[w]++;
    if (this.tb) {
      const to = this.mtb ? F.matchTiebreakTo : F.tiebreakTo;
      if (this.p[w] >= to && this.p[w] - this.p[o] >= 2) return this.game(w);
      if ((this.p[0] + this.p[1]) % 6 === 0) this.end = -this.end;
      return;
    }
    if ((this.p[w] >= 4 && this.p[w] - this.p[o] >= 2) || (F.noAd && this.p[w] === 4)) this.game(w);
  }
  game(w) {
    const F = this.F;
    this.p = [0, 0]; this.g[w]++; this.gameNo++;
    const total = this.g[0] + this.g[1];
    const setOver = this.tb || (this.g[w] >= F.games && this.g[w] - this.g[1 - w] >= 2);
    if (total % 2 === 1) this.end = -this.end;     // ungerade Spielsumme im Satz (gilt auch am Satzende)
    if (setOver) {
      this.sets[w]++; this.g = [0, 0]; this.tb = false; this.mtb = false;
      if (this.sets[w] === F.setsToWin) { this.over = true; return; }
      const deciding = this.sets[0] + this.sets[1] === F.sets - 1;
      if (deciding && F.finalSet === 'match_tiebreak') { this.tb = true; this.mtb = true; }
      return;
    }
    const deciding = this.sets[0] + this.sets[1] === F.sets - 1;
    if (F.tiebreakAt != null && !(deciding && F.finalSet === 'advantage') && this.g[0] === F.tiebreakAt && this.g[1] === F.tiebreakAt) this.tb = true;
  }
}

test('500 Zufallsmatches: Aufschläger, Feld, Seiten, Stand gegen Referenzmodell', () => {
  const rng = makeRng(20261007);
  const formats = [
    { sets: 3 }, { sets: 1 }, { sets: 3, games: 4 }, { sets: 3, finalSet: 'match_tiebreak' }, { sets: 1, finalSet: 'advantage' },
    { sets: 5 }, { sets: 3, noAd: true }, { sets: 1, superTiebreakOnly: true }, { sets: 3, firstServer: 1, startSides: [-1, 1] },
    { sets: 3, tiebreakTo: 10 },
  ];
  let points = 0;
  for (let m = 0; m < 500; m++) {
    const F = formats[m % formats.length];
    const s = new Score(['A', 'B'], F), o = new Oracle(F);
    const bias = 0.35 + rng() * 0.3;
    let guard = 0;
    while (!s.over && guard++ < 5000) {
      if (s.server !== o.server()) throw new Error(`Match ${m} Punkt ${guard}: Aufschläger ${s.server} != ${o.server()} (${JSON.stringify(F)})`);
      if (s.serveBox !== o.box()) throw new Error(`Match ${m}: Feld ${s.serveBox} != ${o.box()}`);
      if (s.sideOf(0) !== o.end) throw new Error(`Match ${m} Punkt ${guard}: Seite ${s.sideOf(0)} != ${o.end} (${JSON.stringify(F)})`);
      // Aufschläger gewinnt mit Wahrscheinlichkeit ~ 0.6
      const w = rng() < 0.6 ? s.server : 1 - s.server;
      const ww = rng() < bias ? w : (rng() < 0.5 ? 0 : 1);
      s.pointWon(ww); o.point(ww); points++;
      const v = s.view();
      if (!s.over && (v.games[0] !== o.g[0] || v.games[1] !== o.g[1])) throw new Error(`Match ${m}: Spiele ${v.games} != ${o.g}`);
    }
    ok(s.over && o.over, `Match ${m} beendet`);
    eq(s.view().setsWon, o.sets, `Match ${m} Sätze`);
    eq(s.view().setsWon[s.winner], normalizeFormat(F).setsToWin);
  }
  ok(points > 50000, 'genug Punkte simuliert: ' + points);
});

// ------------------------------------------------------------------ Zusammenfassung
for (const f of failures) console.log(f);
console.log(`\nrules.test: ${passed} bestanden, ${failed} fehlgeschlagen`);
process.exit(failed ? 1 : 0);

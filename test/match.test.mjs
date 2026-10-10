// GAMEPLAY-Tests: viele KI-gegen-KI-Matches headless (Statistik + Robustheit) und Skript-Tests
// (perfekte Vorhand landet am Ziel, später Druck = schwächer, Aufschlagfehler/Netz/Doppelfehler,
// Seitenwechsel, Tiebreak).  Aufruf: node test/match.test.mjs [--quick] [--matches N] [--full] [--only stats|script]
import { Match, MATCH_DT, makeInput } from '../src/game/match.js';
import { Ball, BALL, predict, Trajectory } from '../src/sim/ball.js';
import { solveShot } from '../src/sim/shot.js';
import { COURT, inServiceBox } from '../src/sim/court.js';
import { STROKES, CHARGE } from '../src/sim/strokes.js';
import { strokeKey } from '../src/game/player.js';
import { rotateVel } from '../src/game/player.js';

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const FULL = args.includes('--full');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const NM = args.includes('--matches') ? +args[args.indexOf('--matches') + 1] : (QUICK ? 3 : 8);

let failures = 0, passes = 0;
const ok = (cond, msg) => { if (cond) passes++; else { failures++; console.log('  FAIL: ' + msg); } };
const pct = (a, b) => (b > 0 ? (100 * a / b).toFixed(1) + '%' : '–');
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const f1 = (x) => x.toFixed(1), f2 = (x) => x.toFixed(2);

// ============================================================== Statistik: KI gegen KI
const PHASE_LIMIT = { pre_serve: 7, serve: 12, rally: 1e9, point_over: 2.5, between_points: 2.5, change_ends: 5 };

function simulateMatch(diffs, seed, format) {
  const m = new Match({ humans: [], difficulty: diffs, seed, format });
  const st = {
    points: 0, rally: [], reasons: {}, serve1: 0, serve1In: 0, serve2: 0, serve2In: 0, aces: 0, dfs: 0,
    kmh1: [], kmh2: [], rallyKmh: [], quality: {}, shots: {}, families: {}, volleys: 0, netPoints: 0, pointDur: [],
    lets: 0, closeCalls: 0, misses: 0, hits: 0, maxPhase: {}, stuck: [], winner: null, games: 0, changeEnds: 0, tiebreaks: 0,
    nonFinite: 0, splitSteps: 0, emotes: 0, serveQuality: {},
  };
  let phase = m.state.phase, phaseStart = 0, serveHitT = -1;
  const maxT = 60 * 60 * (format.sets === 1 ? 1.5 : 4);
  const t0 = performance.now();
  while (!m.state.over && m.time < maxT) {
    m.step(1 / 60);
    if (m.state.phase !== phase) {
      const d = m.time - phaseStart;
      st.maxPhase[phase] = Math.max(st.maxPhase[phase] || 0, d);
      phase = m.state.phase; phaseStart = m.time;
    } else if (m.time - phaseStart > (PHASE_LIMIT[phase] || 1e9) && !st.stuck.includes(phase)) st.stuck.push(phase);
    if (phase === 'rally' && m.time - Math.max(m.state.lastHitTime, phaseStart) > 10 && !st.stuck.includes('rally')) st.stuck.push('rally');
    for (const e of m.drainEvents()) {
      switch (e.type) {
        case 'hit':
          if (e.serve) {
            serveHitT = m.time;
            if (e.serveNo === 1) { st.serve1++; } else st.serve2++;
            st.serveQuality[e.quality] = (st.serveQuality[e.quality] || 0) + 1;
          } else {
            st.hits++;
            st.quality[e.quality] = (st.quality[e.quality] || 0) + 1;
            st.shots[e.shot] = (st.shots[e.shot] || 0) + 1;
            st.families[e.family] = (st.families[e.family] || 0) + 1;
            if (e.family === 'volley' || e.family === 'smash') st.volleys++;
            st.rallyKmh.push(e.kmh);
          }
          if (!Number.isFinite(e.speed) || !e.pos.every(Number.isFinite)) st.nonFinite++;
          break;
        case 'serve_speed': (e.serveNo === 1 ? st.kmh1 : st.kmh2).push(e.kmh); break;
        case 'fault': break;
        case 'let': st.lets++; if (e.serveNo === 1) st.serve1--; else st.serve2--; break;
        case 'miss': st.misses++; break;
        case 'split_step': st.splitSteps++; break;
        case 'emote': st.emotes++; break;
        case 'change_ends': st.changeEnds++; break;
        case 'tiebreak_start': st.tiebreaks++; break;
        case 'game': st.games++; break;
        case 'point':
          st.points++;
          st.rally.push(e.rally);
          st.reasons[e.reason] = (st.reasons[e.reason] || 0) + 1;
          if (e.reason === 'ace') st.aces++;
          if (e.reason === 'double_fault') st.dfs++;
          if (e.atNet[0] || e.atNet[1]) st.netPoints++;
          if (e.closeCall) st.closeCalls++;
          if (serveHitT >= 0) st.pointDur.push(m.time - serveHitT);
          serveHitT = -1;
          if (!Number.isFinite(e.winner)) st.nonFinite++;
          break;
        default: break;
      }
    }
  }
  // Aufschlag-Quote: 1. Aufschläge, die nicht zum 2. führten
  const s = m.score.stats;
  st.firstIn = s.players[0].firstServesIn + s.players[1].firstServesIn;
  st.firstTotal = s.players[0].firstServes + s.players[1].firstServes;
  st.secondIn = s.players[0].secondServesIn + s.players[1].secondServesIn;
  st.secondTotal = s.players[0].secondServes + s.players[1].secondServes;
  st.winner = m.score.winner;
  st.over = m.state.over;
  st.simTime = m.time;
  st.wallMs = performance.now() - t0;
  st.view = m.score.view();
  st.statsSummary = s;
  return st;
}

function validScore(v, format) {
  if (!v.over) return false;
  const need = Math.floor((format.sets || 3) / 2) + 1;
  if (Math.max(v.setsWon[0], v.setsWon[1]) !== need) return false;
  for (const set of v.sets) {
    const [a, b] = set.games, hi = Math.max(a, b), lo = Math.min(a, b);
    if (set.matchTiebreak) continue;
    if (!((hi === 6 && lo <= 4) || (hi === 7 && (lo === 5 || lo === 6)))) return false;
  }
  return true;
}

function statsSection() {
  console.log('\n=== KI gegen KI: Statistik ===');
  const format = FULL ? { sets: 3 } : { sets: 1 };
  const combos = QUICK ? [['normal', 'normal'], ['hard', 'easy']] : [['normal', 'normal'], ['hard', 'hard'], ['easy', 'easy'], ['hard', 'easy'], ['normal', 'hard']];
  for (const diffs of combos) {
    const all = [];
    for (let k = 0; k < NM; k++) all.push(simulateMatch(diffs, 1000 + k * 37 + diffs.join('').length, format));
    const sum = (f) => all.reduce((a, s) => a + f(s), 0);
    const P = sum((s) => s.points);
    const rally = all.flatMap((s) => s.rally);
    const reasons = {};
    for (const s of all) for (const [k, v] of Object.entries(s.reasons)) reasons[k] = (reasons[k] || 0) + v;
    const quality = {}, shots = {}, fam = {};
    for (const s of all) {
      for (const [k, v] of Object.entries(s.quality)) quality[k] = (quality[k] || 0) + v;
      for (const [k, v] of Object.entries(s.shots)) shots[k] = (shots[k] || 0) + v;
      for (const [k, v] of Object.entries(s.families)) fam[k] = (fam[k] || 0) + v;
    }
    const hits = sum((s) => s.hits);
    const winners = (reasons.winner || 0) + (reasons.double_bounce || 0) + (reasons.ace || 0) + (reasons.service_winner || 0);
    const errors = (reasons.net || 0) + (reasons.out || 0) + (reasons.unforced_error || 0) + (reasons.forced_error || 0) + (reasons.double_fault || 0);
    const wins0 = all.filter((s) => s.winner === 0).length;
    console.log(`\n-- ${diffs[0]} (P0) vs ${diffs[1]} (P1): ${NM} Matches ${FULL ? 'Best-of-3' : '1 Satz'}, ${P} Punkte, Siege P0 ${wins0}/${NM}`);
    console.log(`   Ballwechsel Ø ${f2(avg(rally))} Schläge (Median ${rally.slice().sort((a, b) => a - b)[rally.length >> 1]}, max ${Math.max(...rally)})  Punktdauer Ø ${f1(avg(all.flatMap((s) => s.pointDur)))} s`);
    console.log(`   Asse ${pct(sum((s) => s.aces), P)}  Doppelfehler ${pct(sum((s) => s.dfs), P)}  1. Aufschlag ${pct(sum((s) => s.firstIn), sum((s) => s.firstTotal))}  2. Aufschlag ${pct(sum((s) => s.secondIn), sum((s) => s.secondTotal))}  Netz-Wdh. ${sum((s) => s.lets)}`);
    console.log(`   Aufschlag Ø 1. ${f1(avg(all.flatMap((s) => s.kmh1)))} km/h (max ${Math.max(...all.flatMap((s) => s.kmh1))})  2. ${f1(avg(all.flatMap((s) => s.kmh2)))} km/h   Rally-Tempo Ø ${f1(avg(all.flatMap((s) => s.rallyKmh)))} km/h`);
    console.log(`   Winner/Fehler ${winners}/${errors} = ${f2(winners / Math.max(1, errors))}   Netzpunkte ${pct(sum((s) => s.netPoints), P)}  Volleys/Smash ${pct(sum((s) => s.volleys), hits)} der Schläge  Close Calls ${sum((s) => s.closeCalls)}  Luftlöcher ${sum((s) => s.misses)}`);
    console.log('   Punktende: ' + Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v, P)}`).join(', '));
    console.log('   Qualität: ' + Object.entries(quality).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v, hits)}`).join(', '));
    console.log('   Schläge: ' + Object.entries(shots).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v, hits)}`).join(', ') + '  | ' + Object.entries(fam).map(([k, v]) => `${k} ${pct(v, hits)}`).join(', '));
    console.log(`   Zeit pro Match: ${f1(avg(all.map((s) => s.wallMs)))} ms Rechenzeit, ${f1(avg(all.map((s) => s.simTime)) / 60)} min Spielzeit; Seitenwechsel Ø ${f1(avg(all.map((s) => s.changeEnds)))}, Tiebreaks ${sum((s) => s.tiebreaks)}`);
    // Zusicherungen
    for (const s of all) {
      ok(s.over, `${diffs}: Match endet (Spielzeit ${f1(s.simTime)} s)`);
      ok(validScore(s.view, format), `${diffs}: gültiger Endstand ${JSON.stringify(s.view.sets.map((x) => x.games))}`);
      ok(s.stuck.length === 0, `${diffs}: keine hängenden Phasen (${s.stuck.join(',')}) max ${JSON.stringify(s.maxPhase)}`);
      ok(s.nonFinite === 0, `${diffs}: keine NaN in Ereignissen`);
      ok(s.points === s.statsSummary.pointsPlayed, `${diffs}: alle Punkte verbucht`);
    }
    if (diffs[0] === 'normal' && diffs[1] === 'normal') {
      const ar = avg(rally);
      // Prototyp 3: ohne Zufalls-Netzfehler und Gauß-Streuung werden Ballwechsel länger; Feinabstimmung in Teil B
      ok(ar >= 3.5 && ar <= 14, `normal: Ø Ballwechsel 3.5..14 (ist ${f2(ar)})`);
      ok(sum((s) => s.dfs) / P < 0.08, 'normal: Doppelfehler < 8 %');
      ok(sum((s) => s.aces) / P < 0.2, 'normal: Asse < 20 %');
    }
    if (diffs[0] === 'hard' && diffs[1] === 'easy') ok(wins0 >= Math.ceil(NM * 0.6), `hard schlägt easy meistens (${wins0}/${NM})`);
  }
}

// ============================================================== Skript-Tests
function setupRally(seed, opts = {}) {
  // beide Slots menschlich: der Gegner (Slot 1, neutrale Eingabe) spielt nicht zurück
  const m = new Match({ humans: [0, 1], difficulty: opts.difficulty || 'normal', seed, format: { sets: 1 } });
  // Spieler 0 (Mensch) auf Seite +1, Gegner auf -1
  const P0 = m.players[0], P1 = m.players[1];
  m.step(MATCH_DT);
  P0.side = 1; P1.side = -1;
  P0.pos[0] = opts.p0x ?? 0.4; P0.pos[2] = 12.2; P0.vel[0] = P0.vel[2] = 0;
  P1.pos[0] = 0; P1.pos[2] = -12.2;
  const from = [opts.fromX ?? -0.5, 1.0, -11.8];
  const sol = solveShot({ from, target: { x: opts.tx ?? 1.6, z: opts.tz ?? 8.9 }, spin: 'topspin', power: 0.55 });
  m.debugLaunch(1, from, sol.vel, sol.spin);
  m.drainEvents();
  return m;
}

/** Skript-Spieler: läuft zum Abfangpunkt, drückt pressLead s vor dem Kontakt (bzw. pressAt nach Abflug). */
function playHumanShot(m, { pressAt = 0.12, pressBeforeContact = null, shot = 'topspin', aim = [0, 0], perfectMove = true }) {
  const inp = makeInput();
  const P0 = m.players[0];
  let hit = null, bounce = null, hitPlan = null;
  const launchT = m.time;
  for (let i = 0; i < 120 * 4 && !bounce; i++) {
    inp.move[0] = inp.move[1] = 0;
    inp.buttons[shot] = false;
    inp.aim[0] = aim[0]; inp.aim[1] = aim[1];
    const plan = P0.plan;
    if (perfectMove && plan && plan.valid && !P0.stroke) {
      const dx = plan.pos[0] - P0.pos[0], dz = plan.pos[2] - P0.pos[2], d = Math.hypot(dx, dz);
      if (d > 0.03) { const f = Math.min(1, d / 0.5); inp.move[0] = (dx / d) * f; inp.move[1] = (dz / d) * f; }
    }
    if (!P0.pending && !hit) {
      if (pressBeforeContact != null) { if (plan && plan.valid && plan.time - m.time <= pressBeforeContact) inp.buttons[shot] = true; }
      else if (m.time - launchT >= pressAt) inp.buttons[shot] = true;
    }
    m.step(MATCH_DT, [inp, null]);
    for (const e of m.drainEvents()) {
      if (e.type === 'hit' && e.player === 0) { hit = e; hitPlan = P0.plan; }
      if (e.type === 'bounce' && hit && e.index === 1 && !bounce) bounce = e;
      if (e.type === 'point' && !hit) return { hit: null, bounce: null, point: e };
    }
  }
  return { hit, bounce };
}

function scriptSection() {
  console.log('\n=== Skript-Tests ===');
  // --- 1. Perfekt getimte Vorhand landet am Ziel
  {
    const errs = [], quals = {}, speeds = [];
    let inCount = 0;
    for (let k = 0; k < 8; k++) {
      const m = setupRally(50 + k);
      const r = playHumanShot(m, { pressAt: 0.1, aim: [-1, 0.6] });
      ok(!!r.hit, `perfekte Vorhand #${k}: Treffer erfolgt`);
      if (!r.hit || !r.bounce) continue;
      quals[r.hit.quality] = (quals[r.hit.quality] || 0) + 1;
      errs.push(Math.hypot(r.bounce.pos[0] - r.hit.target.x, r.bounce.pos[2] - r.hit.target.z));
      if (process.env.TG_DEBUG) console.log('   ziel', r.hit.target.x.toFixed(2), r.hit.target.z.toFixed(2), 'aufsprung', r.bounce.pos[0].toFixed(2), r.bounce.pos[2].toFixed(2), 'von', r.hit.pos.map((v) => v.toFixed(2)).join(','), r.hit.kmh.toFixed(0), 'clr', r.hit.clearance && r.hit.clearance.toFixed(2));
      speeds.push(r.hit.speed);
      if (r.bounce.in) inCount++;
    }
    const me = avg(errs);
    console.log(`  perfekte Vorhand: Qualität ${JSON.stringify(quals)}, Ø Abweichung vom Ziel ${f2(me)} m, drin ${inCount}/${errs.length}, Ø ${f1(avg(speeds) * 3.6)} km/h`);
    ok(me < 1.3, `perfekte Vorhand landet nahe am Ziel (Ø ${f2(me)} m)`);
    ok(inCount >= errs.length - 1, 'perfekte Vorhand: fast immer im Feld');
    ok((quals.perfect || 0) + (quals.good || 0) >= errs.length - 1, 'perfekte Vorhand: Qualität perfect/good');
    // Ziel ist links aus Sicht von Spieler 0 (Seite +1, Blick -Z): links = -X
    ok(errs.length > 0, 'Treffer vorhanden');
  }
  // --- 2. Später Druck = gehetzter, schwächerer Schlag
  {
    const sLate = [], sGood = [], qLate = {};
    for (let k = 0; k < 6; k++) {
      const a = playHumanShot(setupRally(80 + k), { pressAt: 0.1, aim: [0, 0] });
      const b = playHumanShot(setupRally(80 + k), { pressBeforeContact: STROKES.forehand.windup * 0.45, aim: [0, 0] });
      if (a.hit) sGood.push(a.hit.speed);
      if (b.hit) { sLate.push(b.hit.speed); qLate[b.hit.quality] = (qLate[b.hit.quality] || 0) + 1; }
    }
    console.log(`  später Druck: Qualität ${JSON.stringify(qLate)}, Tempo ${f1(avg(sLate) * 3.6)} km/h vs. früh ${f1(avg(sGood) * 3.6)} km/h`);
    ok(sLate.length >= 4, 'später Druck: Schlag findet noch statt');
    ok((qLate.late || 0) + (qLate.frame || 0) >= sLate.length - 1, 'später Druck: Qualität late');
    ok(avg(sLate) < avg(sGood) * 0.92, 'später Druck: deutlich langsamer');
  }
  // --- 3. Kein Druck: kein Schwung, Ball geht durch -> Punkt für Gegner (Winner)
  {
    const m = setupRally(7);
    const inp = makeInput();
    let point = null;
    for (let i = 0; i < 120 * 6 && !point; i++) { m.step(MATCH_DT, [inp, null]); for (const e of m.drainEvents()) if (e.type === 'point') point = e; }
    ok(point && point.winner === 1 && (point.reason === 'winner' || point.reason === 'double_bounce'), `ohne Druck: Punkt für Gegner als Winner (${point && point.reason})`);
  }
  // --- 4. Aufschlag: Fehler, zweiter Aufschlag, Doppelfehler
  {
    const m = new Match({ humans: [0, 1], seed: 3, format: { sets: 1, firstServer: 0 } });
    runUntil(m, () => m.state.phase === 'serve');
    const srv = m.players[m.state.server];
    const s = srv.side;
    ok(m.state.server === 0, 'Aufschläger ist Spieler 0');
    const from = [0.6, 2.7, s * 11.6];
    const long = solveShot({ from, target: { x: -1.5, z: -s * 7.4 }, spin: 'serve_flat', power: 0.8 });
    m.debugLaunch(0, from, long.vel, long.spin, { serve: true });
    let ev = runUntilEvents(m, (e) => e.type === 'fault', 3);
    const f1e = ev.find((e) => e.type === 'fault');
    ok(f1e && f1e.n === 1, 'langer Aufschlag = Fehler (1)');
    ok(ev.some((e) => e.type === 'line_call' && e.call === 'fault'), 'Linienrichter ruft "Fault"');
    runUntil(m, () => m.state.phase === 'serve' && m.srv.state === 'ready', 4);
    ok(m.state.serveNo === 2, 'zweiter Aufschlag');
    m.debugLaunch(0, from, long.vel, long.spin, { serve: true });
    ev = runUntilEvents(m, (e) => e.type === 'point', 4);
    ok(ev.some((e) => e.type === 'double_fault'), 'Doppelfehler-Ereignis');
    const pt = ev.find((e) => e.type === 'point');
    ok(pt && pt.reason === 'double_fault' && pt.winner === 1, `Doppelfehler: Punkt für Rückschläger (${pt && pt.reason})`);
    // Netz (Let): Ball berührt das Netzband und landet im Feld
    const m2 = new Match({ humans: [0, 1], seed: 4, format: { sets: 1, firstServer: 0 } });
    runUntil(m2, () => m2.state.phase === 'serve');
    const s2 = m2.players[0].side;
    const box = m2.state.serveBox;
    let letShot = null;
    const b = new Ball(), tr = new Trajectory(800);
    // Aufschlag leicht nach unten drehen, bis er das Netzband streift und trotzdem im Feld landet
    for (const tz of [5.2, 5.8, 4.6]) {
      const sol = solveShot({ from, target: { x: s2 * -1.2, z: -s2 * tz }, spin: 'serve_flat', power: 0.5 });
      for (let dth = 0; dth > -0.08 && !letShot; dth -= 0.0004) {
        const v = Float64Array.from(sol.vel); rotateVel(v, dth, 0);
        b.launch(from, v, sol.spin);
        predict(b, 3, BALL.dt, { out: tr, maxBounces: 1 });
        const bb = tr.bounce(0);
        if (tr.netCord && bb && inServiceBox(bb.pos[0], bb.pos[2], s2, box)) letShot = { vel: v, spin: Float64Array.from(sol.spin) };
      }
      if (letShot) break;
    }
    ok(!!letShot, 'Netzband-Aufschlag gefunden');
    if (letShot) {
      m2.debugLaunch(0, from, letShot.vel, letShot.spin, { serve: true });
      const ev2 = runUntilEvents(m2, (e) => e.type === 'let' || e.type === 'fault' || e.type === 'point', 4);
      ok(ev2.some((e) => e.type === 'let'), 'Netzberührung + im Feld = Let');
      runUntil(m2, () => m2.srv.state === 'ready', 4);
      ok(m2.state.serveNo === 1, 'Let: Aufschlag wird wiederholt (weiterhin 1.)');
    }
  }
  // --- 5. Seitenwechsel nach dem ersten Spiel
  {
    const m = new Match({ humans: [], seed: 11, format: { sets: 1 } });
    const sides0 = m.players.map((p) => p.side);
    const ev = runUntilEvents(m, (e) => e.type === 'change_ends', 600);
    const games = ev.filter((e) => e.type === 'game').length;
    ok(ev.some((e) => e.type === 'change_ends') && games === 1, `Seitenwechsel nach Spiel 1 (Spiele ${games})`);
    runUntil(m, () => m.state.phase === 'pre_serve', 10);
    ok(m.players[0].side === -sides0[0] && m.players[1].side === -sides0[1], 'Spieler haben die Seiten getauscht');
    ok(m.players.every((p) => p.pos[2] * p.side > 0), 'Spieler stehen auf ihrer neuen Hälfte');
  }
  // --- 6. Tiebreak
  {
    const m = new Match({ humans: [], seed: 21, format: { sets: 1 } });
    m.forceScore({ games: [6, 6], server: 0 });
    ok(m.score.isTiebreak, 'Tiebreak aktiv bei 6:6');
    const servers = [];
    let changes = 0, setEv = null, pointsSeen = 0, changeAt = [];
    let lastServer = null;
    for (let i = 0; i < 120 * 60 * 30 && !setEv; i++) {
      m.step(1 / 60);
      for (const e of m.drainEvents()) {
        if (e.type === 'serve_toss' && e.player !== lastServer) { lastServer = e.player; }
        if (e.type === 'hit' && e.serve && (servers.length === pointsSeen)) servers.push(e.player);
        if (e.type === 'point') pointsSeen++;
        if (e.type === 'change_ends') { changes++; changeAt.push(pointsSeen); }
        if (e.type === 'set') setEv = e;
      }
    }
    ok(!!setEv, 'Tiebreak endet mit Satzgewinn');
    if (setEv) {
      const g = setEv.games;
      ok(Math.max(g[0], g[1]) === 7 && Math.min(g[0], g[1]) === 6, `Satz 7:6 (${g})`);
      const tb = setEv.tiebreak;
      ok(tb && Math.max(tb[0], tb[1]) >= 7 && Math.abs(tb[0] - tb[1]) >= 2, `Tiebreak-Punkte gültig (${tb})`);
    }
    // Aufschlagfolge: A, B, B, A, A, B, B …
    let seqOk = true;
    for (let i = 0; i < servers.length; i++) {
      const exp = Math.floor((i + 1) / 2) % 2 === 0 ? servers[0] : 1 - servers[0];
      if (servers[i] !== exp) seqOk = false;
    }
    ok(seqOk, `Tiebreak-Aufschlagfolge korrekt (${servers.join('')})`);
    const expectedChanges = changeAt.filter((n) => n % 6 === 0 || true);
    ok(changeAt.slice(0, -1).every((n) => n % 6 === 0), `Seitenwechsel im Tiebreak alle 6 Punkte (${changeAt})`);
    console.log(`  Tiebreak: ${pointsSeen} Punkte, Aufschläger ${servers.join('')}, Seitenwechsel nach ${changeAt.join(',')}`);
  }
  // --- 7. Determinismus
  {
    const run = () => { const m = new Match({ humans: [], seed: 99, format: { sets: 1, games: 2 } }); for (let i = 0; i < 120 * 90; i++) m.step(MATCH_DT); return JSON.stringify(m.score.view().games) + m.players[0].pos.map((v) => v.toFixed(6)).join(','); };
    ok(run() === run(), 'deterministisch bei gleichem Seed');
  }
  // --- 8. Mensch als Aufschläger: Ballwurf + Schlag mit Messanzeige
  {
    const m = new Match({ humans: [0], seed: 5, format: { sets: 1, firstServer: 0 } });
    runUntil(m, () => m.state.phase === 'serve' && m.srv.t > 0.5);
    const inp = makeInput();
    inp.buttons.topspin = true; m.step(MATCH_DT, [inp, null]); inp.buttons.topspin = false;
    ok(m.srv.state === 'toss', 'Mensch: erster Druck = Ballwurf');
    let meterMax = 0, hitEv = null, speedEv = null;
    for (let i = 0; i < 400 && !hitEv; i++) {
      const pressNow = m.srv.state === 'toss' && m.time >= m.srv.idealPress - 1e-9;
      inp.buttons.topspin = pressNow;
      m.step(MATCH_DT, [inp, null]);
      if (m.players[0].serveMeter != null) meterMax = Math.max(meterMax, m.players[0].serveMeter);
      for (const e of m.drainEvents()) { if (e.type === 'hit') hitEv = e; if (e.type === 'serve_speed') speedEv = e; }
    }
    ok(hitEv && hitEv.serve && (hitEv.quality === 'perfect' || hitEv.quality === 'good'), `Mensch: perfekter Aufschlag (${hitEv && hitEv.quality})`);
    ok(meterMax > 0.9, `Messanzeige erreicht ~1 (${f2(meterMax)})`);
    ok(speedEv && speedEv.kmh > 110 && speedEv.kmh < 165, `Aufschlagtempo im Arcade-Bereich 110..165 (${speedEv && speedEv.kmh} km/h)`);
  }
  // --- 9. Robustheit: zwei "Tastenhämmerer" (zufällige Eingaben, beide Slots menschlich)
  {
    let nonFinite = 0, points = 0, maxPhase = {}, threw = null;
    for (const seed of [11, 12, 13]) {
      const m = new Match({ humans: [0, 1], seed, format: { sets: 1, games: 3 } });
      const rnd = mulberry(seed * 31);
      const inps = [makeInput(), makeInput()];
      let last = m.state.phase, since = 0;
      try {
        for (let i = 0; i < 120 * 60 * 6 && !m.state.over; i++) {
          for (const inp of inps) {
            if (rnd() < 0.03) { const a = rnd() * 6.283; const r = rnd(); inp.move[0] = Math.cos(a) * r; inp.move[1] = Math.sin(a) * r; }
            if (rnd() < 0.05) { inp.aim[0] = rnd() * 2 - 1; inp.aim[1] = rnd() * 2 - 1; }
            for (const k of ['topspin', 'slice', 'lob', 'drop']) if (rnd() < 0.02) inp.buttons[k] = !inp.buttons[k];
            inp.skip = rnd() < 0.01;
          }
          m.step(MATCH_DT, inps);
          for (const e of m.drainEvents()) if (e.type === 'point') points++;
          for (const p of m.players) if (!Number.isFinite(p.pos[0] + p.pos[2] + p.vel[0] + p.vel[2] + p.yaw)) nonFinite++;
          if (!Number.isFinite(m.ball.pos[0] + m.ball.pos[1] + m.ball.pos[2])) nonFinite++;
          if (m.state.phase !== last) { maxPhase[last] = Math.max(maxPhase[last] || 0, since); last = m.state.phase; since = 0; } else since += MATCH_DT;
        }
      } catch (err) { threw = err; break; }
    }
    ok(!threw, `Zufallseingaben: keine Ausnahme ${threw ? threw.stack : ''}`);
    ok(nonFinite === 0, 'Zufallseingaben: Positionen endlich');
    ok(points > 30, `Zufallseingaben: Punkte werden gespielt (${points})`);
    ok((maxPhase.rally || 0) < 90 && (maxPhase.point_over || 0) < 2.5, `Zufallseingaben: Phasen enden (${JSON.stringify(maxPhase, (k, v) => (typeof v === 'number' ? +v.toFixed(1) : v))})`);
  }
  // --- 10. Menschlicher Skript-Spieler gegen jede KI-Stufe (Balance)
  {
    const res = {}, rally = {};
    for (const diff of ['easy', 'normal', 'hard']) {
      for (const style of ['lazy', 'good', 'robot']) {
        let won = 0, total = 0;
        const rl = [];
        const onEv = (e) => { if (e.type === 'point') rl.push(e.rally); };
        for (const seed of [21, 22]) { const r = humanBotMatch(diff, style, seed, 60, onEv); won += r.won; total += r.total; }
        res[diff + '/' + style] = won / Math.max(1, total);
        if (style === 'good') rally[diff] = avg(rl);
      }
    }
    console.log('  Mensch-Bot (Punktgewinn %): ' + Object.entries(res).map(([k, v]) => `${k} ${(100 * v).toFixed(0)}%`).join(', '));
    console.log('  Mensch-Bot "good": Ø Ballwechsel ' + Object.entries(rally).map(([k, v]) => `${k} ${f1(v)}`).join(', '));
    ok(res['easy/good'] > res['normal/good'] && res['normal/good'] > res['hard/good'], 'Balance: easy > normal > hard');
    ok(res['easy/good'] > 0.6, 'Balance: easy klar schlagbar');
    ok(res['normal/good'] > 0.4 && res['normal/good'] < 0.7, 'Balance: normal ausgeglichen');
    ok(res['hard/good'] > 0.15 && res['hard/good'] < 0.5, 'Balance: hard stark, aber schlagbar');
    ok(res['normal/lazy'] < res['normal/good'] - 0.1, 'Balance: Laufen lohnt sich');
  }
}

/** Deterministischer Zufall für Tests. */
function mulberry(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), s | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Skript-"Mensch" (Slot 0) gegen KI (Slot 1), Schlagkern Prototyp 3 (Balken lädt ab Druck, Laden bremst, Ausfallschritt,
 * Zielkreis sichtbar).
 *   'lazy'  : steht still, drückt nur (testet die Laufhilfe)
 *   'good'  : menschenähnlich – Reaktion 0.25–0.4 s, ungenauer Laufweg (σ ~0.4 m, wird beim Annähern kleiner), will meist
 *             viel Kraft, drückt, sobald der Platz auch gebremst erreichbar ist (10 % zu spät), zielt oft mit voller Richtung
 *             (digitale Tastatur), nimmt bei rotem Kreis meist (60 %) Richtung und Länge zurück; Aufschlag-Timing σ 0.05 s
 *   'robot' : kennt den idealen Treffpunkt, läuft perfekt, lädt voll, zielt nie über die Linie (Obergrenze)
 * opts.assist: Laufhilfe ('off'|'light'|'strong', Standard 'light').
 */
function humanBotMatch(diff, style, seed, nPoints, onEvent = null, opts = {}) {
  const m = new Match({ humans: [0], difficulty: diff, seed, format: { sets: 3 }, assist: opts.assist || 'light' });
  const rnd = mulberry(seed * 97 + 5);
  const g = () => rnd() + rnd() + rnd() - 1.5;   // ~N(0, 0.5)
  const inp = makeInput();
  const P0 = m.players[0];
  const robot = style === 'robot', moves = style !== 'lazy';
  let won = 0, total = 0, pressAt = null, aimLr = 0, aimD = 0.3, shotId = -1, offX = 0, offZ = 0, want = 0.8, late = false, react = 0.3, pulled = false;
  for (let i = 0; i < 120 * 60 * 40 && total < nPoints && !m.state.over; i++) {
    const S = m.state;
    inp.move[0] = inp.move[1] = 0;
    inp.buttons.topspin = false;
    inp.skip = false;
    if (S.phase === 'serve' && S.server === 0) {
      if (m.srv.state === 'ready' && m.srv.t > 0.6) inp.buttons.topspin = true;
      if (m.srv.state === 'toss') {
        if (pressAt == null) pressAt = m.srv.idealPress + g() * (robot ? 0.04 : 0.1);
        if (m.time >= pressAt) inp.buttons.topspin = true;
        inp.aim[0] = rnd() < 0.5 ? -1 : 1;
      }
    } else pressAt = null;
    if (S.phase === 'rally') {
      const incoming = m.rally.lastHitter === 1 && !m.rally.decided;
      const plan = P0.plan;
      if (incoming && m.rally.shotId !== shotId) {
        shotId = m.rally.shotId; pulled = false;
        if (robot) { aimLr = [-0.6, -0.3, 0, 0.3, 0.6][Math.floor(rnd() * 5)]; aimD = 0.2 * rnd(); offX = offZ = 0; want = 1; late = false; react = 0.2; }
        else {
          const r = rnd();
          aimLr = r < 0.45 ? 0 : r < 0.6 ? 0.7 * Math.sign(rnd() - 0.5) : Math.sign(rnd() - 0.5);
          aimD = rnd() < 0.5 ? 0 : 1;
          offX = g() * 0.8; offZ = g() * 0.8;
          want = rnd() < 0.15 ? 0.4 : 0.65 + 0.35 * rnd();
          late = rnd() < 0.1;
          react = 0.25 + 0.15 * rnd();
        }
      }
      const swingT = plan && plan.valid ? STROKES[strokeKey(plan.family, plan.hand, 'topspin')].swing : 0.2;
      const tl = plan && plan.valid ? plan.time - m.time : 9;
      if (moves && incoming && plan && plan.valid && !P0.stroke && m.time - S.lastHitTime > react) {
        const k = Math.min(1, Math.max(0, (tl - swingT) / 0.8));   // Fehler schrumpft beim Annähern
        const dx = plan.pos[0] + offX * k - P0.pos[0], dz = plan.pos[2] + offZ * k - P0.pos[2], d = Math.hypot(dx, dz);
        if (d > 0.04) { const f = Math.min(1, d / 0.5); inp.move[0] = (dx / d) * f; inp.move[1] = (dz / d) * f; }
      } else if (moves && !incoming && !P0.stroke) {
        const dx = -P0.pos[0] * 0.6, dz = P0.side * (COURT.halfLength + 0.8) - P0.pos[2], d = Math.hypot(dx, dz);
        if (d > 0.3) { inp.move[0] = (dx / d) * 0.7; inp.move[1] = (dz / d) * 0.7; }
      }
      // Laden: früh genug für die gewünschte Kraft, aber erst, wenn der Platz auch gebremst noch erreichbar ist
      if (incoming && plan && plan.valid && !P0.pending && m.time - S.lastHitTime > react) {
        const left = tl - swingT;
        const dist = moves ? Math.hypot(plan.pos[0] - P0.pos[0], plan.pos[2] - P0.pos[2]) : 0;
        const slowT = dist / (P0.stats.maxSpeed * CHARGE.moveMul) + 0.05;
        let press = left <= want * CHARGE.fill && slowT <= left;
        if (!moves) press = left <= 0.6;
        if (late) press = left <= swingT * 0.3;
        if (left <= 0.05) press = true;
        if (press) inp.buttons.topspin = true;
      }
      // Risiko sehen: roter Kreis -> meist zurücknehmen (Roboter zielt nie über die Linie)
      if (P0.preview.on && P0.preview.red && !pulled && !robot && style === 'good') {
        pulled = true;
        if (rnd() < 0.6) { aimLr *= 0.4; aimD = Math.min(aimD, 0); }
      }
      // Zielrichtung: digitale Tastatur – Bewegungsrichtung und Ziel teilen sich die Tasten
      inp.aim[0] = aimLr; inp.aim[1] = aimD;
    }
    if (S.phase === 'point_over' || S.phase === 'between_points') inp.skip = rnd() < 0.02;
    m.step(MATCH_DT, [inp, null]);
    for (const e of m.drainEvents()) { if (onEvent) onEvent(e); if (e.type === 'point') { total++; if (e.winner === 0) won++; } }
  }
  return { won, total };
}

function runUntil(m, cond, maxSec = 30) {
  for (let i = 0; i < maxSec * 120 && !cond(); i++) { m.step(MATCH_DT); m.drainEvents(); }
}
function runUntilEvents(m, stop, maxSec = 30) {
  const out = [];
  for (let i = 0; i < maxSec * 120; i++) {
    m.step(MATCH_DT);
    const ev = m.drainEvents();
    out.push(...ev);
    if (ev.some(stop)) break;
  }
  return out;
}

const t0 = performance.now();
if (!ONLY || ONLY === 'script') scriptSection();
if (!ONLY || ONLY === 'stats') statsSection();
console.log(`\n${passes} ok, ${failures} fehlgeschlagen (${f1((performance.now() - t0) / 1000)} s)`);
process.exit(failures ? 1 : 0);

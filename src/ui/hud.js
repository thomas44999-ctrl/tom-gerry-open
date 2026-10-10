// In-Game-HUD: Broadcast-Scorebug (oben links) mit Flaggen (Breakball/Satzball/Matchball),
// Aufschlag-Tempo, Powerbalken am Spieler (friert beim Treffer ein, zeigt km/h), Zielkreis auf dem Platz,
// Trefferblitz, Aufschlag-Timing-Meter und Timing-Feedback.
// Alle Per-Frame-Methoden (power, aimCircle, serveMeter) schreiben nur bei Änderung ins DOM.

import { h, esc, cssColor, animate } from './dom.js';
import { icon } from './icons.js';
import { emblemSVG } from './logo.js';

const PT_LABELS = ['0', '15', '30', '40'];
const DEFAULT_PLAYERS = [
  { name: 'Tom', color: '#8CCBF2', id: 'tom' },
  { name: 'Gerry', color: '#F08A2B', id: 'gerry' },
];

const TIMING_TEXT = {
  perfect: ['Perfekt!', 'perfect'],
  good: ['Gut', 'good'],
  early: ['Zu früh', 'bad'],
  late: ['Zu spät', 'bad'],
  stretch: ['Gestreckt', 'meh'],
  frame: ['Rahmen!', 'bad'],
  miss: ['Daneben!', 'bad'],
  rescue: ['Gerettet!', 'meh'],
};
const SVGNS = 'http://www.w3.org/2000/svg';

const FLAG_TEXT = { break: ['BREAKBALL', 'BREAKBÄLLE'], set: ['SATZBALL', 'SATZBÄLLE'], match: ['MATCHBALL', 'MATCHBÄLLE'] };

/** Punkte (Zahlen) -> Anzeige, inkl. Einstand/Vorteil. Tiebreak: rohe Zahlen. */
export function pointsText(a, b, tiebreak) {
  if (tiebreak) return [String(a), String(b)];
  if (a >= 3 && b >= 3) {
    if (a === b) return ['40', '40'];
    return a > b ? ['AD', '40'] : ['40', 'AD'];
  }
  return [PT_LABELS[Math.min(a, 3)], PT_LABELS[Math.min(b, 3)]];
}

const normPtStr = (s) => {
  const t = String(s).trim();
  if (/^(a|ad|adv|advantage|vorteil|v)$/i.test(t)) return 'AD';
  if (/^love$/i.test(t)) return '0';
  return t;
};

const pick = (...vals) => { for (const v of vals) if (v !== undefined && v !== null) return v; return undefined; };

/**
 * Satz-Liste vereinheitlichen -> [[a, b, tbLoser?], …].
 * Akzeptiert [[6,4],[7,6,5]] ebenso wie rules.js-Objekte { games:[7,6], tiebreak:[7,5]|null, matchTiebreak }.
 * Match-Tiebreak-Sätze werden mit ihren Tiebreak-Punkten angezeigt (z. B. 10:8).
 */
export function normSets(sets, out = []) {
  out.length = 0;
  if (!Array.isArray(sets)) return out;
  for (const s of sets) {
    if (Array.isArray(s)) { out.push(s); continue; }
    if (!s || typeof s !== 'object') continue;
    const tb = s.tiebreak;
    if (s.matchTiebreak && Array.isArray(tb)) { out.push([tb[0], tb[1]]); continue; }
    const a = pick(s.a, s.p0, s.games?.[0], s[0]), b = pick(s.b, s.p1, s.games?.[1], s[1]);
    let loser = pick(s.tb, s.tiebreakLoser);
    if (loser == null && Array.isArray(tb)) loser = Math.min(tb[0], tb[1]);
    else if (loser == null && Number.isFinite(tb)) loser = tb;
    out.push(loser == null ? [a ?? 0, b ?? 0] : [a ?? 0, b ?? 0, loser]);
  }
  return out;
}

/**
 * Normalisiert ein Score-View-Objekt (verschiedene Feldnamen werden akzeptiert) in `out`.
 * Direkt kompatibel mit `Score.view()` aus src/sim/rules.js; außerdem mit der Kurzform
 *  { sets: [[6,4],[6,7,5]], games: [5,6], points: ['30','40'] | [2,3], tiebreak: false, server: 0|1,
 *    flags: { breakPoint, setPoint, matchPoint } (bool | Spielerindex | {player, count}), names?: [..] }
 */
export function normalizeScore(v, out = {}) {
  out.sets = out.sets || [];
  out.games = out.games || [0, 0]; out.pts = out.pts || ['0', '0'];
  const P = Array.isArray(v.players) && typeof v.players[0] === 'object' ? v.players : null;
  // Sätze
  let sets = pick(v.sets, v.setScores, v.setHistory, v.completedSets, v.setsHistory);
  if (!Array.isArray(sets) && P && Array.isArray(P[0].sets)) sets = P[0].sets.map((g, i) => [g, P[1].sets[i]]);
  normSets(sets, out.sets);
  // Spiele im laufenden Satz
  const games = pick(v.games, v.gamesInSet, v.currentGames, v.setGames, P && [P[0].games, P[1].games]);
  out.games[0] = games?.[0] ?? 0; out.games[1] = games?.[1] ?? 0;
  // Tiebreak
  out.tiebreak = !!pick(v.tiebreak, v.isTiebreak, v.inTiebreak, v.flags?.tiebreak);
  out.matchTiebreak = !!v.matchTiebreak;
  // Punkte
  const pts = pick(v.pointsText, v.pointText, v.points, v.pts, v.gamePoints, P && [P[0].points, P[1].points]);
  if (Array.isArray(pts)) {
    if (typeof pts[0] === 'number' && typeof pts[1] === 'number') {
      const t = pointsText(pts[0], pts[1], out.tiebreak); out.pts[0] = t[0]; out.pts[1] = t[1];
    } else { out.pts[0] = normPtStr(pts[0] ?? ''); out.pts[1] = normPtStr(pts[1] ?? ''); }
  } else { out.pts[0] = '0'; out.pts[1] = '0'; }
  // Aufschläger
  let server = pick(v.server, v.serving, v.serverIndex);
  if (server === undefined && P) server = P.findIndex((p) => p.serving);
  out.server = server === 0 || server === 1 ? server : -1;
  // Flaggen (Priorität Match > Satz > Break)
  const F = v.flags || v;
  out.flag = null;
  const leader = () => {
    const a = parseInt(out.pts[0], 10), b = parseInt(out.pts[1], 10);
    if (out.pts[0] === 'AD') return 0; if (out.pts[1] === 'AD') return 1;
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a > b ? 0 : 1;
    return -1;
  };
  const mk = (val, kind, defHolder) => {
    if (val === undefined || val === null || val === false || val === -1) return null;
    let holder = -1, count = 1;
    if (typeof val === 'number') holder = val;
    else if (typeof val === 'object') { holder = pick(val.player, val.holder, val.for, -1); count = val.count || 1; }
    else holder = defHolder();
    return { kind, holder: holder === 0 || holder === 1 ? holder : -1, count };
  };
  out.flag = mk(pick(F.matchPoint, F.matchpoint, F.match_point), 'match', leader)
    || mk(pick(F.setPoint, F.setpoint, F.set_point), 'set', leader)
    || mk(pick(F.breakPoint, F.breakpoint, F.break_point), 'break', () => (out.server >= 0 ? 1 - out.server : leader()));
  if (out.flag) {
    const cnt = pick(F.breakPointCount, F.pointsCount, F.count, v.pressureCount, v.pressure?.count);
    if (typeof cnt === 'number' && cnt > 1) out.flag.count = cnt;
  }
  out.names = pick(v.names, P && P.map((p) => p.name));
  return out;
}

export class Hud {
  constructor(ui) {
    this.ui = ui;
    this.players = DEFAULT_PLAYERS.map((p) => ({ ...p }));
    this.el = h('div', 'tg-hud');
    this.visible = false;
    this._norm = {};
    this._prev = { pts: ['', ''], games: ['', ''], server: -2, sets: '', flag: '', tb: null };

    // ---------- Scorebug
    this.tl = h('div', 'tg-hud-tl');
    this.bug = h('div', 'tg-bug tg-glass');
    this.bug.setAttribute('role', 'status');
    this.bug.setAttribute('aria-label', 'Spielstand');
    this.bugEmblem = h('div', 'tg-bug-emblem', emblemSVG({ text: false, cls: 'tg-bug-emblem-svg' }));
    this.bugRows = h('div', 'tg-bug-rows');
    this.tbTab = h('div', 'tg-bug-tab', 'TIEBREAK');
    this.rows = [0, 1].map((i) => {
      const row = h('div', `tg-row tg-row-${i}`);
      const name = h('span', 'tg-name');
      const serve = h('span', 'tg-serve', icon('ball'));
      const sets = h('span', 'tg-sets');
      const games = h('span', 'tg-games');
      const ptsWrap = h('span', 'tg-pts');
      const pts = h('span', 'tg-pts-v', '0');
      ptsWrap.appendChild(pts);
      row.append(name, serve, sets, games, ptsWrap);
      this.bugRows.appendChild(row);
      return { row, name, serve, sets, games, pts, ptsWrap, setCells: [] };
    });
    this.bug.append(this.bugEmblem, this.bugRows, this.tbTab);

    this.flagWrap = h('div', 'tg-flag-wrap');
    this.flag = h('div', 'tg-flag', '<i class="tg-flag-dot"></i><span class="tg-flag-t"></span><span class="tg-flag-p"></span><i class="tg-flag-shine"></i>');
    this.flagT = this.flag.querySelector('.tg-flag-t');
    this.flagP = this.flag.querySelector('.tg-flag-p');
    this.flagWrap.appendChild(this.flag);

    this.speedWrap = h('div', 'tg-speed-wrap');
    this.speed = h('div', 'tg-speed tg-glass', `${icon('radar')}<span class="tg-speed-l">Aufschlag</span><span class="tg-speed-v">0</span><span class="tg-speed-u">km/h</span>`);
    this.speedV = this.speed.querySelector('.tg-speed-v');
    this.speedL = this.speed.querySelector('.tg-speed-l');
    this.speedWrap.appendChild(this.speed);
    this._speedTimer = 0;

    this.tl.append(this.bug, this.flagWrap, this.speedWrap);

    // ---------- Zielkreise auf dem Platz (pro Spieler, Bildschirm-Polygon) + Landepunkt
    this.aimSvg = document.createElementNS(SVGNS, 'svg');
    this.aimSvg.setAttribute('class', 'tg-aim');
    this.aimSvg.setAttribute('aria-hidden', 'true');
    this.aims = [0, 1].map((i) => {
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', `tg-aim-g tg-aim-${i}`);
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('class', 'tg-aim-c');
      const dot = document.createElementNS(SVGNS, 'circle');
      dot.setAttribute('class', 'tg-aim-dot'); dot.setAttribute('r', '5');
      g.append(path, dot);
      this.aimSvg.appendChild(g);
      return { g, path, dot, on: false, red: false, d: '', land: false };
    });

    // ---------- Powerbalken (pro Spieler): füllt sich von unten, friert beim Treffer ein, zeigt dann km/h
    this.powers = [0, 1].map((i) => {
      const el = h('div', `tg-pow tg-pow-${i}`);
      el.innerHTML = `<div class="tg-pow-in">
        <div class="tg-pow-net">Netz!</div>
        <div class="tg-pow-trk"><div class="tg-pow-fill"></div><i style="bottom:25%"></i><i style="bottom:50%"></i><i style="bottom:75%"></i><div class="tg-pow-mark"></div></div>
        <div class="tg-pow-kmh"><b>0</b><span>km/h</span></div>
      </div>`;
      return {
        el, fill: el.querySelector('.tg-pow-fill'), mark: el.querySelector('.tg-pow-mark'), kmh: el.querySelector('.tg-pow-kmh b'),
        on: false, v: -1, x: NaN, y: NaN, max: false, frozen: false, net: false, k: -1,
      };
    });
    this.charges = this.powers;     // Altname (Spielerfarbe setzen)

    // ---------- Trefferblitz
    this.flash = h('div', 'tg-flash');

    // ---------- Aufschlag-Meter
    this.meter = h('div', 'tg-meter');
    this.meter.innerHTML = `<div class="tg-meter-in tg-glass">
      <div class="tg-meter-l">Timing</div>
      <div class="tg-meter-track"><div class="tg-meter-fill"></div><div class="tg-meter-zone"><b>Perfekt</b></div><div class="tg-meter-mark"><i>${icon('ball')}</i></div></div>
      </div>`;
    this.meterZone = this.meter.querySelector('.tg-meter-zone');
    this.meterFill = this.meter.querySelector('.tg-meter-fill');
    this.meterMark = this.meter.querySelector('.tg-meter-mark');
    this._meter = { on: false, v: -1, lo: -1, hi: -1, x: NaN, y: NaN, hot: false };
    this._meterH = 0; this._meterW = 0;
    window.addEventListener('resize', () => { this._meterH = 0; });

    // ---------- Timing-Pops (Pool)
    this.pops = [0, 1, 2, 3].map(() => { const el = h('div', 'tg-timing'); return el; });
    this._popIdx = 0;
    this._lastAnchor = [null, null];

    this.el.append(this.aimSvg, this.tl, ...this.powers.map((c) => c.el), this.flash, this.meter, ...this.pops);
    this.setPlayers(this.players);
  }

  show() {
    if (this.visible) return;
    this.visible = true;
    this.el.classList.add('is-on');
  }

  hide() {
    this.visible = false;
    this.el.classList.remove('is-on');
    this.power(0, null); this.power(1, null); this.aimCircle(0, null); this.aimCircle(1, null); this.serveMeter(null);
  }

  /** [{ name, color, id? }, …] — Farbe als '#hex' oder [r,g,b]. */
  setPlayers(list) {
    if (!Array.isArray(list)) return;
    list.forEach((p, i) => {
      if (i > 1 || !p) return;
      const base = this.players[i];
      base.name = p.name ?? base.name;
      base.color = cssColor(p.color, base.color);
      base.id = p.id ?? base.id;
    });
    const longest = Math.max(...this.players.map((p) => String(p.name).length));
    this.bug.style.setProperty('--namew', `${(Math.max(5, longest) * 0.74 + 1.6).toFixed(2)}em`);
    this.players.forEach((p, i) => {
      this.rows[i].name.textContent = String(p.name).toUpperCase();
      this.rows[i].row.style.setProperty('--pc', p.color);
      this.powers[i].el.style.setProperty('--pc', p.color);
      this.aims[i].g.style.setProperty('--pc', p.color);
    });
    this.ui?._playersChanged?.(this.players);
  }

  /** Spielstand aktualisieren (idempotent, nur geänderte Zellen werden angefasst). */
  update(view) {
    if (!view) return;
    const n = normalizeScore(view, this._norm);
    const P = this._prev;
    if (n.names && n.names.length === 2 && n.names.some((nm, i) => nm && nm !== this.players[i].name)) {
      this.setPlayers(n.names.map((name) => ({ name })));
    }
    // Satzspalten
    const setsKey = n.sets.map((s) => s.join('-')).join('|');
    if (setsKey !== P.sets) {
      P.sets = setsKey;
      this._buildSets(n.sets);
    }
    // Spiele & Punkte
    for (let i = 0; i < 2; i++) {
      const r = this.rows[i];
      const g = String(n.games[i]);
      if (g !== P.games[i]) {
        const first = P.games[i] === '';
        P.games[i] = g; r.games.textContent = g;
        if (!first) animate(r.games, [{ transform: 'scale(1.5)', color: '#F3D98A' }, { transform: 'scale(1)' }], { duration: 520, easing: 'cubic-bezier(.16,1,.3,1)' });
      }
      const pt = n.pts[i];
      if (pt !== P.pts[i]) {
        const first = P.pts[i] === '';
        P.pts[i] = pt; r.pts.textContent = pt;
        r.ptsWrap.classList.toggle('is-ad', pt === 'AD');
        if (!first) animate(r.pts, [{ transform: 'translateY(-70%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 380, easing: 'cubic-bezier(.16,1,.3,1)' });
      }
    }
    // Aufschläger
    if (n.server !== P.server) {
      P.server = n.server;
      this.rows.forEach((r, i) => r.row.classList.toggle('is-serving', i === n.server));
      if (n.server >= 0) animate(this.rows[n.server].serve.firstElementChild, [{ transform: 'scale(0) rotate(-180deg)' }, { transform: 'scale(1) rotate(0)' }], { duration: 520, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    }
    const tbKey = n.tiebreak ? (n.matchTiebreak ? 2 : 1) : 0;
    if (tbKey !== P.tb) {
      P.tb = tbKey;
      this.tbTab.textContent = tbKey === 2 ? 'MATCH-TIEBREAK' : 'TIEBREAK';
      this.bug.classList.toggle('is-tiebreak', tbKey > 0);
    }
    // Flagge
    const fk = n.flag ? `${n.flag.kind}:${n.flag.holder}:${n.flag.count}` : '';
    if (fk !== P.flag) { P.flag = fk; this._setFlag(n.flag); }
  }

  _buildSets(sets) {
    const ns = sets.length;
    for (let i = 0; i < 2; i++) {
      const r = this.rows[i];
      r.sets.textContent = '';
      for (const s of sets) {
        const mine = s[i] ?? 0, other = s[1 - i] ?? 0;
        const cell = h('span', `tg-set${mine > other ? ' is-won' : ''}`);
        cell.textContent = String(mine);
        const tbl = s[2];
        if (mine < other && Number.isFinite(tbl)) { const sup = h('sup', 'tg-tb'); sup.textContent = String(tbl); cell.appendChild(sup); }
        r.sets.appendChild(cell);
      }
    }
    this.bug.style.setProperty('--nsets', String(ns));
    this.bug.classList.toggle('has-sets', ns > 0);
  }

  _setFlag(f) {
    const w = this.flagWrap;
    if (!f) { w.classList.remove('is-on'); return; }
    const [one, many] = FLAG_TEXT[f.kind];
    this.flagT.textContent = f.count > 1 ? `${f.count} ${many}` : one;
    const p = this.players[f.holder];
    this.flagP.textContent = p ? String(p.name).toUpperCase() : '';
    this.flag.style.setProperty('--pc', p ? p.color : 'transparent');
    this.flag.className = `tg-flag tg-flag-${f.kind}`;
    w.classList.remove('is-on');
    void w.offsetWidth; // Animation neu starten (selten, kein Hot-Path)
    w.classList.add('is-on');
  }

  /** Aufschlag-Tempo-Popup (km/h). label optional (z. B. '2. Aufschlag'). */
  serveSpeed(kmh, label = 'Aufschlag') {
    if (kmh == null) { this.speedWrap.classList.remove('is-on'); return; }
    this.speedL.textContent = label;
    this.speedWrap.classList.remove('is-on');
    void this.speedWrap.offsetWidth;
    this.speedWrap.classList.add('is-on');
    const target = Math.round(kmh);
    // Zähl-Animation
    const t0 = performance.now(), dur = 650;
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      this.speedV.textContent = String(Math.round(target * e));
      if (k < 1) this._speedRaf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this._speedRaf);
    this._speedRaf = requestAnimationFrame(tick);
    clearTimeout(this._speedTimer);
    this._speedTimer = setTimeout(() => this.speedWrap.classList.remove('is-on'), 3600);
  }

  _defaultAnchor(idx) {
    const W = window.innerWidth, H = window.innerHeight;
    return idx === 0 ? [W * 0.5, H * 0.74] : [W * 0.5, H * 0.34];
  }

  /** Altname: Schlag-Ladung = Powerbalken. */
  charge(idx, v, screenPos) { this.power(idx, v, screenPos); }

  /**
   * Powerbalken am Spieler: v 0..1 (null = aus), screenPos = {x,y} | [x,y] (CSS-Pixel, Körpermitte; der Balken steht rechts
   * daneben). o = { frozen: Treffer (Wert eingefroren), kmh: Tempo nach dem Treffer, net: Netz-Warnung (tiefer Ball + volle Kraft) }.
   */
  power(idx, v, screenPos, o = null) {
    const c = this.powers[idx];
    if (!c) return;
    if (v == null || v < 0) {
      if (c.on) { c.on = false; c.el.classList.remove('is-on', 'is-max', 'is-frozen', 'has-kmh', 'is-net'); c.max = c.frozen = c.net = false; c.v = -1; c.k = -1; }
      return;
    }
    let x, y;
    if (screenPos) { x = screenPos.x ?? screenPos[0]; y = screenPos.y ?? screenPos[1]; }
    else if (Number.isFinite(c.x)) { x = c.x; y = c.y; }
    else { const d = this._defaultAnchor(idx); x = d[0]; y = d[1]; }
    if (Math.abs(x - c.x) > 0.4 || Math.abs(y - c.y) > 0.4 || !c.on) {
      c.x = x; c.y = y;
      c.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    }
    const a = this._lastAnchor[idx] || (this._lastAnchor[idx] = [0, 0]);
    a[0] = x; a[1] = y;
    if (!c.on) { c.on = true; c.el.classList.add('is-on'); }
    v = v > 1 ? 1 : v;
    if (Math.abs(v - c.v) > 0.002) {
      c.v = v;
      c.fill.style.clipPath = `inset(${((1 - v) * 100).toFixed(2)}% 0 0 0)`;
      c.mark.style.transform = `translateY(${(-v * 100).toFixed(2)}%)`;
      const max = v >= 0.985;
      if (max !== c.max) { c.max = max; c.el.classList.toggle('is-max', max); }
    }
    const frozen = !!(o && o.frozen), net = !!(o && o.net);
    if (frozen !== c.frozen) { c.frozen = frozen; c.el.classList.toggle('is-frozen', frozen); }
    if (net !== c.net) { c.net = net; c.el.classList.toggle('is-net', net); }
    const k = o && o.kmh > 0 ? Math.round(o.kmh) : -1;
    if (k !== c.k) {
      c.k = k;
      c.el.classList.toggle('has-kmh', k > 0);
      if (k > 0) c.kmh.textContent = String(k);
    }
  }

  /**
   * Zielkreis auf dem Platz: pts = Bildschirmpunkte [x0, y0, x1, y1, …] (geschlossenes Polygon) oder null (aus).
   * o = { red: Kreis reicht über eine Linie, land: [x, y] Landepunkt (nach dem Treffer), fade: 0..1 Ausblenden }.
   */
  aimCircle(idx, pts, o = null) {
    const c = this.aims[idx];
    if (!c) return;
    if (!pts) { if (c.on) { c.on = false; c.g.classList.remove('is-on', 'is-red', 'is-land'); c.red = c.land = false; c.d = ''; c.path.setAttribute('d', ''); } return; }
    let d = '';
    for (let i = 0; i + 1 < pts.length; i += 2) d += (i ? 'L' : 'M') + pts[i].toFixed(1) + ' ' + pts[i + 1].toFixed(1);
    d += 'Z';
    if (d !== c.d) { c.d = d; c.path.setAttribute('d', d); }
    if (!c.on) { c.on = true; c.g.classList.add('is-on'); }
    const red = !!(o && o.red);
    if (red !== c.red) { c.red = red; c.g.classList.toggle('is-red', red); }
    const land = o && o.land;
    if (!!land !== c.land) { c.land = !!land; c.g.classList.toggle('is-land', !!land); }
    if (land) { c.dot.setAttribute('cx', land[0].toFixed(1)); c.dot.setAttribute('cy', land[1].toFixed(1)); }
    c.g.style.opacity = o && o.fade != null ? (1 - o.fade).toFixed(3) : '';
  }

  /** Trefferblitz an screenPos (CSS-Pixel), strength 0..1. */
  impact(screenPos, strength = 1) {
    const x = screenPos.x ?? screenPos[0], y = screenPos.y ?? screenPos[1];
    const t = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`, k = 0.6 + 0.6 * strength;
    animate(this.flash, [
      { opacity: Math.min(1, 0.55 + 0.45 * strength), transform: `${t} scale(${(0.45 * k).toFixed(2)})` },
      { opacity: 0, transform: `${t} scale(${(1.5 * k).toFixed(2)})` },
    ], { duration: 280, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }

  /**
   * Aufschlag-Timing-Meter. v 0..1 (null = aus). sweetSpot: Zahl (Mitte, Breite 0.14) | [lo, hi] | {center, width}.
   * screenPos optional (Mitte des Meters), sonst rechts neben dem Aufschläger.
   */
  serveMeter(v, sweetSpot, screenPos) {
    const m = this._meter;
    if (v == null) {
      if (m.on) { m.on = false; this.meter.classList.remove('is-on', 'is-hot'); m.hot = false; m.v = -1; }
      return;
    }
    let lo = m.lo, hi = m.hi;
    if (sweetSpot != null) {
      if (typeof sweetSpot === 'number') { lo = sweetSpot - 0.07; hi = sweetSpot + 0.07; }
      else if (Array.isArray(sweetSpot)) { lo = sweetSpot[0]; hi = sweetSpot[1]; }
      else if (typeof sweetSpot === 'object') { const w = (sweetSpot.width ?? 0.14) / 2; lo = sweetSpot.center - w; hi = sweetSpot.center + w; }
    }
    if (lo < 0 && hi < 0) { lo = 0.78; hi = 0.92; }
    lo = Math.max(0, lo); hi = Math.min(1, hi);
    if (lo !== m.lo || hi !== m.hi) {
      m.lo = lo; m.hi = hi;
      this.meterZone.style.bottom = `${(lo * 100).toFixed(2)}%`;
      this.meterZone.style.height = `${((hi - lo) * 100).toFixed(2)}%`;
    }
    // Anker = unten links des Meters (rechts neben dem Spieler); im Viewport halten
    let x, y;
    if (screenPos) { x = screenPos.x ?? screenPos[0]; y = screenPos.y ?? screenPos[1]; }
    else if (this._lastAnchor[0]) { x = this._lastAnchor[0][0]; y = this._lastAnchor[0][1]; }
    else { x = window.innerWidth * 0.5 + window.innerHeight * 0.06; y = window.innerHeight * 0.8; }
    if (!this._meterH) { this._meterH = this.meter.firstElementChild.offsetHeight || 160; this._meterW = this.meter.firstElementChild.offsetWidth + this.meter.firstElementChild.offsetLeft || 80; }
    const pad = 12;
    y = Math.min(Math.max(y, this._meterH + pad), window.innerHeight - pad);
    x = Math.min(Math.max(x, pad), window.innerWidth - this._meterW - pad);
    if (Math.abs(x - m.x) > 0.4 || Math.abs(y - m.y) > 0.4 || !m.on) {
      m.x = x; m.y = y;
      this.meter.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    }
    if (!m.on) { m.on = true; this.meter.classList.add('is-on'); }
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    if (Math.abs(v - m.v) > 0.002) {
      m.v = v;
      const s = v.toFixed(4);
      this.meterFill.style.transform = `scaleY(${s})`;
      this.meterMark.style.transform = `translateY(${(-v * 100).toFixed(2)}%)`;
      const hot = v >= lo && v <= hi;
      if (hot !== m.hot) { m.hot = hot; this.meter.classList.toggle('is-hot', hot); }
    }
  }

  /** Kurzes Timing-Feedback am Spieler: 'perfect'|'good'|'early'|'late'|'stretch'|'frame' oder freier Text. */
  timing(quality, screenPos, playerIdx = 0) {
    const def = TIMING_TEXT[quality] || [String(quality), 'good'];
    let x, y;
    if (screenPos) { x = screenPos.x ?? screenPos[0]; y = screenPos.y ?? screenPos[1]; }
    else if (this._lastAnchor[playerIdx]) { x = this._lastAnchor[playerIdx][0]; y = this._lastAnchor[playerIdx][1] - window.innerHeight * 0.075; }
    else { const d = this._defaultAnchor(playerIdx); x = d[0]; y = d[1] - window.innerHeight * 0.1; }
    const el = this.pops[this._popIdx = (this._popIdx + 1) % this.pops.length];
    el.className = `tg-timing tg-timing-${def[1]}`;
    el.innerHTML = `<span>${esc(def[0])}</span>`;
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    animate(el.firstElementChild, [
      { transform: 'translate(-50%, -50%) scale(.5)', opacity: 0 },
      { transform: 'translate(-50%, -50%) scale(1.14)', opacity: 1, offset: 0.14 },
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.26 },
      { transform: 'translate(-50%, -50%) translateY(0)', opacity: 1, offset: 0.62 },
      { transform: 'translate(-50%, -50%) translateY(-1.6em)', opacity: 0 },
    ], { duration: 1100, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' });
  }

  /** Replay-Modus: Scorebug dezent ausblenden. */
  setReplay(on) { this.el.classList.toggle('is-replay', !!on); }
}

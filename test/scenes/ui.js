// Dev-Szene für die UI-Schicht: zeigt jeden UI-Zustand mit realistischen Mock-Daten
// über einem gemalten (2D-Canvas) Stadion-Hintergrund – ohne WebGL.
//
//   dev.html?scene=ui&ui=loader|title|controls|hud|banner|pause|end|intro|hawkeye|meter|changeends|replay|toast|demo
//   Zusätzlich: &kind=ace (Banner-Art), &v=tb|match|deuce|ad (HUD-Variante), &verdict=IN&mm=2 (Linienkamera),
//               &blur=0..8 (Hintergrund-Unschärfe in px), &p=0.62 (Loader-Fortschritt)

import { UI } from '../../src/ui/ui.js';

const P = (k, d) => { const s = new URLSearchParams(location.search); return s.has(k) ? s.get(k) : d; };

// ------------------------------------------------------------------ Hintergrund (2D-Malerei)

function makeCamera(W, H) {
  const C = [0, 7.6, 21.2], T = [0, 0.2, -1.5];
  const f = norm(sub(T, C)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
  const k = (H / 2) / Math.tan(0.6 / 2);
  return (p) => {
    const d = sub(p, C);
    const zc = dot(d, f);
    return [W / 2 + (dot(d, r) / zc) * k, H / 2 - (dot(d, u) / zc) * k, zc];
  };
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function paintStadium(cv, W, H, dpr) {
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const proj = makeCamera(W, H);
  const R = rng(7);
  const quad = (pts, fill) => { g.beginPath(); pts.forEach((p, i) => { const s = proj(p); i ? g.lineTo(s[0], s[1]) : g.moveTo(s[0], s[1]); }); g.closePath(); g.fillStyle = fill; g.fill(); };

  // Himmel
  const sky = g.createLinearGradient(0, 0, 0, H * 0.3);
  sky.addColorStop(0, '#7fb2d6'); sky.addColorStop(1, '#f2d9ad');
  g.fillStyle = sky; g.fillRect(0, 0, W, H * 0.3);
  // Tribünen hinten (Fläche zwischen Horizont und Rückwand)
  const wallTop = proj([0, 2.2, -19])[1], wallBot = proj([0, 0, -19])[1];
  const standTop = H * 0.06;
  const st = g.createLinearGradient(0, standTop, 0, wallTop);
  st.addColorStop(0, '#3b3a33'); st.addColorStop(0.12, '#d8cfbd'); st.addColorStop(1, '#bfb39b');
  g.fillStyle = st; g.fillRect(0, standTop, W, wallTop - standTop);
  // Dach
  g.fillStyle = '#20231f'; g.fillRect(0, 0, W, standTop);
  g.fillStyle = 'rgba(255,240,210,.35)'; g.fillRect(0, standTop - 2, W, 2);
  // Zuschauer
  const cols = ['#e9e2d2', '#c94f3d', '#2f5f8a', '#e0b04a', '#3d6e4a', '#f2efe8', '#8a6a4a', '#1d2a3a', '#d77a8a', '#7fa8c9'];
  for (let y = standTop + 8; y < wallTop - 3; y += 6.5) {
    const row = (y - standTop) / (wallTop - standTop);
    const sz = 2.2 + row * 2.6;
    for (let x = -4; x < W + 4; x += sz * 1.55) {
      if (R() < 0.08) continue;
      g.fillStyle = cols[(R() * cols.length) | 0];
      g.globalAlpha = 0.55 + R() * 0.4;
      g.fillRect(x + R() * 2, y + R() * 2, sz, sz * 1.25);
      g.fillStyle = '#e8c3a0'; g.globalAlpha *= 0.8;
      g.fillRect(x + R() * 2 + sz * 0.2, y - sz * 0.55, sz * 0.62, sz * 0.62);
    }
  }
  g.globalAlpha = 1;
  // Schatten des Dachs auf den oberen Rängen
  const sh = g.createLinearGradient(0, standTop, 0, standTop + (wallTop - standTop) * 0.5);
  sh.addColorStop(0, 'rgba(10,12,8,.55)'); sh.addColorStop(1, 'rgba(10,12,8,0)');
  g.fillStyle = sh; g.fillRect(0, standTop, W, (wallTop - standTop) * 0.5);
  // Rückwand
  g.fillStyle = '#0c3a25'; g.fillRect(0, wallTop, W, wallBot - wallTop + 1);
  g.fillStyle = 'rgba(246,239,223,.32)';
  g.font = `700 ${Math.max(7, (wallBot - wallTop) * 0.3)}px -apple-system, Helvetica, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const xx of [-0.28, 0, 0.28]) g.fillText('TOM & GERRY OPEN', W * (0.5 + xx), (wallTop + wallBot) / 2);
  // Rasen (Umrandung + Streifen)
  quad([[-40, 0, -19], [40, 0, -19], [40, 0, 19], [-40, 0, 19]], '#3f8a46');
  for (let i = 0; i < 20; i++) {
    const z0 = -19 + i * 1.9;
    quad([[-40, 0, z0], [40, 0, z0], [40, 0, z0 + 0.95], [-40, 0, z0 + 0.95]], i % 2 ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.06)');
  }
  // Abgenutzte Bereiche hinter den Grundlinien
  for (const zs of [-1, 1]) {
    const c = proj([0, 0, zs * 12.3]);
    const rad = g.createRadialGradient(c[0], c[1], 0, c[0], c[1], W * 0.08);
    rad.addColorStop(0, 'rgba(176,150,95,.38)'); rad.addColorStop(1, 'rgba(176,150,95,0)');
    g.save(); g.translate(c[0], c[1]); g.scale(2.4, 0.5); g.translate(-c[0], -c[1]);
    g.fillStyle = rad; g.beginPath(); g.arc(c[0], c[1], W * 0.08, 0, Math.PI * 2); g.fill(); g.restore();
  }
  // Linien
  const L = (x0, z0, x1, z1, w = 0.05) => {
    const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz), nx = (-dz / l) * w / 2, nz = (dx / l) * w / 2;
    quad([[x0 + nx, 0, z0 + nz], [x1 + nx, 0, z1 + nz], [x1 - nx, 0, z1 - nz], [x0 - nx, 0, z0 - nz]], 'rgba(250,250,245,.92)');
  };
  const B = 11.885, S = 4.115, D = 5.485, SV = 6.4;
  L(-D, -B, D, -B, 0.1); L(-D, B, D, B, 0.1);
  L(-S, -B, -S, B); L(S, -B, S, B); L(-D, -B, -D, B); L(D, -B, D, B);
  L(-S, -SV, S, -SV); L(-S, SV, S, SV); L(0, -SV, 0, SV);
  L(0, -B, 0, -B + 0.15); L(0, B, 0, B - 0.15);
  // Spielerfiguren (stilisiert) + Schatten
  const figure = (x, z, shirt, head, hair, scale = 1) => {
    const feet = proj([x, 0, z]), top = proj([x, 1.8 * scale, z]);
    const hgt = feet[1] - top[1], w = hgt * 0.26;
    g.fillStyle = 'rgba(0,0,0,.28)'; g.beginPath(); g.ellipse(feet[0] + w * 0.3, feet[1], w * 0.9, w * 0.22, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f4f1ea'; g.fillRect(feet[0] - w * 0.35, feet[1] - hgt * 0.5, w * 0.7, hgt * 0.22); // Shorts
    g.fillStyle = head; g.fillRect(feet[0] - w * 0.3, feet[1] - hgt * 0.3, w * 0.22, hgt * 0.28); g.fillRect(feet[0] + w * 0.08, feet[1] - hgt * 0.3, w * 0.22, hgt * 0.28);
    g.fillStyle = shirt; g.beginPath(); g.roundRect(feet[0] - w * 0.48, feet[1] - hgt * 0.82, w * 0.96, hgt * 0.36, w * 0.2); g.fill();
    g.fillStyle = head; g.beginPath(); g.arc(feet[0], feet[1] - hgt * 0.9, w * 0.34, 0, Math.PI * 2); g.fill();
    if (hair) { g.fillStyle = hair; g.beginPath(); g.arc(feet[0], feet[1] - hgt * 0.94, w * 0.33, Math.PI, 0); g.fill(); }
    // Schläger
    g.strokeStyle = '#222'; g.lineWidth = Math.max(1, w * 0.08); g.beginPath(); g.moveTo(feet[0] + w * 0.5, feet[1] - hgt * 0.55); g.lineTo(feet[0] + w * 1.0, feet[1] - hgt * 0.8); g.stroke();
    g.beginPath(); g.ellipse(feet[0] + w * 1.12, feet[1] - hgt * 0.9, w * 0.2, w * 0.28, 0.5, 0, Math.PI * 2); g.stroke();
    return { x: feet[0], y: feet[1] - hgt * 0.5, h: hgt };
  };
  const gerry = figure(1.2, -11.6, '#f7f3ea', '#f08a2b', null, 0.92);
  // Ohren für Gerry
  // Netz
  const netPts = [];
  for (let i = 0; i <= 24; i++) { const x = -6.4 + (12.8 * i) / 24; const hx = Math.abs(x) > 5.029 ? 1.07 : 0.914 + (1.07 - 0.914) * (x / 5.029) ** 2; netPts.push([x, hx, 0]); }
  g.beginPath(); netPts.forEach((p, i) => { const s = proj(p); i ? g.lineTo(s[0], s[1]) : g.moveTo(s[0], s[1]); });
  for (let i = netPts.length - 1; i >= 0; i--) { const s = proj([netPts[i][0], 0, 0]); g.lineTo(s[0], s[1]); }
  g.closePath(); g.fillStyle = 'rgba(15,20,18,.42)'; g.fill();
  g.save(); g.clip();
  g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1;
  for (let x = -6.4; x <= 6.4; x += 0.12) { const a = proj([x, 0, 0]), b = proj([x, 1.1, 0]); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); }
  g.restore();
  g.beginPath(); netPts.forEach((p, i) => { const s = proj(p); i ? g.lineTo(s[0], s[1]) : g.moveTo(s[0], s[1]); });
  g.strokeStyle = '#fbfbf6'; g.lineWidth = Math.max(2, H * 0.006); g.stroke();
  for (const x of [-6.4, 6.4]) { const a = proj([x, 0, 0]), b = proj([x, 1.07, 0]); g.strokeStyle = '#0b2a1c'; g.lineWidth = Math.max(3, H * 0.008); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); }
  const tom = figure(-0.6, 11.4, '#8ccbf2', '#e7b08a', '#2a1c14', 1);
  // Ball
  const bp = proj([0.6, 1.6, 4.5]), bs = proj([0.6, 0, 4.5]);
  g.fillStyle = 'rgba(0,0,0,.3)'; g.beginPath(); g.ellipse(bs[0], bs[1], 5, 1.6, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#e4f25a'; g.beginPath(); g.arc(bp[0], bp[1], Math.max(3, H * 0.006), 0, Math.PI * 2); g.fill();
  // Licht/Vignette
  const warm = g.createLinearGradient(0, 0, W, H);
  warm.addColorStop(0, 'rgba(255,214,150,.16)'); warm.addColorStop(1, 'rgba(40,20,0,.1)');
  g.fillStyle = warm; g.fillRect(0, 0, W, H);
  const vig = g.createRadialGradient(W / 2, H * 0.5, H * 0.35, W / 2, H * 0.5, H * 1.05);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.42)');
  g.fillStyle = vig; g.fillRect(0, 0, W, H);
  return { tom, gerry };
}

// ------------------------------------------------------------------ Mock-Daten

const PLAYERS = [{ name: 'Tom', color: '#8CCBF2', id: 'tom' }, { name: 'Gerry', color: '#F08A2B', id: 'gerry' }];

function hudView(v) {
  switch (v) {
    case 'tb': return { sets: [[6, 4]], games: [6, 6], points: [5, 4], tiebreak: true, server: 1, flags: { setPoint: 0 } };
    case 'match': return { sets: [[6, 4], [3, 6]], games: [5, 4], points: ['40', '15'], server: 0, flags: { matchPoint: 0 } };
    case 'deuce': return { sets: [], games: [3, 3], points: [3, 3], server: 1, flags: {} };
    case 'ad': return { sets: [], games: [2, 1], points: [4, 3], server: 0, flags: {} };
    case 'start': return { sets: [], games: [0, 0], points: [0, 0], server: 0, flags: {} };
    default: return { sets: [], games: [6, 5], points: ['30', '40'], server: 0, flags: { breakPoint: true } };
  }
}

const MOCK_STATS = {
  winner: 0, duration: 41 * 60 + 37, longestRally: 23,
  sets: [[6, 4], [3, 6], [7, 6, 5]],
  p: [
    { aces: 7, doubleFaults: 2, winners: 24, unforcedErrors: 13, firstServeIn: 38, firstServeTotal: 57, firstServeWon: 29, secondServeWon: 10, secondServePlayed: 19, breakPointsWon: 3, breakPointsTotal: 7, fastestServe: 201.4, pointsWon: 98 },
    { aces: 3, doubleFaults: 4, winners: 19, unforcedErrors: 17, firstServeIn: 35, firstServeTotal: 60, firstServeWon: 23, secondServeWon: 12, secondServePlayed: 25, breakPointsWon: 2, breakPointsTotal: 5, fastestServe: 184.0, pointsWon: 91 },
  ],
};

// ------------------------------------------------------------------ Szene

export async function run(ctx = {}) {
  const state = P('ui', 'title');
  document.documentElement.style.background = '#000';
  document.body.style.margin = '0';
  if (ctx.canvas) ctx.canvas.style.visibility = 'hidden';
  // dev.html: FPS-Overlay ausblenden (würde den Scorebug verdecken), WebGL wird hier nicht gebraucht
  if (ctx.devkit) ctx.devkit.statsEl = null;
  const stats = document.getElementById('stats');
  if (stats) stats.style.display = 'none';

  // Hintergrund
  const bg = document.createElement('canvas');
  Object.assign(bg.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', zIndex: '1' });
  document.body.appendChild(bg);
  const blurDef = { title: 0, hud: 0, meter: 0, banner: 0, replay: 1.5, hawkeye: 2, intro: 0.6, toast: 0, changeends: 0, loader: 0 };
  const blur = +P('blur', blurDef[state] ?? 3);
  bg.style.filter = blur > 0 ? `blur(${blur}px) saturate(1.05)` : '';
  if (blur > 0) bg.style.transform = 'scale(1.03)';
  let anchors = paintStadium(bg, innerWidth, innerHeight, Math.min(2, devicePixelRatio || 1));
  addEventListener('resize', () => { anchors = paintStadium(bg, innerWidth, innerHeight, Math.min(2, devicePixelRatio || 1)); });

  const host = document.createElement('div');
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2' });
  document.body.appendChild(host);
  const ui = new UI(host);
  window.__ui = ui;
  ui.hud.setPlayers(PLAYERS);
  ui.on('sound', () => {});

  const tomAnchor = () => ({ x: anchors.tom.x + anchors.tom.h * 0.62, y: anchors.tom.y - anchors.tom.h * 0.08 });
  const showHud = (v = P('v', 'bp')) => { ui.hud.show(); ui.hud.update(hudView(v)); };

  switch (state) {
    case 'loader': {
      const p = +P('p', 0.62);
      ui.loader.set(p, P('label', 'Stadion wird aufgebaut'));
      if (P('anim', '0') === '1') {
        const stages = ['Grafik-Engine', 'Rasen & Linien', 'Stadion wird aufgebaut', 'Zuschauer nehmen Platz', 'Tom wird modelliert', 'Gerrys Fell wird gebürstet', 'Schläger bespannt', 'Anpfiff'];
        let i = 0; const t = setInterval(() => { i++; ui.loader.set(i / stages.length, stages[Math.min(i, stages.length - 1)]); if (i >= stages.length) { clearInterval(t); setTimeout(() => ui.loader.hide(), 600); } }, 700);
      }
      break;
    }
    case 'title':
      ui.showTitle(null, {
        onStart: (s) => ui.toast(`Match startet: ${s.player} · ${s.format} · ${s.difficulty}`, { icon: 'play' }),
        onChange: () => {},
      });
      break;
    case 'controls':
      ui.showTitle(null, {});
      ui.showControls();
      break;
    case 'hud': {
      showHud();
      ui.hud.serveSpeed(+P('kmh', 187));
      const v = +P('charge', 0.72);
      ui.hud.charge(0, v, tomAnchor());
      if (P('timing', '1') === '1') setTimeout(() => ui.hud.timing(P('q', 'perfect'), null, 0), 1200);
      break;
    }
    case 'meter': {
      showHud(P('v', 'start'));
      const fixed = P('mv', null);
      const a = tomAnchor();
      const pos = { x: a.x, y: a.y - anchors.tom.h * 0.2 };
      if (fixed != null) ui.hud.serveMeter(+fixed, [0.8, 0.92], pos);
      else { const t0 = performance.now(); const loop = (t) => { const k = ((t - t0) / 1100) % 2; ui.hud.serveMeter(k < 1 ? k : 2 - k, [0.8, 0.92], pos); requestAnimationFrame(loop); }; requestAnimationFrame(loop); }
      break;
    }
    case 'banner': {
      showHud(P('v', 'bp'));
      const kind = P('kind', null);
      const mk = {
        ace: ['ASS!', 'Tom · 201 km/h'], winner: ['WINNER!', 'Vorhand longline · Gerry'], doublefault: ['DOPPELFEHLER', 'Breakball Gerry'],
        break: ['BREAK!', 'Gerry führt 4 : 3'], game: ['SPIEL TOM', 'Tom führt 5 : 4'], set: ['SATZ GERRY', '6 : 4'],
        changeends: ['SEITENWECHSEL', 'Tom 3 : 2 Gerry'], deuce: ['EINSTAND', ''], advantage: ['VORTEIL TOM', ''],
        tiebreak: ['TIEBREAK', 'Erster Satz · 6 : 6'], match: ['MATCHGEWINN', 'Tom gewinnt 6 : 4 · 3 : 6 · 7 : 6'], fault: ['FEHLER', 'Zweiter Aufschlag'],
      };
      if (kind) { const [t, s] = mk[kind] || [kind.toUpperCase(), '']; ui.banner(t, s, kind, { hold: P('hold', '1') === '1' }); }
      else {
        const keys = Object.keys(mk); let i = 0;
        const next = () => { const k = keys[i++ % keys.length]; ui.banner(mk[k][0], mk[k][1], k).then(next); };
        next();
      }
      break;
    }
    case 'pause':
      showHud();
      ui.showPause({ onResume: () => ui.hidePause(), onRestart: () => ui.toast('Neustart'), onQuit: () => ui.toast('Hauptmenü'), settings: ui.loadSettings(), onChange: () => {} });
      break;
    case 'end':
      ui.hud.update({ sets: [[6, 4], [3, 6], [7, 6, 5]], games: [0, 0], points: [0, 0], server: 0 });
      ui.showMatchEnd({ ...MOCK_STATS, winner: +P('winner', 0) }, { onRematch: () => ui.toast('Revanche!'), onMenu: () => ui.toast('Hauptmenü') });
      break;
    case 'intro': {
      const which = P('who', 'both');
      const list = which === 'tom' ? PLAYERS[0] : which === 'gerry' ? PLAYERS[1] : PLAYERS;
      ui.showIntro(list, { hold: true });
      break;
    }
    case 'hawkeye':
      showHud();
      ui.replayBadge(true, 'Linienkamera');
      ui.hawkeye({ verdict: P('verdict', 'AUS'), distanceMm: +P('mm', 4), line: P('line', 'Grundlinie'), hold: true });
      break;
    case 'changeends': {
      showHud('start');
      const loop = () => ui.changeEnds({ sub: 'Tom 3 : 2 Gerry', onMid: () => {} }).then(() => setTimeout(loop, 600));
      loop();
      break;
    }
    case 'replay':
      showHud();
      ui.replayBadge(true, 'Zeitlupe');
      break;
    case 'toast':
      showHud();
      ui.toast('Netz – Aufschlag wiederholen', { icon: 'info', duration: 60000 });
      setTimeout(() => ui.toast('Zweiter Aufschlag', { icon: 'ball', duration: 60000 }), 250);
      break;
    case 'demo': {
      // Kleiner Ablauf aller HUD-Elemente (manuelles Ansehen)
      showHud('start');
      let pts = [0, 0], games = [0, 0];
      const step = () => {
        const w = Math.random() < 0.5 ? 0 : 1; pts[w]++;
        const done = pts[w] >= 4 && pts[w] - pts[1 - w] >= 2;
        if (done) { games[w]++; pts = [0, 0]; ui.announce('game', { player: w, sub: `${games[0]} : ${games[1]}` }); }
        ui.hud.update({ sets: [], games, points: pts, server: (games[0] + games[1]) % 2, flags: { breakPoint: pts[1] >= 3 && pts[1] > pts[0] } });
        ui.hud.serveSpeed(150 + Math.random() * 60);
      };
      setInterval(step, 2600);
      const t0 = performance.now();
      const loop = (t) => { const k = ((t - t0) / 900) % 1.4; ui.hud.charge(0, k < 1 ? k : null, tomAnchor()); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      break;
    }
    case 'api':
      runApiTest(ui).then((r) => { window.__uiTest = r; }, (e) => { window.__uiTest = { ok: false, fails: [`exception: ${e && e.stack || e}`] }; });
      break;
    default:
      ui.showTitle(null, {});
  }
  return { ui };
}

// ------------------------------------------------------------------ Automatischer API-Test (?ui=api)
// Spielt ein komplettes Match mit der echten Zählweise (rules.js) durch, füttert HUD/Banner/Match-Ende
// und prüft die DOM-Ausgabe. Ergebnis in window.__uiTest = { ok, fails[], checks }.

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (code, k = code) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code, bubbles: true, cancelable: true }));

async function runApiTest(ui) {
  const fails = [];
  let checks = 0;
  const expect = (cond, msg) => { checks++; if (!cond) fails.push(msg); };
  const { Score } = await import('../../src/sim/rules.js');
  const R = rng(42);

  // Loader
  ui.loader.set(0.2, 'Grafik-Engine'); ui.loader.set(0.9, 'Fast fertig');
  expect(ui.loader.el.classList.contains('is-on'), 'loader sichtbar');
  await ui.loader.hide();
  expect(!ui.loader.el.classList.contains('is-on'), 'loader ausgeblendet');

  // Titel + Tastatur-Navigation
  let started = null; const changes = [];
  ui.showTitle({ player: 'tom', difficulty: 'normal', format: 'short', mode: 'single' }, { onStart: (s) => { started = s; }, onChange: (s) => changes.push(s) });
  expect(ui.blocksInput, 'Titel blockiert Spiel-Input');
  key('ArrowDown'); key('ArrowRight');           // Spieler -> Gerry
  expect(changes.length === 1 && changes[0].player === 'gerry', 'ArrowRight wechselt Spieler');
  key('KeyS'); key('KeyD'); key('KeyD');          // Gegner -> Schwer -> Leicht
  expect(changes[changes.length - 1].difficulty === 'easy', `Gegner zyklisch (${changes[changes.length - 1]?.difficulty})`);
  key('ArrowUp'); key('ArrowUp'); key('Enter');   // zurück auf "Match starten"
  expect(started && started.player === 'gerry' && started.humans[0] === 1 && started.formatRules.games === 4, 'onStart mit aufgelösten Einstellungen');
  ui.hideTitle();
  expect(!ui.blocksInput, 'nach hideTitle kein Menü offen');

  // Ganzes Match mit echter Zählweise
  const sc = new Score(['Tom', 'Gerry'], { sets: 3, games: 6, tiebreakAt: 6, tiebreakTo: 7 });
  ui.hud.setPlayers([{ name: 'Tom', color: [0.55, 0.8, 0.95], id: 'tom' }, { name: 'Gerry', color: '#F08A2B', id: 'gerry' }]);
  ui.hud.show();
  let guard = 0, banners = 0;
  const reasons = ['ace', 'winner', 'unforced_error', 'forced_error', 'double_fault', 'out', 'net'];
  while (!sc.view().over && guard++ < 2000) {
    const v0 = sc.view();
    const w = R() < (v0.server === 0 ? 0.62 : 0.4) ? 0 : 1;
    const ev = sc.pointWon(w, { reason: reasons[(R() * reasons.length) | 0], serve: R() < 0.6 ? 1 : 2, rally: 1 + ((R() * 14) | 0), serveKmh: 150 + R() * 55 });
    const v = sc.view();
    ui.hud.update(v);
    for (const e of ev) if (e.de) { banners++; ui.banner(e.de.title, e.de.sub, e.de.kind); }
    // DOM prüfen
    const rows = ui.hud.rows;
    if (!v.over) {
      for (let i = 0; i < 2; i++) {
        expect(rows[i].pts.textContent === v.pointsText[i], `Punkte P${i}: ${rows[i].pts.textContent} != ${v.pointsText[i]}`);
        expect(rows[i].games.textContent === String(v.games[i]), `Spiele P${i}`);
        expect(rows[i].row.classList.contains('is-serving') === (v.server === i), 'Aufschläger-Markierung');
      }
      expect(rows[0].sets.children.length === v.sets.length, 'Satzspalten');
      const flagOn = ui.hud.flagWrap.classList.contains('is-on');
      expect(flagOn === (v.pressure != null), `Druck-Flagge ${flagOn} vs ${JSON.stringify(v.pressure)}`);
      if (v.tiebreak) expect(ui.hud.bug.classList.contains('is-tiebreak'), 'Tiebreak-Tab');
    }
  }
  const v = sc.view();
  expect(v.over, 'Match beendet');
  expect(banners > 5, 'Banner erzeugt');
  ui.clearBanners();

  // Sonstige HUD-API
  ui.hud.serveSpeed(201.4); ui.hud.serveSpeed(null);
  for (let k = 0; k <= 10; k++) ui.hud.charge(0, k / 10, { x: 400, y: 500 });
  ui.hud.charge(0, null); ui.hud.charge(1, 0.5); ui.hud.charge(1, null);
  for (let k = 0; k <= 10; k++) ui.hud.serveMeter(k / 10, 0.85, [600, 600]);
  ui.hud.serveMeter(0.5, [0.7, 0.8]); ui.hud.serveMeter(null);
  ['perfect', 'good', 'early', 'late', 'stretch', 'frame'].forEach((q) => ui.hud.timing(q));
  ui.toast('Netz – Aufschlag wiederholen');
  ui.replayBadge(true); expect(ui.root.classList.contains('is-replay'), 'Replay-Badge'); ui.replayBadge(false);
  const hk = ui.hawkeye({ verdict: 'IN', distanceMm: 3, duration: 200 });
  await hk;
  ui.hawkeye({ verdict: 'AUS', distanceMm: 120 }); ui.hawkeye(null);
  let mid = false;
  await ui.changeEnds({ onMid: () => { mid = true; } });
  expect(mid, 'changeEnds onMid');
  const intro = ui.showIntro([{ id: 'tom', name: 'Tom', color: '#8CCBF2' }, { id: 'gerry', name: 'Gerry', color: '#F08A2B' }], { duration: 300 });
  await intro;
  await ui.fade(true, 120); expect(+getComputedStyle(ui.fadeEl).opacity > 0.99, 'fade -> schwarz');
  await ui.fade(false, 120); expect(+getComputedStyle(ui.fadeEl).opacity < 0.01, 'fade -> sichtbar');

  // Pause (Esc = weiter)
  let resumed = 0;
  ui.showPause({ onResume: () => { resumed++; ui.hidePause(); }, onRestart: () => {}, onQuit: () => {}, settings: { quality: 'high', sound: false }, onChange: () => {} });
  expect(ui.blocksInput, 'Pause blockiert Input');
  key('Escape');
  expect(resumed === 1 && !ui.blocksInput, 'Esc setzt fort');

  // Steuerung (Promise beim Schließen)
  const c = ui.showControls(); key('Escape'); await c;
  expect(!ui.blocksInput, 'Steuerung geschlossen');

  // Match-Ende mit MatchStats direkt (verschachtelt) und als flaches Objekt
  let rem = 0;
  ui.showMatchEnd({ winner: v.winner, sets: v.sets, duration: 1834, stats: sc.stats }, { onRematch: () => { rem++; }, onMenu: () => {} });
  const cells = [...ui.end.el.querySelectorAll('.tg-stat-v b')].map((e) => e.textContent);
  const P = sc.stats.players;
  expect(cells[0] === String(P[0].aces) && cells[1] === String(P[1].aces), `Asse ${cells[0]}/${cells[1]} vs ${P[0].aces}/${P[1].aces}`);
  expect(ui.end.el.querySelectorAll('.tg-end-set').length === v.sets.length, 'Satzergebnisse im Endbildschirm');
  expect(ui.end.el.querySelector('.tg-stat-one')?.textContent.startsWith(String(sc.stats.longestRally)), 'Längster Ballwechsel');
  key('Enter');
  expect(rem === 1, 'Revanche per Enter');
  ui.hideMatchEnd();
  ui.showMatchEnd({ ...sc.stats, winner: 'Gerry', sets: v.sets }, {});
  expect(/GERRY/.test(ui.end.el.querySelector('.tg-end-name-t').textContent), 'Sieger per Name');
  ui.hideMatchEnd();
  return { ok: fails.length === 0, fails: fails.slice(0, 20), nFails: fails.length, checks, banners };
}

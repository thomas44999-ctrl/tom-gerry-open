// GAMEPLAY-Debugszene: echtes Match (src/game/match.js) mit einfachen Primitiven.
//   dev.html?scene=gameplay[&demo=1][&difficulty=easy|normal|hard][&player=tom|gerry][&seed=N]
//   [&warm=Sekunden (Match vorab simulieren, z. B. für Screenshots)][&speed=0.5][&view=broadcast|side|top|orbit]
//   [&pred=0 (keine Vorhersage)][&hud=0]
// Platz mit Linien/Netz, Kapsel-Spieler (Tom hellblau, Gerry orange) mit Schläger-Andeutung, Ball + Schatten,
// vorhergesagte Flugbahn (Punkte), Zielmarke des letzten Schlags, idealer Standort des Rückschlägers,
// Broadcast-Kamera hinter dem menschlichen Spieler. Tastatur: WASD/Pfeile, J/Leertaste, K, L, I, Esc = Pause.
import { mat4, vec3, DEG, hexToLinear, damp, clamp } from '../../src/core/math.js';
import * as G from '../../src/gfx/geometry.js';
import { COURT, netHeightAt } from '../../src/sim/court.js';
import { Ball, BALL, predict, Trajectory } from '../../src/sim/ball.js';
import { STROKES } from '../../src/sim/strokes.js';
import { Match, MATCH_DT } from '../../src/game/match.js';
import { InputManager } from '../../src/game/input.js';

const HL = COURT.halfLength;
const COLORS = { tom: hexToLinear('#8CCBF2'), gerry: hexToLinear('#E8822A') };

export async function run({ renderer: r, devkit, params, canvas }) {
  const demo = params.bool('demo', false);
  const humanIdx = params.get('player', 'tom') === 'gerry' ? 1 : 0;
  const diff = params.get('difficulty', 'normal');
  const seed = params.num('seed', 7);
  const showPred = params.bool('pred', true);
  const view = params.get('view', 'broadcast');
  const match = new Match({
    players: ['tom', 'gerry'], humans: demo ? [] : [humanIdx], difficulty: diff, seed,
    format: { sets: params.num('sets', 1), games: params.num('games', 6) },
  });
  const camIdx = demo ? 0 : humanIdx;

  const scene = devkit.defaultScene();
  const D = scene.drawables;
  scene.shadow = { center: [0, 0, 0], radius: 17 };
  if (view === 'orbit') devkit.setOrbit({ dist: 30, yaw: 20, pitch: 30, target: [0, 0.5, 0] });
  else devkit.orbit.enabled = false;
  const cam = devkit.camera;
  cam.fov = 40 * DEG;

  // ---------------------------------------------------------------- Platz
  const courtMat = r.createMaterial({
    name: 'gp-court',
    uniforms: { u_a: [0.07, 0.18, 0.05], u_b: [0.095, 0.225, 0.06] },
    surface: `void surface(in SurfaceInput i, inout Surface s) {
      float st = step(0.5, fract(i.worldPos.z / 2.4));
      s.albedo = mix(u_a, u_b, st) * (0.93 + 0.14 * noise2(i.worldPos.xz * 3.0));
      s.roughness = 0.9; s.specular = 0.3;
    }`,
  });
  const CW = (COURT.doublesHalfWidth + COURT.runoffSide) * 2, CL = (HL + COURT.runoffBack) * 2;
  D.push({ mesh: r.createMesh(G.plane(CW, CL, 1, 1)), material: courtMat, model: mat4.fromTranslation(mat4.create(), [0, 0.003, 0]), castShadow: false });
  const white = r.createMaterial({ name: 'gp-white', uniforms: { u_baseColor: [0.9, 0.9, 0.88] }, surface: `void surface(in SurfaceInput i, inout Surface s) { s.roughness = 0.7; }` });
  {
    const lines = [];
    const L = (x0, z0, x1, z1) => lines.push(G.transform(G.box(Math.abs(x1 - x0), 0.004, Math.abs(z1 - z0)), mat4.fromTranslation(mat4.create(), [(x0 + x1) / 2, 0.006, (z0 + z1) / 2])));
    const SW = COURT.singlesHalfWidth, DW = COURT.doublesHalfWidth, LW = COURT.lineWidth, BW = COURT.baselineWidth;
    for (const s of [-1, 1]) {
      L(-DW, s * HL, DW, s * (HL - BW));
      L(s * SW, -HL, s * (SW - LW), HL);
      L(s * DW, -HL, s * (DW - LW), HL);
      L(-SW, s * COURT.serviceLineZ, SW, s * (COURT.serviceLineZ - LW));
      L(-COURT.centreMarkWidth / 2, s * (HL - BW), COURT.centreMarkWidth / 2, s * (HL - BW - COURT.centreMarkLength));
    }
    L(-COURT.centreLineHalfWidth, -COURT.serviceLineZ, COURT.centreLineHalfWidth, COURT.serviceLineZ);
    D.push({ mesh: r.createMesh(G.merge(lines)), material: white, castShadow: false });
    // Netz
    const N = COURT.net, seg = 64, pos = [], nor = [], uv = [], idx = [];
    for (let i = 0; i <= seg; i++) {
      const x = -N.postX + (2 * N.postX * i) / seg, h = netHeightAt(x);
      pos.push(x, 0, 0, x, h, 0); nor.push(0, 0, 1, 0, 0, 1); uv.push(x, 0, x, h);
      if (i < seg) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const netMat = r.createMaterial({
      name: 'gp-net', uniforms: { u_baseColor: [0.03, 0.035, 0.04] }, cull: 'none', alphaTest: 0.5,
      surface: `void surface(in SurfaceInput i, inout Surface s) {
        vec2 g = abs(fract(i.uv / 0.045) - 0.5);
        s.alpha = max(step(0.40, max(g.x, g.y)), step(i.uv.y, 0.06)); s.roughness = 0.8;
      }`,
    });
    D.push({ mesh: r.createMesh({ positions: new Float32Array(pos), normals: new Float32Array(nor), uvs: new Float32Array(uv), indices: new Uint16Array(idx) }), material: netMat });
    const tape = G.tube((t) => { const x = -N.postX + 2 * N.postX * t; return [x, netHeightAt(x) - 0.03, 0]; }, 0.032, 64, 8);
    const posts = [tape];
    for (const s of [-1, 1]) posts.push(G.transform(G.cylinder(N.postRadius, N.postRadius, N.postHeight + 0.03, 16), mat4.fromTranslation(mat4.create(), [s * N.postX, (N.postHeight + 0.03) / 2, 0])));
    D.push({ mesh: r.createMesh(G.merge(posts)), material: white });
  }

  // ---------------------------------------------------------------- Spieler, Schläger, Ball
  const bodyMat = r.createMaterial({ name: 'gp-body', uniforms: { u_baseColor: [1, 1, 1] }, surface: `void surface(in SurfaceInput i, inout Surface s) { s.roughness = 0.55; s.sheen = 0.3; }` });
  const darkMat = r.createMaterial({ name: 'gp-dark', uniforms: { u_baseColor: [0.06, 0.06, 0.07] }, surface: `void surface(in SurfaceInput i, inout Surface s) { s.roughness = 0.4; }` });
  const bodyMesh = r.createMesh(G.capsule(0.27, 1.06, 8, 20));          // Gesamthöhe 1.6
  const headMesh = r.createMesh(G.sphere(0.15, 20, 12));
  const noseMesh = r.createMesh(G.box(0.12, 0.08, 0.2));
  const racketMesh = r.createMesh(G.merge([
    G.transform(G.box(0.03, 0.03, 0.42), mat4.fromTranslation(mat4.create(), [0, 0, 0.21])),
    G.transform(G.torus(0.13, 0.014, 8, 24, Math.PI * 2, 'y'), mat4.fromRotationTranslationScale(mat4.create(), [0, 0, 0, 1], [0, 0, 0.55], [0.8, 1, 1.08])),
  ]));
  const players = match.players.map((p) => {
    const col = COLORS[p.id] || [0.8, 0.8, 0.8];
    const d = {
      body: { mesh: bodyMesh, material: bodyMat, model: mat4.create(), uniforms: { u_baseColor: col } },
      head: { mesh: headMesh, material: bodyMat, model: mat4.create(), uniforms: { u_baseColor: [0.85, 0.7, 0.6] } },
      nose: { mesh: noseMesh, material: darkMat, model: mat4.create() },
      racket: { mesh: racketMesh, material: darkMat, model: mat4.create() },
    };
    D.push(d.body, d.head, d.nose, d.racket);
    return d;
  });
  const ballMat = r.createMaterial({ name: 'gp-ball', uniforms: { u_baseColor: hexToLinear('#D7E83A') }, surface: `void surface(in SurfaceInput i, inout Surface s) { s.roughness = 0.8; s.emissive = u_baseColor * 0.25; }` });
  const ballD = { mesh: r.createMesh(G.sphere(BALL.radius * 1.25, 20, 12)), material: ballMat, model: mat4.create() };
  D.push(ballD);
  const shadowMat = r.createMaterial({ name: 'gp-shadow', unlit: true, blend: 'alpha', depthWrite: false, castShadow: false, uniforms: { u_baseColor: [0, 0, 0], u_a: 0.5 },
    surface: `void surface(in SurfaceInput i, inout Surface s) { float d = length(i.uv - 0.5) * 2.0; s.albedo = vec3(0.0); s.alpha = u_a * (1.0 - smoothstep(0.4, 1.0, d)); }` });
  const shadowD = { mesh: r.createMesh(G.plane(1, 1, 1, 1)), material: shadowMat, model: mat4.create(), castShadow: false, pass: 'transparent', uniforms: { u_a: 0.5 } };
  D.push(shadowD);
  // Vorhersage-Punkte, Zielmarke, Idealposition
  const dotMat = r.createMaterial({ name: 'gp-dot', unlit: true, castShadow: false, uniforms: { u_baseColor: [1, 1, 1] } });
  const dotMesh = r.createMesh(G.sphere(0.022, 8, 6));
  const NDOTS = 44;
  const dots = [];
  for (let i = 0; i < NDOTS; i++) { const d = { mesh: dotMesh, material: dotMat, model: mat4.create(), castShadow: false, visible: false, uniforms: { u_baseColor: [1, 0.95, 0.6] } }; dots.push(d); D.push(d); }
  const ringMesh = r.createMesh(G.ring(0.18, 0.26, 40));
  const targetD = { mesh: ringMesh, material: dotMat, model: mat4.create(), castShadow: false, visible: false, uniforms: { u_baseColor: [1, 0.3, 0.2] } };
  const idealD = { mesh: ringMesh, material: dotMat, model: mat4.create(), castShadow: false, visible: false, uniforms: { u_baseColor: [0.3, 0.8, 1] } };
  const contactD = { mesh: r.createMesh(G.sphere(0.05, 10, 8)), material: dotMat, model: mat4.create(), castShadow: false, visible: false, uniforms: { u_baseColor: [0.3, 0.8, 1] } };
  D.push(targetD, idealD, contactD);

  // ---------------------------------------------------------------- HUD (DOM)
  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;right:10px;top:10px;z-index:60;font:12px/1.45 ui-monospace,Menlo,monospace;color:#eef;background:rgba(8,12,16,.72);padding:8px 11px;border-radius:8px;pointer-events:none;min-width:300px;white-space:pre';
  if (params.bool('hud', true)) document.body.appendChild(hud);
  const meter = document.createElement('div');
  meter.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);width:260px;height:14px;border-radius:7px;background:rgba(0,0,0,.5);overflow:hidden;z-index:60;display:none';
  const meterFill = document.createElement('div');
  meterFill.style.cssText = 'height:100%;width:0;background:linear-gradient(90deg,#3a7,#ee4,#f84);';
  meter.appendChild(meterFill);
  document.body.appendChild(meter);
  const log = [];
  const logEv = (s) => { log.push(s); if (log.length > 7) log.shift(); };

  // ---------------------------------------------------------------- Eingabe
  const input = new InputManager(window, { mode: 'single' });
  const inputs = [null, null];
  let paused = false;

  // Vorab simulieren (Screenshots mitten im Ballwechsel)
  const warm = params.num('warm', 0);
  for (let t = 0; t < warm; t += MATCH_DT) { match.step(MATCH_DT, inputs); match.drainEvents(); }

  // ---------------------------------------------------------------- Kamera
  const camPos = vec3.fromValues(0, 8, 21), camTgt = vec3.fromValues(0, 0.6, 0);
  let camInit = false;
  const predBall = new Ball(), predTr = new Trajectory(800);
  let predAge = 1;
  const tmp = vec3.create();

  const update = (dt) => {
    input.poll();
    if (input.consumePause()) paused = !paused;
    const S = match.state;
    const hp = match.players[camIdx];
    if (!demo) inputs[humanIdx] = input.getPlayerInput(0, match.players[humanIdx].side);
    if (!paused) match.step(dt, inputs);
    for (const e of match.drainEvents()) {
      switch (e.type) {
        case 'hit': logEv(`${match.players[e.player].name}: ${e.stroke} ${e.shot} ${e.quality} ${Math.round(e.kmh)} km/h`); break;
        case 'point': logEv(`PUNKT ${match.players[e.winner].name} (${e.reason}${e.closeCall ? ', knapp ' + e.closeCall.distanceMm + ' mm' : ''}) – ${e.call}`); break;
        case 'fault': logEv(e.n === 2 ? 'Doppelfehler' : 'Fehler (' + e.kind + ')'); break;
        case 'let': logEv('Netz – Wiederholung'); break;
        case 'line_call': logEv(`Linienrichter: ${e.call}`); break;
        case 'game': case 'set': case 'match': logEv(`${e.type.toUpperCase()} ${match.players[e.winner].name} – ${e.call || ''}`); break;
        case 'change_ends': logEv('Seitenwechsel'); break;
        default: break;
      }
    }
    // --- Spieler
    for (let i = 0; i < 2; i++) {
      const p = match.players[i], d = players[i];
      const k = (p.stats.height || 1.8) / 1.8;
      const hop = p.split > 0 ? Math.sin(clamp(p.split / 0.22, 0, 1) * Math.PI) * 0.09 : 0;
      mat4.fromYawTranslation(d.body.model, p.yaw, [p.pos[0], 0.8 * k + hop, p.pos[2]], k);
      mat4.fromYawTranslation(d.head.model, p.yaw, [p.pos[0], 1.68 * k + hop, p.pos[2]], k);
      const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
      mat4.fromYawTranslation(d.nose.model, p.yaw, [p.pos[0] + fx * 0.25 * k, 1.25 * k + hop, p.pos[2] + fz * 0.25 * k], k);
      racketPose(d.racket.model, p, S.time, k, hop);
    }
    // --- Ball
    const b = S.ball.pos;
    ballD.visible = S.ball.visible;
    mat4.fromTranslation(ballD.model, [b[0], b[1], b[2]]);
    const sh = Math.max(0.12, 0.22 - b[1] * 0.02);
    mat4.fromRotationTranslationScale(shadowD.model, [0, 0, 0, 1], [b[0], 0.008, b[2]], [sh, 1, sh]);
    shadowD.visible = S.ball.visible;
    shadowD.uniforms.u_a = clamp(0.55 - b[1] * 0.07, 0.12, 0.55);
    // --- Vorhersage
    const inFlight = (S.phase === 'rally' || S.phase === 'point_over' || S.phase === 'serve') && match.ball.mode === 'air' && S.ball.visible;
    predAge += dt;
    if (showPred && inFlight && predAge > 0.05) {
      predAge = 0;
      predBall.copyFrom(match.ball);
      predict(predBall, 2.6, BALL.dt, { out: predTr, maxBounces: 2 });
      const dur = predTr.duration;
      for (let i = 0; i < NDOTS; i++) {
        const t = (i + 1) / NDOTS * dur;
        predTr.positionAt(t, tmp);
        mat4.fromTranslation(dots[i].model, tmp);
        dots[i].visible = true;
      }
    } else if (!inFlight) for (const d of dots) d.visible = false;
    // --- Zielmarke / Idealposition
    if (S.target && S.phase === 'rally') {
      mat4.fromTranslation(targetD.model, [S.target.x, 0.012, S.target.z]);
      targetD.visible = true;
    } else targetD.visible = false;
    const recv = match.players.find((p) => p.plan && p.plan.valid);
    if (recv && S.phase === 'rally') {
      mat4.fromTranslation(idealD.model, [recv.plan.pos[0], 0.014, recv.plan.pos[2]]);
      mat4.fromTranslation(contactD.model, recv.plan.contact);
      idealD.visible = contactD.visible = true;
    } else idealD.visible = contactD.visible = false;
    // --- Kamera (Broadcast hinter dem Menschen)
    if (view !== 'orbit') {
      const s = hp.side;
      let px, py, pz, tx, ty, tz;
      if (view === 'side') { px = 26; py = 6; pz = 0; tx = 0; ty = 0.5; tz = 0; }
      else if (view === 'top') { px = 0; py = 46; pz = s * 0.01; tx = 0; ty = 0; tz = 0; }
      else {
        const bx = S.ball.visible ? b[0] : 0;
        px = clamp(bx * 0.3 + hp.pos[0] * 0.25, -3, 3); py = 9.2; pz = s * (HL + 11.5);
        tx = clamp(bx * 0.45, -2.5, 2.5); ty = 0; tz = s * 0.6;
      }
      if (!camInit) { vec3.set(camPos, px, py, pz); vec3.set(camTgt, tx, ty, tz); camInit = true; }
      const sideChange = Math.sign(camPos[2]) !== Math.sign(pz) && view === 'broadcast';
      if (sideChange) { vec3.set(camPos, px, py, pz); vec3.set(camTgt, tx, ty, tz); }
      camPos[0] = damp(camPos[0], px, 2.5, dt); camPos[1] = damp(camPos[1], py, 2.5, dt); camPos[2] = damp(camPos[2], pz, 2.5, dt);
      camTgt[0] = damp(camTgt[0], tx, 3, dt); camTgt[1] = damp(camTgt[1], ty, 3, dt); camTgt[2] = damp(camTgt[2], tz, 3, dt);
      vec3.copy(cam.position, camPos); vec3.copy(cam.target, camTgt);
    }
    // --- HUD
    const v = match.score.view();
    const P = match.players;
    const srv = v.server;
    const line = (i) => `${i === srv ? '●' : ' '} ${P[i].name.padEnd(6)} ${v.sets.map((x) => x.games[i]).join(' ')} ${String(v.games[i]).padStart(2)}  ${v.pointsText[i].padStart(3)}`;
    const hpp = P[demo ? 0 : humanIdx];
    hud.textContent =
      `${line(0)}\n${line(1)}\n` +
      `Phase ${S.phase}${paused ? ' (PAUSE)' : ''}  Rallye ${S.rally}  ${demo ? 'DEMO' : 'Mensch: ' + P[humanIdx].name}  ${diff}\n` +
      `${hpp.name}: ${hpp.mode}${hpp.stroke ? ' ' + hpp.stroke.type : ''} Ladung ${(hpp.charge * 100).toFixed(0)}%${hpp.emote ? ' Emote ' + hpp.emote : ''}\n` +
      log.join('\n');
    const sm = P[S.server] && P[S.server].serveMeter;
    meter.style.display = sm != null ? 'block' : 'none';
    if (sm != null) meterFill.style.width = (sm * 100).toFixed(0) + '%';
  };

  window.__TG_gameplay = { match, input };
  update(0);
  devkit.start({ scene, update });
}

/** Schläger-Andeutung: Ruhehaltung vor dem Körper, Schwung um die Schulter (Vorhand rechts, Rückhand links). */
function racketPose(out, p, time, k, hop) {
  const yaw = p.yaw;
  const f = [Math.sin(yaw), 0, Math.cos(yaw)], rgt = [-Math.cos(yaw), 0, Math.sin(yaw)];
  let ang = 0.6, side = 1, up = 1.05 * k, pitch = 0;
  const st = p.stroke;
  if (st && st.type) {
    const S = STROKES[st.type] || STROKES.forehand;
    const t0 = st.contactTime - st.windup, t1 = st.contactTime + S.follow;
    const u = clamp((time - t0) / Math.max(0.05, st.contactTime - t0), 0, 1);
    const v = clamp((time - st.contactTime) / Math.max(0.05, t1 - st.contactTime), 0, 1);
    side = S.side === 'bh' ? -1 : 1;
    if (st.type === 'serve' || st.type === 'smash') {
      pitch = -2.6 + 2.2 * u + 1.6 * v; ang = 0.3; up = 1.6 * k;
    } else {
      ang = time < st.contactTime ? -2.0 + 2.0 * u * u : 2.0 * Math.sin(v * Math.PI / 2);
      up = (S.contact.up * 0.8 + 0.2) * k;
    }
  } else if (p.servePhase === 'toss') { pitch = -2.2; ang = 0.2; up = 1.5 * k; }
  // Richtung in der Horizontalen: ang = 0 -> seitlich, + nach vorn (Ausschwung), - nach hinten (Ausholen)
  const a = side > 0 ? ang : -ang;
  const dx = rgt[0] * side * Math.cos(ang) + f[0] * Math.sin(Math.abs(a)) * Math.sign(ang);
  const dz = rgt[2] * side * Math.cos(ang) + f[2] * Math.sin(Math.abs(a)) * Math.sign(ang);
  const dirYaw = Math.atan2(dx, dz);
  const sx = p.pos[0] + rgt[0] * side * 0.3 * k, sz = p.pos[2] + rgt[2] * side * 0.3 * k;
  mat4.fromYawTranslation(out, dirYaw, [sx, up + hop, sz], k);
  if (pitch) mat4.rotateX(out, out, pitch);
}

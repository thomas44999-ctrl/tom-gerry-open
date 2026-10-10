// Anzeigetafeln: zwei große Eck-Anzeigetafeln (LED, Live-Spielstand per Canvas-Textur), Uhren an den
// Pavillons (Zeiger im Shader), Aufschlag-Geschwindigkeitsanzeigen an den Stirnmauern.
import { MeshBuilder } from './mb.js';
import { LAYOUT, BASE } from './layout.js';
import { hex } from './envlib.js';
import { makeCanvas, drawLogo, INK } from './signs.js';
import { mat4, vec3 } from '../core/math.js';

const SCREEN_SURFACE = `
void surface(in SurfaceInput i, inout Surface s) {
  vec3 t = texture(u_tex, i.uv).rgb;
  // LED-Raster (nur aus der Nähe sichtbar)
  vec2 g = fract(i.uv * u_led) - 0.5;
  float fw = max(fwidth(i.uv.x * u_led.x), fwidth(i.uv.y * u_led.y));
  float dots = mix(1.0, 0.55 + 0.45 * (1.0 - smoothstep(0.25, 0.5, length(g))), 1.0 - smoothstep(0.3, 0.8, fw));
  s.albedo = t * 0.05;
  s.emissive = t * dots * u_bright;
  s.roughness = 0.25; s.specular = 0.6;
}`;

const CLOCK_SURFACE = `
float clk_hand(vec2 p, float ang, float len, float w) {
  vec2 d = vec2(sin(ang), cos(ang));
  float t = clamp(dot(p, d), -0.08, len);
  float dist = length(p - d * t);
  float aa = fwidth(dist) * 1.2;
  return 1.0 - smoothstep(w - aa, w + aa, dist);
}
void surface(in SurfaceInput i, inout Surface s) {
  vec2 p = (i.uv - 0.5) * vec2(2.0, -2.0);
  vec3 face = texture(u_tex, i.uv).rgb;
  float sec = u_clock.z, mn = u_clock.y + sec / 60.0, hr = mod(u_clock.x, 12.0) + mn / 60.0;
  float h = clk_hand(p, hr / 12.0 * 6.2831853, 0.48, 0.035);
  float m = clk_hand(p, mn / 60.0 * 6.2831853, 0.72, 0.024);
  float sc = clk_hand(p, sec / 60.0 * 6.2831853, 0.78, 0.008);
  vec3 col = mix(face, vec3(0.02, 0.06, 0.04), max(h, m));
  col = mix(col, vec3(0.75, 0.55, 0.2), sc);
  float hub = 1.0 - smoothstep(0.045, 0.055, length(p));
  col = mix(col, vec3(0.75, 0.6, 0.3), hub);
  s.albedo = col;
  s.roughness = 0.35;
  s.emissive = col * 0.18;
}`;

function screenQuad(mb, M, w, h, uv = [0, 0, 1, 1]) {
  const P = (x, y) => vec3.transformMat4([], [x, y, 0], M);
  const n = vec3.normalize([], vec3.transformMat4([], [0, 0, 1], [M[0], M[1], M[2], 0, M[4], M[5], M[6], 0, M[8], M[9], M[10], 0, 0, 0, 0, 1]));
  mb.quad(P(-w / 2, -h / 2), P(w / 2, -h / 2), P(w / 2, h / 2), P(-w / 2, h / 2), n, [uv[0], uv[3], uv[2], uv[1]]);
}

export function buildScoreboards(r, q, opts = {}) {
  const L = LAYOUT;
  const frame = new MeshBuilder();
  const scr = new MeshBuilder(), clk = new MeshBuilder(), spd = new MeshBuilder();
  const D = (rough, pat = 0) => [rough, pat, 1, 0];
  const green = hex('#103424'), gold = hex('#c9a04a'), dark = hex('#111614'), cream = hex('#efe8d6');

  // ---------------------------------------------------------------- Eck-Anzeigetafeln (NO + SW)
  const boards = [];
  for (const segName of ['NE', 'SW']) {
    const g = BASE.segs[BASE.names.indexOf(segName)];
    const sm = (g.s0 + g.s1) / 2;
    const a = BASE.at(sm, L.grand.depthF - 2.1, {});
    const yaw = Math.atan2(-a.nx, -a.nz);
    const M = mat4.fromYawTranslation(mat4.create(), yaw, [a.x, L.concourseY + 5.0, a.z]);
    mat4.rotateX(M, M, 0.1);
    frame.box([0, 0, -0.2], [7.0, 4.15, 0.35], M, green, D(0.5, 0));
    frame.box([0, 2.1, -0.15], [7.1, 0.08, 0.45], M, gold, D(0.35, 5));
    frame.box([0, -2.1, -0.15], [7.1, 0.08, 0.45], M, gold, D(0.35, 5));
    for (const sx of [-1, 1]) frame.box([sx * 3.55, 0, -0.15], [0.08, 4.2, 0.45], M, gold, D(0.35, 5));
    // Ausleger zur Fassade
    for (const sx of [-2.4, 2.4]) for (const sy of [-1.2, 1.2]) {
      const p0 = vec3.transformMat4([], [sx, sy, -0.35], M);
      const p1 = vec3.transformMat4([], [sx, sy, -2.3], M);
      frame.tube(p0, p1, 0.07, 8, dark, D(0.4, 5));
    }
    screenQuad(scr, mat4.translate(mat4.create(), M, [0, 0, -0.01]), 6.6, 3.71);
    boards.push({ pos: [a.x, L.concourseY + 5.0, a.z] });
  }
  const sbCanvas = makeCanvas(1024, 576);
  const sbTex = r.createTexture(sbCanvas, { srgb: true, anisotropy: 8, wrap: 'clamp' });
  const screenMat = r.createMaterial({
    name: 'env-screen',
    uniforms: { u_tex: sbTex, u_led: [512, 288], u_bright: 2.4 },
    surface: SCREEN_SURFACE,
    castShadow: false,
  });

  // ---------------------------------------------------------------- Uhren an den Pavillons
  const clockCanvas = makeCanvas(512, 512);
  {
    const g = clockCanvas.getContext('2d');
    const c = 256;
    g.fillStyle = INK.green; g.fillRect(0, 0, 512, 512);
    g.fillStyle = INK.cream; g.beginPath(); g.arc(c, c, 236, 0, Math.PI * 2); g.fill();
    g.strokeStyle = INK.gold; g.lineWidth = 14; g.beginPath(); g.arc(c, c, 242, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = INK.green; g.lineWidth = 3; g.beginPath(); g.arc(c, c, 222, 0, Math.PI * 2); g.stroke();
    for (let k = 0; k < 60; k++) {
      const a = k / 60 * Math.PI * 2, big = k % 5 === 0;
      g.strokeStyle = INK.greenDeep; g.lineWidth = big ? 9 : 3;
      g.beginPath(); g.moveTo(c + Math.sin(a) * (big ? 178 : 196), c - Math.cos(a) * (big ? 178 : 196)); g.lineTo(c + Math.sin(a) * 214, c - Math.cos(a) * 214); g.stroke();
    }
    g.fillStyle = INK.greenDeep; g.font = '600 46px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const rom = ['XII', 'III', 'VI', 'IX'];
    for (let k = 0; k < 4; k++) { const a = k / 4 * Math.PI * 2; g.fillText(rom[k], c + Math.sin(a) * 140, c - Math.cos(a) * 140 + 2); }
    g.font = 'italic 24px Georgia, serif'; g.fillStyle = INK.goldDeep;
    g.fillText('Tom & Gerry', c, c + 72);
    drawLogo(g, c, c - 70, 34);
  }
  const clockTex = r.createTexture(clockCanvas, { srgb: true, anisotropy: 8, wrap: 'clamp' });
  for (const sz of [1, -1]) {
    const z = sz * (L.wallZ + L.end.depthF - 1.0);
    const M = mat4.fromYawTranslation(mat4.create(), sz > 0 ? Math.PI : 0, [0, L.concourseY + 4.85, z]);
    frame.tube(vec3.transformMat4([], [0, 0, -0.25], M), vec3.transformMat4([], [0, 0, 0.02], M), 1.22, 32, green, D(0.45, 0), true);
    frame.tube(vec3.transformMat4([], [0, 0, -0.05], M), vec3.transformMat4([], [0, 0, 0.06], M), 1.16, 32, gold, D(0.3, 5), false);
    // Rahmen/Aufhängung
    frame.box([0, 1.75, -0.2], [0.18, 1.1, 0.18], M, green, D(0.45, 0));
    screenQuad(clk, mat4.translate(mat4.create(), M, [0, 0, 0.035]), 2.24, 2.24);
  }
  const clockMat = r.createMaterial({
    name: 'env-clock', uniforms: { u_tex: clockTex, u_clock: [18, 47, 0] }, surface: CLOCK_SURFACE, castShadow: false,
  });

  // ---------------------------------------------------------------- Aufschlag-Geschwindigkeit (Stirnmauern)
  const spdCanvas = makeCanvas(256, 128);
  const spdTex = r.createTexture(spdCanvas, { srgb: true, anisotropy: 4, wrap: 'clamp' });
  for (const [sx, sz] of [[-1, -1], [1, 1]]) {
    const z = sz * (L.wallZ - 0.12);
    const M = mat4.fromYawTranslation(mat4.create(), sz > 0 ? Math.PI : 0, [sx * 5.25, 0.95, z]);
    frame.box([0, 0, -0.05], [1.22, 0.66, 0.12], M, dark, D(0.4, 5));
    frame.box([0, -0.36, -0.05], [1.26, 0.05, 0.14], M, gold, D(0.35, 5));
    screenQuad(spd, mat4.translate(mat4.create(), M, [0, 0.02, 0.012]), 1.1, 0.55);
  }

  const frameMesh = r.createMesh(frame.finish());
  const fin = (mb) => { const d = mb.finish(); delete d.colors; delete d.data; return r.createMesh(d); };
  const drawables = [
    { mesh: frameMesh, material: opts.structMaterial, castShadow: false },
    { mesh: fin(scr), material: screenMat, castShadow: false, receiveShadow: false },
    { mesh: fin(clk), material: clockMat, castShadow: false },
    { mesh: fin(spd), material: screenMat, uniforms: { u_tex: spdTex, u_led: [128, 64], u_bright: 2.2 }, castShadow: false, receiveShadow: false },
  ];

  // ---------------------------------------------------------------- Inhalte
  const state = { view: null, kmh: null, clockMin: -1, time: 18 * 3600 + 47 * 60 };
  const fmtTime = (t) => { const h = Math.floor(t / 3600) % 24, m = Math.floor(t / 60) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };
  const drawBoard = () => {
    const g = sbCanvas.getContext('2d');
    const W = 1024, H = 576;
    g.fillStyle = '#050f0a'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#0c2a1c'; g.fillRect(0, 0, W, 92);
    g.fillStyle = INK.gold; g.font = '600 40px Georgia, serif'; g.textBaseline = 'middle'; g.textAlign = 'left';
    g.letterSpacing = '4px'; g.fillText('TOM & GERRY OPEN', 34, 48); g.letterSpacing = '0px';
    g.textAlign = 'right'; g.fillStyle = INK.cream; g.font = '600 30px Helvetica, Arial, sans-serif';
    g.fillText('CENTRE COURT · FINALE', W - 34, 48);
    const v = state.view;
    const names = v ? v.names : ['Tom', 'Gerry'];
    const sets = v ? v.sets : [];
    const cur = v ? v.games : [0, 0];
    const pts = v ? (v.pointsText || ['0', '0']) : ['0', '0'];
    const server = v ? v.server : 0;
    // Kopfzeile Spalten
    const colX = [600, 680, 760];
    g.font = '600 26px Helvetica, Arial, sans-serif'; g.fillStyle = '#7c9a88'; g.textAlign = 'center';
    for (let k = 0; k < 3; k++) g.fillText(`S${k + 1}`, colX[k], 130);
    g.fillText('PUNKTE', 900, 130);
    for (let p = 0; p < 2; p++) {
      const y = 215 + p * 125;
      g.fillStyle = p === 0 ? '#0a1f15' : '#0a1f15'; g.fillRect(24, y - 52, W - 48, 104);
      // Aufschlag-Marker
      if (server === p && !(v && v.over)) { g.fillStyle = INK.optic; g.beginPath(); g.arc(62, y, 15, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = '#f4f1e6'; g.textAlign = 'left'; g.font = '700 64px Helvetica, Arial, sans-serif';
      g.fillText(String(names[p] || '').toUpperCase(), 98, y + 3);
      g.textAlign = 'center'; g.font = '700 62px Helvetica, Arial, sans-serif';
      const all = sets.map((s) => s.games[p]);
      const showCur = !(v && v.over);
      for (let k = 0; k < 3; k++) {
        let val = null, active = false;
        if (k < all.length) val = all[k];
        else if (k === all.length && showCur) { val = cur[p]; active = true; }
        if (val === null || val === undefined) continue;
        g.fillStyle = active ? INK.optic : '#e8c35a';
        g.fillText(String(val), colX[k], y + 3);
        const tb = k < sets.length && sets[k].tb !== null && sets[k].games[p] < sets[k].games[1 - p] ? sets[k].tb : null;
        if (tb !== null && tb !== undefined) { g.font = '600 26px Helvetica, Arial, sans-serif'; g.fillText(String(tb), colX[k] + 32, y - 26); g.font = '700 62px Helvetica, Arial, sans-serif'; }
      }
      g.fillStyle = '#ffffff'; g.font = '700 70px Helvetica, Arial, sans-serif';
      if (showCur) g.fillText(String(pts[p]), 900, y + 4);
    }
    // Fußzeile
    g.fillStyle = '#0c2a1c'; g.fillRect(0, H - 96, W, 96);
    g.textAlign = 'left'; g.font = '600 34px Helvetica, Arial, sans-serif'; g.fillStyle = '#9fb9a8';
    const call = v && v.call ? String(v.call) : '';
    g.fillText(state.kmh ? `AUFSCHLAG  ${state.kmh} KM/H` : call.toUpperCase().slice(0, 26), 34, H - 48);
    g.textAlign = 'right'; g.fillStyle = INK.cream; g.font = '700 44px Helvetica, Arial, sans-serif';
    g.fillText(fmtTime(state.time), W - 34, H - 48);
    r.updateTexture(sbTex, sbCanvas);
  };
  const drawSpeed = () => {
    const g = spdCanvas.getContext('2d');
    g.fillStyle = '#060807'; g.fillRect(0, 0, 256, 128);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffb53a'; g.font = '700 74px Helvetica, Arial, sans-serif';
    g.fillText(state.kmh ? String(state.kmh) : '---', 102, 66);
    g.fillStyle = '#d9d2c0'; g.font = '600 24px Helvetica, Arial, sans-serif';
    g.fillText('KM/H', 212, 80);
    g.fillStyle = INK.gold; g.fillRect(0, 0, 256, 6);
    r.updateTexture(spdTex, spdCanvas);
  };
  drawBoard(); drawSpeed();

  const api = {
    drawables, boards,
    /** scoreView = Score.view() aus src/sim/rules.js; extra: { serveKmh } */
    set(view, extra = {}) {
      state.view = view;
      if (extra.serveKmh !== undefined) { state.kmh = extra.serveKmh; drawSpeed(); }
      drawBoard();
    },
    setServeSpeed(kmh) { state.kmh = kmh; drawSpeed(); drawBoard(); },
    /** Uhrzeit setzen (Sekunden seit Mitternacht). */
    setTime(sec) { state.time = sec; },
    update(dt) {
      state.time += dt;
      const t = state.time;
      const U = clockMat.uniforms.u_clock;
      U[0] = Math.floor(t / 3600) % 24; U[1] = Math.floor(t / 60) % 60; U[2] = Math.floor(t % 60);
      const mn = Math.floor(t / 60);
      if (mn !== state.clockMin) { state.clockMin = mn; drawBoard(); }
    },
  };
  return api;
}

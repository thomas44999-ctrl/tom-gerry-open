// SIM-Testszene: echte Flugbahnen aller Schlagarten (Löser + Ballphysik) auf einem maßstabsgetreuen Platz.
//   dev.html?scene=trajectories[&view=broadcast|side|top|net|serve][&shots=topspin,lob,…][&surface=grass|hard|clay]
//   [&power=0.7][&t=1.2 (Zeit einfrieren)][&tubes=0][&legend=0]
// Bahnen als farbige Röhren, Aufsprünge als Ringe, animierte Bälle (Echtzeit, Schleife).
// Zeigt: Topspin-Dip + hoher Absprung, flacher Drive, rutschender Slice, Lob über Netzspieler,
// Stopp mit Unterschnitt, Aufschläge (flach/Kick/Slice mit Kurve und Seitwärts-Kick), Volley, Smash,
// Netzroller (drüber / zurück) und Netztreffer.
import { mat4, vec3, DEG } from '../../src/core/math.js';
import * as G from '../../src/gfx/geometry.js';
import { COURT, SURFACES, netHeightAt } from '../../src/sim/court.js';
import { Ball, BALL, Trajectory, predict, RPM, spinFromLocal } from '../../src/sim/ball.js';
import { solveShot, presetParams } from '../../src/sim/shot.js';
import { PLAYER_STATS } from '../../src/sim/strokes.js';

const VIEWS = {
  broadcast: { dist: 24, yaw: 0, pitch: 21, target: [0, 0.6, -1] },
  side: { dist: 160, yaw: 90, pitch: 0.4, target: [0, 3.6, -1.5], fov: 4.6 },     // nahezu orthografisch
  top: { dist: 32, yaw: 0, pitch: 88, target: [0, 0, 0] },
  net: { dist: 6.5, yaw: 70, pitch: 12, target: [0.4, 0.9, 0] },
  serve: { dist: 15, yaw: 35, pitch: 20, target: [-1.0, 1.2, 1.5] },
  default: { dist: 27, yaw: 38, pitch: 24, target: [0, 0.8, 0] },
};

// Farben (linear) je Schlagart
const COL = {
  topspin: [0.95, 0.42, 0.06], flat: [0.95, 0.85, 0.1], slice: [0.15, 0.55, 1.0], lob: [0.75, 0.3, 0.95],
  drop: [0.1, 0.85, 0.75], volley: [0.95, 0.95, 0.95], smash: [1.0, 0.12, 0.15],
  serve_flat: [1.0, 0.95, 0.55], serve_kick: [0.45, 1.0, 0.25], serve_slice: [0.3, 0.85, 1.0],
  cord_over: [1.0, 0.45, 0.7], cord_back: [0.6, 0.6, 0.6], net: [0.35, 0.35, 0.35],
};

function shotList(power) {
  const T = PLAYER_STATS.tom;
  const L = [];
  const add = (key, label, from, sol) => { if (sol && sol.ok) L.push({ key, label, from, vel: Array.from(sol.vel), spin: Array.from(sol.spin), speed: sol.speed }); };
  const S = (type, from, target, extra = {}) => solveShot({ from, target, spin: type, power, stats: T, ...extra });
  add('topspin', 'Topspin', [0.6, 1.0, 11.6], S('topspin', [0.6, 1.0, 11.6], { x: -2.2, z: -9.8 }));
  add('flat', 'Flach', [0.3, 1.0, 11.4], S('flat', [0.3, 1.0, 11.4], { x: 2.6, z: -10.2 }));
  add('slice', 'Slice', [-0.5, 0.85, 11.8], S('slice', [-0.5, 0.85, 11.8], { x: -3.4, z: -9.4 }));
  add('lob', 'Lob', [1.2, 0.8, 12.2], S('lob', [1.2, 0.8, 12.2], { x: 0.8, z: -10.6 }));
  add('drop', 'Stopp', [-1.5, 0.9, 7.5], S('drop', [-1.5, 0.9, 7.5], { x: 2.6, z: -2.0 }));
  add('volley', 'Volley', [1.0, 1.15, 2.6], S('volley', [1.0, 1.15, 2.6], { x: -3.3, z: -8.5 }));
  add('smash', 'Smash', [-0.8, 2.8, 5.5], S('smash', [-0.8, 2.8, 5.5], { x: 2.8, z: -7.5 }));
  const sv = [0.55, 2.7, 12.1];
  add('serve_flat', 'Aufschlag flach', sv, S('serve_flat', sv, { x: -0.35, z: -5.9 }));
  add('serve_kick', 'Aufschlag Kick', sv, S('serve_kick', sv, { x: -2.2, z: -5.6 }));
  add('serve_slice', 'Aufschlag Slice', sv, S('serve_slice', sv, { x: -3.6, z: -5.2 }));
  // Netzroller / Netz (feste Abflugzustände: knapp auf das Band)
  const cord = (q, speed, x) => {
    const tt = 2 / speed;
    return { from: [x, netHeightAt(x) + q * BALL.radius, 2], vel: [0, 0.5 * BALL.g * tt, -speed], spin: Array.from(spinFromLocal([0, 0, 0], 0, -1, 1500 * RPM)) };
  };
  L.push({ key: 'cord_over', label: 'Netzroller drüber', speed: 30, ...cord(0.5, 30, 1.2) });
  L.push({ key: 'cord_back', label: 'Netzroller zurück', speed: 12, ...cord(0.6, 12, -1.6) });
  L.push({ key: 'net', label: 'Netz', speed: 25, ...cord(-0.8, 25, 3.0) });
  return L;
}

export async function run({ renderer: r, devkit, params }) {
  const scene = devkit.defaultScene();
  const D = scene.drawables;
  const view = VIEWS[params.get('view', 'default')] || VIEWS.default;
  devkit.setOrbit(view);
  if (view.fov && !params.has('fov')) devkit.camera.fov = view.fov * DEG;
  scene.shadow = { center: [0, 0, 0], radius: 15 };

  const surface = SURFACES[params.get('surface', 'grass')] || SURFACES.grass;
  const power = params.num('power', 0.7);
  const filter = params.list('shots', []);

  // ---------------------------------------------------------------- Platz
  const courtMat = r.createMaterial({
    name: 'traj-court',
    uniforms: { u_a: [0.075, 0.19, 0.05], u_b: [0.10, 0.235, 0.065] },
    surface: `void surface(in SurfaceInput i, inout Surface s) {
      float st = step(0.5, fract(i.worldPos.z / 2.4));
      s.albedo = mix(u_a, u_b, st) * (0.92 + 0.16 * noise2(i.worldPos.xz * 3.0));
      s.roughness = 0.9; s.specular = 0.35; s.sheen = 0.3; s.sheenColor = vec3(0.6, 0.75, 0.45);
    }`,
  });
  const CW = (COURT.doublesHalfWidth + COURT.runoffSide) * 2, CL = (COURT.halfLength + COURT.runoffBack) * 2;
  D.push({ mesh: r.createMesh(G.plane(CW, CL, 1, 1)), material: courtMat, model: mat4.fromTranslation(mat4.create(), [0, 0.003, 0]), castShadow: false });

  const lineMat = r.createMaterial({ name: 'traj-lines', uniforms: { u_baseColor: [0.92, 0.92, 0.9] }, surface: `void surface(in SurfaceInput i, inout Surface s) { s.roughness = 0.7; }` });
  const lines = [];
  const L = (x0, z0, x1, z1) => {     // Rechteck (Außenkanten) als flache Box
    const b = G.box(Math.abs(x1 - x0), 0.004, Math.abs(z1 - z0));
    lines.push(G.transform(b, mat4.fromTranslation(mat4.create(), [(x0 + x1) / 2, 0.006, (z0 + z1) / 2])));
  };
  const HL = COURT.halfLength, SW = COURT.singlesHalfWidth, DW = COURT.doublesHalfWidth, LW = COURT.lineWidth, BW = COURT.baselineWidth;
  for (const s of [-1, 1]) {
    L(-DW, s * HL, DW, s * (HL - BW));                          // Grundlinie (10 cm, Außenkante bei ±HL)
    L(s * SW, -HL, s * (SW - LW), HL);                          // Einzel-Seitenlinie
    L(s * DW, -HL, s * (DW - LW), HL);                          // Doppel-Seitenlinie
    L(-SW, s * COURT.serviceLineZ, SW, s * (COURT.serviceLineZ - LW));   // Aufschlaglinie
    L(-COURT.centreMarkWidth / 2, s * (HL - BW), COURT.centreMarkWidth / 2, s * (HL - BW - COURT.centreMarkLength)); // Mittelzeichen
  }
  L(-COURT.centreLineHalfWidth, -COURT.serviceLineZ, COURT.centreLineHalfWidth, COURT.serviceLineZ);   // Mittellinie
  D.push({ mesh: r.createMesh(G.merge(lines)), material: lineMat, castShadow: false });

  // ---------------------------------------------------------------- Netz, Pfosten, Einzelstützen
  const N = COURT.net;
  {
    const seg = 96, pos = [], nor = [], uv = [], idx = [];
    for (let i = 0; i <= seg; i++) {
      const x = -N.postX + (2 * N.postX * i) / seg, h = netHeightAt(x);
      pos.push(x, 0, 0, x, h, 0); nor.push(0, 0, 1, 0, 0, 1); uv.push(x, 0, x, h);
      if (i < seg) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const netMat = r.createMaterial({
      name: 'traj-net', uniforms: { u_baseColor: [0.03, 0.035, 0.04] }, cull: 'none', alphaTest: 0.5,
      surface: `void surface(in SurfaceInput i, inout Surface s) {
        vec2 g = abs(fract(i.uv / 0.045) - 0.5);
        float m = step(0.40, max(g.x, g.y));
        float band = step(i.uv.y, 0.06);
        s.alpha = max(m, band); s.roughness = 0.8;
      }`,
    });
    D.push({ mesh: r.createMesh({ positions: new Float32Array(pos), normals: new Float32Array(nor), uvs: new Float32Array(uv), indices: new Uint16Array(idx) }), material: netMat });
    const tape = G.tube((t) => { const x = -N.stickX + 2 * N.stickX * t; return [x, netHeightAt(x) - 0.03, 0]; }, 0.032, 64, 8);
    const tape2 = G.tube((t) => { const x = N.stickX + (N.postX - N.stickX) * t; return [x, N.stickHeight - 0.03, 0]; }, 0.032, 8, 8);
    const tape3 = G.tube((t) => { const x = -N.postX + (N.postX - N.stickX) * t; return [x, N.stickHeight - 0.03, 0]; }, 0.032, 8, 8);
    D.push({ mesh: r.createMesh(G.merge([tape, tape2, tape3])), material: lineMat });
    const postMat = r.createMaterial({ name: 'traj-post', uniforms: { u_baseColor: [0.02, 0.09, 0.05] }, surface: `void surface(in SurfaceInput i, inout Surface s) { s.roughness = 0.35; s.metalness = 0.2; }` });
    const posts = [];
    for (const s of [-1, 1]) {
      posts.push(G.transform(G.cylinder(N.postRadius, N.postRadius, N.postHeight + 0.03, 20), mat4.fromTranslation(mat4.create(), [s * N.postX, (N.postHeight + 0.03) / 2, 0])));
      posts.push(G.transform(G.cylinder(N.stickRadius, N.stickRadius, N.stickHeight, 16), mat4.fromTranslation(mat4.create(), [s * N.stickX, N.stickHeight / 2, 0])));
    }
    D.push({ mesh: r.createMesh(G.merge(posts)), material: postMat });
  }

  // ---------------------------------------------------------------- Flugbahnen
  const trailMat = r.createMaterial({
    name: 'traj-trail', unlit: true, uniforms: { u_baseColor: [1, 1, 1] }, castShadow: false,
    surface: `void surface(in SurfaceInput i, inout Surface s) { s.albedo = u_baseColor * 0.9; s.emissive = u_baseColor * 0.35; }`,
  });
  const ballMat = r.createMaterial({
    name: 'traj-ball', uniforms: { u_baseColor: [0.75, 0.88, 0.12] },
    surface: `void surface(in SurfaceInput i, inout Surface s) { s.roughness = 0.85; s.sheen = 0.6; s.sheenColor = vec3(0.9, 1.0, 0.6); s.emissive = u_baseColor * 0.15; }`,
  });
  const ringMat = r.createMaterial({ name: 'traj-ring', unlit: true, uniforms: { u_baseColor: [1, 1, 1] }, castShadow: false, cull: 'none' });
  const ballMesh = r.createMesh(G.sphere(BALL.radius * 1.5, 20, 12));
  const ringMesh = r.createMesh(G.ring(0.06, 0.1, 32));

  let shots = shotList(power);
  if (filter.length) shots = shots.filter((s) => filter.includes(s.key));
  const tubes = params.bool('tubes', true);
  const anim = [];
  for (const s of shots) {
    const b = new Ball(); b.surface = surface;
    b.launch(s.from, s.vel, s.spin);
    const tr = predict(b, 4.5, BALL.dt, { out: new Trajectory(800), maxBounces: 3 });
    const dur = tr.duration;
    const color = COL[s.key] || [1, 1, 1];
    if (tubes) {
      const mesh = G.tube((u) => Array.from(tr.positionAt(u * dur)), params.num('thick', 0.018), Math.max(60, Math.round(dur * 140)), 6, false, false);
      D.push({ mesh: r.createMesh(mesh), material: trailMat, uniforms: { u_baseColor: color }, castShadow: false });
    }
    for (let i = 0; i < tr.bounceCount; i++) {
      const bb = tr.bounce(i);
      const m = mat4.fromTranslation(mat4.create(), [bb.pos[0], 0.012 + i * 0.001, bb.pos[2]]);
      D.push({ mesh: ringMesh, material: ringMat, model: m, uniforms: { u_baseColor: color }, castShadow: false });
    }
    const model = mat4.create();
    D.push({ mesh: ballMesh, material: ballMat, model });
    const b0 = tr.bounce(0), b1 = tr.bounce(1);
    s.info = { b0, apex: tr.apexY, clr: tr.netClearance, apex2: b0 ? tr.maxHeightBetween(b0.t + 1e-6, b1 ? b1.t : dur).y : NaN };
    anim.push({ tr, dur, model, pos: new Float64Array(3) });
  }

  // ---------------------------------------------------------------- Legende (DOM)
  if (params.bool('legend', true) && typeof document !== 'undefined') {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:60;font:11px/1.5 ui-monospace,Menlo,monospace;color:#eef;background:rgba(8,12,16,.7);padding:8px 10px;border-radius:8px;pointer-events:none';
    const hex = (c) => '#' + c.map((v) => Math.round(Math.pow(Math.min(1, v), 1 / 2.2) * 255).toString(16).padStart(2, '0')).join('');
    const rows = shots.map((s) => {
      const i = s.info, pp = presetParams(s.key.startsWith('cord') || s.key === 'net' ? 'topspin' : s.key, power);
      const rpm = s.key.startsWith('cord') || s.key === 'net' ? 1500 : pp.topRpm;
      return `<div><span style="display:inline-block;width:10px;height:10px;border-radius:5px;background:${hex(COL[s.key])};margin-right:6px"></span>` +
        `${s.label.padEnd(18, ' ')} ${String(Math.round(s.speed * 3.6)).padStart(3, ' ')} km/h ${String(Math.round(rpm)).padStart(5, ' ')} U/min` +
        ` · Netz ${Number.isFinite(i.clr) ? i.clr.toFixed(2) : ' – '} · Absprung ${Number.isFinite(i.apex2) ? i.apex2.toFixed(2) : ' – '} m</div>`;
    });
    el.innerHTML = `<div style="opacity:.7;margin-bottom:4px">Flugbahnen · ${surface.name} · power ${power}</div>` + rows.join('');
    document.body.appendChild(el);
  }

  const update = (dt, t) => {
    for (const a of anim) {
      const tt = t % (a.dur + 0.6);
      a.tr.positionAt(Math.min(tt, a.dur), a.pos);
      mat4.fromTranslation(a.model, a.pos);
    }
  };
  update(0, devkit.time);
  devkit.start({ scene, update });
  if (typeof window !== 'undefined' && window.__dev) window.__dev.shots = shots.map((s) => ({ key: s.key, speedKmh: s.speed * 3.6, ...s.info, b0: s.info.b0 ? Array.from(s.info.b0.pos) : null }));
}

// Dev-Szene für das komplette Stadion (env).
//   dev.html?scene=world[&view=broadcast|broadcastN|aerial|courtside|umpire|crowd|net|baseline|highCorner|royal|scoreboard|top]
//   [&q=low|medium|high|ultra] [&t=<s> Zeit einfrieren] [&noball=1] [&react=cheer|applause|standing|wave|ooh|quiet]
//   [&cam=dist,yaw,pitch,targetY] [&fov=deg] [&ballAt=x,y,z statischer Ball]
// Ein Fake-Ball fliegt Ballwechsel (Trail, Kopfdrehen im Publikum, Aufsprung-Effekte, Netzwackeln,
// Anzeigetafel-Updates). window.__world gibt Zugriff auf die World.
import { vec3, DEG } from '../../src/core/math.js';
import { buildWorld } from '../../src/world/world.js';
import { Score } from '../../src/sim/rules.js';

const VIEW_ALIAS = {
  broadcast: 'broadcastS', aerial: 'aerial', courtside: 'courtside', umpire: 'umpire', crowd: 'crowdNorth',
  net: 'netCam', baseline: 'behindBaselineS', highCorner: 'highCorner', royal: 'royalBox', scoreboard: 'scoreboard',
  top: 'topDown',
};

const G = -9.81;

/** Kinematischer Fake-Ballwechsel (Parabeln, Aufsprung, Ereignisse). */
class FakeRally {
  constructor() {
    this.pos = vec3.fromValues(0, 1, 11.5); this.vel = vec3.create(); this.spin = vec3.fromValues(-60, 0, 0);
    this.visible = true; this.events = []; this.t = 0; this.seg = null; this.side = 1; this.n = 0;
    this._next();
  }
  _rand(a, b) { this.n = (this.n * 9301 + 49297) % 233280; return a + (b - a) * (this.n / 233280); }
  _next() {
    // von Spielerseite s zur Gegenseite: Kontakt -> Aufsprung -> nächster Kontakt
    const s = this.side;
    const p0 = [this._rand(-3.5, 3.5), this._rand(0.8, 1.2), s * this._rand(11.0, 12.6)];
    const pb = [this._rand(-3.8, 3.8), 0.0335, -s * this._rand(4.5, 11.2)];
    const T1 = this._rand(0.85, 1.15);
    const p1 = [pb[0] + this._rand(-1.5, 1.5), this._rand(0.8, 1.2), -s * this._rand(11.5, 12.8)];
    const T2 = this._rand(0.45, 0.65);
    const v0 = [(pb[0] - p0[0]) / T1, (pb[1] - p0[1] - 0.5 * G * T1 * T1) / T1, (pb[2] - p0[2]) / T1];
    const v1 = [(p1[0] - pb[0]) / T2, (p1[1] - pb[1] - 0.5 * G * T2 * T2) / T2, (p1[2] - pb[2]) / T2];
    this.seg = { p0, pb, p1, T1, T2, v0, v1 };
    this.t = 0;
    this.spin[0] = -s * this._rand(80, 260);
    this.spin[1] = this._rand(-40, 40);
  }
  step(dt) {
    const S = this.seg;
    const t0 = this.t;
    this.t += dt;
    if (t0 < S.T1 && this.t >= S.T1) this.events.push({ type: 'bounce', pos: S.pb.slice(), in: true, speed: Math.hypot(...S.v0) });
    let p, v, t;
    if (this.t < S.T1) { t = this.t; p = S.p0; v = S.v0; }
    else { t = this.t - S.T1; p = S.pb; v = S.v1; }
    for (let k = 0; k < 3; k++) { this.pos[k] = p[k] + v[k] * t + (k === 1 ? 0.5 * G * t * t : 0); this.vel[k] = v[k] + (k === 1 ? G * t : 0); }
    // Netzdurchgang
    if (this.t < S.T1 && Math.sign(this.pos[2]) !== Math.sign(this.pos[2] - this.vel[2] * dt) && this.pos[1] < 1.6) {
      this.events.push({ type: 'net_pass', pos: [this.pos[0], this.pos[1], 0] });
    }
    if (this.t >= S.T1 + S.T2) {
      this.events.push({ type: 'hit', pos: S.p1.slice(), speed: 30 });
      this.side = -this.side; this._next();
    }
  }
  drain() { const e = this.events; this.events = []; return e; }
}

export async function run({ renderer: r, devkit, params }) {
  const qn = params.get('q', null);
  if (qn && qn !== r.q.name) r.setQuality(qn);
  const t0 = performance.now();
  const world = await buildWorld(r, { onProgress: () => {} });
  const buildMs = performance.now() - t0;
  window.__world = world; window.__r = r; window.__scene = null; window.__devkit = devkit;
  const scene = { drawables: world.drawables.slice(), time: 0 };
  world.applyTo(scene); window.__scene = scene;
  if (world.ball) scene.drawables.push(...world.ball.drawables);

  // Kamera aus Anker -> Orbit-Parameter
  const vname = params.get('view', 'broadcast');
  const anchor = world.anchors[VIEW_ALIAS[vname] || vname] || world.anchors.broadcastS;
  const off = vec3.sub(vec3.create(), anchor.position, anchor.target);
  const dist = vec3.length(off);
  devkit.setOrbit({ dist, yaw: Math.atan2(off[0], off[2]) / DEG, pitch: Math.asin(off[1] / dist) / DEG, target: anchor.target });
  if (!params.has('fov')) devkit.camera.fov = anchor.fov;
  devkit.camera.far = 900;

  // Spielstand
  const score = new Score(['Tom', 'Gerry'], { sets: 3 });
  const rally = new FakeRally();
  const useBall = !params.bool('noball', false);
  let pointTimer = 0, reactTimer = 0;
  const react = params.get('react', null);
  if (react && world.crowd) world.crowd.react(react, 1);
  if (world.scoreboard) {
    score.force?.({ sets: [[6, 4]], games: [3, 2], points: [2, 1] });
    world.scoreboard.set(score.view(), { serveKmh: 187 });
  }
  const ballState = { pos: rally.pos, vel: rally.vel, spin: rally.spin, visible: useBall };
  window.__ballState = ballState;
  const ballAt = params.list('ballAt', []);
  if (ballAt.length >= 3) { ballState.pos = ballAt.map(Number); ballState.vel = [0, 0, -25]; ballState.visible = true; }
  const info = document.createElement('div');
  info.style.cssText = 'position:fixed;left:8px;bottom:8px;font:11px monospace;color:#fff;background:#0008;padding:4px 6px;white-space:pre;pointer-events:none';
  document.body.appendChild(info);
  let infoT = 0;

  devkit.start({
    scene,
    update(dt, t) {
      const events = [];
      if (useBall && dt > 0) {
        rally.step(dt);
        for (const e of rally.drain()) {
          if (e.type === 'net_pass') { if (Math.abs(e.pos[1] - 1.0) < 0.25) events.push({ type: 'net', pos: e.pos, cord: true, speed: 20 }); continue; }
          events.push(e);
        }
      } else if (useBall && devkit.frozen) {
        // eingefrorene Zeit: Ball deterministisch vorspulen
        if (!rally._warm) { rally._warm = true; for (let k = 0; k < Math.round(t * 60); k++) { rally.step(1 / 60); if (world.ball) world.ball.update(1 / 60, ballState); } rally.drain(); }
      }
      pointTimer += dt; reactTimer += dt;
      if (pointTimer > 6 && world.scoreboard) {
        pointTimer = 0;
        score.pointWon(Math.random() < 0.5 ? 0 : 1);
        world.scoreboard.set(score.view(), { serveKmh: 160 + Math.round(Math.random() * 50) });
        if (world.crowd && !react) world.crowd.react(Math.random() < 0.5 ? 'applause' : 'cheer', 0.6 + Math.random() * 0.4);
      }
      world.update(dt, { time: t, ballPos: ballState.pos, events, excitement: 0.3, camera: devkit.camera });
      if (world.ball && !(devkit.frozen && useBall)) world.ball.update(dt, ballState);
      if (world.umpire) world.umpire.lookAt(rally.pos);
      infoT += dt;
      if (infoT > 0.5 || devkit.frozen) {
        infoT = 0;
        const s = r.stats;
        info.textContent = `world build ${buildMs.toFixed(0)} ms  draws ${s.drawCalls} (sh ${s.shadowDrawCalls})  tris ${(s.triangles / 1e6).toFixed(2)}M  update ${(world.updateMs ?? 0).toFixed(2)} ms`;
      }
    },
  });
  window.__dev.buildMs = buildMs;
}

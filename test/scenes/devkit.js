// Dev-Kit für Testszenen (dev.html?scene=<name>):
//  - Orbit-Kamera: Linksziehen dreht, Mausrad zoomt, Rechtsziehen (oder Shift/Alt+Ziehen) verschiebt.
//    URL: cam=dist,yawDeg,pitchDeg,targetY   target=x,y,z   fov=Grad
//  - defaultScene(): beleuchtete Grundszene (Sonne ~32°, später Nachmittag, Himmel, Rasenboden)
//  - start({ scene, camera?, update(dt, t) }): Renderschleife. &t=<s> friert die Zeit ein (Screenshots).
//    &speed=<k> skaliert die Zeit. &pause=1 startet pausiert; &keys=1: Leertaste pausiert/setzt fort.
import { mat4, vec3, DEG, clamp } from '../../src/core/math.js';
import { plane } from '../../src/gfx/geometry.js';

export const DEFAULT_SUN_DIR = (() => {
  // Elevation 32°, Azimut so, dass Schatten aus der Standardansicht schräg nach vorne-rechts fallen
  const el = 32 * DEG, az = -148 * DEG;
  return [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
})();

const GROUND_SURFACE = `
void surface(in SurfaceInput i, inout Surface s) {
  vec2 p = i.worldPos.xz;
  float dist = length(i.worldPos - u_cameraPos);
  float n1 = fbm2(p * 0.07, 4);
  float n2 = noise2(p * 0.9 + 13.0);
  float n3 = noise2(p * 6.0);
  vec3 col = mix(u_grassA, u_grassB, smoothstep(0.32, 0.72, n1));
  col = mix(col, u_grassC, smoothstep(0.55, 0.95, n2) * 0.45);
  col *= 0.9 + 0.22 * mix(n3, 0.5, smoothstep(8.0, 40.0, dist));
  s.albedo = col;
  s.roughness = 0.88;
  s.specular = 0.4;
  s.sheen = 0.35; s.sheenColor = vec3(0.55, 0.7, 0.4);
  float fade = 1.0 - smoothstep(6.0, 30.0, dist);
  if (fade > 0.0) {
    float h = n3 * 0.5 + noise2(p * 21.0) * 0.5;
    s.normal = bumpNormal(s.normal, i.worldPos, h, 0.004 * fade);
  }
}`;

export function createDevkit(renderer, canvas, params) {
  const P = params;
  const camParam = P.list('cam', []);
  const tgtParam = P.list('target', []);
  const frozenT = P.has('t') ? P.num('t', 0) : null;
  const speed = P.num('speed', 1);

  const orbit = {
    dist: 14, yaw: 25 * DEG, pitch: 18 * DEG, target: vec3.fromValues(0, 1, 0),
    minDist: 0.2, maxDist: 900, enabled: true, urlLocked: camParam.length > 0,
  };
  const camera = {
    position: vec3.fromValues(0, 4, 14), target: vec3.fromValues(0, 1, 0), up: [0, 1, 0],
    fov: P.num('fov', 0) > 0 ? P.num('fov', 43) * DEG : 0.75, near: 0.1, far: 900, dof: null,
  };

  const applyUrlCam = () => {
    if (camParam.length >= 1 && isFinite(camParam[0])) orbit.dist = camParam[0];
    if (camParam.length >= 2 && isFinite(camParam[1])) orbit.yaw = camParam[1] * DEG;
    if (camParam.length >= 3 && isFinite(camParam[2])) orbit.pitch = camParam[2] * DEG;
    if (camParam.length >= 4 && isFinite(camParam[3])) orbit.target[1] = camParam[3];
    if (tgtParam.length >= 3) vec3.set(orbit.target, +tgtParam[0], +tgtParam[1], +tgtParam[2]);
  };

  const updateOrbitCamera = () => {
    const cp = Math.cos(orbit.pitch), sp = Math.sin(orbit.pitch);
    camera.position[0] = orbit.target[0] + orbit.dist * Math.sin(orbit.yaw) * cp;
    camera.position[1] = orbit.target[1] + orbit.dist * sp;
    camera.position[2] = orbit.target[2] + orbit.dist * Math.cos(orbit.yaw) * cp;
    vec3.copy(camera.target, orbit.target);
  };

  const devkit = {
    renderer, canvas, params, camera, orbit,
    time: frozenT ?? 0, frozen: frozenT !== null, paused: P.bool('pause', false), speed,
    frame: 0, statsEl: null, onError: null, running: false,
    _loop: null,

    /** Orbit-Kamera setzen (Winkel in Grad). URL-Parameter cam/target haben Vorrang. */
    setOrbit({ dist, yaw, pitch, target } = {}) {
      if (dist !== undefined) orbit.dist = dist;
      if (yaw !== undefined) orbit.yaw = yaw * DEG;
      if (pitch !== undefined) orbit.pitch = pitch * DEG;
      if (target) vec3.copy(orbit.target, target);
      applyUrlCam();
      updateOrbitCamera();
      return devkit;
    },

    /** Grundszene: Sonne, Himmel, Hemisphäre, Nebel, Schatten, Post + großer Rasenboden. */
    defaultScene(opts = {}) {
      const scene = {
        drawables: [],
        sun: { dir: DEFAULT_SUN_DIR.slice(), color: [1.0, 0.87, 0.71], intensity: 4.2 },
        hemi: { sky: [0.36, 0.48, 0.70], ground: [0.15, 0.15, 0.10], intensity: 1.0 },
        sky: {},
        fog: { color: [0.58, 0.64, 0.74], density: 0.0009, heightFalloff: 0.05 },
        shadow: { center: [0, 0, 0], radius: 16 },
        exposure: 1.0,
        post: { bloom: 0.5, bloomThreshold: 1.0, vignette: 0.25, saturation: 1.05, contrast: 1.05, grain: 0.03, temperature: 0.0, lift: [0, 0, 0], gain: [1, 1, 1] },
        time: 0,
      };
      if (opts.ground !== false && renderer) {
        const size = opts.groundSize ?? 600;
        devkit.groundMaterial = devkit.groundMaterial || renderer.createMaterial({
          name: 'devkit-ground',
          uniforms: { u_grassA: [0.050, 0.115, 0.030], u_grassB: [0.080, 0.150, 0.042], u_grassC: [0.105, 0.135, 0.055] },
          surface: GROUND_SURFACE,
        });
        devkit.groundMesh = devkit.groundMesh || renderer.createMesh(plane(size, size, 1, 1));
        devkit.ground = { mesh: devkit.groundMesh, material: devkit.groundMaterial, castShadow: false, bounds: { center: [0, 0, 0], radius: size * 0.75 } };
        scene.drawables.push(devkit.ground);
      }
      return scene;
    },

    /** Renderschleife starten. update(dt, t) wird vor jedem Bild aufgerufen. */
    start({ scene, camera: cam, update, render } = {}) {
      devkit.stop();
      const useCam = cam || camera;
      let last = performance.now();
      devkit.running = true;
      const tick = (now) => {
        if (!devkit.running) return;
        devkit._loop = requestAnimationFrame(tick);
        let dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
        last = now;
        if (devkit.frozen || devkit.paused) dt = 0;
        else { dt *= devkit.speed; devkit.time += dt; }
        const t = devkit.time;
        try {
          if (!cam && orbit.enabled) updateOrbitCamera();
          if (update) update(dt, t);
          if (scene) scene.time = t;
          if (render) render(dt, t);
          else if (renderer && scene) renderer.render(scene, useCam);
        } catch (e) {
          devkit.running = false;
          cancelAnimationFrame(devkit._loop);
          if (devkit.onError) devkit.onError(e, 'frame'); else console.error(e);
          return;
        }
        devkit.frame++;
        if (typeof window !== 'undefined' && window.__dev) { window.__dev.frames = devkit.frame; if (devkit.frame >= 3) window.__dev.ready = true; }
        if (devkit.statsEl && (devkit.frame % 15 === 1)) devkit._updateStats();
      };
      devkit._loop = requestAnimationFrame(tick);
      return devkit;
    },

    stop() {
      if (devkit._loop) cancelAnimationFrame(devkit._loop);
      devkit._loop = null; devkit.running = false;
    },

    _updateStats() {
      const r = renderer; if (!r) return;
      const s = r.stats;
      devkit.statsEl.textContent =
        `${s.fps.toFixed(1)} fps  ${s.frameMs.toFixed(1)} ms  cpu ${s.cpuMs.toFixed(1)}` + (s.gpuMs ? `  gpu ${s.gpuMs.toFixed(1)}` : '') + '\n' +
        `draws ${s.drawCalls} (shadow ${s.shadowDrawCalls})  tris ${(s.triangles / 1000).toFixed(0)}k\n` +
        `${r.q.name}  ${s.width}x${s.height} @${s.renderScale.toFixed(2)}  msaa ${r.q.msaa}` + (devkit.frozen ? `  t=${devkit.time}` : '');
    },
  };

  // ---------------------------------------------------------------- Eingabe (Orbit)
  let drag = null;
  const onDown = (e) => {
    if (!orbit.enabled) return;
    const pan = e.button === 2 || e.button === 1 || e.shiftKey || e.altKey;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pan };
    try { canvas.setPointerCapture(e.pointerId); } catch {}
  };
  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.pan) {
      const h = canvas.clientHeight || 1;
      const k = (2 * Math.tan(camera.fov / 2) * orbit.dist) / h;
      const fwd = vec3.sub(vec3.create(), camera.target, camera.position); vec3.normalize(fwd, fwd);
      const right = vec3.cross(vec3.create(), fwd, [0, 1, 0]); vec3.normalize(right, right);
      const up = vec3.cross(vec3.create(), right, fwd);
      vec3.scaleAndAdd(orbit.target, orbit.target, right, -dx * k);
      vec3.scaleAndAdd(orbit.target, orbit.target, up, dy * k);
    } else {
      orbit.yaw -= dx * 0.006;
      orbit.pitch = clamp(orbit.pitch + dy * 0.005, -1.2, 1.53);
    }
  };
  const onUp = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
  const onWheel = (e) => {
    if (!orbit.enabled) return;
    e.preventDefault();
    orbit.dist = clamp(orbit.dist * Math.exp(e.deltaY * 0.0012), orbit.minDist, orbit.maxDist);
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  if (P.bool('keys', false)) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !devkit.frozen) devkit.paused = !devkit.paused;
    });
  }

  applyUrlCam();
  updateOrbitCamera();
  return devkit;
}

/** Hilfsfunktion für Szenen: Modellmatrix aus Position, Y-Rotation und Skalierung. */
export function trs(pos, yaw = 0, scale = 1, out = mat4.create()) {
  return mat4.fromYawTranslation(out, yaw, pos, scale);
}

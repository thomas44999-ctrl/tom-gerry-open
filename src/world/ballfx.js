// Ball-Visualisierung: optisch-gelber Filzball (Flaum-Glanz, weiße Naht als analytische Kurve), Rotation aus
// dem Spin, dezentes Bewegungsband (geschwindigkeitsabhängig), weicher Kontaktschatten; Ballabdrücke im Rasen
// (marks.add) und Hawk-Eye-Markierung (marks.hawkeye) für knappe Entscheidungen.
import { sphere, quad } from '../gfx/geometry.js';
import { mat4, quat, vec3 } from '../core/math.js';
import { MeshBuilder } from './mb.js';

const BALL_R = 0.0335;
// Darstellung größer als der echte Ball (Arcade-Lesbarkeit); Physik rechnet weiter mit BALL_R.
// Der sichtbare Ball wird um (VIS_R - BALL_R) angehoben, damit er beim Aufsprung auf dem Rasen aufsetzt.
const VIS_R = 0.072;
// Mindestgröße im Bild (CSS-Pixel Durchmesser): am fernen Platzende bleibt der Ball sichtbar (setView setzt die Kamera)
const MIN_PX = 8, MAX_R = 0.2;
const TRAIL_N = 26;

const BALL_SURFACE = `
void surface(in SurfaceInput i, inout Surface s) {
  vec3 p = normalize(i.objPos);
  // Naht: Nullstellen von f = y*(x^2+z^2) - A*(x^2 - z^2) auf der Einheitskugel ("Hundeknochen")
  const float A = 0.78;
  float r2 = p.x * p.x + p.z * p.z;
  float f = p.y * r2 - A * (p.x * p.x - p.z * p.z);
  vec3 g = vec3(2.0 * p.x * p.y - 2.0 * A * p.x, r2, 2.0 * p.z * p.y + 2.0 * A * p.z);
  g -= dot(g, p) * p;
  float d = abs(f) / max(length(g), 1e-3);
  float w = max(fwidth(d), 1e-4);
  float seam = 1.0 - smoothstep(0.05 - w, 0.05 + w, d);
  // Filz: leichte Flaum-Variation
  float fz = noise3(p * 18.0) * 0.5 + noise3(p * 47.0) * 0.5;
  vec3 felt = u_felt * (0.88 + 0.22 * fz);
  s.albedo = mix(felt, vec3(0.9, 0.9, 0.85), seam);
  s.roughness = mix(0.95, 0.5, seam);
  s.specular = 0.3;
  s.sheen = mix(1.0, 0.0, seam);
  s.sheenColor = vec3(1.0, 1.0, 0.75);
  s.emissive = s.albedo * u_glow;
  // heller Rand (hebt den Ball vom Rasen und von den Tribünen ab)
  float rim = pow(1.0 - saturate(dot(normalize(i.normal), i.viewDir)), 2.0);
  s.emissive += vec3(1.0, 1.0, 0.55) * rim * u_rim;
}`;

const TRAIL_VERTEX = `
void vertexWorld(inout vec3 wp, inout vec3 wn) {
  vec3 tng = normalize(wn + vec3(1e-5, 0.0, 0.0));
  vec3 vd = normalize(u_cameraPos - wp);
  vec3 side = normalize(cross(tng, vd) + vec3(0.0, 1e-5, 0.0));
  float age = a_data.y;
  float wdt = u_width * (1.0 - age * 0.75);
  wp += side * a_data.x * wdt;
  wn = vd;
}`;

const TRAIL_SURFACE = `
void surface(in SurfaceInput i, inout Surface s) {
  float age = i.data.y;
  float edge = 1.0 - abs(i.data.x);
  float a = (1.0 - age) * (1.0 - age) * smoothstep(0.0, 0.8, edge) * i.data.z * u_alpha;
  s.albedo = vec3(0.0);
  s.emissive = u_color * a;
  s.alpha = a;
}`;

const BLOB_SURFACE = `
void surface(in SurfaceInput i, inout Surface s) {
  vec2 c = i.uv * 2.0 - 1.0;
  float r = dot(c, c);
  float a = exp(-r * 3.2) * (1.0 - smoothstep(0.7, 1.0, r));
  s.albedo = vec3(0.18, 0.22, 0.14);
  s.alpha = a * u_strength;
}`;

const MARK_VERTEX = `
void vertexObject(inout vec3 p, inout vec3 n) { p.y += 0.0; }`;

const MARK_SURFACE = `
void surface(in SurfaceInput i, inout Surface s) {
  vec2 c = i.uv * 2.0 - 1.0;
  float r = length(c);
  float fade = i.instData.x;
  float a = (1.0 - smoothstep(0.55, 1.0, r)) * fade;
  float streak = 0.75 + 0.25 * noise2(vec2(c.x * 3.0, c.y * 14.0) + i.instData.y * 17.0);
  s.albedo = mix(vec3(0.42, 0.52, 0.32), vec3(0.62, 0.58, 0.46), i.instData.z) * streak;
  s.roughness = 0.95;
  s.alpha = a * 0.55;
}`;

const HAWK_SURFACE = `
void surface(in SurfaceInput i, inout Surface s) {
  vec2 c = i.uv * 2.0 - 1.0;
  float r = length(c);
  float aa = fwidth(r) * 1.5;
  float fill = 1.0 - smoothstep(0.78 - aa, 0.78 + aa, r);
  float ring = smoothstep(0.78 - aa, 0.78 + aa, r) * (1.0 - smoothstep(1.0 - aa * 2.0, 1.0, r));
  float pulse = 0.85 + 0.15 * sin(u_time * 6.0);
  vec3 fillCol = vec3(0.95, 0.97, 0.9);
  vec3 col = fillCol * fill + u_verdict * ring * 1.4;
  s.albedo = vec3(0.0);
  s.emissive = col * pulse * u_intensity;
  s.alpha = max(fill * 0.9, ring) * u_intensity;
}`;

export function buildBallFx(r, q) {
  // ---------------------------------------------------------------- Ball
  const ballMat = r.createMaterial({
    name: 'env-ball',
    uniforms: { u_felt: [0.66, 0.86, 0.04], u_glow: 0.22, u_rim: 0.55 },
    surface: BALL_SURFACE,
  });
  const ballModel = mat4.create();
  const ball = { mesh: r.createMesh(sphere(VIS_R, 28, 18)), material: ballMat, model: ballModel, bounds: { center: [0, 0, 0], radius: VIS_R * 1.5 } };
  const rot = quat.create();

  // ---------------------------------------------------------------- Bewegungsband
  const tb = new MeshBuilder();
  for (let i = 0; i < TRAIL_N; i++) {
    tb.v(0, 0, 0, 0, 0, 1, 0, 0, [1, 1, 1, 1], [-1, i / (TRAIL_N - 1), 0, 0]);
    tb.v(0, 0, 0, 0, 0, 1, 0, 0, [1, 1, 1, 1], [1, i / (TRAIL_N - 1), 0, 0]);
  }
  for (let i = 0; i < TRAIL_N - 1; i++) { const k = i * 2; tb.tri(k, k + 2, k + 3); tb.tri(k, k + 3, k + 1); }
  const trailData = tb.finish({ dynamic: true });
  delete trailData.colors; delete trailData.uvs;
  const trailMesh = r.createMesh(trailData);
  const trailMat = r.createMaterial({
    name: 'env-trail',
    uniforms: { u_width: VIS_R * 0.95, u_color: [1.0, 1.0, 0.7], u_alpha: 0.5 },
    vertex: TRAIL_VERTEX, surface: TRAIL_SURFACE,
    blend: 'alpha', unlit: true, depthWrite: false, cull: 'none', castShadow: false,
  });
  const trail = { mesh: trailMesh, material: trailMat, pass: 'transparent', castShadow: false, bounds: { center: [0, 1, 0], radius: 60 }, visible: false };
  const hist = Array.from({ length: TRAIL_N }, () => ({ p: [0, 0, 0], v: 0 }));
  let histCount = 0;
  const tPos = trailData.positions, tNrm = trailData.normals, tDat = trailData.data;
  const trailUpd = { positions: tPos, normals: tNrm, data: tDat };

  // ---------------------------------------------------------------- Kontaktschatten
  const blobMat = r.createMaterial({
    name: 'env-ballblob', uniforms: { u_strength: 0.35 }, surface: BLOB_SURFACE,
    blend: 'multiply', unlit: true, depthWrite: false, castShadow: false,
  });
  const blobModel = mat4.create();
  const _vp = [0, 0, 0];
  let viewCam = null, viewH = 720;
  const blobGeo = quad(1, 1);
  // quad liegt in XY -> auf den Boden drehen
  const rx = mat4.fromQuat(mat4.create(), quat.setAxisAngle(quat.create(), [1, 0, 0], -Math.PI / 2));
  const blobMB = new MeshBuilder(); blobMB.add(blobGeo, rx);
  const blobData = blobMB.finish(); delete blobData.colors; delete blobData.data;
  const blob = { mesh: r.createMesh(blobData), material: blobMat, model: blobModel, pass: 'transparent', castShadow: false, order: -1, bounds: { center: [0, 0, 0], radius: 0.6 } };

  const visual = {
    drawables: [ball, trail, blob],
    radius: VIS_R,
    /** Kamera + Bildhöhe (CSS-Pixel) für die Mindestgröße im Bild. */
    setView(camera, height) { viewCam = camera; viewH = Math.max(240, height || 720); },
    /** ballState: { pos, vel, spin, visible } */
    update(dt, st) {
      const vis = st && st.visible !== false && st.pos;
      ball.visible = !!vis; blob.visible = !!vis;
      if (!vis) { histCount = 0; trail.visible = false; return; }
      const p = st.pos;
      // Rotation aus Winkelgeschwindigkeit (Welt)
      const w = st.spin;
      if (w && dt > 0) {
        const wl = Math.hypot(w[0], w[1], w[2]);
        if (wl > 1e-3) {
          const dq = quat.setAxisAngle(quat.create(), [w[0] / wl, w[1] / wl, w[2] / wl], Math.min(wl * dt, 1.5));
          quat.multiply(rot, dq, rot); quat.normalize(rot, rot);
        }
      }
      // sichtbarer Radius: mindestens MIN_PX im Bild; angehoben, damit der Ball beim Aufsprung auf dem Rasen aufsetzt
      let vr = VIS_R;
      if (viewCam) {
        const c = viewCam.position, d = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]);
        vr = Math.min(MAX_R, Math.max(VIS_R, d * Math.tan((viewCam.fov || 0.75) * 0.5) * MIN_PX / viewH));
      }
      const lift = vr - BALL_R;
      visual.drawRadius = vr;
      _vp[0] = p[0]; _vp[1] = p[1] + lift; _vp[2] = p[2];
      mat4.fromRotationTranslation(ballModel, rot, _vp);
      if (vr !== VIS_R) { const k = vr / VIS_R; mat4.scale(ballModel, ballModel, [k, k, k]); }
      trailMat.uniforms.u_width = vr * 0.95;
      // Kontaktschatten: kräftig und klein, wächst nur wenig mit der Höhe (zeigt, wo der Ball gerade ist)
      const h = Math.max(0, p[1] - BALL_R);
      const sz = 0.17 + h * 0.035;
      mat4.fromTranslation(blobModel, [p[0], 0.004, p[2]]);
      mat4.scale(blobModel, blobModel, [sz, 1, sz]);
      blobMat.uniforms.u_strength = 0.75 / (1 + h * 0.45) * (p[1] < 9 ? 1 : 0);
      // Band: Verlauf der letzten Positionen
      const sp = st.vel ? Math.hypot(st.vel[0], st.vel[1], st.vel[2]) : 0;
      if (dt > 0) {
        const last = hist[TRAIL_N - 1];
        hist.copyWithin(1, 0);
        hist[0] = last;
        last.p[0] = p[0]; last.p[1] = p[1] + lift; last.p[2] = p[2]; last.v = sp;
        histCount = Math.min(TRAIL_N, histCount + 1);
      }
      const k = Math.min(1, Math.max(0, (sp - 6) / 12));
      trail.visible = histCount > 3 && k > 0.01;
      if (trail.visible) {
        for (let i = 0; i < TRAIL_N; i++) {
          const a = hist[Math.min(i, histCount - 1)].p;
          const b = hist[Math.min(i + 1, histCount - 1)].p;
          const c = hist[Math.max(i - 1, 0)].p;
          let tx = c[0] - b[0], ty = c[1] - b[1], tz = c[2] - b[2];
          if (Math.abs(tx) + Math.abs(ty) + Math.abs(tz) < 1e-6) { tx = 0; ty = 0; tz = 1; }
          for (let s2 = 0; s2 < 2; s2++) {
            const o = (i * 2 + s2);
            tPos[o * 3] = a[0]; tPos[o * 3 + 1] = a[1]; tPos[o * 3 + 2] = a[2];
            tNrm[o * 3] = tx; tNrm[o * 3 + 1] = ty; tNrm[o * 3 + 2] = tz;
            tDat[o * 4 + 2] = i < histCount ? k : 0;
          }
        }
        r.updateMesh(trailMesh, trailUpd);
      }
    },
  };

  // ---------------------------------------------------------------- Abdrücke + Hawk-Eye
  const MAXM = 48;
  const markInst = r.createInstances(MAXM);
  const markMat = r.createMaterial({
    name: 'env-mark', vertex: MARK_VERTEX, surface: MARK_SURFACE,
    blend: 'alpha', depthWrite: false, castShadow: false, polygonOffset: [-1, -2],
  });
  const markMB = new MeshBuilder(); markMB.add(quad(1, 1), rx);
  const markData = markMB.finish(); delete markData.colors; delete markData.data;
  const markDraw = { mesh: r.createMesh(markData), material: markMat, instances: markInst, pass: 'transparent', castShadow: false, order: -2, receiveShadow: true };
  const marks = [];
  const hawkMat = r.createMaterial({
    name: 'env-hawkeye', uniforms: { u_verdict: [0.2, 1.0, 0.35], u_intensity: 1 }, surface: HAWK_SURFACE,
    blend: 'alpha', unlit: true, depthWrite: false, castShadow: false, polygonOffset: [-2, -4],
  });
  const hawkModel = mat4.create();
  const hawk = { mesh: r.createMesh(markData), material: hawkMat, model: hawkModel, pass: 'transparent', castShadow: false, order: -1, visible: false, bounds: { center: [0, 0, 0], radius: 0.3 } };
  const _m = mat4.create();
  const _md = [0, 0, 0, 0];
  const markApi = {
    drawables: [markDraw, hawk],
    /** Ballabdruck: pos (Welt), dir (Flugrichtung, optional), soil (0..1 Erde statt Gras). */
    add(pos, dir, soil = 0) {
      const ang = dir ? Math.atan2(dir[0], dir[2]) : Math.random() * Math.PI;
      marks.push({ x: pos[0], z: pos[2], ang, age: 0, seed: Math.random(), soil });
      if (marks.length > MAXM) marks.shift();
      markApi._dirty = true;
    },
    /** Hawk-Eye-Markierung: verdict 'in' | 'out' (oder true/false). dir = Flugrichtung (optional). */
    hawkeye(pos, verdict = 'in', dir = null) {
      const ang = dir ? Math.atan2(dir[0], dir[2]) : 0;
      mat4.fromYawTranslation(hawkModel, ang, [pos[0], 0.006, pos[2]]);
      mat4.scale(hawkModel, hawkModel, [0.075, 1, 0.12]);
      const isIn = verdict === true || verdict === 'in';
      hawkMat.uniforms.u_verdict = isIn ? [0.25, 1.0, 0.4] : [1.0, 0.18, 0.12];
      hawk.visible = true;
      // bounds sind lokal (Renderer transformiert mit model) -> Zentrum bleibt [0,0,0]
      hawk.bounds.center = [0, 0, 0];
    },
    clearHawkeye() { hawk.visible = false; },
    clear() { marks.length = 0; markApi._dirty = true; },
    update(dt) {
      if (!marks.length) { markInst.count = 0; return; }
      for (let i = marks.length - 1; i >= 0; i--) { marks[i].age += dt; if (marks[i].age > 40) marks.splice(i, 1); }
      for (let i = 0; i < marks.length; i++) {
        const mk = marks[i];
        mat4.fromYawTranslation(_m, mk.ang, [mk.x, 0.003, mk.z]);
        mat4.scale(_m, _m, [0.07, 1, 0.16]);
        const fade = Math.min(1, mk.age * 8) * (1 - Math.min(1, Math.max(0, (mk.age - 25) / 15)));
        _md[0] = fade; _md[1] = mk.seed; _md[2] = mk.soil;
        markInst.set(i, _m, null, _md);
      }
      markInst.count = marks.length;
      markInst.dirty = true;
    },
  };
  void vec3;
  return { ball: visual, marks: markApi };
}

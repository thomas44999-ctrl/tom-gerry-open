// Partikel: CPU-simulierte Billboards. Grasschnipsel (alpha-getestet, opak) bei Aufsprüngen, Kreidewolke bei
// Linientreffern, Staub auf abgenutzten Stellen, feine Fasern beim Netztreffer (weich, transparent).
import { quad } from '../gfx/geometry.js';
import { mat4 } from '../core/math.js';

const BILLBOARD_VERTEX = `
vec2 g_corner;
void vertexObject(inout vec3 p, inout vec3 n) { g_corner = a_uv * 2.0 - 1.0; p = vec3(0.0); }
void vertexWorld(inout vec3 wp, inout vec3 wn) {
  float size = g_instData.x, ang = g_instData.y;
  float c = cos(ang), s = sin(ang);
  vec2 q = vec2(g_corner.x * c - g_corner.y * s, g_corner.x * s + g_corner.y * c);
  wp += (u_cameraRight * q.x * g_instData.w + u_cameraUp * q.y) * size;
  wn = normalize(u_cameraPos - wp);
}`;

const BITS_SURFACE = `
void surface(in SurfaceInput i, inout Surface s) {
  vec2 c = i.uv * 2.0 - 1.0;
  float a = 1.0 - smoothstep(0.55, 1.0, length(c * vec2(1.0, 1.0)));
  s.albedo = i.instColor.rgb;
  s.alpha = a * step(0.02, i.instColor.a);
  s.roughness = 0.7;
  s.sheen = 0.4; s.sheenColor = vec3(0.6, 0.8, 0.4);
  s.subsurface = 0.6; s.subsurfaceColor = vec3(0.4, 0.8, 0.2);
}`;

const PUFF_SURFACE = `
void surface(in SurfaceInput i, inout Surface s) {
  vec2 c = i.uv * 2.0 - 1.0;
  float r = dot(c, c);
  float n = noise2(c * 2.5 + i.instData.z * 13.0);
  float a = exp(-r * 2.8) * (0.7 + 0.6 * n) * (1.0 - smoothstep(0.75, 1.0, r));
  s.albedo = i.instColor.rgb;
  s.alpha = a * i.instColor.a;
  s.roughness = 1.0; s.specular = 0.0;
  s.normal = normalize(i.normal + vec3(0.0, 0.6, 0.0));
}`;

export function buildParticles(r, q) {
  const scale = q.particleScale ?? 1;
  const MAX_BITS = 96, MAX_PUFF = 96;
  const bitsInst = r.createInstances(MAX_BITS);
  const puffInst = r.createInstances(MAX_PUFF);
  const mesh = r.createMesh(quad(1, 1));
  const bitsMat = r.createMaterial({ name: 'env-fx-bits', vertex: BILLBOARD_VERTEX, surface: BITS_SURFACE, alphaTest: 0.5, cull: 'none', castShadow: false });
  const puffMat = r.createMaterial({ name: 'env-fx-puff', vertex: BILLBOARD_VERTEX, surface: PUFF_SURFACE, blend: 'alpha', depthWrite: false, cull: 'none', castShadow: false });
  const dBits = { mesh, material: bitsMat, instances: bitsInst, castShadow: false, receiveShadow: false };
  const dPuff = { mesh, material: puffMat, instances: puffInst, pass: 'transparent', castShadow: false, receiveShadow: false };
  const bits = [], puffs = [];
  const m = mat4.create();
  const col = [0, 0, 0, 1], dat = [0, 0, 0, 1];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const push = (arr, max, p) => { if (arr.length >= max) arr.shift(); arr.push(p); };

  const fx = {
    drawables: [dBits, dPuff],
    /** kind: 'grass' | 'chalk' | 'dust' | 'netShake'; pos (Welt), vel (Ballgeschwindigkeit, optional) */
    emit(kind, pos, vel) {
      const vx = vel ? vel[0] : 0, vz = vel ? vel[2] : 0;
      const sp = vel ? Math.hypot(vel[0], vel[1], vel[2]) : 15;
      const k = Math.min(1.5, 0.5 + sp / 30);
      if (kind === 'grass') {
        const n = Math.round(rnd(5, 9) * scale * k);
        for (let i = 0; i < n; i++) {
          const g = rnd(0.7, 1.1);
          push(bits, MAX_BITS, {
            p: [pos[0] + rnd(-0.04, 0.04), 0.02, pos[2] + rnd(-0.04, 0.04)],
            v: [vx * rnd(0.04, 0.12) + rnd(-0.5, 0.5), rnd(0.8, 2.2) * k, vz * rnd(0.04, 0.12) + rnd(-0.5, 0.5)],
            life: rnd(0.6, 1.1), age: 0, size: rnd(0.008, 0.016), ang: rnd(0, 6.28), spin: rnd(-12, 12), aspect: rnd(0.25, 0.45),
            c: [0.09 * g, 0.2 * g, 0.045 * g],
          });
        }
      } else if (kind === 'chalk' || kind === 'dust') {
        const chalk = kind === 'chalk';
        const n = Math.round((chalk ? rnd(7, 11) : rnd(5, 8)) * scale * k);
        for (let i = 0; i < n; i++) {
          push(puffs, MAX_PUFF, {
            p: [pos[0] + rnd(-0.05, 0.05), rnd(0.02, 0.06), pos[2] + rnd(-0.05, 0.05)],
            v: [vx * rnd(0.05, 0.15) + rnd(-0.35, 0.35), rnd(0.15, 0.6), vz * rnd(0.05, 0.15) + rnd(-0.35, 0.35)],
            life: rnd(0.7, 1.4) * (chalk ? 1 : 1.3), age: 0, size0: rnd(0.03, 0.06), size1: rnd(0.14, 0.28) * (chalk ? 1 : 1.4),
            ang: rnd(0, 6.28), spin: rnd(-1, 1), seed: Math.random(),
            c: chalk ? [0.9, 0.9, 0.86] : [0.42, 0.34, 0.22], a: chalk ? 0.55 : 0.4,
          });
        }
        if (chalk) fx.emit('grass', pos, vel);
      } else if (kind === 'netShake') {
        const n = Math.round(5 * scale);
        for (let i = 0; i < n; i++) {
          push(puffs, MAX_PUFF, {
            p: [pos[0] + rnd(-0.2, 0.2), Math.max(0.1, pos[1]) + rnd(-0.1, 0.1), rnd(-0.03, 0.03)],
            v: [rnd(-0.2, 0.2), rnd(-0.1, 0.25), rnd(-0.3, 0.3)],
            life: rnd(0.5, 0.9), age: 0, size0: 0.02, size1: rnd(0.06, 0.1), ang: rnd(0, 6.28), spin: rnd(-1, 1), seed: Math.random(),
            c: [0.8, 0.8, 0.76], a: 0.3,
          });
        }
      }
    },
    update(dt) {
      // Grasschnipsel
      let nb = 0;
      for (let i = bits.length - 1; i >= 0; i--) {
        const b = bits[i];
        b.age += dt;
        if (b.age > b.life) { bits.splice(i, 1); continue; }
        b.v[1] -= 9.81 * dt * 0.55;
        const drag = Math.exp(-3.5 * dt);
        b.v[0] *= drag; b.v[2] *= drag; b.v[1] *= Math.exp(-1.2 * dt);
        b.p[0] += b.v[0] * dt; b.p[1] += b.v[1] * dt; b.p[2] += b.v[2] * dt;
        if (b.p[1] < 0.005) { b.p[1] = 0.005; b.v[0] = b.v[1] = b.v[2] = 0; b.spin = 0; }
        b.ang += b.spin * dt;
      }
      for (const b of bits) {
        mat4.fromTranslation(m, b.p);
        col[0] = b.c[0]; col[1] = b.c[1]; col[2] = b.c[2]; col[3] = 1 - Math.max(0, (b.age - b.life * 0.7) / (b.life * 0.3));
        dat[0] = b.size; dat[1] = b.ang; dat[2] = 0; dat[3] = b.aspect;
        bitsInst.set(nb++, m, col, dat);
      }
      bitsInst.count = nb; if (nb) bitsInst.dirty = true;
      // Wolken
      let np = 0;
      for (let i = puffs.length - 1; i >= 0; i--) {
        const p = puffs[i];
        p.age += dt;
        if (p.age > p.life) { puffs.splice(i, 1); continue; }
        const drag = Math.exp(-2.2 * dt);
        p.v[0] *= drag; p.v[1] = p.v[1] * drag + 0.05 * dt; p.v[2] *= drag;
        p.p[0] += p.v[0] * dt; p.p[1] += p.v[1] * dt; p.p[2] += p.v[2] * dt;
        p.ang += p.spin * dt;
      }
      for (const p of puffs) {
        const t = p.age / p.life;
        mat4.fromTranslation(m, p.p);
        col[0] = p.c[0]; col[1] = p.c[1]; col[2] = p.c[2]; col[3] = p.a * Math.min(1, t * 8) * (1 - t) * (1 - t);
        dat[0] = p.size0 + (p.size1 - p.size0) * (1 - (1 - t) * (1 - t)); dat[1] = p.ang; dat[2] = p.seed; dat[3] = 1;
        puffInst.set(np++, m, col, dat);
      }
      puffInst.count = np; if (np) puffInst.dirty = true;
    },
    get count() { return bits.length + puffs.length; },
  };
  return fx;
}

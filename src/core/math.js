// Mathematik-Kern. API bewusst kompatibel zu gl-matrix (Teilmenge): Out-Parameter zuerst,
// Matrizen spaltenweise (column-major) als Float32Array(16), Quaternionen als [x, y, z, w].
// Konvention im ganzen Projekt: rechtshändig, Y nach oben, Meter, Sekunden, Radiant.

const EPS = 1e-6;

// ---------------------------------------------------------------- Skalar-Helfer
export const PI = Math.PI, TAU = Math.PI * 2, DEG = Math.PI / 180;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, x) => (a === b ? 0 : (x - a) / (b - a));
export const remap = (x, a0, a1, b0, b1, clampIt = true) => {
  let t = invLerp(a0, a1, x); if (clampIt) t = saturate(t); return b0 + (b1 - b0) * t;
};
export const smoothstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const smootherstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * t * (t * (t * 6 - 15) + 10); };
/** Bildratenunabhängiges exponentielles Annähern: damp(current, target, lambda, dt). lambda ~ 1/Zeitkonstante. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
/** Winkel auf (-PI, PI] normieren. */
export const wrapAngle = (a) => { a = (a + PI) % TAU; if (a < 0) a += TAU; return a - PI; };
export const angleLerp = (a, b, t) => a + wrapAngle(b - a) * t;
export const dampAngle = (a, b, lambda, dt) => a + wrapAngle(b - a) * (1 - Math.exp(-lambda * dt));
export const sign = (x) => (x < 0 ? -1 : 1);
export const fract = (x) => x - Math.floor(x);
export const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
export const easeOutBack = (t, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
export const easeOutElastic = (t) => t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1;

/** Kritisch gedämpfte Feder (SmoothDamp). state = { v: Geschwindigkeit }. Gibt neuen Wert zurück. */
export function smoothDamp(current, target, state, smoothTime, dt, maxSpeed = Infinity) {
  smoothTime = Math.max(0.0001, smoothTime);
  const omega = 2 / smoothTime, x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  let change = current - target;
  const maxChange = maxSpeed * smoothTime;
  change = clamp(change, -maxChange, maxChange);
  const tgt = current - change;
  const temp = (state.v + omega * change) * dt;
  state.v = (state.v - omega * temp) * exp;
  let out = tgt + (change + temp) * exp;
  if ((target - current > 0) === (out > target)) { out = target; state.v = (out - target) / dt; }
  return out;
}

// ---------------------------------------------------------------- Zufall (deterministisch)
/** Mulberry32 – schneller, deterministischer PRNG. rng() liefert [0,1). */
export function makeRng(seed = 1) {
  let s = seed >>> 0;
  const rng = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (a, b) => a + (b - a) * rng();
  rng.int = (a, b) => Math.floor(a + (b - a + 1) * rng()); // inklusive a..b
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.sign = () => (rng() < 0.5 ? -1 : 1);
  rng.gauss = () => { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v); };
  rng.state = () => s; rng.setState = (v) => { s = v >>> 0; };
  return rng;
}
/** Ganzzahl-Hash (für prozedurale Muster). */
export function hash32(x) {
  x |= 0; x = Math.imul(x ^ (x >>> 16), 0x7feb352d); x = Math.imul(x ^ (x >>> 15), 0x846ca68b); return (x ^ (x >>> 16)) >>> 0;
}
export const hash01 = (x) => hash32(x) / 4294967296;
export const hash2 = (x, y) => hash01(Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663));
export const hash3 = (x, y, z) => hash01(Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791));

/** Wertrauschen 3D in [0,1] (glatt, CPU-seitig, z.B. für prozedurale Geometrie). */
export function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const h = (a, b, c) => hash3(xi + a, yi + b, zi + c);
  const x00 = lerp(h(0, 0, 0), h(1, 0, 0), u), x10 = lerp(h(0, 1, 0), h(1, 1, 0), u);
  const x01 = lerp(h(0, 0, 1), h(1, 0, 1), u), x11 = lerp(h(0, 1, 1), h(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}
export function fbm3(x, y, z, octaves = 4) {
  let a = 0.5, f = 1, s = 0, n = 0;
  for (let i = 0; i < octaves; i++) { s += a * noise3(x * f, y * f, z * f); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}

// ---------------------------------------------------------------- vec2
export const vec2 = {
  create: () => new Float32Array(2),
  fromValues: (x, y) => { const o = new Float32Array(2); o[0] = x; o[1] = y; return o; },
  set: (o, x, y) => { o[0] = x; o[1] = y; return o; },
  copy: (o, a) => { o[0] = a[0]; o[1] = a[1]; return o; },
  add: (o, a, b) => { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; return o; },
  sub: (o, a, b) => { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; return o; },
  scale: (o, a, s) => { o[0] = a[0] * s; o[1] = a[1] * s; return o; },
  length: (a) => Math.hypot(a[0], a[1]),
  normalize: (o, a) => { const l = Math.hypot(a[0], a[1]); const k = l > EPS ? 1 / l : 0; o[0] = a[0] * k; o[1] = a[1] * k; return o; },
  dot: (a, b) => a[0] * b[0] + a[1] * b[1],
  distance: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]),
  lerp: (o, a, b, t) => { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; return o; },
};

// ---------------------------------------------------------------- vec3
export const vec3 = {
  create: () => new Float32Array(3),
  fromValues: (x, y, z) => { const o = new Float32Array(3); o[0] = x; o[1] = y; o[2] = z; return o; },
  clone: (a) => { const o = new Float32Array(3); o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; },
  set: (o, x, y, z) => { o[0] = x; o[1] = y; o[2] = z; return o; },
  copy: (o, a) => { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; },
  add: (o, a, b) => { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; },
  sub: (o, a, b) => { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; },
  subtract: (o, a, b) => vec3.sub(o, a, b),
  mul: (o, a, b) => { o[0] = a[0] * b[0]; o[1] = a[1] * b[1]; o[2] = a[2] * b[2]; return o; },
  multiply: (o, a, b) => vec3.mul(o, a, b),
  scale: (o, a, s) => { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; },
  scaleAndAdd: (o, a, b, s) => { o[0] = a[0] + b[0] * s; o[1] = a[1] + b[1] * s; o[2] = a[2] + b[2] * s; return o; },
  negate: (o, a) => { o[0] = -a[0]; o[1] = -a[1]; o[2] = -a[2]; return o; },
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (o, a, b) => {
    const ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2];
    o[0] = ay * bz - az * by; o[1] = az * bx - ax * bz; o[2] = ax * by - ay * bx; return o;
  },
  length: (a) => Math.hypot(a[0], a[1], a[2]),
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  squaredLength: (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2],
  distance: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  squaredDistance: (a, b) => { const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2]; return x * x + y * y + z * z; },
  normalize: (o, a) => {
    const l = Math.hypot(a[0], a[1], a[2]); const k = l > EPS ? 1 / l : 0;
    o[0] = a[0] * k; o[1] = a[1] * k; o[2] = a[2] * k; return o;
  },
  lerp: (o, a, b, t) => { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o; },
  min: (o, a, b) => { o[0] = Math.min(a[0], b[0]); o[1] = Math.min(a[1], b[1]); o[2] = Math.min(a[2], b[2]); return o; },
  max: (o, a, b) => { o[0] = Math.max(a[0], b[0]); o[1] = Math.max(a[1], b[1]); o[2] = Math.max(a[2], b[2]); return o; },
  equals: (a, b, eps = EPS) => Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps,
  /** Punkt mit 4x4-Matrix transformieren (w=1, mit perspektivischer Division). */
  transformMat4: (o, a, m) => {
    const x = a[0], y = a[1], z = a[2];
    let w = m[3] * x + m[7] * y + m[11] * z + m[15]; w = w || 1;
    o[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    o[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    o[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    return o;
  },
  /** Richtung mit 4x4-Matrix transformieren (w=0). */
  transformDirMat4: (o, a, m) => {
    const x = a[0], y = a[1], z = a[2];
    o[0] = m[0] * x + m[4] * y + m[8] * z;
    o[1] = m[1] * x + m[5] * y + m[9] * z;
    o[2] = m[2] * x + m[6] * y + m[10] * z;
    return o;
  },
  transformMat3: (o, a, m) => {
    const x = a[0], y = a[1], z = a[2];
    o[0] = x * m[0] + y * m[3] + z * m[6]; o[1] = x * m[1] + y * m[4] + z * m[7]; o[2] = x * m[2] + y * m[5] + z * m[8];
    return o;
  },
  transformQuat: (o, a, q) => {
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3], x = a[0], y = a[1], z = a[2];
    let uvx = qy * z - qz * y, uvy = qz * x - qx * z, uvz = qx * y - qy * x;
    let uuvx = qy * uvz - qz * uvy, uuvy = qz * uvx - qx * uvz, uuvz = qx * uvy - qy * uvx;
    const w2 = qw * 2; uvx *= w2; uvy *= w2; uvz *= w2; uuvx *= 2; uuvy *= 2; uuvz *= 2;
    o[0] = x + uvx + uuvx; o[1] = y + uvy + uuvy; o[2] = z + uvz + uuvz; return o;
  },
  rotateY: (o, a, origin, rad) => {
    const px = a[0] - origin[0], pz = a[2] - origin[2], c = Math.cos(rad), s = Math.sin(rad);
    o[0] = origin[0] + pz * s + px * c; o[1] = a[1]; o[2] = origin[2] + pz * c - px * s; return o;
  },
  angle: (a, b) => {
    const d = Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]);
    return d > 0 ? Math.acos(clamp(vec3.dot(a, b) / d, -1, 1)) : 0;
  },
  /** Frame-unabhängiges Annähern eines Vektors. */
  damp: (o, a, b, lambda, dt) => vec3.lerp(o, a, b, 1 - Math.exp(-lambda * dt)),
  str: (a, d = 2) => `(${a[0].toFixed(d)}, ${a[1].toFixed(d)}, ${a[2].toFixed(d)})`,
};

// ---------------------------------------------------------------- vec4
export const vec4 = {
  create: () => new Float32Array(4),
  fromValues: (x, y, z, w) => { const o = new Float32Array(4); o[0] = x; o[1] = y; o[2] = z; o[3] = w; return o; },
  set: (o, x, y, z, w) => { o[0] = x; o[1] = y; o[2] = z; o[3] = w; return o; },
  copy: (o, a) => { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; o[3] = a[3]; return o; },
  transformMat4: (o, a, m) => {
    const x = a[0], y = a[1], z = a[2], w = a[3];
    o[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
    o[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
    o[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
    o[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
    return o;
  },
};

// ---------------------------------------------------------------- quat  [x, y, z, w]
export const quat = {
  create: () => { const o = new Float32Array(4); o[3] = 1; return o; },
  fromValues: (x, y, z, w) => { const o = new Float32Array(4); o[0] = x; o[1] = y; o[2] = z; o[3] = w; return o; },
  clone: (a) => { const o = new Float32Array(4); o.set(a); return o; },
  identity: (o) => { o[0] = 0; o[1] = 0; o[2] = 0; o[3] = 1; return o; },
  copy: (o, a) => { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; o[3] = a[3]; return o; },
  set: (o, x, y, z, w) => { o[0] = x; o[1] = y; o[2] = z; o[3] = w; return o; },
  setAxisAngle: (o, axis, rad) => {
    rad *= 0.5; const s = Math.sin(rad);
    o[0] = s * axis[0]; o[1] = s * axis[1]; o[2] = s * axis[2]; o[3] = Math.cos(rad); return o;
  },
  multiply: (o, a, b) => {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
    o[0] = ax * bw + aw * bx + ay * bz - az * by;
    o[1] = ay * bw + aw * by + az * bx - ax * bz;
    o[2] = az * bw + aw * bz + ax * by - ay * bx;
    o[3] = aw * bw - ax * bx - ay * by - az * bz;
    return o;
  },
  mul: (o, a, b) => quat.multiply(o, a, b),
  rotateX: (o, a, rad) => {
    rad *= 0.5; const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = Math.sin(rad), bw = Math.cos(rad);
    o[0] = ax * bw + aw * bx; o[1] = ay * bw + az * bx; o[2] = az * bw - ay * bx; o[3] = aw * bw - ax * bx; return o;
  },
  rotateY: (o, a, rad) => {
    rad *= 0.5; const ax = a[0], ay = a[1], az = a[2], aw = a[3], by = Math.sin(rad), bw = Math.cos(rad);
    o[0] = ax * bw - az * by; o[1] = ay * bw + aw * by; o[2] = az * bw + ax * by; o[3] = aw * bw - ay * by; return o;
  },
  rotateZ: (o, a, rad) => {
    rad *= 0.5; const ax = a[0], ay = a[1], az = a[2], aw = a[3], bz = Math.sin(rad), bw = Math.cos(rad);
    o[0] = ax * bw + ay * bz; o[1] = ay * bw - ax * bz; o[2] = az * bw + aw * bz; o[3] = aw * bw - az * bz; return o;
  },
  conjugate: (o, a) => { o[0] = -a[0]; o[1] = -a[1]; o[2] = -a[2]; o[3] = a[3]; return o; },
  invert: (o, a) => {
    const d = a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3]; const k = d ? 1 / d : 0;
    o[0] = -a[0] * k; o[1] = -a[1] * k; o[2] = -a[2] * k; o[3] = a[3] * k; return o;
  },
  normalize: (o, a) => {
    let l = Math.hypot(a[0], a[1], a[2], a[3]); l = l > 0 ? 1 / l : 0;
    o[0] = a[0] * l; o[1] = a[1] * l; o[2] = a[2] * l; o[3] = a[3] * l; return o;
  },
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3],
  slerp: (o, a, b, t) => {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    let bx = b[0], by = b[1], bz = b[2], bw = b[3];
    let cosom = ax * bx + ay * by + az * bz + aw * bw, s0, s1;
    if (cosom < 0) { cosom = -cosom; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    if (1 - cosom > EPS) {
      const omega = Math.acos(cosom), sinom = Math.sin(omega);
      s0 = Math.sin((1 - t) * omega) / sinom; s1 = Math.sin(t * omega) / sinom;
    } else { s0 = 1 - t; s1 = t; }
    o[0] = s0 * ax + s1 * bx; o[1] = s0 * ay + s1 * by; o[2] = s0 * az + s1 * bz; o[3] = s0 * aw + s1 * bw;
    return o;
  },
  /** Normalisierte Linearinterpolation (schnell, Vorzeichen-korrigiert). */
  nlerp: (o, a, b, t) => {
    const s = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) < 0 ? -1 : 1;
    o[0] = a[0] + (b[0] * s - a[0]) * t; o[1] = a[1] + (b[1] * s - a[1]) * t;
    o[2] = a[2] + (b[2] * s - a[2]) * t; o[3] = a[3] + (b[3] * s - a[3]) * t;
    return quat.normalize(o, o);
  },
  /** Euler-Winkel in GRAD, Reihenfolge XYZ intrinsisch wie gl-matrix fromEuler (Standard 'zyx' = Yaw/Pitch/Roll extrinsisch). */
  fromEuler: (o, xDeg, yDeg, zDeg) => {
    const h = DEG / 2;
    const x = xDeg * h, y = yDeg * h, z = zDeg * h;
    const sx = Math.sin(x), cx = Math.cos(x), sy = Math.sin(y), cy = Math.cos(y), sz = Math.sin(z), cz = Math.cos(z);
    o[0] = sx * cy * cz - cx * sy * sz;
    o[1] = cx * sy * cz + sx * cy * sz;
    o[2] = cx * cy * sz - sx * sy * cz;
    o[3] = cx * cy * cz + sx * sy * sz;
    return o;
  },
  /** Rotation, die Einheitsvektor a auf Einheitsvektor b dreht. */
  rotationTo: (o, a, b) => {
    const d = vec3.dot(a, b);
    if (d < -0.999999) {
      const t = vec3.create(); vec3.cross(t, [1, 0, 0], a);
      if (vec3.length(t) < 1e-6) vec3.cross(t, [0, 1, 0], a);
      vec3.normalize(t, t); return quat.setAxisAngle(o, t, PI);
    }
    if (d > 0.999999) return quat.identity(o);
    const t = vec3.create(); vec3.cross(t, a, b);
    o[0] = t[0]; o[1] = t[1]; o[2] = t[2]; o[3] = 1 + d; return quat.normalize(o, o);
  },
  fromMat3: (o, m) => {
    const tr = m[0] + m[4] + m[8];
    if (tr > 0) {
      let r = Math.sqrt(tr + 1); o[3] = 0.5 * r; r = 0.5 / r;
      o[0] = (m[5] - m[7]) * r; o[1] = (m[6] - m[2]) * r; o[2] = (m[1] - m[3]) * r;
    } else {
      let i = 0; if (m[4] > m[0]) i = 1; if (m[8] > m[i * 3 + i]) i = 2;
      const j = (i + 1) % 3, k = (i + 2) % 3;
      let r = Math.sqrt(m[i * 3 + i] - m[j * 3 + j] - m[k * 3 + k] + 1);
      o[i] = 0.5 * r; r = 0.5 / r;
      o[3] = (m[j * 3 + k] - m[k * 3 + j]) * r; o[j] = (m[j * 3 + i] + m[i * 3 + j]) * r; o[k] = (m[k * 3 + i] + m[i * 3 + k]) * r;
    }
    return o;
  },
  /** Blickrichtung (forward, +Z lokal) und Up auf Quaternion. */
  fromForwardUp: (o, fwd, up = [0, 1, 0]) => {
    const z = vec3.normalize(vec3.create(), fwd);
    const x = vec3.cross(vec3.create(), up, z); vec3.normalize(x, x);
    const y = vec3.cross(vec3.create(), z, x);
    const m = new Float32Array([x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]]);
    return quat.fromMat3(o, m);
  },
  fromYaw: (o, yaw) => { o[0] = 0; o[1] = Math.sin(yaw / 2); o[2] = 0; o[3] = Math.cos(yaw / 2); return o; },
};

// ---------------------------------------------------------------- mat3 (für Normalmatrix)
export const mat3 = {
  create: () => { const o = new Float32Array(9); o[0] = o[4] = o[8] = 1; return o; },
  /** Inverse-Transponierte der oberen 3x3 einer mat4. */
  normalFromMat4: (o, a) => {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return null; det = 1 / det;
    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[2] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    o[3] = (a02 * b10 - a01 * b11 - a03 * b09) * det; o[4] = (a00 * b11 - a02 * b08 + a03 * b07) * det; o[5] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    o[6] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[7] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[8] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    return o;
  },
  fromQuat: (o, q) => {
    const x = q[0], y = q[1], z = q[2], w = q[3], x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, yx = y * x2, yy = y * y2, zx = z * x2, zy = z * y2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    o[0] = 1 - yy - zz; o[3] = yx - wz; o[6] = zx + wy;
    o[1] = yx + wz; o[4] = 1 - xx - zz; o[7] = zy - wx;
    o[2] = zx - wy; o[5] = zy + wx; o[8] = 1 - xx - yy;
    return o;
  },
};

// ---------------------------------------------------------------- mat4 (column-major)
export const mat4 = {
  create: () => { const o = new Float32Array(16); o[0] = o[5] = o[10] = o[15] = 1; return o; },
  clone: (a) => new Float32Array(a),
  copy: (o, a) => { o.set(a); return o; },
  identity: (o) => { o.fill(0); o[0] = o[5] = o[10] = o[15] = 1; return o; },
  multiply: (o, a, b) => {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
    o[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30; o[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    o[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32; o[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
    o[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30; o[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    o[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32; o[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
    o[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30; o[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    o[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32; o[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
    o[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30; o[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    o[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32; o[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    return o;
  },
  mul: (o, a, b) => mat4.multiply(o, a, b),
  invert: (o, a) => {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return null; det = 1 / det;
    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return o;
  },
  transpose: (o, a) => {
    if (o === a) {
      const a01 = a[1], a02 = a[2], a03 = a[3], a12 = a[6], a13 = a[7], a23 = a[11];
      o[1] = a[4]; o[2] = a[8]; o[3] = a[12]; o[4] = a01; o[6] = a[9]; o[7] = a[13];
      o[8] = a02; o[9] = a12; o[11] = a[14]; o[12] = a03; o[13] = a13; o[14] = a23;
    } else {
      o[0] = a[0]; o[1] = a[4]; o[2] = a[8]; o[3] = a[12]; o[4] = a[1]; o[5] = a[5]; o[6] = a[9]; o[7] = a[13];
      o[8] = a[2]; o[9] = a[6]; o[10] = a[10]; o[11] = a[14]; o[12] = a[3]; o[13] = a[7]; o[14] = a[11]; o[15] = a[15];
    }
    return o;
  },
  perspective: (o, fovy, aspect, near, far) => {
    const f = 1 / Math.tan(fovy / 2); o.fill(0);
    o[0] = f / aspect; o[5] = f; o[11] = -1;
    if (far != null && far !== Infinity) { const nf = 1 / (near - far); o[10] = (far + near) * nf; o[14] = 2 * far * near * nf; }
    else { o[10] = -1; o[14] = -2 * near; }
    return o;
  },
  ortho: (o, l, r, b, t, n, f) => {
    const lr = 1 / (l - r), bt = 1 / (b - t), nf = 1 / (n - f); o.fill(0);
    o[0] = -2 * lr; o[5] = -2 * bt; o[10] = 2 * nf; o[12] = (l + r) * lr; o[13] = (t + b) * bt; o[14] = (f + n) * nf; o[15] = 1;
    return o;
  },
  /** View-Matrix (Kamera blickt entlang -Z). */
  lookAt: (o, eye, center, up) => {
    let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
    let l = Math.hypot(z0, z1, z2); if (l < EPS) return mat4.identity(o);
    l = 1 / l; z0 *= l; z1 *= l; z2 *= l;
    let x0 = up[1] * z2 - up[2] * z1, x1 = up[2] * z0 - up[0] * z2, x2 = up[0] * z1 - up[1] * z0;
    l = Math.hypot(x0, x1, x2); if (l) { l = 1 / l; x0 *= l; x1 *= l; x2 *= l; } else { x0 = x1 = x2 = 0; }
    const y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
    o[0] = x0; o[1] = y0; o[2] = z0; o[3] = 0; o[4] = x1; o[5] = y1; o[6] = z1; o[7] = 0;
    o[8] = x2; o[9] = y2; o[10] = z2; o[11] = 0;
    o[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]); o[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
    o[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]); o[15] = 1;
    return o;
  },
  /** Objekt-Matrix, die lokales +Z auf (target - eye) ausrichtet (für Objekte, nicht Kameras). */
  targetTo: (o, eye, target, up = [0, 1, 0]) => {
    let z0 = target[0] - eye[0], z1 = target[1] - eye[1], z2 = target[2] - eye[2];
    let l = z0 * z0 + z1 * z1 + z2 * z2; if (l > 0) { l = 1 / Math.sqrt(l); z0 *= l; z1 *= l; z2 *= l; }
    let x0 = up[1] * z2 - up[2] * z1, x1 = up[2] * z0 - up[0] * z2, x2 = up[0] * z1 - up[1] * z0;
    l = x0 * x0 + x1 * x1 + x2 * x2; if (l > 0) { l = 1 / Math.sqrt(l); x0 *= l; x1 *= l; x2 *= l; }
    o[0] = x0; o[1] = x1; o[2] = x2; o[3] = 0;
    o[4] = z1 * x2 - z2 * x1; o[5] = z2 * x0 - z0 * x2; o[6] = z0 * x1 - z1 * x0; o[7] = 0;
    o[8] = z0; o[9] = z1; o[10] = z2; o[11] = 0;
    o[12] = eye[0]; o[13] = eye[1]; o[14] = eye[2]; o[15] = 1;
    return o;
  },
  fromTranslation: (o, v) => { mat4.identity(o); o[12] = v[0]; o[13] = v[1]; o[14] = v[2]; return o; },
  fromScaling: (o, v) => { mat4.identity(o); o[0] = v[0]; o[5] = v[1]; o[10] = v[2]; return o; },
  fromQuat: (o, q) => mat4.fromRotationTranslation(o, q, [0, 0, 0]),
  fromRotationTranslation: (o, q, v) => {
    const x = q[0], y = q[1], z = q[2], w = q[3], x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    o[0] = 1 - (yy + zz); o[1] = xy + wz; o[2] = xz - wy; o[3] = 0;
    o[4] = xy - wz; o[5] = 1 - (xx + zz); o[6] = yz + wx; o[7] = 0;
    o[8] = xz + wy; o[9] = yz - wx; o[10] = 1 - (xx + yy); o[11] = 0;
    o[12] = v[0]; o[13] = v[1]; o[14] = v[2]; o[15] = 1;
    return o;
  },
  fromRotationTranslationScale: (o, q, v, s) => {
    mat4.fromRotationTranslation(o, q, v);
    const sx = typeof s === 'number' ? s : s[0], sy = typeof s === 'number' ? s : s[1], sz = typeof s === 'number' ? s : s[2];
    o[0] *= sx; o[1] *= sx; o[2] *= sx; o[4] *= sy; o[5] *= sy; o[6] *= sy; o[8] *= sz; o[9] *= sz; o[10] *= sz;
    return o;
  },
  /** Yaw um Y + Position (häufigster Fall für Figuren). */
  fromYawTranslation: (o, yaw, v, s = 1) => {
    const c = Math.cos(yaw) * s, sn = Math.sin(yaw) * s; o.fill(0);
    o[0] = c; o[2] = -sn; o[5] = s; o[8] = sn; o[10] = c; o[12] = v[0]; o[13] = v[1]; o[14] = v[2]; o[15] = 1;
    return o;
  },
  translate: (o, a, v) => {
    const x = v[0], y = v[1], z = v[2];
    if (o !== a) o.set(a);
    o[12] = a[0] * x + a[4] * y + a[8] * z + a[12]; o[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
    o[14] = a[2] * x + a[6] * y + a[10] * z + a[14]; o[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
    return o;
  },
  scale: (o, a, v) => {
    const x = v[0], y = v[1], z = v[2];
    for (let i = 0; i < 4; i++) { o[i] = a[i] * x; o[4 + i] = a[4 + i] * y; o[8 + i] = a[8 + i] * z; o[12 + i] = a[12 + i]; }
    return o;
  },
  rotateX: (o, a, rad) => mat4.multiply(o, a, mat4.fromQuat(_m4, quat.setAxisAngle(_q, [1, 0, 0], rad))),
  rotateY: (o, a, rad) => mat4.multiply(o, a, mat4.fromQuat(_m4, quat.setAxisAngle(_q, [0, 1, 0], rad))),
  rotateZ: (o, a, rad) => mat4.multiply(o, a, mat4.fromQuat(_m4, quat.setAxisAngle(_q, [0, 0, 1], rad))),
  getTranslation: (o, m) => { o[0] = m[12]; o[1] = m[13]; o[2] = m[14]; return o; },
  getScaling: (o, m) => {
    o[0] = Math.hypot(m[0], m[1], m[2]); o[1] = Math.hypot(m[4], m[5], m[6]); o[2] = Math.hypot(m[8], m[9], m[10]); return o;
  },
  getRotation: (o, m) => {
    const s = mat4.getScaling(vec3.create(), m);
    const r = new Float32Array([m[0] / s[0], m[1] / s[0], m[2] / s[0], m[4] / s[1], m[5] / s[1], m[6] / s[1], m[8] / s[2], m[9] / s[2], m[10] / s[2]]);
    return quat.fromMat3(o, r);
  },
};
const _m4 = mat4.create(), _q = quat.create();

// ---------------------------------------------------------------- Geometrie-Helfer
/** Strahl/Ebene y = h. Gibt t oder -1 zurück. */
export function rayPlaneY(origin, dir, h = 0) {
  if (Math.abs(dir[1]) < EPS) return -1;
  const t = (h - origin[1]) / dir[1]; return t >= 0 ? t : -1;
}
/** Catmull-Rom-Spline durch Punkte (Arrays aus vec3), t in [0,1] über die ganze Kurve. */
export function catmullRom(out, pts, t) {
  const n = pts.length - 1; const f = clamp(t, 0, 1) * n; const i = Math.min(Math.floor(f), n - 1); const u = f - i;
  const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, n)];
  const u2 = u * u, u3 = u2 * u;
  for (let k = 0; k < 3; k++) {
    out[k] = 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * u + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u3);
  }
  return out;
}
/** Hex-Farbe (#rrggbb) -> lineares RGB [0..1] (sRGB-Dekodierung). */
export function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
export function hexToLinear(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
}

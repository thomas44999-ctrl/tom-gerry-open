// Prozeduraler Himmel: analytischer Verlauf (Zenit -> warmer Horizont), Sonnenscheibe + Aureole,
// geschichtete FBM-Wolken mit Sonnenlicht. Dieselbe Funktion speist Hintergrund, die vorgefilterte
// Umgebungs-Cubemap (Glanz) und die SH-Irradianz (diffuses Umgebungslicht).
import { GLSL_HEADER, GLSL_FRAME_UBO, GLSL_COMMON, FRAME } from './shaderlib.js';
import { createProgram, FULLSCREEN_VS } from './gl.js';

/** Standardwerte (später Nachmittag). Alle Farben linear (Radianz). */
export const SKY_DEFAULTS = {
  zenith: [0.075, 0.19, 0.54],
  horizon: [0.60, 0.70, 0.85],
  ground: [0.20, 0.20, 0.18],
  horizonExponent: 5.0,       // größer = Horizont-Dunst schmaler
  sunGlow: [1.0, 0.70, 0.42], // Wärme des Horizonts auf der Sonnenseite
  sunGlowStrength: 0.9,
  aureole: 0.12,              // Mie-Spitze um die Sonne
  sunSize: 0.75,              // Winkelradius in Grad
  sunIntensity: 9.0,          // Scheibe = Sonnenfarbe*Intensität*sunIntensity
  brightness: 1.0,
  clouds: {
    coverage: 0.45, density: 1.5, scale: 1.0, softness: 0.10,
    color: [1.0, 0.97, 0.93], shade: [0.36, 0.42, 0.55], brightness: 1.1, silver: 1.0, opacity: 0.96,
    curvature: 0.12, wind: [0.004, 0.0012],
  },
};

export const GLSL_SKY = `
float tg_cloudFbm(vec2 p, int oct) {
  float f = 0.0, a = 0.5, n = 0.0;
  for (int k = 0; k < 8; k++) {
    if (k >= oct) break;
    f += a * noise2(p); n += a;
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(3.1, 1.7);
    a *= 0.5;
  }
  return f / n;
}
vec3 tg_sunTint() { return u_sunColor / max(max(u_sunColor.r, u_sunColor.g), max(u_sunColor.b, 1e-4)); }
float tg_hg(float mu, float g) { float g2 = g * g; return (1.0 - g2) / (12.5663706 * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5)); }
// Wolkenschicht: rgb = Radianz, a = Deckkraft
vec4 tg_clouds(vec3 rd, int oct) {
  if (rd.y < 0.01 || u_cloudParams.x <= 0.0) return vec4(0.0);
  vec2 uv = rd.xz / (rd.y + u_cloudWind.z) * u_cloudParams.z * 0.5 + u_cloudWind.xy;
  vec2 w = vec2(tg_cloudFbm(uv * 0.5 + 7.3, 3), tg_cloudFbm(uv * 0.5 + 1.9, 3)) - 0.5;
  vec2 p = uv + w * 0.8;
  float thr = mix(0.70, 0.34, u_cloudParams.x);
  float shape = tg_cloudFbm(p * 0.6, 4);
  float detail = tg_cloudFbm(p * 2.9 + 3.7, max(oct - 2, 2));
  float n = shape - (detail - 0.5) * 0.36 - (1.0 - shape) * 0.06;
  float d = smoothstep(thr, thr + u_cloudParams.w, n);
  if (d <= 0.001) return vec4(0.0);
  // Selbstabschattung: Dichte Richtung Sonne (Beer + Pulver-Effekt)
  vec2 sd = normalize(u_sunDir.xz + 1e-4) * 0.07 * (1.6 - u_sunDir.y);
  float s1 = max(tg_cloudFbm((p + sd) * 0.6, 4) - thr, 0.0);
  float s2 = max(tg_cloudFbm((p + sd * 2.5) * 0.6, 3) - thr, 0.0);
  float od = (s1 + s2 * 0.6 + max(n - thr, 0.0) * 0.5) * u_cloudParams.y * 3.0;
  float beer = exp(-od * 2.0);
  float powder = 1.0 - exp(-od * 4.0 - 0.35);
  float light = saturate(beer * mix(1.0, powder, 0.5) * 1.6);
  vec3 tint = tg_sunTint();
  vec3 col = u_cloudShade.rgb * (0.85 + 0.3 * rd.y) + u_cloudColor.rgb * tint * (u_cloudWind.w * light);
  // Vorwärtsstreuung: dünne Ränder nahe der Sonne leuchten (Silberrand)
  float mu = dot(rd, u_sunDir);
  col += tint * (u_cloudColor.w * tg_hg(mu, 0.6) * (1.0 - d * 0.75) * 1.4 * u_cloudWind.w);
  // Luftperspektive zum Horizont
  float low = 1.0 - smoothstep(0.02, 0.35, rd.y);
  col = mix(col, u_skyHorizon.rgb * (1.0 + 0.4 * light), low * 0.55);
  float fade = smoothstep(0.012, 0.18, rd.y);
  return vec4(col, d * fade * u_cloudShade.w);
}
vec3 tg_skyBase(vec3 rd) {
  float yh = max(rd.y, 0.0);
  float mu = dot(rd, u_sunDir);
  vec3 tint = tg_sunTint();
  // Rayleigh-artiger Verlauf: tiefes Blau im Zenit -> heller, dunstiger Horizont
  float hz = pow(1.0 - yh, u_skyZenith.w);
  vec3 col = mix(u_skyZenith.rgb, u_skyHorizon.rgb, hz);
  col *= 0.9 + 0.1 * (1.0 + mu * mu);
  // warmer Horizont nur auf der Sonnenseite und nur in Horizontnähe
  float sunSide = pow(saturate(mu * 0.5 + 0.5), 2.2);
  float band = pow(1.0 - yh, 7.0);
  col = mix(col, col * u_skySunGlow.rgb * 1.4, saturate(band * sunSide * u_skySunGlow.w));
  // Mie: Aureole + breiter weißlich-warmer Schein um die Sonne (additiv, kein Lila)
  col += tint * (u_skyMisc.w * tg_hg(mu, 0.8) + u_skySunGlow.w * 0.22 * pow(saturate(mu), 5.0) * (0.6 + 0.4 * hz));
  if (rd.y < 0.0) col = mix(col, u_skyGround.rgb, smoothstep(0.0, 0.2, -rd.y));
  return col * u_skyMisc.z;
}
// Vollständiger Himmel. sunDisc: 0/1, oct: Wolken-Oktaven (0 = keine Wolken)
vec3 tg_sky(vec3 rd, float sunDisc, int oct) {
  vec3 col = tg_skyBase(rd);
  float cov = 0.0;
  if (oct > 0) {
    vec4 c = tg_clouds(rd, oct);
    col = mix(col, c.rgb * u_skyMisc.z, c.a);
    cov = c.a;
  }
  if (sunDisc > 0.0) {
    float mu = dot(rd, u_sunDir);
    float cs = u_skyMisc.x;
    if (mu > cs - 0.0004) {
      float r = saturate((1.0 - mu) / max(1.0 - cs, 1e-6));
      float limb = 1.0 - 0.55 * (1.0 - sqrt(max(1.0 - r * r, 0.0)));
      float edge = smoothstep(cs - 0.0004, cs + 0.00005, mu);
      col += u_sunColor * u_skyMisc.y * limb * edge * (1.0 - cov * 0.92);
    }
  }
  return col;
}
// Öffentlich: Himmelsradianz in Richtung dir (ohne Sonnenscheibe, mit Wolken)
vec3 skyRadiance(vec3 dir) { return tg_sky(normalize(dir), 0.0, 4); }
`;

const SKY_BG_FS = `${GLSL_HEADER}${GLSL_FRAME_UBO}${GLSL_COMMON}${GLSL_SKY}
in vec2 v_uv;
layout(location = 0) out vec4 o_color;
#ifdef MRT_AO
layout(location = 1) out vec4 o_ao;
#endif
void main() {
  vec4 p = u_invViewProj * vec4(v_uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(p.xyz / p.w - u_cameraPos);
  o_color = vec4(tg_sky(rd, 1.0, 6), 1.0);
#ifdef MRT_AO
  o_ao = vec4(0.0);
#endif
}`;

const SKY_BG_VS = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 1.0, 1.0);
}`;

const CUBE_DIR = `
uniform int u_face;
vec3 tg_faceDir(int f, vec2 uv) {
  vec2 c = uv * 2.0 - 1.0;
  vec3 d;
  if (f == 0) d = vec3(1.0, -c.y, -c.x);
  else if (f == 1) d = vec3(-1.0, -c.y, c.x);
  else if (f == 2) d = vec3(c.x, 1.0, c.y);
  else if (f == 3) d = vec3(c.x, -1.0, -c.y);
  else if (f == 4) d = vec3(c.x, -c.y, 1.0);
  else d = vec3(-c.x, -c.y, -1.0);
  return normalize(d);
}`;

const CUBE_SKY_FS = `${GLSL_HEADER}${GLSL_FRAME_UBO}${GLSL_COMMON}${GLSL_SKY}${CUBE_DIR}
in vec2 v_uv;
out vec4 o_color;
void main() {
  vec3 d = tg_faceDir(u_face, v_uv);
  vec3 c = tg_sky(d, 0.0, 4);
  // unterhalb des Horizonts: Bodenreflex (hemi.ground)
  float below = smoothstep(0.0, -0.08, d.y);
  c = mix(c, u_hemiGround, below);
  o_color = vec4(c, 1.0);
}`;

const PREFILTER_FS = `${GLSL_HEADER}${GLSL_COMMON}${CUBE_DIR}
in vec2 v_uv;
out vec4 o_color;
uniform samplerCube u_src;
uniform float u_rough;
uniform float u_srcRes;
float radicalInverse(uint b) {
  b = (b << 16u) | (b >> 16u);
  b = ((b & 0x55555555u) << 1u) | ((b & 0xAAAAAAAAu) >> 1u);
  b = ((b & 0x33333333u) << 2u) | ((b & 0xCCCCCCCCu) >> 2u);
  b = ((b & 0x0F0F0F0Fu) << 4u) | ((b & 0xF0F0F0F0u) >> 4u);
  b = ((b & 0x00FF00FFu) << 8u) | ((b & 0xFF00FF00u) >> 8u);
  return float(b) * 2.3283064365386963e-10;
}
void main() {
  vec3 N = tg_faceDir(u_face, v_uv);
  vec3 up = abs(N.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tx = normalize(cross(up, N));
  vec3 ty = cross(N, tx);
  float a = u_rough * u_rough;
  float a2 = a * a;
  const uint SAMPLES = 96u;
  vec3 sum = vec3(0.0); float wsum = 0.0;
  float saTexel = 4.0 * TG_PI / (6.0 * u_srcRes * u_srcRes);
  for (uint k = 0u; k < SAMPLES; k++) {
    vec2 xi = vec2(float(k) / float(SAMPLES), radicalInverse(k));
    float phi = 2.0 * TG_PI * xi.x;
    float cosT = sqrt((1.0 - xi.y) / (1.0 + (a2 - 1.0) * xi.y));
    float sinT = sqrt(1.0 - cosT * cosT);
    vec3 H = tx * (sinT * cos(phi)) + ty * (sinT * sin(phi)) + N * cosT;
    vec3 L = 2.0 * dot(N, H) * H - N;
    float NoL = dot(N, L);
    if (NoL > 0.0) {
      float NoH = cosT;
      float f = (NoH * a2 - NoH) * NoH + 1.0;
      float D = a2 / (TG_PI * f * f);
      float pdf = D * 0.25 + 1e-4;
      float saSample = 1.0 / (float(SAMPLES) * pdf);
      float mip = clamp(0.5 * log2(saSample / saTexel) + 1.0, 0.0, 7.0);
      sum += textureLod(u_src, L, mip).rgb * NoL;
      wsum += NoL;
    }
  }
  o_color = vec4(sum / max(wsum, 1e-4), 1.0);
}`;

const SH_FS = `${GLSL_HEADER}${GLSL_COMMON}${CUBE_DIR}
out vec4 o_color;
uniform samplerCube u_src;
uniform float u_mip;
uniform int u_n;
void main() {
  int k = int(gl_FragCoord.x);
  vec3 sum = vec3(0.0);
  float fn = float(u_n);
  for (int f = 0; f < 6; f++) {
    for (int y = 0; y < 64; y++) {
      if (y >= u_n) break;
      for (int x = 0; x < 64; x++) {
        if (x >= u_n) break;
        vec2 uv = (vec2(float(x), float(y)) + 0.5) / fn;
        vec2 c = uv * 2.0 - 1.0;
        float dw = 4.0 / (fn * fn) / pow(1.0 + dot(c, c), 1.5);
        vec3 d = tg_faceDir(f, uv);
        if (d.y <= 0.0) continue;
        vec3 L = textureLod(u_src, d, u_mip).rgb;
        float Y;
        if (k == 0) Y = 0.282095;
        else if (k == 1) Y = 0.488603 * d.y;
        else if (k == 2) Y = 0.488603 * d.z;
        else if (k == 3) Y = 0.488603 * d.x;
        else if (k == 4) Y = 1.092548 * d.x * d.y;
        else if (k == 5) Y = 1.092548 * d.y * d.z;
        else if (k == 6) Y = 0.315392 * (3.0 * d.z * d.z - 1.0);
        else if (k == 7) Y = 1.092548 * d.x * d.z;
        else if (k == 8) Y = 0.546274 * (d.x * d.x - d.y * d.y);
        else if (k == 9) Y = 1.0;
        else { Y = 1.0; L = vec3(1.0); }
        sum += L * (Y * dw);
      }
    }
  }
  o_color = vec4(sum, 1.0);
}`;

// SH-Konstanten (Ramamoorthi & Hanrahan)
const SH_K = [0.282095, 0.488603, 0.488603, 0.488603, 1.092548, 1.092548, 0.315392, 1.092548, 0.546274];
const SH_A = [Math.PI, 2 * Math.PI / 3, 2 * Math.PI / 3, 2 * Math.PI / 3, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4];
function shBasis(x, y, z, out) {
  out[0] = 0.282095; out[1] = 0.488603 * y; out[2] = 0.488603 * z; out[3] = 0.488603 * x;
  out[4] = 1.092548 * x * y; out[5] = 1.092548 * y * z; out[6] = 0.315392 * (3 * z * z - 1);
  out[7] = 1.092548 * x * z; out[8] = 0.546274 * (x * x - y * y);
  return out;
}
/** SH-Projektion einer Funktion, die für y<0 (lower) bzw. y>0 (upper) 1 ist. */
function hemisphereSH(lower) {
  const out = new Float64Array(9), b = new Float64Array(9);
  const N = 96;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < 2 * N; j++) {
      const th = (i + 0.5) / N * Math.PI, ph = (j + 0.5) / (2 * N) * 2 * Math.PI;
      const y = Math.cos(th), s = Math.sin(th), x = s * Math.cos(ph), z = s * Math.sin(ph);
      if (lower ? y >= 0 : y <= 0) continue;
      const dw = s * (Math.PI / N) * (Math.PI / N);
      shBasis(x, y, z, b);
      for (let k = 0; k < 9; k++) out[k] += b[k] * dw;
    }
  }
  return out;
}
const SH_LOWER = hemisphereSH(true);
const SH_UPPER = hemisphereSH(false);

export class SkySystem {
  constructor(renderer) {
    this.r = renderer;
    const gl = this.gl = renderer.gl;
    this.size = 128;
    this.mips = 6;
    this.maxLod = this.mips - 1;
    this.shReady = false;
    this.sh = new Float32Array(36);           // 9 x vec4, fertig vorgefaltet (/PI)
    this.shUpperRaw = new Float32Array(44);   // 11 Pixel RGBA aus GPU-Projektion
    this.skyAvg = [0.3, 0.4, 0.6];
    this._sig = NaN; this._lastGen = -1e9; this._pending = null; this._first = true;
    this._resolved = { ...SKY_DEFAULTS, clouds: { ...SKY_DEFAULTS.clouds } };
    this.bgProgram = new Map();
    this._initTargets();
  }

  _initTargets() {
    const gl = this.gl, S = this.size;
    this.src = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.src);
    const srcLevels = Math.log2(S) + 1;
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, srcLevels, this.r.hdrFormat, S, S);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.env = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.env);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, this.mips, this.r.hdrFormat, S, S);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAX_LEVEL, this.mips - 1);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
    this.fbo = gl.createFramebuffer();
    // SH-Ziel (11 x 1, float)
    this.shOK = !!this.r.ext.colorBufferFloat;
    if (this.shOK) {
      this.shTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.shTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 11, 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.shFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.shTex, 0);
      this.shOK = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, 44 * 4, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
    this.r.state.reset();
    const name = 'sky';
    this.cubeProg = this._prog(FULLSCREEN_VS, CUBE_SKY_FS, name + '-cube', true);
    this.prefProg = this._prog(FULLSCREEN_VS, PREFILTER_FS, name + '-prefilter', false);
    this.shProg = this.shOK ? this._prog(FULLSCREEN_VS, SH_FS, name + '-sh', false) : null;
  }

  _prog(vs, fs, name, ubo) {
    const gl = this.gl;
    const p = createProgram(gl, vs, fs, name);
    if (ubo) { const bi = gl.getUniformBlockIndex(p, 'Frame'); if (bi !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, bi, 0); }
    const u = (n) => gl.getUniformLocation(p, n);
    return { p, face: u('u_face'), src: u('u_src'), rough: u('u_rough'), srcRes: u('u_srcRes'), mip: u('u_mip'), n: u('u_n') };
  }

  getBackgroundProgram(mrt) {
    let p = this.bgProgram.get(mrt);
    if (!p) {
      const gl = this.gl;
      p = createProgram(gl, SKY_BG_VS, SKY_BG_FS.replace('#version 300 es\n', '#version 300 es\n' + (mrt ? '#define MRT_AO 1\n' : '')), 'sky-background');
      const bi = gl.getUniformBlockIndex(p, 'Frame'); if (bi !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, bi, 0);
      this.bgProgram.set(mrt, p);
    }
    return p;
  }

  /** Szene-Himmelsparameter (mit Defaults) in den Frame-Puffer schreiben. Allokationsfrei. */
  writeUniforms(F, scene, time) {
    const s = scene.sky || SKY_DEFAULTS;
    const d = SKY_DEFAULTS, c = s.clouds || d.clouds, dc = d.clouds;
    const v3 = (off, a, b, k = 1) => { const x = a || b; F[off] = x[0] * k; F[off + 1] = x[1] * k; F[off + 2] = x[2] * k; };
    v3(FRAME.skyZenith, s.zenith, d.zenith); F[FRAME.skyZenith + 3] = s.horizonExponent ?? d.horizonExponent;
    v3(FRAME.skyHorizon, s.horizon, d.horizon); F[FRAME.skyHorizon + 3] = 0;
    v3(FRAME.skyGround, s.ground, d.ground); F[FRAME.skyGround + 3] = 0;
    v3(FRAME.skySunGlow, s.sunGlow, d.sunGlow); F[FRAME.skySunGlow + 3] = s.sunGlowStrength ?? d.sunGlowStrength;
    const cov = c.coverage ?? dc.coverage;
    F[FRAME.cloudParams] = s.clouds === false ? 0 : cov; F[FRAME.cloudParams + 1] = c.density ?? dc.density;
    F[FRAME.cloudParams + 2] = c.scale ?? dc.scale; F[FRAME.cloudParams + 3] = c.softness ?? dc.softness;
    const wind = c.wind || dc.wind;
    F[FRAME.cloudWind] = wind[0] * time; F[FRAME.cloudWind + 1] = wind[1] * time;
    F[FRAME.cloudWind + 2] = c.curvature ?? dc.curvature; F[FRAME.cloudWind + 3] = c.brightness ?? dc.brightness;
    v3(FRAME.cloudColor, c.color, dc.color); F[FRAME.cloudColor + 3] = c.silver ?? dc.silver;
    v3(FRAME.cloudShade, c.shade, dc.shade); F[FRAME.cloudShade + 3] = c.opacity ?? dc.opacity;
    const size = (s.sunSize ?? d.sunSize) * Math.PI / 180;
    F[FRAME.skyMisc] = Math.cos(size); F[FRAME.skyMisc + 1] = s.sunIntensity ?? d.sunIntensity;
    F[FRAME.skyMisc + 2] = s.brightness ?? d.brightness; F[FRAME.skyMisc + 3] = s.aureole ?? d.aureole;
  }

  /** Signatur der Parameter, die die Umgebung beeinflussen (ohne Wind-Zeit). */
  signature(F) {
    let h = 0;
    const add = (off, n) => { for (let i = 0; i < n; i++) h = (h * 1.000173 + F[off + i] * (i + 1.37)) % 1e9; };
    add(FRAME.sunDir, 3); add(FRAME.sunColor, 3); add(FRAME.hemiGround, 3);
    add(FRAME.skyZenith, 4); add(FRAME.skyHorizon, 4); add(FRAME.skyGround, 4); add(FRAME.skySunGlow, 4);
    add(FRAME.cloudParams, 4); add(FRAME.cloudColor, 4); add(FRAME.cloudShade, 4); add(FRAME.skyMisc, 4);
    add(FRAME.cloudWind + 2, 2);
    return h;
  }

  /** Bei Bedarf Umgebung neu erzeugen (max. 4x/s) und asynchrone SH-Rücklesung abholen. */
  update(F, now) {
    this._pollReadback();
    const sig = this.signature(F);
    if (sig !== this._sig && now - this._lastGen > 250) {
      this._sig = sig; this._lastGen = now;
      this._generate();
    }
  }

  _generate() {
    const gl = this.gl, st = this.r.state, S = this.size;
    st.bindVAO(this.r.emptyVAO);
    st.setBlend(0); st.setDepth(false, false); st.setCull(0); st.setA2C(false); st.setPolygonOffset(0, 0);
    st.bindFBO(this.fbo);
    // 1) Himmel in Quell-Cubemap
    st.useProgram(this.cubeProg.p);
    st.viewport(0, 0, S, S);
    for (let f = 0; f < 6; f++) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, this.src, 0);
      gl.uniform1i(this.cubeProg.face, f);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    st.bindTextureActive(0, gl.TEXTURE_CUBE_MAP, this.src);
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
    // 2) GGX-Vorfilterung je Mip
    st.useProgram(this.prefProg.p);
    gl.uniform1i(this.prefProg.src, 0);
    gl.uniform1f(this.prefProg.srcRes, S);
    for (let m = 0; m < this.mips; m++) {
      const sz = S >> m;
      st.viewport(0, 0, sz, sz);
      gl.uniform1f(this.prefProg.rough, Math.max(m / (this.mips - 1), 0.02));
      for (let f = 0; f < 6; f++) {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, this.env, m);
        gl.uniform1i(this.prefProg.face, f);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X, null, 0);
    // 3) SH-Projektion der oberen Hemisphäre
    if (this.shProg) {
      st.bindFBO(this.shFbo);
      st.viewport(0, 0, 11, 1);
      st.useProgram(this.shProg.p);
      gl.uniform1i(this.shProg.src, 0);
      gl.uniform1f(this.shProg.mip, 2);
      gl.uniform1i(this.shProg.n, S >> 2);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (this._first) {
        gl.readPixels(0, 0, 11, 1, gl.RGBA, gl.FLOAT, this.shUpperRaw);
        this._first = false;
        this._applySH();
      } else {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        gl.readPixels(0, 0, 11, 1, gl.RGBA, gl.FLOAT, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        if (this._pending) gl.deleteSync(this._pending);
        this._pending = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
      }
    }
    st.bindFBO(null);
  }

  _pollReadback() {
    if (!this._pending) return;
    const gl = this.gl;
    const res = gl.clientWaitSync(this._pending, 0, 0);
    if (res === gl.TIMEOUT_EXPIRED || res === gl.WAIT_FAILED) return;
    gl.deleteSync(this._pending); this._pending = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.shUpperRaw);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this._applySH();
  }

  _applySH() {
    const raw = this.shUpperRaw;
    const area = raw[40] || 2 * Math.PI;
    this.skyAvg[0] = raw[36] / area; this.skyAvg[1] = raw[37] / area; this.skyAvg[2] = raw[38] / area;
    this.shReady = true;
    this._shDirty = true;
  }

  /**
   * Endgültige SH-Koeffizienten: Himmel (getönt, sodass sein Mittel = hemi.sky) + Boden (hemi.ground).
   * Schreibt 9 vec4 nach F[FRAME.sh].
   */
  writeSH(F, hemi) {
    const raw = this.shUpperRaw;
    const hs = hemi?.sky, hg = hemi?.ground || [0.12, 0.13, 0.09];
    const hi = hemi?.intensity ?? 1;
    for (let c = 0; c < 3; c++) {
      let tint = 1, useRaw = this.shReady;
      if (useRaw && hs) tint = hs[c] / Math.max(this.skyAvg[c], 1e-4);
      for (let k = 0; k < 9; k++) {
        const upper = useRaw ? raw[k * 4 + c] * tint : SH_UPPER[k] * (hs ? hs[c] : 0.4);
        const L = (upper + SH_LOWER[k] * hg[c]) * hi;
        F[FRAME.sh + k * 4 + c] = L * SH_A[k] * SH_K[k] / Math.PI;
      }
    }
  }

  drawBackground(mrt) {
    const gl = this.gl, st = this.r.state;
    st.useProgram(this.getBackgroundProgram(mrt));
    st.bindVAO(this.r.emptyVAO);
    st.setBlend(0); st.setCull(0); st.setA2C(false); st.setPolygonOffset(0, 0);
    st.setDepth(true, false, gl.LEQUAL);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    st.setDepth(true, true, gl.LEQUAL);
  }
}

// Post-Processing (linear HDR -> sRGB): SSAO (halbe Auflösung, SAO + bilateraler Blur, nur auf
// Umgebungslicht), Bloom (Soft-Threshold + Dual-Filter-Kette), Tiefenunschärfe (Gather-Bokeh),
// filmisches Tonemapping (Khronos PBR Neutral, wahlweise AgX "punchy"), Farbkorrektur, Vignette,
// Filmkorn, Dithering, FXAA (wenn kein MSAA).
import { GLSL_HEADER, GLSL_FRAME_UBO, GLSL_COMMON } from './shaderlib.js';
import { createProgram, getUniformInfo, FULLSCREEN_VS } from './gl.js';

export const POST_DEFAULTS = {
  bloom: 0.5, bloomThreshold: 1.0, bloomKnee: 0.5, vignette: 0.25, saturation: 1.05, contrast: 1.05,
  grain: 0.03, temperature: 0.0, lift: [0, 0, 0], gain: [1, 1, 1], tonemap: 'neutral',
  ao: 1.0, aoRadius: 0.55, aoDirect: 0.18, aoBias: 0.01, sharpen: 0.25,
};

const DEBUG_VIEWS = { ao: 1, ambient: 2 };

const LIN_DEPTH = `
float tg_linDepth(float d) { float z = d * 2.0 - 1.0; return 2.0 * u_near * u_far / (u_far + u_near - z * (u_far - u_near)); }
`;

// ---------------------------------------------------------------- SSAO
const DEPTH_DOWN_FS = `
uniform sampler2D u_depth;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  ivec2 m = textureSize(u_depth, 0) - 1;
  // nächstliegende der 4 Tiefen (Kanten stabil, keine Halos vor dem Himmel)
  float d0 = texelFetch(u_depth, min(p, m), 0).r;
  float d1 = texelFetch(u_depth, min(p + ivec2(1, 0), m), 0).r;
  float d2 = texelFetch(u_depth, min(p + ivec2(0, 1), m), 0).r;
  float d3 = texelFetch(u_depth, min(p + ivec2(1, 1), m), 0).r;
  o = vec4(tg_linDepth(min(min(d0, d1), min(d2, d3))), 0.0, 0.0, 1.0);
}`;

const SSAO_FS = `
uniform sampler2D u_hd;
uniform vec4 u_aoP;    // x radius (m), y intensity, z bias, w projScale (px/m bei z=1)
uniform vec2 u_invProj; // 1/proj[0][0], 1/proj[1][1]
out vec4 o;
#define NS 12
#define TURNS 7.0
vec3 vpos(ivec2 p, vec2 res) {
  float z = texelFetch(u_hd, p, 0).r;
  vec2 uv = (vec2(p) + 0.5) / res;
  return vec3((uv * 2.0 - 1.0) * u_invProj * z, -z);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(u_hd, 0);
  vec2 res = vec2(sz);
  vec3 P = vpos(p, res);
  if (-P.z > u_far * 0.95) { o = vec4(1.0); return; }
  vec3 Pr = vpos(min(p + ivec2(1, 0), sz - 1), res), Pl = vpos(max(p - ivec2(1, 0), ivec2(0)), res);
  vec3 Pt = vpos(min(p + ivec2(0, 1), sz - 1), res), Pb = vpos(max(p - ivec2(0, 1), ivec2(0)), res);
  vec3 dx = abs(Pr.z - P.z) < abs(P.z - Pl.z) ? Pr - P : P - Pl;
  vec3 dy = abs(Pt.z - P.z) < abs(P.z - Pb.z) ? Pt - P : P - Pb;
  vec3 N = normalize(cross(dx, dy));
  float r = u_aoP.x, r2 = r * r;
  float ssR = r * u_aoP.w / -P.z;
  if (ssR < 1.0) { o = vec4(1.0); return; }
  ssR = min(ssR, 90.0);
  float rnd = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
  float sum = 0.0;
  float bias = u_aoP.z + 0.0015 * -P.z;
  for (int k = 0; k < NS; k++) {
    float a = (float(k) + 0.5) / float(NS);
    float ang = a * TURNS * 6.2831853 + rnd;
    float h = ssR * a;
    ivec2 q = p + ivec2(round(h * vec2(cos(ang), sin(ang))));
    if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, sz))) continue;
    vec3 v = vpos(q, res) - P;
    float vv = dot(v, v), vn = dot(v, N);
    float f = max(r2 - vv, 0.0);
    sum += f * f * f * max((vn - bias) / (vv + 0.01), 0.0);
  }
  float t = r2 * r;
  sum /= t * t;
  float A = max(0.0, 1.0 - sum * u_aoP.y * (5.0 / float(NS)));
  // flache Kanten: leichte Abschwächung, weit entfernte Flächen ausblenden
  A = mix(1.0, A, 1.0 - smoothstep(70.0, 140.0, -P.z));
  o = vec4(A, 0.0, 0.0, 1.0);
}`;

const AO_BLUR_FS = `
uniform sampler2D u_src;
uniform sampler2D u_hd;
uniform ivec2 u_dir;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(u_src, 0) - 1;
  float z = texelFetch(u_hd, p, 0).r;
  float sum = texelFetch(u_src, p, 0).r * 0.2270270;
  float ws = 0.2270270;
  const float W[4] = float[4](0.1945946, 0.1216216, 0.0540540, 0.0162162);
  float k = 1.0 / (z * 0.04 + 0.03);
  for (int i = 1; i <= 4; i++) {
    for (int s = -1; s <= 1; s += 2) {
      ivec2 q = clamp(p + u_dir * (i * s), ivec2(0), sz);
      float zq = texelFetch(u_hd, q, 0).r;
      float w = W[i - 1] * max(0.0, 1.0 - abs(zq - z) * k);
      sum += texelFetch(u_src, q, 0).r * w; ws += w;
    }
  }
  o = vec4(sum / ws, 0.0, 0.0, 1.0);
}`;

// ---------------------------------------------------------------- Bloom
const BLOOM_DOWN_FS = `
uniform sampler2D u_src;
uniform vec2 u_texel;      // Quell-Texel
uniform vec4 u_thr;        // x threshold, y knee, z exposure, w prefilter(1)/0
out vec4 o;
vec3 tap(vec2 uv) { return textureLod(u_src, uv, 0.0).rgb; }
float kw(vec3 c) { return 1.0 / (1.0 + max(max(c.r, c.g), c.b)); }
void main() {
  vec2 uv = v_uv;
  vec2 t = u_texel;
  vec3 a = tap(uv + t * vec2(-2.0, 2.0)), b = tap(uv + t * vec2(0.0, 2.0)), c = tap(uv + t * vec2(2.0, 2.0));
  vec3 d = tap(uv + t * vec2(-2.0, 0.0)), e = tap(uv), f = tap(uv + t * vec2(2.0, 0.0));
  vec3 g = tap(uv + t * vec2(-2.0, -2.0)), h = tap(uv + t * vec2(0.0, -2.0)), i = tap(uv + t * vec2(2.0, -2.0));
  vec3 j = tap(uv + t * vec2(-1.0, 1.0)), k = tap(uv + t * vec2(1.0, 1.0));
  vec3 l = tap(uv + t * vec2(-1.0, -1.0)), m = tap(uv + t * vec2(1.0, -1.0));
  vec3 col;
  if (u_thr.w > 0.5) {
    // Karis-Mittel gegen Glühwürmchen (nur erste Stufe)
    vec3 g0 = (j + k + l + m) * 0.25, g1 = (a + b + d + e) * 0.25, g2 = (b + c + e + f) * 0.25, g3 = (d + e + g + h) * 0.25, g4 = (e + f + h + i) * 0.25;
    float w0 = kw(g0) * 0.5, w1 = kw(g1) * 0.125, w2 = kw(g2) * 0.125, w3 = kw(g3) * 0.125, w4 = kw(g4) * 0.125;
    col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    col *= u_thr.z;
    float br = max(max(col.r, col.g), col.b);
    float knee = u_thr.x * u_thr.y + 1e-4;
    float rq = clamp(br - u_thr.x + knee, 0.0, 2.0 * knee);
    rq = rq * rq / (4.0 * knee);
    col *= max(rq, br - u_thr.x) / max(br, 1e-4);
    col = min(col, vec3(256.0));
  } else {
    col = (j + k + l + m) * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + e * 0.125;
  }
  o = vec4(col, 1.0);
}`;

const BLOOM_UP_FS = `
uniform sampler2D u_src;
uniform vec2 u_texel;  // Quell-Texel (kleinere Stufe)
uniform float u_radius;
out vec4 o;
void main() {
  vec2 uv = v_uv;
  vec2 t = u_texel * u_radius;
  vec3 s = textureLod(u_src, uv, 0.0).rgb * 4.0;
  s += (textureLod(u_src, uv + vec2(-t.x, 0.0), 0.0).rgb + textureLod(u_src, uv + vec2(t.x, 0.0), 0.0).rgb
      + textureLod(u_src, uv + vec2(0.0, -t.y), 0.0).rgb + textureLod(u_src, uv + vec2(0.0, t.y), 0.0).rgb) * 2.0;
  s += textureLod(u_src, uv + vec2(-t.x, -t.y), 0.0).rgb + textureLod(u_src, uv + vec2(t.x, -t.y), 0.0).rgb
     + textureLod(u_src, uv + vec2(-t.x, t.y), 0.0).rgb + textureLod(u_src, uv + vec2(t.x, t.y), 0.0).rgb;
  o = vec4(s * (1.0 / 16.0), 1.0);
}`;

// ---------------------------------------------------------------- Tiefenunschärfe
const AO_APPLY = `
#ifdef AO
uniform sampler2D u_ambFrac;
uniform sampler2D u_ao;
uniform sampler2D u_hd;
uniform vec2 u_aoMix;   // x Stärke, y Anteil auf direktes Licht
float tg_aoUpsample(vec2 uv, float zc) {
  vec2 hres = vec2(textureSize(u_ao, 0));
  vec2 hp = uv * hres - 0.5;
  ivec2 i0 = ivec2(floor(hp));
  vec2 f = fract(hp);
  ivec2 mx = ivec2(hres) - 1;
  float sum = 0.0, ws = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    ivec2 q = clamp(i0 + o, ivec2(0), mx);
    float bw = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
    float zq = texelFetch(u_hd, q, 0).r;
    float w = bw * (1.0 / (1e-3 + abs(zq - zc) / max(zc, 1e-3) * 30.0)) + 1e-5;
    sum += texelFetch(u_ao, q, 0).r * w; ws += w;
  }
  return sum / ws;
}
vec3 tg_applyAO(vec3 col, vec2 uv, float zc) {
  float af = texture(u_ambFrac, uv).r;
  float ao = tg_aoUpsample(uv, zc);
  float k = (af + (1.0 - af) * u_aoMix.y) * (1.0 - ao) * u_aoMix.x;
  return col * (1.0 - k);
}
#endif
`;

const DOF_PREP_FS = `
uniform sampler2D u_scene;
uniform sampler2D u_depth;
uniform vec4 u_dofP;  // x focus, y aperture, z cocScale (Halbpixel), w maxCoc
${AO_APPLY}
out vec4 o;
void main() {
  vec2 uv = v_uv;
  vec3 c = textureLod(u_scene, uv, 0.0).rgb;
  float z = tg_linDepth(textureLod(u_depth, uv, 0.0).r);
#ifdef AO
  c = tg_applyAO(c, uv, z);
#endif
  float coc = u_dofP.y * (z - u_dofP.x) / max(z, 1e-3) * u_dofP.z;
  coc = clamp(coc, -u_dofP.w, u_dofP.w);
  o = vec4(min(c, vec3(64.0)), coc);
}`;

const DOF_BLUR_FS = `
uniform sampler2D u_src;
uniform vec4 u_dofP;  // w maxCoc
out vec4 o;
void main() {
  vec2 res = vec2(textureSize(u_src, 0));
  vec2 texel = 1.0 / res;
  vec2 uv = v_uv;
  vec4 c0 = textureLod(u_src, uv, 0.0);
  float cc = c0.a, cr = abs(cc);
  vec3 acc = c0.rgb; float tot = 1.0;
  float nearCov = 0.0;
  float maxR = u_dofP.w;
  float rs = 0.75;
  float radius = rs;
  float ang = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
  for (int k = 0; k < 96; k++) {
    if (radius >= maxR) break;
    vec2 tc = uv + vec2(cos(ang), sin(ang)) * texel * radius;
    vec4 s = textureLod(u_src, tc, 0.0);
    float sr = abs(s.a);
    if (s.a > cc) sr = min(sr, cr * 2.0);
    float m = smoothstep(radius - 0.5, radius + 0.5, sr);
    acc += mix(acc / tot, s.rgb, m); tot += 1.0;
    if (s.a < 0.0) nearCov = max(nearCov, m * saturate(-s.a - 0.5));
    ang += 2.39996323;
    radius += rs / radius;
  }
  o = vec4(acc / tot, max(cr, nearCov * maxR));
}`;

// ---------------------------------------------------------------- Komposition + Tonemapping
const COMPOSITE_FS = `
uniform sampler2D u_scene;
uniform sampler2D u_depth;
uniform sampler2D u_bloom;
uniform sampler2D u_dof;
uniform vec4 u_p0;   // x exposure, y bloom (bereits / Stufen), z saturation, w contrast
uniform vec4 u_p1;   // x temperature, y vignette, z grain, w seed
uniform vec4 u_p2;   // x focus, y aperture, z cocScale, w sharpen
uniform vec3 u_lift;
uniform vec3 u_gain;
uniform vec2 u_srcTexel;
${AO_APPLY}
out vec4 o;

vec3 tg_neutral(vec3 color) {
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) return color;
  const float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / (peak + d - startCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}
vec3 tg_agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 tg_agx(vec3 v) {
  const mat3 m = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                      0.0784335999999992, 0.878468636469772, 0.0784336,
                      0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const mat3 mi = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                       -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                       -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  const float lo = -12.47393, hi = 4.026069;
  v = m * max(v, vec3(1e-10));
  v = clamp(log2(v), lo, hi);
  v = (v - lo) / (hi - lo);
  v = tg_agxContrast(v);
  // "punchy" Look
  float l = dot(v, vec3(0.2126, 0.7152, 0.0722));
  v = pow(max(v, vec3(0.0)), vec3(1.35));
  v = l + 1.4 * (v - l);
  v = mi * v;
  return pow(max(v, vec3(0.0)), vec3(2.2));
}
vec3 tg_linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 uv = v_uv;
  vec3 col = textureLod(u_scene, uv, 0.0).rgb;
#if SHARPEN
  // leichtes Nachschärfen bei reduzierter Renderauflösung (Kontrast-adaptiv)
  {
    vec3 n = textureLod(u_scene, uv + vec2(0.0, u_srcTexel.y), 0.0).rgb;
    vec3 s = textureLod(u_scene, uv - vec2(0.0, u_srcTexel.y), 0.0).rgb;
    vec3 e = textureLod(u_scene, uv + vec2(u_srcTexel.x, 0.0), 0.0).rgb;
    vec3 w = textureLod(u_scene, uv - vec2(u_srcTexel.x, 0.0), 0.0).rgb;
    vec3 mn = min(col, min(min(n, s), min(e, w))), mx = max(col, max(max(n, s), max(e, w)));
    vec3 amp = sqrt(saturate(min(mn, 2.0 - mx) / max(mx, 1e-4)));
    vec3 wgt = -amp * u_p2.w * 0.2;
    col = max((col + (n + s + e + w) * wgt) / (1.0 + 4.0 * wgt), vec3(0.0));
  }
#endif
#if defined(AO) || defined(DOF)
  float zc = tg_linDepth(textureLod(u_depth, uv, 0.0).r);
#endif
#ifdef AO
  col = tg_applyAO(col, uv, zc);
#endif
#if DEBUG_VIEW == 1 && defined(AO)
  o = vec4(vec3(tg_aoUpsample(uv, zc)), 1.0); return;
#elif DEBUG_VIEW == 2 && defined(AO)
  o = vec4(vec3(texture(u_ambFrac, uv).r), 1.0); return;
#endif
#ifdef DOF
  {
    vec4 b = textureLod(u_dof, uv, 0.0);
    float coc = abs(u_p2.y * (zc - u_p2.x) / max(zc, 1e-3) * u_p2.z);
    float t = smoothstep(0.35, 1.4, max(coc, b.a));
    col = mix(col, b.rgb, t);
  }
#endif
#ifdef BLOOM
  col += textureLod(u_bloom, uv, 0.0).rgb * u_p0.y;
#endif
  col *= u_p0.x;
  // Weißabgleich (Temperatur) und Sättigung im linearen Raum
  float tmp = u_p1.x;
  vec3 wb = vec3(1.0 + 0.10 * tmp, 1.0 + 0.012 * tmp, 1.0 - 0.12 * tmp);
  col *= wb / dot(wb, vec3(0.2126, 0.7152, 0.0722));
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(lum), col, u_p0.z), vec3(0.0));
#if TONEMAP == 1
  col = tg_agx(col);
#else
  col = tg_neutral(col);
#endif
  // Vignette (linear, multiplikativ)
  vec2 vc = (uv - 0.5) * vec2(1.0, 0.82);
  col *= 1.0 - u_p1.y * smoothstep(0.18, 0.72, dot(vc, vc) * 2.2);
  vec3 s = tg_linearToSrgb(saturate(col));
  // Kontrast um Mittelgrau, Lift/Gain (Anzeigeraum)
  s = saturate((s - 0.5) * u_p0.w + 0.5);
  s = s * u_gain + u_lift * (1.0 - s);
  // Filmkorn (mitteltonbetont) + Dithering gegen Banding
  vec2 fc = gl_FragCoord.xy + fract(u_p1.w * 0.6180339) * 113.0;
  float n1 = hash12(fc), n2 = hash12(fc + 71.3);
  float sl = dot(s, vec3(0.2126, 0.7152, 0.0722));
  s += (n1 - 0.5) * u_p1.z * 4.0 * sl * (1.0 - sl);
  s += (n1 + n2 - 1.0) / 255.0;
  s = saturate(s);
#ifdef FXAA_OUT
  o = vec4(s, dot(s, vec3(0.299, 0.587, 0.114)));
#else
  o = vec4(s, 1.0);
#endif
}`;

const FXAA_FS = `
uniform sampler2D u_src;
uniform vec2 u_texel;
out vec4 o;
float L(vec2 p) { return textureLod(u_src, p, 0.0).a; }
void main() {
  vec2 posM = v_uv;
  vec4 rgbyM = textureLod(u_src, posM, 0.0);
  float lumaM = rgbyM.a;
  float lumaS = textureLodOffset(u_src, posM, 0.0, ivec2(0, 1)).a;
  float lumaE = textureLodOffset(u_src, posM, 0.0, ivec2(1, 0)).a;
  float lumaN = textureLodOffset(u_src, posM, 0.0, ivec2(0, -1)).a;
  float lumaW = textureLodOffset(u_src, posM, 0.0, ivec2(-1, 0)).a;
  float maxSM = max(lumaS, lumaM), minSM = min(lumaS, lumaM);
  float maxESM = max(lumaE, maxSM), minESM = min(lumaE, minSM);
  float maxWN = max(lumaN, lumaW), minWN = min(lumaN, lumaW);
  float rangeMax = max(maxWN, maxESM), rangeMin = min(minWN, minESM);
  float range = rangeMax - rangeMin;
  if (range < max(0.0625, rangeMax * 0.125)) { o = vec4(rgbyM.rgb, 1.0); return; }
  float lumaNW = textureLodOffset(u_src, posM, 0.0, ivec2(-1, -1)).a;
  float lumaSE = textureLodOffset(u_src, posM, 0.0, ivec2(1, 1)).a;
  float lumaNE = textureLodOffset(u_src, posM, 0.0, ivec2(1, -1)).a;
  float lumaSW = textureLodOffset(u_src, posM, 0.0, ivec2(-1, 1)).a;
  float lumaNS = lumaN + lumaS, lumaWE = lumaW + lumaE;
  float subpixRcpRange = 1.0 / range;
  float subpixNSWE = lumaNS + lumaWE;
  float edgeHorz1 = -2.0 * lumaM + lumaNS, edgeVert1 = -2.0 * lumaM + lumaWE;
  float lumaNESE = lumaNE + lumaSE, lumaNWNE = lumaNW + lumaNE;
  float edgeHorz2 = -2.0 * lumaE + lumaNESE, edgeVert2 = -2.0 * lumaN + lumaNWNE;
  float lumaNWSW = lumaNW + lumaSW, lumaSWSE = lumaSW + lumaSE;
  float edgeHorz4 = abs(edgeHorz1) * 2.0 + abs(edgeHorz2);
  float edgeVert4 = abs(edgeVert1) * 2.0 + abs(edgeVert2);
  float edgeHorz3 = -2.0 * lumaW + lumaNWSW, edgeVert3 = -2.0 * lumaS + lumaSWSE;
  float edgeHorz = abs(edgeHorz3) + edgeHorz4, edgeVert = abs(edgeVert3) + edgeVert4;
  float subpixNWSWNESE = lumaNWSW + lumaNESE;
  float lengthSign = u_texel.x;
  bool horzSpan = edgeHorz >= edgeVert;
  float subpixA = subpixNSWE * 2.0 + subpixNWSWNESE;
  if (!horzSpan) { lumaN = lumaW; lumaS = lumaE; } else lengthSign = u_texel.y;
  float subpixB = subpixA * (1.0 / 12.0) - lumaM;
  float gradientN = lumaN - lumaM, gradientS = lumaS - lumaM;
  float lumaNN = lumaN + lumaM, lumaSS = lumaS + lumaM;
  bool pairN = abs(gradientN) >= abs(gradientS);
  float gradient = max(abs(gradientN), abs(gradientS));
  if (pairN) lengthSign = -lengthSign;
  float subpixC = saturate(abs(subpixB) * subpixRcpRange);
  vec2 posB = posM;
  vec2 offNP = horzSpan ? vec2(u_texel.x, 0.0) : vec2(0.0, u_texel.y);
  if (!horzSpan) posB.x += lengthSign * 0.5; else posB.y += lengthSign * 0.5;
  vec2 posN = posB - offNP, posP = posB + offNP;
  float subpixD = -2.0 * subpixC + 3.0;
  float lumaEndN = L(posN), lumaEndP = L(posP);
  float subpixE = subpixC * subpixC;
  if (!pairN) lumaNN = lumaSS;
  float gradientScaled = gradient * 0.25;
  float lumaMM = lumaM - lumaNN * 0.5;
  float subpixF = subpixD * subpixE;
  bool lumaMLTZero = lumaMM < 0.0;
  lumaEndN -= lumaNN * 0.5; lumaEndP -= lumaNN * 0.5;
  bool doneN = abs(lumaEndN) >= gradientScaled, doneP = abs(lumaEndP) >= gradientScaled;
  if (!doneN) posN -= offNP * 1.5;
  if (!doneP) posP += offNP * 1.5;
  const float STEPS[8] = float[8](2.0, 2.0, 2.0, 2.0, 4.0, 4.0, 8.0, 12.0);
  for (int k = 0; k < 8; k++) {
    if (doneN && doneP) break;
    if (!doneN) lumaEndN = L(posN) - lumaNN * 0.5;
    if (!doneP) lumaEndP = L(posP) - lumaNN * 0.5;
    doneN = abs(lumaEndN) >= gradientScaled; doneP = abs(lumaEndP) >= gradientScaled;
    if (!doneN) posN -= offNP * STEPS[k];
    if (!doneP) posP += offNP * STEPS[k];
  }
  float dstN = horzSpan ? posM.x - posN.x : posM.y - posN.y;
  float dstP = horzSpan ? posP.x - posM.x : posP.y - posM.y;
  bool goodSpanN = (lumaEndN < 0.0) != lumaMLTZero, goodSpanP = (lumaEndP < 0.0) != lumaMLTZero;
  float spanLength = dstP + dstN;
  bool directionN = dstN < dstP;
  float dst = min(dstN, dstP);
  bool goodSpan = directionN ? goodSpanN : goodSpanP;
  float subpixG = subpixF * subpixF;
  float pixelOffset = dst * (-1.0 / spanLength) + 0.5;
  float subpixH = subpixG * 0.6;
  float pixelOffsetGood = goodSpan ? pixelOffset : 0.0;
  float pixelOffsetSubpix = max(pixelOffsetGood, subpixH);
  if (!horzSpan) posM.x += pixelOffsetSubpix * lengthSign; else posM.y += pixelOffsetSubpix * lengthSign;
  o = vec4(textureLod(u_src, posM, 0.0).rgb, 1.0);
}`;

// ---------------------------------------------------------------- PostFX
const HEAD = (defs) => GLSL_HEADER + defs + GLSL_FRAME_UBO + GLSL_COMMON + LIN_DEPTH + 'in vec2 v_uv;\n';

export class PostFX {
  constructor(renderer) {
    this.r = renderer;
    this.gl = renderer.gl;
    this.passes = new Map();
    this.t = null;
    this.bloomLevels = 0;
  }

  _pass(key, fs, defs = '') {
    let p = this.passes.get(key);
    if (p) return p;
    const gl = this.gl;
    const prog = createProgram(gl, FULLSCREEN_VS, HEAD(defs) + fs, 'post:' + key);
    const bi = gl.getUniformBlockIndex(prog, 'Frame');
    if (bi !== gl.INVALID_INDEX) gl.uniformBlockBinding(prog, bi, 0);
    const info = getUniformInfo(gl, prog);
    const u = {};
    for (const [n, e] of info) u[n] = e.loc;
    // Sampler-Einheiten fest vergeben (Reihenfolge der Deklaration egal)
    const units = {};
    let unit = 0;
    gl.useProgram(prog);
    for (const [n, e] of info) {
      if (e.type === gl.SAMPLER_2D) { units[n] = unit; gl.uniform1i(e.loc, unit); unit++; }
    }
    this.r.state.program = prog;
    p = { prog, u, units };
    this.passes.set(key, p);
    return p;
  }

  _tex(p, name, tex) {
    const unit = p.units[name];
    if (unit === undefined) return;
    this.r.state.bindTexture(unit, this.gl.TEXTURE_2D, tex);
  }

  _target(w, h, ifmt, filter) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, ifmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Post-Target unvollständig: 0x' + st.toString(16));
    return { tex, fbo, w, h };
  }

  dispose() {
    const t = this.t; if (!t) return;
    const gl = this.gl;
    const all = [t.hd, t.ao0, t.ao1, t.dofA, t.dofB, t.ldr, ...(t.bloom || [])];
    for (const x of all) if (x) { gl.deleteTexture(x.tex); gl.deleteFramebuffer(x.fbo); }
    this.t = null;
    this.r.state.reset();
  }

  _ensure(w, h, outW, outH) {
    const q = this.r.q;
    const hdr = this.r.hdrRenderable;
    const key = `${w}x${h}|${outW}x${outH}|${q.ssao}|${q.bloom}|${q.dof}|${q.fxaa}|${hdr}`;
    if (this.t && this.t.key === key) return this.t;
    this.dispose();
    const gl = this.gl;
    const hw = Math.max(1, (w + 1) >> 1), hh = Math.max(1, (h + 1) >> 1);
    const t = { key, hw, hh };
    const hdrFmt = hdr ? gl.RGBA16F : gl.RGBA8;
    if (q.ssao && hdr) {
      t.hd = this._target(hw, hh, gl.R32F, gl.NEAREST);
      t.ao0 = this._target(hw, hh, gl.R8, gl.LINEAR);
      t.ao1 = this._target(hw, hh, gl.R8, gl.LINEAR);
    }
    if (q.bloom) {
      t.bloom = [];
      let bw = hw, bh = hh;
      for (let i = 0; i < 7 && bw >= 4 && bh >= 4; i++) {
        t.bloom.push(this._target(bw, bh, hdrFmt, gl.LINEAR));
        bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
      }
    }
    if (q.dof) {
      t.dofA = this._target(hw, hh, hdrFmt, gl.LINEAR);
      t.dofB = this._target(hw, hh, hdrFmt, gl.LINEAR);
    }
    if (q.fxaa) t.ldr = this._target(outW, outH, gl.RGBA8, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.r.state.reset();
    this.t = t;
    return t;
  }

  _draw() { this.gl.drawArrays(this.gl.TRIANGLES, 0, 3); this.r.stats.postPasses++; }

  /** HDR-Szene (T) -> Canvas. */
  render(scene, cam, T) {
    const r = this.r, gl = this.gl, st = r.state, q = r.q;
    const outW = r.width, outH = r.height;
    const t = this._ensure(T.w, T.h, outW, outH);
    const P = scene.post || POST_DEFAULTS, D = POST_DEFAULTS;
    r.stats.postPasses = 0;
    st.bindVAO(r.emptyVAO);
    st.setBlend(0); st.setDepth(false, false); st.setCull(0); st.setA2C(false); st.setPolygonOffset(0, 0);
    const exposure = scene.exposure ?? 1;

    // ---- SSAO
    const aoOn = !!(t.hd && T.mrt && T.aoWTex && (P.ao ?? D.ao) > 0);
    if (aoOn) {
      st.bindFBO(t.hd.fbo); st.viewport(0, 0, t.hw, t.hh);
      let p = this._pass('depthDown', DEPTH_DOWN_FS);
      st.useProgram(p.prog);
      this._tex(p, 'u_depth', T.depthTex);
      this._draw();

      st.bindFBO(t.ao0.fbo);
      p = this._pass('ssao', SSAO_FS);
      st.useProgram(p.prog);
      this._tex(p, 'u_hd', t.hd.tex);
      const proj = cam.proj;
      const radius = P.aoRadius ?? D.aoRadius;
      gl.uniform4f(p.u.u_aoP, radius, 1.0, P.aoBias ?? D.aoBias, proj[5] * t.hh * 0.5);
      gl.uniform2f(p.u.u_invProj, 1 / proj[0], 1 / proj[5]);
      this._draw();

      p = this._pass('aoBlur', AO_BLUR_FS);
      st.useProgram(p.prog);
      this._tex(p, 'u_hd', t.hd.tex);
      st.bindFBO(t.ao1.fbo);
      this._tex(p, 'u_src', t.ao0.tex);
      gl.uniform2i(p.u.u_dir, 1, 0);
      this._draw();
      st.bindFBO(t.ao0.fbo);
      this._tex(p, 'u_src', t.ao1.tex);
      gl.uniform2i(p.u.u_dir, 0, 1);
      this._draw();
    }

    // ---- Bloom
    const bloomAmt = P.bloom ?? D.bloom;
    const bloomOn = !!(t.bloom && t.bloom.length && bloomAmt > 0);
    if (bloomOn) {
      const B = t.bloom;
      let p = this._pass('bloomDown', BLOOM_DOWN_FS);
      st.useProgram(p.prog);
      for (let i = 0; i < B.length; i++) {
        const dst = B[i];
        st.bindFBO(dst.fbo); st.viewport(0, 0, dst.w, dst.h);
        const srcTex = i === 0 ? T.sceneTex : B[i - 1].tex;
        const sw = i === 0 ? T.w : B[i - 1].w, sh = i === 0 ? T.h : B[i - 1].h;
        this._tex(p, 'u_src', srcTex);
        gl.uniform2f(p.u.u_texel, 1 / sw, 1 / sh);
        gl.uniform4f(p.u.u_thr, P.bloomThreshold ?? D.bloomThreshold, P.bloomKnee ?? D.bloomKnee, exposure, i === 0 ? 1 : 0);
        this._draw();
      }
      p = this._pass('bloomUp', BLOOM_UP_FS);
      st.useProgram(p.prog);
      st.setBlend(5);
      for (let i = B.length - 2; i >= 0; i--) {
        const dst = B[i], src = B[i + 1];
        st.bindFBO(dst.fbo); st.viewport(0, 0, dst.w, dst.h);
        this._tex(p, 'u_src', src.tex);
        gl.uniform2f(p.u.u_texel, 1 / src.w, 1 / src.h);
        gl.uniform1f(p.u.u_radius, 1.0);
        this._draw();
      }
      st.setBlend(0);
    }

    // ---- Tiefenunschärfe
    const dof = cam.dof;
    const dofOn = !!(q.dof && t.dofA && dof && (dof.aperture ?? 0) > 0);
    const cocScale = t.hh * 0.045;
    const maxCoc = Math.min(14, Math.max(4, t.hh / 40));
    if (dofOn) {
      st.bindFBO(t.dofA.fbo); st.viewport(0, 0, t.hw, t.hh);
      let p = this._pass(aoOn ? 'dofPrepAO' : 'dofPrep', DOF_PREP_FS, aoOn ? '#define AO 1\n' : '');
      st.useProgram(p.prog);
      this._tex(p, 'u_scene', T.sceneTex);
      this._tex(p, 'u_depth', T.depthTex);
      if (aoOn) this._bindAO(p, T, t, P);
      gl.uniform4f(p.u.u_dofP, dof.focus ?? 10, dof.aperture ?? 0.5, cocScale, maxCoc);
      this._draw();
      st.bindFBO(t.dofB.fbo);
      p = this._pass('dofBlur', DOF_BLUR_FS);
      st.useProgram(p.prog);
      this._tex(p, 'u_src', t.dofA.tex);
      gl.uniform4f(p.u.u_dofP, 0, 0, 0, maxCoc);
      this._draw();
    }

    // ---- Komposition
    const tm = (P.tonemap ?? D.tonemap) === 'agx' ? 1 : 0;
    const sharpen = r.renderScale < 0.99 ? (P.sharpen ?? D.sharpen) : 0;
    const fx = !!t.ldr;
    const dbg = DEBUG_VIEWS[P.debug] || 0;
    const key = `comp${aoOn ? 'A' : ''}${bloomOn ? 'B' : ''}${dofOn ? 'D' : ''}${fx ? 'F' : ''}${tm}${sharpen > 0 ? 'S' : ''}${dbg}`;
    let defs = `#define TONEMAP ${tm}\n#define SHARPEN ${sharpen > 0 ? 1 : 0}\n#define DEBUG_VIEW ${dbg}\n`;
    if (aoOn) defs += '#define AO 1\n';
    if (bloomOn) defs += '#define BLOOM 1\n';
    if (dofOn) defs += '#define DOF 1\n';
    if (fx) defs += '#define FXAA_OUT 1\n';
    const p = this._pass(key, COMPOSITE_FS, defs);
    st.bindFBO(fx ? t.ldr.fbo : null);
    st.viewport(0, 0, outW, outH);
    st.useProgram(p.prog);
    this._tex(p, 'u_scene', T.sceneTex);
    this._tex(p, 'u_depth', T.depthTex);
    if (aoOn) this._bindAO(p, T, t, P);
    if (bloomOn) this._tex(p, 'u_bloom', t.bloom[0].tex);
    if (dofOn) this._tex(p, 'u_dof', t.dofB.tex);
    const levels = bloomOn ? t.bloom.length : 1;
    gl.uniform4f(p.u.u_p0, exposure, bloomOn ? (bloomAmt * 0.6) / levels : 0, P.saturation ?? D.saturation, P.contrast ?? D.contrast);
    gl.uniform4f(p.u.u_p1, P.temperature ?? D.temperature, P.vignette ?? D.vignette, P.grain ?? D.grain, (scene.time ?? 0) * 60);
    gl.uniform4f(p.u.u_p2, dof?.focus ?? 10, dof?.aperture ?? 0, cocScale, sharpen);
    const lift = P.lift || D.lift, gain = P.gain || D.gain;
    gl.uniform3f(p.u.u_lift, lift[0], lift[1], lift[2]);
    gl.uniform3f(p.u.u_gain, gain[0], gain[1], gain[2]);
    if (p.u.u_srcTexel) gl.uniform2f(p.u.u_srcTexel, 1 / T.w, 1 / T.h);
    this._draw();

    // ---- FXAA
    if (fx) {
      const pf = this._pass('fxaa', FXAA_FS);
      st.bindFBO(null);
      st.viewport(0, 0, outW, outH);
      st.useProgram(pf.prog);
      this._tex(pf, 'u_src', t.ldr.tex);
      gl.uniform2f(pf.u.u_texel, 1 / outW, 1 / outH);
      this._draw();
    }
  }

  _bindAO(p, T, t, P) {
    this._tex(p, 'u_ambFrac', T.aoWTex);
    this._tex(p, 'u_ao', t.ao0.tex);
    this._tex(p, 'u_hd', t.hd.tex);
    this.gl.uniform2f(p.u.u_aoMix, P.ao ?? POST_DEFAULTS.ao, P.aoDirect ?? POST_DEFAULTS.aoDirect);
  }
}

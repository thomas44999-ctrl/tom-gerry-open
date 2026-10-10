// GLSL-Bibliothek: Frame-Uniform-Block, öffentliche Helfer (Hash/Noise/FBM/Voronoi/…),
// BRDF, Kaskaden-Schatten, Umgebungslicht (SH + vorgefilterte Sky-Cubemap), Nebel.
// Interne Funktionen tragen das Präfix tg_, damit sie nicht mit Material-Code kollidieren.

export const GLSL_HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp samplerCube;
precision highp sampler2DArray;
precision highp sampler2DArrayShadow;
precision highp sampler2DShadow;
precision highp sampler3D;
`;

// ---------------------------------------------------------------- Frame-UBO (std140)
// Float-Offsets für renderer.js (müssen exakt zur Deklaration passen).
export const FRAME = {
  view: 0, proj: 16, viewProj: 32, invViewProj: 48, shadowMat0: 64, shadowMat1: 80,
  cameraPos: 96, time: 99, sunDir: 100, shadowStrength: 103, sunColor: 104, exposure: 107,
  cameraRight: 108, near: 111, cameraUp: 112, far: 115, cameraFwd: 116, shadowCascades: 119,
  resolution: 120, invResolution: 122, hemiSky: 124, hemiIntensity: 127, hemiGround: 128, envIntensity: 131,
  fogColor: 132, fogDensity: 135, fogParams: 136, shadowParams0: 140, shadowParams1: 144,
  sh: 148 /* 9 x vec4 */, skyZenith: 184, skyHorizon: 188, skyGround: 192, skySunGlow: 196,
  cloudParams: 200, cloudWind: 204, cloudColor: 208, cloudShade: 212, misc: 216, skyMisc: 220,
  shadowParams2: 224, SIZE: 228,
};

export const GLSL_FRAME_UBO = `
layout(std140) uniform Frame {
  mat4 u_view;
  mat4 u_proj;
  mat4 u_viewProj;
  mat4 u_invViewProj;
  mat4 u_shadowMat0;
  mat4 u_shadowMat1;
  vec3 u_cameraPos;   float u_time;
  vec3 u_sunDir;      float u_shadowStrength;
  vec3 u_sunColor;    float u_exposure;
  vec3 u_cameraRight; float u_near;
  vec3 u_cameraUp;    float u_far;
  vec3 u_cameraFwd;   float u_shadowCascades;
  vec2 u_resolution;  vec2 u_invResolution;
  vec3 u_hemiSky;     float u_hemiIntensity;
  vec3 u_hemiGround;  float u_envIntensity;
  vec3 u_fogColor;    float u_fogDensity;
  vec4 u_fogParams;      // x heightFalloff, y baseHeight, z sunScatter, w maxFog
  vec4 u_shadowParams0;  // x texelWorld c0, y texelWorld c1, z normalBias (texel), w depthBias
  vec4 u_shadowParams1;  // x blend band, y map size, z 1/size, w enabled
  vec4 u_sh[9];          // SH-Irradianz (vorgefaltet, /PI)
  vec4 u_skyZenith;      // rgb, w horizon exponent
  vec4 u_skyHorizon;     // rgb, w horizon sharpness
  vec4 u_skyGround;      // rgb, w unused
  vec4 u_skySunGlow;     // rgb, w strength
  vec4 u_cloudParams;    // x coverage, y density, z scale, w softness
  vec4 u_cloudWind;      // xy offset, z curvature, w brightness
  vec4 u_cloudColor;     // rgb lit, w silver lining
  vec4 u_cloudShade;     // rgb shadow, w opacity
  vec4 u_misc;           // x envMaxLod, y ssao, z renderScale, w frame
  vec4 u_skyMisc;        // x sun disc cos, y sun disc intensity, z sky brightness, w aureole
  vec4 u_shadowParams2;  // x depthBias c1, yzw reserviert
};
`;

// ---------------------------------------------------------------- öffentliche Helfer (beide Stufen)
export const GLSL_COMMON = `
#define TG_PI 3.14159265359
#define TG_INV_PI 0.31830988618
float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec2 saturate(vec2 x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
vec4 saturate(vec4 x) { return clamp(x, 0.0, 1.0); }
float remap(float x, float a0, float a1, float b0, float b1) { return b0 + (b1 - b0) * clamp((x - a0) / (a1 - a0), 0.0, 1.0); }
float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
float srgbToLinear(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
mat2 rotate2d(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

// Hash without Sine (Dave Hoskins)
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash33(vec3 p3) { p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }

// Wertrauschen [0,1]
float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0)), c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1, 0, 0)), n010 = hash13(i + vec3(0, 1, 0)), n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1)), n101 = hash13(i + vec3(1, 0, 1)), n011 = hash13(i + vec3(0, 1, 1)), n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}

// Simplex-Rauschen [-1,1] (Ashima Arts / Ian McEwan, MIT)
vec2 tg_mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 tg_mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 tg_mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 tg_permute(vec3 x) { return tg_mod289(((x * 34.0) + 1.0) * x); }
vec4 tg_permute(vec4 x) { return tg_mod289(((x * 34.0) + 1.0) * x); }
float snoise2(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = tg_mod289(i);
  vec3 p = tg_permute(tg_permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
float snoise3(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = tg_mod289(i);
  vec4 p = tg_permute(tg_permute(tg_permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = 1.79284291400159 - 0.85373472095314 * vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// Fraktales Rauschen (Wertrauschen, [0,1]); oct <= 10
float fbm2(vec2 p, int oct) {
  float a = 0.5, s = 0.0, n = 0.0;
  const mat2 r = mat2(0.80, 0.60, -0.60, 0.80);
  for (int k = 0; k < 10; k++) {
    if (k >= oct) break;
    s += a * noise2(p); n += a;
    p = r * p * 2.02 + vec2(17.13, 3.71); a *= 0.5;
  }
  return s / max(n, 1e-5);
}
float fbm3(vec3 p, int oct) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int k = 0; k < 10; k++) {
    if (k >= oct) break;
    s += a * noise3(p); n += a;
    p = p * 2.03 + vec3(17.13, 3.71, 9.19); a *= 0.5;
  }
  return s / max(n, 1e-5);
}
// Zellrauschen: x = Abstand zum nächsten Zellpunkt (F1), y = Zell-ID (Hash [0,1])
vec2 voronoi2(vec2 p) {
  vec2 n = floor(p), f = fract(p);
  float md = 8.0; vec2 mc = n;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + hash22(n + g) - f;
    float d = dot(r, r);
    if (d < md) { md = d; mc = n + g; }
  }
  return vec2(sqrt(md), hash12(mc));
}
`;

// ---------------------------------------------------------------- nur Fragment
export const GLSL_FRAG_HELPERS = `
// Bump-Mapping ohne Tangenten (Mikkelsen 2010, Bildschirm-Ableitungen).
vec3 bumpNormal(vec3 n, vec3 worldPos, float height, float strength) {
  vec3 dpdx = dFdx(worldPos), dpdy = dFdy(worldPos);
  float dhdx = dFdx(height), dhdy = dFdy(height);
  vec3 r1 = cross(dpdy, n), r2 = cross(n, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
  return normalize(abs(det) * n - strength * grad);
}
float tg_ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

// ---------------------------------------------------------------- Oberflächen-Structs
export const GLSL_SURFACE_STRUCTS = `
struct SurfaceInput {
  vec3 worldPos; vec3 normal;
  vec3 objPos; vec3 objNormal;
  vec2 uv; vec4 color; vec4 data;
  vec4 instColor; vec4 instData;
  float shell;
  vec3 viewDir;
  float time; vec2 fragCoord;
};
struct Surface {
  vec3 albedo; float alpha;
  vec3 normal;
  float roughness; float metalness; float specular;
  vec3 emissive; float ao;
  float subsurface; vec3 subsurfaceColor;
  float sheen; vec3 sheenColor;
  float shadow;                    // zusätzlicher Sonnen-Schattenfaktor (init 1), z.B. analytische Dachschatten
};
`;

// ---------------------------------------------------------------- Beleuchtung
export const GLSL_LIGHTING = `
uniform highp sampler2DArrayShadow u_shadowMap;
uniform samplerCube u_envMap;

float tg_D_GGX(float NoH, float a) { float a2 = a * a; float f = (NoH * a2 - NoH) * NoH + 1.0; return a2 / (TG_PI * f * f + 1e-7); }
float tg_V_SmithGGX(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gl = NoV * sqrt((-NoL * a2 + NoL) * NoL + a2);
  float gv = NoL * sqrt((-NoV * a2 + NoV) * NoV + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
vec3 tg_F_Schlick(vec3 f0, float VoH) { float f = pow(1.0 - VoH, 5.0); return f + f0 * (1.0 - f); }
float tg_D_Charlie(float r, float NoH) { float inv = 1.0 / r; float s2 = max(1.0 - NoH * NoH, 0.0078125); return (2.0 + inv) * pow(s2, inv * 0.5) / (2.0 * TG_PI); }
float tg_V_Neubelt(float NoV, float NoL) { return clamp(1.0 / (4.0 * (NoL + NoV - NoL * NoV) + 1e-4), 0.0, 1.0); }
vec3 tg_envBRDF(vec3 f0, float rough, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  vec2 ab = vec2(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}

// SH-Irradianz, vorgefaltet und durch PI geteilt: Ergebnis * albedo = diffuses Umgebungslicht
vec3 tg_shIrradiance(vec3 n) {
  return max(u_sh[0].rgb
    + u_sh[1].rgb * n.y + u_sh[2].rgb * n.z + u_sh[3].rgb * n.x
    + u_sh[4].rgb * (n.x * n.y) + u_sh[5].rgb * (n.y * n.z) + u_sh[6].rgb * (3.0 * n.z * n.z - 1.0)
    + u_sh[7].rgb * (n.x * n.z) + u_sh[8].rgb * (n.x * n.x - n.y * n.y), vec3(0.0));
}

// ---- Schatten: optimiertes PCF (Castaño 2013) auf Hardware-Vergleich
float tg_shadowTap(vec2 base, vec2 o, float layer, float z) {
  return texture(u_shadowMap, vec4(base + o * u_shadowParams1.z, layer, z));
}
float tg_shadowPCF(vec3 sc, float layer) {
  vec2 uv = sc.xy * u_shadowParams1.y;
  vec2 base = floor(uv + 0.5);
  float s = uv.x + 0.5 - base.x;
  float t = uv.y + 0.5 - base.y;
  base = (base - 0.5) * u_shadowParams1.z;
  float z = sc.z;
  float sum = 0.0;
#if SHADOW_FILTER == 3
  float uw0 = 3.0 - 2.0 * s, uw1 = 1.0 + 2.0 * s;
  float u0 = (2.0 - s) / uw0 - 1.0, u1 = s / uw1 + 1.0;
  float vw0 = 3.0 - 2.0 * t, vw1 = 1.0 + 2.0 * t;
  float v0 = (2.0 - t) / vw0 - 1.0, v1 = t / vw1 + 1.0;
  sum += uw0 * vw0 * tg_shadowTap(base, vec2(u0, v0), layer, z);
  sum += uw1 * vw0 * tg_shadowTap(base, vec2(u1, v0), layer, z);
  sum += uw0 * vw1 * tg_shadowTap(base, vec2(u0, v1), layer, z);
  sum += uw1 * vw1 * tg_shadowTap(base, vec2(u1, v1), layer, z);
  return sum / 16.0;
#elif SHADOW_FILTER == 5
  float uw0 = 4.0 - 3.0 * s, uw1 = 7.0, uw2 = 1.0 + 3.0 * s;
  float u0 = (3.0 - 2.0 * s) / uw0 - 2.0, u1 = (3.0 + s) / uw1, u2 = s / uw2 + 2.0;
  float vw0 = 4.0 - 3.0 * t, vw1 = 7.0, vw2 = 1.0 + 3.0 * t;
  float v0 = (3.0 - 2.0 * t) / vw0 - 2.0, v1 = (3.0 + t) / vw1, v2 = t / vw2 + 2.0;
  sum += uw0 * vw0 * tg_shadowTap(base, vec2(u0, v0), layer, z);
  sum += uw1 * vw0 * tg_shadowTap(base, vec2(u1, v0), layer, z);
  sum += uw2 * vw0 * tg_shadowTap(base, vec2(u2, v0), layer, z);
  sum += uw0 * vw1 * tg_shadowTap(base, vec2(u0, v1), layer, z);
  sum += uw1 * vw1 * tg_shadowTap(base, vec2(u1, v1), layer, z);
  sum += uw2 * vw1 * tg_shadowTap(base, vec2(u2, v1), layer, z);
  sum += uw0 * vw2 * tg_shadowTap(base, vec2(u0, v2), layer, z);
  sum += uw1 * vw2 * tg_shadowTap(base, vec2(u1, v2), layer, z);
  sum += uw2 * vw2 * tg_shadowTap(base, vec2(u2, v2), layer, z);
  return sum / 144.0;
#else
  float uw0 = 5.0 * s - 6.0, uw1 = 11.0 * s - 28.0, uw2 = -(11.0 * s + 17.0), uw3 = -(5.0 * s + 1.0);
  float u0 = (4.0 * s - 5.0) / uw0 - 3.0, u1 = (4.0 * s - 16.0) / uw1 - 1.0, u2 = -(7.0 * s + 5.0) / uw2 + 1.0, u3 = -s / uw3 + 3.0;
  float vw0 = 5.0 * t - 6.0, vw1 = 11.0 * t - 28.0, vw2 = -(11.0 * t + 17.0), vw3 = -(5.0 * t + 1.0);
  float v0 = (4.0 * t - 5.0) / vw0 - 3.0, v1 = (4.0 * t - 16.0) / vw1 - 1.0, v2 = -(7.0 * t + 5.0) / vw2 + 1.0, v3 = -t / vw3 + 3.0;
  sum += uw0 * vw0 * tg_shadowTap(base, vec2(u0, v0), layer, z);
  sum += uw1 * vw0 * tg_shadowTap(base, vec2(u1, v0), layer, z);
  sum += uw2 * vw0 * tg_shadowTap(base, vec2(u2, v0), layer, z);
  sum += uw3 * vw0 * tg_shadowTap(base, vec2(u3, v0), layer, z);
  sum += uw0 * vw1 * tg_shadowTap(base, vec2(u0, v1), layer, z);
  sum += uw1 * vw1 * tg_shadowTap(base, vec2(u1, v1), layer, z);
  sum += uw2 * vw1 * tg_shadowTap(base, vec2(u2, v1), layer, z);
  sum += uw3 * vw1 * tg_shadowTap(base, vec2(u3, v1), layer, z);
  sum += uw0 * vw2 * tg_shadowTap(base, vec2(u0, v2), layer, z);
  sum += uw1 * vw2 * tg_shadowTap(base, vec2(u1, v2), layer, z);
  sum += uw2 * vw2 * tg_shadowTap(base, vec2(u2, v2), layer, z);
  sum += uw3 * vw2 * tg_shadowTap(base, vec2(u3, v2), layer, z);
  sum += uw0 * vw3 * tg_shadowTap(base, vec2(u0, v3), layer, z);
  sum += uw1 * vw3 * tg_shadowTap(base, vec2(u1, v3), layer, z);
  sum += uw2 * vw3 * tg_shadowTap(base, vec2(u2, v3), layer, z);
  sum += uw3 * vw3 * tg_shadowTap(base, vec2(u3, v3), layer, z);
  return sum / 2704.0;
#endif
}

// Sonnenschatten mit Normal-Offset, Kaskadenwahl und weicher Überblendung.
float tg_sunShadow(vec3 wp, vec3 gn, float NoL) {
  if (u_shadowParams1.w < 0.5) return 1.0;
  float sinT = sqrt(saturate(1.0 - NoL * NoL));
  float k = u_shadowParams0.z * (0.35 + 0.65 * sinT);
  vec3 sc0 = (u_shadowMat0 * vec4(wp + gn * (u_shadowParams0.x * k), 1.0)).xyz;
  vec2 e0 = abs(sc0.xy * 2.0 - 1.0);
  float edge0 = max(e0.x, e0.y);
  float band = u_shadowParams1.x;
  float s0 = 1.0, s1 = 1.0;
  float w1 = smoothstep(1.0 - band, 1.0, edge0);
  if (w1 < 1.0) s0 = sc0.z >= 1.0 ? 1.0 : tg_shadowPCF(vec3(sc0.xy, sc0.z - u_shadowParams0.w), 0.0);
#if SHADOW_CASCADES > 1
  if (w1 > 0.0) {
    vec3 sc1 = (u_shadowMat1 * vec4(wp + gn * (u_shadowParams0.y * k), 1.0)).xyz;
    vec2 e1 = abs(sc1.xy * 2.0 - 1.0);
    float edge1 = max(e1.x, e1.y);
    s1 = (edge1 >= 1.0 || sc1.z >= 1.0) ? 1.0 : tg_shadowPCF(vec3(sc1.xy, sc1.z - u_shadowParams2.x), 1.0);
    s1 = mix(s1, 1.0, smoothstep(0.9, 1.0, edge1));
  }
#endif
  float sh = mix(s0, s1, w1);
  return mix(1.0, sh, u_shadowStrength);
}

// Exponentieller Höhennebel (analytisches Integral) mit Sonnenstreuung.
vec3 tg_applyFog(vec3 col, vec3 wp, out float amount) {
  vec3 d = wp - u_cameraPos;
  float dist = length(d);
  vec3 rd = d / max(dist, 1e-4);
  float fh = max(u_fogParams.x, 1e-4);
  float a = u_fogDensity * exp(-fh * (u_cameraPos.y - u_fogParams.y));
  float b = fh * rd.y;
  float f = abs(b) > 1e-4 ? a * (1.0 - exp(-dist * b)) / b : a * dist;
  amount = min(1.0 - exp(-max(f, 0.0)), u_fogParams.w);
  float sunAmt = pow(saturate(dot(rd, u_sunDir)), 8.0);
  vec3 fc = u_fogColor + u_skySunGlow.rgb * (u_fogParams.z * sunAmt);
  return mix(col, fc, amount);
}

// Geometrisches Specular-Antialiasing (Tokuyoshi/Kaplanyan) gegen Glanzflimmern.
float tg_specAA(vec3 n, float rough) {
  vec3 dn = fwidth(n);
  float v = 0.25 * dot(dn, dn);
  float k = min(2.0 * v, 0.18);
  return sqrt(min(rough * rough + k, 1.0));
}

// Hauptbeleuchtung. ambFrac = Anteil des Umgebungslichts (für SSAO im Post-Prozess).
vec3 tg_shade(Surface s, SurfaceInput i, vec3 gn, float receiveShadow, out float ambFrac) {
  vec3 N = normalize(s.normal);
  vec3 V = i.viewDir;
  vec3 L = u_sunDir;
  float NoV = max(dot(N, V), 1e-4);
  float NoLr = dot(N, L);
  float NoL = max(NoLr, 0.0);
  float rough = clamp(tg_specAA(N, clamp(s.roughness, 0.03, 1.0)), 0.045, 1.0);
  float a = rough * rough;
  vec3 diffColor = s.albedo * (1.0 - s.metalness);
  vec3 f0 = mix(vec3(0.16 * s.specular * s.specular), s.albedo, s.metalness);

  float gNoL = dot(gn, L);
  float sh = 1.0;
  if (receiveShadow > 0.5 && (NoLr > -0.4 || s.subsurface > 0.0)) sh = tg_sunShadow(i.worldPos, gn, gNoL);
  sh *= s.shadow;

  // direkt: GGX + gewickelte Diffusion (Subsurface)
  vec3 H = normalize(L + V);
  float NoH = saturate(dot(N, H)), LoH = saturate(dot(L, H));
  vec3 F = tg_F_Schlick(f0, LoH);
  vec3 spec = tg_D_GGX(NoH, a) * tg_V_SmithGGX(NoV, NoL, a) * F;
  float w = s.subsurface;
  float wrapped = saturate((NoLr + w) / (1.0 + w));
  vec3 diffLight = vec3(NoL) + s.subsurfaceColor * max(wrapped - NoL, 0.0);
  vec3 kd = diffColor * (1.0 - F * 0.5);
  vec3 direct = kd * TG_INV_PI * diffLight + spec * NoL;
  if (s.sheen > 0.0) direct += s.sheenColor * s.sheen * tg_D_Charlie(0.5, NoH) * tg_V_Neubelt(NoV, NoL) * NoL;
  direct *= u_sunColor * sh;
  // Durchleuchtung dünner Teile (Ohren) im Gegenlicht
  if (w > 0.0) direct += diffColor * s.subsurfaceColor * (w * 0.35 * pow(saturate(dot(V, -L)), 3.0)) * u_sunColor * mix(0.4, 1.0, sh);

  // Umgebung: SH-Irradianz + vorgefilterte Himmels-Cubemap
  vec3 irr = tg_shIrradiance(N);
  vec3 ambD = diffColor * irr * s.ao;
  vec3 R = reflect(-V, N);
  float hor = saturate(1.0 + dot(R, gn)); hor *= hor;
  float specOcc = saturate(pow(NoV + s.ao, exp2(-16.0 * a - 1.0)) - 1.0 + s.ao);
  vec3 env = textureLod(u_envMap, R, rough * u_misc.x).rgb * u_envIntensity;
  vec3 ambS = env * tg_envBRDF(f0, rough, NoV) * hor * specOcc;
  vec3 amb = ambD + ambS;
  if (s.sheen > 0.0) amb += s.sheenColor * s.sheen * irr * s.ao * (0.15 + 0.6 * pow(1.0 - NoV, 3.0));
  vec3 total = direct + amb;
  float tl = luminance(total + s.emissive);
  ambFrac = tl > 1e-5 ? saturate(luminance(amb) / tl) : 1.0;
  return total + s.emissive;
}
`;

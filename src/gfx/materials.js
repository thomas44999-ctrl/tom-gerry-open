// Material-System ("Surface-Shader"): erzeugt aus Material-Definitionen und Varianten-Flags
// vollständige Vertex-/Fragment-Shader, verwaltet Programm-Cache und Uniform-Uploads.
import { GLSL_HEADER, GLSL_FRAME_UBO, GLSL_COMMON, GLSL_FRAG_HELPERS, GLSL_SURFACE_STRUCTS, GLSL_LIGHTING } from './shaderlib.js';
import { GLSL_SKY } from './sky.js';
import { beginProgram, finishProgram, isProgramReady, getUniformInfo } from './gl.js';

/** Varianten-Flags (Bitmaske). */
export const VF = { SKINNED: 1, INSTANCED: 2, SHELLS: 4, SHADOW: 8, VCOLOR: 16, NO_RECV: 32, A2C: 64, MRT: 128 };
export const BLEND = { none: 0, alpha: 1, additive: 2, multiply: 3, premultiplied: 4 };
export const CULL = { none: 0, back: 1, front: 2 };
export const TEX_UNIT_BASE = 2; // 0 = Schattenkarte, 1 = Umgebungs-Cubemap

const TYPE_BY_LEN = { 1: 'float', 2: 'vec2', 3: 'vec3', 4: 'vec4', 9: 'mat3', 16: 'mat4' };
const LEN_BY_TYPE = { float: 1, vec2: 2, vec3: 3, vec4: 4, mat3: 9, mat4: 16, int: 1 };

function stripComments(src) { return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''); }

/** Uniform-Typ aus JS-Wert ableiten. Erlaubt auch { type, value, count }. */
function inferUniform(name, v) {
  if (v && typeof v === 'object' && typeof v.type === 'string' && !v.isTexture) {
    return { name, type: v.type, count: v.count || 1, explicit: true };
  }
  if (v && v.isTexture) return { name, type: v.target === 0x8513 ? 'samplerCube' : 'sampler2D', count: 1 };
  if (typeof v === 'number' || typeof v === 'boolean') return { name, type: 'float', count: 1 };
  if (v && v.length !== undefined) {
    const t = TYPE_BY_LEN[v.length];
    if (t) return { name, type: t, count: 1 };
    if (v.length % 4 === 0) return { name, type: 'vec4', count: v.length / 4 };
    if (v.length % 3 === 0) return { name, type: 'vec3', count: v.length / 3 };
  }
  throw new Error(`Material-Uniform "${name}": Typ nicht ableitbar (Wert: ${String(v)}). Nutze { type, value }.`);
}

let _matId = 1;

export class Material {
  constructor(def) {
    this.id = _matId++;
    this.name = def.name || `material-${this.id}`;
    this.def = def;
    this.uniforms = {};
    this.decls = [];
    for (const [k, v] of Object.entries(def.uniforms || {})) {
      const d = inferUniform(k, v);
      this.decls.push(d);
      this.uniforms[k] = d.explicit ? v.value : v;
    }
    this.vertex = def.vertex || '';
    this.surface = def.surface || '';
    this.alphaTest = def.alphaTest || 0;
    this.blend = def.blend || 'none';
    this.blendMode = BLEND[this.blend] ?? 0;
    this.cull = def.cull || (def.doubleSided ? 'none' : 'back');
    this.cullMode = CULL[this.cull] ?? 1;
    this.depthWrite = def.depthWrite ?? (this.blendMode === 0);
    this.depthTest = def.depthTest ?? true;
    this.unlit = !!def.unlit;
    this.fog = def.fog ?? true;
    this.castShadow = def.castShadow ?? (this.blendMode === 0);
    this.shadowShells = !!def.shadowShells;
    this.defines = def.defines || {};
    this.polygonOffset = def.polygonOffset || null;
    this.transparent = this.blendMode !== 0;
    const vs = stripComments(this.vertex), fs = stripComments(this.surface);
    this.hasVertexObject = /\bvertexObject\s*\(/.test(vs);
    this.hasVertexWorld = /\bvertexWorld\s*\(/.test(vs);
    this.hasSurface = /\bsurface\s*\(/.test(fs);
    this.uses = {
      objPos: /\bobjPos\b/.test(fs), objNormal: /\bobjNormal\b/.test(fs), uv: /\.uv\b/.test(fs),
      color: /\.color\b/.test(fs), data: /\.data\b/.test(fs), instColor: /\binstColor\b/.test(fs),
      instData: /\binstData\b/.test(fs), shell: /\.shell\b/.test(fs),
    };
    this.hasHooks = this.hasVertexObject || this.hasVertexWorld;
    this.variants = new Map();
    this.version = 0;
  }
  set(name, value) { this.uniforms[name] = value; return this; }
  get(name) { return this.uniforms[name]; }
}

// ------------------------------------------------------------------ Quelltext-Erzeugung
function declBlock(decls) {
  let s = '';
  for (const d of decls) s += `uniform ${d.type} ${d.name}${d.count > 1 ? `[${d.count}]` : ''};\n`;
  return s;
}

function defineBlock(defs) {
  let s = '';
  for (const [k, v] of Object.entries(defs)) if (v !== false && v !== null && v !== undefined) s += `#define ${k} ${v === true ? 1 : v}\n`;
  return s;
}

/** Vertex+Fragment-Quelltext für Material & Varianten-Flags. g = globale Defines des Renderers. */
export function buildSources(mat, flags, g) {
  const shadow = !!(flags & VF.SHADOW);
  const u = mat.uses;
  const needSurfaceInShadow = shadow && mat.alphaTest > 0 && mat.hasSurface;
  const varyings = !shadow || needSurfaceInShadow;
  const useColor = varyings && (u.color || (flags & VF.VCOLOR));
  const defs = {
    SKINNED: !!(flags & VF.SKINNED), INSTANCED: !!(flags & VF.INSTANCED), SHELLS: !!(flags & VF.SHELLS),
    SHADOW_PASS: shadow, HAS_VCOLOR: !!(flags & VF.VCOLOR), NO_RECEIVE_SHADOW: !!(flags & VF.NO_RECV),
    A2C: !!(flags & VF.A2C), MRT_AO: !!(flags & VF.MRT),
    HOOK_VERTEX_OBJECT: mat.hasVertexObject, HOOK_VERTEX_WORLD: mat.hasVertexWorld, HAS_SURFACE: mat.hasSurface,
    VARYINGS: varyings,
    USE_OBJPOS: varyings && u.objPos, USE_OBJNORMAL: varyings && u.objNormal, USE_UV: varyings && u.uv,
    USE_COLOR: useColor, USE_DATA: varyings && u.data, USE_INSTCOLOR: varyings && u.instColor,
    USE_INSTDATA: varyings && u.instData, USE_SHELL: varyings && u.shell,
    ALPHA_TEST: mat.alphaTest > 0 ? mat.alphaTest.toFixed(6) : false,
    DOUBLE_SIDED: mat.cullMode === 0, UNLIT: mat.unlit, FOG: mat.fog ? 1 : false,
    BLEND_MODE: mat.blendMode,
    SHADOW_FILTER: g.shadowFilter, SHADOW_CASCADES: g.shadowCascades,
  };
  const header = GLSL_HEADER + defineBlock(defs) + defineBlock(mat.defines);
  const uniforms = declBlock(mat.decls);
  const bc = mat.decls.find((d) => d.name === 'u_baseColor');

  const varyingDecl = (q) => `
${q} vec3 v_worldPos;
${q} vec3 v_normal;
#ifdef USE_OBJPOS
${q} vec3 v_objPos;
#endif
#ifdef USE_OBJNORMAL
${q} vec3 v_objNormal;
#endif
#ifdef USE_UV
${q} vec2 v_uv;
#endif
#ifdef USE_COLOR
${q} vec4 v_color;
#endif
#ifdef USE_DATA
${q} vec4 v_data;
#endif
#ifdef USE_INSTCOLOR
flat ${q} vec4 v_instColor;
#endif
#ifdef USE_INSTDATA
flat ${q} vec4 v_instData;
#endif
#ifdef USE_SHELL
flat ${q} float v_shell;
#endif
`;

  const vs = `${header}${GLSL_FRAME_UBO}${GLSL_COMMON}
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;
layout(location = 3) in vec4 a_color;
layout(location = 4) in vec4 a_data;
#ifdef SKINNED
layout(location = 5) in vec4 a_joints;
layout(location = 6) in vec4 a_weights;
uniform mat4 u_bones[64];
#endif
#ifdef INSTANCED
layout(location = 7) in mat4 i_model;
layout(location = 11) in vec4 i_color;
layout(location = 12) in vec4 i_data;
#endif
uniform mat4 u_model;
uniform mat3 u_normalMat;
#ifdef SHELLS
uniform float u_shellCount;
#endif
float g_shell;
vec4 g_instColor;
vec4 g_instData;
${uniforms}
#ifdef VARYINGS
${varyingDecl('out')}
#endif
mat3 tg_cofactor(mat3 m) { return mat3(cross(m[1], m[2]), cross(m[2], m[0]), cross(m[0], m[1])); }
// ---- Material: Vertex-Hooks
${mat.vertex}
// ----
void main() {
#ifdef SHELLS
  g_shell = u_shellCount > 1.0 ? float(gl_InstanceID) / (u_shellCount - 1.0) : 0.0;
#else
  g_shell = 0.0;
#endif
#ifdef INSTANCED
  g_instColor = i_color; g_instData = i_data;
#else
  g_instColor = vec4(1.0); g_instData = vec4(0.0);
#endif
  vec3 p = a_position;
  vec3 n = a_normal;
#ifdef USE_OBJPOS
  v_objPos = a_position;
#endif
#ifdef USE_OBJNORMAL
  v_objNormal = a_normal;
#endif
#ifdef HOOK_VERTEX_OBJECT
  vertexObject(p, n);
#endif
#ifdef SKINNED
  float wsum = dot(a_weights, vec4(1.0));
  mat4 skin = u_bones[int(a_joints.x)] * a_weights.x + u_bones[int(a_joints.y)] * a_weights.y
            + u_bones[int(a_joints.z)] * a_weights.z + u_bones[int(a_joints.w)] * a_weights.w;
  if (wsum > 1e-4) {
    skin *= 1.0 / wsum;
    p = (skin * vec4(p, 1.0)).xyz;
    n = mat3(skin) * n;
  }
#endif
#ifdef INSTANCED
  p = (i_model * vec4(p, 1.0)).xyz;
  n = tg_cofactor(mat3(i_model)) * n;
#endif
  vec3 wp = (u_model * vec4(p, 1.0)).xyz;
  vec3 wn = normalize(u_normalMat * n);
#ifdef HOOK_VERTEX_WORLD
  vertexWorld(wp, wn);
#endif
#ifdef VARYINGS
  v_worldPos = wp;
  v_normal = wn;
#ifdef USE_UV
  v_uv = a_uv;
#endif
#ifdef USE_COLOR
  v_color = a_color;
#endif
#ifdef USE_DATA
  v_data = a_data;
#endif
#ifdef USE_INSTCOLOR
  v_instColor = g_instColor;
#endif
#ifdef USE_INSTDATA
  v_instData = g_instData;
#endif
#ifdef USE_SHELL
  v_shell = g_shell;
#endif
#endif
  gl_Position = u_viewProj * vec4(wp, 1.0);
}
`;

  let albedoInit = 'vec3(0.8)', alphaInit = '1.0';
  if (bc) {
    if (bc.type === 'vec3') albedoInit = 'u_baseColor';
    else if (bc.type === 'vec4') { albedoInit = 'u_baseColor.rgb'; alphaInit = 'u_baseColor.a'; }
    else if (bc.type === 'float') albedoInit = 'vec3(u_baseColor)';
  } else if (flags & VF.VCOLOR) albedoInit = 'vec3(1.0)';

  const surfaceInit = `
  SurfaceInput i;
  vec3 tg_gn = normalize(v_normal);
#ifdef DOUBLE_SIDED
  if (!gl_FrontFacing) tg_gn = -tg_gn;
#endif
  i.worldPos = v_worldPos;
  i.normal = tg_gn;
#ifdef USE_OBJPOS
  i.objPos = v_objPos;
#else
  i.objPos = vec3(0.0);
#endif
#ifdef USE_OBJNORMAL
  i.objNormal = normalize(v_objNormal);
#else
  i.objNormal = vec3(0.0, 1.0, 0.0);
#endif
#ifdef USE_UV
  i.uv = v_uv;
#else
  i.uv = vec2(0.0);
#endif
#ifdef USE_COLOR
  i.color = v_color;
#else
  i.color = vec4(1.0);
#endif
#ifdef USE_DATA
  i.data = v_data;
#else
  i.data = vec4(0.0);
#endif
#ifdef USE_INSTCOLOR
  i.instColor = v_instColor;
#else
  i.instColor = vec4(1.0);
#endif
#ifdef USE_INSTDATA
  i.instData = v_instData;
#else
  i.instData = vec4(0.0);
#endif
#ifdef USE_SHELL
  i.shell = v_shell;
#else
  i.shell = 0.0;
#endif
  i.viewDir = normalize(u_cameraPos - v_worldPos);
  i.time = u_time;
  i.fragCoord = gl_FragCoord.xy;
  Surface s;
  s.albedo = ${albedoInit};
  s.alpha = ${alphaInit};
#ifdef HAS_VCOLOR
  s.albedo *= i.color.rgb;
  s.alpha *= i.color.a;
#endif
  s.normal = tg_gn;
  s.roughness = 0.6; s.metalness = 0.0; s.specular = 0.5;
  s.emissive = vec3(0.0); s.ao = 1.0;
  s.subsurface = 0.0; s.subsurfaceColor = vec3(1.0, 0.3, 0.2);
  s.sheen = 0.0; s.sheenColor = vec3(1.0);
  s.shadow = 1.0;
#ifdef HAS_SURFACE
  surface(i, s);
#endif
`;

  let fs;
  if (shadow) {
    fs = needSurfaceInShadow ? `${header}${GLSL_FRAME_UBO}${GLSL_COMMON}${GLSL_FRAG_HELPERS}${GLSL_SURFACE_STRUCTS}${GLSL_SKY}
${uniforms}
${varyingDecl('in')}
// ---- Material: Surface
${mat.surface}
// ----
void main() {
${surfaceInit}
  if (s.alpha < ALPHA_TEST) discard;
}
` : `${header}
void main() {}
`;
  } else {
    fs = `${header}${GLSL_FRAME_UBO}${GLSL_COMMON}${GLSL_FRAG_HELPERS}${GLSL_SURFACE_STRUCTS}${GLSL_SKY}${GLSL_LIGHTING}
${uniforms}
${varyingDecl('in')}
layout(location = 0) out vec4 o_color;
#ifdef MRT_AO
layout(location = 1) out vec4 o_ao;
#endif
// ---- Material: Surface
${mat.surface}
// ----
void main() {
${surfaceInit}
#ifdef ALPHA_TEST
#ifdef A2C
  s.alpha = saturate((s.alpha - ALPHA_TEST) / max(fwidth(s.alpha), 1e-4) + 0.5);
  if (s.alpha < 0.004) discard;
#else
  if (s.alpha < ALPHA_TEST) discard;
  s.alpha = 1.0;
#endif
#endif
  float ambFrac = 0.0;
#ifdef UNLIT
  vec3 col = s.albedo + s.emissive;
#else
#ifdef NO_RECEIVE_SHADOW
  vec3 col = tg_shade(s, i, tg_gn, 0.0, ambFrac);
#else
  vec3 col = tg_shade(s, i, tg_gn, 1.0, ambFrac);
#endif
#endif
#ifdef FOG
  float fogAmt;
#if BLEND_MODE == 2
  tg_applyFog(col, v_worldPos, fogAmt);
  col *= 1.0 - fogAmt;
#elif BLEND_MODE == 3
  tg_applyFog(col, v_worldPos, fogAmt);
  col = mix(col, vec3(1.0), fogAmt);
#else
  col = tg_applyFog(col, v_worldPos, fogAmt);
#endif
  ambFrac *= 1.0 - fogAmt;
#endif
#if BLEND_MODE == 3
  col = mix(vec3(1.0), col, s.alpha);
#endif
  o_color = vec4(max(col, vec3(0.0)), s.alpha);
#ifdef MRT_AO
  o_ao = vec4(ambFrac, 0.0, 0.0, 1.0);
#endif
}
`;
  }
  return { vs, fs };
}

// ------------------------------------------------------------------ Programme
const _programsBySource = new Map();
let _progId = 1;

/** Programm-Info anlegen (noch nicht fertig gelinkt, falls parallel kompiliert wird). */
function createProgramInfo(gl, mat, flags, g) {
  const { vs, fs } = buildSources(mat, flags, g);
  const key = vs + '\u0000' + fs;
  let info = _programsBySource.get(key);
  if (info && info.gl === gl) return info;
  info = { gl, id: _progId++, key, name: mat.name, flags, pending: beginProgram(gl, vs, fs, `${mat.name} [${flagNames(flags)}]`), prog: null, decls: mat.decls, ready: false, error: null };
  _programsBySource.set(key, info);
  return info;
}

function flagNames(f) { return Object.entries(VF).filter(([, b]) => f & b).map(([k]) => k.toLowerCase()).join(',') || 'base'; }

function finalizeProgram(gl, info) {
  if (info.ready) return info;
  if (info.error) throw info.error;
  try { info.prog = finishProgram(gl, info.pending); }
  catch (e) { info.error = e; throw e; }
  const p = info.prog;
  const bi = gl.getUniformBlockIndex(p, 'Frame');
  if (bi !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, bi, 0);
  const uni = getUniformInfo(gl, p);
  const loc = (n) => uni.get(n)?.loc || null;
  info.uModel = loc('u_model'); info.uNormalMat = loc('u_normalMat'); info.uBones = loc('u_bones');
  info.uShellCount = loc('u_shellCount');
  gl.useProgram(p);
  const sm = loc('u_shadowMap'); if (sm) gl.uniform1i(sm, 0);
  const em = loc('u_envMap'); if (em) gl.uniform1i(em, 1);
  info.mat = [];
  let unit = TEX_UNIT_BASE;
  for (const d of info.decls) {
    const l = loc(d.name);
    const isSampler = d.type.startsWith('sampler');
    const e = { name: d.name, type: d.type, count: d.count, loc: l, unit: isSampler ? unit++ : -1, target: d.type === 'samplerCube' ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D };
    if (isSampler && l) gl.uniform1i(l, e.unit);
    if (l) info.mat.push(e);
  }
  info.matSet = null; info.matFrame = -1; info.dirty = true;
  info.pending = null;
  info.ready = true;
  return info;
}

export class ProgramCache {
  constructor(renderer) { this.r = renderer; this.globals = { shadowFilter: 7, shadowCascades: 2 }; }
  setGlobals(g) {
    if (g.shadowFilter === this.globals.shadowFilter && g.shadowCascades === this.globals.shadowCascades) return;
    this.globals = { ...g };
    this.clear();
  }
  clear() {
    for (const m of this.r._materials) m.variants.clear();
  }
  /** Synchron: Programm für Material+Flags (kompiliert bei Bedarf). */
  get(mat, flags) {
    let info = mat.variants.get(flags);
    if (info && info.ready) return info;
    if (!info) { info = createProgramInfo(this.r.gl, mat, flags, this.globals); mat.variants.set(flags, info); }
    return finalizeProgram(this.r.gl, info);
  }
  /** Asynchron vorbereiten (KHR_parallel_shader_compile). */
  request(mat, flags) {
    let info = mat.variants.get(flags);
    if (!info) { info = createProgramInfo(this.r.gl, mat, flags, this.globals); mat.variants.set(flags, info); }
    return info;
  }
  isReady(info) { return info.ready || isProgramReady(this.r.gl, info.pending, this.r.ext); }
  finalize(info) { return finalizeProgram(this.r.gl, info); }
}

// ------------------------------------------------------------------ Uniform-Upload
export function uploadMaterialUniforms(gl, state, info, values, fallbackTex) {
  const list = info.mat;
  for (let k = 0; k < list.length; k++) {
    const e = list[k];
    const v = values[e.name];
    if (v === undefined) continue;
    setUniform(gl, state, e, v, fallbackTex);
  }
}

export function setUniform(gl, state, e, v, fallbackTex) {
  switch (e.type) {
    case 'float':
      if (e.count > 1) gl.uniform1fv(e.loc, v);
      else gl.uniform1f(e.loc, typeof v === 'number' ? v : (v === true ? 1 : v === false ? 0 : v[0]));
      break;
    case 'vec2': gl.uniform2fv(e.loc, v); break;
    case 'vec3': gl.uniform3fv(e.loc, v); break;
    case 'vec4': gl.uniform4fv(e.loc, v); break;
    case 'mat3': gl.uniformMatrix3fv(e.loc, false, v); break;
    case 'mat4': gl.uniformMatrix4fv(e.loc, false, v); break;
    case 'int': gl.uniform1i(e.loc, v | 0); break;
    case 'sampler2D': case 'samplerCube': {
      const t = v && v.tex ? v : fallbackTex;
      state.bindTexture(e.unit, e.type === 'samplerCube' ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D, t.tex);
      break;
    }
    default: break;
  }
}

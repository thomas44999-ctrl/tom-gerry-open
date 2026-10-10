// Low-level WebGL2-Helfer: Kontext, Shader/Programme mit lesbaren Fehlern, Texturen,
// Render-Targets und ein kleiner State-Cache gegen redundante GL-Aufrufe.

export const ATTR = {
  position: 0, normal: 1, uv: 2, color: 3, data: 4, joints: 5, weights: 6,
  iModel: 7 /* 7..10 */, iColor: 11, iData: 12,
};

/** WebGL2-Kontext + Erweiterungen. Wirft, wenn WebGL2 fehlt. */
export function createContext(canvas) {
  const gl = canvas.getContext('webgl2', {
    antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: true,
    preserveDrawingBuffer: false, powerPreference: 'high-performance', desynchronized: false,
  });
  if (!gl) throw new Error('WebGL2 wird von diesem Browser/Gerät nicht unterstützt.');
  const ext = {
    colorBufferFloat: gl.getExtension('EXT_color_buffer_float'),
    colorBufferHalfFloat: gl.getExtension('EXT_color_buffer_half_float'),
    floatLinear: gl.getExtension('OES_texture_float_linear'),
    aniso: gl.getExtension('EXT_texture_filter_anisotropic'),
    parallel: gl.getExtension('KHR_parallel_shader_compile'),
    timer: gl.getExtension('EXT_disjoint_timer_query_webgl2'),
  };
  return { gl, ext };
}

// ------------------------------------------------------------------ Shader
function numberedExcerpt(src, line, radius = 6) {
  const lines = src.split('\n');
  const from = Math.max(1, line - radius), to = Math.min(lines.length, line + radius);
  const out = [];
  for (let i = from; i <= to; i++) out.push(`${i === line ? '>>' : '  '}${String(i).padStart(5)}| ${lines[i - 1]}`);
  return out.join('\n');
}

/** Formatiert ein GLSL-Infolog mit Quelltext-Ausschnitten um die Fehlerzeilen. */
export function formatShaderError(name, stage, log, src) {
  const msgs = [];
  const seen = new Set();
  const re = /ERROR:\s*\d+:(\d+):\s*([^\n]*)/g;
  let m;
  while ((m = re.exec(log))) {
    const line = +m[1];
    msgs.push(`  Zeile ${line}: ${m[2]}`);
    if (!seen.has(line) && seen.size < 3) { seen.add(line); msgs.push(numberedExcerpt(src, line)); }
  }
  if (!msgs.length) msgs.push(log.trim());
  return `Shader-Fehler in Material "${name}" (${stage}):\n${msgs.join('\n')}`;
}

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  return sh;
}

/**
 * Programm anlegen. Kompilieren/Linken startet sofort; Status wird erst bei finishProgram geprüft
 * (mit KHR_parallel_shader_compile laufen viele Programme so parallel).
 */
export function beginProgram(gl, vsSrc, fsSrc, name) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs);
  // feste Attribut-Positionen (auch über layout(location) gesetzt, hier doppelt abgesichert)
  gl.linkProgram(prog);
  return { prog, vs, fs, vsSrc, fsSrc, name, done: false };
}

export function isProgramReady(gl, pending, ext) {
  if (pending.done) return true;
  if (!ext?.parallel) return true;
  return gl.getProgramParameter(pending.prog, ext.parallel.COMPLETION_STATUS_KHR);
}

/** Prüft Link-Status, wirft lesbare Fehler, gibt das WebGLProgram zurück. */
export function finishProgram(gl, pending) {
  if (pending.done) return pending.prog;
  const { prog, vs, fs, name } = pending;
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    let msg = '';
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) msg = formatShaderError(name, 'Vertex', gl.getShaderInfoLog(vs) || '', pending.vsSrc);
    else if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) msg = formatShaderError(name, 'Fragment', gl.getShaderInfoLog(fs) || '', pending.fsSrc);
    else msg = `Link-Fehler in Material "${name}":\n${gl.getProgramInfoLog(prog)}`;
    gl.deleteShader(vs); gl.deleteShader(fs); gl.deleteProgram(prog);
    pending.done = true;
    throw new Error(msg);
  }
  gl.detachShader(prog, vs); gl.detachShader(prog, fs);
  gl.deleteShader(vs); gl.deleteShader(fs);
  pending.done = true;
  return prog;
}

export function createProgram(gl, vsSrc, fsSrc, name = 'program') {
  return finishProgram(gl, beginProgram(gl, vsSrc, fsSrc, name));
}

/** Alle aktiven Uniforms: name -> { loc, type, size } (Array-Namen ohne "[0]"). */
export function getUniformInfo(gl, prog) {
  const map = new Map();
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    if (!info) continue;
    const loc = gl.getUniformLocation(prog, info.name);
    if (!loc) continue; // Uniform-Block-Member
    const name = info.name.replace(/\[0\]$/, '');
    map.set(name, { loc, type: info.type, size: info.size });
  }
  return map;
}

// ------------------------------------------------------------------ Texturen
export class Texture {
  constructor(gl, target, tex, width, height, opts = {}) {
    this.gl = gl; this.target = target; this.tex = tex; this.width = width; this.height = height;
    this.opts = opts; this.isTexture = true; this.id = Texture._id++;
  }
  dispose() { this.gl.deleteTexture(this.tex); this.tex = null; }
}
Texture._id = 1;

function srcSize(src) {
  if (src.width !== undefined) return [src.width, src.height];
  throw new Error('createTexture: Quelle ohne width/height');
}

function isDomSource(src) {
  return (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) ||
    (typeof ImageData !== 'undefined' && src instanceof ImageData) ||
    (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) ||
    (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) ||
    (typeof OffscreenCanvas !== 'undefined' && src instanceof OffscreenCanvas) ||
    (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement);
}

/** Lädt Pixel in die gebundene TEXTURE_2D. Wählt Format nach Quelltyp und Kanalanzahl. */
export function uploadTexture2D(gl, src, opts, allocate) {
  const [w, h] = srcSize(src);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !!opts.flipY);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  if (isDomSource(src)) {
    const ifmt = opts.srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8;
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, gl.RGBA, gl.UNSIGNED_BYTE, src);
  } else {
    const data = src.data;
    const n = w * h;
    const ch = opts.channels || (data.length >= n * 4 ? 4 : data.length >= n * 2 ? 2 : 1);
    const isFloat = data instanceof Float32Array;
    const fmt = [0, gl.RED, gl.RG, gl.RGB, gl.RGBA][ch];
    let ifmt;
    if (isFloat) ifmt = [0, gl.R16F, gl.RG16F, gl.RGB16F, gl.RGBA16F][ch];
    else if (opts.srgb && ch === 4) ifmt = gl.SRGB8_ALPHA8;
    else ifmt = [0, gl.R8, gl.RG8, gl.RGB8, gl.RGBA8][ch];
    const type = isFloat ? gl.FLOAT : gl.UNSIGNED_BYTE;
    if (allocate) gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, data);
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, fmt, type, data);
  }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  return [w, h];
}

export function applySampler(gl, target, opts, ext) {
  const lin = (opts.filter || 'linear') === 'linear';
  const mips = opts.mipmaps !== false;
  const wrap = { repeat: gl.REPEAT, clamp: gl.CLAMP_TO_EDGE, mirror: gl.MIRRORED_REPEAT }[opts.wrap || 'repeat'];
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, lin ? (mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR) : (mips ? gl.NEAREST_MIPMAP_NEAREST : gl.NEAREST));
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, lin ? gl.LINEAR : gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, wrap);
  if (ext?.aniso && mips && lin) {
    const max = gl.getParameter(ext.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    gl.texParameterf(target, ext.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(max, opts.anisotropy ?? 8));
  }
}

/** Leere Textur für Render-Targets. */
export function createTargetTexture(gl, w, h, ifmt, fmt, type, filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, ifmt, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  return tex;
}

/** Einfaches Render-Target (eine Farbtextur, optional Tiefe). */
export class RenderTarget {
  constructor(gl, w, h, { ifmt, fmt = gl.RGBA, type = gl.HALF_FLOAT, filter = gl.LINEAR, depth = null } = {}) {
    this.gl = gl; this.width = w; this.height = h;
    this.tex = createTargetTexture(gl, w, h, ifmt, fmt, type, filter);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('RenderTarget unvollständig: 0x' + st.toString(16));
  }
  dispose() { const gl = this.gl; gl.deleteTexture(this.tex); gl.deleteFramebuffer(this.fbo); }
}

// ------------------------------------------------------------------ State-Cache
export class GLState {
  constructor(gl) {
    this.gl = gl;
    this.reset();
  }
  reset() {
    this.program = null; this.vao = undefined; this.fbo = undefined;
    this.blend = -1; this.depthTest = -1; this.depthWrite = -1; this.depthFunc = -1; this.cull = -1;
    this.a2c = -1; this.polyOffset = -1; this.colorMask = -1;
    this.units = new Array(32).fill(null); this.active = -1;
    this.vp0 = -1; this.vp1 = -1; this.vp2 = -1; this.vp3 = -1;
  }
  useProgram(p) { if (this.program !== p) { this.gl.useProgram(p); this.program = p; } }
  bindVAO(v) { if (this.vao !== v) { this.gl.bindVertexArray(v); this.vao = v; } }
  bindFBO(f) { if (this.fbo !== f) { this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, f); this.fbo = f; } }
  viewport(x, y, w, h) {
    if (this.vp0 !== x || this.vp1 !== y || this.vp2 !== w || this.vp3 !== h) {
      this.gl.viewport(x, y, w, h); this.vp0 = x; this.vp1 = y; this.vp2 = w; this.vp3 = h;
    }
  }
  /** 0 none, 1 alpha, 2 additive, 3 multiply, 4 premultiplied, 5 pure add (ONE,ONE) */
  setBlend(mode) {
    if (this.blend === mode) return;
    const gl = this.gl;
    if (mode === 0) gl.disable(gl.BLEND);
    else {
      if (this.blend <= 0) gl.enable(gl.BLEND);
      if (mode === 1) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
      else if (mode === 2) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE);
      else if (mode === 3) gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, gl.ZERO, gl.ONE);
      else if (mode === 4) gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
      else if (mode === 5) gl.blendFunc(gl.ONE, gl.ONE);
    }
    this.blend = mode;
  }
  setDepth(test, write, func) {
    const gl = this.gl;
    if (this.depthTest !== test) { test ? gl.enable(gl.DEPTH_TEST) : gl.disable(gl.DEPTH_TEST); this.depthTest = test; }
    if (this.depthWrite !== write) { gl.depthMask(!!write); this.depthWrite = write; }
    if (func && this.depthFunc !== func) { gl.depthFunc(func); this.depthFunc = func; }
  }
  /** 0 none, 1 back, 2 front */
  setCull(mode) {
    if (this.cull === mode) return;
    const gl = this.gl;
    if (mode === 0) gl.disable(gl.CULL_FACE);
    else { if (this.cull <= 0) gl.enable(gl.CULL_FACE); gl.cullFace(mode === 1 ? gl.BACK : gl.FRONT); }
    this.cull = mode;
  }
  setA2C(on) {
    if (this.a2c === on) return;
    on ? this.gl.enable(this.gl.SAMPLE_ALPHA_TO_COVERAGE) : this.gl.disable(this.gl.SAMPLE_ALPHA_TO_COVERAGE);
    this.a2c = on;
  }
  /** key: 0 = aus, sonst eindeutiger Schlüssel aus factor/units */
  setPolygonOffset(factor, units) {
    const key = factor === 0 && units === 0 ? 0 : factor * 1000 + units + 0.5;
    if (this.polyOffset === key) return;
    const gl = this.gl;
    if (key === 0) gl.disable(gl.POLYGON_OFFSET_FILL);
    else { if (this.polyOffset <= 0) gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(factor, units); }
    this.polyOffset = key;
  }
  bindTexture(unit, target, tex) {
    if (this.units[unit] === tex) return;
    const gl = this.gl;
    if (this.active !== unit) { gl.activeTexture(gl.TEXTURE0 + unit); this.active = unit; }
    gl.bindTexture(target, tex);
    this.units[unit] = tex;
  }
  /** Textur binden UND die Einheit aktiv machen (für generateMipmap/texImage). */
  bindTextureActive(unit, target, tex) {
    const gl = this.gl;
    if (this.active !== unit) { gl.activeTexture(gl.TEXTURE0 + unit); this.active = unit; }
    gl.bindTexture(target, tex);
    this.units[unit] = tex;
  }
  /** Nach fremden Bindungen (z.B. Texturerzeugung) Cache für eine Einheit verwerfen. */
  invalidateUnit(unit) { this.units[unit] = undefined; }
}

/** Fullscreen-Dreieck (ohne Buffer, nutzt gl_VertexID). */
export const FULLSCREEN_VS = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

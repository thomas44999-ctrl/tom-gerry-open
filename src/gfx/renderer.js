// WebGL2-Forward-Renderer (linear HDR): kaskadierte Sonnenschatten, PBR-Surface-Shader,
// prozeduraler Himmel + IBL, MSAA, SSAO, Bloom, DoF, filmisches Tonemapping, dynamische Auflösung.
// API-Vertrag: ARCHITECTURE.md §4.
import { mat4 } from '../core/math.js';
import { createContext, GLState, ATTR, Texture, uploadTexture2D, applySampler } from './gl.js';
import { FRAME } from './shaderlib.js';
import { Material, ProgramCache, VF, uploadMaterialUniforms, setUniform } from './materials.js';
import { SkySystem, SKY_DEFAULTS } from './sky.js';
import { PostFX } from './post.js';
import { computeBounds } from './geometry.js';

export const QUALITY_PRESETS = {
  low: { name: 'low', dprCap: 1, msaa: 0, shadowSize: 1024, shadowCascades: 1, shadowFilter: 3, ssao: false, ssaoSamples: 0, bloom: true, dof: false, furShells: 8, grassShells: 0, crowdDensity: 0.35, particleScale: 0.5 },
  medium: { name: 'medium', dprCap: 1.5, msaa: 4, shadowSize: 2048, shadowCascades: 1, shadowFilter: 5, ssao: false, ssaoSamples: 0, bloom: true, dof: false, furShells: 14, grassShells: 6, crowdDensity: 0.65, particleScale: 0.75 },
  high: { name: 'high', dprCap: 2, msaa: 4, shadowSize: 2048, shadowCascades: 2, shadowFilter: 7, ssao: true, ssaoSamples: 12, bloom: true, dof: true, furShells: 20, grassShells: 10, crowdDensity: 1, particleScale: 1 },
  ultra: { name: 'ultra', dprCap: 2, msaa: 4, shadowSize: 4096, shadowCascades: 2, shadowFilter: 7, ssao: true, ssaoSamples: 16, bloom: true, dof: true, dofHQ: true, furShells: 24, grassShells: 14, crowdDensity: 1, particleScale: 1 },
};

const IDENT = mat4.create();
const SCRATCH_UNIT = 15;
const UP = [0, 1, 0];

// ------------------------------------------------------------------ GPU-Mesh
let _meshId = 1;
export class Mesh {
  constructor() {
    this.id = _meshId++; this.vao = null; this.ibo = null; this.indexType = 0; this.count = 0; this.vertexCount = 0;
    this.attribs = []; this.vaos = []; this.bounds = null; this.hasColor = false; this.hasSkin = false; this.dynamic = false;
  }
}

// ------------------------------------------------------------------ Instanzen
export class Instances {
  constructor(r, capacity) {
    const gl = r.gl;
    this.r = r; this.capacity = capacity; this.count = 0; this.dirty = true;
    this.data = new Float32Array(capacity * 24);
    for (let i = 0; i < capacity; i++) {
      const o = i * 24; this.data[o] = this.data[o + 5] = this.data[o + 10] = this.data[o + 15] = 1;
      this.data[o + 16] = this.data[o + 17] = this.data[o + 18] = this.data[o + 19] = 1;
    }
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this._vaos = new Map();
    this._uploaded = -1;
  }
  /** Instanz i setzen: m = mat4 (16 Werte), color = [r,g,b,a?], data = [x,y,z,w]. Weggelassenes bleibt. */
  set(i, m, color, data) {
    const o = i * 24, D = this.data;
    if (m) for (let k = 0; k < 16; k++) D[o + k] = m[k];
    if (color) { D[o + 16] = color[0]; D[o + 17] = color[1]; D[o + 18] = color[2]; D[o + 19] = color.length > 3 ? color[3] : 1; }
    if (data) { D[o + 20] = data[0] ?? 0; D[o + 21] = data[1] ?? 0; D[o + 22] = data[2] ?? 0; D[o + 23] = data[3] ?? 0; }
    if (i >= this.count) this.count = i + 1;
    this.dirty = true;
  }
  setColor(i, c) { this.set(i, null, c, null); }
  setData(i, d) { this.set(i, null, null, d); }
  upload() {
    const gl = this.r.gl, n = Math.min(this.count, this.capacity);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    if (n > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, n * 24);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.dirty = false;
  }
  dispose() { const gl = this.r.gl; gl.deleteBuffer(this.buffer); for (const v of this._vaos.values()) gl.deleteVertexArray(v); this._vaos.clear(); }
}

// ------------------------------------------------------------------ Renderer
export class Renderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const { gl, ext } = createContext(canvas);
    this.gl = gl; this.ext = ext;
    this.state = new GLState(gl);
    this.opts = opts;
    this.lost = false;
    this.onContextLost = null; this.onContextRestored = null;
    this.dynamicResolution = opts.dynamicResolution ?? true;
    this.minScale = opts.minScale ?? 0.6; this.maxScale = opts.maxScale ?? 1.0;
    this.renderScale = opts.renderScale ?? 1.0;
    this.stats = { fps: 60, frameMs: 16.7, cpuMs: 0, gpuMs: 0, drawCalls: 0, triangles: 0, shadowDrawCalls: 0, renderScale: this.renderScale, width: 0, height: 0, programs: 0 };
    this._materials = new Set();
    this.frameId = 0;

    // HDR-Format
    this.hdrRenderable = !!(ext.colorBufferFloat || ext.colorBufferHalfFloat);
    this.hdrFormat = this.hdrRenderable ? gl.RGBA16F : gl.RGBA8;

    this.emptyVAO = gl.createVertexArray();
    this._initDefaults();
    this.programs = new ProgramCache(this);

    // Frame-UBO: 3 Slots (Kamera, Kaskade 0, Kaskade 1)
    const align = gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT);
    this._slotBytes = Math.ceil((FRAME.SIZE * 4) / align) * align;
    this._slotFloats = this._slotBytes / 4;
    this.frameData = new Float32Array(this._slotFloats * 3);
    this.ubo = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferData(gl.UNIFORM_BUFFER, this.frameData.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);

    this.q = null;
    this._targets = null;
    this._shadow = null;
    this.setQuality(opts.quality || 'high');
    this.sky = new SkySystem(this);
    this.post = new PostFX(this);

    // Zwischenspeicher (keine Allokationen pro Frame)
    this._items = []; this._itemCount = 0;
    this._opaque = []; this._transp = []; this._casters = [[], []];
    this._planes = new Float32Array(24);
    this._tmpM = mat4.create(); this._tmpM2 = mat4.create(); this._nm = new Float32Array(9);
    this._lightView = [mat4.create(), mat4.create()]; this._lightProj = [mat4.create(), mat4.create()];
    this._lightVP = [mat4.create(), mat4.create()]; this._shadowMat = [mat4.create(), mat4.create()];
    this._cascade = [{ cx: 0, cy: 0, cz: 0, r: 16, ext: 60, texel: 0, range: 1 }, { cx: 0, cy: 0, cz: 0, r: 70, ext: 40, texel: 0, range: 1 }];
    this._camRight = new Float32Array(3); this._camUp = new Float32Array(3); this._camFwd = new Float32Array(3);
    this._lastTime = 0; this._ftSmooth = 16.7; this._dynTimer = 0; this._upDelay = 2500; this._lastChange = 0;
    this._timerQueries = []; this._timerActive = null;

    // Größe
    this._cssW = canvas.clientWidth || 1; this._cssH = canvas.clientHeight || 1; this._dpr = (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1);
    this._devW = 0; this._devH = 0;
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver((entries) => {
        for (const e of entries) {
          const cs = e.contentBoxSize?.[0];
          this._cssW = cs ? cs.inlineSize : e.contentRect.width;
          this._cssH = cs ? cs.blockSize : e.contentRect.height;
          const dp = e.devicePixelContentBoxSize?.[0];
          if (dp) { this._devW = dp.inlineSize; this._devH = dp.blockSize; } else { this._devW = 0; this._devH = 0; }
        }
      });
      try { this._ro.observe(canvas, { box: 'device-pixel-content-box' }); } catch { this._ro.observe(canvas); }
    }
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; this.onContextLost?.(e); }, false);
    canvas.addEventListener('webglcontextrestored', (e) => { this.onContextRestored?.(e); }, false);
  }

  _initDefaults() {
    const gl = this.gl;
    // konstante Vertex-Attribute für fehlende Arrays
    gl.vertexAttrib2f(ATTR.uv, 0, 0);
    gl.vertexAttrib4f(ATTR.color, 1, 1, 1, 1);
    gl.vertexAttrib4f(ATTR.data, 0, 0, 0, 0);
    gl.vertexAttrib4f(ATTR.joints, 0, 0, 0, 0);
    gl.vertexAttrib4f(ATTR.weights, 1, 0, 0, 0);
    this.whiteTex = this.createTexture({ width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) }, { mipmaps: false, filter: 'nearest' });
    // Dummy-Schattenkarte
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT16, 1, 1, 1);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    this.dummyShadow = t;
    this.state.reset();
  }

  // ---------------------------------------------------------------- Qualität
  setQuality(name) {
    const base = QUALITY_PRESETS[name] || QUALITY_PRESETS.high;
    const gl = this.gl;
    const q = { ...base };
    // MSAA-Unterstützung prüfen
    if (q.msaa > 0) {
      const max = gl.getParameter(gl.MAX_SAMPLES) || 0;
      let ok = max;
      if (this.hdrRenderable) {
        const s = gl.getInternalformatParameter(gl.RENDERBUFFER, this.hdrFormat, gl.SAMPLES);
        ok = s && s.length ? Math.max(...s) : 0;
      }
      q.msaa = Math.min(q.msaa, max, ok);
    }
    q.fxaa = q.msaa === 0;
    if (!this.hdrRenderable) { q.ssao = false; q.bloom = false; }
    this.q = q;
    this.programs?.setGlobals({ shadowFilter: q.shadowFilter, shadowCascades: q.shadowCascades });
    this._disposeTargets();
    this._disposeShadow();
    this._resizePending = true;
    this.renderScale = Math.min(this.renderScale, this.maxScale);
    return q;
  }

  // ---------------------------------------------------------------- Ressourcen
  createMesh(data) {
    const gl = this.gl;
    const m = new Mesh();
    if (!data.normals) data = { ...data, normals: _flatNormalsFallback(data) };
    m.dynamic = !!data.dynamic;
    const usage = m.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW;
    const add = (loc, arr, size) => {
      if (!arr) return;
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, arr, usage);
      const type = arr instanceof Float32Array ? gl.FLOAT : arr instanceof Uint16Array ? gl.UNSIGNED_SHORT : arr instanceof Uint8Array ? gl.UNSIGNED_BYTE : gl.FLOAT;
      const a = { loc, buf, size, type, bytes: arr.byteLength };
      m.attribs[loc] = a;
      return a;
    };
    add(ATTR.position, data.positions, 3);
    add(ATTR.normal, data.normals, 3);
    add(ATTR.uv, data.uvs, 2);
    add(ATTR.color, data.colors, 4);
    add(ATTR.data, data.data, 4);
    if (data.joints && data.weights) { add(ATTR.joints, data.joints instanceof Float32Array || data.joints instanceof Uint8Array || data.joints instanceof Uint16Array ? data.joints : new Float32Array(data.joints), 4); add(ATTR.weights, data.weights, 4); m.hasSkin = true; }
    m.hasColor = !!data.colors;
    m.vertexCount = data.positions.length / 3;
    const idx = data.indices || _seqIndices(m.vertexCount);
    m.ibo = gl.createBuffer();
    m.indexType = idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    m.count = idx.length;
    m.iboBytes = idx.byteLength;
    m.vao = this._buildVAO(m, null);
    gl.bindVertexArray(m.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, usage);
    gl.bindVertexArray(null);
    this.state.vao = undefined;
    m.bounds = data.bounds || computeBounds(data);
    m.autoBounds = !data.dynamic;
    return m;
  }

  _buildVAO(m, inst) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    for (const a of m.attribs) {
      if (!a) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, a.buf);
      gl.enableVertexAttribArray(a.loc);
      gl.vertexAttribPointer(a.loc, a.size, a.type, false, 0, 0);
    }
    if (m.ibo) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo);
    if (inst) {
      gl.bindBuffer(gl.ARRAY_BUFFER, inst.buffer);
      for (let c = 0; c < 4; c++) {
        gl.enableVertexAttribArray(ATTR.iModel + c);
        gl.vertexAttribPointer(ATTR.iModel + c, 4, gl.FLOAT, false, 96, c * 16);
        gl.vertexAttribDivisor(ATTR.iModel + c, 1);
      }
      gl.enableVertexAttribArray(ATTR.iColor); gl.vertexAttribPointer(ATTR.iColor, 4, gl.FLOAT, false, 96, 64); gl.vertexAttribDivisor(ATTR.iColor, 1);
      gl.enableVertexAttribArray(ATTR.iData); gl.vertexAttribPointer(ATTR.iData, 4, gl.FLOAT, false, 96, 80); gl.vertexAttribDivisor(ATTR.iData, 1);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.state.vao = undefined;
    m.vaos.push(vao);
    return vao;
  }

  _instVAO(m, inst) {
    let v = inst._vaos.get(m);
    if (!v) { v = this._buildVAO(m, inst); inst._vaos.set(m, v); }
    return v;
  }

  /** Dynamische Meshes aktualisieren. count = Anzahl zu zeichnender Indizes. */
  updateMesh(m, upd) {
    const gl = this.gl;
    const usage = m.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW;
    const map = [['positions', ATTR.position, 3], ['normals', ATTR.normal, 3], ['uvs', ATTR.uv, 2], ['colors', ATTR.color, 4], ['data', ATTR.data, 4], ['joints', ATTR.joints, 4], ['weights', ATTR.weights, 4]];
    let layoutChanged = false;
    for (let k = 0; k < map.length; k++) {
      const [key, loc, size] = map[k];
      const arr = upd[key];
      if (!arr) continue;
      let a = m.attribs[loc];
      if (!a) {
        a = { loc, buf: gl.createBuffer(), size, type: arr instanceof Float32Array ? gl.FLOAT : arr instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_BYTE, bytes: 0 };
        m.attribs[loc] = a; layoutChanged = true;
        if (key === 'colors') m.hasColor = true;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, a.buf);
      if (arr.byteLength > a.bytes || layoutChanged) { gl.bufferData(gl.ARRAY_BUFFER, arr, usage); a.bytes = arr.byteLength; }
      else gl.bufferSubData(gl.ARRAY_BUFFER, 0, arr);
      if (key === 'positions') m.vertexCount = arr.length / 3;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    if (layoutChanged) {
      for (const v of m.vaos) {
        gl.bindVertexArray(v);
        for (const a of m.attribs) {
          if (!a) continue;
          gl.bindBuffer(gl.ARRAY_BUFFER, a.buf);
          gl.enableVertexAttribArray(a.loc);
          gl.vertexAttribPointer(a.loc, a.size, a.type, false, 0, 0);
        }
      }
      gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);
      this.state.vao = undefined;
    }
    if (upd.indices) {
      gl.bindVertexArray(m.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo);
      if (upd.indices.byteLength > m.iboBytes) { gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, upd.indices, usage); m.iboBytes = upd.indices.byteLength; }
      else gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, upd.indices);
      gl.bindVertexArray(null);
      this.state.vao = undefined;
      m.indexType = upd.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      m.count = upd.indices.length;
    }
    if (upd.count !== undefined) m.count = upd.count;
    if (upd.bounds) m.bounds = upd.bounds;
  }

  deleteMesh(m) {
    const gl = this.gl;
    for (const a of m.attribs) if (a) gl.deleteBuffer(a.buf);
    gl.deleteBuffer(m.ibo);
    for (const v of m.vaos) gl.deleteVertexArray(v);
    m.vaos.length = 0; m.attribs.length = 0;
    this.state.vao = undefined;
  }

  createInstances(capacity) { return new Instances(this, capacity); }

  createTexture(src, opts = {}) {
    const gl = this.gl;
    const tex = gl.createTexture();
    this.state.bindTextureActive(SCRATCH_UNIT, gl.TEXTURE_2D, tex);
    const [w, h] = uploadTexture2D(gl, src, opts, true);
    applySampler(gl, gl.TEXTURE_2D, opts, this.ext);
    if (opts.mipmaps !== false) gl.generateMipmap(gl.TEXTURE_2D);
    return new Texture(gl, gl.TEXTURE_2D, tex, w, h, opts);
  }

  updateTexture(t, src) {
    const gl = this.gl;
    this.state.bindTextureActive(SCRATCH_UNIT, gl.TEXTURE_2D, t.tex);
    const w = src.width, h = src.height;
    const realloc = w !== t.width || h !== t.height;
    uploadTexture2D(gl, src, t.opts, realloc || !(src.data === undefined || src.data));
    t.width = w; t.height = h;
    if (t.opts.mipmaps !== false) gl.generateMipmap(gl.TEXTURE_2D);
  }

  createMaterial(def) {
    const m = new Material(def);
    this._materials.add(m);
    return m;
  }

  /**
   * Shader-Varianten für Drawables vorab kompilieren (parallel, falls möglich).
   * Gibt ein Promise zurück, das erfüllt wird, wenn alle Programme bereit sind.
   */
  precompile(drawables, onProgress) {
    const infos = [];
    const q = this.q;
    for (const d of drawables) {
      if (!d || !d.material || !d.mesh) continue;
      const f = this._flagsFor(d, false);
      infos.push(this.programs.request(d.material, f));
      if (d.material.castShadow && d.castShadow !== false && q.shadowSize > 0) infos.push(this.programs.request(d.material, this._flagsFor(d, true)));
    }
    const uniq = [...new Set(infos)];
    return new Promise((resolve, reject) => {
      const tick = () => {
        let done = 0;
        try {
          for (const info of uniq) {
            if (info.ready) { done++; continue; }
            if (this.programs.isReady(info)) { this.programs.finalize(info); done++; }
          }
        } catch (e) { reject(e); return; }
        onProgress?.(uniq.length ? done / uniq.length : 1);
        if (done >= uniq.length) resolve(uniq.length);
        else (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(tick) : setTimeout(tick, 16));
      };
      tick();
    });
  }

  // ---------------------------------------------------------------- Kamera/Hilfen
  updateCamera(cam, aspect) {
    if (!cam.view) cam.view = mat4.create();
    if (!cam.proj) cam.proj = mat4.create();
    if (!cam.viewProj) cam.viewProj = mat4.create();
    if (aspect === undefined) aspect = this._aspect || (this._cssW / Math.max(1, this._cssH));
    mat4.lookAt(cam.view, cam.position, cam.target, cam.up || UP);
    mat4.perspective(cam.proj, cam.fov ?? 0.75, aspect, cam.near ?? 0.1, cam.far ?? 600);
    mat4.multiply(cam.viewProj, cam.proj, cam.view);
    return cam;
  }

  /** Weltpunkt -> CSS-Pixel. out optional (vermeidet Allokation). */
  worldToScreen(cam, p, out) {
    out = out || { x: 0, y: 0, visible: false };
    if (!cam.viewProj) this.updateCamera(cam);
    const m = cam.viewProj, x = p[0], y = p[1], z = p[2];
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    const W = this.canvas.clientWidth || this._cssW, H = this.canvas.clientHeight || this._cssH;
    if (cw <= 1e-6) { out.x = -1e5; out.y = -1e5; out.visible = false; return out; }
    const nx = cx / cw, ny = cy / cw;
    out.x = (nx * 0.5 + 0.5) * W; out.y = (1 - (ny * 0.5 + 0.5)) * H;
    out.visible = nx >= -1 && nx <= 1 && ny >= -1 && ny <= 1;
    return out;
  }

  // ---------------------------------------------------------------- Render-Targets
  _disposeTargets() {
    const t = this._targets; if (!t) return;
    const gl = this.gl;
    for (const k of ['msaaFbo', 'resolveFbo', 'aoFbo']) if (t[k]) gl.deleteFramebuffer(t[k]);
    for (const k of ['rbColor', 'rbAo', 'rbDepth']) if (t[k]) gl.deleteRenderbuffer(t[k]);
    for (const k of ['sceneTex', 'depthTex', 'aoWTex']) if (t[k]) gl.deleteTexture(t[k]);
    this._targets = null;
    this.state.reset();
  }

  _ensureTargets(w, h) {
    const t = this._targets;
    const mrt = this.q.ssao;
    if (t && t.w === w && t.h === h && t.mrt === mrt && t.msaa === this.q.msaa) return t;
    this._disposeTargets();
    const gl = this.gl, q = this.q;
    const T = { w, h, mrt, msaa: q.msaa };
    const tex2D = (ifmt, filter) => {
      const tx = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tx);
      gl.texStorage2D(gl.TEXTURE_2D, 1, ifmt, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tx;
    };
    T.sceneTex = tex2D(this.hdrFormat, gl.LINEAR);
    T.depthTex = tex2D(gl.DEPTH_COMPONENT24, gl.NEAREST);
    if (mrt) T.aoWTex = tex2D(gl.R8, gl.LINEAR);
    T.resolveFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.resolveFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, T.sceneTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, T.depthTex, 0);
    if (mrt && !q.msaa) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, T.aoWTex, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    }
    _checkFbo(gl, 'resolve');
    if (q.msaa) {
      const rb = (fmt) => { const r = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, r); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, q.msaa, fmt, w, h); return r; };
      T.rbColor = rb(this.hdrFormat);
      T.rbDepth = rb(gl.DEPTH_COMPONENT24);
      if (mrt) T.rbAo = rb(gl.R8);
      T.msaaFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.msaaFbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, T.rbColor);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, T.rbDepth);
      if (mrt) {
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.RENDERBUFFER, T.rbAo);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      }
      _checkFbo(gl, 'msaa');
      if (mrt) {
        T.aoFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.aoFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, T.aoWTex, 0);
        _checkFbo(gl, 'ao');
      }
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.state.reset();
    this._targets = T;
    return T;
  }

  _disposeShadow() {
    const s = this._shadow; if (!s) return;
    this.gl.deleteTexture(s.tex); this.gl.deleteFramebuffer(s.fbo);
    this._shadow = null;
    this.state.reset();
  }

  _ensureShadow() {
    const q = this.q;
    if (this._shadow && this._shadow.size === q.shadowSize && this._shadow.layers === q.shadowCascades) return this._shadow;
    this._disposeShadow();
    const gl = this.gl, size = q.shadowSize, layers = q.shadowCascades;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, size >= 4096 ? gl.DEPTH_COMPONENT16 : gl.DEPTH_COMPONENT24, size, size, layers);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, tex, 0, 0);
    _checkFbo(gl, 'shadow');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.state.reset();
    this._shadow = { tex, fbo, size, layers };
    return this._shadow;
  }

  // ---------------------------------------------------------------- Größe & dynamische Auflösung
  _updateSize() {
    const q = this.q, c = this.canvas;
    const dpr = Math.min(typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1, q.dprCap);
    const cssW = this._cssW || c.clientWidth || 1, cssH = this._cssH || c.clientHeight || 1;
    let w, h;
    const realDpr = typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1;
    // devicePixelContentBoxSize ist pixelgenau (kein Moiré beim Hochskalieren), aber nur wenn konsistent
    if (this._devW && Math.abs(dpr - realDpr) < 1e-3 && Math.abs(this._devW - cssW * dpr) <= 2 && Math.abs(this._devH - cssH * dpr) <= 2) { w = this._devW; h = this._devH; }
    else { w = Math.max(1, Math.round(cssW * dpr)); h = Math.max(1, Math.round(cssH * dpr)); }
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    this.width = w; this.height = h;
    this._aspect = w / h;
  }

  _updateDynRes(dtMs) {
    if (!this.dynamicResolution || this.frozen) return;
    if (dtMs <= 0 || dtMs > 250) return; // Tab-Wechsel o.Ä.
    this._ftSmooth += (dtMs - this._ftSmooth) * 0.08;
    this._dynTimer += dtMs;
    const target = 1000 / 60;
    let s = this.renderScale;
    if (this._ftSmooth > target * 1.15 && this._dynTimer > 600 && s > this.minScale + 1e-3) {
      s = Math.max(this.minScale, Math.round((s - 0.1) * 10) / 10);
      this._dynTimer = 0;
      if (performance.now() - this._lastChange < 4000) this._upDelay = Math.min(this._upDelay * 2, 30000);
      this._lastChange = performance.now();
    } else if (this._ftSmooth < target * 1.04 && this._dynTimer > this._upDelay && s < this.maxScale - 1e-3) {
      s = Math.min(this.maxScale, Math.round((s + 0.1) * 10) / 10);
      this._dynTimer = 0;
      this._lastChange = performance.now();
    }
    this.renderScale = s;
  }

  // ---------------------------------------------------------------- Frame-Daten
  _fillFrame(scene, cam, time) {
    const F = this.frameData, q = this.q;
    F.set(cam.view, FRAME.view); F.set(cam.proj, FRAME.proj); F.set(cam.viewProj, FRAME.viewProj);
    mat4.invert(this._tmpM, cam.viewProj); F.set(this._tmpM, FRAME.invViewProj);
    F.set(this._shadowMat[0], FRAME.shadowMat0); F.set(this._shadowMat[1], FRAME.shadowMat1);
    const v = cam.view;
    F[FRAME.cameraPos] = cam.position[0]; F[FRAME.cameraPos + 1] = cam.position[1]; F[FRAME.cameraPos + 2] = cam.position[2];
    F[FRAME.time] = time;
    const sun = scene.sun || DEFAULT_SUN;
    const sd = sun.dir || DEFAULT_SUN.dir;
    const sl = Math.hypot(sd[0], sd[1], sd[2]) || 1;
    F[FRAME.sunDir] = sd[0] / sl; F[FRAME.sunDir + 1] = sd[1] / sl; F[FRAME.sunDir + 2] = sd[2] / sl;
    F[FRAME.shadowStrength] = scene.shadow?.strength ?? 1;
    const sc = sun.color || DEFAULT_SUN.color, si = sun.intensity ?? DEFAULT_SUN.intensity;
    F[FRAME.sunColor] = sc[0] * si; F[FRAME.sunColor + 1] = sc[1] * si; F[FRAME.sunColor + 2] = sc[2] * si;
    F[FRAME.exposure] = scene.exposure ?? 1;
    F[FRAME.cameraRight] = v[0]; F[FRAME.cameraRight + 1] = v[4]; F[FRAME.cameraRight + 2] = v[8];
    F[FRAME.near] = cam.near ?? 0.1;
    F[FRAME.cameraUp] = v[1]; F[FRAME.cameraUp + 1] = v[5]; F[FRAME.cameraUp + 2] = v[9];
    F[FRAME.far] = cam.far ?? 600;
    F[FRAME.cameraFwd] = -v[2]; F[FRAME.cameraFwd + 1] = -v[6]; F[FRAME.cameraFwd + 2] = -v[10];
    F[FRAME.shadowCascades] = q.shadowCascades;
    const T = this._targets;
    F[FRAME.resolution] = T ? T.w : this.width; F[FRAME.resolution + 1] = T ? T.h : this.height;
    F[FRAME.invResolution] = 1 / F[FRAME.resolution]; F[FRAME.invResolution + 1] = 1 / F[FRAME.resolution + 1];
    const hemi = scene.hemi || DEFAULT_HEMI;
    const hs = hemi.sky || DEFAULT_HEMI.sky, hg = hemi.ground || DEFAULT_HEMI.ground;
    F[FRAME.hemiSky] = hs[0]; F[FRAME.hemiSky + 1] = hs[1]; F[FRAME.hemiSky + 2] = hs[2];
    F[FRAME.hemiIntensity] = hemi.intensity ?? 1;
    F[FRAME.hemiGround] = hg[0]; F[FRAME.hemiGround + 1] = hg[1]; F[FRAME.hemiGround + 2] = hg[2];
    F[FRAME.envIntensity] = (hemi.intensity ?? 1) * (scene.envIntensity ?? 1);
    const fog = scene.fog;
    const sky = scene.sky || SKY_DEFAULTS;
    const fc = fog?.color || sky.horizon || SKY_DEFAULTS.horizon;
    F[FRAME.fogColor] = fc[0]; F[FRAME.fogColor + 1] = fc[1]; F[FRAME.fogColor + 2] = fc[2];
    F[FRAME.fogDensity] = fog ? (fog.density ?? 0.002) : 0;
    F[FRAME.fogParams] = fog?.heightFalloff ?? 0.05; F[FRAME.fogParams + 1] = fog?.height ?? 0;
    F[FRAME.fogParams + 2] = fog?.sunScatter ?? 0.5; F[FRAME.fogParams + 3] = fog?.max ?? 1;
    const sh = scene.shadow || DEFAULT_SHADOW;
    const c0 = this._cascade[0], c1 = this._cascade[1];
    const enabled = q.shadowSize > 0 && scene.shadow !== false && (sun.castShadow ?? true);
    F[FRAME.shadowParams0] = c0.texel; F[FRAME.shadowParams0 + 1] = c1.texel;
    F[FRAME.shadowParams0 + 2] = sh.normalBias ?? 1.0;
    F[FRAME.shadowParams0 + 3] = (sh.bias ?? 0.025) / c0.range;
    F[FRAME.shadowParams1] = sh.blend ?? 0.12; F[FRAME.shadowParams1 + 1] = q.shadowSize; F[FRAME.shadowParams1 + 2] = 1 / q.shadowSize;
    F[FRAME.shadowParams1 + 3] = enabled ? 1 : 0;
    F[FRAME.shadowParams2] = ((sh.bias ?? 0.025) * 2.5) / c1.range;
    this.sky.writeUniforms(F, scene, time);
    this.sky.writeSH(F, scene.hemi || DEFAULT_HEMI);
    F[FRAME.misc] = this.sky.maxLod; F[FRAME.misc + 1] = q.ssao ? 1 : 0; F[FRAME.misc + 2] = this.renderScale; F[FRAME.misc + 3] = this.frameId;
    return enabled;
  }

  /** Lichtmatrizen für Kaskade k (texel-gerastert, stabil gegen Kamerabewegung). */
  _computeCascade(k, center, radius, ext, size) {
    const F = this.frameData;
    const L = [F[FRAME.sunDir], F[FRAME.sunDir + 1], F[FRAME.sunDir + 2]];
    const up = Math.abs(L[1]) > 0.99 ? [0, 0, 1] : UP;
    const V = this._lightView[k];
    mat4.lookAt(V, L, ZERO3, up);
    const x = V[0] * center[0] + V[4] * center[1] + V[8] * center[2] + V[12];
    const y = V[1] * center[0] + V[5] * center[1] + V[9] * center[2] + V[13];
    const z = V[2] * center[0] + V[6] * center[1] + V[10] * center[2] + V[14];
    const texel = (2 * radius) / size;
    const cx = Math.round(x / texel) * texel, cy = Math.round(y / texel) * texel;
    const near = -z - radius - ext, far = -z + radius;
    const P = this._lightProj[k];
    mat4.ortho(P, cx - radius, cx + radius, cy - radius, cy + radius, near, far);
    mat4.multiply(this._lightVP[k], P, V);
    const S = this._shadowMat[k];
    mat4.identity(this._tmpM2);
    this._tmpM2[0] = this._tmpM2[5] = this._tmpM2[10] = 0.5; this._tmpM2[12] = this._tmpM2[13] = this._tmpM2[14] = 0.5;
    mat4.multiply(S, this._tmpM2, this._lightVP[k]);
    const c = this._cascade[k];
    c.cx = cx; c.cy = cy; c.cz = z; c.r = radius; c.ext = ext; c.texel = texel; c.range = far - near;
  }

  // ---------------------------------------------------------------- Drawlisten
  _flagsFor(d, shadow) {
    const mat = d.material, mesh = d.mesh;
    let f = 0;
    if (d.bones && mesh.hasSkin) f |= VF.SKINNED;
    if (d.instances) f |= VF.INSTANCED;
    else if (d.shells > 0) f |= VF.SHELLS;
    if (shadow) {
      f |= VF.SHADOW;
      if (mat.alphaTest > 0 && mesh.hasColor) f |= VF.VCOLOR;
      return f;
    }
    if (mesh.hasColor) f |= VF.VCOLOR;
    if (d.receiveShadow === false) f |= VF.NO_RECV;
    if (mat.alphaTest > 0 && this.q.msaa > 0 && !mat.transparent) f |= VF.A2C;
    if (this.q.ssao && !mat.transparent && d.pass !== 'transparent') f |= VF.MRT;
    return f;
  }

  _item() {
    let it = this._items[this._itemCount];
    if (!it) { it = { d: null, info: null, order: 0, depth: 0, progId: 0, matId: 0 }; this._items[this._itemCount] = it; }
    this._itemCount++;
    return it;
  }

  /** Bounding-Kugel (Welt) eines Drawables in out[0..3]; false, wenn unbekannt. */
  _worldSphere(d, out) {
    let b = d.bounds;
    const mat = d.material, mesh = d.mesh;
    if (!b) {
      if (!mesh.autoBounds || !mesh.bounds || d.bones || d.instances || d.shells > 0 || mat.hasHooks) return false;
      b = mesh.bounds;
    }
    const m = d.model || IDENT, c = b.center;
    out[0] = m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12];
    out[1] = m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13];
    out[2] = m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14];
    const sx = m[0] * m[0] + m[1] * m[1] + m[2] * m[2], sy = m[4] * m[4] + m[5] * m[5] + m[6] * m[6], sz = m[8] * m[8] + m[9] * m[9] + m[10] * m[10];
    out[3] = b.radius * Math.sqrt(Math.max(sx, sy, sz));
    return true;
  }

  _buildLists(scene, cam, shadowsOn) {
    this._itemCount = 0;
    const op = this._opaque, tr = this._transp, cs0 = this._casters[0], cs1 = this._casters[1];
    op.length = 0; tr.length = 0; cs0.length = 0; cs1.length = 0;
    const P = this._planes;
    _extractPlanes(P, cam.viewProj);
    const list = scene.drawables;
    const sph = _sph;
    const camP = cam.position;
    const nCasc = shadowsOn ? this.q.shadowCascades : 0;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (!d || d.visible === false || !d.mesh || !d.material) continue;
      const mat = d.material;
      if (d.instances) {
        if (d.instances.count <= 0) continue;
        if (d.instances.dirty) d.instances.upload();
      }
      const hasS = this._worldSphere(d, sph);
      // Schattenwerfer
      if (nCasc > 0 && mat.castShadow && d.castShadow !== false) {
        for (let k = 0; k < nCasc; k++) {
          if (hasS && !this._sphereInCascade(k, sph)) continue;
          const it = this._item();
          it.d = d; it.info = null; it.order = 0; it.depth = 0;
          (k === 0 ? cs0 : cs1).push(it);
        }
      }
      // Sichtbarkeit
      if (hasS && !_sphereInFrustum(P, sph)) continue;
      const it = this._item();
      it.d = d; it.info = null;
      it.order = d.order || 0;
      if (hasS) { const dx = sph[0] - camP[0], dy = sph[1] - camP[1], dz = sph[2] - camP[2]; it.depth = dx * dx + dy * dy + dz * dz; }
      else if (d.model) { const m = d.model, dx = m[12] - camP[0], dy = m[13] - camP[1], dz = m[14] - camP[2]; it.depth = dx * dx + dy * dy + dz * dz; }
      else it.depth = 0;
      it.matId = mat.id;
      const transparent = d.pass ? d.pass === 'transparent' : mat.transparent;
      (transparent ? tr : op).push(it);
    }
  }

  _sphereInCascade(k, s) {
    const V = this._lightView[k], c = this._cascade[k];
    const x = V[0] * s[0] + V[4] * s[1] + V[8] * s[2] + V[12];
    const y = V[1] * s[0] + V[5] * s[1] + V[9] * s[2] + V[13];
    const z = V[2] * s[0] + V[6] * s[1] + V[10] * s[2] + V[14];
    const r = s[3];
    if (Math.abs(x - c.cx) > c.r + r || Math.abs(y - c.cy) > c.r + r) return false;
    // Sichtraum-z: Lichtseite = größeres z
    if (z - r > c.cz + c.r + c.ext || z + r < c.cz - c.r) return false;
    return true;
  }

  // ---------------------------------------------------------------- Zeichnen
  _draw(it, shadow) {
    const gl = this.gl, st = this.state, d = it.d, mat = d.material, mesh = d.mesh;
    let info = it.info;
    if (!info) {
      const f = this._flagsFor(d, shadow);
      info = this.programs.get(mat, f);
    }
    st.useProgram(info.prog);
    // Material-Uniforms (einmal je Frame/Programm/Material, nach Overrides erneut)
    if (info.matSet !== mat || info.matFrame !== this.frameId || info.dirty) {
      uploadMaterialUniforms(gl, st, info, mat.uniforms, this.whiteTex);
      info.matSet = mat; info.matFrame = this.frameId; info.dirty = false;
    } else if (info._hasSamplers !== false) {
      // Texturen könnten durch andere Programme von ihren Einheiten verdrängt worden sein
      let any = false;
      const ml = info.mat;
      for (let k = 0; k < ml.length; k++) {
        const e = ml[k];
        if (e.unit >= 0) { any = true; const t = mat.uniforms[e.name]; st.bindTexture(e.unit, e.target, t && t.tex ? t.tex : this.whiteTex.tex); }
      }
      info._hasSamplers = any;
    }
    if (d.uniforms) {
      const ml = info.mat;
      for (const name in d.uniforms) {
        for (let k = 0; k < ml.length; k++) if (ml[k].name === name) { setUniform(gl, st, ml[k], d.uniforms[name], this.whiteTex); break; }
      }
      info.dirty = true;
    }
    const model = d.model || IDENT;
    if (info.uModel) gl.uniformMatrix4fv(info.uModel, false, model);
    if (info.uNormalMat) gl.uniformMatrix3fv(info.uNormalMat, false, _cofactor3(this._nm, model));
    if (info.uBones && d.bones) {
      const n = Math.min(d.bones.length, 1024);
      gl.uniformMatrix4fv(info.uBones, false, d.bones, 0, n - (n % 16));
    }
    const inst = d.instances;
    let instCount = 0;
    if (inst) { st.bindVAO(this._instVAO(mesh, inst)); instCount = Math.min(inst.count, inst.capacity); }
    else {
      st.bindVAO(mesh.vao);
      if (d.shells > 0) {
        const shells = shadow && !mat.shadowShells ? 1 : d.shells;
        if (info.uShellCount) gl.uniform1f(info.uShellCount, d.shells);
        instCount = shells;
      }
    }
    // Zustand
    if (shadow) {
      st.setBlend(0); st.setA2C(false);
      st.setDepth(true, true, gl.LEQUAL);
      const sc = mat.def.shadowCull;
      st.setCull(sc ? (sc === 'none' ? 0 : sc === 'front' ? 2 : 1) : mat.cullMode);
    } else {
      st.setBlend(mat.blendMode);
      st.setDepth(mat.depthTest, mat.depthWrite, gl.LEQUAL);
      st.setCull(mat.cullMode);
      st.setA2C(!!(info.flags & VF.A2C));
      const po = mat.polygonOffset;
      if (po) st.setPolygonOffset(po[0], po[1]); else st.setPolygonOffset(0, 0);
    }
    const count = mesh.count;
    if (count <= 0) return;
    if (instCount > 0) gl.drawElementsInstanced(gl.TRIANGLES, count, mesh.indexType, 0, instCount);
    else gl.drawElements(gl.TRIANGLES, count, mesh.indexType, 0);
    this.stats.drawCalls++;
    if (shadow) this.stats.shadowDrawCalls++;
    else this.stats.triangles += (count / 3) * (instCount || 1);
  }

  _resolvePrograms(arr, shadow) {
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i];
      it.info = this.programs.get(it.d.material, this._flagsFor(it.d, shadow));
      it.progId = it.info.id;
    }
  }

  _bindFrameSlot(slot) {
    const gl = this.gl;
    gl.bindBufferRange(gl.UNIFORM_BUFFER, 0, this.ubo, slot * this._slotBytes, FRAME.SIZE * 4);
  }

  _renderShadows(scene) {
    const gl = this.gl, st = this.state, S = this._ensureShadow();
    const n = this.q.shadowCascades;
    const sh = scene.shadow || DEFAULT_SHADOW;
    st.bindFBO(S.fbo);
    st.viewport(0, 0, S.size, S.size);
    st.setA2C(false);
    for (let k = 0; k < n; k++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, S.tex, 0, k);
      st.setDepth(true, true, gl.LEQUAL);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      this._bindFrameSlot(k + 1);
      st.setPolygonOffset(sh.slopeBias ?? 2.0, sh.constBias ?? 2.0);
      const list = this._casters[k];
      this._resolvePrograms(list, true);
      list.sort(_cmpShadow);
      for (let i = 0; i < list.length; i++) this._draw(list[i], true);
    }
    st.setPolygonOffset(0, 0);
    this._bindFrameSlot(0);
  }

  // ---------------------------------------------------------------- Hauptmethode
  render(scene, cam) {
    if (this.lost || this.gl.isContextLost()) return;
    const gl = this.gl, st = this.state, q = this.q;
    const now = performance.now();
    const dt = this._lastTime ? now - this._lastTime : 16.7;
    this._lastTime = now;
    this.frameId++;
    // GPU-Timer
    this._pollTimer();
    const tq = this._beginTimer();

    // Größe & Auflösung
    this._updateDynRes(dt);
    this._updateSize();
    const scale = this.renderScale;
    const iw = Math.max(1, Math.round(this.width * scale)), ih = Math.max(1, Math.round(this.height * scale));
    const T = this._ensureTargets(iw, ih);
    this.updateCamera(cam, this.width / this.height);
    const time = scene.time ?? now / 1000;

    // Schatten-Kaskaden (abhängig von Sonne, nicht von der Kamera)
    const F = this.frameData;
    const sun = scene.sun || DEFAULT_SUN;
    const sd = sun.dir || DEFAULT_SUN.dir, sl = Math.hypot(sd[0], sd[1], sd[2]) || 1;
    F[FRAME.sunDir] = sd[0] / sl; F[FRAME.sunDir + 1] = sd[1] / sl; F[FRAME.sunDir + 2] = sd[2] / sl;
    const sh = scene.shadow || DEFAULT_SHADOW;
    const center = sh.center || ZERO3;
    const cascades = q.shadowCascades;
    this._computeCascade(0, center, (sh.radius ?? 16) * (cascades === 1 ? 1.4 : 1), sh.extend ?? 60, q.shadowSize);
    if (cascades > 1) this._computeCascade(1, sh.wideCenter || center, sh.wideRadius ?? 70, sh.wideExtend ?? 40, q.shadowSize);
    const shadowsOn = this._fillFrame(scene, cam, time);

    // UBO: Slot 0 Kamera, 1/2 Lichtkaskaden
    const SF = this._slotFloats;
    for (let k = 1; k <= 2; k++) {
      F.copyWithin(k * SF, 0, FRAME.SIZE);
      const vp = this._lightVP[Math.min(k - 1, 1)];
      F.set(this._lightView[Math.min(k - 1, 1)], k * SF + FRAME.view);
      F.set(this._lightProj[Math.min(k - 1, 1)], k * SF + FRAME.proj);
      F.set(vp, k * SF + FRAME.viewProj);
    }
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, F);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    this._bindFrameSlot(0);

    // Himmel/Umgebung bei Bedarf neu erzeugen
    this.sky.update(F, now);

    // Listen
    this.stats.drawCalls = 0; this.stats.triangles = 0; this.stats.shadowDrawCalls = 0;
    this._buildLists(scene, cam, shadowsOn);

    // Schatten
    if (shadowsOn) this._renderShadows(scene);
    const S = this._shadow;

    // Hauptpass
    const mainFbo = q.msaa ? T.msaaFbo : T.resolveFbo;
    st.bindFBO(mainFbo);
    st.viewport(0, 0, T.w, T.h);
    st.setDepth(true, true, gl.LEQUAL);
    gl.colorMask(true, true, true, true);
    if (T.mrt) gl.drawBuffers(DB2);
    gl.clearBufferfv(gl.COLOR, 0, CLEAR0);
    if (T.mrt) gl.clearBufferfv(gl.COLOR, 1, CLEAR0);
    gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0);
    st.bindTexture(0, gl.TEXTURE_2D_ARRAY, shadowsOn && S ? S.tex : this.dummyShadow);
    st.bindTexture(1, gl.TEXTURE_CUBE_MAP, this.sky.env);

    const op = this._opaque, tr = this._transp;
    this._resolvePrograms(op, false);
    op.sort(_cmpOpaque);
    for (let i = 0; i < op.length; i++) this._draw(op[i], false);
    // Hintergrund-Himmel (nur sichtbare Pixel)
    this.sky.drawBackground(T.mrt);
    // Transparente Objekte (hinten nach vorne)
    if (tr.length) {
      if (T.mrt) gl.drawBuffers(DB1);
      this._resolvePrograms(tr, false);
      tr.sort(_cmpTransp);
      for (let i = 0; i < tr.length; i++) this._draw(tr[i], false);
      if (T.mrt) gl.drawBuffers(DB2);
    }
    st.setA2C(false); st.setPolygonOffset(0, 0); st.setBlend(0);

    // MSAA auflösen
    if (q.msaa) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, T.msaaFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, T.resolveFbo);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.blitFramebuffer(0, 0, T.w, T.h, 0, 0, T.w, T.h, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      if (T.mrt) {
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, T.aoFbo);
        gl.readBuffer(gl.COLOR_ATTACHMENT1);
        gl.blitFramebuffer(0, 0, T.w, T.h, 0, 0, T.w, T.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      st.fbo = null;
    }

    // Post-Processing -> Canvas
    this.post.render(scene, cam, T);

    this._endTimer(tq);
    const cpu = performance.now() - now;
    const s = this.stats;
    s.cpuMs += (cpu - s.cpuMs) * 0.1;
    if (dt > 0 && dt < 250) { s.frameMs += (dt - s.frameMs) * 0.1; s.fps = 1000 / s.frameMs; }
    s.renderScale = this.renderScale; s.width = T.w; s.height = T.h;
  }

  // ---------------------------------------------------------------- GPU-Zeitmessung (optional)
  _beginTimer() {
    const ext = this.ext.timer; if (!ext || this._timerQueries.length > 4) return null;
    const gl = this.gl, qy = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, qy);
    return qy;
  }
  _endTimer(qy) {
    if (!qy) return;
    this.gl.endQuery(this.ext.timer.TIME_ELAPSED_EXT);
    this._timerQueries.push(qy);
  }
  _pollTimer() {
    const ext = this.ext.timer; if (!ext || !this._timerQueries.length) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    while (this._timerQueries.length) {
      const qy = this._timerQueries[0];
      if (!gl.getQueryParameter(qy, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(qy, gl.QUERY_RESULT);
      if (!disjoint) this.stats.gpuMs += (ns / 1e6 - this.stats.gpuMs) * 0.1;
      gl.deleteQuery(qy);
      this._timerQueries.shift();
    }
  }

  dispose() {
    this._ro?.disconnect();
    this._disposeTargets(); this._disposeShadow();
    this.post?.dispose?.();
  }
}

// ------------------------------------------------------------------ Hilfsfunktionen
const DEFAULT_SUN = { dir: [-0.45, 0.53, -0.72], color: [1.0, 0.9, 0.78], intensity: 4.0 };
const DEFAULT_HEMI = { sky: [0.42, 0.52, 0.68], ground: [0.16, 0.15, 0.11], intensity: 1.0 };
const DEFAULT_SHADOW = { center: [0, 0, 0], radius: 16 };
const ZERO3 = new Float32Array(3);
const CLEAR0 = new Float32Array(4);
const DB1 = [0x8CE0, 0]; // COLOR_ATTACHMENT0, NONE
const DB2 = [0x8CE0, 0x8CE1];
const _sph = new Float32Array(4);

function _cmpOpaque(a, b) { return (a.order - b.order) || (a.progId - b.progId) || (a.matId - b.matId) || (a.depth - b.depth); }
function _cmpTransp(a, b) { return (a.order - b.order) || (b.depth - a.depth); }
function _cmpShadow(a, b) { return a.progId - b.progId; }

function _checkFbo(gl, name) {
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Framebuffer "${name}" unvollständig (0x${st.toString(16)})`);
}

function _extractPlanes(P, m) {
  // Gribb/Hartmann, Ebenen normalisiert: links, rechts, unten, oben, nah, fern
  const rows = [
    [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],
    [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],
    [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],
    [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],
    [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],
    [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],
  ];
  for (let i = 0; i < 6; i++) {
    const r = rows[i], l = Math.hypot(r[0], r[1], r[2]) || 1;
    P[i * 4] = r[0] / l; P[i * 4 + 1] = r[1] / l; P[i * 4 + 2] = r[2] / l; P[i * 4 + 3] = r[3] / l;
  }
}

function _sphereInFrustum(P, s) {
  for (let i = 0; i < 6; i++) {
    if (P[i * 4] * s[0] + P[i * 4 + 1] * s[1] + P[i * 4 + 2] * s[2] + P[i * 4 + 3] < -s[3]) return false;
  }
  return true;
}

/** Kofaktor-Matrix (= inverse Transponierte * det) des oberen 3x3 – korrekt für nicht-uniforme Skalierung. */
function _cofactor3(o, m) {
  const a0 = m[0], a1 = m[1], a2 = m[2], b0 = m[4], b1 = m[5], b2 = m[6], c0 = m[8], c1 = m[9], c2 = m[10];
  o[0] = b1 * c2 - b2 * c1; o[1] = b2 * c0 - b0 * c2; o[2] = b0 * c1 - b1 * c0;
  o[3] = c1 * a2 - c2 * a1; o[4] = c2 * a0 - c0 * a2; o[5] = c0 * a1 - c1 * a0;
  o[6] = a1 * b2 - a2 * b1; o[7] = a2 * b0 - a0 * b2; o[8] = a0 * b1 - a1 * b0;
  return o;
}

function _seqIndices(n) { const a = n > 65535 ? new Uint32Array(n) : new Uint16Array(n); for (let i = 0; i < n; i++) a[i] = i; return a; }
function _flatNormalsFallback(d) { const n = new Float32Array(d.positions.length); for (let i = 1; i < n.length; i += 3) n[i] = 1; return n; }

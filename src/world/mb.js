// MeshBuilder: sammelt Dreiecke mit Farbe (linear RGBA) und Daten-Vektor je Vertex, um statische
// Geometrie vieler Teile zu wenigen Draw-Calls zusammenzufassen.
export class MeshBuilder {
  constructor() {
    this.pos = []; this.nrm = []; this.uv = []; this.col = []; this.dat = []; this.idx = [];
    this.color = [1, 1, 1, 1]; this.data = [0.6, 0, 1, 0];
  }
  get vertexCount() { return this.pos.length / 3; }
  /** Vertex hinzufügen, Index zurück. */
  v(x, y, z, nx, ny, nz, u = 0, w = 0, c = this.color, d = this.data) {
    this.pos.push(x, y, z); this.nrm.push(nx, ny, nz); this.uv.push(u, w);
    this.col.push(c[0], c[1], c[2], c.length > 3 ? c[3] : 1);
    this.dat.push(d[0], d[1], d[2], d[3]);
    return this.pos.length / 3 - 1;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  /**
   * Viereck p0..p3 (gegen den Uhrzeigersinn von der Vorderseite gesehen: p0 unten links, p1 unten rechts,
   * p2 oben rechts, p3 oben links). Normale aus Geometrie, falls n fehlt. uvs = [u0,v0,u1,v1] (v1 = oben).
   */
  quad(p0, p1, p2, p3, n, uvs, c, d, ao) {
    if (!n) {
      const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
      const bx = p3[0] - p0[0], by = p3[1] - p0[1], bz = p3[2] - p0[2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const l = Math.hypot(nx, ny, nz) || 1; n = [nx / l, ny / l, nz / l];
    }
    const U = uvs || [0, 0, 1, 1];
    const dd = d || this.data;
    const da = ao ? ao.map((a) => [dd[0], dd[1], a, dd[3]]) : null;
    const a = this.v(p0[0], p0[1], p0[2], n[0], n[1], n[2], U[0], U[1], c, da ? da[0] : dd);
    const b = this.v(p1[0], p1[1], p1[2], n[0], n[1], n[2], U[2], U[1], c, da ? da[1] : dd);
    const e = this.v(p2[0], p2[1], p2[2], n[0], n[1], n[2], U[2], U[3], c, da ? da[2] : dd);
    const f = this.v(p3[0], p3[1], p3[2], n[0], n[1], n[2], U[0], U[3], c, da ? da[3] : dd);
    this.idx.push(a, b, e, a, e, f);
  }
  /** Fertige Mesh-Daten (geometry.js-Format) mit Transformation m (mat4) übernehmen. */
  add(mesh, m, c, d) {
    const P = mesh.positions, N = mesh.normals, UV = mesh.uvs, C = mesh.colors;
    const base = this.vertexCount;
    const n = P.length / 3;
    for (let i = 0; i < n; i++) {
      let x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      let nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
      if (m) {
        const X = m[0] * x + m[4] * y + m[8] * z + m[12];
        const Y = m[1] * x + m[5] * y + m[9] * z + m[13];
        const Z = m[2] * x + m[6] * y + m[10] * z + m[14];
        x = X; y = Y; z = Z;
        // Normalen: Kofaktor (für nicht-uniforme Skalierung)
        const a = m[0], b = m[1], cc = m[2], e = m[4], f = m[5], g = m[6], h = m[8], k = m[9], l = m[10];
        const NX = (f * l - g * k) * nx + (k * cc - l * b) * ny + (b * g - cc * f) * nz;
        const NY = (g * h - e * l) * nx + (l * a - h * cc) * ny + (cc * e - a * g) * nz;
        const NZ = (e * k - f * h) * nx + (h * b - k * a) * ny + (a * f - b * e) * nz;
        const L = Math.hypot(NX, NY, NZ) || 1; nx = NX / L; ny = NY / L; nz = NZ / L;
      }
      const col = C ? [C[i * 4], C[i * 4 + 1], C[i * 4 + 2], C[i * 4 + 3]] : (c || this.color);
      const cc2 = C && c ? [col[0] * c[0], col[1] * c[1], col[2] * c[2], col[3]] : col;
      this.v(x, y, z, nx, ny, nz, UV ? UV[i * 2] : 0, UV ? UV[i * 2 + 1] : 0, cc2, d || this.data);
    }
    const I = mesh.indices;
    for (let i = 0; i < I.length; i++) this.idx.push(base + I[i]);
  }
  /** Achsparalleler Quader (Mitte c, Größe s) mit optionaler Transformation m. */
  box(c, s, m, col, d, faces = 63) {
    const [cx, cy, cz] = c, hx = s[0] / 2, hy = s[1] / 2, hz = s[2] / 2;
    const P = (x, y, z) => {
      const X = cx + x, Y = cy + y, Z = cz + z;
      if (!m) return [X, Y, Z];
      return [m[0] * X + m[4] * Y + m[8] * Z + m[12], m[1] * X + m[5] * Y + m[9] * Z + m[13], m[2] * X + m[6] * Y + m[10] * Z + m[14]];
    };
    const N = (x, y, z) => {
      if (!m) return [x, y, z];
      const X = m[0] * x + m[4] * y + m[8] * z, Y = m[1] * x + m[5] * y + m[9] * z, Z = m[2] * x + m[6] * y + m[10] * z;
      const l = Math.hypot(X, Y, Z) || 1; return [X / l, Y / l, Z / l];
    };
    // +x, -x, +y, -y, +z, -z
    if (faces & 1) this.quad(P(hx, -hy, hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(hx, hy, hz), N(1, 0, 0), [0, 0, s[2], s[1]], col, d);
    if (faces & 2) this.quad(P(-hx, -hy, -hz), P(-hx, -hy, hz), P(-hx, hy, hz), P(-hx, hy, -hz), N(-1, 0, 0), [0, 0, s[2], s[1]], col, d);
    if (faces & 4) this.quad(P(-hx, hy, hz), P(hx, hy, hz), P(hx, hy, -hz), P(-hx, hy, -hz), N(0, 1, 0), [0, 0, s[0], s[2]], col, d);
    if (faces & 8) this.quad(P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, -hy, hz), P(-hx, -hy, hz), N(0, -1, 0), [0, 0, s[0], s[2]], col, d);
    if (faces & 16) this.quad(P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz), N(0, 0, 1), [0, 0, s[0], s[1]], col, d);
    if (faces & 32) this.quad(P(hx, -hy, -hz), P(-hx, -hy, -hz), P(-hx, hy, -hz), P(hx, hy, -hz), N(0, 0, -1), [0, 0, s[0], s[1]], col, d);
  }
  /** Zylinder/Rohr zwischen zwei Punkten. */
  tube(a, b, r, segs, col, d, caps = false) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz) || 1;
    const t = [dx / L, dy / L, dz / L];
    const up = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let ux = up[1] * t[2] - up[2] * t[1], uy = up[2] * t[0] - up[0] * t[2], uz = up[0] * t[1] - up[1] * t[0];
    const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
    const vx = t[1] * uz - t[2] * uy, vy = t[2] * ux - t[0] * uz, vz = t[0] * uy - t[1] * ux;
    const base = this.vertexCount;
    for (let i = 0; i <= segs; i++) {
      const ang = (i / segs) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang);
      const nx = ux * c + vx * s, ny = uy * c + vy * s, nz = uz * c + vz * s;
      this.v(a[0] + nx * r, a[1] + ny * r, a[2] + nz * r, nx, ny, nz, i / segs, 0, col, d);
      this.v(b[0] + nx * r, b[1] + ny * r, b[2] + nz * r, nx, ny, nz, i / segs, 1, col, d);
    }
    for (let i = 0; i < segs; i++) { const k = base + i * 2; this.idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    if (caps) {
      for (const [p, sg] of [[b, 1], [a, -1]]) {
        const cI = this.v(p[0], p[1], p[2], t[0] * sg, t[1] * sg, t[2] * sg, 0.5, 0.5, col, d);
        const st = this.vertexCount;
        for (let i = 0; i <= segs; i++) {
          const ang = (i / segs) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang);
          this.v(p[0] + (ux * c + vx * s) * r, p[1] + (uy * c + vy * s) * r, p[2] + (uz * c + vz * s) * r, t[0] * sg, t[1] * sg, t[2] * sg, 0, 0, col, d);
        }
        for (let i = 0; i < segs; i++) { if (sg > 0) this.idx.push(cI, st + i, st + i + 1); else this.idx.push(cI, st + i + 1, st + i); }
      }
    }
  }
  finish(extra = {}) {
    const n = this.vertexCount;
    return {
      positions: new Float32Array(this.pos), normals: new Float32Array(this.nrm), uvs: new Float32Array(this.uv),
      colors: new Float32Array(this.col), data: new Float32Array(this.dat),
      indices: n > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), ...extra,
    };
  }
}

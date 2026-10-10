// Geometrie-Bausteine. Alle Funktionen liefern Mesh-Daten (CPU) gemäß ARCHITECTURE §4.1:
// { positions, normals, uvs, indices } (+ colors/data/joints/weights wo vorhanden).
// Konventionen: Y oben, gegen den Uhrzeigersinn = Vorderseite, Normalen nach außen.
// UV: u nach rechts, v = 0 an der OBEREN Kante (entspricht Canvas-Zeile 0), sodass Canvas-Texturen
// ohne flipY aufrecht erscheinen.

const TAU = Math.PI * 2;

function finish(pos, nrm, uv, idx) {
  const n = pos.length / 3;
  return {
    positions: new Float32Array(pos), normals: new Float32Array(nrm), uvs: new Float32Array(uv),
    indices: n > 65535 ? new Uint32Array(idx) : new Uint16Array(idx),
  };
}

/** Index-Array passenden Typs. */
export function indexArray(arr, vertexCount) { return vertexCount > 65535 ? new Uint32Array(arr) : new Uint16Array(arr); }

// ------------------------------------------------------------------ Grundkörper
/** Quader, zentriert. box(w, h, d) oder box([w, h, d]). */
export function box(w = 1, h = 1, d = 1) {
  if (Array.isArray(w)) [w, h, d] = w;
  const x = w / 2, y = h / 2, z = d / 2;
  const pos = [], nrm = [], uv = [], idx = [];
  // je Fläche: Normale, u-Achse, v-Achse (v zeigt nach "unten" im Bild)
  const faces = [
    [[1, 0, 0], [0, 0, -1], [0, -1, 0], x],
    [[-1, 0, 0], [0, 0, 1], [0, -1, 0], x],
    [[0, 1, 0], [1, 0, 0], [0, 0, 1], y],
    [[0, -1, 0], [1, 0, 0], [0, 0, -1], y],
    [[0, 0, 1], [1, 0, 0], [0, -1, 0], z],
    [[0, 0, -1], [-1, 0, 0], [0, -1, 0], z],
  ];
  const half = [x, y, z];
  for (const [n, u, v] of faces) {
    const base = pos.length / 3;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const su = i * 2 - 1, sv = j * 2 - 1;
      for (let k = 0; k < 3; k++) pos.push(n[k] * half[k] + u[k] * su * half[k] + v[k] * sv * half[k]);
      nrm.push(n[0], n[1], n[2]);
      uv.push(i, j);
    }
    // Reihenfolge so, dass (u x v) = -n ... prüfen: wir wählen Dreiecke mit Normale n
    idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }
  return fixWinding(finish(pos, nrm, uv, idx));
}

/** Ebene in XZ, Normale +Y, zentriert. */
export function plane(w = 1, d = 1, segX = 1, segZ = 1) {
  const pos = [], nrm = [], uv = [], idx = [];
  for (let j = 0; j <= segZ; j++) for (let i = 0; i <= segX; i++) {
    const u = i / segX, v = j / segZ;
    pos.push((u - 0.5) * w, 0, (v - 0.5) * d);
    nrm.push(0, 1, 0);
    uv.push(u, v);
  }
  const row = segX + 1;
  for (let j = 0; j < segZ; j++) for (let i = 0; i < segX; i++) {
    const a = j * row + i, b = a + 1, c = a + row, e = c + 1;
    idx.push(a, c, b, b, c, e);
  }
  return finish(pos, nrm, uv, idx);
}

/** Rechteck in XY, Normale +Z, zentriert. */
export function quad(w = 1, h = 1) {
  const x = w / 2, y = h / 2;
  return finish(
    [-x, y, 0, x, y, 0, -x, -y, 0, x, -y, 0],
    [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    [0, 0, 1, 0, 0, 1, 1, 1],
    [0, 2, 1, 1, 2, 3],
  );
}

/** Kreisscheibe in XZ, Normale +Y. */
export function disc(r = 0.5, segs = 32) {
  const pos = [0, 0, 0], nrm = [0, 1, 0], uv = [0.5, 0.5], idx = [];
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * TAU, c = Math.cos(a), s = Math.sin(a);
    pos.push(c * r, 0, s * r); nrm.push(0, 1, 0); uv.push(0.5 + c * 0.5, 0.5 + s * 0.5);
  }
  for (let i = 1; i <= segs; i++) idx.push(0, i + 1, i);
  return finish(pos, nrm, uv, idx);
}

/** Kreisring in XZ, Normale +Y. uv.x = Winkel, uv.y = innen(0)..außen(1). */
export function ring(rIn = 0.4, rOut = 0.5, segs = 48) {
  const pos = [], nrm = [], uv = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * TAU, c = Math.cos(a), s = Math.sin(a);
    pos.push(c * rIn, 0, s * rIn, c * rOut, 0, s * rOut);
    nrm.push(0, 1, 0, 0, 1, 0);
    uv.push(i / segs, 0, i / segs, 1);
  }
  for (let i = 0; i < segs; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  return fixWinding(finish(pos, nrm, uv, idx));
}

/** UV-Kugel. v = 0 am Nordpol. */
export function sphere(r = 0.5, ws = 32, hs = 16) {
  const pos = [], nrm = [], uv = [], idx = [];
  for (let iy = 0; iy <= hs; iy++) {
    const v = iy / hs, th = v * Math.PI;
    for (let ix = 0; ix <= ws; ix++) {
      const u = ix / ws, ph = u * TAU;
      const nx = -Math.cos(ph) * Math.sin(th), ny = Math.cos(th), nz = Math.sin(ph) * Math.sin(th);
      pos.push(nx * r, ny * r, nz * r); nrm.push(nx, ny, nz); uv.push(u, v);
    }
  }
  const row = ws + 1;
  for (let iy = 0; iy < hs; iy++) for (let ix = 0; ix < ws; ix++) {
    const a = iy * row + ix, b = a + 1, c = a + row, d = c + 1;
    if (iy !== 0) idx.push(a, b, c);
    if (iy !== hs - 1) idx.push(b, d, c);
  }
  return fixWinding(finish(pos, nrm, uv, idx));
}

/**
 * Rotationskörper um Y. profile: [[r, y], …] (oder {x,y}) von unten nach oben.
 * Normalen glatt aus der Profiltangente; harte Kanten durch doppelte Profilpunkte.
 */
export function lathe(profile, segments = 32, phiStart = 0, phiLength = TAU) {
  const P = profile.map((p) => (Array.isArray(p) ? p : [p.x, p.y]));
  const n = P.length;
  // Profil-Normalen (2D): senkrecht zur Tangente, nach außen
  const pn = [];
  for (let j = 0; j < n; j++) {
    const a = P[Math.max(j - 1, 0)], b = P[Math.min(j + 1, n - 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    // doppelter Punkt (harte Kante): nur die Nachbarseite verwenden
    if (j > 0 && P[j - 1][0] === P[j][0] && P[j - 1][1] === P[j][1]) { tx = b[0] - P[j][0]; ty = b[1] - P[j][1]; }
    else if (j < n - 1 && P[j + 1][0] === P[j][0] && P[j + 1][1] === P[j][1]) { tx = P[j][0] - a[0]; ty = P[j][1] - a[1]; }
    const l = Math.hypot(tx, ty) || 1;
    pn.push([ty / l, -tx / l]);
  }
  const pos = [], nrm = [], uv = [], idx = [];
  // Profil-Länge für v
  const len = [0];
  for (let j = 1; j < n; j++) len.push(len[j - 1] + Math.hypot(P[j][0] - P[j - 1][0], P[j][1] - P[j - 1][1]));
  const total = len[n - 1] || 1;
  for (let i = 0; i <= segments; i++) {
    const phi = phiStart + (i / segments) * phiLength, s = Math.sin(phi), c = Math.cos(phi);
    for (let j = 0; j < n; j++) {
      const [r, y] = P[j];
      pos.push(r * s, y, r * c);
      let nx = pn[j][0] * s, ny = pn[j][1], nz = pn[j][0] * c;
      const l = Math.hypot(nx, ny, nz) || 1;
      nrm.push(nx / l, ny / l, nz / l);
      uv.push(i / segments, 1 - len[j] / total);
    }
  }
  for (let i = 0; i < segments; i++) for (let j = 0; j < n - 1; j++) {
    const a = i * n + j, b = a + n, c = a + 1, d = b + 1;
    idx.push(a, b, c, c, b, d);
  }
  return fixWinding(finish(pos, nrm, uv, idx));
}

/** Kapsel entlang Y: Zylinderteil der Länge length, Gesamthöhe length + 2r. */
export function capsule(r = 0.5, length = 1, capSegs = 8, radialSegs = 24) {
  const prof = [];
  const h = length / 2;
  for (let i = 0; i <= capSegs; i++) { const a = -Math.PI / 2 + (i / capSegs) * (Math.PI / 2); prof.push([Math.cos(a) * r, -h + Math.sin(a) * r]); }
  for (let i = 0; i <= capSegs; i++) { const a = (i / capSegs) * (Math.PI / 2); prof.push([Math.cos(a) * r, h + Math.sin(a) * r]); }
  prof[0][0] = 0; prof[prof.length - 1][0] = 0;
  return lathe(prof, radialSegs);
}

/** Zylinder/Kegelstumpf entlang Y, zentriert. */
export function cylinder(rTop = 0.5, rBottom = 0.5, h = 1, radialSegs = 24, heightSegs = 1, openEnded = false) {
  const pos = [], nrm = [], uv = [], idx = [];
  const slope = (rBottom - rTop) / h;
  for (let j = 0; j <= heightSegs; j++) {
    const v = j / heightSegs, r = rTop + (rBottom - rTop) * v, y = h / 2 - v * h;
    for (let i = 0; i <= radialSegs; i++) {
      const u = i / radialSegs, a = u * TAU, s = Math.sin(a), c = Math.cos(a);
      pos.push(r * s, y, r * c);
      const l = Math.hypot(1, slope);
      nrm.push(s / l, slope / l, c / l);
      uv.push(u, v);
    }
  }
  const row = radialSegs + 1;
  for (let j = 0; j < heightSegs; j++) for (let i = 0; i < radialSegs; i++) {
    const a = j * row + i, b = a + row, c = a + 1, d = b + 1;
    idx.push(a, b, c, c, b, d);
  }
  if (!openEnded) {
    for (const top of [true, false]) {
      const r = top ? rTop : rBottom;
      if (r <= 0) continue;
      const y = top ? h / 2 : -h / 2, ny = top ? 1 : -1;
      const center = pos.length / 3;
      pos.push(0, y, 0); nrm.push(0, ny, 0); uv.push(0.5, 0.5);
      for (let i = 0; i <= radialSegs; i++) {
        const a = (i / radialSegs) * TAU, s = Math.sin(a), c = Math.cos(a);
        pos.push(r * s, y, r * c); nrm.push(0, ny, 0); uv.push(0.5 + s * 0.5, 0.5 + c * 0.5 * ny);
      }
      for (let i = 0; i < radialSegs; i++) idx.push(center, center + 1 + i, center + 2 + i);
    }
  }
  return fixWinding(finish(pos, nrm, uv, idx));
}

/** Kegel entlang Y, zentriert (Spitze oben). */
export function cone(r = 0.5, h = 1, radialSegs = 24, heightSegs = 1, openEnded = false) {
  return cylinder(0, r, h, radialSegs, heightSegs, openEnded);
}

/**
 * Torus. R = Ringradius, r = Rohrradius. axis 'y' (Standard): Ring liegt in der XZ-Ebene
 * (z.B. Schweißband um einen senkrechten Arm); axis 'z': Ring in der XY-Ebene (wie three.js).
 */
export function torus(R = 0.5, r = 0.15, radialSegs = 16, tubularSegs = 48, arc = TAU, axis = 'y') {
  const pos = [], nrm = [], uv = [], idx = [];
  for (let j = 0; j <= radialSegs; j++) {
    const v = (j / radialSegs) * TAU;
    for (let i = 0; i <= tubularSegs; i++) {
      const u = (i / tubularSegs) * arc;
      const cx = R * Math.cos(u), cy = R * Math.sin(u);
      const x = (R + r * Math.cos(v)) * Math.cos(u), y = (R + r * Math.cos(v)) * Math.sin(u), z = r * Math.sin(v);
      let nx = x - cx, ny = y - cy, nz = z;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      if (axis === 'y') { pos.push(x, z, y); nrm.push(nx, nz, ny); }
      else { pos.push(x, y, z); nrm.push(nx, ny, nz); }
      uv.push(i / tubularSegs, j / radialSegs);
    }
  }
  const row = tubularSegs + 1;
  for (let j = 0; j < radialSegs; j++) for (let i = 0; i < tubularSegs; i++) {
    const a = j * row + i, b = a + row, c = a + 1, d = b + 1;
    idx.push(a, b, c, c, b, d);
  }
  return fixWinding(finish(pos, nrm, uv, idx));
}

/**
 * Röhre entlang eines Pfades. path: Array von [x,y,z] (Catmull-Rom-interpoliert) oder Funktion t -> [x,y,z].
 * radiusFn: Zahl oder Funktion t -> Radius. Parallel-Transport-Rahmen (kein Verdrehen).
 */
export function tube(path, radiusFn = 0.05, tubularSegs = 64, radialSegs = 8, closed = false, caps = true) {
  const sample = typeof path === 'function' ? path : (t) => catmull(path, t, closed);
  const rad = typeof radiusFn === 'function' ? radiusFn : () => radiusFn;
  const N = tubularSegs;
  const P = [], T = [];
  for (let i = 0; i <= N; i++) P.push(sample(closed ? (i % N) / N : i / N));
  for (let i = 0; i <= N; i++) {
    const a = P[Math.max(i - 1, 0)], b = P[Math.min(i + 1, N)];
    let t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    if (closed) { const a2 = P[(i - 1 + N) % N], b2 = P[(i + 1) % N]; t = [b2[0] - a2[0], b2[1] - a2[1], b2[2] - a2[2]]; }
    T.push(norm3(t));
  }
  // erster Rahmen
  const t0 = T[0];
  let up = Math.abs(t0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let Nn = norm3(cross3(cross3(t0, up), t0));
  const normals = [Nn];
  for (let i = 1; i <= N; i++) {
    const axis = cross3(T[i - 1], T[i]);
    const l = Math.hypot(axis[0], axis[1], axis[2]);
    if (l > 1e-6) {
      const ang = Math.acos(Math.max(-1, Math.min(1, dot3(T[i - 1], T[i]))));
      Nn = rotateAxis(Nn, [axis[0] / l, axis[1] / l, axis[2] / l], ang);
    }
    normals.push(Nn);
  }
  const pos = [], nrm = [], uv = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const t = T[i], n = normals[i], b = cross3(t, n), r = rad(i / N), p = P[i];
    for (let j = 0; j <= radialSegs; j++) {
      const a = (j / radialSegs) * TAU, c = Math.cos(a), s = Math.sin(a);
      const nx = n[0] * c + b[0] * s, ny = n[1] * c + b[1] * s, nz = n[2] * c + b[2] * s;
      pos.push(p[0] + nx * r, p[1] + ny * r, p[2] + nz * r); nrm.push(nx, ny, nz); uv.push(i / N, j / radialSegs);
    }
  }
  const row = radialSegs + 1;
  for (let i = 0; i < N; i++) for (let j = 0; j < radialSegs; j++) {
    const a = i * row + j, b = a + row, c = a + 1, d = b + 1;
    idx.push(a, c, b, c, d, b);
  }
  if (caps && !closed) {
    for (const end of [0, N]) {
      const t = T[end], dir = end === 0 ? -1 : 1, p = P[end], r = rad(end / N);
      const center = pos.length / 3;
      pos.push(p[0], p[1], p[2]); nrm.push(t[0] * dir, t[1] * dir, t[2] * dir); uv.push(0.5, 0.5);
      for (let j = 0; j <= radialSegs; j++) {
        const o = (end * row + j) * 3;
        pos.push(pos[o], pos[o + 1], pos[o + 2]); nrm.push(t[0] * dir, t[1] * dir, t[2] * dir);
        const a = (j / radialSegs) * TAU; uv.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
      }
      if (r > 0) for (let j = 0; j < radialSegs; j++) idx.push(center, center + 1 + j, center + 2 + j);
    }
  }
  return fixWinding(finish(pos, nrm, uv, idx));
}

/**
 * Extrusion eines 2D-Umrisses (Array [x,y], einfache Polygonkontur ohne Löcher) entlang +Z von 0..depth.
 * opts.smooth: weiche Seitennormalen (sonst harte Kanten je Segment).
 */
export function extrude(shape2d, depth = 0.1, opts = {}) {
  let S = shape2d.map((p) => (Array.isArray(p) ? p : [p.x, p.y]));
  if (S.length > 2 && S[0][0] === S[S.length - 1][0] && S[0][1] === S[S.length - 1][1]) S = S.slice(0, -1);
  if (signedArea(S) < 0) S = S.slice().reverse(); // CCW
  const tris = earcut(S);
  const pos = [], nrm = [], uv = [], idx = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of S) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const su = 1 / ((maxX - minX) || 1), sv = 1 / ((maxY - minY) || 1);
  // Kappen
  for (const front of [true, false]) {
    const base = pos.length / 3, z = front ? depth : 0, nz = front ? 1 : -1;
    for (const [x, y] of S) { pos.push(x, y, z); nrm.push(0, 0, nz); uv.push((x - minX) * su, 1 - (y - minY) * sv); }
    for (let i = 0; i < tris.length; i += 3) {
      if (front) idx.push(base + tris[i], base + tris[i + 1], base + tris[i + 2]);
      else idx.push(base + tris[i], base + tris[i + 2], base + tris[i + 1]);
    }
  }
  // Seiten
  const n = S.length;
  let perim = 0; const acc = [0];
  for (let i = 0; i < n; i++) { const a = S[i], b = S[(i + 1) % n]; perim += Math.hypot(b[0] - a[0], b[1] - a[1]); acc.push(perim); }
  if (opts.smooth) {
    const base = pos.length / 3;
    for (let i = 0; i <= n; i++) {
      const p = S[i % n], a = S[(i - 1 + n) % n], b = S[(i + 1) % n];
      const e1 = norm2([p[0] - a[0], p[1] - a[1]]), e2 = norm2([b[0] - p[0], b[1] - p[1]]);
      const nx = (e1[1] + e2[1]), ny = -(e1[0] + e2[0]); const l = Math.hypot(nx, ny) || 1;
      for (const z of [0, depth]) { pos.push(p[0], p[1], z); nrm.push(nx / l, ny / l, 0); uv.push(acc[i] / perim, z / (depth || 1)); }
    }
    for (let i = 0; i < n; i++) { const a = base + i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  } else {
    for (let i = 0; i < n; i++) {
      const a = S[i], b = S[(i + 1) % n];
      const e = norm2([b[0] - a[0], b[1] - a[1]]); const nx = e[1], ny = -e[0];
      const base = pos.length / 3;
      pos.push(a[0], a[1], 0, b[0], b[1], 0, a[0], a[1], depth, b[0], b[1], depth);
      for (let k = 0; k < 4; k++) nrm.push(nx, ny, 0);
      uv.push(acc[i] / perim, 0, acc[i + 1] / perim, 0, acc[i] / perim, 1, acc[i + 1] / perim, 1);
      idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }
  }
  return fixWinding(finish(pos, nrm, uv, idx));
}

/**
 * Abgerundeter Quader, zentriert (glatte Normalen). radius <= min(w,h,d)/2.
 */
export function roundedBox(w = 1, h = 1, d = 1, radius = 0.05, segs = 3) {
  const r = Math.min(radius, w / 2, h / 2, d / 2);
  const inner = [w / 2 - r, h / 2 - r, d / 2 - r];
  const n = segs * 2 + 1; // Unterteilung je Fläche
  const out = [];
  // feines Gitter je Würfelseite
  const faces = [[0, 1, 2, 1], [0, 1, 2, -1], [1, 2, 0, 1], [1, 2, 0, -1], [2, 0, 1, 1], [2, 0, 1, -1]];
  for (const [ax, au, av, sgn] of faces) {
    const pos = [], nrm = [], uv = [], idx = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const p = [0, 0, 0];
      p[ax] = sgn; p[au] = (i / n) * 2 - 1; p[av] = (j / n) * 2 - 1;
      // auf abgerundeten Körper projizieren
      const q = [0, 0, 0], nn = [0, 0, 0];
      // Würfelpunkt -> Position: Kernquader + Kugelanteil
      const c = [p[0] * (inner[0] + r), p[1] * (inner[1] + r), p[2] * (inner[2] + r)];
      for (let k = 0; k < 3; k++) q[k] = Math.max(-inner[k], Math.min(inner[k], c[k]));
      for (let k = 0; k < 3; k++) nn[k] = c[k] - q[k];
      const l = Math.hypot(nn[0], nn[1], nn[2]);
      if (l > 1e-9) for (let k = 0; k < 3; k++) nn[k] /= l; else nn[ax] = sgn;
      pos.push(q[0] + nn[0] * r, q[1] + nn[1] * r, q[2] + nn[2] * r);
      nrm.push(nn[0], nn[1], nn[2]);
      uv.push(i / n, 1 - j / n);
    }
    const row = n + 1;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = j * row + i, bb = a + 1, c = a + row, e = c + 1;
      idx.push(a, bb, c, bb, e, c);
    }
    out.push(finish(pos, nrm, uv, idx));
  }
  return fixWinding(merge(out));
}

// ------------------------------------------------------------------ Mesh-Operationen
const DEF = { uvs: [0, 0], colors: [1, 1, 1, 1], data: [0, 0, 0, 0], joints: [0, 0, 0, 0], weights: [1, 0, 0, 0] };
const SIZE = { positions: 3, normals: 3, uvs: 2, colors: 4, data: 4, joints: 4, weights: 4 };

/** Mehrere Meshes zu einem verschmelzen (fehlende Attribute werden mit Standardwerten gefüllt). */
export function merge(list) {
  list = list.filter(Boolean);
  let nv = 0, ni = 0;
  for (const m of list) { nv += m.positions.length / 3; ni += m.indices.length; }
  const out = { positions: new Float32Array(nv * 3), normals: new Float32Array(nv * 3) };
  for (const k of ['uvs', 'colors', 'data', 'joints', 'weights']) {
    if (list.some((m) => m[k])) {
      const Ctor = k === 'joints' ? (nv > 0 && list.some((m) => m.joints instanceof Uint16Array) ? Uint16Array : Uint8Array) : Float32Array;
      out[k] = new Ctor(nv * SIZE[k]);
    }
  }
  out.indices = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const m of list) {
    const n = m.positions.length / 3;
    for (const k of Object.keys(SIZE)) {
      if (!out[k]) continue;
      const sz = SIZE[k];
      if (m[k]) out[k].set(m[k].subarray ? m[k].subarray(0, n * sz) : m[k].slice(0, n * sz), vo * sz);
      else { const d = DEF[k]; for (let i = 0; i < n; i++) for (let c = 0; c < sz; c++) out[k][(vo + i) * sz + c] = d[c]; }
    }
    for (let i = 0; i < m.indices.length; i++) out.indices[io + i] = m.indices[i] + vo;
    vo += n; io += m.indices.length;
  }
  return out;
}

/** Kopie mit transformierten Positionen/Normalen (bei Spiegelung wird die Windung korrigiert). */
export function transform(mesh, m) {
  const out = clone(mesh);
  const P = out.positions, N = out.normals, n = P.length / 3;
  // Kofaktor-Matrix für Normalen
  const a = [m[0], m[1], m[2]], b = [m[4], m[5], m[6]], c = [m[8], m[9], m[10]];
  const ca = cross3(b, c), cb = cross3(c, a), cc = cross3(a, b);
  const det = dot3(a, ca);
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    P[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
    P[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    P[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (N) {
      const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
      let tx = ca[0] * nx + cb[0] * ny + cc[0] * nz, ty = ca[1] * nx + cb[1] * ny + cc[1] * nz, tz = ca[2] * nx + cb[2] * ny + cc[2] * nz;
      if (det < 0) { tx = -tx; ty = -ty; tz = -tz; }
      const l = Math.hypot(tx, ty, tz) || 1;
      N[i * 3] = tx / l; N[i * 3 + 1] = ty / l; N[i * 3 + 2] = tz / l;
    }
  }
  if (det < 0) { const I = out.indices; for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; } }
  return out;
}

/** Tiefe Kopie aller Attribute. */
export function clone(mesh) {
  const out = {};
  for (const [k, v] of Object.entries(mesh)) out[k] = v && v.slice ? v.slice() : v;
  return out;
}

/** Glatte, flächengewichtete Vertex-Normalen (in place). */
export function computeNormals(mesh) {
  const P = mesh.positions, I = mesh.indices, n = P.length / 3;
  const N = mesh.normals && mesh.normals.length === n * 3 ? mesh.normals : new Float32Array(n * 3);
  N.fill(0);
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { N[o] += nx; N[o + 1] += ny; N[o + 2] += nz; }
  }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
    N[i * 3] /= l; N[i * 3 + 1] /= l; N[i * 3 + 2] /= l;
  }
  mesh.normals = N;
  return mesh;
}

/** Konstante Vertexfarbe setzen (linear RGBA, in place). */
export function setColor(mesh, rgba) {
  const n = mesh.positions.length / 3;
  const c = mesh.colors && mesh.colors.length === n * 4 ? mesh.colors : new Float32Array(n * 4);
  const a = rgba.length > 3 ? rgba[3] : 1;
  for (let i = 0; i < n; i++) { c[i * 4] = rgba[0]; c[i * 4 + 1] = rgba[1]; c[i * 4 + 2] = rgba[2]; c[i * 4 + 3] = a; }
  mesh.colors = c;
  return mesh;
}

/** Konstante data-Werte setzen (in place). */
export function setData(mesh, v) {
  const n = mesh.positions.length / 3;
  const d = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) d[i * 4 + k] = v[k] ?? 0;
  mesh.data = d;
  return mesh;
}

/** Bounding-Kugel und AABB. */
export function computeBounds(mesh) {
  const P = mesh.positions, n = P.length / 3;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { const v = P[i * 3 + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  if (!n) return { center: [0, 0, 0], radius: 0, min: [0, 0, 0], max: [0, 0, 0] };
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let r2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = P[i * 3] - center[0], dy = P[i * 3 + 1] - center[1], dz = P[i * 3 + 2] - center[2];
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  return { center, radius: Math.sqrt(r2), min, max };
}

/**
 * Korrigiert die Windung jedes Dreiecks so, dass seine Flächennormale zur Vertex-Normalen passt.
 * (Sicherheitsnetz für alle Bausteine; degenerierte Dreiecke bleiben unverändert.)
 */
export function fixWinding(mesh) {
  const P = mesh.positions, N = mesh.normals, I = mesh.indices;
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const nx = N[a] + N[b] + N[c], ny = N[a + 1] + N[b + 1] + N[c + 1], nz = N[a + 2] + N[b + 2] + N[c + 2];
    if (fx * nx + fy * ny + fz * nz < 0) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; }
  }
  return mesh;
}

// ------------------------------------------------------------------ Hilfen
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm3(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function norm2(a) { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; }
function rotateAxis(v, k, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), kv = cross3(k, v), kd = dot3(k, v);
  return [v[0] * c + kv[0] * s + k[0] * kd * (1 - c), v[1] * c + kv[1] * s + k[1] * kd * (1 - c), v[2] * c + kv[2] * s + k[2] * kd * (1 - c)];
}
function catmull(pts, t, closed) {
  const n = pts.length;
  if (n === 1) return pts[0].slice();
  const segs = closed ? n : n - 1;
  const f = Math.max(0, Math.min(1, t)) * segs;
  let i = Math.min(Math.floor(f), segs - 1);
  const u = f - i;
  const g = (k) => (closed ? pts[((k % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, k))]);
  const p0 = g(i - 1), p1 = g(i), p2 = g(i + 1), p3 = g(i + 2);
  const u2 = u * u, u3 = u2 * u, o = [0, 0, 0];
  for (let k = 0; k < 3; k++) o[k] = 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * u + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u3);
  return o;
}
function signedArea(S) { let a = 0; for (let i = 0; i < S.length; i++) { const p = S[i], q = S[(i + 1) % S.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }

/** Ohrenschneiden-Triangulierung (CCW-Polygon ohne Löcher). Gibt Indexliste zurück. */
export function earcut(S) {
  const n = S.length, out = [];
  if (n < 3) return out;
  const V = [...Array(n).keys()];
  const isEar = (i0, i1, i2) => {
    const a = S[i0], b = S[i1], c = S[i2];
    const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (cr <= 1e-12) return false;
    for (const k of V) {
      if (k === i0 || k === i1 || k === i2) continue;
      const p = S[k];
      const d1 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      const d2 = (c[0] - b[0]) * (p[1] - b[1]) - (c[1] - b[1]) * (p[0] - b[0]);
      const d3 = (a[0] - c[0]) * (p[1] - c[1]) - (a[1] - c[1]) * (p[0] - c[0]);
      if (d1 >= 0 && d2 >= 0 && d3 >= 0) return false;
    }
    return true;
  };
  let guard = 0;
  while (V.length > 3 && guard++ < n * n) {
    let found = false;
    for (let i = 0; i < V.length; i++) {
      const i0 = V[(i - 1 + V.length) % V.length], i1 = V[i], i2 = V[(i + 1) % V.length];
      if (isEar(i0, i1, i2)) { out.push(i0, i1, i2); V.splice(i, 1); found = true; break; }
    }
    if (!found) { // degeneriert: Fächer
      for (let i = 1; i < V.length - 1; i++) out.push(V[0], V[i], V[i + 1]);
      return out;
    }
  }
  out.push(V[0], V[1], V[2]);
  return out;
}

// Stadion: Umrandungsmauern mit Schriftzügen, Sitzreihen (Tribünen + Pavillons) mit Treppen,
// Trennwände, Konkurse mit Geländer, Fassaden (Logen, Pressebereich), Dachring mit Rippen und Flaggen,
// Außenfassade, Flutlichtmasten (aus). Liefert außerdem alle Sitzplätze für das Publikum.
import { MeshBuilder } from './mb.js';
import { LAYOUT, BASE, BLOCKS, RoundRect, roofUnderY, rng32 } from './layout.js';
import { GLSL_ENV, hex, roofShadowAt, skyVisAt } from './envlib.js';
import { buildWallAtlas } from './signs.js';
import { mat4, vec3 } from '../core/math.js';
import { sphere } from '../gfx/geometry.js';

const L = LAYOUT;
const RF = L.roof;
export const ROOF_IN = new RoundRect(RF.innerX, RF.innerZ, RF.innerR);
export const ROOF_OUT = new RoundRect(RF.outerX, RF.outerZ, RF.outerR);

// Farben (linear)
const C = {
  riser: hex('#ece6d6'), tread: hex('#d3ccba'), stepTop: hex('#c9c2b0'), stepNose: hex('#e2dbca'),
  divider: hex('#ebe4d2'), concourse: hex('#bdb7a8'), facade: hex('#efe8d6'), facadeShade: hex('#d9d1bd'),
  rail: hex('#2b3a33'), roofTop: hex('#c9c8c2'), steel: hex('#e4e5e2'), roofUnder: hex('#f2f1ec'), fascia: hex('#f4f2ea'),
  gold: hex('#c9a04a'), green: hex('#143f2c'), greenDark: hex('#0d2a1e'), exterior: hex('#1d4a35'),
  plinth: hex('#cfc6b0'), mast: hex('#bfc3c2'), seat: hex('#1f5537'), wicker: hex('#c9b48a'), cushion: hex('#174a33'),
  glass: hex('#1b2a30'), wallTop: hex('#103424'),
  planter: hex('#ddd5c2'), leaf: hex('#2c5526'), leaf2: hex('#3d6b2c'), bloom: hex('#f3f1ea'),
};
// data = [roughness, pattern, ao, extra]; Muster: 0 glatt, 1 Beton, 2 Glas, 3 Dach, 4 Fassade, 5 Metall, 6 Außen, 8 Lampen
const D = (rough, pat, ao = 1, extra = 0) => [rough, pat, ao, extra];

const _a = {}, _b = {};

/** Waagrechter Streifen entlang s (Normale +y). */
function hstrip(mb, s0, s1, d0, d1, y0, y1, col, dat, maxA = 0.12, down = false) {
  const S = BASE.samples(s0, s1, maxA);
  const base = mb.vertexCount;
  const ny = down ? -1 : 1;
  for (const s of S) {
    const a = BASE.at(s, d0, _a), b = BASE.at(s, d1, _b);
    mb.v(a.x, y0, a.z, 0, ny, 0, s, 0, col, dat);
    mb.v(b.x, y1 ?? y0, b.z, 0, ny, 0, s, 1, col, dat);
  }
  for (let i = 0; i < S.length - 1; i++) {
    const k = base + i * 2;
    if (down) { mb.tri(k, k + 3, k + 2); mb.tri(k, k + 1, k + 3); }
    else { mb.tri(k, k + 2, k + 3); mb.tri(k, k + 3, k + 1); }
  }
}

/** Senkrechter Streifen bei Versatz d; face = -1: zum Platz, +1: nach außen. yTop optional Funktion(x,z). */
function vstrip(mb, s0, s1, d, y0, y1, face, col, dat, opts = {}) {
  const S = BASE.samples(s0, s1, opts.maxA ?? 0.12, opts.maxLine ?? 1e9);
  const base = mb.vertexCount;
  let u = 0, prev = null;
  for (const s of S) {
    const a = BASE.at(s, d, _a);
    if (prev) u += Math.hypot(a.x - prev[0], a.z - prev[1]);
    prev = [a.x, a.z];
    const top = typeof y1 === 'function' ? y1(a.x, a.z) : y1;
    const bot = typeof y0 === 'function' ? y0(a.x, a.z) : y0;
    const nx = a.nx * face, nz = a.nz * face;
    const uu = opts.uv ? opts.uv(u, s) : u;
    mb.v(a.x, bot, a.z, nx, 0, nz, uu, opts.vScale ? 0 : bot, col, opts.datBot || dat);
    mb.v(a.x, top, a.z, nx, 0, nz, uu, opts.vScale ? 1 : top, col, dat);
  }
  for (let i = 0; i < S.length - 1; i++) {
    const k = base + i * 2;
    if (face < 0) { mb.tri(k, k + 2, k + 3); mb.tri(k, k + 3, k + 1); }
    else { mb.tri(k, k + 3, k + 2); mb.tri(k, k + 1, k + 3); }
  }
}

/** Ring zwischen zwei abgerundeten Rechtecken gleicher Struktur (gleiche Eckwinkel). */
function ringPoints(rr, cornerSteps, lineSteps, out = []) {
  for (let gi = 0; gi < 8; gi++) {
    const g = rr.segs[gi];
    const n = g.arc ? cornerSteps : lineSteps;
    for (let i = 0; i < n; i++) {
      const s = g.s0 + g.len * (i / n);
      const a = rr.at(s, 0, {});
      out.push({ x: a.x, z: a.z, nx: a.nx, nz: a.nz });
    }
  }
  return out;
}

/** Profil-Oberkante (Boden) eines Blocks im Abstand d. */
function floorAt(prof, d) {
  if (d < L.wallThick) return prof.wallH;
  if (d >= prof.depthC) return L.concourseY;
  const k = Math.floor((d - L.wallThick) / L.rowDepth);
  return prof.floor0 + k * prof.rise;
}

/** Gänge (Basis-s) je Block. */
function aislesFor(b) {
  if (b.kind === 'grand') {
    const c0 = BASE.segs[b.name === 'E' ? 0 : 4], side = BASE.segs[b.name === 'E' ? 1 : 5], c1 = BASE.segs[b.name === 'E' ? 2 : 6];
    const a = [c0.s0 + c0.len * 0.5];
    for (let i = 0; i <= 4; i++) a.push(side.s0 + side.len * i / 4);
    a.push(c1.s0 + c1.len * 0.5);
    return a;
  }
  return [b.s0 + 2.6, b.s1 - 2.6];
}

export function buildStadium(r, q, opts = {}) {
  const rnd = rng32(1234);
  const lower = new MeshBuilder();   // wirft Schatten (Mauern, Reihen, Trennwände)
  const upper = new MeshBuilder();   // ohne Schattenwurf (Fassaden, Dach, Außenhülle) – analytischer Dachschatten
  const wall = new MeshBuilder();    // grüne Mauer mit Schrift-Atlas
  const atlas = buildWallAtlas();
  const seats = [];                  // { x, y, z, yaw, s, row, block, royal, nx, nz }

  // ------------------------------------------------------------ Umrandungsmauer
  const wallCol = C.green, wallDat = D(0.8, 0, 1, 0);
  for (let gi = 0; gi < 8; gi++) {
    const g = BASE.segs[gi];
    const blk = BLOCKS.find((b) => g.s0 >= b.s0 - 1e-6 && g.s1 <= b.s1 + 1e-6);
    const h = blk.prof.wallH;
    const name = BASE.names[gi];
    const reg = name === 'E' ? atlas.regions.sideE : name === 'W' ? atlas.regions.sideW : name === 'N' ? atlas.regions.endN : name === 'S' ? atlas.regions.endS : null;
    const S = BASE.samples(g.s0, g.s1, 0.1);
    const base = wall.vertexCount;
    for (const s of S) {
      const a = BASE.at(s, 0, _a);
      const t = (s - g.s0) / g.len;
      const u = reg ? reg.u0 + (reg.u1 - reg.u0) * t : -1;
      wall.v(a.x, 0, a.z, -a.nx, 0, -a.nz, u, reg ? reg.v1 : -1, wallCol, D(0.8, 0, 0.75, s));
      wall.v(a.x, h, a.z, -a.nx, 0, -a.nz, u, reg ? reg.v0 : -1, wallCol, D(0.8, 0, 1, s));
    }
    for (let i = 0; i < S.length - 1; i++) { const k = base + i * 2; wall.tri(k, k + 2, k + 3); wall.tri(k, k + 3, k + 1); }
    // Deckel (gepolsterte Kante) und Rückseite
    hstrip(wall, g.s0, g.s1, 0, L.wallThick, h, h, C.wallTop, D(0.7, 0, 1, -1));
    vstrip(wall, g.s0, g.s1, L.wallThick, blk.prof.floor0, h, 1, C.wallTop, D(0.8, 0, 0.8, -1));
  }

  // ------------------------------------------------------------ Sitzreihen je Block
  for (const b of BLOCKS) {
    const P = b.prof;
    const aisles = aislesFor(b);
    const isRoyalBlock = b.name === 'S';
    for (let k = 0; k < P.rows; k++) {
      const d0 = L.wallThick + k * L.rowDepth, d1 = d0 + L.rowDepth;
      const y = P.floor0 + k * P.rise;
      // Setzstufe (vorne), Trittfläche
      const yPrev = k === 0 ? P.floor0 : y - P.rise;
      if (k > 0) vstrip(lower, b.s0, b.s1, d0, yPrev, y, -1, C.riser, D(0.85, 1, 0.8), { maxA: 0.1 });
      hstrip(lower, b.s0, b.s1, d0, d1, y, y, C.tread, D(0.9, 1, 0.9), 0.1);
      // Treppenstufen in den Gängen (halbe Stufe in der hinteren Hälfte)
      for (const sa of aisles) {
        const dm = d0 + L.rowDepth * 0.5;
        const sc = BASE.at(sa, dm, _a).scale;
        const hw = 0.5 / sc;
        const yS = y + P.rise * 0.5;
        hstrip(lower, sa - hw, sa + hw, dm, d1, yS, yS, C.stepTop, D(0.9, 1, 1));
        vstrip(lower, sa - hw, sa + hw, dm, y, yS, -1, C.stepNose, D(0.85, 1, 0.9));
        // Seitenflächen
        for (const sg of [-1, 1]) {
          const ss = sa + sg * hw;
          const p0 = BASE.at(ss, dm, {}), p1 = BASE.at(ss, d1, {});
          const n = [p0.tx * sg, 0, p0.tz * sg];
          const A = [p0.x, y, p0.z], B = [p1.x, y, p1.z], Cc = [p1.x, yS, p1.z], Dd = [p0.x, yS, p0.z];
          if (sg > 0) lower.quad(A, B, Cc, Dd, n, null, C.stepNose, D(0.85, 1, 0.85));
          else lower.quad(B, A, Dd, Cc, n, null, C.stepNose, D(0.85, 1, 0.85));
        }
      }
      // Sitzplätze: Abschnitte zwischen Gängen bzw. Blockgrenzen
      const dSeat = d1 - 0.30;
      const bounds = [{ s: b.s0, pad: 0.35 }, ...aisles.map((s) => ({ s, pad: 0.55 })), { s: b.s1, pad: 0.35 }];
      for (let i = 0; i < bounds.length - 1; i++) {
        const sA = bounds[i].s, sB = bounds[i + 1].s;
        const len = BASE.lengthAt(sA, sB, dSeat);
        const usable = len - bounds[i].pad - bounds[i + 1].pad;
        const n = Math.floor(usable / L.seatPitch);
        if (n <= 0) continue;
        const start = bounds[i].pad + (usable - n * L.seatPitch) * 0.5 + L.seatPitch * 0.5;
        const royal = isRoyalBlock && i === 1 && k < 5;
        for (let j = 0; j < n; j++) {
          const sp = BASE.sAtLength(sA, start + j * L.seatPitch, dSeat);
          const a = BASE.at(sp, dSeat, {});
          seats.push({ x: a.x, y, z: a.z, yaw: Math.atan2(-a.nx, -a.nz), s: sp / BASE.length, row: k, block: b.name, royal, nx: a.nx, nz: a.nz });
        }
      }
    }
    // Handläufe in den Treppengängen (dunkelgrün), Pfosten jede 3. Reihe
    for (const sa of aisles) {
      let prevR = null;
      for (let k = 0; k <= P.rows; k++) {
        const kk = Math.min(k, P.rows - 1);
        const d = L.wallThick + k * L.rowDepth + (k === P.rows ? -0.1 : 0.2);
        const yk = P.floor0 + kk * P.rise + (k === P.rows ? P.rise * 0.5 : 0) + 0.92;
        const a = BASE.at(sa, d, {});
        const pR = [a.x, yk, a.z];
        if (prevR) upper.tube(prevR, pR, 0.022, 6, C.rail, D(0.35, 5, 1));
        if (k % 3 === 0 || k === P.rows) upper.tube([a.x, yk - 0.92, a.z], pR, 0.018, 5, C.rail, D(0.35, 5, 1));
        prevR = pR;
      }
    }
    // Pflanzkästen mit weißen Blüten auf der Mauerkrone (vor den Gängen; Seitentribünen zusätzlich dazwischen)
    {
      const spots = aisles.slice();
      if (b.kind === 'grand') for (let i = 1; i < aisles.length - 2; i++) spots.push((aisles[i] + aisles[i + 1]) * 0.5);
      else spots.push(b.s0 + 0.9, b.s1 - 0.9);
      for (const sp of spots) {
        const a = BASE.at(sp, L.wallThick * 0.5, {});
        const m = mat4.create();
        m[0] = -a.tx; m[2] = -a.tz; m[8] = a.nx; m[10] = a.nz; m[5] = 1;
        m[12] = a.x; m[13] = P.wallH; m[14] = a.z;
        addPlanter(lower, m, rnd, b.kind === 'grand' ? 1.5 : 1.2);
      }
    }
    // Setzstufe zur Konkurse + Konkurse
    const yLast = P.floor0 + (P.rows - 1) * P.rise;
    vstrip(lower, b.s0, b.s1, P.depthC, yLast, L.concourseY, -1, C.riser, D(0.85, 1, 0.85));
    hstrip(upper, b.s0, b.s1, P.depthC, P.depthF, L.concourseY, L.concourseY, C.concourse, D(0.9, 1, 0.8));
    // Geländer an der Konkurse-Vorderkante: Handlauf + Pfosten
    {
      const S = BASE.samples(b.s0 + 0.05, b.s1 - 0.05, 0.12, 2.0);
      const dR = P.depthC + 0.12, yR = L.concourseY + 1.0;
      let prev = null;
      for (const s of S) {
        const a = BASE.at(s, dR, {});
        const p = [a.x, yR, a.z];
        if (prev) upper.tube(prev, p, 0.03, 6, C.rail, D(0.35, 5, 1));
        upper.tube([a.x, L.concourseY, a.z], p, 0.025, 5, C.rail, D(0.35, 5, 1));
        prev = p;
      }
      // Glasfüllung (dunkel spiegelnd, halbhoch)
      vstrip(upper, b.s0, b.s1, dR + 0.02, L.concourseY + 0.05, L.concourseY + 0.95, -1, C.glass, D(0.08, 2, 1, 0), { uv: (u) => u, vScale: true });
    }
    // Fassade hinter der Konkurse: Logen (Glas), Balkon, Presse (Glas), Abschluss bis Dach
    {
      const dF = P.depthF;
      const yA = L.concourseY, yB = yA + 3.0, yC = yB + 0.45;
      const roofAt = (x, z) => roofUnderY(x, z) + 0.05;
      vstrip(upper, b.s0, b.s1, dF, yA, yA + 0.25, -1, C.facadeShade, D(0.8, 4, 0.7));
      vstrip(upper, b.s0, b.s1, dF, yA + 0.25, yB, -1, C.glass, D(0.06, 2, 1, 2.4), { uv: (u) => u, vScale: true });
      // Balkonplatte
      hstrip(upper, b.s0, b.s1, dF - 0.9, dF, yC, yC, C.facade, D(0.8, 4, 0.9));
      vstrip(upper, b.s0, b.s1, dF - 0.9, yB, yC, -1, C.facade, D(0.75, 4, 1));
      hstrip(upper, b.s0, b.s1, dF - 0.9, dF, yB, yB, C.facadeShade, D(0.8, 4, 0.6), 0.12, true);
      // Balkongeländer
      const S = BASE.samples(b.s0 + 0.05, b.s1 - 0.05, 0.12, 2.4);
      let prev = null;
      for (const s of S) {
        const a = BASE.at(s, dF - 0.85, {});
        const p = [a.x, yC + 1.0, a.z];
        if (prev) upper.tube(prev, p, 0.025, 5, C.fascia, D(0.4, 5, 1));
        upper.tube([a.x, yC, a.z], p, 0.02, 4, C.fascia, D(0.4, 5, 1));
        prev = p;
      }
      vstrip(upper, b.s0, b.s1, dF, yC, yC + 2.6, -1, C.glass, D(0.06, 2, 1, 3.2), { uv: (u) => u, vScale: true });
      vstrip(upper, b.s0, b.s1, dF, yC + 2.6, roofAt, -1, C.facade, D(0.8, 4, 0.75));
    }
  }

  // ------------------------------------------------------------ Trennwände an den Blockgrenzen (abgetreppt)
  const E = L.end, Gp = L.grand;
  for (const b of BLOCKS.filter((x) => x.kind === 'end')) {
    for (const [sj, side] of [[b.s0, 1], [b.s1, -1]]) {
      const pts = [];
      const brk = new Set([0, L.wallThick, E.depthC, E.depthF, Gp.depthC, Gp.depthF, L.exterior - 0.3]);
      for (let k = 0; k <= Math.max(E.rows, Gp.rows); k++) brk.add(L.wallThick + k * L.rowDepth);
      const ds = [...brk].filter((d) => d <= L.exterior - 0.3).sort((x, y) => x - y);
      for (let i = 0; i < ds.length - 1; i++) {
        const da = ds[i], db = ds[i + 1], dm = (da + db) * 0.5;
        let top;
        if (dm < L.wallThick) top = E.wallH;
        else if (dm < E.depthF) top = Math.max(floorAt(E, dm), floorAt(Gp, dm)) + 1.05;
        else { const p = BASE.at(sj, dm, _a); top = roofUnderY(p.x, p.z) + 0.05; }
        pts.push([da, db, top]);
      }
      for (const [da, db, top] of pts) {
        const p0 = BASE.at(sj, da, {}), p1 = BASE.at(sj, db, {});
        const cx = (p0.x + p1.x) / 2, cz = (p0.z + p1.z) / 2;
        const len = Math.hypot(p1.x - p0.x, p1.z - p0.z);
        const m = mat4.create();
        // lokale Achsen: x = Tangente, z = Normale
        m[0] = -p0.tx; m[2] = -p0.tz; m[8] = p0.nx; m[10] = p0.nz; m[5] = 1;
        m[12] = cx; m[13] = 0; m[14] = cz;
        lower.box([0, top / 2, 0], [0.4, top, len + 0.002], m, C.divider, D(0.85, 1, 0.9), 63 - 8);
      }
      void side;
    }
  }

  // ------------------------------------------------------------ Ehrenloge (Südpavillon, Mittelsektion, Reihen 0-4): Seitenwände, Brüstung
  {
    const b = BLOCKS.find((x) => x.name === 'S');
    const P = b.prof;
    const aisles = aislesFor(b);
    const dEnd = L.wallThick + 5 * L.rowDepth;
    for (const sa of aisles) {
      for (const sg of [-1, 1]) {
        const s = sa + sg * 0.52;
        for (let k = 0; k < 5; k++) {
          const d0 = L.wallThick + k * L.rowDepth, d1 = d0 + L.rowDepth;
          const y = P.floor0 + k * P.rise;
          const p0 = BASE.at(s, d0, {}), p1 = BASE.at(s, d1, {});
          const m = mat4.create();
          m[0] = -p0.tx; m[2] = -p0.tz; m[8] = p0.nx; m[10] = p0.nz; m[5] = 1;
          m[12] = (p0.x + p1.x) / 2; m[14] = (p0.z + p1.z) / 2;
          lower.box([0, y + 0.55, 0], [0.08, 1.1, L.rowDepth + 0.002], m, C.green, D(0.5, 0, 1), 63 - 8);
          lower.box([0, y + 1.12, 0], [0.12, 0.04, L.rowDepth + 0.01], m, C.gold, D(0.35, 5, 1), 63 - 8);
        }
      }
    }
    // Rückwand der Loge (grün) hinter Reihe 4
    const sA = aisles[0] + 0.56, sB = aisles[1] - 0.56;
    vstrip(lower, sA, sB, dEnd, P.floor0 + 4 * P.rise, P.floor0 + 5 * P.rise + 0.35, -1, C.green, D(0.5, 0, 0.9));
    hstrip(lower, sA, sB, dEnd - 0.06, dEnd + 0.06, P.floor0 + 5 * P.rise + 0.35, P.floor0 + 5 * P.rise + 0.35, C.gold, D(0.35, 5, 1));
  }

  // ------------------------------------------------------------ Dach
  const CS = 14, LS_ = 10;
  const pin = ringPoints(ROOF_IN, CS, LS_), pout = ringPoints(ROOF_OUT, CS, LS_);
  const nR = pin.length;
  const th = RF.thick;
  for (let i = 0; i < nR; i++) {
    const j = (i + 1) % nR;
    const a = pin[i], b = pin[j], c = pout[j], d = pout[i];
    // Oberseite (Normale ~ +y), Unterseite
    upper.quad([a.x, RF.yIn + th, a.z], [b.x, RF.yIn + th, b.z], [c.x, RF.yOut + th, c.z], [d.x, RF.yOut + th, d.z], null, [0, 0, 1, 1], C.roofTop, D(0.55, 3, 1));
    upper.quad([a.x, RF.yIn, a.z], [d.x, RF.yOut, d.z], [c.x, RF.yOut, c.z], [b.x, RF.yIn, b.z], null, [0, 0, 1, 1], C.roofUnder, D(0.7, 3, 0.75, 1));
    // Innenblende: weiß, Goldband, grüner Saum (zum Platz)
    const fz = (p, y) => [p.x, y, p.z];
    const nIn = [-(a.nx + b.nx) / 2, 0, -(a.nz + b.nz) / 2];
    const bands = [[RF.yIn - 1.0, RF.yIn - 0.85, C.green], [RF.yIn - 0.85, RF.yIn - 0.72, C.gold], [RF.yIn - 0.72, RF.yIn + th + 0.12, C.fascia]];
    for (const [y0, y1, col] of bands) upper.quad(fz(a, y0), fz(b, y0), fz(b, y1), fz(a, y1), nIn, null, col, D(col === C.gold ? 0.35 : 0.6, col === C.gold ? 5 : 0, 1));
    // Unterkante der Blende
    upper.quad(fz(b, RF.yIn - 1.0), fz(a, RF.yIn - 1.0), [a.x + a.nx * 0.35, RF.yIn - 1.0, a.z + a.nz * 0.35], [b.x + b.nx * 0.35, RF.yIn - 1.0, b.z + b.nz * 0.35], [0, -1, 0], null, C.fascia, D(0.6, 0, 0.8));
    upper.quad([b.x + b.nx * 0.35, RF.yIn - 1.0, b.z + b.nz * 0.35], [a.x + a.nx * 0.35, RF.yIn - 1.0, a.z + a.nz * 0.35], [a.x + a.nx * 0.35, RF.yIn, a.z + a.nz * 0.35], [b.x + b.nx * 0.35, RF.yIn, b.z + b.nz * 0.35], [a.nx, 0, a.nz], null, C.fascia, D(0.6, 0, 0.6));
    // Oberkante Blende (Deckel)
    upper.quad(fz(a, RF.yIn + th + 0.12), fz(b, RF.yIn + th + 0.12), [b.x + b.nx * 0.3, RF.yIn + th + 0.12, b.z + b.nz * 0.3], [a.x + a.nx * 0.3, RF.yIn + th + 0.12, a.z + a.nz * 0.3], [0, 1, 0], null, C.fascia, D(0.6, 0, 1));
    // Außenblende
    const nOut = [(c.nx + d.nx) / 2, 0, (c.nz + d.nz) / 2];
    upper.quad(fz(c, RF.yOut - 0.5), fz(d, RF.yOut - 0.5), fz(d, RF.yOut + th + 0.05), fz(c, RF.yOut + th + 0.05), nOut, null, C.fascia, D(0.6, 0, 1));
    upper.quad(fz(d, RF.yOut - 0.5), fz(c, RF.yOut - 0.5), fz(c, RF.yOut), fz(d, RF.yOut), [-nOut[0], 0, -nOut[2]], null, C.fascia, D(0.6, 0, 0.8));
    // Aufgesetzte Stahlrippen auf der Oberseite (jede 4. Stützstelle)
    if (i % 4 === 0) {
      const tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz) || 1;
      const ox = (tx / tl) * 0.14, oz = (tz / tl) * 0.14;
      const y0i = RF.yIn + th, y0o = RF.yOut + th, hr = 0.32;
      const A0 = [a.x + a.nx * 0.5, a.z + a.nz * 0.5], B0 = [d.x - d.nx * 0.3, d.z - d.nz * 0.3];
      const ti = 0.5 / Math.hypot(d.x - a.x, d.z - a.z);
      const yA = y0i + (y0o - y0i) * ti, yB = y0o - (y0o - y0i) * 0.02;
      upper.quad([A0[0] - ox, yA + hr, A0[1] - oz], [A0[0] + ox, yA + hr, A0[1] + oz], [B0[0] + ox, yB + hr, B0[1] + oz], [B0[0] - ox, yB + hr, B0[1] - oz], null, null, C.steel, D(0.45, 5, 1));
      for (const sg of [-1, 1]) {
        const n = [ox / 0.14 * sg, 0, oz / 0.14 * sg];
        const P0 = [A0[0] + ox * sg, yA, A0[1] + oz * sg], P1 = [B0[0] + ox * sg, yB, B0[1] + oz * sg];
        const Q1 = [P1[0], yB + hr, P1[2]], Q0 = [P0[0], yA + hr, P0[2]];
        if (sg > 0) upper.quad(P0, P1, Q1, Q0, n, null, C.steel, D(0.45, 5, 0.9));
        else upper.quad(P1, P0, Q0, Q1, n, null, C.steel, D(0.45, 5, 0.9));
      }
    }
    // Rippen unter dem Dach (jede 2. Stützstelle)
    if (i % 2 === 0) {
      const tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz) || 1;
      const ox = (tx / tl) * 0.12, oz = (tz / tl) * 0.12;
      const yi = RF.yIn - 0.02, yo = RF.yOut - 0.02, hi = 0.9, ho = 1.8;
      const ai = [a.x + a.nx * 0.4, a.z + a.nz * 0.4];
      for (const sg of [-1, 1]) {
        const n = [ox / 0.12 * sg, 0, oz / 0.12 * sg];
        const A = [ai[0] + ox * sg, yi - hi, ai[1] + oz * sg], B = [d.x + ox * sg, yo - ho, d.z + oz * sg], Cc = [d.x + ox * sg, yo, d.z + oz * sg], Dd = [ai[0] + ox * sg, yi, ai[1] + oz * sg];
        if (sg > 0) upper.quad(A, B, Cc, Dd, n, null, C.roofUnder, D(0.6, 5, 0.75));
        else upper.quad(B, A, Dd, Cc, n, null, C.roofUnder, D(0.6, 5, 0.75));
      }
      upper.quad([ai[0] + ox, yi - hi, ai[1] + oz], [ai[0] - ox, yi - hi, ai[1] - oz], [d.x - ox, yo - ho, d.z - oz], [d.x + ox, yo - ho, d.z + oz], [0, -1, 0], null, C.roofUnder, D(0.6, 5, 0.7));
    }
  }

  // ------------------------------------------------------------ Flaggen auf der Innenblende
  const flags = [];
  for (let i = 0; i < nR; i += 3) {
    const a = pin[i];
    const base = [a.x + a.nx * 0.15, RF.yIn + th + 0.12, a.z + a.nz * 0.15];
    const top = [base[0], base[1] + 4.2, base[2]];
    upper.tube(base, top, 0.045, 6, C.fascia, D(0.4, 5, 1));
    upper.tube(top, [top[0], top[1] + 0.08, top[2]], 0.08, 6, C.gold, D(0.3, 5, 1));
    flags.push({ x: top[0], y: top[1] - 0.05, z: top[2], i: flags.length });
  }

  // ------------------------------------------------------------ Außenfassade + Sockel
  const ext = L.exterior;
  const extTop = (x, z) => roofUnderY(x, z) + 0.05;
  vstrip(upper, 0, BASE.length, ext, 0, extTop, 1, C.exterior, D(0.85, 6, 1), { maxA: 0.06, maxLine: 3.0 });
  vstrip(upper, 0, BASE.length, ext + 0.25, 0, 1.2, 1, C.plinth, D(0.85, 1, 1), { maxA: 0.06 });
  hstrip(upper, 0, BASE.length, ext, ext + 0.25, 1.2, 1.2, C.plinth, D(0.85, 1, 1), 0.06);

  // ------------------------------------------------------------ Flutlichtmasten (aus)
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const cx = sx * (L.wallX - L.cornerR), cz = sz * (L.wallZ - L.cornerR);
    const rr = L.cornerR + ext + 6.5;
    const x = cx + sx * rr * 0.62, z = cz + sz * rr * 0.79;
    const H = 44;
    upper.tube([x, 0, z], [x, H * 0.55, z], 0.5, 10, C.mast, D(0.45, 5, 1));
    upper.tube([x, H * 0.55, z], [x, H - 1.6, z], 0.34, 10, C.mast, D(0.45, 5, 1));
    // Kopf: Gitterrahmen mit Lampenraster, zum Platz geneigt
    const m = mat4.create();
    const yaw = Math.atan2(-x, -z);
    mat4.fromYawTranslation(m, yaw, [x, H, z]);
    mat4.rotateX(m, m, 0.45);
    const fr = hex('#7d8482');
    for (const yy of [-1.55, 0, 1.55]) upper.box([0, yy, -0.2], [6.4, 0.14, 0.14], m, fr, D(0.45, 5, 1));
    for (const xx of [-3.2, 3.2]) upper.box([xx, 0, -0.2], [0.14, 3.24, 0.14], m, fr, D(0.45, 5, 1));
    upper.box([0, -1.75, -0.6], [0.3, 0.3, 1.0], m, fr, D(0.45, 5, 1));
    for (let ly = 0; ly < 3; ly++) for (let lx = 0; lx < 7; lx++) {
      const p0 = vec3.transformMat4([], [-2.7 + lx * 0.9, -1.0 + ly * 1.0, -0.15], m);
      const p1 = vec3.transformMat4([], [-2.7 + lx * 0.9, -1.0 + ly * 1.0, 0.18], m);
      upper.tube(p0, p1, 0.36, 10, C.mast, D(0.35, 5, 1), false);
      const p2 = vec3.transformMat4([], [-2.7 + lx * 0.9, -1.0 + ly * 1.0, 0.19], m);
      upper.tube(p1, p2, 0.32, 10, C.glass, D(0.1, 8, 1), true);
    }
  }

  // ------------------------------------------------------------ Meshes & Materialien
  const wallTex = r.createTexture(atlas.canvas, { srgb: true, anisotropy: 8, wrap: 'clamp' });
  const structMat = createStructureMaterial(r);
  const wallMat = r.createMaterial({
    name: 'env-wall',
    uniforms: { u_signs: wallTex },
    surface: GLSL_ENV + `
void surface(in SurfaceInput i, inout Surface s) {
  vec3 P = i.worldPos;
  vec3 col = s.albedo;
  if (i.uv.x >= 0.0) col = texture(u_signs, i.uv).rgb;
  // Paneelfugen alle 2.5 m, leichte Wolkigkeit
  float seam = abs(fract(i.data.w / 2.5) - 0.5) * 2.5;
  float fw = max(fwidth(i.data.w), 1e-4);
  col *= mix(0.72, 1.0, smoothstep(0.0, 1.5 * fw + 0.004, seam)) * (i.data.w < 0.0 ? 1.0 : 1.0);
  col *= 0.94 + 0.08 * noise2(P.xz * 0.7 + P.y * 1.3);
  s.albedo = col;
  s.roughness = 0.62;
  s.specular = 0.45;
  s.ao = i.data.z * env_skyVis(P, s.normal);
  s.shadow = env_roofShadow(P);
}`,
  });
  const lowerMesh = r.createMesh(lower.finish());
  const upperMesh = r.createMesh(upper.finish());
  const wallMesh = r.createMesh(wall.finish());
  const drawables = [
    { mesh: wallMesh, material: wallMat },
    { mesh: lowerMesh, material: structMat },
    { mesh: upperMesh, material: structMat, castShadow: false, receiveShadow: false },
  ];

  // ------------------------------------------------------------ Sitze (instanziert)
  const seatMesh = buildSeatMesh();
  const seatInst = r.createInstances(seats.length);
  const m = mat4.create();
  for (let i = 0; i < seats.length; i++) {
    const st = seats[i];
    mat4.fromYawTranslation(m, st.yaw, [st.x, st.y, st.z], 1);
    if (st.royal) mat4.scale(m, m, [0.98, 1.12, 1.1]);
    const col = st.royal ? C.wicker : C.seat;
    const v = 0.9 + rnd() * 0.15;
    const sky = skyVisAt(st.x, st.y + 0.6, st.z, -st.nx * 0.5, 0.85, -st.nz * 0.5), sh = roofShadowAt(st.x, st.y + 0.6, st.z);
    seatInst.set(i, m, [col[0] * v, col[1] * v, col[2] * v, (st.royal ? 1 : 0) + 2 * Math.round(sky * 63) + 128 * Math.round(sh * 7)]);
  }
  seatInst.count = seats.length;
  const seatMat = r.createMaterial({
    name: 'env-seat',
    surface: `
void surface(in SurfaceInput i, inout Surface s) {
  int pk = int(i.instColor.a + 0.5);
  s.albedo = i.instColor.rgb;
  if ((pk & 1) != 0) {
    // Korbgeflecht
    float wv = noise2(i.worldPos.xz * 60.0 + i.worldPos.y * 30.0);
    s.albedo *= 0.8 + 0.4 * wv;
    s.roughness = 0.75;
  } else s.roughness = 0.42;
  s.ao = float((pk >> 1) & 63) / 63.0 * (0.6 + 0.4 * max(i.normal.y, 0.0));
  s.shadow = float((pk >> 7) & 7) / 7.0;
}`,
    castShadow: false,
  });
  drawables.push({ mesh: r.createMesh(seatMesh), material: seatMat, instances: seatInst, castShadow: false, receiveShadow: false });

  // ------------------------------------------------------------ Flaggen (instanziert, Vertex-Wind)
  const flagInst = r.createInstances(flags.length);
  const palette = [[C.green, C.gold], [C.fascia, C.green], [C.gold, C.green], [hex('#4b2a5e'), C.fascia]];
  for (const f of flags) {
    mat4.fromYawTranslation(m, 0, [f.x, f.y, f.z]);
    const p = palette[f.i % palette.length];
    flagInst.set(f.i, m, [p[0][0], p[0][1], p[0][2], 1], [p[1][0], p[1][1], p[1][2], f.i * 0.37]);
  }
  flagInst.count = flags.length;
  const flagGeo = flagMesh();
  const flagMat = r.createMaterial({
    name: 'env-flag',
    uniforms: { u_wind: [1.0, 0.0, 0.25], u_windStrength: 1.0 },
    vertex: `
void vertexObject(inout vec3 p, inout vec3 n) {
  // Fahne liegt in lokaler XY-Ebene (x = Abstand vom Mast 0..1.8)
  float u = p.x / 1.8;
  float ph = u_time * 5.5 + g_instData.w * 6.0;
  float a = u * u_windStrength;
  float wave = sin(ph - u * 7.0) * 0.22 * a + sin(ph * 1.7 - u * 13.0) * 0.06 * a;
  float yaw = atan(u_wind.z, u_wind.x) + sin(u_time * 0.4 + g_instData.w) * 0.12;
  float c = cos(yaw), s = sin(yaw);
  vec3 q = vec3(p.x, p.y - u * u * 0.18 * (1.2 - u_windStrength * 0.5), wave);
  p = vec3(q.x * c - q.z * s, q.y, q.x * s + q.z * c);
  float dw = cos(ph - u * 7.0) * -7.0 * 0.22 * a / 1.8;
  vec3 nn = normalize(vec3(-dw, 0.0, 1.0));
  n = vec3(nn.x * c - nn.z * s, nn.y, nn.x * s + nn.z * c);
}`,
    surface: `
void surface(in SurfaceInput i, inout Surface s) {
  vec2 uv = i.uv;
  vec3 a = i.instColor.rgb, b = i.instData.rgb;
  float stripe = step(0.36, uv.y) * step(uv.y, 0.64);
  s.albedo = mix(a, b, stripe);
  s.roughness = 0.8;
  s.sheen = 0.4; s.sheenColor = vec3(1.0);
  s.subsurface = 0.5; s.subsurfaceColor = s.albedo;
}`,
    cull: 'none',
  });
  drawables.push({ mesh: r.createMesh(flagGeo), material: flagMat, instances: flagInst, castShadow: false, receiveShadow: false });

  return {
    drawables, seats, atlas, flagMaterial: flagMat, structMaterial: structMat,
    stats: { lowerTris: lower.idx.length / 3, upperTris: upper.idx.length / 3, wallTris: wall.idx.length / 3, seats: seats.length },
  };
}

function buildSeatMesh() {
  const mb = new MeshBuilder();
  const w = [1, 1, 1, 1], d = D(0.5, 0, 1);
  // Sitzschale + abgerundete Vorderkante
  mb.box([0, 0.43, 0.03], [0.44, 0.045, 0.38], null, w, d, 63 - 8);
  mb.box([0, 0.415, 0.215], [0.44, 0.05, 0.04], null, w, d, 63 - 8 - 16);
  // hohe, leicht gewölbte Rückenlehne aus zwei Hälften
  for (const sx of [-1, 1]) {
    const m = mat4.create();
    mat4.fromTranslation(m, [sx * 0.11, 0.45, -0.17]);
    mat4.rotateY(m, m, -sx * 0.16);
    mat4.rotateX(m, m, -0.16);
    mb.box([0, 0.21, 0], [0.225, 0.42, 0.04], m, w, d, 63 - 8);
  }
  mb.box([0, 0.2, -0.08], [0.08, 0.4, 0.08], null, w, d, 1 | 2 | 16 | 32);
  const md = mb.finish();
  delete md.colors; delete md.data;
  return md;
}

/** Pflanzkasten (Stein, creme) mit Buchs/Hortensien und weißen Blütenbällen. m: lokale x = Tangente, z = nach außen. */
const _sph = sphere(1, 8, 6), _sphS = sphere(1, 6, 4);
function addPlanter(mb, m, rnd, len) {
  const box = mat4.create();
  mb.box([0, 0.15, 0.1], [len, 0.3, 0.42], m, C.planter, D(0.8, 4, 1), 63 - 8);
  mb.box([0, 0.31, 0.1], [len + 0.06, 0.03, 0.48], m, C.planter, D(0.75, 4, 1), 63 - 8);
  const n = Math.round(len / 0.3);
  const leafM = mat4.create(), tmp = mat4.create();
  for (let i = 0; i < n; i++) {
    const x = -len / 2 + 0.15 + (i + 0.5) * (len - 0.3) / n + (rnd() - 0.5) * 0.08;
    const r = 0.17 + rnd() * 0.08;
    mat4.fromTranslation(tmp, [x, 0.33 + r * 0.7, 0.1 + (rnd() - 0.5) * 0.08]);
    mat4.scale(tmp, tmp, [r * 1.15, r, r]);
    mat4.multiply(leafM, m, tmp);
    mb.add(_sph, leafM, rnd() < 0.5 ? C.leaf : C.leaf2, D(0.85, 7, 0.9));
    // Blütenbälle vorne/oben
    const nb = 2 + Math.floor(rnd() * 2);
    for (let j = 0; j < nb; j++) {
      const ang = (rnd() - 0.5) * 2.2, el = 0.25 + rnd() * 0.9;
      const fr = 0.055 + rnd() * 0.035;
      const px = x + Math.sin(ang) * r * 0.9 * Math.cos(el), py = 0.33 + r * 0.7 + Math.sin(el) * r * 0.95, pz = 0.1 - Math.cos(ang) * r * 0.95 * Math.cos(el);
      mat4.fromTranslation(tmp, [px, py, pz]);
      mat4.scale(tmp, tmp, [fr, fr * 0.85, fr]);
      mat4.multiply(leafM, m, tmp);
      mb.add(_sphS, leafM, C.bloom, D(0.7, 9, 1));
    }
  }
  void box;
}

function flagMesh() {
  const mb = new MeshBuilder();
  const nx = 10, ny = 4, W = 1.8, H = 1.15;
  const base = mb.vertexCount;
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) mb.v(W * i / nx, -H * j / ny, 0, 0, 0, 1, i / nx, j / ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = base + j * (nx + 1) + i, b = a + 1, c = a + nx + 1, e = c + 1;
    mb.tri(a, c, b); mb.tri(b, c, e);
  }
  const md = mb.finish();
  delete md.colors; delete md.data;
  return md;
}

/** Strukturmaterial: Vertexfarbe + prozedurale Muster (Beton, Glas, Dach, Fassade, Metall, Außen). */
export function createStructureMaterial(r) {
  return r.createMaterial({
    name: 'env-structure',
    uniforms: { u_interior: [1.0, 0.72, 0.45] },
    surface: GLSL_ENV + `
void surface(in SurfaceInput i, inout Surface s) {
  vec3 P = i.worldPos;
  int pat = int(i.data.y + 0.5);
  vec3 col = s.albedo;
  float rough = i.data.x;
  float ao = i.data.z;
  if (pat == 1) {
    vec2 q = abs(i.normal.y) > 0.5 ? P.xz : vec2(P.x + P.z, P.y);
    float n = noise2(q * 1.9) * 0.6 + noise2(q * 7.3 + 5.0) * 0.4;
    col *= 0.88 + 0.2 * n;
  } else if (pat == 2) {
    // Glas mit Pfosten/Riegeln; data.w = Rasterbreite (0 = nur Glas)
    float gw = i.data.w;
    float frame = 0.0;
    if (gw > 0.0) {
      float u = i.uv.x / gw;
      float du = abs(fract(u) - 0.5) * gw;
      float fwu = max(fwidth(i.uv.x), 1e-4);
      frame = 1.0 - smoothstep(0.035, 0.035 + fwu * 1.5, gw * 0.5 - du);
      float v = i.uv.y;
      float fwv = max(fwidth(v), 1e-4);
      frame = max(frame, 1.0 - smoothstep(0.02, 0.02 + fwv * 1.5, min(v, 1.0 - v)));
      frame = max(frame, 1.0 - smoothstep(0.012, 0.012 + fwv * 1.5, abs(v - 0.72)));
      // Innenraum: warmes Licht, zufällig je Feld
      float cell = floor(u);
      float lit = step(0.35, hash11(cell * 1.37 + floor(P.y)));
      s.emissive = u_interior * (0.05 + 0.10 * lit) * (1.0 - frame) * smoothstep(0.0, 0.6, v);
    }
    col = mix(col, vec3(0.86, 0.85, 0.8), frame);
    rough = mix(0.05, 0.5, frame);
    // Spiegelung im Kessel: unterhalb des Tribünenrands sieht das Glas Zuschauer statt Himmel
    vec3 Rf = reflect(-i.viewDir, i.normal);
    s.specular = mix(mix(0.15, 0.9, smoothstep(0.15, 0.55, Rf.y)), 0.5, frame);
  } else if (pat == 3) {
    // Dach: Bahnen (radial) mit Stehfalzen, umlaufende Rinne, leichte Verschmutzung
    float n = noise2(P.xz * 0.35) * 0.6 + noise2(P.xz * 2.1) * 0.4;
    col *= 0.9 + 0.14 * n;
    if (i.data.w < 0.5) {
      float u = atan(P.z, P.x) * 70.0;
      float fu = max(fwidth(u), 1e-4);
      float seam = abs(fract(u) - 0.5);
      col *= mix(0.78, 1.0, smoothstep(0.0, 0.03 + fu, seam));
      float dIn = env_sdRR(P.xz, vec2(${RF.innerX.toFixed(2)}, ${RF.innerZ.toFixed(2)}), ${RF.innerR.toFixed(2)});
      col *= mix(0.86, 1.0, smoothstep(0.6, 1.4, dIn));               // Rinne an der Innenkante
      rough = 0.78;
      col *= mix(1.0, 0.85, smoothstep(6.0, 0.0, abs(dIn - 7.0)) * n);  // Wasserspuren
    }
  } else if (pat == 4) {
    float n = noise3(P * 0.9) * 0.6 + noise3(P * 5.0) * 0.4;
    col *= 0.92 + 0.12 * n;
  } else if (pat == 5) {
    s.metalness = 0.55;
    rough = i.data.x;
  } else if (pat == 6) {
    // Außenfassade: grüne Verkleidung mit cremefarbenen Lisenen und Fensterbändern
    float u = i.uv.x, v = i.uv.y;
    float bay = abs(fract(u / 6.0) - 0.5) * 6.0;
    float pil = 1.0 - smoothstep(0.32, 0.36, bay);
    float win = step(0.9, bay) * step(bay, 2.6) * (step(3.0, v) * step(v, 6.2) + step(9.5, v) * step(v, 12.0) + step(13.6, v) * step(v, 15.6));
    vec3 cream = vec3(0.80, 0.76, 0.66);
    col = mix(col * (0.85 + 0.25 * noise2(P.xz * 0.3 + P.y)), cream, pil);
    col = mix(col, vec3(0.03, 0.04, 0.045), win);
    rough = mix(rough, 0.1, win);
    s.specular = mix(0.5, 1.0, win);
    // Eingangsbögen unten
    float arch = step(abs(fract(u / 12.0 + 0.25) - 0.5) * 12.0, 1.4) * step(v, 2.8);
    col = mix(col, vec3(0.02, 0.025, 0.02), arch);
    // Efeu-Flecken
    float ivy = smoothstep(0.55, 0.75, fbm2(vec2(u * 0.35, v * 0.5), 3)) * (1.0 - pil) * step(v, 9.0);
    col = mix(col, vec3(0.03, 0.09, 0.025), ivy * 0.8);
  } else if (pat == 7) {
    // Laub (Buchs/Hortensie): Blattbüschel-Rauschen, Durchscheinen
    float n = noise3(P * 24.0) * 0.55 + noise3(P * 7.0 + 2.0) * 0.45;
    col *= 0.5 + 0.85 * n;
    rough = 0.85;
    s.subsurface = 0.4; s.subsurfaceColor = vec3(0.3, 0.55, 0.12);
  } else if (pat == 9) {
    float n = noise3(P * 70.0);
    col *= 0.82 + 0.22 * n;
    rough = 0.7; s.sheen = 0.5; s.sheenColor = vec3(1.0);
    s.subsurface = 0.3; s.subsurfaceColor = vec3(1.0, 0.95, 0.85);
  } else if (pat == 8) {
    col = vec3(0.04);
    float g = step(0.5, fract(i.uv.x * 6.0)) * step(0.5, fract(i.uv.y * 4.0));
    rough = 0.15; s.specular = 1.0;
    col += vec3(0.05) * g;
  }
  s.albedo = col;
  s.roughness = rough;
  s.ao = ao * env_skyVis(P, s.normal);
  // Dachoberseite/Blendendeckel liegen über der analytischen Schattenebene -> kein Selbstschatten
  bool roofTop = P.y > ${(RF.yIn + 0.02).toFixed(2)} && i.normal.y > 0.5;
  s.shadow = roofTop ? 1.0 : env_roofShadow(P);
}`,
  });
}

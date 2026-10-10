// Stadion-Layout: gemeinsame Maße und Pfad-Geometrie (abgerundetes Rechteck) für alle World-Module.
// Benennung: Nord = z < 0, Süd = z > 0, Ost = x > 0, West = x < 0 (Schiedsrichter im Westen).
// Die Innenkante der Umrandungsmauer entspricht den Ballphysik-Wänden aus src/sim/ball.js
// (x = ±(Doppellinie + Auslauf seitlich), z = ±(Grundlinie + Auslauf hinten)).
import { COURT } from '../sim/court.js';

const TAU = Math.PI * 2;

export const LAYOUT = {
  wallX: COURT.doublesHalfWidth + COURT.runoffSide,   // 9.145
  wallZ: COURT.halfLength + COURT.runoffBack,         // 18.285
  cornerR: 3.0,
  wallThick: 0.3,
  rowDepth: 0.82,
  seatPitch: 0.52,
  concourseY: 9.13,
  concourseW: 2.2,
  // Blöcke: Längsseiten (inkl. Ecken) = Tribünen mit 18 Reihen, Stirnseiten = Pavillons mit 12 Reihen
  grand: { wallH: 1.25, floor0: 0.85, rows: 18 },
  end: { wallH: 3.2, floor0: 2.75, rows: 12 },
  roof: { innerX: 19.6, innerZ: 29.6, innerR: 14.0, outerX: 31.0, outerZ: 40.1, outerR: 24.8, yIn: 16.6, yOut: 18.2, thick: 0.55 },
  outerPad: 3.0,          // Gebäudetiefe hinter der Tribünen-Fassade
};
for (const b of [LAYOUT.grand, LAYOUT.end]) {
  b.rise = (LAYOUT.concourseY - b.floor0) / b.rows;
  b.depthC = LAYOUT.wallThick + b.rows * LAYOUT.rowDepth;     // Beginn Konkurse (Abstand zur Mauer)
  b.depthF = b.depthC + LAYOUT.concourseW;                     // Fassade
}
LAYOUT.exterior = LAYOUT.grand.depthF + LAYOUT.outerPad;       // Außenfassade (Versatz zur Mauer)

/** Signierter Abstand zu einem abgerundeten Rechteck (Halbachsen ax/az, Radius r), > 0 außen. */
export function sdRoundRect(x, z, ax, az, r) {
  const qx = Math.abs(x) - ax + r, qz = Math.abs(z) - az + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - r;
}

/** Unterkante des Dachs an (x,z): linear zwischen Innen- und Außenkante. */
export function roofUnderY(x, z) {
  const R = LAYOUT.roof;
  const a = sdRoundRect(x, z, R.innerX, R.innerZ, R.innerR), b = sdRoundRect(x, z, R.outerX, R.outerZ, R.outerR);
  const t = Math.min(1, Math.max(0, a / Math.max(a - b, 1e-3)));
  return R.yIn + (R.yOut - R.yIn) * t;
}

/**
 * Abgerundetes Rechteck (Halbachsen ax, az, Eckradius r) als Bogenlängen-parametrisierter Pfad.
 * Start an der Nordost-Ecke (Normale (0,-1)), Umlauf: NO-Ecke, Ostseite, SO-Ecke, Südende, SW-Ecke,
 * Westseite, NW-Ecke, Nordende. Versatz d wirkt entlang der Außennormalen (Ecken: Radius r + d).
 */
export class RoundRect {
  constructor(ax, az, r) {
    this.ax = ax; this.az = az; this.r = r;
    const cx = ax - r, cz = az - r;
    const segs = [];
    const arc = (ccx, ccz, a0) => segs.push({ arc: true, cx: ccx, cz: ccz, a0, len: r * Math.PI / 2 });
    const line = (x0, z0, x1, z1, nx, nz) => segs.push({ arc: false, x0, z0, x1, z1, nx, nz, len: Math.hypot(x1 - x0, z1 - z0) });
    arc(cx, -cz, -Math.PI / 2);                 // NO
    line(ax, -cz, ax, cz, 1, 0);                // Ost
    arc(cx, cz, 0);                             // SO
    line(cx, az, -cx, az, 0, 1);                // Süd
    arc(-cx, cz, Math.PI / 2);                  // SW
    line(-ax, cz, -ax, -cz, -1, 0);             // West
    arc(-cx, -cz, Math.PI);                     // NW
    line(-cx, -az, cx, -az, 0, -1);             // Nord
    let s = 0;
    for (const g of segs) { g.s0 = s; s += g.len; g.s1 = s; }
    this.segs = segs; this.length = s;
    this.names = ['NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N'];
  }
  segAt(s) {
    s = ((s % this.length) + this.length) % this.length;
    for (const g of this.segs) if (s <= g.s1) return g;
    return this.segs[this.segs.length - 1];
  }
  /** Punkt bei Basis-Bogenlänge s mit Versatz d: out = { x, z, nx, nz, tx, tz, scale } (scale = dl/ds). */
  at(s, d = 0, out = {}) {
    s = ((s % this.length) + this.length) % this.length;
    const g = this.segAt(s);
    const u = s - g.s0;
    if (g.arc) {
      const a = g.a0 + u / this.r;
      const c = Math.cos(a), sn = Math.sin(a);
      out.nx = c; out.nz = sn;
      out.x = g.cx + c * (this.r + d); out.z = g.cz + sn * (this.r + d);
      out.scale = (this.r + d) / this.r;
    } else {
      const t = u / g.len;
      out.nx = g.nx; out.nz = g.nz;
      out.x = g.x0 + (g.x1 - g.x0) * t + g.nx * d; out.z = g.z0 + (g.z1 - g.z0) * t + g.nz * d;
      out.scale = 1;
    }
    // Tangente in Laufrichtung (gegen den Uhrzeigersinn von oben gesehen mit +z nach unten)
    out.tx = -out.nz; out.tz = out.nx;
    return out;
  }
  /** Segmentgrenzen s0/s1 eines benannten Segments. */
  range(name) { const g = this.segs[this.names.indexOf(name)]; return [g.s0, g.s1]; }
  /** Stützstellen zwischen s0 und s1: Geraden grob, Bögen fein (maxAngle rad je Schritt). */
  samples(s0, s1, maxAngle = 0.08, maxLine = 1e9) {
    const out = [s0];
    for (const g of this.segs) {
      const a = Math.max(s0, g.s0), b = Math.min(s1, g.s1);
      if (b <= a + 1e-6) continue;
      const step = g.arc ? maxAngle * this.r : maxLine;
      const n = Math.max(1, Math.ceil((b - a) / step - 1e-6));
      for (let i = 1; i <= n; i++) out.push(a + (b - a) * i / n);
    }
    // Duplikate entfernen
    const res = [out[0]];
    for (let i = 1; i < out.length; i++) if (out[i] - res[res.length - 1] > 1e-5) res.push(out[i]);
    return res;
  }
  /** Länge der versetzten Kurve zwischen s0 und s1. */
  lengthAt(s0, s1, d) {
    let L = 0;
    for (const g of this.segs) {
      const a = Math.max(s0, g.s0), b = Math.min(s1, g.s1);
      if (b <= a) continue;
      L += g.arc ? (b - a) * (this.r + d) / this.r : (b - a);
    }
    return L;
  }
  /** Basis-s, an dem die versetzte Kurve (Versatz d) ab s0 die Länge len erreicht. */
  sAtLength(s0, len, d) {
    let rem = len;
    for (const g of this.segs) {
      if (g.s1 <= s0) continue;
      const a = Math.max(s0, g.s0);
      const k = g.arc ? (this.r + d) / this.r : 1;
      const segL = (g.s1 - a) * k;
      if (rem <= segL) return a + rem / k;
      rem -= segL;
    }
    return this.length;
  }
}

export const BASE = new RoundRect(LAYOUT.wallX, LAYOUT.wallZ, LAYOUT.cornerR);

/** Blöcke entlang des Basis-Pfads: Ost-/West-Tribüne (Seite + beide Ecken), Süd-/Nord-Pavillon. */
export const BLOCKS = (() => {
  const S = BASE.segs;
  return [
    { name: 'E', kind: 'grand', s0: S[0].s0, s1: S[2].s1, prof: LAYOUT.grand },
    { name: 'S', kind: 'end', s0: S[3].s0, s1: S[3].s1, prof: LAYOUT.end },
    { name: 'W', kind: 'grand', s0: S[4].s0, s1: S[6].s1, prof: LAYOUT.grand },
    { name: 'N', kind: 'end', s0: S[7].s0, s1: S[7].s1, prof: LAYOUT.end },
  ];
})();

export function blockAt(s) {
  s = ((s % BASE.length) + BASE.length) % BASE.length;
  for (const b of BLOCKS) if (s >= b.s0 - 1e-6 && s <= b.s1 + 1e-6) return b;
  return BLOCKS[0];
}

/** Höhe der Tribünenoberfläche (Sitzreihen-Boden) eines Profils im Abstand d von der Mauerinnenkante. */
export function standFloorY(prof, d) {
  const L = LAYOUT;
  if (d < L.wallThick) return prof.wallH;
  if (d >= prof.depthC) return L.concourseY;
  const k = Math.floor((d - L.wallThick) / L.rowDepth);
  return prof.floor0 + k * prof.rise;
}

/** Sonnenrichtung (Boden → Sonne) aus Azimut (von -z Richtung -x, Grad) und Elevation (Grad). */
export function sunDirection(azDeg, elDeg) {
  const a = azDeg * Math.PI / 180, e = elDeg * Math.PI / 180;
  return [-Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

export const SUN = { az: 34, el: 33 };
export const SUN_DIR = sunDirection(SUN.az, SUN.el);

/** Deterministischer Zufallsgenerator (mulberry32). */
export function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { TAU };

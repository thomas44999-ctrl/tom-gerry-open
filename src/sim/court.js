// Platzgeometrie, Linien, Netz und Belagsparameter (ITF-Maße, Rasen).
// Ursprung = Platzmitte am Boden, Netz entlang X bei z = 0, Länge entlang Z, Y nach oben.
// Alle Maße beziehen sich (wie im Regelwerk) auf die AUSSENkante der Linien; Linien gehören zum Feld.

// ---------------------------------------------------------------- Beläge
// Ballabsprung nach Cross/Brody: vertikale Stoßzahl e(vy) = e0 - eSlope*|vy| (geklemmt),
// Reibung mu (Gleiten vs. Haften), tangentiale Rückstellung ex beim Haften, Rollwiderstand.
// Kalibriert am ITF Court Pace Rating (CPR = 100(1-μ) + 150(0.81-e), Ball 30 m/s unter 16°):
// Rasen ≈ 57 (schnell, flach, rutschig), Hartplatz ≈ 39 (mittel), Sand ≈ 26 (langsam). Siehe test/sim.test.mjs.
export const SURFACES = {
  grass: {
    name: 'grass',
    e0: 0.764, eSlope: 0.0065, eMin: 0.56, eMax: 0.78,  // e ≈ 0.72 bei 7 m/s (ITF-Falltest), ≈ 0.71 im CPR-Test
    mu: 0.57,            // niedrige Reibung: Ball rutscht ("skiddy")
    ex: 0.04,            // Tangential-Restitution im Haftfall
    rollDecel: 1.9,      // m/s² Rollwiderstand (Rasen bremst stark)
    spinKeepY: 0.85,     // Erhalt des Seitwärtsdralls (vertikale Achse) beim Aufsprung
    color: [0.24, 0.47, 0.16],
  },
  hard: {
    name: 'hard', e0: 0.84, eSlope: 0.0058, eMin: 0.62, eMax: 0.86,
    mu: 0.64, ex: 0.08, rollDecel: 0.7, spinKeepY: 0.8, color: [0.16, 0.33, 0.55],
  },
  clay: {
    name: 'clay', e0: 0.85, eSlope: 0.0052, eMin: 0.64, eMax: 0.87,
    mu: 0.80, ex: 0.10, rollDecel: 1.3, spinKeepY: 0.75, color: [0.72, 0.36, 0.2],
  },
};

// ---------------------------------------------------------------- Platzmaße
export const COURT = {
  length: 23.77,
  halfLength: 11.885,            // Grundlinie bei z = ±11.885
  width: 8.23,
  singlesHalfWidth: 4.115,       // Einzel-Seitenlinie x = ±4.115
  doublesHalfWidth: 5.485,       // Doppel-Seitenlinie x = ±5.485
  serviceLineZ: 6.40,            // Aufschlaglinie z = ±6.40
  lineWidth: 0.05,               // alle Linien 5 cm …
  baselineWidth: 0.10,           // … Grundlinie 10 cm
  centreLineHalfWidth: 0.025,    // Mittellinie liegt symmetrisch um x = 0
  centreMarkLength: 0.10,        // Mittelzeichen: 10 cm nach innen an der Grundlinie
  centreMarkWidth: 0.05,
  // Auslauf (Centre-Court-Maße): hinter der Grundlinie 6.40 m, seitlich der Doppellinie 3.66 m
  runoffBack: 6.40,
  runoffSide: 3.66,
  // Netz
  net: {
    centreHeight: 0.914,
    stickHeight: 1.07,           // Einzelstützen
    stickX: 5.029,
    postHeight: 1.07,            // Netzpfosten
    postX: 6.40,
    stickRadius: 0.0375,         // 7.5 cm Querschnitt
    postRadius: 0.05,
    tapeWidth: 0.0635,           // Netzband (sichtbare Höhe je Seite)
    strapWidth: 0.05,            // Mittelband
  },
  // Abdruck des Balls am Boden (Radius der Kontaktfläche). Linie berührt = "in".
  ballFootprint: 0.02,
  surface: SURFACES.grass,
};

const N = COURT.net;
const SAG = N.stickHeight - N.centreHeight;
const INV_STICK2 = 1 / (N.stickX * N.stickX);

/** Netzhöhe (Oberkante Netzband) an der Stelle x. 0 außerhalb der Pfosten. */
export function netHeightAt(x) {
  const ax = x < 0 ? -x : x;
  if (ax <= N.stickX) return N.centreHeight + SAG * ax * ax * INV_STICK2;
  if (ax <= N.postX) return N.stickHeight;
  return 0;
}

/** Ableitung dh/dx der Netzhöhe (für Netzband-Normalen). */
export function netSlopeAt(x) {
  const ax = x < 0 ? -x : x;
  if (ax > N.stickX) return 0;
  return 2 * SAG * x * INV_STICK2;
}

/** Hälfte des Platzes: +1 für z >= 0, -1 sonst (Seite +1 = Hälfte mit z > 0). */
export const courtHalf = (z) => (z >= 0 ? 1 : -1);

/** Abdruckradius in Abhängigkeit der vertikalen Aufprallgeschwindigkeit (Ball wird stärker gestaucht). */
export function footprintRadius(vyIn) {
  const v = Math.abs(vyIn || 0);
  const r = 0.011 + 0.0012 * v;
  return r < 0.011 ? 0.011 : r > 0.028 ? 0.028 : r;
}

/** Ist der Aufsprungpunkt im Einzelfeld? Linie berührt = gut. margin = Abdruckradius. */
export function isInSingles(x, z, margin = COURT.ballFootprint) {
  return Math.abs(x) - margin <= COURT.singlesHalfWidth && Math.abs(z) - margin <= COURT.halfLength;
}

/**
 * Ist der Aufsprung im korrekten Aufschlagfeld?
 * serverSide: Seite des Aufschlägers (+1: z > 0, -1: z < 0). box: 'deuce' | 'ad' aus Sicht des Aufschlägers.
 * Deuce-Feld = rechts vom jeweiligen Spieler. Der Aufschlag geht diagonal ins gegenüberliegende Feld.
 */
export function inServiceBox(x, z, serverSide, box, margin = COURT.ballFootprint) {
  const zr = -z * serverSide;                               // Tiefe auf der Rückschläger-Seite (> 0)
  const xr = box === 'deuce' ? -x * serverSide : x * serverSide; // > 0 = innerhalb der Feldhälfte
  return zr > -margin && zr - margin <= COURT.serviceLineZ &&
    xr + margin >= -COURT.centreLineHalfWidth && xr - margin <= COURT.singlesHalfWidth;
}

/** Rechteck des Ziel-Aufschlagfeldes in Weltkoordinaten (Linienaußenkanten). */
export function serviceBoxRect(serverSide, box, out = {}) {
  const zs = -serverSide;
  const xs = box === 'deuce' ? -serverSide : serverSide;
  const z0 = 0, z1 = zs * COURT.serviceLineZ;
  const x0 = -xs * COURT.centreLineHalfWidth, x1 = xs * COURT.singlesHalfWidth;
  out.xMin = Math.min(x0, x1); out.xMax = Math.max(x0, x1);
  out.zMin = Math.min(z0, z1); out.zMax = Math.max(z0, z1);
  out.cx = (out.xMin + out.xMax) / 2; out.cz = (out.zMin + out.zMax) / 2;
  return out;
}

/** Typische Position des Aufschlägers (hinter der Grundlinie, neben dem Mittelzeichen). */
export function serverPosition(serverSide, box, out = [0, 0, 0], lateral = 0.75, behind = 0.25) {
  const xs = box === 'deuce' ? serverSide : -serverSide;   // Deuce: rechts vom Mittelzeichen aus Spielersicht
  out[0] = xs * lateral; out[1] = 0; out[2] = serverSide * (COURT.halfLength + behind);
  return out;
}

/** Typische Position des Rückschlägers. */
export function receiverPosition(serverSide, box, out = [0, 0, 0], lateral = 2.6, behind = 0.9) {
  const rs = -serverSide;
  const xs = box === 'deuce' ? rs : -rs;                   // rechts aus Sicht des Rückschlägers
  out[0] = xs * lateral; out[1] = 0; out[2] = rs * (COURT.halfLength + behind);
  return out;
}

/**
 * Wie weit ist ein Ball im Aus? (Rallye, Einzelfeld). Werte in Metern von der Abdruckkante zur Linienaußenkante.
 * { in, long, wide, distance }  long/wide = 0 wenn nicht in dieser Richtung aus.
 */
export function describeMiss(x, z, margin = COURT.ballFootprint, out = {}) {
  const long = Math.max(0, Math.abs(z) - margin - COURT.halfLength);
  const wide = Math.max(0, Math.abs(x) - margin - COURT.singlesHalfWidth);
  out.in = long === 0 && wide === 0;
  out.long = long; out.wide = wide;
  out.distance = Math.hypot(long, wide);
  return out;
}

/** Wie describeMiss, aber für Aufschläge: long = hinter der Aufschlaglinie, wide = neben der Seitenlinie,
 *  centre = falsche Seite der Mittellinie, net = Ball auf eigener Seite. */
export function describeServeMiss(x, z, serverSide, box, margin = COURT.ballFootprint, out = {}) {
  const zr = -z * serverSide;
  const xr = box === 'deuce' ? -x * serverSide : x * serverSide;
  out.long = Math.max(0, zr - margin - COURT.serviceLineZ);
  out.wide = Math.max(0, xr - margin - COURT.singlesHalfWidth);
  out.centre = Math.max(0, -(xr + margin) - COURT.centreLineHalfWidth);
  out.net = zr <= -margin;
  out.in = !out.net && out.long === 0 && out.wide === 0 && out.centre === 0;
  out.distance = Math.hypot(out.long, Math.max(out.wide, out.centre));
  return out;
}

/**
 * Hawk-Eye: vorzeichenbehafteter Abstand der Abdruckkante zur relevanten Linie.
 * dist >= 0: Ball berührt die Linie / ist drin (Überlappung in m), dist < 0: aus um |dist| m.
 * opts: { serverSide, box } für Aufschläge (sonst Einzelfeld), margin (Abdruckradius).
 * Liefert { in, dist, line: 'baseline'|'sideline'|'service'|'centre', lineX, lineZ, axis: 'x'|'z' } —
 * lineX/lineZ = Koordinate der Linienaußenkante am nächsten Punkt (für Kamera/Visualisierung).
 */
export function lineDistance(x, z, opts = {}, out = {}) {
  const margin = opts.margin ?? COURT.ballFootprint;
  if (opts.serverSide) {
    const s = opts.serverSide, box = opts.box || 'deuce';
    const zr = -z * s;
    const xs = box === 'deuce' ? -s : s;
    const xr = x * xs;
    const mService = COURT.serviceLineZ - (zr - margin);
    const mSide = COURT.singlesHalfWidth - (xr - margin);
    const mCentre = (xr + margin) + COURT.centreLineHalfWidth;
    let dist = mService, line = 'service';
    if (mSide < dist) { dist = mSide; line = 'sideline'; }
    if (mCentre < dist) { dist = mCentre; line = 'centre'; }
    out.dist = dist; out.line = line; out.in = dist >= 0 && zr > -margin;
    if (line === 'service') { out.axis = 'z'; out.lineZ = -s * COURT.serviceLineZ; out.lineX = x; }
    else if (line === 'sideline') { out.axis = 'x'; out.lineX = xs * COURT.singlesHalfWidth; out.lineZ = z; }
    else { out.axis = 'x'; out.lineX = -xs * COURT.centreLineHalfWidth; out.lineZ = z; }
    return out;
  }
  const mBase = COURT.halfLength - (Math.abs(z) - margin);
  const mSide = COURT.singlesHalfWidth - (Math.abs(x) - margin);
  if (mBase < mSide) {
    out.dist = mBase; out.line = 'baseline'; out.axis = 'z';
    out.lineZ = (z >= 0 ? 1 : -1) * COURT.halfLength; out.lineX = x;
  } else {
    out.dist = mSide; out.line = 'sideline'; out.axis = 'x';
    out.lineX = (x >= 0 ? 1 : -1) * COURT.singlesHalfWidth; out.lineZ = z;
  }
  out.in = out.dist >= 0;
  return out;
}

/** Liegt die Position eines Spielers/Balls innerhalb der Spielfläche inkl. Auslauf? */
export function inPlayArea(x, z, pad = 0) {
  return Math.abs(x) <= COURT.doublesHalfWidth + COURT.runoffSide + pad &&
    Math.abs(z) <= COURT.halfLength + COURT.runoffBack + pad;
}

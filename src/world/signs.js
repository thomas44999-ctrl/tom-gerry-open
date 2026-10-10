// Canvas-Grafiken: Banden-/Mauer-Atlas ("TOM & GERRY OPEN", "CENTRE COURT", "FINALE", Katzen-Ball-Logo).
// Keine Sponsoren. Farben in sRGB (Canvas), Texturen werden mit srgb:true hochgeladen.
import { LAYOUT, BASE } from './layout.js';

export const INK = {
  green: '#143f2c', greenDeep: '#0e3022', cream: '#f1e9d2', gold: '#cfa64f', goldDeep: '#a07c31',
  optic: '#d9ec3f', purple: '#4b2a5e', white: '#f7f5ef',
};

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Stilisiertes Logo: Katzenkopf-Silhouette + Tennisball im goldgerahmten grünen Medaillon. */
export function drawLogo(g, cx, cy, r, opts = {}) {
  g.save();
  g.translate(cx, cy);
  // Medaillon
  g.fillStyle = opts.bg || INK.greenDeep;
  g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
  g.lineWidth = r * 0.07; g.strokeStyle = INK.gold;
  g.beginPath(); g.arc(0, 0, r * 0.93, 0, Math.PI * 2); g.stroke();
  g.lineWidth = r * 0.02;
  g.beginPath(); g.arc(0, 0, r * 0.82, 0, Math.PI * 2); g.stroke();
  // Katzenkopf (Creme) mit Ohren
  const k = r * 0.42;
  g.fillStyle = INK.cream;
  g.beginPath();
  g.moveTo(-k * 0.95, -k * 0.15);
  g.lineTo(-k * 0.85, -k * 1.15); g.lineTo(-k * 0.35, -k * 0.72);
  g.quadraticCurveTo(0, -k * 0.84, k * 0.35, -k * 0.72);
  g.lineTo(k * 0.85, -k * 1.15); g.lineTo(k * 0.95, -k * 0.15);
  g.bezierCurveTo(k * 1.05, k * 0.65, k * 0.45, k * 0.95, 0, k * 0.95);
  g.bezierCurveTo(-k * 0.45, k * 0.95, -k * 1.05, k * 0.65, -k * 0.95, -k * 0.15);
  g.closePath(); g.fill();
  // Gesicht (dunkel)
  g.fillStyle = INK.greenDeep;
  for (const sx of [-1, 1]) {
    g.beginPath(); g.ellipse(sx * k * 0.38, k * 0.05, k * 0.13, k * 0.2, sx * 0.25, 0, Math.PI * 2); g.fill();
  }
  g.beginPath(); g.moveTo(-k * 0.1, k * 0.38); g.lineTo(k * 0.1, k * 0.38); g.lineTo(0, k * 0.5); g.closePath(); g.fill();
  g.strokeStyle = INK.greenDeep; g.lineWidth = k * 0.05; g.lineCap = 'round';
  for (const sx of [-1, 1]) for (const dy of [-0.06, 0.1]) {
    g.beginPath(); g.moveTo(sx * k * 0.3, k * (0.55 + dy)); g.lineTo(sx * k * 1.05, k * (0.45 + dy * 2.2)); g.stroke();
  }
  // Tennisball unten rechts
  const br = r * 0.24, bx = r * 0.44, by = r * 0.42;
  g.fillStyle = INK.optic;
  g.beginPath(); g.arc(bx, by, br, 0, Math.PI * 2); g.fill();
  g.strokeStyle = INK.white; g.lineWidth = br * 0.12;
  g.beginPath(); g.arc(bx - br * 1.05, by, br * 0.8, -0.85, 0.85); g.stroke();
  g.beginPath(); g.arc(bx + br * 1.05, by, br * 0.8, Math.PI - 0.85, Math.PI + 0.85); g.stroke();
  g.restore();
}

function spaced(g, text, x, y, spacing) {
  g.letterSpacing = `${spacing}px`;
  g.fillText(text, x + spacing * 0.5, y);
  g.letterSpacing = '0px';
}

function laurel(g, x, y, s, dir) {
  g.save(); g.translate(x, y); g.scale(dir, 1);
  g.strokeStyle = INK.gold; g.fillStyle = INK.gold; g.lineWidth = s * 0.06;
  g.beginPath(); g.arc(s * 1.1, 0, s * 1.1, Math.PI * 0.72, Math.PI * 1.28); g.stroke();
  for (let i = 0; i < 5; i++) {
    const a = Math.PI * (0.76 + i * 0.12);
    const px = s * 1.1 + Math.cos(a) * s * 1.1, py = Math.sin(a) * s * 1.1;
    g.beginPath(); g.ellipse(px - s * 0.12, py, s * 0.22, s * 0.09, a + 1.2, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

/**
 * Mauer-Atlas (4096 x 1024). Liefert Canvas + Regionen in Pixeln:
 *   sideE/sideW: ganze Längsseiten-Gerade (Länge x Mauerhöhe), endN/endS: Stirnmauer-Gerade.
 */
export function buildWallAtlas() {
  const W = 4096, H = 1024;
  const cv = makeCanvas(W, H);
  const g = cv.getContext('2d');
  g.fillStyle = INK.green; g.fillRect(0, 0, W, H);
  const sideLen = BASE.segs[1].len, endLen = BASE.segs[3].len;
  const gh = LAYOUT.grand.wallH, eh = LAYOUT.end.wallH;
  const ppmS = 120, ppmE = 156;
  const regions = {
    sideE: { x: 0, y: 0, w: Math.round(sideLen * ppmS), h: Math.round(gh * ppmS) },
    sideW: { x: 0, y: 170, w: Math.round(sideLen * ppmS), h: Math.round(gh * ppmS) },
    endN: { x: 0, y: 340, w: Math.round(endLen * ppmE), h: Math.round(eh * ppmE) },
    endS: { x: 2048, y: 340, w: Math.round(endLen * ppmE), h: Math.round(eh * ppmE) },
  };
  // --- Längsseiten
  const sideBoard = (R, west) => {
    g.save(); g.translate(R.x, R.y);
    const ppm = R.w / sideLen, h = R.h;
    g.fillStyle = INK.green; g.fillRect(0, 0, R.w, h);
    // feine Goldlinie oben/unten
    g.fillStyle = INK.goldDeep; g.fillRect(0, h * 0.06, R.w, Math.max(2, h * 0.012)); g.fillRect(0, h * 0.92, R.w, Math.max(2, h * 0.012));
    const items = west
      ? [['logo', 2.2], ['CENTRE COURT', 7.2], ['logo', 11.8], ['TOM & GERRY OPEN', 15.29], ['logo', 18.8], ['FINALE', 23.0], ['logo', 28.4]]
      : [['logo', 2.2], ['FINALE', 7.0], ['logo', 11.8], ['TOM & GERRY OPEN', 15.29], ['logo', 18.8], ['CENTRE COURT', 23.4], ['logo', 28.4]];
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const [it, m] of items) {
      const x = m * ppm;
      if (it === 'logo') { drawLogo(g, x, h * 0.5, h * 0.36); continue; }
      g.fillStyle = INK.cream;
      g.font = `600 ${Math.round(h * 0.40)}px Georgia, 'Times New Roman', serif`;
      spaced(g, it, x, h * 0.53, h * 0.07);
      if (it === 'FINALE') { laurel(g, x - h * 1.95, h * 0.52, h * 0.32, 1); laurel(g, x + h * 1.95, h * 0.52, h * 0.32, -1); }
    }
    g.restore();
  };
  sideBoard(regions.sideE, false);
  sideBoard(regions.sideW, true);
  // --- Stirnmauern: große Schrift oben, Untertitel, Logos
  const endBoard = (R, south) => {
    g.save(); g.translate(R.x, R.y);
    const w = R.w, h = R.h;
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, '#16442f'); grd.addColorStop(1, INK.green);
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    g.fillStyle = INK.goldDeep; g.fillRect(0, h * 0.035, w, 3);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = INK.cream;
    g.font = `600 ${Math.round(h * 0.2)}px Georgia, 'Times New Roman', serif`;
    spaced(g, 'TOM & GERRY OPEN', w * 0.5, h * 0.25, h * 0.03);
    g.fillStyle = INK.gold;
    g.fillRect(w * 0.3, h * 0.385, w * 0.4, 3);
    g.font = `italic ${Math.round(h * 0.085)}px Georgia, 'Times New Roman', serif`;
    spaced(g, south ? 'Centre Court  ·  Finale' : 'The Championship  ·  Grass', w * 0.5, h * 0.46, h * 0.012);
    drawLogo(g, w * 0.09, h * 0.3, h * 0.2);
    drawLogo(g, w * 0.91, h * 0.3, h * 0.2);
    g.restore();
  };
  endBoard(regions.endN, false);
  endBoard(regions.endS, true);
  for (const k in regions) { const R = regions[k]; R.u0 = R.x / W; R.u1 = (R.x + R.w) / W; R.v0 = R.y / H; R.v1 = (R.y + R.h) / H; }
  return { canvas: cv, regions };
}

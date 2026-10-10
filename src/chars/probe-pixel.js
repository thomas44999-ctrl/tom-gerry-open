// Figuren-Probe, Variante A: die Pixelfiguren aus Tom & Gerry Flutlicht als Billboards im Stadion.
// Jede Figur ist ein senkrechtes Rechteck, das sich nur um die Hochachse zur Kamera dreht (zylindrisches
// Billboard). Pixel bleiben scharf (Nearest), Farben unbeleuchtet wie im Original; im Stadionschatten
// wird die Figur abgedunkelt, unter den Füßen liegt ein weicher Kontaktschatten.
// Grenze der Quelle: Tom gibt es nur von hinten, Gerry nur von vorn (je eine Ansicht pro Pose).
//
//   const sheets = await loadPixelSheets(renderer);
//   const fig = new PixelFigure(renderer, sheets.tom, 'tom');
//   fig.position, fig.setPose('vorhand', 2) | fig.play('laufen'); fig.update(dt, camera); fig.drawables
import { mat4 } from '../core/math.js';
import { PROBE_SPRITES, PROBE_SPRITE_ANIMS, PROBE_SPRITE_FRAME } from './probe-sprites.js';

/** Meter je Sprite-Pixel: Tom (37 px vom Scheitel bis zum Boden) wird ~1,48 m groß, Gerry (31 px) ~1,24 m. */
export const PIXEL_M = 0.04;

const SPRITE_SURFACE = `
void surface(in SurfaceInput i, inout Surface s) {
  vec2 px = u_frame.xy + min(floor(i.uv * u_frame.zw), u_frame.zw - 1.0) + 0.5;
  vec4 t = texture(u_sheet, px / u_sheetSize);
  s.alpha = t.a;
  float sh = 1.0;
#ifndef SHADOW_PASS
  sh = tg_sunShadow(i.worldPos, u_sunDir, 1.0);
#endif
  s.albedo = t.rgb * u_gain * mix(u_shadowDim, 1.0, sh);
}`;

const BLOB_SURFACE = `
void surface(in SurfaceInput i, inout Surface s) {
  vec2 d = (i.uv - 0.5) * 2.0;
  s.albedo = vec3(0.0);
  s.alpha = u_blobA * (1.0 - smoothstep(0.25, 1.0, length(d)));
}`;

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('Sprite-Bild ließ sich nicht dekodieren'));
    im.src = src;
  });
}

/** Spritesheets dekodieren und als Texturen anlegen (sRGB, Nearest, ohne Mipmaps). */
export async function loadPixelSheets(r) {
  const out = {};
  for (const id of Object.keys(PROBE_SPRITES)) {
    const img = await loadImage(PROBE_SPRITES[id].src);
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    out[id] = {
      tex: r.createTexture(c, { filter: 'nearest', wrap: 'clamp', mipmaps: false, srgb: true }),
      w: img.width, h: img.height, view: PROBE_SPRITES[id].view,
    };
  }
  return out;
}

let _shared = null;
function shared(r) {
  if (_shared && _shared.r === r) return _shared;
  const F = PROBE_SPRITE_FRAME, m = PIXEL_M;
  // Rechteck in XY (Normale +Z), Ursprung = Anker (Füße), v = 0 oben wie die Bildzeilen
  const x0 = -F.anchorX * m, x1 = (F.w - F.anchorX) * m, y0 = -(F.h - F.anchorY) * m, y1 = F.anchorY * m;
  const quad = {
    positions: new Float32Array([x0, y1, 0, x1, y1, 0, x0, y0, 0, x1, y0, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    indices: new Uint16Array([0, 2, 1, 1, 2, 3]),
  };
  const blob = {
    positions: new Float32Array([-0.5, 0, -0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, 0.5]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    indices: new Uint16Array([0, 2, 1, 1, 2, 3]),
  };
  _shared = {
    r,
    quad: r.createMesh(quad),
    blob: r.createMesh(blob),
    blobMat: r.createMaterial({
      name: 'probe-pixel-blob', unlit: true, blend: 'alpha', depthWrite: false, castShadow: false,
      uniforms: { u_blobA: 0.42 }, surface: BLOB_SURFACE,
    }),
  };
  return _shared;
}

export class PixelFigure {
  constructor(r, sheet, id) {
    const S = shared(r);
    this.id = id;
    this.sheet = sheet;
    this.view = sheet.view;
    this.position = new Float32Array(3);
    this.yaw = 0;                       // wird ignoriert: das Bild zeigt immer dieselbe Seite
    this.model = mat4.create();
    this.blobM = mat4.create();
    this.frameU = new Float32Array([0, 0, PROBE_SPRITE_FRAME.w, PROBE_SPRITE_FRAME.h]);
    this.material = r.createMaterial({
      name: 'probe-pixel-' + id, unlit: true, alphaTest: 0.5, cull: 'none', castShadow: false,
      uniforms: { u_sheet: sheet.tex, u_sheetSize: [sheet.w, sheet.h], u_frame: this.frameU, u_gain: 1.0, u_shadowDim: 0.55 },
      surface: SPRITE_SURFACE,
    });
    const H = PROBE_SPRITE_FRAME.h * PIXEL_M;
    this.drawables = [
      { mesh: S.blob, material: S.blobMat, model: this.blobM, pass: 'transparent', order: -2, castShadow: false, receiveShadow: false, bounds: { center: [0, 0, 0], radius: 0.8 } },
      { mesh: S.quad, material: this.material, model: this.model, castShadow: false, bounds: { center: [0, H * 0.45, 0], radius: H * 0.75 } },
    ];
    this.anim = 'bereit'; this.frame = 0; this.time = 0; this.playing = false;
    this.setPose('bereit', 0);
  }

  /** Feste Pose: Animation + Frame-Index (gehaltenes Einzelbild). */
  setPose(anim, frame = 0) {
    const A = PROBE_SPRITE_ANIMS[anim] || PROBE_SPRITE_ANIMS.bereit;
    this.anim = anim; this.frame = Math.min(frame, A.frames - 1); this.playing = false;
    this._applyFrame();
  }

  /** Animation abspielen (Schleife; Schläge und Aufschlag halten das letzte Bild). */
  play(anim) { this.anim = anim; this.time = 0; this.frame = 0; this.playing = true; this._applyFrame(); }

  _applyFrame() {
    const A = PROBE_SPRITE_ANIMS[this.anim] || PROBE_SPRITE_ANIMS.bereit;
    this.frameU[0] = this.frame * PROBE_SPRITE_FRAME.w;
    this.frameU[1] = A.reihe * PROBE_SPRITE_FRAME.h;
  }

  /** Bild weiterschalten und zur Kamera drehen. */
  update(dt, camera) {
    if (this.playing) {
      const A = PROBE_SPRITE_ANIMS[this.anim];
      this.time += dt;
      const n = Math.floor(this.time * A.fps);
      const loop = A.treffer === undefined;
      this.frame = loop ? n % A.frames : Math.min(n, A.frames - 1);
      this._applyFrame();
    }
    const p = this.position;
    const a = camera ? Math.atan2(camera.position[0] - p[0], camera.position[2] - p[2]) : 0;
    mat4.fromYawTranslation(this.model, a, p);
    mat4.fromYawTranslation(this.blobM, 0, [p[0], p[1] + 0.012, p[2]], 1);
    mat4.scale(this.blobM, this.blobM, [0.95, 1, 0.6]);
  }
}

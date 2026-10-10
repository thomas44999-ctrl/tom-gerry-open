// World-Einstieg (ARCHITECTURE §9): baut Platz, Netz, Stadion, Publikum, Requisiten, Anzeigetafeln,
// Ball-Visualisierung und Partikel; liefert Szene-Einstellungen (Licht, Himmel, Nebel, Post) und Kamera-Anker.
import { nextFrame } from '../core/util.js';
import { LAYOUT, SUN_DIR } from './layout.js';
import { buildCourt } from './court.js';
import { buildStadium } from './stadium.js';
import { buildCrowd } from './crowd.js';
import { buildNet } from './net.js';
import { buildProps } from './props.js';
import { buildScoreboards } from './scoreboard.js';
import { buildBallFx } from './ballfx.js';
import { buildParticles } from './particles.js';
import { buildSurroundings } from './surroundings.js';

/** Golden-Hour-Licht für das Centre-Court-Finale. */
export function createSceneSettings() {
  return {
    sun: { dir: SUN_DIR.slice(), color: [1.0, 0.76, 0.5], intensity: 5.4 },
    hemi: { sky: [0.33, 0.45, 0.72], ground: [0.16, 0.15, 0.1], intensity: 0.88 },
    sky: {
      zenith: [0.045, 0.13, 0.42], horizon: [0.7, 0.66, 0.64], ground: [0.22, 0.21, 0.18],
      horizonExponent: 4.0, sunGlow: [1.0, 0.55, 0.25], sunGlowStrength: 1.3, aureole: 0.18,
      sunSize: 0.7, sunIntensity: 8.0, brightness: 1.0,
      clouds: {
        coverage: 0.36, density: 1.4, scale: 1.0, softness: 0.12,
        color: [1.0, 0.92, 0.82], shade: [0.40, 0.40, 0.50], brightness: 1.1, silver: 1.2, opacity: 0.92,
        curvature: 0.12, wind: [0.003, 0.001],
      },
    },
    fog: { color: [0.68, 0.63, 0.58], density: 0.0012, heightFalloff: 0.03, sunScatter: 0.9 },
    shadow: {
      center: [0, 0, 0], radius: 17, extend: 50,
      wideCenter: [0, 0, 0], wideRadius: 52, wideExtend: 40, strength: 1.0,
    },
    exposure: 1.0,
    post: {
      bloom: 0.4, bloomThreshold: 1.15, vignette: 0.24, saturation: 1.06, contrast: 1.1, grain: 0.02,
      temperature: 0.085, lift: [0.004, 0.005, 0.012], gain: [1.04, 1.0, 0.93],
    },
  };
}

/** Benannte Kamera-Positionen/-Ziele für Kinematiken (Positionen in m, fov vertikal in rad). */
export function createAnchors() {
  const L = LAYOUT;
  const a = (position, target, fov = 0.75) => ({ position, target, fov });
  return {
    broadcastS: a([0, 8.6, 21.6], [0, 0.0, -1.6], 0.72),
    broadcastN: a([0, 8.6, -21.6], [0, 0.0, 1.6], 0.72),
    behindBaselineS: a([0, 2.4, 17.6], [0, 1.0, 0], 0.62),
    behindBaselineN: a([0, 2.4, -17.6], [0, 1.0, 0], 0.62),
    umpire: a([-9.0, 4.05, 1.45], [1.0, 0.2, -2.6], 0.8),
    umpirePOV: a([-6.95, 3.02, 0.0], [2.0, 0.6, -3.0], 0.9),
    umpireChair: a([-3.5, 2.2, 5.5], [-7.4, 2.2, 0], 0.7),
    courtside: a([-L.wallX + 0.8, 1.15, 6.2], [0, 1.0, -4.5], 0.8),
    courtsideE: a([L.wallX - 0.8, 1.15, -6.2], [0, 1.0, 4.5], 0.8),
    netCam: a([6.75, 0.55, 0.35], [-4, 0.75, -0.2], 0.8),
    netPost: a([6.9, 1.4, 1.6], [0, 0.9, -1.0], 0.85),
    crowdNorth: a([0, 2.6, -6], [0, 6.5, -26], 0.8),
    crowdSouth: a([0, 2.6, 6], [0, 6.5, 26], 0.8),
    crowdEast: a([-2, 2.4, 0], [20, 6.0, 0], 0.8),
    crowdWest: a([2, 2.4, 0], [-20, 6.0, 0], 0.8),
    royalBox: a([0, 4.5, 6.0], [0, 4.5, 21.5], 0.55),
    scoreboard: a([0, 6, 0], [20, 12, -27], 0.5),
    highCorner: a([-14.5, 14.2, -24.5], [1.5, 0, 2.5], 0.78),
    highCornerS: a([14.5, 14.2, 24.5], [-1.5, 0, -2.5], 0.78),
    roofCorner: a([-5, 52, -66], [0, 0, 1], 0.62),
    aerial: a([58, 78, 26], [0, 0, 0], 0.7),
    topDown: a([0, 95, 0.01], [0, 0, 0], 0.6),
    // Titel-Überflug: Stützpunkte (position/target), z.B. per Catmull-Rom abfahren
    flyover: [
      a([-120, 60, -150], [0, 8, 0]), a([-60, 45, -80], [0, 4, 0]), a([-10, 30, -45], [0, 2, 0]),
      a([13, 15, -22], [0, 1, 0]), a([14, 10, 0], [0, 1, 0]), a([0, 8.6, 21.6], [0, 0.0, -1.6]),
    ],
  };
}

/**
 * Welt aufbauen. Gibt World gemäß ARCHITECTURE §9 zurück.
 * @param {Renderer} renderer
 * @param {{ onProgress?: (p:number, label?:string) => void }} opts
 */
export async function buildWorld(renderer, { onProgress } = {}) {
  const r = renderer, q = r.q;
  const prog = (p, label) => { if (onProgress) onProgress(Math.min(1, p), label); };
  const world = {
    drawables: [],
    sceneSettings: createSceneSettings(),
    anchors: createAnchors(),
    layout: LAYOUT,
    excitement: 0,
    autoReact: true,
  };
  prog(0.02, 'Rasen');
  const court = buildCourt(r, q);
  world.court = court;
  world.drawables.push(...court.drawables);
  await nextFrame();
  prog(0.1, 'Stadion');
  const stadium = buildStadium(r, q);
  world.stadium = stadium;
  world.drawables.push(...stadium.drawables);
  await nextFrame();
  prog(0.3, 'Netz');
  const net = buildNet(r, q, { structMaterial: stadium.structMaterial });
  world.net = net;
  world.drawables.push(...net.drawables);
  prog(0.32, 'Requisiten');
  const props = buildProps(r, q, { structMaterial: stadium.structMaterial });
  world.props = props;
  world.umpire = props.umpire;
  world.drawables.push(...props.drawables);
  await nextFrame();
  prog(0.35, 'Publikum');
  const crowd = buildCrowd(r, q, stadium.seats);
  world.crowd = crowd;
  world.drawables.push(...crowd.drawables);
  await nextFrame();
  prog(0.6, 'Anzeigetafeln');
  const scoreboard = buildScoreboards(r, q, { structMaterial: stadium.structMaterial });
  world.scoreboard = scoreboard;
  world.drawables.push(...scoreboard.drawables);
  world.anchors.scoreboard.target = scoreboard.boards[0].pos.slice();
  world.anchors.scoreboardSW = { position: [0, 6, 0], target: scoreboard.boards[1].pos.slice(), fov: 0.5 };
  prog(0.65, 'Ball');
  const bfx = buildBallFx(r, q);
  world.ball = bfx.ball;          // eigene Drawables (world.ball.drawables), nicht in world.drawables
  world.marks = bfx.marks;
  world.drawables.push(...bfx.marks.drawables);
  const fx = buildParticles(r, q);
  world.fx = fx;
  world.drawables.push(...fx.drawables);
  await nextFrame();
  prog(0.7, 'Umgebung');
  const sur = buildSurroundings(r, q);
  world.surroundings = sur;
  world.drawables.push(...sur.drawables);
  await nextFrame();

  const lastBall = [0, 1, 0], ballVel = [0, 0, 0];
  let haveBall = false;
  world.update = (dt, ctx = {}) => {
    const t0 = performance.now();
    world.excitement = ctx.excitement ?? world.excitement;
    // Ballgeschwindigkeit schätzen (für Abdruck-/Partikelrichtung)
    if (ctx.ballPos && dt > 0) {
      const b = ctx.ballPos;
      if (haveBall) for (let k = 0; k < 3; k++) ballVel[k] = ballVel[k] * 0.5 + ((b[k] - lastBall[k]) / dt) * 0.5;
      lastBall[0] = b[0]; lastBall[1] = b[1]; lastBall[2] = b[2]; haveBall = true;
    }
    if (ctx.events && world.autoReact) for (const e of ctx.events) world.handleEvent(e);
    const camPos = ctx.cameraPos || (ctx.camera && ctx.camera.position);
    if (camPos) crowd.setCamera(camPos, ctx.cameraTarget || (ctx.camera && ctx.camera.target));
    crowd.update(dt, ctx.ballPos || null, world.excitement);
    net.update(dt);
    if (ctx.ballPos) props.umpire.autoLook(ctx.ballPos);
    props.umpire.update(dt);
    scoreboard.update(dt);
    bfx.marks.update(dt);
    fx.update(dt);
    sur.update(dt);
    world.updateMs = (world.updateMs ?? 0) * 0.9 + (performance.now() - t0) * 0.1;
  };
  /** Spielereignis (GameEvent, siehe ARCHITECTURE §7) visuell umsetzen. */
  world.handleEvent = (e) => {
    const type = e.type || e.event;
    switch (type) {
      case 'bounce': {
        if (!e.pos || (e.index && e.index > 2)) break;
        const p = e.pos, v = e.vel || ballVel;
        const w = court.wearAt(p[0], p[2]);
        const onLine = court.lineDistance(p[0], p[2]) < 0.035;
        if (onLine) fx.emit('chalk', p, v);
        else if (w.soil > 0.4) fx.emit('dust', p, v);
        else fx.emit('grass', p, v);
        bfx.marks.add(p, v, w.soil);
        break;
      }
      case 'net': {
        if (!e.pos) break;
        const sp = e.speed ?? 15;
        net.impulse(e.pos, Math.min(0.14, 0.02 + sp * 0.0035) * (e.cord ? 0.8 : 1) * (e.post ? 0.2 : 1) * (ballVel[2] < 0 ? -1 : 1));
        fx.emit('netShake', e.pos);
        if (e.cord) crowd.react('ooh', 0.7);
        break;
      }
      case 'point': {
        const big = e.rally >= 9 || e.reason === 'ace' || e.reason === 'winner';
        if (e.reason === 'double_fault') crowd.react('ooh', 0.5);
        crowd.react(big ? 'cheer' : 'applause', Math.min(1, 0.45 + (e.rally || 0) * 0.05 + (e.closeCall ? 0.2 : 0)));
        break;
      }
      case 'line_call': if (e.closeCall) crowd.react('ooh', 0.8); break;
      case 'fault': if (e.closeCall) crowd.react('ooh', 0.4); break;
      case 'game': crowd.react('cheer', 0.7); break;
      case 'set': crowd.react('standing', 0.7); break;
      case 'match': crowd.react('standing', 1); break;
      case 'serve_speed': if (e.kmh) scoreboard.setServeSpeed(e.kmh); break;
      case 'pressure': crowd.react('quiet', 1); break;
      case 'phase': if (e.phase === 'serve') crowd.react('quiet', 1); break;
      default: break;
    }
  };
  /** Szene-Einstellungen in ein Szene-Objekt kopieren (sun/hemi/sky/fog/shadow/exposure/post). */
  world.applyTo = (scene) => {
    const s = world.sceneSettings;
    scene.sun = s.sun; scene.hemi = s.hemi; scene.sky = s.sky; scene.fog = s.fog;
    scene.shadow = s.shadow; scene.exposure = s.exposure; scene.post = s.post;
    return scene;
  };
  prog(0.9, 'Shader');
  await r.precompile([...world.drawables, ...world.ball.drawables], (p) => prog(0.9 + 0.1 * p, 'Shader'));
  prog(1, 'Fertig');
  return world;
}

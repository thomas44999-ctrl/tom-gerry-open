// Laufzeit-Figur (ARCHITECTURE §5.5): Animations-Zustandsmaschine, Fußplaner + Bein-IK, Treffpunkt-IK,
// Blick, Sekundärbewegung (Schwanz/Ohren/Atmung), Drawables inkl. Schläger und Kontaktschatten.
//
//   const c = new Character(renderer, asset, racket);      // renderer darf null sein (Node-Tests, keine Drawables)
//   c.position, c.yaw; c.setLocomotion(velWorld, ready, { split })
//   c.playStroke(type, { timeToContact, contactWorld, shot, power }); c.playServe(phase, opts); c.playEmote(name)
//   c.lookAt(pos|null); c.update(dt); c.drawables; c.events (pro update neu befüllt)
//   c.getRacketSweetSpot(out); c.getHandPos('l'|'r', out); c.heldBallPos(out); c.capturePose(); c.applyCapturedPose(a)
//
// Pipeline je Bild: Gang/Fußplaner -> Basis-Pose (Lokomotions-Zyklen) -> Aktions-Ebene (Schlag/Aufschlag/Emote)
//   -> prozedurale Zusätze (Hüftgier, Becken, Lehne, Atmung) -> Treffpunkt-Vorhersage -> Reichweitenhilfe
//   -> Becken-Anpassung an die Füße -> Bein-IK -> Arm-IK (Treffpunkt exakt) -> linke Hand (Hals/Griff/Ballwurf)
//   -> Blick -> Federketten -> FK -> Drawables.

import { createSkeleton } from './skeleton.js';
import {
  createPose, copyPose, blendPose, addPose, sampleClip, twoBoneIK, lookAt as poseLookAt, SpringChain,
  getBoneModel, boneMask, eulerToQuat, poseFromEuler, clipEvents,
} from './pose.js';
import { mat4, quat, clamp, lerp, smoothstep, wrapAngle } from '../core/math.js';
import { STROKES, SERVE, PLAYER_STATS } from '../sim/strokes.js';
import {
  FootPlanner, Gait, gaitHeel, LOCO_CLIPS, READY, RELAXED, buildAnimSet, TAIL_MOODS, EAR_MOODS, EMOTE_MOOD,
} from './animlib.js';
import { plane } from '../gfx/geometry.js';

const G = 9.81;
const DEG = Math.PI / 180;
const STROKE_TYPES = Object.keys(STROKES);

// ---------------------------------------------------------------------------- Kontaktschatten (multiply)
const SHADOW_SURFACE = `
float tgFootBlob(vec2 p, vec2 c, vec2 dir, float lift, float s) {
  vec2 d = p - c;
  float al = dot(d, dir) - 0.045 * s;
  float ac = dot(d, vec2(dir.y, -dir.x));
  float e = al * al / (0.0144 * s * s) + ac * ac / (0.0042 * s * s);
  return exp(-e * 1.1) * (1.0 - smoothstep(0.0, 0.3 * s, lift)) * 0.95;
}
void surface(in SurfaceInput i, inout Surface s) {
  vec2 p = i.worldPos.xz;
  float sc = u_shScale.x;
  float a = tgFootBlob(p, u_shFeet.xy, u_shDirs.xy, u_shLift.x, sc);
  float b = tgFootBlob(p, u_shFeet.zw, u_shDirs.zw, u_shLift.y, sc);
  vec2 c = p - u_shLift.zw;
  float body = exp(-dot(c, c) / (0.09 * sc * sc)) * 0.55 * u_shScale.y;
  float t = 1.0 - (1.0 - a) * (1.0 - b) * (1.0 - body);
  s.albedo = vec3(0.10, 0.12, 0.08);
  s.alpha = t * u_shScale.z;
}`;

// ---------------------------------------------------------------------------- Hilfen
const _q0 = new Float32Array(4), _q1 = new Float32Array(4), _q2 = new Float32Array(4), _q3 = new Float32Array(4);
const _v0 = new Float32Array(3), _v1 = new Float32Array(3), _v2 = new Float32Array(3), _v3 = new Float32Array(3);
const _m0 = new Float32Array(16), _m1 = new Float32Array(16);

function qYaw(out, a) { out[0] = 0; out[1] = Math.sin(a * 0.5); out[2] = 0; out[3] = Math.cos(a * 0.5); return out; }
function qAxis(out, ax, ay, az, a) { const s = Math.sin(a * 0.5); out[0] = ax * s; out[1] = ay * s; out[2] = az * s; out[3] = Math.cos(a * 0.5); return out; }
function rotV(o, q, x, y, z) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const uvx = qy * z - qz * y, uvy = qz * x - qx * z, uvz = qx * y - qy * x;
  const uuvx = qy * uvz - qz * uvy, uuvy = qz * uvx - qx * uvz, uuvz = qx * uvy - qy * uvx;
  o[0] = x + 2 * (qw * uvx + uuvx); o[1] = y + 2 * (qw * uvy + uuvy); o[2] = z + 2 * (qw * uvz + uuvz);
  return o;
}
/** Linker Multiplikator auf eine lokale Rotation im Posen-Array (Drehung im Elternrahmen). */
function preRot(pose, i, q) {
  const o = 4 * i, r = pose.rot;
  _q3[0] = r[o]; _q3[1] = r[o + 1]; _q3[2] = r[o + 2]; _q3[3] = r[o + 3];
  quat.multiply(_q3, q, _q3);
  r[o] = _q3[0]; r[o + 1] = _q3[1]; r[o + 2] = _q3[2]; r[o + 3] = _q3[3];
}
/** Rechter Multiplikator (Drehung im eigenen Knochenrahmen). */
function postRot(pose, i, q) {
  const o = 4 * i, r = pose.rot;
  _q3[0] = r[o]; _q3[1] = r[o + 1]; _q3[2] = r[o + 2]; _q3[3] = r[o + 3];
  quat.multiply(_q3, _q3, q);
  r[o] = _q3[0]; r[o + 1] = _q3[1]; r[o + 2] = _q3[2]; r[o + 3] = _q3[3];
}
const env = (t, a, b, c, d) => smoothstep(a, b, t) * (1 - smoothstep(c, d, t));
/** Stückweise linear in [[t, v], …]. */
function curve(k, t) {
  if (!k || !k.length) return 0;
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i][0]) { const a = k[i - 1], b = k[i]; const u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]); return a[1] + (b[1] - a[1]) * smoothstep(0, 1, u); }
  }
  return k[k.length - 1][1];
}

// ============================================================================ Character

export class Character {
  /**
   * @param {Renderer|null} renderer
   * @param {CharacterAsset} asset
   * @param {{parts, sweetSpot}} racket
   * @param {{ scale?: number }} [opts] scale = Reichweitenskalierung der Spiellogik (Standard PLAYER_STATS[id].reachScale)
   */
  constructor(renderer, asset, racket, opts = {}) {
    this.asset = asset;
    this.racket = racket;
    this.id = asset.id;
    const def = this.def = asset.skeletonDef;
    this.skel = createSkeleton(def);
    const st = PLAYER_STATS[asset.id];
    this.scale = opts.scale !== undefined ? opts.scale : (st ? st.reachScale : 1);
    const J = (n) => def.rest.subarray(3 * def.index[n], 3 * def.index[n] + 3);
    this.bodyScale = J('pelvis')[1] / 0.985;
    const S = this.bodyScale;
    this.position = new Float32Array(3);
    this.yaw = 0;
    this.model = mat4.create();
    this.time = 0;
    this.events = [];
    this.anim = buildAnimSet(asset.id, def);

    // Knochen
    const bi = this.bi = {};
    for (const n of def.names) bi[n] = def.index[n];
    this.hasTail = !!(asset.secondary && asset.secondary.tail && bi.tail_0 !== undefined);
    this.hasEars = !!(asset.secondary && asset.secondary.ears && bi.ear_l !== undefined);

    // Fußgeometrie (Ruhepose): Knöchelhöhe, Ballen-/Fersenabstand
    const fl = J('foot_l'), tl = J('toe_l');
    this.geo = {
      ankleH: fl[1], ballZ: Math.max(0.06, tl[2] - fl[2]), heelZ: 0.06 * S,
      hipW: Math.abs(J('thigh_l')[0]) * 2,
      legLen: dist3(J('thigh_l'), J('shin_l')) + dist3(J('shin_l'), J('foot_l')),
      armLen: dist3(J('arm_r'), J('forearm_r')) + dist3(J('forearm_r'), J('hand_r')),
      shoulderY: J('arm_r')[1], shoulderX: J('arm_r')[0],
    };
    // Griff
    const gs = asset.gripSocket;
    this.gripM = gs.matrix ? new Float32Array(gs.matrix) : mat4.fromTranslation(mat4.create(), gs.offset);
    this.gripRot = new Float32Array(gs.rotation || [0, 0, 0, 1]);
    this.gripOff = new Float32Array(gs.offset);
    const lg = asset.leftHandGrip || { bone: 'hand_l', offset: [-gs.offset[0], gs.offset[1], gs.offset[2]] };
    this.lgripOff = new Float32Array(lg.offset);
    const lr = lg.rotation || [this.gripRot[0], -this.gripRot[1], -this.gripRot[2], this.gripRot[3]];
    // linke Hand am Schläger: Handfläche zur Schlagfläche der Rückhand (-Z), Daumen entlang des Schafts
    this.lgripRot = quat.multiply(new Float32Array(4), new Float32Array(lr), qAxis(new Float32Array(4), 0, 1, 0, Math.PI));
    this.sweet = new Float32Array(racket && racket.sweetSpot ? racket.sweetSpot : [0, 0.47, 0]);
    // Kopfmitte relativ zum Kopfgelenk (Ruhepose) – für Kamera/UI (getHeadWorld)
    const hj = J('head'), hc = asset.headCenter || [hj[0], hj[1] + 0.12 * this.bodyScale, hj[2]];
    this.headOff = new Float32Array([hc[0] - hj[0], hc[1] - hj[1], hc[2] - hj[2]]);

    // Posen
    this.pose = createPose(def);
    this.base = createPose(def);
    this.act = createPose(def);
    this.pred = createPose(def);
    this.tmp = createPose(def);
    this.tmp2 = createPose(def);
    this.prevAct = createPose(def);
    // Bereitschaft: Figuren dürfen die Haltung anpassen (Chibi: Schläger tiefer, sonst verdeckt er das Gesicht)
    this.readyPose = poseFromEuler(def, asset.readyPose ? { ...READY, ...asset.readyPose } : READY);
    this.relaxedPose = poseFromEuler(def, asset.relaxedPose ? { ...RELAXED, ...asset.relaxedPose } : RELAXED);
    // Gang-Zyklen: gleiche Handgelenk-Korrektur wie in der lockeren Haltung (Schläger nicht vor dem Gesicht)
    const hx = asset.relaxedPose && asset.relaxedPose.hand_r ? asset.relaxedPose.hand_r[0] - RELAXED.hand_r[0] : 0;
    this.carryFix = hx ? qAxis(new Float32Array(4), 1, 0, 0, hx * DEG) : null;
    this.maskArms = boneMask(def, ['arms', 'torso']);
    this.maskUpper = boneMask(def, 'upper');
    this.maskLowerSet = new Float32Array(def.count);
    this.maskAct = new Float32Array(def.count);

    // Fortbewegung
    this.feet = new FootPlanner();
    this.gait = new Gait(this.feet, S);
    this.velIn = new Float32Array(3);
    this.vel = new Float32Array(3);
    this.acc = new Float32Array(3);
    this.ready = 0;
    this.readyIn = 0;
    this.hipLocal = 0;
    this.hipVel = 0;
    this.pelvisDrop = 0;
    this.exertion = 0;
    // Cartoon-Sekundärbewegung: Squash & Stretch (Feder um 1) und nachwippender großer Kopf (Nick-/Neige-Feder)
    this.toon = { sq: 1, sqV: 0, squash: 1, rootY: 0, vy: 0, air: false, hx: 0, hxV: 0, hz: 0, hzV: 0 };
    this._lastPos = new Float32Array(3);
    this._velT = -1;
    this._settleT = 0;
    this._fresh = true;
    this.split = null;
    this._ikRot = new Float32Array(4);
    this._ikPos = new Float32Array(3);
    this._ikW = 0;

    // Aktion (Schlag/Aufschlag/Emote) + ausblendende Vorgänger-Pose
    this.action = null;
    this.prevW = 0;
    this.serve = { phase: 'none', t: 0, period: 0.62, catchT: 0, released: false, v0: 0, spot: new Float32Array(3), release: 0, caught: false };
    this.ballInHand = false;
    this._ball = new Float32Array(3);

    // Blick/Gesicht
    this.lookTarget = new Float32Array(3);
    this.lookOn = false;
    this.lookW = 0;
    this.mood = 'neutral';
    this.moodT = 0;
    this.blink = undefined;
    this._lookDir = new Float32Array(3);

    // Sekundär
    if (this.hasTail) {
      this.tail = new SpringChain(def, asset.secondary.tail, { frequency: 2.3, damping: 0.45, gravity: 1.2, falloff: 0.9, maxAngle: 0.9 });
      this.tailMood = { happy: 0, sad: 0, tense: 0 };
    }
    if (this.hasEars) {
      this.earL = new SpringChain(def, ['ear_l'], { frequency: 6, damping: 0.3, maxAngle: 0.5 });
      this.earR = new SpringChain(def, ['ear_r'], { frequency: 6, damping: 0.3, maxAngle: 0.5 });
      this.earMood = { perk: 0, flat: 0 };
      this._twitch = { t: 2, side: 0, a: 0 };
    }

    // Weltmatrizen
    this.racketM = mat4.create();
    this.attM = (asset.attachments || []).map(() => mat4.create());
    this.drawables = [];
    this._partDrawables = [];
    if (renderer) this._buildDrawables(renderer);
    this.reset();
  }

  // -------------------------------------------------------------------------- Drawables
  _buildDrawables(r) {
    const S = this.bodyScale;
    const bounds = { center: [0, 1.1 * S, 0], radius: 2.1 * S };
    for (const p of this.asset.parts) {
      const d = { mesh: p.mesh, material: p.material, bones: this.skel.skin, model: this.model, castShadow: p.castShadow !== false, bounds };
      if (p.shells) d.shells = p.shells;
      this.drawables.push(d); this._partDrawables.push(d);
    }
    this._attDrawables = (this.asset.attachments || []).map((a, k) => {
      // Hüllkugel aus dem Mesh (Attachment-Raum). Ein fester Ursprung [0,0,0] läge bei Teilen, die im Modellraum
      // modelliert sind (Haare, Nase, Schnurrhaare), an den Füßen -> Teil wurde in Nahaufnahmen weggeschnitten.
      const mb = a.mesh.bounds;
      const bounds = mb ? { center: [mb.center[0], mb.center[1], mb.center[2]], radius: mb.radius * 1.15 + 0.02 } : { center: [0, 0, 0], radius: 2.5 * S };
      const d = { mesh: a.mesh, material: a.material, model: this.attM[k], castShadow: a.castShadow !== false, bounds };
      this.drawables.push(d);
      return d;
    });
    this._racketDrawables = this.racket ? this.racket.parts.map((p) => {
      const d = { mesh: p.mesh, material: p.material, model: this.racketM, castShadow: true, bounds: { center: [0, 0.35, 0], radius: 0.5 } };
      this.drawables.push(d);
      return d;
    }) : [];
    // Kontaktschatten
    if (!Character._shadowMat || Character._shadowR !== r) {
      Character._shadowR = r;
      Character._shadowMat = r.createMaterial({
        name: 'char-contact-shadow',
        uniforms: { u_shFeet: [0, 0, 0, 0], u_shDirs: [0, 1, 0, 1], u_shLift: [0, 0, 0, 0], u_shScale: [1, 1, 0.6, 0] },
        surface: SHADOW_SURFACE, blend: 'multiply', unlit: true, depthWrite: false, castShadow: false,
      });
      const m = plane(1, 1, 1, 1); delete m.colors;
      Character._shadowMesh = r.createMesh(m);
    }
    this.shadowM = mat4.create();
    this.shadowU = { u_shFeet: new Float32Array(4), u_shDirs: new Float32Array(4), u_shLift: new Float32Array(4), u_shScale: new Float32Array([S, 1, 0.62, 0]) };
    this.shadow = { mesh: Character._shadowMesh, material: Character._shadowMat, model: this.shadowM, uniforms: this.shadowU, pass: 'transparent', order: -2, castShadow: false, receiveShadow: false, bounds: { center: [0, 0, 0], radius: 0.9 } };
    this.drawables.push(this.shadow);
  }

  /** Fell-LOD (Gerry): Bildschirmhöhe der Figur in px. */
  setLod(screenPx) { if (this.asset.applyFurLod && this._partDrawables.length) this.asset.applyFurLod(this._partDrawables, screenPx); }

  // -------------------------------------------------------------------------- Steuerung
  /** Sofort an die aktuelle Position/Gier setzen (Füße neu pflanzen, Federn zurücksetzen). */
  reset() {
    const S = this.bodyScale;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const w = lerp(0.24, 0.46, this.ready) * S * 0.5;
    for (let i = 0; i < 2; i++) {
      const sg = i === 0 ? 1 : -1;
      this.feet.plant(i, this.position[0] + c * sg * w, this.position[2] - s * sg * w, this.yaw + sg * 0.15);
      this.feet.feet[i].heel = 0;
    }
    this.gait.reset();
    this.hipLocal = 0; this.hipVel = 0;
    this.vel.fill(0); this.acc.fill(0);
    const T = this.toon; T.sq = 1; T.sqV = 0; T.squash = 1; T.vy = 0; T.air = false; T.hx = T.hxV = T.hz = T.hzV = 0; T.rootY = 0;
    this._lastPos.set(this.position);
    if (this.tail) this.tail.reset();
    if (this.earL) { this.earL.reset(); this.earR.reset(); }
    this._fresh = true;
  }

  /** velWorld: Geschwindigkeit (m/s, Welt), ready 0..1, opts.split = Restzeit bis zur Landung eines Split-Steps. */
  setLocomotion(velWorld, ready = 0, opts = null) {
    this.velIn[0] = velWorld[0]; this.velIn[1] = 0; this.velIn[2] = velWorld[2];
    this.readyIn = clamp(ready, 0, 1);
    this._velT = this.time;
    if (opts && opts.split > 0) this.splitStep(opts.split);
  }

  /** Split-Step: kleiner Hüpfer, Landung (breiter, federnd) in tLand Sekunden. */
  splitStep(tLand = 0.12) {
    if (this.split && this.time - this.split.t0 < this.split.dur + 0.1) return;
    if (this.action && this.action.kind !== 'emote') return;
    const dur = clamp(tLand + 0.06, 0.14, 0.3);
    this.split = { t0: this.time, dur, h: 0.055 * this.bodyScale, stepped: false };
  }

  lookAt(pos) {
    if (!pos) { this.lookOn = false; return; }
    this.lookOn = true; this.lookTarget[0] = pos[0]; this.lookTarget[1] = pos[1]; this.lookTarget[2] = pos[2];
  }

  /**
   * Schlag starten: Kontakt exakt nach timeToContact Sekunden bei contactWorld.
   * type: STROKES-Schlüssel; shot: 'topspin'|'slice'|'lob'|'drop'|'flat'; power 0..1.
   */
  playStroke(type, o = {}) {
    if (type === 'serve') return this.playServe('swing', o);
    const A = this.anim.strokes[type] || this.anim.strokes.forehand;
    const T = Math.max(0.05, o.timeToContact !== undefined ? o.timeToContact : A.W);
    const act = this._newAction('stroke', A.clip);
    act.type = type; act.A = A; act.shot = o.shot || 'topspin'; act.power = o.power !== undefined ? o.power : 0.6;
    act.T = T; act.W = A.W;
    act.speed = clamp(A.W / T, 0.7, 1.6);
    act.contact = new Float32Array(o.contactWorld || this._defaultContact(type, _v0));
    act.contacted = false;
    // Schlagrahmen: vorhergesagte Körperposition beim Treffer
    const k = Math.min(T, 0.35) * 0.7;
    act.ox = this.position[0] + this.vel[0] * k; act.oz = this.position[2] + this.vel[2] * k; act.oyaw = this.yaw;
    // Treffpunkt im Schlagrahmen -> Varianten
    const dx = act.contact[0] - act.ox, dz = act.contact[2] - act.oz;
    const c = Math.cos(act.oyaw), s = Math.sin(act.oyaw);
    const lx = c * dx - s * dz, lz = s * dx + c * dz;          // lx = links, lz = vorn
    const def = STROKES[type] ? STROKES[type].contact : STROKES.forehand.contact;
    const sc = this.scale;
    const right = -lx, up = act.contact[1] - this.position[1];
    act.dUp = up - def.up * sc;
    act.dSide = Math.abs(right) - Math.abs(def.right) * sc;
    act.dFwd = lz - def.forward * sc;
    act.wLow = clamp(-act.dUp / (0.55 * sc), 0, 1);
    act.wHigh = clamp(act.dUp / (0.6 * sc), 0, 1);
    act.wReach = clamp(act.dSide / (0.55 * sc), 0, 1);
    act.wJam = clamp(-act.dSide / (0.3 * sc), 0, 1);
    act.footShift = clamp(act.dSide, -0.25, 0.6) * Math.sign(def.right);   // >0: nach rechts
    // Laufschlag: hohe Geschwindigkeit -> Unterkörper läuft weiter
    const sp = Math.hypot(this.vel[0], this.vel[2]) / this.bodyScale;
    act.run = smoothstep(2.4, 3.6, sp);
    act.feetMode = act.run > 0.5 ? 'gait' : 'plan';
    act.stepsDone = 0;
    act.hop = this._autoHop(type, act, A);
    this._startAction(act, 0.1);
    this.exertion = Math.min(1, this.exertion + 0.08);
  }

  /** Aufschlag-Phasen: 'idle' | 'bounce' | 'toss' | 'swing' (timeToContact, contactWorld) | 'follow'. */
  playServe(phase, o = {}) {
    const sv = this.serve, A = this.anim.serve;
    if (phase === 'follow') { if (this.action && this.action.kind === 'serve' && this.action.sub === 'swing') return; phase = 'swing'; o = { timeToContact: 0.02 }; }
    if (phase === 'idle' || phase === 'bounce') {
      if (this.action && this.action.kind === 'serve' && this.action.sub === phase) return;
      const act = this._newAction('serve', phase === 'idle' ? A.idle : A.bounce);
      act.sub = phase; act.loop = phase === 'bounce';
      act.feetMode = 'serve';
      sv.phase = phase; sv.t = 0; sv.period = o.period || 0.62; sv.released = false; sv.caught = true;
      act.speed = A.bouncePeriod / sv.period;
      this._startAction(act, 0.25);
      this.ballInHand = true;
      return;
    }
    if (phase === 'toss') {
      const act = this._newAction('serve', A.toss);
      act.sub = 'toss'; act.feetMode = 'serve';
      sv.phase = 'toss'; sv.t = 0; sv.released = false; sv.caught = false;
      // Wurfpunkt wie die Spiellogik (Treffpunkt bei perfektem Timing)
      const k = this.scale;
      const c = STROKES.serve.contact;
      const s = Math.sin(this.yaw), cc = Math.cos(this.yaw);
      sv.spot[0] = this.position[0] + s * c.forward * k - cc * c.right * k;
      sv.spot[2] = this.position[2] + cc * c.forward * k + s * c.right * k;
      sv.release = SERVE.releaseUp * k;
      const apex = (c.up + SERVE.tossApexAbove) * k;
      sv.v0 = Math.sqrt(2 * G * Math.max(0.2, apex - sv.release));
      sv.spot[1] = c.up * k;
      // Fangzeit: Ball fällt zurück auf Brusthöhe
      const yC = 1.05 * k, dy = sv.release - yC;
      sv.catchT = SERVE.tossRelease + (sv.v0 + Math.sqrt(sv.v0 * sv.v0 + 2 * G * dy)) / G;
      this._startAction(act, 0.12);
      this.ballInHand = true;
      return;
    }
    if (phase === 'swing') {
      const T = Math.max(0.05, o.timeToContact !== undefined ? o.timeToContact : A.W);
      const act = this._newAction('serve', A.swing);
      act.sub = 'swing'; act.type = 'serve'; act.A = A.swingDef; act.shot = o.shot || 'serve_flat'; act.power = o.power !== undefined ? o.power : 0.7;
      act.T = T; act.W = A.W; act.speed = clamp(A.W / T, 0.7, 1.6);
      act.contact = new Float32Array(o.contactWorld || this._defaultContact('serve', _v0));
      act.contacted = false;
      act.ox = this.position[0]; act.oz = this.position[2]; act.oyaw = this.yaw;
      act.wLow = 0; act.wHigh = 0; act.wReach = 0; act.wJam = 0; act.footShift = 0; act.run = 0;
      act.feetMode = 'plan'; act.stepsDone = 0;
      act.hop = this._autoHop('serve', act, A.swingDef);
      sv.phase = 'swing';
      this._startAction(act, 0.08);
      this.exertion = Math.min(1, this.exertion + 0.1);
    }
  }

  /** Emote: 'fistpump' 'celebrate' 'jump' 'dejected' 'shrug' 'wave' 'clap' 'bow' 'catch_ball'. */
  playEmote(name, o = {}) {
    const E = this.anim.emotes[name];
    if (!E) return;
    if (this.action && this.action.kind === 'stroke' && !this.action.done && this.action.tau < this.action.T + 0.2) return;
    const act = this._newAction('emote', E.clip);
    act.E = E; act.name = name; act.feetMode = E.feet || 'plan'; act.stepsDone = 0;
    act.hop = E.hop && Math.hypot(this.vel[0], this.vel[2]) < 0.6 ? { ...E.hop } : null;
    act.ox = this.position[0]; act.oz = this.position[2]; act.oyaw = this.yaw;
    this.mood = EMOTE_MOOD[name] || 'neutral'; this.moodT = E.clip.duration + 1.5;
    this._startAction(act, 0.2);
  }

  /** Läuft gerade eine Aktion? (null | 'stroke' | 'serve' | 'emote') */
  get busy() { return this.action && !this.action.done ? this.action.kind : null; }

  /** Laufende Aktion weich beenden (z. B. Aufschlag-Tippen, wenn der Punkt von außen abgebrochen wird). */
  stopAction() {
    const a = this.action;
    if (!a) return;
    if (a.w > 0.01) { copyPose(this.prevAct, this.act); this.prevW = a.w; }
    if (a.kind === 'serve') { this.serve.phase = 'none'; this.ballInHand = false; }
    this.action = null;
  }

  _newAction(kind, clip) {
    return { kind, clip, t: 0, tau: 0, w: 0, fade: 0.1, speed: 1, done: false, sub: null, loop: false, feetMode: 'plan', hop: null, stepsDone: 0, lowerW: 1 };
  }
  _startAction(act, fade) {
    // laufende Aktionspose einfrieren und ausblenden
    if (this.action && this.action.w > 0.01) { copyPose(this.prevAct, this.act); this.prevW = this.action.w; }
    act.fade = fade;
    this.action = act;
    if (act.kind === 'stroke' || (act.kind === 'serve' && act.sub === 'swing')) {
      act.t = clamp(act.W - act.speed * act.T, 0, act.W);
    }
  }
  _defaultContact(type, out) {
    const c = (STROKES[type] || STROKES.forehand).contact, k = this.scale;
    const s = Math.sin(this.yaw), cc = Math.cos(this.yaw);
    out[0] = this.position[0] + s * c.forward * k - cc * c.right * k;
    out[1] = c.up * k;
    out[2] = this.position[2] + cc * c.forward * k + s * c.right * k;
    return out;
  }
  /**
   * Automatischer Sprung für hohe Treffpunkte (Schmetterball/Aufschlag/hohe Volleys; kleine Figuren springen höher).
   * Höhe = senkrechtes Defizit zwischen Treffpunkt und maximaler Stand-Reichweite (Schulter + Arm + Schläger).
   */
  _autoHop(type, act, A) {
    const g = this.geo, S = this.bodyScale, K = Math.max(S, this.scale);   // K: Reichweite der Spiellogik (Chibi > Körpergröße)
    const reach = this.sweet[1] + Math.hypot(this.gripOff[0], this.gripOff[1], this.gripOff[2]) * 0.5;
    const pre = STROKES[type] ? STROKES[type].preBounce : true;
    // erreichbare Höhe über der Schulter sinkt mit dem seitlichen Abstand (nach Verschieben des Körpers)
    const R = (g.armLen + reach) * 0.9;
    const c = Math.cos(act.oyaw), s = Math.sin(act.oyaw);
    const dx = act.contact[0] - act.ox, dz = act.contact[2] - act.oz;
    const lx = c * dx - s * dz, lz = s * dx + c * dz;
    const dh = Math.max(0, Math.hypot(lx - g.shoulderX, lz) - (pre ? 0.9 : 0.75) * K);
    const top = g.shoulderY + 0.05 * S + Math.sqrt(Math.max(R * R - dh * dh, 0.36 * R * R));
    let h = Math.max(0, act.contact[1] - this.position[1] - top + 0.03);
    h = Math.min(h, pre ? 0.95 * K : 0.22 * K);
    if (A && A.hop) h = Math.max(h, A.hop * S);
    if (h < 0.025) return null;
    return { t0: -Math.min(0.34, 0.16 + h * 0.4), t1: 0.14 + h * 0.36, h, land: A && A.hopLand ? A.hopLand : null };
  }

  // -------------------------------------------------------------------------- Update
  update(dt) {
    this.events.length = 0;
    dt = clamp(dt, 0, 0.1);
    this.time += dt;
    const S = this.bodyScale;
    mat4.fromYawTranslation(this.model, this.yaw, this.position);
    // Teleport?
    const jump = Math.hypot(this.position[0] - this._lastPos[0], this.position[2] - this._lastPos[2]);
    if (this._fresh || jump > 1.5) { this.reset(); this._fresh = false; }
    // Geschwindigkeit (setLocomotion oder Positionsableitung)
    if (dt > 0) {
      let vx = this.velIn[0], vz = this.velIn[2];
      if (this.time - this._velT > 0.25) { vx = (this.position[0] - this._lastPos[0]) / dt; vz = (this.position[2] - this._lastPos[2]) / dt; }
      const k = 1 - Math.exp(-dt * 14);
      const nvx = this.vel[0] + (vx - this.vel[0]) * k, nvz = this.vel[2] + (vz - this.vel[2]) * k;
      const ka = 1 - Math.exp(-dt * 8);
      this.acc[0] += ((nvx - this.vel[0]) / dt - this.acc[0]) * ka;
      this.acc[2] += ((nvz - this.vel[2]) / dt - this.acc[2]) * ka;
      this.vel[0] = nvx; this.vel[2] = nvz;
      this.ready += (this.readyIn - this.ready) * (1 - Math.exp(-dt * 6));
    }
    this._lastPos.set(this.position);
    const speed = Math.hypot(this.vel[0], this.vel[2]);
    this.exertion = Math.max(0, Math.min(1, this.exertion + dt * (speed > 3 ? 0.06 : -0.035)));

    // 1) Aktion fortschreiben (Zeit, Gewichte, Fußarbeit-Befehle)
    this._updateAction(dt);
    const act = this.action;
    const actW = act ? act.w : 0;
    const lowerW = act ? act.lowerW * actW : 0;

    // 2) Hüftgier (Unterkörper dreht in Laufrichtung bei schneller Seit-/Rückwärtsbewegung)
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const vxL = c * this.vel[0] - s * this.vel[2], vzL = s * this.vel[0] + c * this.vel[2];   // links / vorn
    const th = Math.atan2(vxL, vzL);
    const sn = speed / S;
    let hipT = 0;
    const ath = Math.abs(th);
    if (speed > 0.3) {
      const turn = smoothstep(2.3, 4.2, sn);
      if (ath < 0.7) hipT = th * lerp(0.5, 0.9, turn);
      else if (ath < 2.3) hipT = Math.sign(th) * lerp(0.12, 1.25, smoothstep(1.7, 3.1, sn)) * smoothstep(0.7, 1.2, ath);
      else hipT = (th >= 0 ? 1 : -1) * lerp(0, 1.35, smoothstep(2.6, 4.2, sn));
    }
    hipT *= (1 - lowerW);
    // kritisch gedämpfte Feder
    {
      const w = 11, x = wrapAngle(this.hipLocal - hipT);
      const a = -w * w * x - 2 * w * this.hipVel;
      this.hipVel += a * dt; this.hipLocal += this.hipVel * dt;
    }
    const hipW = this.yaw + this.hipLocal;
    const ch = Math.cos(this.hipLocal), sh = Math.sin(this.hipLocal);
    const vxH = ch * vxL - sh * vzL, vzH = sh * vxL + ch * vzL;   // Geschwindigkeit im Hüftrahmen
    const thH = Math.abs(Math.atan2(vxH, vzH));
    const fwdW = 1 - smoothstep(0.65, 1.1, thH), backW = smoothstep(2.0, 2.45, thH);
    const latW = Math.max(0, 1 - fwdW - backW);

    // 3) Gang + Füße
    const gaitOn = !act || act.feetMode === 'gait' || actW < 0.2 || ((act.feetMode === 'serve' || act.kind === 'emote') && speed > 0.4 * S);
    const splitOn = this.split && this.time - this.split.t0 < this.split.dur;
    this.gait.update(dt, {
      x: this.position[0], z: this.position[2], vx: this.vel[0], vz: this.vel[2], hipYaw: hipW,
      fwd: fwdW, lat: latW, back: backW, latSign: vxH > 0 ? 1 : -1, enabled: gaitOn && !splitOn,
    });
    this._updateSplit(dt, hipW);
    if (gaitOn && !this.gait.moving && !splitOn) this._settleFeet(dt, hipW);
    if (!splitOn) this._rescueFeet(hipW);
    this.feet.update(dt);
    for (const i of this.feet.landed) this._footstep(i);
    this._updateHeels(dt);

    // 4) Basis-Pose
    this._buildBase(dt, speed);

    // 5) Aktion mischen
    if (act) this._sampleAction(act, act.t, this.act);
    this._compose(this.pose, this.act, actW, lowerW, hipW);

    // Blick (vor der IK, damit Rumpfanteile in die Treffer-Vorhersage eingehen)
    this._lookWeight(dt, act);
    this._applyLook(this.pose);
    // 6) Becken an Füße anpassen, Bein-IK
    this._fitPelvis(dt);
    // 7) Treffpunkt-IK (vor Bein-IK berechnet, Reichweitenhilfe verschiebt Wurzel)
    const ik = this._contactIK(act);
    this._legIK();
    if (ik) this._armIK();
    // 8) linke Hand
    this._leftHand(act);
    // 9) Augen + Sekundär
    this._eyes();
    this._secondary(dt, act);
    this._toon(dt, act);
    // 10) FK + Drawables
    this.skel.update(this.pose);
    this._applySquash();
    this._finish(dt);
  }

  // -------------------------------------------------------------------------- Aktionen
  _updateAction(dt) {
    if (this.prevW > 0) this.prevW = Math.max(0, this.prevW - dt / 0.14);
    const a = this.action;
    if (!a) return;
    a.tau += dt;
    const sv = this.serve;
    if (a.kind === 'stroke' || (a.kind === 'serve' && a.sub === 'swing')) {
      const tc = a.W - a.speed * (a.T - a.tau);
      if (a.tau <= a.T) a.t = Math.max(0, tc);
      else a.t = a.W + (a.tau - a.T) * (a.followSpeed || 1);
      if (tc < 0) { a.w = 0; a.wait = true; return; }
      if (a.wait || a.start === undefined) { a.wait = false; a.start = a.tau; }
      // Kontakt-Ereignis
      if (!a.contacted && a.tau >= a.T - 1e-6) {
        a.contacted = true;
        this.events.push({ type: 'swing_contact', stroke: a.type, pos: Array.from(a.contact), time: this.time });
        if (a.kind === 'serve') this.ballInHand = false;
      }
      // Fußarbeit
      this._actionSteps(a, a.t - a.W);
      // Gewicht
      const D = a.clip.duration;
      const fin = a.A && a.A.fadeOut !== undefined ? a.A.fadeOut : 0.22;
      const wIn = smoothstep(0, 1, Math.min(1, (a.tau - a.start + 1e-3) / a.fade));
      a.w = wIn * (1 - smoothstep(D - fin, D, a.t));
      a.lowerW = 1 - a.run;
      if (a.t >= D) { a.done = true; this.action = null; if (a.kind === 'serve') sv.phase = 'none'; }
      return;
    }
    if (a.kind === 'serve') {
      sv.t += dt;
      const A = this.anim.serve;
      if (a.sub === 'toss') {
        a.t = Math.min(sv.t, a.clip.duration);
        if (!sv.released && sv.t >= SERVE.tossRelease) {
          sv.released = true; this.ballInHand = false;
          this.heldBallPos(this._ball);
          this.events.push({ type: 'ball_release', pos: Array.from(this._ball), time: this.time });
        }
        // kein Schlag: Ball fangen und neu ansetzen
        if (sv.released && !sv.caught && sv.t >= sv.catchT) {
          sv.caught = true; this.ballInHand = true;
          this.events.push({ type: 'ball_catch', time: this.time });
        }
        if (sv.caught && sv.t >= sv.catchT + 0.45) { this.playServe('bounce', { period: sv.period }); return; }
      } else {
        a.t = a.sub === 'bounce' ? (sv.t * a.speed) % A.bounce.duration : Math.min(sv.t, a.clip.duration);
        if (a.sub === 'bounce') {
          // Ballaufprall-Ereignis (Mitte der Periode)
          const P = sv.period, prev = (sv.t - dt) / P, cur = sv.t / P;
          if (Math.floor(prev - 0.5) !== Math.floor(cur - 0.5) && cur >= 0.5) {
            this.heldBallPos(this._ball);
            this.events.push({ type: 'ball_bounce', pos: [this._ball[0], 0, this._ball[2]], time: this.time });
          }
        }
      }
      a.w = smoothstep(0, 1, Math.min(1, a.tau / a.fade));
      a.lowerW = 1;
      this._serveFeet(a);
      return;
    }
    // Emote
    a.t = a.tau;
    this._actionSteps(a, a.t);
    const D = a.clip.duration;
    a.w = smoothstep(0, 1, Math.min(1, a.tau / a.fade)) * (1 - smoothstep(D - 0.3, D, a.t));
    const sp = Math.hypot(this.vel[0], this.vel[2]) / this.bodyScale;
    a.lowerW = (a.E && a.E.lowerW !== undefined ? a.E.lowerW : 1) * (1 - smoothstep(0.3, 1.1, sp));
    if (a.t >= D) { a.done = true; this.action = null; }
  }

  /** Fußarbeit-Befehle einer Aktion (Zeit tr relativ zum Treffer bzw. Emote-Zeit). */
  _actionSteps(a, tr) {
    const steps = a.kind === 'emote' ? a.E.steps : a.A && a.A.steps;
    if (a.feetMode === 'gait') return;
    const S = this.bodyScale;
    const c = Math.cos(a.oyaw), s = Math.sin(a.oyaw);
    if (steps) {
      while (a.stepsDone < steps.length && tr >= steps[a.stepsDone].t) {
        const st = steps[a.stepsDone++];
        const i = st.foot === 'l' ? 0 : 1;
        let x = st.at[0] * S, z = st.at[1] * S;
        // Variante: Ausfallschritt zur Ballseite, tiefer Ball -> breiter
        if (st.reach) x -= (a.footShift || 0) * st.reach;
        if (a.wLow && st.wide) x *= 1 + 0.18 * a.wLow;
        const wx = a.ox + c * x + s * z, wz = a.oz - s * x + c * z;
        const dur = Math.max(0.08, st.dur / (a.speed || 1));
        this.feet.step(i, wx, wz, a.oyaw + st.yaw * DEG, dur, (st.h || 0.06) * S, { lock: 0.5, landPitch: st.land !== undefined ? st.land : -0.05, force: true });
      }
    }
    // Sprung
    const h = a.hop;
    if (h && !h.started && tr >= h.t0) {
      h.started = true;
      // Echtzeit-Dauer (vor dem Treffer läuft der Clip mit a.speed)
      const dur = a.kind === 'emote' ? h.t1 - h.t0 : Math.max(0, -h.t0) / (a.speed || 1) + Math.max(0, h.t1);
      for (let i = 0; i < 2; i++) {
        const f = this.feet.feet[i];
        let tx = f.x, tz = f.z;
        if (h.land) { const sg = i === 0 ? 0 : 2; const x = h.land[sg] * S, z = h.land[sg + 1] * S; tx = a.ox + c * x + s * z; tz = a.oz - s * x + c * z; }
        this.feet.step(i, tx, tz, f.yaw, dur * 0.98, Math.max(0.03, h.h * 0.75), { lock: 0.6, landPitch: 0.15, startPitch: 0.3, force: true, air: h.h > 0.05 });
      }
    }
  }

  _serveFeet(a) {
    // Aufschlagstellung: linker Fuß vorn (Spitze zum rechten Netzpfosten), rechter Fuß parallel zur Grundlinie.
    // Nur im Stand und nur ein Fuß zugleich (seitliches Verschieben beim Tippen: Gang übernimmt).
    const F = this.feet.feet;
    if (F[0].swing || F[1].swing || this.gait.moving) return;
    if (Math.hypot(this.vel[0], this.vel[2]) > 0.25) return;
    const S = this.bodyScale, A = this.anim.serve;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    for (const st of A.stance) {
      const i = st.foot === 'l' ? 0 : 1;
      const x = st.at[0] * S, z = st.at[1] * S;
      const wx = this.position[0] + c * x + s * z, wz = this.position[2] - s * x + c * z;
      const f = F[i];
      const d = Math.hypot(f.x - wx, f.z - wz), dy = Math.abs(wrapAngle(f.yaw - (this.yaw + st.yaw * DEG)));
      if (d > 0.05 * S || dy > 0.2) { this.feet.step(i, wx, wz, this.yaw + st.yaw * DEG, 0.26, 0.05 * S, { lock: 0.6 }); return; }
    }
  }

  _updateSplit(dt, hipW) {
    const sp = this.split;
    if (!sp) return;
    const u = (this.time - sp.t0) / sp.dur;
    if (!sp.stepped) {
      sp.stepped = true;
      const S = this.bodyScale, w = 0.27 * S;
      const c = Math.cos(hipW), s = Math.sin(hipW);
      const px = this.position[0] + this.vel[0] * sp.dur * 0.6, pz = this.position[2] + this.vel[2] * sp.dur * 0.6;
      for (let i = 0; i < 2; i++) {
        const sg = i === 0 ? 1 : -1;
        this.feet.step(i, px + c * sg * w, pz - s * sg * w, hipW + sg * 0.3, sp.dur * 0.97, sp.h, { lock: 0.7, landPitch: 0.2, startPitch: 0.25, force: true });
      }
    }
    if (u > 1.8) this.split = null;
  }

  /** Füße im Stand nachsetzen (Drehen auf der Stelle, Stellung wechseln). */
  _settleFeet(dt, hipW) {
    const F = this.feet.feet;
    if (F[0].swing || F[1].swing) { this._settleT = 0; return; }
    const S = this.bodyScale;
    const r = this.ready;
    const w = lerp(0.24, 0.48, r) * S * 0.5;
    const c = Math.cos(hipW), s = Math.sin(hipW);
    let worst = -1, we = 0;
    for (let i = 0; i < 2; i++) {
      const sg = i === 0 ? 1 : -1;
      const tx = this.position[0] + c * sg * w, tz = this.position[2] - s * sg * w;
      const d = Math.hypot(F[i].x - tx, F[i].z - tz);
      const dy = Math.abs(wrapAngle(F[i].yaw - (hipW + sg * lerp(0.12, 0.28, r))));
      const e = d / (0.11 * S) + dy / 0.5;
      if (e > 1 && e > we) { we = e; worst = i; }
    }
    if (worst < 0) { this._settleT = 0; return; }
    this._settleT += dt;
    if (this._settleT < 0.06) return;
    this._settleT = 0;
    const sg = worst === 0 ? 1 : -1;
    const tx = this.position[0] + c * sg * w, tz = this.position[2] - s * sg * w;
    const d = Math.hypot(F[worst].x - tx, F[worst].z - tz);
    this.feet.step(worst, tx, tz, hipW + sg * lerp(0.12, 0.28, r), clamp(0.18 + d * 0.3, 0.2, 0.32), (0.04 + d * 0.08) * S, { lock: 0.7, landPitch: -0.04 });
  }

  /** Überdehnter Standfuß (Körper ist weitergelaufen): sofort nachsetzen. */
  _rescueFeet(hipW) {
    const F = this.feet.feet, S = this.bodyScale, g = this.geo;
    const maxH = 0.6 * g.legLen + 0.12 * S;
    for (let i = 0; i < 2; i++) {
      const f = F[i], o = F[1 - i];
      if (f.swing || (o.swing && o.t < o.dur * 0.55)) continue;
      const dx = f.x - this.position[0], dz = f.z - this.position[2];
      if (dx * dx + dz * dz < maxH * maxH) continue;
      const sg = i === 0 ? 1 : -1;
      const c = Math.cos(hipW), s = Math.sin(hipW);
      const w = (this.gait.moving ? this.gait.p.width : lerp(0.24, 0.48, this.ready)) * S * 0.5;
      const k = 0.16;
      const tx = this.position[0] + this.vel[0] * k + c * sg * w, tz = this.position[2] + this.vel[2] * k - s * sg * w;
      this.feet.step(i, tx, tz, hipW + sg * 0.15, 0.16, 0.07 * S, { lock: 0.6, landPitch: 0 });
      return;
    }
  }

  _updateHeels(dt) {
    const a = this.action;
    const k = 1 - Math.exp(-dt * 16);
    for (let i = 0; i < 2; i++) {
      const f = this.feet.feet[i];
      if (f.swing) continue;
      let tgt = this.gait.moving ? gaitHeel(this.gait, i) : 0.1 * this.ready;
      if (a && a.w > 0.01) {
        const hc = a.kind === 'emote' ? (a.E.heel && a.E.heel[i === 0 ? 'l' : 'r']) : a.A && a.A.heel && a.A.heel[i === 0 ? 'l' : 'r'];
        if (hc) {
          const tr = a.kind === 'emote' ? a.t : a.t - (a.W || 0);
          tgt = lerp(tgt, curve(hc, tr), a.w);
        }
      }
      f.heel += (tgt - f.heel) * k;
    }
  }

  _footstep(i) {
    const f = this.feet.feet[i];
    const sp = Math.hypot(this.vel[0], this.vel[2]);
    // Cartoon: jeder Schritt federt kurz ein, der große Kopf nickt mit
    const T = this.toon, sn = Math.min(sp / this.bodyScale, 12);
    T.sqV -= 0.2 + sn * 0.07;
    T.hxV += 0.25 + sn * 0.12;
    this.events.push({ type: 'footstep', foot: i === 0 ? 'l' : 'r', pos: [f.x, this.position[1], f.z], speed: sp, strength: clamp(0.25 + sp / 6, 0.2, 1) });
  }

  // -------------------------------------------------------------------------- Posen
  _buildBase(dt, speed) {
    const g = this.gait, W = g.w, B = this.base;
    const r = this.ready;
    // Stand: entspannt <-> bereit
    copyPose(B, this.relaxedPose);
    blendPose(B, B, this.readyPose, r);
    this._acc = Math.max(1e-4, W.idle);
    const sn = speed / this.bodyScale;
    this._addCycle(LOCO_CLIPS.walk, W.walk, r * 0.85);
    this._addCycle(LOCO_CLIPS.run, W.run, r * 0.5 * (1 - smoothstep(2.6, 3.8, sn)));
    this._addCycle(LOCO_CLIPS.sprint, W.sprint, 0);
    this._addCycle(LOCO_CLIPS.shuffle, W.shuffle, 0);
    this._addCycle(LOCO_CLIPS.back, W.back, 0);
  }
  /** Lauf-Zyklus (Gangphase) gewichtet in die Basis mischen. */
  _addCycle(clip, w, readyArms) {
    if (w <= 1e-3) return;
    const T = this.tmp;
    sampleClip(this.def, clip, this.gait.phase, T);
    if (this.carryFix) postRot(T, this.bi.hand_r, this.carryFix);
    if (readyArms > 0) blendPose(T, T, this.readyPose, readyArms, this.maskArms);
    this._acc += w;
    blendPose(this.base, this.base, T, w / this._acc);
  }

  _sampleAction(a, t, out) {
    sampleClip(this.def, a.clip, t, out);
    if (a.kind !== 'stroke' && !(a.kind === 'serve' && a.sub === 'swing')) return;
    const A = a.A;
    if (!A || !A.add) return;
    const tr = t - a.W;
    const e = env(tr, -a.W * 0.8, -0.05, A.envOut || 0.15, (A.envOut || 0.15) + 0.3);
    if (a.wLow > 0 && A.add.low) addPose(out, out, A.add.low, a.wLow * e);
    if (a.wHigh > 0 && A.add.high) addPose(out, out, A.add.high, a.wHigh * e);
    if (a.wReach > 0 && A.add.reach) addPose(out, out, A.add.reach, a.wReach * e);
    if (a.wJam > 0 && A.add.jam) addPose(out, out, A.add.jam, a.wJam * e);
    const sh = A.add.shot && A.add.shot[a.shot];
    if (sh) addPose(out, out, sh, smoothstep(-0.12, 0.08, tr));
  }

  /**
   * out = Basis + Aktion (Gewicht w, Unterkörper lowerW) + prozedurale Zusätze. Gibt nichts zurück.
   */
  _compose(out, actPose, w, lowerW, hipW) {
    const def = this.def, S = this.bodyScale, n = def.count;
    copyPose(out, this.base);
    if (this.prevW > 0) blendPose(out, out, this.prevAct, this.prevW);
    if (w > 0) {
      const m = this.maskAct;
      const lw = this.action ? this.action.lowerW : 1;
      for (let i = 0; i < n; i++) m[i] = this.maskUpper[i] > 0 ? 1 : lw;
      blendPose(out, out, actPose, w, m);
      // Laufschlag: Wurzel-Gier des Schlags in den Rumpf übertragen
      if (lw < 1) {
        const ry = actPose.rot, o = 0;
        const yaw = 2 * Math.atan2(ry[o + 1], ry[o + 3]) * (1 - lw) * w;
        qYaw(_q0, yaw * 0.45); postRot(out, this.bi.spine, _q0); postRot(out, this.bi.chest, _q0);
      }
    }
    // Skalierung der Offsets (Clips in Tom-Metern)
    for (let k = 0; k < 6; k++) out.t[k] *= S;
    const a = this.action;
    const act = a && a.w > 0 ? a : null;
    const speed = Math.hypot(this.vel[0], this.vel[2]);
    const mv = smoothstep(0.1, 0.8, speed);
    const g = this.gait;
    const free = 1 - (act ? act.w * act.lowerW : 0);
    // Hüftgier (Wurzel), Oberkörper dreht zurück Richtung Netz
    qYaw(_q0, this.hipLocal * free);
    preRot(out, 0, _q0);
    const counter = -this.hipLocal * free * smoothstep(0.2, 0.6, this.ready + 0.3 * mv) * (act ? 1 - act.w : 1);
    qYaw(_q0, counter * 0.22); postRot(out, this.bi.spine, _q0);
    qYaw(_q0, counter * 0.28); postRot(out, this.bi.chest, _q0);
    // Becken: Gang-Hocke, Hub, Bereitschafts-Wippen
    const P = g.p;
    out.t[4] += (-P.crouch * S * mv + g.bob) * free;
    // Bereitschaft: federndes Wippen auf den Fußballen + leichtes Gewichtverlagern (Mario-Tennis-Stil)
    const bounce = this.ready * (1 - mv) * (act ? 1 - act.w : 1);
    const rph = this.time * TAU * 1.15;
    out.t[4] += (Math.abs(Math.sin(rph)) - 0.6) * 0.034 * S * bounce;
    out.t[0] += Math.sin(rph * 0.5) * 0.014 * S * bounce;
    // Neigung durch Beschleunigung und ins Laufen hinein (vorn/seitlich im Körperrahmen)
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const axL = c * this.acc[0] - s * this.acc[2], azL = s * this.acc[0] + c * this.acc[2];
    const vxL = c * this.vel[0] - s * this.vel[2], vzL = s * this.vel[0] + c * this.vel[2];
    const lean = (clamp(azL * 1.3, -13, 13) + clamp(vzL / S * 1.1, -6, 9)) * DEG * free;
    const side = (clamp(-axL * 1.0, -11, 11) + clamp(-vxL / S * 0.9, -8, 8)) * DEG * free;
    qAxis(_q0, 1, 0, 0, lean * 0.6); postRot(out, this.bi.spine, _q0);
    qAxis(_q0, 0, 0, 1, side * 0.6); postRot(out, this.bi.spine, _q0);
    // Atmung
    const br = lerp(0.24, 0.55, this.exertion), amp = lerp(1.0, 2.6, this.exertion) * DEG;
    const bph = Math.sin(this.time * TAU * br);
    qAxis(_q0, 1, 0, 0, -bph * amp); postRot(out, this.bi.chest, _q0);
    qAxis(_q0, 1, 0, 0, bph * amp * 0.7); postRot(out, this.bi.neck, _q0);
    // Split-Step: Hüpfer (Wurzel hoch), Landung federt
    const sp = this.split;
    if (sp) {
      const u = (this.time - sp.t0) / sp.dur;
      if (u < 1) out.t[1] += sp.h * Math.sin(Math.PI * clamp(u, 0, 1)) * 0.85;
      else out.t[4] -= 0.05 * S * Math.sin(Math.PI * clamp((u - 1) / 0.8, 0, 1));
    }
    // Aktions-Sprung
    if (act && act.hop && act.hop.started) {
      const h = act.hop, tr = act.kind === 'emote' ? act.t : act.t - act.W;
      const u = (tr - h.t0) / (h.t1 - h.t0);
      if (u > 0 && u < 1) out.t[1] += h.h * Math.sin(Math.PI * u);
      else if (u >= 1 && u < 1.8) out.t[4] -= 0.06 * S * Math.sin(Math.PI * (u - 1) / 0.8) * Math.min(1, h.h * 6);
    }
    // Varianten: Ballhöhe -> Hocke/Streckung
    if (act && (act.kind === 'stroke' || act.sub === 'swing')) {
      const tr = act.t - act.W;
      const e = env(tr, -act.W * 0.85, -0.06, 0.12, 0.45) * act.w;
      out.t[4] += (-act.wLow * 0.17 + act.wHigh * 0.03) * S * e;
    }
    void hipW;
  }

  /** Becken absenken, falls ein Fuß sonst nicht erreichbar wäre. */
  _fitPelvis(dt) {
    const g = this.geo, S = this.bodyScale;
    let need = 0;
    for (let i = 0; i < 2; i++) {
      const f = this.feet.feet[i];
      if (f.swing && f.air) continue;
      this._ankleModel(i, _v0);
      getBoneModel(this.def, this.pose, i === 0 ? 'thigh_l' : 'thigh_r', _q0, _v1);
      const dx = _v0[0] - _v1[0], dy = _v1[1] - _v0[1], dz = _v0[2] - _v1[2];
      const Lm = g.legLen * 0.985;
      const dh2 = dx * dx + dz * dz;
      const maxDy = dh2 < Lm * Lm ? Math.sqrt(Lm * Lm - dh2) : 0;
      need = Math.max(need, dy - maxDy);
    }
    need = clamp(need, 0, 0.32 * S);
    // sofort runter, weich wieder hoch
    if (need > this.pelvisDrop) this.pelvisDrop = need;
    else this.pelvisDrop += (need - this.pelvisDrop) * (1 - Math.exp(-dt * 10));
    this.pose.t[4] -= this.pelvisDrop;
  }

  /** Knöchel-Zielposition (Modellraum) für Fuß i. */
  _ankleModel(i, out) {
    const f = this.feet.feet[i], g = this.geo;
    const a = f.heel;
    let ly, lz;
    if (a >= 0) { ly = g.ankleH * Math.cos(a) + g.ballZ * Math.sin(a); lz = g.ballZ + g.ankleH * Math.sin(a) - g.ballZ * Math.cos(a); }
    else { ly = g.ankleH * Math.cos(a) - g.heelZ * Math.sin(a); lz = -g.heelZ + g.ankleH * Math.sin(a) + g.heelZ * Math.cos(a); }
    const wx = f.x + Math.sin(f.yaw) * lz, wz = f.z + Math.cos(f.yaw) * lz, wy = ly + f.lift;
    const dx = wx - this.position[0], dz = wz - this.position[2];
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    out[0] = c * dx - s * dz; out[1] = wy; out[2] = s * dx + c * dz;
    return out;
  }

  _legIK() {
    const def = this.def, P = this.pose, S = this.bodyScale;
    for (let i = 0; i < 2; i++) {
      const f = this.feet.feet[i];
      const sx = i === 0 ? '_l' : '_r';
      this._ankleModel(i, _v0);
      const fy = f.yaw - this.yaw;
      // Fußrotation (Modell): Gier * Neigung
      qYaw(_q0, fy); qAxis(_q1, 1, 0, 0, f.heel); quat.multiply(_q2, _q0, _q1);
      // Knie-Pol: vor dem Knie in Fußrichtung, leicht nach außen
      getBoneModel(def, P, 'thigh' + sx, _q1, _v1);
      const sg = i === 0 ? 1 : -1;
      _v2[0] = (_v1[0] + _v0[0]) * 0.5 + Math.sin(fy) * 0.6 * S + Math.cos(fy) * sg * 0.2 * S;
      _v2[1] = (_v1[1] + _v0[1]) * 0.5;
      _v2[2] = (_v1[2] + _v0[2]) * 0.5 + Math.cos(fy) * 0.6 * S - Math.sin(fy) * sg * 0.2 * S;
      twoBoneIK(def, P, 'thigh' + sx, 'shin' + sx, 'foot' + sx, _v0, _v2, { endRot: _q2, soft: 0.015 * S });
      // Zehen flach halten bei angehobener Ferse
      const ti = this.bi['toe' + sx];
      if (f.heel > 0) qAxis(_q0, 1, 0, 0, -f.heel * (f.swing ? 0.5 : 1)); else { _q0[0] = 0; _q0[1] = 0; _q0[2] = 0; _q0[3] = 1; }
      P.rot[4 * ti] = _q0[0]; P.rot[4 * ti + 1] = _q0[1]; P.rot[4 * ti + 2] = _q0[2]; P.rot[4 * ti + 3] = _q0[3];
    }
  }

  // -------------------------------------------------------------------------- Treffpunkt-IK
  /**
   * Bereitet die Arm-IK vor: Ziel = aktuelle Hand + w * (Kontakt - vorhergesagter Sweet-Spot beim Treffer).
   * Am Treffzeitpunkt ist die Vorhersage die aktuelle Pose -> Sweet-Spot liegt exakt auf contactWorld.
   */
  _contactIK(a) {
    if (!a || !(a.kind === 'stroke' || (a.kind === 'serve' && a.sub === 'swing')) || a.w <= 0) return false;
    const dtc = a.tau - a.T;
    const A = a.A || {};
    const pre = A.ikIn || 0.14, post = A.ikOut || 0.14;
    const w = smoothstep(-pre, -0.015, dtc) * (1 - smoothstep(0.02, post, dtc));
    if (w <= 0.001) return false;
    // Vorhersage: gleiche Pipeline mit Aktions-Sample beim Treffer
    this._sampleAction(a, a.W, this.tmp2);
    this._compose(this.pred, this.tmp2, a.w, a.lowerW * a.w, 0);
    this._applyLook(this.pred);
    this.pred.t[4] -= this.pelvisDrop;
    this._sweetModel(this.pred, _v0);
    // Kontakt in Modellraum
    const cm = this._toModel(a.contact, _v1);
    const Dx = cm[0] - _v0[0], Dy = cm[1] - _v0[1], Dz = cm[2] - _v0[2];
    // aktuelle Hand (Modell) + Rotation
    getBoneModel(this.def, this.pose, 'hand_r', this._ikRot, this._ikPos);
    this._ikPos[0] += Dx * w; this._ikPos[1] += Dy * w; this._ikPos[2] += Dz * w;
    this._ikW = w;
    // Reichweitenhilfe: Wurzel/Becken zum Ziel verschieben, Rumpf neigen
    this._reachAssist(this._ikPos, w);
    this._racketRedirect();
    return true;
  }
  /**
   * Letzte Stufe: Ziel immer noch außer Armreichweite -> Schläger um den Sweet-Spot zum Ball hin drehen (Arm und
   * Schläger strecken sich in einer Linie zum Ball). Sweet-Spot-Ziel bleibt unverändert (Treffer exakt).
   */
  _racketRedirect() {
    const H = this._ikPos, Q = this._ikRot, g = this.geo;
    const maxL = g.armLen * 0.985;
    getBoneModel(this.def, this.pose, 'arm_r', _q0, _v2);
    if (Math.hypot(H[0] - _v2[0], H[1] - _v2[1], H[2] - _v2[2]) <= maxL) return;
    // r = Hand -> Sweet (Modell), Sweet-Ziel P = H + r
    rotV(_v0, this.gripRot, this.sweet[0], this.sweet[1], this.sweet[2]);
    _v0[0] += this.gripOff[0]; _v0[1] += this.gripOff[1]; _v0[2] += this.gripOff[2];
    rotV(_v0, Q, _v0[0], _v0[1], _v0[2]);
    const Px = H[0] + _v0[0], Py = H[1] + _v0[1], Pz = H[2] + _v0[2];
    const rl = Math.hypot(_v0[0], _v0[1], _v0[2]);
    // Zielrichtung u = Schulter -> P
    let ux = Px - _v2[0], uy = Py - _v2[1], uz = Pz - _v2[2];
    const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    const rx = _v0[0] / rl, ry = _v0[1] / rl, rz = _v0[2] / rl;
    let ax = ry * uz - rz * uy, ay = rz * ux - rx * uz, az = rx * uy - ry * ux;
    const al = Math.hypot(ax, ay, az);
    const full = Math.atan2(al, rx * ux + ry * uy + rz * uz);
    if (al < 1e-6) return;
    ax /= al; ay /= al; az /= al;
    // kleinster Drehwinkel, der die Hand in Reichweite bringt (Bisektion)
    let lo = 0, hi = full;
    for (let k = 0; k < 10; k++) {
      const m = (lo + hi) * 0.5;
      qAxis(_q1, ax, ay, az, m); rotV(_v1, _q1, _v0[0], _v0[1], _v0[2]);
      const d = Math.hypot(Px - _v1[0] - _v2[0], Py - _v1[1] - _v2[1], Pz - _v1[2] - _v2[2]);
      if (d > maxL) lo = m; else hi = m;
    }
    qAxis(_q1, ax, ay, az, hi); rotV(_v1, _q1, _v0[0], _v0[1], _v0[2]);
    H[0] = Px - _v1[0]; H[1] = Py - _v1[1]; H[2] = Pz - _v1[2];
    quat.multiply(Q, _q1, Q);
  }
  /** Ziel H (Modell) außer Reichweite: Wurzel/Becken verschieben (Ausfallschritt/Hocke), dann Rumpf zum Ziel neigen. */
  _reachAssist(H, w) {
    const g = this.geo, S = this.bodyScale, P = this.pose, def = this.def;
    const K = Math.max(S, this.scale);   // Budgets nach Spiel-Reichweite (kurze Chibi-Arme gleichen mit dem Körper aus)
    const maxL = g.armLen * 0.975;
    const a = this.action;
    const pre = a && a.type && STROKES[a.type] ? STROKES[a.type].preBounce : false;
    let budH = (pre ? 0.9 : 0.75) * K, budDown = 0.36 * S, budUp = 0.12 * K, bend = 1.3, twist = 0.6;
    for (let it = 0; it < 12; it++) {
      getBoneModel(def, P, 'arm_r', _q0, _v2);
      const dx = H[0] - _v2[0], dy = H[1] - _v2[1], dz = H[2] - _v2[2];
      const d = Math.hypot(dx, dy, dz);
      if (d <= maxL + 1e-4) break;
      const ex = (d - maxL) * 1.02;
      // a) Verschieben (Wurzel horizontal, Becken vertikal)
      let mx = dx / d * ex, mz = dz / d * ex, my = dy / d * ex;
      const hl = Math.hypot(mx, mz);
      if (hl > budH) { mx *= budH / hl; mz *= budH / hl; }
      if (my < -budDown) my = -budDown; if (my > budUp) my = budUp;
      const moved = Math.hypot(mx, my, mz);
      if (moved > 0.002 && it < 3) {
        P.t[0] += mx; P.t[2] += mz; P.t[4] += my;
        budH -= Math.hypot(mx, mz); if (my < 0) budDown += my; else budUp -= my;
        continue;
      }
      // b) Rumpf zum Ziel drehen (um die Hochachse), dann neigen (Achse (Schulter-J) x (Ziel-J))
      getBoneModel(def, P, 'spine', _q1, _v1);
      const vx = _v2[0] - _v1[0], vy = _v2[1] - _v1[1], vz = _v2[2] - _v1[2];
      const tx = H[0] - _v1[0], ty = H[1] - _v1[1], tz = H[2] - _v1[2];
      let ax, ay, az, ang;
      const hv = Math.hypot(vx, vz), ht = Math.hypot(tx, tz);
      const yawD = hv > 0.03 && ht > 0.03 ? wrapAngle(Math.atan2(tx, tz) - Math.atan2(vx, vz)) : 0;
      if (twist > 0.01 && Math.abs(yawD) > 0.05) {
        ang = Math.sign(yawD) * Math.min(twist, Math.abs(yawD) * 0.9, ex / Math.max(0.1, hv) * 1.2);
        twist -= Math.abs(ang); ax = 0; ay = 1; az = 0;
      } else {
        if (bend <= 0.01) break;
        ax = vy * tz - vz * ty; ay = vz * tx - vx * tz; az = vx * ty - vy * tx;
        const al = Math.hypot(ax, ay, az);
        if (al < 1e-6) break;
        const th = Math.atan2(al, vx * tx + vy * ty + vz * tz);   // Winkel zwischen v und t (nicht überdrehen)
        ax /= al; ay /= al; az /= al;
        ang = Math.min(bend, th * 0.95, ex / Math.max(0.15, Math.hypot(vx, vy, vz)) * 1.2);
        if (ang < 0.005) break;
        bend -= ang;
      }
      qAxis(_q2, ax, ay, az, ang);
      quat.multiply(_q2, _q2, _q1);                       // neue Modellrotation des spine
      getBoneModel(def, P, 'pelvis', _q3, _v3);
      quat.invert(_q3, _q3); quat.multiply(_q2, _q3, _q2);
      const o = 4 * this.bi.spine;
      P.rot[o] = _q2[0]; P.rot[o + 1] = _q2[1]; P.rot[o + 2] = _q2[2]; P.rot[o + 3] = _q2[3];
    }
    void w;
  }
  _armIK() {
    twoBoneIK(this.def, this.pose, 'arm_r', 'forearm_r', 'hand_r', this._ikPos, null, { endRot: this._ikRot, soft: 0 });
  }
  /** Sweet-Spot einer Pose im Modellraum. */
  _sweetModel(pose, out) {
    getBoneModel(this.def, pose, 'hand_r', _q1, _v3);
    // Schläger = Hand * gripMatrix; Sweet = Schläger * sweet
    rotV(out, this.gripRot, this.sweet[0], this.sweet[1], this.sweet[2]);
    out[0] += this.gripOff[0]; out[1] += this.gripOff[1]; out[2] += this.gripOff[2];
    rotV(out, _q1, out[0], out[1], out[2]);
    out[0] += _v3[0]; out[1] += _v3[1]; out[2] += _v3[2];
    return out;
  }
  _toModel(w, out) {
    const dx = w[0] - this.position[0], dz = w[2] - this.position[2];
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    out[0] = c * dx - s * dz; out[1] = w[1] - this.position[1]; out[2] = s * dx + c * dz;
    return out;
  }

  // -------------------------------------------------------------------------- linke Hand
  _leftHand(a) {
    const P = this.pose;
    // Gewichte: Bereitschaft (Hals), Aktionskurve (Hals/Griff), Aufschlagwurf (Wurfpunkt)
    let wThroat = this.ready * (1 - smoothstep(1.2, 2.6, Math.hypot(this.vel[0], this.vel[2]) / this.bodyScale));
    let wGrip = 0, wToss = 0, wCatch = 0;
    if (a && a.w > 0) {
      const curveOf = a.kind === 'emote' ? a.E : a.kind === 'serve' && a.sub !== 'swing' ? null : a.A;
      const tr = a.kind === 'emote' ? a.t : a.t - (a.W || 0);
      const throat = curveOf && curveOf.throat ? curve(curveOf.throat, tr) : 0;
      const grip = curveOf && curveOf.grip ? curve(curveOf.grip, tr) : 0;
      wThroat = lerp(wThroat, throat, a.w);
      wGrip = grip * a.w;
      if (a.kind === 'serve' && a.sub !== 'swing') wThroat = 0;
      if (a.kind === 'serve' && a.sub === 'toss') {
        const t = this.serve.t;
        wToss = smoothstep(0.08, SERVE.tossRelease, t) * (1 - smoothstep(SERVE.tossRelease + 0.02, SERVE.tossRelease + 0.25, t)) * a.w;
        const sv = this.serve;
        if (sv.released) wCatch = smoothstep(sv.catchT - 0.35, sv.catchT - 0.05, t) * (1 - smoothstep(sv.catchT + 0.1, sv.catchT + 0.45, t)) * a.w;
      }
    }
    let wStr = 0;
    if (a && a.kind === 'emote' && a.E.strings) wStr = curve(a.E.strings, a.t) * a.w;
    if (wThroat < 0.01 && wGrip < 0.01 && wToss < 0.01 && wCatch < 0.01 && wStr < 0.01) return;
    // Schläger (Modell) aus aktueller Pose
    getBoneModel(this.def, P, 'hand_r', _q0, _v0);
    quat.multiply(_q1, _q0, this.gripRot);                           // Schläger-Rotation (Modell)
    rotV(_v1, _q0, this.gripOff[0], this.gripOff[1], this.gripOff[2]);
    _v1[0] += _v0[0]; _v1[1] += _v0[1]; _v1[2] += _v0[2];            // Griffpunkt
    const wSum = wThroat + wGrip;
    if (wSum > 0.01) {
      const S = this.bodyScale;
      const along = (wThroat * 0.265 + wGrip * 0.085 * S) / wSum;
      rotV(_v2, _q1, 0, along, (wThroat * -0.012) / wSum);
      _v2[0] += _v1[0]; _v2[1] += _v1[1]; _v2[2] += _v1[2];           // linke Faustmitte
      quat.invert(_q2, this.lgripRot); quat.multiply(_q2, _q1, _q2);   // linke Hand-Rotation
      if (wThroat > 0) { qAxis(_q3, 1, 0, 0, -0.5 * wThroat / wSum); quat.multiply(_q2, _q2, _q3); }
      rotV(_v3, _q2, this.lgripOff[0], this.lgripOff[1], this.lgripOff[2]);
      _v2[0] -= _v3[0]; _v2[1] -= _v3[1]; _v2[2] -= _v3[2];            // Handgelenk-Ziel
      const w = clamp(wSum, 0, 1);
      twoBoneIK(this.def, P, 'arm_l', 'forearm_l', 'hand_l', _v2, null, { weight: w, soft: 0.01 });
      if (w > 0.5) {
        // Hand-Rotation setzen (gewichtet)
        getBoneModel(this.def, P, 'hand_l', _q3, _v3);
        quat.slerp(_q3, _q3, _q2, smoothstep(0.5, 1, w));
        twoBoneIK(this.def, P, 'arm_l', 'forearm_l', 'hand_l', _v2, null, { weight: 1, endRot: _q3, soft: 0.01 });
      }
    }
    if (wStr > 0.01) {
      // Applaus auf die Saiten: linke Hand tippt gegen die Schlagfläche
      const tap = 0.5 + 0.5 * Math.cos(TAU * (a.E.tap || 3) * a.t);
      rotV(_v2, _q1, 0, 0.44, 0.035 + 0.075 * tap);
      _v2[0] += _v1[0]; _v2[1] += _v1[1]; _v2[2] += _v1[2];
      getBoneModel(this.def, P, 'hand_l', _q0, _v0);
      rotV(_v3, _q0, this.lgripOff[0], this.lgripOff[1], this.lgripOff[2]);
      _v2[0] -= _v3[0]; _v2[1] -= _v3[1]; _v2[2] -= _v3[2];
      twoBoneIK(this.def, P, 'arm_l', 'forearm_l', 'hand_l', _v2, null, { weight: wStr, keepEndRot: true, soft: 0.01 });
    }
    if (wToss > 0.01 || wCatch > 0.01) {
      const sv = this.serve;
      const tgt = this._toModel(wToss > wCatch ? _ballRel(sv, this, _v3, true) : _ballRel(sv, this, _v3, false), _v2);
      // Ball liegt in den Fingern: Faustmitte etwas unter dem Ball
      getBoneModel(this.def, P, 'hand_l', _q0, _v0);
      rotV(_v1, _q0, this.lgripOff[0], this.lgripOff[1], this.lgripOff[2]);
      const bo = 0.045 * this.bodyScale;
      tgt[0] -= _v1[0]; tgt[1] -= _v1[1] + bo; tgt[2] -= _v1[2];
      twoBoneIK(this.def, P, 'arm_l', 'forearm_l', 'hand_l', tgt, null, { weight: Math.max(wToss, wCatch), keepEndRot: true, soft: 0.01 });
    }
  }

  // -------------------------------------------------------------------------- Blick, Sekundär
  _lookWeight(dt, a) {
    let tw = this.lookOn ? 1 : 0;
    if (a && a.kind === 'emote') tw *= 1 - (a.E.lookOff !== undefined ? a.E.lookOff : 0.7) * a.w;
    if (a && a.kind === 'stroke') { const tr = a.t - a.W; tw *= lerp(1, 0.55, smoothstep(0.08, 0.3, tr) * a.w); }
    if (a && a.kind === 'serve' && a.sub === 'swing') { const tr = a.t - a.W; tw *= 1 - smoothstep(0.05, 0.25, tr) * a.w * 0.8; }
    this.lookW += (tw - this.lookW) * (1 - Math.exp(-dt * 6));
  }
  _applyLook(pose) {
    if (this.lookW < 0.01) return;
    const tm = this._toModel(this.lookTarget, _v0);
    poseLookAt(this.def, pose, tm, { weight: this.lookW * 0.95, weights: [0.06, 0.12, 0.32, 0.5], maxYaw: 1.25, maxPitchUp: 0.75, maxPitchDown: 0.7 });
  }
  /** Augenrichtung (Kopfraum) für face.update. */
  _eyes() {
    if (this.lookW < 0.01) { this._lookDir[0] = 0; this._lookDir[1] = 0; this._lookDir[2] = 1; return; }
    this._toModel(this.lookTarget, _v0);
    getBoneModel(this.def, this.pose, 'head', _q0, _v1);
    _v0[0] -= _v1[0]; _v0[1] -= _v1[1] + 0.09 * this.bodyScale; _v0[2] -= _v1[2];
    quat.invert(_q1, _q0); rotV(this._lookDir, _q1, _v0[0], _v0[1], _v0[2]);
  }

  _secondary(dt, a) {
    const P = this.pose, def = this.def;
    const mood = this.moodT > 0 ? this.mood : (this.ready > 0.75 ? 'focused' : 'neutral');
    this.moodT = Math.max(0, this.moodT - dt);
    this._faceMood = mood;
    if (this.tail) {
      const tm = this.tailMood;
      const tgtH = mood === 'happy' ? 1 : 0, tgtS = mood === 'sad' ? 1 : 0, tgtT = (mood === 'focused' || (a && a.kind === 'stroke')) ? 1 : 0;
      const k = 1 - Math.exp(-dt * 3);
      tm.happy += (tgtH - tm.happy) * k; tm.sad += (tgtS - tm.sad) * k; tm.tense += (tgtT - tm.tense) * k;
      // Basis-Schwanzhaltung (Euler-Additiv)
      for (let j = 0; j < 6; j++) {
        const i = this.bi['tail_' + j];
        const N = TAIL_MOODS.neutral[j], H = TAIL_MOODS.happy[j], Sd = TAIL_MOODS.sad[j];
        let x = N[0] + (H[0] - N[0]) * tm.happy + (Sd[0] - N[0]) * tm.sad;
        let z = N[2] + (H[2] - N[2]) * tm.happy + (Sd[2] - N[2]) * tm.sad;
        // Schwingen / Zucken
        const sway = Math.sin(this.time * 1.7 - j * 0.6) * (3 + j * 1.5) * (1 - tm.sad * 0.7);
        const flick = tm.tense * Math.pow(Math.max(0, Math.sin(this.time * 5.3 - j * 0.9)), 6) * (j >= 3 ? 14 : 4);
        z += sway + flick * (j % 2 ? 1 : -1);
        eulerToQuat(def, i, x, 0, z, _q0);
        P.rot.set(_q0, 4 * i);
      }
      this.tail.update(P, dt, this.model);
    }
    if (this.hasEars) {
      const em = this.earMood;
      const k = 1 - Math.exp(-dt * 6);
      const perk = mood === 'happy' || mood === 'focused' ? 1 : 0, flat = mood === 'sad' ? 1 : 0;
      em.perk += (perk - em.perk) * k; em.flat += (flat - em.flat) * k;
      const tw = this._twitch;
      tw.t -= dt;
      if (tw.t <= 0) { tw.t = 1.5 + 3 * hashT(this.time); tw.side = hashT(this.time * 1.7) < 0.5 ? 0 : 1; tw.a = 1; }
      tw.a = Math.max(0, tw.a - dt * 6);
      for (let s = 0; s < 2; s++) {
        const i = this.bi[s === 0 ? 'ear_l' : 'ear_r'];
        const N = EAR_MOODS.neutral, Pk = EAR_MOODS.perk, F = EAR_MOODS.flat;
        let x = N[0] + (Pk[0] - N[0]) * em.perk + (F[0] - N[0]) * em.flat;
        let y = N[1] + (Pk[1] - N[1]) * em.perk + (F[1] - N[1]) * em.flat;
        let z = N[2] + (Pk[2] - N[2]) * em.perk + (F[2] - N[2]) * em.flat;
        if (tw.side === s) { const tt = Math.sin(tw.a * Math.PI) * 14; x -= tt; z += tt * 0.6; }
        eulerToQuat(def, i, x, y, z, _q0);
        P.rot.set(_q0, 4 * i);
      }
      this.earL.update(P, dt, this.model);
      this.earR.update(P, dt, this.model);
    }
  }

  // -------------------------------------------------------------------------- Cartoon-Sekundärbewegung
  /**
   * Squash & Stretch (Federn um 1: Absprung streckt, Landung/Schritt staucht, wippt nach) und ein träger großer
   * Kopf (nickt bei Schritten, bleibt bei Beschleunigung zurück). Rund um den Ballkontakt ausgeblendet, damit der
   * Schläger exakt trifft.
   */
  _toon(dt, act) {
    if (dt <= 0) return;
    const T = this.toon, S = this.bodyScale, P = this.pose;
    const y = P.t[1] + P.t[4];
    const vy = (y - T.rootY) / dt;
    T.rootY = y;
    const air = P.t[1] > 0.02 * S;
    if (T.air && !air && T.vy < -0.3) { T.sqV -= clamp(-T.vy * 1.8, 0.5, 3.0); T.hxV += clamp(-T.vy * 2.5, 0.5, 4); }   // Landung
    if (!T.air && air) T.sqV += 1.6;                                                                                  // Absprung
    T.air = air; T.vy = vy;
    let calm = 1;
    if (act && (act.kind === 'stroke' || (act.kind === 'serve' && act.sub === 'swing'))) calm = smoothstep(0.05, 0.22, Math.abs(act.tau - act.T));
    const tgt = 1 + clamp(vy * 0.05 / S, -0.07, 0.09) * (air ? 1 : 0.35);
    {
      const w = 16, z = 0.3;
      T.sqV += (-(w * w) * (T.sq - tgt) - 2 * z * w * T.sqV) * dt;
      T.sq = clamp(T.sq + T.sqV * dt, 0.8, 1.2);
    }
    T.squash = 1 + (T.sq - 1) * calm;
    // Kopf: Trägheit gegen die Körperbeschleunigung (Körperrahmen), unterkritisch gedämpft
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const axL = c * this.acc[0] - s * this.acc[2], azL = s * this.acc[0] + c * this.acc[2];
    const tx = clamp(-azL * 0.02, -0.3, 0.3), tz = clamp(axL * 0.018, -0.26, 0.26);
    {
      const w = 12, z = 0.26;
      T.hxV += (-(w * w) * (T.hx - tx) - 2 * z * w * T.hxV) * dt; T.hx = clamp(T.hx + T.hxV * dt, -0.45, 0.45);
      T.hzV += (-(w * w) * (T.hz - tz) - 2 * z * w * T.hzV) * dt; T.hz = clamp(T.hz + T.hzV * dt, -0.4, 0.4);
    }
    const k = 0.35 + 0.65 * calm;
    qAxis(_q0, 1, 0, 0, T.hx * 0.55 * k); postRot(P, this.bi.neck, _q0);
    qAxis(_q0, 1, 0, 0, T.hx * 0.35 * k); postRot(P, this.bi.head, _q0);
    qAxis(_q0, 0, 0, 1, T.hz * 0.5 * k); postRot(P, this.bi.neck, _q0);
    qAxis(_q0, 0, 0, 1, T.hz * 0.4 * k); postRot(P, this.bi.head, _q0);
  }
  /** Squash & Stretch auf die Modellmatrix (volumenerhaltend, Drehpunkt = Füße). */
  _applySquash() {
    const q = this.toon.squash;
    if (Math.abs(q - 1) < 1e-4) return;
    const M = this.model, sx = 1 / Math.sqrt(q);
    M[0] *= sx; M[1] *= sx; M[2] *= sx;
    M[4] *= q; M[5] *= q; M[6] *= q;
    M[8] *= sx; M[9] *= sx; M[10] *= sx;
  }

  // -------------------------------------------------------------------------- Abschluss
  _finish(dt) {
    const sk = this.skel;
    // Gesicht zuerst: setzt die Offsets von Augen/Lidern/Brauen, die gleich in die Anbauteil-Matrizen eingehen
    // (sonst hängt die Mimik ein Bild hinterher)
    if (this.asset.face && dt >= 0) {
      this.asset.face.update(dt, { blink: this.blink, mood: this._faceMood || 'neutral', lookDir: this.lookW > 0.05 ? this._lookDir : null });
    }
    // Anbauteile
    const atts = this.asset.attachments || [];
    for (let k = 0; k < atts.length; k++) {
      const a = atts[k];
      mat4.multiply(_m0, sk.world[this.bi[a.bone]], a.offset);
      mat4.multiply(this.attM[k], this.model, _m0);
    }
    // Schläger
    const gb = this.bi[this.asset.gripSocket.bone];
    mat4.multiply(_m0, sk.world[gb], this.gripM);
    mat4.multiply(this.racketM, this.model, _m0);
    // Kontaktschatten
    if (this.shadow) {
      const U = this.shadowU, F = this.feet.feet;
      const p = this.position;
      mat4.fromTranslation(this.shadowM, [p[0], p[1] + 0.006, p[2]]);
      const sc = 2.2 * this.bodyScale;
      this.shadowM[0] = sc; this.shadowM[10] = sc;
      // Fußmitte (Knöchel-Projektion + halber Fuß)
      for (let i = 0; i < 2; i++) {
        sk.getWorldPos(i === 0 ? 'foot_l' : 'foot_r', _v0, this.model);
        sk.getWorldPos(i === 0 ? 'toe_l' : 'toe_r', _v1, this.model);
        U.u_shFeet[2 * i] = _v0[0]; U.u_shFeet[2 * i + 1] = _v0[2];
        const dx = _v1[0] - _v0[0], dz = _v1[2] - _v0[2], l = Math.hypot(dx, dz) || 1;
        U.u_shDirs[2 * i] = dx / l; U.u_shDirs[2 * i + 1] = dz / l;
        U.u_shLift[i] = Math.max(0, _v0[1] - p[1] - this.geo.ankleH);
      }
      sk.getWorldPos('pelvis', _v0, this.model);
      U.u_shLift[2] = _v0[0]; U.u_shLift[3] = _v0[2];
      U.u_shScale[1] = clamp(1.2 - (_v0[1] - p[1]) / (1.2 * this.bodyScale), 0.2, 1);
    }
  }

  // -------------------------------------------------------------------------- Abfragen
  /** Sweet-Spot des Schlägers (Welt). */
  getRacketSweetSpot(out = new Float32Array(3)) {
    const m = this.racketM, s = this.sweet;
    out[0] = m[0] * s[0] + m[4] * s[1] + m[8] * s[2] + m[12];
    out[1] = m[1] * s[0] + m[5] * s[1] + m[9] * s[2] + m[13];
    out[2] = m[2] * s[0] + m[6] * s[1] + m[10] * s[2] + m[14];
    return out;
  }
  /** Kopfmitte (Welt), folgt Pose, Sprüngen und Ducken. */
  getHeadWorld(out = new Float32Array(3)) {
    mat4.multiply(_m1, this.model, this.skel.world[this.bi.head]);
    const o = this.headOff;
    out[0] = _m1[0] * o[0] + _m1[4] * o[1] + _m1[8] * o[2] + _m1[12];
    out[1] = _m1[1] * o[0] + _m1[5] * o[1] + _m1[9] * o[2] + _m1[13];
    out[2] = _m1[2] * o[0] + _m1[6] * o[1] + _m1[10] * o[2] + _m1[14];
    return out;
  }
  /** Faustmitte links/rechts (Welt). */
  getHandPos(side = 'r', out = new Float32Array(3)) {
    const left = side === 'l';
    const W = this.skel.world[this.bi[left ? 'hand_l' : 'hand_r']];
    const o = left ? this.lgripOff : this.gripOff;
    mat4.multiply(_m1, this.model, W);
    out[0] = _m1[0] * o[0] + _m1[4] * o[1] + _m1[8] * o[2] + _m1[12];
    out[1] = _m1[1] * o[0] + _m1[5] * o[1] + _m1[9] * o[2] + _m1[13];
    out[2] = _m1[2] * o[0] + _m1[6] * o[1] + _m1[10] * o[2] + _m1[14];
    return out;
  }
  /**
   * Position des sichtbaren Balls vor dem Aufschlag (Welt): in der linken Hand, beim Tippen (Bodenkontakt in der
   * Periodenmitte), nach dem Wurf im Flug (senkrecht über dem Wurfpunkt) bis zum Fangen. this.ballInHand = in der Hand.
   */
  heldBallPos(out = new Float32Array(3)) {
    const sv = this.serve, a = this.action;
    this.getHandPos('l', out);
    // Ball sitzt auf den Fingern (Handflächenseite, oben)
    out[1] += 0.035 * this.bodyScale;
    if (!a || a.kind !== 'serve') return out;
    if (a.sub === 'bounce') {
      const P = sv.period, u = ((sv.t % P) + P) % P / P;
      const r = 0.0335;
      const hy = out[1];
      // Ball verlässt die Hand bei u ~ 0.06, Boden bei 0.5, zurück bei 0.94
      if (u > 0.06 && u < 0.94) {
        const v = (u - 0.06) / 0.88;
        out[1] = r + (hy - r) * (2 * v - 1) * (2 * v - 1);
        this.ballInHand = false;
      } else this.ballInHand = true;
      return out;
    }
    if (a.sub === 'toss' && sv.released && !sv.caught) {
      _ballRel(sv, this, out, false);
    }
    return out;
  }

  // -------------------------------------------------------------------------- Replay
  /** Pose + Platzierung + Squash als Float32Array (für Replays). */
  capturePose(out = null) {
    const n = this.def.count;
    const len = 12 + 4 * n;
    if (!out || out.length !== len) out = new Float32Array(len);
    out[0] = this.position[0]; out[1] = this.position[1]; out[2] = this.position[2]; out[3] = this.yaw;
    const st = this.asset.face && this.asset.face.state;
    out[4] = st && typeof st.blink === 'number' ? st.blink : 0;
    for (let k = 0; k < 6; k++) out[5 + k] = this.pose.t[k];
    out.set(this.pose.rot, 11);
    out[11 + 4 * n] = this.toon.squash;                       // Squash & Stretch
    return out;
  }
  /** Gespeicherte Pose anzeigen (ersetzt update() für dieses Bild). */
  applyCapturedPose(arr) {
    this.position[0] = arr[0]; this.position[1] = arr[1]; this.position[2] = arr[2]; this.yaw = arr[3];
    mat4.fromYawTranslation(this.model, this.yaw, this.position);
    this.pose.t.fill(0);
    for (let k = 0; k < 6; k++) this.pose.t[k] = arr[5 + k];
    const nr = this.pose.rot.length;
    this.pose.rot.set(arr.subarray(11, 11 + nr));
    this.skel.update(this.pose);
    const sq = this.toon.squash;
    this.toon.squash = arr.length > 11 + nr ? arr[11 + nr] : 1;
    this._applySquash();
    this.toon.squash = sq;
    const b = this.blink;
    this.blink = arr[4];
    this._finish(0);
    this.blink = b;
    this._fresh = true;   // nach dem Replay Füße neu pflanzen
  }
}

const TAU = Math.PI * 2;
function dist3(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function hashT(x) { const s = Math.sin(x * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); }

/** Ballposition beim Aufschlagwurf (Welt). toss=true: Wurfpunkt bei Release (für IK), sonst Flugbahn jetzt. */
function _ballRel(sv, c, out, toss) {
  if (toss) { out[0] = sv.spot[0]; out[1] = sv.release; out[2] = sv.spot[2]; return out; }
  const t2 = Math.max(0, sv.t - SERVE.tossRelease);
  out[0] = sv.spot[0]; out[2] = sv.spot[2];
  out[1] = Math.max(0.0335, sv.release + sv.v0 * t2 - 0.5 * G * t2 * t2);
  return out;
}

export { STROKE_TYPES };

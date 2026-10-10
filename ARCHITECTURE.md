# Tom & Gerry Open — Architecture & Contracts

This is the binding contract for everyone building this game. Read it fully before writing code.
If you must deviate from an interface, keep the documented one working (adapter) and note the deviation
in your final report. Never silently change another module's contract.

## 0. Vision

A classic, immediately understandable **tennis game** (singles, real rules, real scoring) — the
vertical slice of a premium stylized sports game. Centre-court **grass** final of the fictional
"Tom & Gerry Open" in warm late-afternoon light.

* **Tom** — dark-haired human tennis player, **light-blue (hellblau) shirt**, white shorts.
* **Gerry** — **orange tabby cat**, upright tennis player (white shorts, sweatband, wristbands, real fur).
* **Since prototype 2: chibi proportions in the style of Mario Tennis** (head ~1/3 of the height, big round eyes,
  round bodies, short limbs, big hands/feet/paws; Tom ~1.34 m, Gerry ~1.34 m incl. ears). Lovably clumsy and cute,
  never realistic or scary. Gameplay reach is scaled per character via `PLAYER_STATS[id].reachScale`.

Showcase angle: *everything is generated from code at runtime* — custom WebGL2 engine, SDF-sculpted
skinned characters, shell-rendered fur, procedural stadium & crowd, physically based ball flight
(drag + Magnus + spin-aware bounce), procedural audio, broadcast presentation. **Zero dependencies,
zero asset files, no network.**

Art direction: cartoon characters (see above) inside a believable, richly detailed, softly lit stadium. Warm sun,
soft shadows, saturated-but-tasteful palette: lush striped grass, deep bottle-green surround walls,
cream/white stands, white lines, optic-yellow ball. Tom's light blue and Gerry's orange must pop.
UI language: **German**. Umpire calls: English (authentic tennis).

## 1. Hard rules

1. **No dependencies, no network.** No npm install, no CDN, no fetch of external resources. Plain
   JavaScript ES modules + WebGL2 + WebAudio + DOM. Node ≥ 26 is available for tools/tests.
2. **Work only inside the dev root** `$ROOT` (given in your task). Never write anywhere else except
   temporary files under `/tmp/tg-*`. Do not touch the Google Drive.
3. **Own your files.** Only create/edit files assigned to you. If you need a change in someone else's
   file, describe it in your report (or write an adapter in your own file).
4. **Module syntax restrictions** (a tiny custom bundler will inline everything into one HTML file):
   * imports: only `import { a, b as c } from './rel/path.js';` or `import * as X from './rel/path.js';`
     — static, relative, with `.js` extension. No default imports/exports, no `export … from`,
     no dynamic `import()` inside `src/` (allowed only in `test/scenes/*`), no top-level `await`,
     no `import.meta`, no Web Workers.
   * exports: `export function`, `export class`, `export const/let`, `export { a, b as c }`.
5. **Code style:** modern JS (classes, arrow functions), 2-space indent, semicolons, identifiers in
   English, short comments in German (or English), no giant commented-out blocks. Keep hot paths
   allocation-free (reuse vec3/mat4 temporaries) — the game runs at 60 fps on an Apple M1 MacBook.
6. **No console noise.** No console.log in normal operation (use `if (DEBUG)`), zero errors/warnings.
7. **Units/axes:** meters, seconds, radians. Right-handed, **Y up**. Math via `src/core/math.js`
   (gl-matrix compatible: `vec3.add(out,a,b)`, column-major `mat4`, quats `[x,y,z,w]`).
8. Test what you build (see §12). A module is not done until you have *looked at it* (screenshots)
   or *run it* (node tests) and fixed what you saw.

## 2. Directory layout & ownership

```
index.html                 game page (integration)            dev.html      dev/test scene runner (engine)
serve.mjs                  static server (exists)              tools/shot.mjs headless screenshot tool (exists)
src/core/math.js           math (exists)                       src/core/util.js  Emitter, params, nextFrame (exists)
src/gfx/*                  ENGINE: gl.js renderer.js shaderlib.js materials.js geometry.js post.js sky.js
src/gfx/sdf.js             RIG: SDF modeling + polygonizer + skin weights + AO bake
src/chars/skeleton.js      RIG: skeleton, FK, skin matrices     src/chars/pose.js RIG: poses, clips, blending, IK
src/chars/tom.js           TOM model                           src/chars/racket.js TOM agent (racket models)
src/chars/gerry.js         GERRY model (+ fur material)
src/chars/character.js     ANIM: runtime character (drawables, anim state machine, IK, secondary motion)
src/chars/animlib.js       ANIM: all clips (locomotion, strokes, serve, emotes)
src/sim/court.js ball.js shot.js rules.js   SIM: dimensions, ball physics, shot solver, scoring
src/sim/strokes.js         CONTRACT gameplay⇄animation (exists; values tunable)
src/game/player.js ai.js match.js input.js  GAMEPLAY
src/game/camera.js director.js replay.js    CAMERA/DIRECTOR
src/game/game.js, src/main.js               INTEGRATION
src/world/*                ENV: court surface, net, stadium, crowd, props, scoreboard, ballfx, particles, world.js
src/audio/*                AUDIO
src/ui/*                   UI (ui.js, hud.js, menus.js, ui.css as JS string or <style> injection)
test/*.test.mjs            node tests (each owner writes their own)
test/scenes/<name>.js      dev scenes (each owner writes their own), run via dev.html?scene=<name>
tools/build.mjs            single-file bundler (integration)
```

## 3. Coordinate system & court

* Origin = court centre on the ground. Net along the **X axis** at `z = 0`. Court length along **Z**.
* Baselines `z = ±11.885`. Singles sidelines `x = ±4.115`, doubles `x = ±5.485` (lines drawn, singles played).
  Service lines `z = ±6.40`. Centre service line `x = 0` for `|z| ≤ 6.40`. Centre marks at baselines.
  Lines are 5 cm wide (baseline up to 10 cm), **lines are in** (ball touching line = in).
* Net: height 0.914 m at centre, 1.07 m at the singles sticks `x = ±5.029` (posts at `x = ±6.40`, 1.07 m).
  Net height between: smooth sag, `h(x) = 0.914 + (1.07-0.914) * (x/5.029)^2` for `|x| ≤ 5.029`.
* Player ends: **side +1** = the half with `z > 0`, **side −1** = `z < 0`. A player on side s faces
  the net, i.e. world direction `(0,0,-s)`. Yaw convention: `yaw = 0` faces **+Z**; forward vector
  `(sin yaw, 0, cos yaw)`; the character's **right** is `(-cos yaw, 0, sin yaw)`. Facing −Z ⇒ `yaw = π`.
* Ends change after game 1, 3, 5 … of each set (odd total games), and every 6 points in a tiebreak.
* The human player's camera is always behind the human (camera end flips when ends change).

## 4. Engine (src/gfx) — API contract

```js
import { Renderer } from './gfx/renderer.js';
const r = new Renderer(canvas, { quality: 'high' });        // 'low' | 'medium' | 'high' | 'ultra'
r.gl                                                         // WebGL2RenderingContext
r.q                                                          // resolved quality settings object (see below)
r.createMesh(meshData) -> Mesh                               // GPU mesh, see §4.1
r.updateMesh(mesh, { positions?, normals?, colors?, uvs?, data?, indices?, count? })  // dynamic meshes
r.createInstances(capacity) -> Instances                     // per instance: mat4 + color(vec4) + data(vec4)
   inst.set(i, mat4, color?, data?); inst.count = n; inst.dirty = true (upload happens in render)
r.createTexture(src, opts?) -> Texture   // src: HTMLCanvasElement | ImageData | {width,height,data:Uint8Array|Float32Array}
   opts: { filter:'linear'|'nearest', wrap:'repeat'|'clamp', mipmaps:true, srgb:false, anisotropy:8 }
r.updateTexture(tex, src)
r.createMaterial(def) -> Material                            // §4.2
r.render(scene, camera)                                      // §4.3
r.worldToScreen(camera, worldPos) -> { x, y, visible }       // CSS pixels, for UI anchoring
r.setQuality(name); r.stats -> { fps, frameMs, drawCalls, triangles, renderScale }
r.onContextLost / automatic resize via ResizeObserver; dynamic resolution keeps ~60 fps
```

`r.q` (quality settings, read by content builders): `{ name, dprCap, msaa, shadowSize, shadowCascades,
ssao, bloom, dof, furShells, grassShells, crowdDensity (0..1), particleScale }`.
Presets: low (dpr 1, no msaa→FXAA, shadow 1024×1, furShells 8, crowd 0.35), medium (dpr 1.5, msaa 4,
2048×1, furShells 14, crowd 0.65), high (dpr 2, msaa 4, 2048×2 cascades, ssao, furShells 20, crowd 1),
ultra (high + 4096 shadows + dof). Default for the game: 'high' with dynamic resolution (0.6–1.0).

### 4.1 Mesh data (CPU)

```js
{ positions: Float32Array(3n), normals: Float32Array(3n),        // required
  uvs?: Float32Array(2n), colors?: Float32Array(4n) /*linear RGBA*/, data?: Float32Array(4n) /*custom*/,
  joints?: Uint8Array|Uint16Array(4n), weights?: Float32Array(4n), // skinning (max 4 influences)
  indices: Uint16Array|Uint32Array, dynamic?: boolean }
```
`src/gfx/geometry.js` provides builders returning mesh data: `box, plane(w,d,segX,segZ), sphere,
capsule, cylinder, cone, torus, lathe(profile), tube(path, radiusFn), extrude(shape2d, depth),
quad, merge([meshData,…]), transform(meshData, mat4), computeNormals(meshData), setColor(meshData,rgba)`.

### 4.2 Materials — "surface shaders"

```js
r.createMaterial({
  name: 'gerry-fur',
  uniforms: { u_baseColor: [1, .45, .1], u_furLen: 0.02, u_noiseTex: tex },  // float | vec2-4 | mat4 | Texture
  vertex: `void vertexObject(inout vec3 p, inout vec3 n) { p += n * g_shell * u_furLen; }`, // optional
  surface: `void surface(in SurfaceInput i, inout Surface s) { s.albedo = u_baseColor; }`,   // optional
  alphaTest: 0.5,          // optional: discard if s.alpha < alphaTest (also in shadow pass)
  blend: 'none'|'alpha'|'additive'|'multiply',  cull: 'back'|'front'|'none',  depthWrite: true,
  unlit: false,            // true: output = s.albedo + s.emissive, no lighting/shadows
  castShadow: true, shadowShells: false, defines: { NAME: '1' },
});
```
Vertex hooks (optional, detected by name): `void vertexObject(inout vec3 p, inout vec3 n)` runs in
object/bind space **before** skinning & instancing; `void vertexWorld(inout vec3 wp, inout vec3 wn)`
runs after the model matrix. Globals usable in vertex hooks: `g_shell` (0..1, shell height; 0 when not
shelled), `g_instColor`, `g_instData` (vec4, per-instance), `a_uv`, `a_color`, `a_data`
(attributes; defaults uv 0, color 1, data 0), `gl_InstanceID`, `gl_VertexID`.

Fragment hook:
```glsl
struct SurfaceInput {
  vec3 worldPos; vec3 normal;      // world, normalized (flipped toward viewer for double-sided)
  vec3 objPos;  vec3 objNormal;    // object/bind-pose space, BEFORE skinning (stable patterns on characters)
  vec2 uv; vec4 color; vec4 data;  // vertex attributes
  vec4 instColor; vec4 instData;   // per-instance
  float shell;                     // 0..1 (0 = base layer or non-shell)
  vec3 viewDir;                    // surface -> camera, normalized
  float time; vec2 fragCoord;      // seconds; gl_FragCoord.xy
};
struct Surface {
  vec3 albedo; float alpha;        // linear albedo; init u_baseColor*vertexColor (if defined) else 0.8
  vec3 normal;                     // world normal, init i.normal (perturb freely)
  float roughness; float metalness; float specular;  // init 0.6, 0, 0.5
  vec3 emissive; float ao;         // init 0, 1
  float subsurface; vec3 subsurfaceColor;  // wrap lighting for skin/ears (init 0, (1,.3,.2))
  float sheen; vec3 sheenColor;            // rim sheen for cloth/fur (init 0, (1,1,1))
};
```
Common uniforms everywhere: `u_time, u_cameraPos, u_view, u_proj, u_viewProj, u_model, u_sunDir,
u_sunColor, u_cameraRight, u_cameraUp, u_resolution`. GLSL helper library (always included):
`saturate, remap, hash11/12/13/22/33, noise2, noise3 (value), snoise2/3 (simplex), fbm2(p,oct),
fbm3(p,oct), voronoi2 (returns vec2(F1, cellId)), rotate2d, srgbToLinear, luminance,
bumpNormal(vec3 n, vec3 worldPos, float height, float strength)` (screen-derivative bump).
Shading model: GGX specular + Lambert/wrapped diffuse, sun with soft PCF shadows (cascaded),
hemisphere ambient (sky/ground) + procedural-sky-based specular ambient, SSAO, fog, all in linear HDR.

### 4.3 Scene & camera

```js
camera = { position: vec3, target: vec3, up: [0,1,0], fov: 0.75 /*vertical rad*/, near: 0.1, far: 600,
           dof: null | { focus: 12, aperture: 0.6 } }   // renderer fills camera.view, .proj, .viewProj
scene = {
  drawables: [Drawable],
  sun:  { dir: vec3 /*unit, ground→sun*/, color: [r,g,b], intensity: 4.0 },
  hemi: { sky: [r,g,b], ground: [r,g,b], intensity: 1.0 },
  sky:  { /* engine-defined params for procedural sky: zenith, horizon, sunGlow, clouds … */ },
  fog:  { color: [r,g,b], density: 0.002, heightFalloff: 0.05 },
  shadow: { center: vec3, radius: 16 },   // tight cascade around the action (court+players)
  exposure: 1.0,
  post: { bloom: 0.5, bloomThreshold: 1.0, vignette: 0.25, saturation: 1.05, contrast: 1.05,
          grain: 0.03, temperature: 0.0, lift: [0,0,0], gain: [1,1,1] },
  time: seconds,
}
Drawable = { mesh, material, model?: mat4, bones?: Float32Array /*n*16, model-space skin matrices*/,
             instances?: Instances, shells?: int, uniforms?: { name: value },
             castShadow?: true, receiveShadow?: true, visible?: true, pass?: 'opaque'|'transparent',
             order?: 0, bounds?: { center, radius } }
```
Skinning: up to 64 bones; `bones` = `boneModelMatrix * inverseBindMatrix` per bone (model space);
`model` then places the character in the world. `shells > 0` draws the mesh `shells` times via
instancing (`g_shell = id/(shells-1)`), not combinable with `instances`.

## 5. Characters

### 5.1 Skeleton (src/chars/skeleton.js)

Fixed humanoid bone set (indices in this order), all characters share it; extras appended per character:
```
0 root(-1)  1 pelvis(0)  2 spine(1)  3 chest(2)  4 neck(3)  5 head(4)
6 shoulder_l(3) 7 arm_l(6) 8 forearm_l(7) 9 hand_l(8)
10 shoulder_r(3) 11 arm_r(10) 12 forearm_r(11) 13 hand_r(12)
14 thigh_l(1) 15 shin_l(14) 16 foot_l(15) 17 toe_l(16)
18 thigh_r(1) 19 shin_r(18) 20 foot_r(19) 21 toe_r(20)
extras e.g. Gerry: tail_0..tail_5 (chain from pelvis), ear_l, ear_r (from head)
```
* Rest pose: standing upright, facing **+Z**, feet on y = 0, **arms in a relaxed A-pose** (~45° down
  from horizontal, slightly forward). Character's **left = +X**, right = −X (bones `_l` at +X).
* All rest-pose bone orientations are **identity**; a skeleton definition is just joint positions
  in model space: `defineSkeleton({ joints: { pelvis: [0, 0.98, 0], … }, extras: [{ name, parent, pos }] })`.
  Local rotations (quats) are applied about the joint, in the parent's frame.
* API: `skel.boneIndex(name)`, `skel.pose` (local rotations + root/pelvis translation), `skel.update()`
  (computes `skel.world[i]` mat4 and `skel.skin` Float32Array for the renderer),
  `skel.getWorldPos(name, out)`, `skel.restPos(name)`.

### 5.2 Poses & clips (src/chars/pose.js)

`createPose(skel)`, `copyPose`, `blendPose(out, a, b, t)`, `addPose(out, base, additive, w)`,
`poseFromEuler(skel, { arm_r: [x, y, z] /*deg*/, …, pelvisOffset: [x,y,z] })`, `mirrorPose(skel, out, src)`,
clips `{ duration, loop, keys: [{ t, pose: {bone: [x,y,z]}, ease }], events: [{ t, name }] }` with
`sampleClip(skel, clip, time, outPose)`, bone masks for layering, `twoBoneIK(skel, pose, upper, lower,
end, targetModelPos, poleModelPos)`, `aimBone(...)` for head look-at.

### 5.3 SDF modeling (src/gfx/sdf.js)

Characters are sculpted as signed distance fields from primitives (sphere, ellipsoid, capsule,
roundCone, roundBox, torus, …) combined with smooth unions/subtractions. Each primitive carries
`bone` (skin binding) and `mat` (material/colour id). `polygonize(sdf, { bounds, cell })` produces
a smooth indexed mesh (surface nets / dual contouring, normals from the SDF gradient) with
`joints/weights` (smooth blend over nearby primitives' bones), `colors` (via paint callback), and
`data = [matId, bakedAO, curvature?, 0]`. Must be fast (sparse/narrow-band evaluation): a full
character at ~8–10 mm cells in well under 1 s on an M1.

### 5.4 Character asset (tom.js / gerry.js export) — consumed by character.js

```js
export function buildTom(renderer, q) -> CharacterAsset   // gerry.js: buildGerry(renderer, q)
CharacterAsset = {
  id: 'tom', name: 'Tom',
  skeletonDef,                       // joints + extras (see 5.1)
  parts: [ { mesh, material, skinned: true, shells?: n, castShadow?: true } ],   // skinned body parts
  attachments: [ { bone: 'head', mesh, material, offset: mat4 /*bone-local*/ , name } ], // eyes, lids, whiskers…
  gripSocket: { bone: 'hand_r', offset: [x,y,z] },   // fist centre in hand-bone local space (rest frame)
  leftHandGrip?: { bone: 'hand_l', offset },         // for two-handed moments (optional)
  face?: { update(dt, { blink: 0..1, mood: 'neutral'|'happy'|'focused'|'sad', lookDir }) },
  secondary?: { tail: ['tail_0', …], ears: ['ear_l','ear_r'] },
  racketStyle: { frame: [r,g,b], accent: [r,g,b], grip: [r,g,b] },
  heightM: 1.80,
}
```
Racket (src/chars/racket.js): `buildRacket(renderer, style) -> { parts:[{mesh, material}], sweetSpot: [0, 0.50, 0] }`.
Racket local frame: origin = grip point (where the fist holds it), **+Y along the shaft towards the
head**, string plane = local XY plane (face normal ±Z). Length ≈ 0.685 m, head ≈ 0.29 × 0.25 m.

### 5.5 Character runtime (src/chars/character.js) — used by the game

```js
const c = new Character(renderer, asset, racket);
c.position (vec3, feet/root on ground), c.yaw
c.setLocomotion(velWorld /*vec3*/, ready /*0..1 crouch/alertness*/)
c.playStroke(type /*STROKES key*/, { timeToContact, contactWorld /*vec3*/, shot, power })  // contact exactly then
c.playServe(phase, opts)   // 'idle' | 'bounce' | 'toss' | 'swing' (swing has timeToContact) | 'follow'
c.playEmote(name)          // 'fistpump' 'celebrate' 'jump' 'dejected' 'shrug' 'wave' 'clap' 'bow' 'catch_ball'
c.lookAt(worldPos | null)
c.update(dt)               // animation, IK, secondary motion, blink; fills drawables
c.drawables                // [Drawable] incl. racket and a soft contact-shadow decal
c.getRacketSweetSpot(out)  // world
c.capturePose() -> Float32Array;  c.applyCapturedPose(arr)   // replays
c.events                   // array of { type: 'footstep', foot, pos } since last update (drain)
```

## 6. Simulation (src/sim) — renderer-independent, deterministic, node-testable

* `court.js`: constants (`COURT`), `netHeightAt(x)`, `isInSingles(x,z)`, `inServiceBox(x, z, serverSide, box /*'deuce'|'ad'*/)`, `lineDistance(...)` (for close-call/Hawk-Eye).
* `ball.js`: `class Ball { pos, vel, spin /*angular vel rad/s vec3*/, step(dt) -> events[] }` with gravity,
  quadratic drag, Magnus lift, spin decay; bounce model with friction & spin (grass: lower, skiddier);
  net collision (net cord deflection, ball can dribble over), posts; events `bounce {pos, vel}`,
  `net {pos, cord}`. `predict(ball, tMax, dt) -> samples` and helpers to find bounce/height crossings.
* `shot.js`: `solveShot({ from, target /*landing x,z*/, spin, netClearance | speed }) -> { vel, spin }`
  (shooting method using the same integrator), plus shot presets (topspin, flat, slice, lob, drop,
  serve flat/kick/slice) giving speed/spin/clearance ranges.
* `rules.js`: `class Score` — points/games/sets/tiebreak, deuce/advantage, server rotation incl.
  tiebreak, serve box (deuce/ad), ends changes, `view()` for UI, `call()` umpire text
  ("Fifteen–Love", "Deuce", "Advantage Tom", "Game, Gerry", "Game and first set, Tom", "Game, set and
  match, Tom"), flags (breakPoint, setPoint, matchPoint, tiebreak), stats accumulation helpers.
  Formats: `{ sets: 1|3, games: 6, tiebreakAt: 6, shortTiebreak: 7, superTiebreakOnly?: false, startGames?: [a,b] }`.

Physics constants: g = 9.81; ball m = 0.057 kg, r = 0.0335 m; ρ = 1.21; Cd ≈ 0.55;
C_L ≈ 1/(2 + v/(r|ω|)); sim at **fixed 120 Hz**.

## 7. Gameplay (src/game: player.js, ai.js, match.js, input.js)

`Match` is pure logic (no DOM/WebGL), steppable in node:
```js
const m = new Match({ players: ['tom','gerry'], humans: [0] /*indices driven by input*/, format, difficulty, seed });
m.step(dt, inputs /* [PlayerInput, PlayerInput] — AI-controlled slots ignore theirs */);
m.state    // { phase, ball:{pos,vel,spin,visible,held}, players:[PlayerState], score:Score, server, ... }
m.drainEvents() -> [GameEvent]
PlayerInput = { move: [x, z] /*world-space desired dir, |v|<=1*/, aim: [lr, depth] /*-1..1 from hitter's view*/,
                buttons: { topspin, slice, lob, drop } /*held booleans*/, skip: bool }
PlayerState = { id, pos, vel, yaw, side, mode, stroke /*null|{type, shot, start, windup, contact:vec3}*/,
                emote, charge, serveMeter, ... }
```
Phases: `pre_serve` (walk to position, ball bounces) → `serve` (toss/meter) → `rally` → `point_over`
(≈2 s, emotes) → `between_points` (walk back; replays may run here) → … `change_ends` → `match_over`.
Game events (drained by game.js and routed to audio/ui/world/director):
`stroke_start {player, type, shot, windup, contact, power}`, `hit {player, type, shot, quality:
'perfect'|'good'|'early'|'late'|'stretch'|'frame', speed, spin, pos}`, `serve_toss`, `bounce {pos, in,
speed}`, `net {pos, cord}`, `let`, `fault {n}`, `double_fault`, `line_call {call:'out'|'fault', pos}`,
`point {winner, reason: 'ace'|'service_winner'|'winner'|'forced_error'|'unforced_error'|'double_fault'|'net'|'out'|'double_bounce', rally, closeCall}`,
`game`, `set`, `match`, `change_ends`, `serve_speed {kmh}`, `pressure {kind:'break_point'|'set_point'|'match_point'}`.

Feel: Virtua-Tennis-style — press shot button early to charge (more power/precision), the swing
fires automatically when the ball arrives; direction held at contact aims (left/right, deep/short);
gentle movement assist toward the ideal contact position; forehand/backhand/volley/smash chosen
automatically. Serve: press = toss, press again = hit (timing meter), direction aims.
Keyboard: move WASD/arrows; J/Space = topspin, K = slice, L = lob, I = drop; Esc/P = pause.
Gamepad: stick + A/B/Y/X, Start. AI uses the same PlayerInput; difficulty easy/normal/hard.

## 8. Camera, director, replay (src/game/camera.js, director.js, replay.js)

Broadcast camera behind/above the human's baseline (classic TV angle: ~ y 7–9 m, ~ 8–10 m behind
baseline, looking down the court), smoothly following ball/player laterally, never nauseating.
Cinematics: stadium flyover (title), player intros, between-point close-ups with DoF, change-of-ends
shots, slow-motion replays of great points from alternative angles, Hawk-Eye close-call view,
match-end celebration. Replay = per-frame recording of ball pos + `capturePose()` of both characters.

## 9. World (src/world) — env agent

`buildWorld(renderer, { onProgress }) -> World` with `world.drawables`, `world.sceneSettings`
(sun, hemi, sky, fog, exposure, post), `world.update(dt, { time, ballPos, events, excitement })`,
`world.crowd.react(kind /*'applause'|'ooh'|'cheer'|'standing'|'wave'|'quiet'*/, intensity)`,
`world.scoreboard.set(scoreView)`, `world.net.impulse(pos, strength)`, `world.marks.add(pos)`,
`world.fx.emit(kind /*'grass'|'chalk'|'dust'|'netShake'*/, pos, vel?)`,
`world.ball` = BallVisual `{ update(dt, ballState), drawables }` (felt shader, trail ribbon,
contact shadow), `world.anchors` (named camera positions/targets for cinematics),
`world.umpire.lookAt(pos)`.

## 10. Audio (src/audio) & UI (src/ui)

Audio: `const audio = new AudioSystem(); audio.unlock()` on first gesture; `audio.handle(event, ctx)`
consumes GameEvents directly; `audio.update(dt, { listenerPos, listenerDir, excitement })`;
`audio.crowd.react(kind, intensity)`; `audio.umpire.say(text)` (speechSynthesis, en-GB, graceful
fallback); `audio.ui(name)`; `audio.setVolume('master'|'sfx'|'crowd'|'voice', v)`; `audio.mute(bool)`.

UI (DOM overlay over the canvas, German text): `const ui = new UI(rootEl)`;
`ui.loader.set(p, label)`, `ui.loader.hide()`; `ui.showTitle(settings, { onStart, onChange })`;
`ui.hideTitle()`; `ui.hud.show()/hide()`, `ui.hud.setPlayers([{name, color}, …])`,
`ui.hud.update(scoreView)`, `ui.hud.serveSpeed(kmh)`, `ui.hud.serveMeter(v|null)`,
`ui.hud.charge(playerIdx, v|null)`, `ui.banner(title, sub, kind)`, `ui.toast(text)`,
`ui.showPause({ onResume, onRestart, onQuit, settings, onChange })`, `ui.hidePause()`,
`ui.showMatchEnd(stats, { onRematch, onMenu })`, `ui.showControls()`, `ui.fade(toBlack, ms) -> Promise`.

## 11. Integration (src/main.js, src/game/game.js, index.html)

`main.js`: create canvas + Renderer + UI + AudioSystem → build world, characters, rackets with
loader progress → `new Game(...)` → RAF loop: fixed-step `match.step` at 120 Hz (scaled by game
speed / slow-mo), characters/world/camera update per frame, `renderer.render`. Debug hooks on
`window.__TG` (state, setPhase, forceScore, demo mode, perf). URL params: `?demo=1` (AI vs AI
attract mode), `?quality=low|medium|high|ultra`, `?seed=N`, `?skip=1` (skip title), `?player=tom|gerry`.

## 12. Testing

* Dev server: `http://127.0.0.1:8123/` serves `$ROOT` (restart with `node serve.mjs &` in `$ROOT` if down;
  check with `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8123/serve.mjs`).
* Screenshots + console: `node tools/shot.mjs "/dev.html?scene=<name>&…" --out /tmp/tg-<you>-x.png --wait 3000`
  then **look at the PNG with the Read tool**. Exit code 2 = page errors (fix them). Options: `--size`,
  `--eval "<js>"`, `--shots N --interval ms`, `--until "<js truthy>"`. GPU is a real Apple M1.
* Dev scenes: `dev.html?scene=<name>` imports `test/scenes/<name>.js` exporting `async function run(ctx)`
  with `ctx = { renderer, canvas, params, devkit }`. `devkit` (engine) provides an orbit camera
  (URL `cam=dist,yawDeg,pitchDeg,targetY`), a default lit scene (sun/sky/ground) and the render loop
  (`devkit.start({ scene, camera, update(dt,t) })`); `&t=<seconds>` freezes time for deterministic shots.
* Node tests: `node test/<name>.test.mjs` (plain asserts, print summary, exit 1 on failure).
* Screenshots are memory-heavy: run them sequentially, keep `--size 1280x720` unless needed.

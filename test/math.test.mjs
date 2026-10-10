import { vec3, quat, mat4, mat3, makeRng, smoothDamp, DEG } from '../src/core/math.js';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } };
const near = (a, b, e = 1e-4) => Math.abs(a - b) < e;
// quat rotateY 90 maps +Z to +X
const q = quat.rotateY(quat.create(), quat.create(), Math.PI / 2);
const v = vec3.transformQuat(vec3.create(), [0, 0, 1], q); ok(near(v[0], 1) && near(v[2], 0), 'rotY +Z->+X ' + vec3.str(v));
// fromEuler(0,90,0) equals rotateY 90
const qe = quat.fromEuler(quat.create(), 0, 90, 0); ok(near(Math.abs(quat.dot(qe, q)), 1), 'fromEuler y');
// fromEuler x: rotate +Y by 90 about X -> +Z
const qx = quat.fromEuler(quat.create(), 90, 0, 0); const vx = vec3.transformQuat(vec3.create(), [0, 1, 0], qx); ok(near(vx[2], 1), 'fromEuler x ' + vec3.str(vx));
// mat4 fromRotationTranslation & invert
const m = mat4.fromRotationTranslationScale(mat4.create(), q, [1, 2, 3], 2); const mi = mat4.invert(mat4.create(), m); const id = mat4.multiply(mat4.create(), m, mi);
ok(near(id[0], 1) && near(id[5], 1) && near(id[12], 0), 'invert');
// fromYawTranslation equals rotation by quat yaw
const my = mat4.fromYawTranslation(mat4.create(), Math.PI / 2, [0, 0, 0]); const p = vec3.transformMat4(vec3.create(), [0, 0, 1], my); ok(near(p[0], 1), 'yawTranslation ' + vec3.str(p));
// fromYaw quat
const qy = quat.fromYaw(quat.create(), Math.PI / 2); ok(near(Math.abs(quat.dot(qy, q)), 1), 'fromYaw');
// lookAt: camera at (0,5,10) looking at origin: origin maps to -Z in view
const V = mat4.lookAt(mat4.create(), [0, 5, 10], [0, 0, 0], [0, 1, 0]); const o = vec3.transformMat4(vec3.create(), [0, 0, 0], V); ok(near(o[0], 0) && o[2] < 0, 'lookAt');
// targetTo: +Z points to target
const T = mat4.targetTo(mat4.create(), [0, 0, 0], [3, 0, 0]); const tz = vec3.transformDirMat4(vec3.create(), [0, 0, 1], T); ok(near(tz[0], 1), 'targetTo');
// fromForwardUp
const qf = quat.fromForwardUp(quat.create(), [1, 0, 0]); const fz = vec3.transformQuat(vec3.create(), [0, 0, 1], qf); ok(near(fz[0], 1), 'fromForwardUp ' + vec3.str(fz));
// getRotation roundtrip
const gr = mat4.getRotation(quat.create(), m); ok(near(Math.abs(quat.dot(gr, q)), 1), 'getRotation');
// rotationTo
const rt = quat.rotationTo(quat.create(), [0, 1, 0], [1, 0, 0]); const r1 = vec3.transformQuat(vec3.create(), [0, 1, 0], rt); ok(near(r1[0], 1), 'rotationTo');
// normalFromMat4
const nm = mat3.normalFromMat4(mat3.create(), m); ok(nm && near(Math.hypot(nm[0], nm[1], nm[2]), 0.5), 'normalFromMat4');
// rng determinism
const a = makeRng(42), b = makeRng(42); ok(a() === b() && a() === b(), 'rng');
// smoothDamp converges
let x = 0, st = { v: 0 }; for (let i = 0; i < 600; i++) x = smoothDamp(x, 10, st, 0.2, 1 / 120); ok(near(x, 10, 1e-2), 'smoothDamp ' + x);
// vec3.rotateY consistent with quat rotateY
const ry = vec3.rotateY(vec3.create(), [0, 0, 1], [0, 0, 0], Math.PI / 2); ok(near(ry[0], 1), 'vec3.rotateY ' + vec3.str(ry));
console.log(fails ? `${fails} failures` : 'math ok');

// 68 V2/V3/V5 — the PURE half of Film mode (phone virtual camera).
//
// Imports nothing (the unit-layer entry rule): quaternion maths as plain [x, y, z, w]
// arrays, the sensor → camera orientation (screen-orientation aware), recentre and horizon
// lock, the One-Euro filter, the thumbstick / up-down movement, lens ↔ FOV, and the take
// sample record. filmMode.js owns the stores, the sensors and the per-frame driver.
//
// FRAMES. three's world is Y-up, -Z forward. A phone reports its rotation in the Earth
// frame (x east, y north, z up). T = Rx(-90°) maps that frame onto three's, and the same
// rotation turns the device's own frame so the camera looks out of the BACK of the phone:
//   q_cam = Rx(-90°) · q_device · Rz(-screenAngle)
// (q_device = Rz(alpha) · Rx(beta) · Ry(gamma) for DeviceOrientation, or the
// RelativeOrientationSensor quaternion, which is the same rotation). A phone lying flat,
// screen up, therefore films straight down; held upright in portrait it films the horizon.

const D2R = Math.PI / 180;

/** @typedef {number[]} Quat [x, y, z, w] */
/** @typedef {number[]} Vec3 [x, y, z] */

export const IDENTITY = Object.freeze([0, 0, 0, 1]);

/** @param {number[]} axis unit @param {number} rad @returns {Quat} */
export function quatAxisAngle(axis, rad) {
	const s = Math.sin(rad / 2);
	return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(rad / 2)];
}

/** a · b (apply b first, then a). @param {Quat} a @param {Quat} b @returns {Quat} */
export function quatMul(a, b) {
	const [ax, ay, az, aw] = a;
	const [bx, by, bz, bw] = b;
	return [
		aw * bx + ax * bw + ay * bz - az * by,
		aw * by - ax * bz + ay * bw + az * bx,
		aw * bz + ax * by - ay * bx + az * bw,
		aw * bw - ax * bx - ay * by - az * bz
	];
}

/** @param {Quat} q @returns {Quat} */
export function quatConj(q) {
	return [-q[0], -q[1], -q[2], q[3]];
}

/** @param {Quat} q @returns {Quat} */
export function quatNorm(q) {
	const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
	return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Rotate a vector by a unit quaternion. @param {Quat} q @param {Vec3} v @returns {Vec3} */
export function quatRotate(q, v) {
	const [x, y, z, w] = q;
	// t = 2 * cross(q.xyz, v); v' = v + w t + cross(q.xyz, t)
	const tx = 2 * (y * v[2] - z * v[1]);
	const ty = 2 * (z * v[0] - x * v[2]);
	const tz = 2 * (x * v[1] - y * v[0]);
	return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

const X = [1, 0, 0];
const Y = [0, 1, 0];
const Z = [0, 0, 1];
/** Rx(-90°): the Earth frame (z up) → three's (y up), and the device's back → the camera's -Z */
const WORLD_FIX = quatAxisAngle(X, -Math.PI / 2);

/**
 * The device rotation from DeviceOrientation angles (degrees, the W3C Z-X'-Y'' intrinsic
 * order). @param {number} alpha @param {number} beta @param {number} gamma @returns {Quat}
 */
export function deviceQuatFromAngles(alpha, beta, gamma) {
	const qa = quatAxisAngle(Z, (Number(alpha) || 0) * D2R);
	const qb = quatAxisAngle(X, (Number(beta) || 0) * D2R);
	const qg = quatAxisAngle(Y, (Number(gamma) || 0) * D2R);
	return quatMul(quatMul(qa, qb), qg);
}

/**
 * The camera orientation in three's world for a device rotation and the screen's
 * orientation angle (0 / 90 / 180 / 270, `screen.orientation.angle`).
 * @param {Quat} deviceQ @param {number} [screenAngleDeg] @returns {Quat}
 */
export function cameraQuatFromDevice(deviceQ, screenAngleDeg = 0) {
	const screen = quatAxisAngle(Z, -(Number(screenAngleDeg) || 0) * D2R);
	return quatNorm(quatMul(quatMul(WORLD_FIX, deviceQ), screen));
}

/** Convenience: DeviceOrientation angles + screen angle → camera quaternion.
 * @param {number} alpha @param {number} beta @param {number} gamma @param {number} [screenAngleDeg] */
export function cameraQuatFromAngles(alpha, beta, gamma, screenAngleDeg = 0) {
	return cameraQuatFromDevice(deviceQuatFromAngles(alpha, beta, gamma), screenAngleDeg);
}

/** The camera's forward (-Z) in world space. @param {Quat} q @returns {Vec3} */
export function forwardOf(q) {
	return quatRotate(q, [0, 0, -1]);
}

/** Yaw (radians, about +Y) of an orientation's forward, 0 = looking down -Z. @param {Quat} q */
export function yawOf(q) {
	const f = forwardOf(q);
	return Math.atan2(-f[0], -f[2]);
}

/**
 * The yaw offset that makes `sensorQ` face the same compass direction as `targetQ` —
 * RECENTRE. Only yaw: gravity (pitch and roll) stays true, so the horizon is never tilted
 * by a recentre. @param {Quat} sensorQ @param {Quat} targetQ @returns {Quat}
 */
export function recentreOffset(sensorQ, targetQ) {
	return quatAxisAngle(Y, yawOf(targetQ) - yawOf(sensorQ));
}

/**
 * Remove the roll: the same forward direction with the camera's up kept in the vertical
 * plane (HORIZON LOCK). Looking straight up/down keeps the incoming orientation.
 * @param {Quat} q @returns {Quat}
 */
export function levelHorizon(q) {
	const f = forwardOf(q);
	const flat = Math.hypot(f[0], f[2]);
	if (flat < 1e-4) return q.slice();
	const yaw = Math.atan2(-f[0], -f[2]);
	const pitch = Math.atan2(f[1], flat);
	return quatNorm(quatMul(quatAxisAngle(Y, yaw), quatAxisAngle(X, pitch)));
}

/** The roll angle (degrees) of an orientation relative to its levelled self — the level bubble. @param {Quat} q */
export function rollOf(q) {
	const lv = levelHorizon(q);
	const d = quatMul(quatConj(lv), q); // the residual is a rotation about local Z
	// withRoll applies Rz(-deg), so the dial's sign is the negated residual angle
	const ang = -2 * Math.atan2(d[2], d[3]);
	let deg = (ang * 180) / Math.PI;
	if (deg > 180) deg -= 360;
	if (deg < -180) deg += 360;
	return deg;
}

/** Add a dutch roll (degrees about the camera's own -Z axis, positive = clockwise as seen). @param {Quat} q @param {number} deg */
export function withRoll(q, deg) {
	if (!deg) return q.slice();
	return quatNorm(quatMul(q, quatAxisAngle(Z, -deg * D2R)));
}

/**
 * The full Film orientation: yaw offset (recentre) · sensor, optionally levelled, plus the
 * dutch roll dial. @param {Quat} sensorQ @param {{offset?: Quat, horizonLock?: boolean, roll?: number}} opts
 */
export function filmOrientation(sensorQ, opts = {}) {
	let q = opts.offset ? quatMul(opts.offset, sensorQ) : sensorQ.slice();
	if (opts.horizonLock) q = levelHorizon(q);
	return quatNorm(withRoll(q, opts.roll ?? 0));
}

/**
 * Pan / tilt only (TRIPOD rig): the orientation's yaw and pitch, no roll — the same thing a
 * fluid head allows. Position is locked by the caller.
 * @param {Quat} q
 */
export function tripodOrientation(q) {
	return levelHorizon(q);
}

/**
 * The orientation that keeps `target` framed from `pos` (TRACK-A-TARGET), with the framing
 * OFFSET kept as the rotation from the look-at to the camera when tracking began.
 * @param {Vec3} pos @param {Vec3} target @param {Quat} [offset] @returns {Quat}
 */
export function lookAtQuat(pos, target, offset) {
	const dx = target[0] - pos[0];
	const dy = target[1] - pos[1];
	const dz = target[2] - pos[2];
	const flat = Math.hypot(dx, dz);
	if (flat < 1e-6 && Math.abs(dy) < 1e-6) return offset ? offset.slice() : IDENTITY.slice();
	const yaw = Math.atan2(-dx, -dz);
	const pitch = Math.atan2(dy, flat);
	const q = quatMul(quatAxisAngle(Y, yaw), quatAxisAngle(X, pitch));
	return quatNorm(offset ? quatMul(q, offset) : q);
}

// ---- movement (V3: thumbstick + up/down) ------------------------------------------

/**
 * One frame of thumbstick flying: the stick moves along the camera's forward and right
 * PROJECTED ON THE FLOOR (looking down does not dig into the ground), up/down along world Y.
 * @param {Vec3} pos @param {Quat} q @param {{x: number, y: number}} stick -1..1 (y up = forward)
 * @param {number} lift -1..1 @param {number} speed m/s @param {number} dt seconds
 * @returns {Vec3}
 */
export function moveStep(pos, q, stick, lift, speed, dt) {
	const step = Math.max(0, speed) * Math.max(0, Math.min(0.25, dt));
	if (!step) return pos.slice();
	const f = forwardOf(q);
	let fx = f[0];
	let fz = f[2];
	let len = Math.hypot(fx, fz);
	if (len < 1e-4) {
		// looking straight down/up: the camera's own up is the floor-forward
		const u = quatRotate(q, [0, 1, 0]);
		fx = u[0] * Math.sign(f[1] || 1) * -1;
		fz = u[2] * Math.sign(f[1] || 1) * -1;
		len = Math.hypot(fx, fz) || 1;
	}
	fx /= len;
	fz /= len;
	// right = forward × up
	const rx = -fz;
	const rz = fx;
	const sx = clampUnit(stick.x);
	const sy = clampUnit(stick.y);
	return [pos[0] + (fx * sy + rx * sx) * step, pos[1] + clampUnit(lift) * step, pos[2] + (fz * sy + rz * sx) * step];
}

/** @param {number} v */
function clampUnit(v) {
	const n = Number(v) || 0;
	return Math.max(-1, Math.min(1, n));
}

/**
 * A virtual thumbstick's value from a touch offset (px) and the pad radius: a dead zone,
 * then a rescale so the stick still reaches 1 at the rim, then a squared response curve
 * (fine control near the centre).
 * @param {number} dx @param {number} dy screen px (y down) @param {number} radius @param {number} [dead] 0..1
 * @returns {{x: number, y: number}} y up = forward
 */
export function stickValue(dx, dy, radius, dead = 0.12) {
	const r = Math.max(1, radius);
	let x = dx / r;
	let y = -dy / r;
	const m = Math.hypot(x, y);
	if (m <= dead) return { x: 0, y: 0 };
	const clamped = Math.min(1, m);
	const scaled = (clamped - dead) / (1 - dead);
	const curve = scaled * scaled;
	x = (x / m) * curve;
	y = (y / m) * curve;
	return { x, y };
}

/** Walk scale (AR): 1 m in the room = this many metres in the scene. */
export const WALK_SCALE = Object.freeze({ min: 0.1, max: 20, default: 1 });

/** @param {number} s */
export function clampWalkScale(s) {
	const n = Number(s);
	return Number.isFinite(n) ? Math.min(WALK_SCALE.max, Math.max(WALK_SCALE.min, n)) : WALK_SCALE.default;
}

/**
 * AR walk-tracking: the scene position for a tracked room pose — the scene anchor plus the
 * room displacement since tracking began, scaled and turned by the anchor's yaw.
 * @param {Vec3} anchorPos where the camera was when tracking began @param {number} anchorYaw radians
 * @param {Vec3} roomStart the XR viewer position then @param {Vec3} roomNow the XR viewer position now
 * @param {number} scale walk scale
 */
export function walkPosition(anchorPos, anchorYaw, roomStart, roomNow, scale) {
	const s = clampWalkScale(scale);
	const d = [roomNow[0] - roomStart[0], roomNow[1] - roomStart[1], roomNow[2] - roomStart[2]];
	const r = quatRotate(quatAxisAngle(Y, anchorYaw), d);
	return [anchorPos[0] + r[0] * s, anchorPos[1] + r[1] * s, anchorPos[2] + r[2] * s];
}

// ---- lens (V5 / V8 zoom) ------------------------------------------------------------

/** The full-frame (36 × 24 mm) sensor's height: three's fov is VERTICAL. */
export const SENSOR_H_MM = 24;
export const LENS_PRESETS = Object.freeze([18, 24, 35, 50, 85]);
export const FOV_RANGE = Object.freeze({ min: 5, max: 120 });

/** Vertical FOV (degrees) for a focal length (mm). @param {number} mm */
export function fovForFocal(mm) {
	const f = Math.max(1, Number(mm) || 50);
	return (2 * Math.atan(SENSOR_H_MM / (2 * f)) * 180) / Math.PI;
}

/** Focal length (mm) for a vertical FOV (degrees). @param {number} fov */
export function focalForFov(fov) {
	const f = Math.min(179, Math.max(0.5, Number(fov) || 50));
	return SENSOR_H_MM / (2 * Math.tan((f * D2R) / 2));
}

/** @param {number} fov */
export function clampFov(fov) {
	const n = Number(fov);
	return Number.isFinite(n) ? Math.min(FOV_RANGE.max, Math.max(FOV_RANGE.min, n)) : 50;
}

/**
 * Pinch zoom: the new FOV for a pinch scale (fingers apart > 1 = zoom IN). Zooms in focal
 * length, which is how a zoom ring feels (equal pinches = equal ratios).
 * @param {number} startFov @param {number} pinchScale @param {number} [speed] 0.25..4
 */
export function pinchFov(startFov, pinchScale, speed = 1) {
	const s = Math.max(0.05, Number(pinchScale) || 1);
	const k = Math.pow(s, Math.max(0.25, Math.min(4, Number(speed) || 1)));
	return clampFov(fovForFocal(focalForFov(startFov) * k));
}

/** Snap a FOV to the nearest lens preset when within `tolerance` mm. @param {number} fov @param {number} [tolerance] */
export function snapToLens(fov, tolerance = 2) {
	const mm = focalForFov(fov);
	let best = null;
	for (const p of LENS_PRESETS) if (Math.abs(p - mm) <= tolerance && (best === null || Math.abs(p - mm) < Math.abs(best - mm))) best = p;
	return best === null ? fov : fovForFocal(best);
}

// ---- One-Euro filter (V5 smoothing, F3) ----------------------------------------------

/**
 * One-Euro (Casiez et al. 2012): an adaptive low-pass — heavy smoothing when slow, little
 * lag when fast. `minCutoff` (Hz) sets the jitter floor, `beta` how fast the cutoff opens
 * with speed. Pure state object so it is testable and resettable.
 * @param {{minCutoff?: number, beta?: number, dCutoff?: number}} [opts]
 */
export function oneEuro(opts = {}) {
	const minCutoff = Math.max(1e-3, opts.minCutoff ?? 1);
	const beta = Math.max(0, opts.beta ?? 0);
	const dCutoff = Math.max(1e-3, opts.dCutoff ?? 1);
	/** @type {number[]|null} */
	let x = null;
	/** @type {number[]|null} */
	let dx = null;
	let lastT = 0;
	const alpha = (/** @type {number} */ cutoff, /** @type {number} */ dt) => {
		const tau = 1 / (2 * Math.PI * cutoff);
		return 1 / (1 + tau / dt);
	};
	return {
		/** @param {number[]} value @param {number} t seconds @returns {number[]} */
		filter(value, t) {
			if (!x || !dx || !(t > lastT)) {
				const first = !x;
				if (first) {
					x = value.slice();
					dx = value.map(() => 0);
					lastT = t;
				}
				return /** @type {number[]} */ (x).slice();
			}
			const dt = t - lastT;
			lastT = t;
			const ad = alpha(dCutoff, dt);
			const prev = x;
			const prevD = dx;
			const nd = value.map((v, i) => prevD[i] + ad * ((v - prev[i]) / dt - prevD[i]));
			const speed = Math.hypot(...nd);
			const a = alpha(minCutoff + beta * speed, dt);
			x = value.map((v, i) => prev[i] + a * (v - prev[i]));
			dx = nd;
			return x.slice();
		},
		reset() {
			x = null;
			dx = null;
			lastT = 0;
		}
	};
}

/**
 * The Film smoothing slider (0 = raw handheld … 1 = steady rig) as One-Euro settings for
 * position and rotation. 0 returns null (no filter: what the sensor says).
 * @param {number} amount 0..1
 */
export function smoothingParams(amount) {
	const a = Math.min(1, Math.max(0, Number(amount) || 0));
	if (a <= 0.001) return null;
	// cutoff 8 Hz (barely smoothed) → 0.15 Hz (a heavy rig); beta keeps fast pans responsive
	const minCutoff = 8 * Math.pow(0.15 / 8, a);
	return { minCutoff, beta: 0.4 * (1 - a) + 0.02, dCutoff: 1 };
}

/**
 * A One-Euro filter for a quaternion: sign continuity against the last output, then the
 * component filter, then renormalize.
 * @param {{minCutoff?: number, beta?: number, dCutoff?: number}} [opts]
 */
export function oneEuroQuat(opts = {}) {
	const f = oneEuro(opts);
	/** @type {number[]|null} */
	let last = null;
	return {
		/** @param {Quat} q @param {number} t */
		filter(q, t) {
			let v = q;
			if (last && last[0] * q[0] + last[1] * q[1] + last[2] * q[2] + last[3] * q[3] < 0) v = q.map((c) => -c);
			last = quatNorm(f.filter(v, t));
			return last.slice();
		},
		reset() {
			f.reset();
			last = null;
		}
	};
}

// ---- takes ----------------------------------------------------------------------------

/** The raw blob layout: one Float32 frame per sample (design note RawRef.layout). */
export const RAW_LAYOUT = Object.freeze(['t', 'pos3', 'quat4', 'fov', 'focus', 'aperture', 'roll', 'rawPos3', 'rawQuat4']);
export const RAW_STRIDE = 1 + 3 + 4 + 1 + 1 + 1 + 1 + 3 + 4;

/**
 * Pack take samples (smoothed + the unfiltered pose kept for re-smoothing, F3) into one
 * Float32Array. @param {any[]} samples @returns {Float32Array}
 */
export function packRaw(samples) {
	const out = new Float32Array(samples.length * RAW_STRIDE);
	samples.forEach((s, n) => {
		const o = n * RAW_STRIDE;
		out[o] = s.t;
		out.set(s.pos, o + 1);
		out.set(s.quat, o + 4);
		out[o + 8] = s.fov ?? 0;
		out[o + 9] = s.focus ?? 0;
		out[o + 10] = s.aperture ?? 0;
		out[o + 11] = s.roll ?? 0;
		out.set(s.rawPos ?? s.pos, o + 12);
		out.set(s.rawQuat ?? s.quat, o + 15);
	});
	return out;
}

/** @param {Float32Array} buf @returns {any[]} */
export function unpackRaw(buf) {
	const out = [];
	for (let o = 0; o + RAW_STRIDE <= buf.length; o += RAW_STRIDE)
		out.push({
			t: buf[o],
			pos: [buf[o + 1], buf[o + 2], buf[o + 3]],
			quat: [buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]],
			fov: buf[o + 8],
			focus: buf[o + 9],
			aperture: buf[o + 10],
			roll: buf[o + 11],
			rawPos: [buf[o + 12], buf[o + 13], buf[o + 14]],
			rawQuat: [buf[o + 15], buf[o + 16], buf[o + 17], buf[o + 18]]
		});
	return out;
}

/** The eased blend of a Move transition (smoothstep). @param {number} x */
export function moveEase(x) {
	const t = Math.min(1, Math.max(0, x));
	return t * t * (3 - 2 * t);
}

/** "0:07.4" — the take timer. @param {number} s */
export function formatTake(s) {
	const v = Math.max(0, Number(s) || 0);
	const m = Math.floor(v / 60);
	const sec = v - m * 60;
	return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
}

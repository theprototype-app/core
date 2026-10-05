// 36-sim U2b: JIGGLE — the maths, as a leaf that imports nothing (vitest unit).
//
// Secondary motion is a spring that lives in the object's ACCELERATING frame: the jiggly
// part is an offset `d` from where the object is, pulled back by the spring, slowed by
// damping, and thrown by the object's own acceleration (the pseudo-force -a). Moving
// the object right leaves the top behind, stopping it flings the top past and back; a
// body landing on the floor squashes. Gravity sags it, wind sways it.
//
// WHY THIS IS NOT REPLICATED. The only input is the object's POSE, which every peer
// already has (an edit, a physics stream, a VR grab are all ordinary moves), so each
// peer runs its own spring from what it sees. The result is a visual on top of the pose
// (a vertex-shader displacement or bone rotations) — nothing a save, physics or a peer
// reads. The parameters are node data and replicate like every node.

/** @typedef {{stiffness: number, damping: number, gravity: number, maxOffset: number, wind: number,
 *   amplitude: number, frequency: number, falloff: number, pivot: string, bones: string}} JiggleParams */
/** the replicated parameters (Jiggle node data) and their defaults @type {Readonly<JiggleParams>} */
export const JIGGLE_DEFAULTS = Object.freeze({
	stiffness: 120, // 1/s^2: higher = snappier, smaller sway
	damping: 0.15, // 0..1 (fraction of critical): low = wobbles longer
	gravity: 0.3, // how much it sags under gravity (0 = none)
	maxOffset: 0.35, // m: the lag never exceeds this
	wind: 0, // m/s^2 of gusting sway
	amplitude: 0.08, // soft-body squash/stretch at a full impact (fraction of size)
	frequency: 3, // Hz of the wobble
	falloff: 1.5, // how the effect grows from the pivot (1 = linear, 2 = mostly the far end)
	pivot: 'bottom', // where the object is "held": bottom | center | top
	bones: '' // skinned models: comma-separated bone-name globs ('' = the chain ends)
});
export const JIGGLE_PIVOTS = ['bottom', 'center', 'top'];

/** @param {any} v @param {number} d @param {number} lo @param {number} hi */
const clampNum = (v, d, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/**
 * The ONE boundary for jiggle params (node data from a peer or a file).
 * @param {any} raw
 * @returns {JiggleParams}
 */
export function normalizeJiggle(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const d = JIGGLE_DEFAULTS;
	return {
		stiffness: clampNum(r.stiffness, d.stiffness, 1, 2000),
		damping: clampNum(r.damping, d.damping, 0, 2),
		gravity: clampNum(r.gravity, d.gravity, 0, 5),
		maxOffset: clampNum(r.maxOffset, d.maxOffset, 0, 5),
		wind: clampNum(r.wind, d.wind, 0, 50),
		amplitude: clampNum(r.amplitude, d.amplitude, 0, 1),
		frequency: clampNum(r.frequency, d.frequency, 0.1, 20),
		falloff: clampNum(r.falloff, d.falloff, 0.1, 6),
		pivot: JIGGLE_PIVOTS.includes(r.pivot) ? r.pivot : d.pivot,
		bones: typeof r.bones === 'string' ? r.bones.slice(0, 200) : d.bones
	};
}

/** a teleport, not a motion: the spring restarts instead of flinging (m per frame) */
export const JIGGLE_SNAP_DISTANCE = 3;
/** acceleration (m/s^2) that counts as a full-strength impact for the wobble */
const IMPACT_ACCEL = 60;
const MAX_DT = 1 / 20;
const SUBSTEP = 1 / 120;

/** @returns {JiggleState} */
export function jiggleState() {
	return {
		d: [0, 0, 0],
		v: [0, 0, 0],
		anchor: /** @type {number[] | null} */ (null),
		anchorVel: [0, 0, 0],
		excite: 0,
		phase: 0
	};
}
/** @typedef {{d: number[], v: number[], anchor: number[] | null, anchorVel: number[], excite: number, phase: number}} JiggleState */

/**
 * Advance one object's spring by `dt` given where the object is NOW (world metres).
 * Writes the state in place; `time` (s) only drives the wind gusts.
 * @param {JiggleState} s
 * @param {number[]} anchor world position of the object's pivot this frame
 * @param {ReturnType<typeof normalizeJiggle>} p
 * @param {number} dt seconds since the last frame
 * @param {number} [time]
 * @param {number[]} [kick] an extra velocity change (m/s) — a grab or an impact told to us
 */
export function stepJiggle(s, anchor, p, dt, time = 0, kick) {
	if (!(dt > 0)) return s;
	dt = Math.min(dt, MAX_DT);
	if (!s.anchor) {
		s.anchor = anchor.slice();
		return s;
	}
	const dx = anchor[0] - s.anchor[0];
	const dy = anchor[1] - s.anchor[1];
	const dz = anchor[2] - s.anchor[2];
	if (dx * dx + dy * dy + dz * dz > JIGGLE_SNAP_DISTANCE * JIGGLE_SNAP_DISTANCE) {
		// a teleport (respawn, undo, a scene switch): start over at rest
		s.anchor = anchor.slice();
		s.d.fill(0);
		s.v.fill(0);
		s.anchorVel.fill(0);
		return s;
	}
	const vx = dx / dt;
	const vy = dy / dt;
	const vz = dz / dt;
	// the frame's acceleration is the pseudo-force the jiggly part feels (-a)
	const ax = (vx - s.anchorVel[0]) / dt;
	const ay = (vy - s.anchorVel[1]) / dt;
	const az = (vz - s.anchorVel[2]) / dt;
	s.anchorVel[0] = vx;
	s.anchorVel[1] = vy;
	s.anchorVel[2] = vz;
	s.anchor[0] = anchor[0];
	s.anchor[1] = anchor[1];
	s.anchor[2] = anchor[2];
	// an impact (a landing, a hit, a grab yank) excites the soft-body wobble
	const accel = Math.hypot(ax, ay, az);
	s.excite = Math.min(1, s.excite + (accel / IMPACT_ACCEL) * dt * 8);
	if (kick) {
		s.v[0] += kick[0];
		s.v[1] += kick[1];
		s.v[2] += kick[2];
		s.excite = Math.min(1, s.excite + Math.hypot(kick[0], kick[1], kick[2]) / 4);
	}
	const k = p.stiffness;
	const c = 2 * p.damping * Math.sqrt(k);
	const gy = -9.81 * p.gravity;
	const gust = p.wind ? p.wind * (Math.sin(time * 1.3) + 0.5 * Math.sin(time * 2.9 + 1.7)) : 0;
	const gustZ = p.wind ? p.wind * 0.4 * Math.sin(time * 0.9 + 0.4) : 0;
	// the pseudo-force is spread across the frame: the anchor's velocity changed by a*dt
	// over this frame, so each substep feels a for its share of dt
	const n = Math.max(1, Math.ceil(dt / SUBSTEP));
	const h = dt / n;
	for (let i = 0; i < n; i++) {
		const fx = -k * s.d[0] - c * s.v[0] - ax + gust;
		const fy = -k * s.d[1] - c * s.v[1] - ay + gy;
		const fz = -k * s.d[2] - c * s.v[2] - az + gustZ;
		s.v[0] += fx * h;
		s.v[1] += fy * h;
		s.v[2] += fz * h;
		s.d[0] += s.v[0] * h;
		s.d[1] += s.v[1] * h;
		s.d[2] += s.v[2] * h;
	}
	// never further than maxOffset: clamp, and drop the outward speed so it does not
	// stick to the limit
	const len = Math.hypot(s.d[0], s.d[1], s.d[2]);
	if (len > p.maxOffset) {
		const f = p.maxOffset / len;
		const nx = s.d[0] / len, ny = s.d[1] / len, nz = s.d[2] / len;
		s.d[0] *= f;
		s.d[1] *= f;
		s.d[2] *= f;
		const out = s.v[0] * nx + s.v[1] * ny + s.v[2] * nz;
		if (out > 0) {
			s.v[0] -= out * nx;
			s.v[1] -= out * ny;
			s.v[2] -= out * nz;
		}
	}
	// the wobble rings at its frequency and dies with the damping
	s.phase = (s.phase + 2 * Math.PI * p.frequency * dt) % (2 * Math.PI * 1000);
	s.excite *= Math.exp(-(0.5 + 2 * Math.PI * p.frequency * p.damping * 0.5) * dt);
	if (s.excite < 1e-4) s.excite = 0;
	return s;
}

/** the squash/stretch factor the shader applies this frame (signed) @param {JiggleState} s @param {ReturnType<typeof normalizeJiggle>} p */
export function wobbleOf(s, p) {
	return p.amplitude * s.excite * Math.sin(s.phase);
}

/**
 * Bone-name globs ("hair*, tail_*") as a matcher; '' matches nothing (the caller then
 * picks the chain ends).
 * @param {string} spec
 * @returns {((name: string) => boolean) | null}
 */
export function boneMatcher(spec) {
	const parts = String(spec ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (!parts.length) return null;
	const res = parts.map(
		(glob) => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
	);
	return (name) => res.some((re) => re.test(name));
}

/**
 * The vertex-shader snippet (three's `#include <begin_vertex>` replacement). `transformed`
 * is the object-space vertex; the uniforms are per object (each jiggling mesh gets its
 * own material clone, see jiggleRuntime).
 */
export const JIGGLE_VERTEX = /* glsl */ `
#include <begin_vertex>
{
	vec3 jRel = transformed - jPivot;
	float jW = pow(clamp(length(jRel) / max(jRadius, 1e-4), 0.0, 1.0), jFalloff);
	transformed += jOffset * jW;
	transformed += jRel * vec3(-0.5 * jWobble, jWobble, -0.5 * jWobble) * jW;
}
`;
export const JIGGLE_UNIFORMS_DECL = /* glsl */ `
uniform vec3 jOffset;
uniform vec3 jPivot;
uniform float jRadius;
uniform float jFalloff;
uniform float jWobble;
`;

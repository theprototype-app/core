// 102b: per-object body tuning and the four new joint kinds — the PURE half (imports nothing),
// so the clamps and defaults that decide what a body or joint becomes are unit-testable with no
// rapier and no stores. physics.js applies them, joints.js and the agent tools validate with them.

/** The per-body tuning keys on userData.physics (each optional; absent = the scene's value). */
export const BODY_TUNING_KEYS = /** @type {const} */ (['gravityScale', 'linearDamping', 'angularDamping']);

/** The clamps: gravity scale may go negative (a balloon), damping uses the scene's own range. */
export const BODY_TUNING_RANGE = {
	gravityScale: [-5, 5],
	linearDamping: [0, 5],
	angularDamping: [0, 5]
};

/**
 * What a dynamic body's gravity scale and damping resolve to — its own value, else the scene's
 * damping and a gravity scale of 1 (the pre-102b body, exactly).
 * @param {any} p collectParams entry / userData.physics (or null) @param {any} defaults scenePhysicsDefaults
 * @returns {{gravityScale: number, linear: number, angular: number}}
 */
export function bodyTuningOf(p, defaults) {
	// a body's own values are clamped here too: they may come from a file or a peer, not only the Inspector
	const own = (/** @type {'gravityScale'|'linearDamping'|'angularDamping'} */ key) => {
		const v = p?.[key];
		if (!Number.isFinite(v)) return null;
		const [lo, hi] = BODY_TUNING_RANGE[key];
		return Math.min(Math.max(v, lo), hi);
	};
	return {
		gravityScale: own('gravityScale') ?? 1,
		linear: own('linearDamping') ?? (defaults?.damping?.linear ?? 0),
		angular: own('angularDamping') ?? (defaults?.damping?.angular ?? 0)
	};
}

/**
 * A caller's tuning values, clamped into a setPhysicsFor patch. `null` passes through (it means
 * "back to the scene's value"); anything not a finite number is dropped.
 * @param {any} input @returns {Record<string, number|null>}
 */
export function bodyTuningPatch(input) {
	/** @type {Record<string, number|null>} */
	const out = {};
	if (!input || typeof input !== 'object') return out;
	for (const key of BODY_TUNING_KEYS) {
		const v = input[key];
		if (v === null) out[key] = null;
		else if (Number.isFinite(v)) {
			const [lo, hi] = BODY_TUNING_RANGE[key];
			out[key] = Math.min(Math.max(v, lo), hi);
		}
	}
	return out;
}

// ---- joints (102b row 2) -----------------------------------------------------------------------
// The canonical kinds are rapier's own joint names. `weld` was stored verbatim by the Joint node and
// the module SDK before 102b and still builds as a fixed joint, so it stays a known kind.

/** @typedef {'fixed'|'revolute'|'spherical'|'prismatic'|'spring'|'rope'} JointKind */
export const JOINT_KINDS = /** @type {const} */ (['fixed', 'revolute', 'spherical', 'prismatic', 'spring', 'rope']);

/** What people call each kind (UI labels, agent words). */
export const JOINT_LABELS = {
	fixed: 'Weld',
	revolute: 'Hinge',
	spherical: 'Ball',
	prismatic: 'Slider',
	spring: 'Spring',
	rope: 'Rope'
};

/** @type {Record<string, JointKind>} */
const JOINT_ALIASES = {
	fixed: 'fixed',
	weld: 'fixed',
	revolute: 'revolute',
	hinge: 'revolute',
	spherical: 'spherical',
	ball: 'spherical',
	socket: 'spherical',
	'ball-socket': 'spherical',
	prismatic: 'prismatic',
	slider: 'prismatic',
	piston: 'prismatic',
	spring: 'spring',
	rope: 'rope',
	chain: 'rope'
};

/** A caller's joint word as a canonical kind, or null. @param {any} raw @returns {JointKind|null} */
export function jointKindOf(raw) {
	const key = String(raw ?? '').trim().toLowerCase();
	return Object.prototype.hasOwnProperty.call(JOINT_ALIASES, key) ? JOINT_ALIASES[key] : null;
}

/** Kinds whose anchor is ONE point (on b's origin by default) vs TWO (a's and b's origins). */
export const TWO_POINT_KINDS = /** @type {const} */ (['spring', 'rope']);
/** Kinds that have an axis (a's local x / y / z). */
export const AXIS_KINDS = /** @type {const} */ (['revolute', 'prismatic']);

export const SPRING_DEFAULTS = { stiffness: 50, damping: 2 };
export const JOINT_RANGE = {
	slide: [-100, 100], // prismatic limits, metres
	rest: [0, 1000],
	stiffness: [0, 100000],
	damping: [0, 1000],
	length: [0.01, 1000]
};

/** @param {number} v @param {number[]} r */
const clampTo = (v, r) => Math.min(Math.max(v, r[0]), r[1]);
const fin = (/** @type {any} */ v) => typeof v === 'number' && Number.isFinite(v);

/** A [min, max] pair, ordered and clamped, or null. @param {any} l @param {number[]} range */
function limitsOf(l, range) {
	if (!Array.isArray(l) || l.length !== 2 || !l.every(fin) || l[0] > l[1]) return null;
	return [clampTo(l[0], range), clampTo(l[1], range)];
}

/**
 * The kind-specific fields a NEW joint gets: slider limits, the spring's rest length, stiffness and
 * damping, the rope's maximum length. `distance` = how far apart the two anchors are now, which is
 * the default rest length and rope length (the pair starts at rest / with the rope just taut).
 * @param {JointKind} kind @param {any} input @param {number} distance
 * @returns {Record<string, any>}
 */
export function jointParamsFor(kind, input, distance) {
	const o = input && typeof input === 'object' ? input : {};
	const d = fin(distance) ? distance : 1;
	if (kind === 'prismatic') {
		const limits = limitsOf(o.limits, JOINT_RANGE.slide);
		return limits ? { limits } : {};
	}
	if (kind === 'spring')
		return {
			rest: clampTo(fin(o.rest) ? o.rest : d, JOINT_RANGE.rest),
			stiffness: clampTo(fin(o.stiffness) ? o.stiffness : SPRING_DEFAULTS.stiffness, JOINT_RANGE.stiffness),
			damping: clampTo(fin(o.damping) ? o.damping : SPRING_DEFAULTS.damping, JOINT_RANGE.damping)
		};
	if (kind === 'rope') return { length: clampTo(fin(o.length) ? o.length : d, JOINT_RANGE.length) };
	return {};
}

/**
 * An edit to an existing joint, as the next def (a NEW object; null = nothing valid in the patch).
 * Only fields that mean something for the joint's kind are taken. `limits: null` clears limits.
 * `axis` 'x'|'y'|'z' re-points a hinge or slider along a's local axis.
 * @param {any} def @param {any} patch @returns {any|null}
 */
export function jointEditPatch(def, patch) {
	if (!def || !patch || typeof patch !== 'object') return null;
	const kind = jointKindOf(def.kind);
	if (!kind) return null;
	const next = { ...def };
	let changed = false;
	const set = (/** @type {string} */ key, /** @type {any} */ value) => {
		if (value === undefined) delete next[key];
		else next[key] = value;
		changed = true;
	};
	if (AXIS_KINDS.includes(/** @type {any} */ (kind)) && ['x', 'y', 'z'].includes(patch.axis))
		set('axisA', patch.axis === 'x' ? [1, 0, 0] : patch.axis === 'z' ? [0, 0, 1] : [0, 1, 0]);
	if ((kind === 'revolute' || kind === 'prismatic') && 'limits' in patch) {
		if (patch.limits === null) set('limits', undefined);
		else {
			const l = limitsOf(patch.limits, kind === 'prismatic' ? JOINT_RANGE.slide : [-2 * Math.PI, 2 * Math.PI]);
			if (l) set('limits', l);
		}
	}
	if (kind === 'spring') {
		if (fin(patch.rest)) set('rest', clampTo(patch.rest, JOINT_RANGE.rest));
		if (fin(patch.stiffness)) set('stiffness', clampTo(patch.stiffness, JOINT_RANGE.stiffness));
		if (fin(patch.damping)) set('damping', clampTo(patch.damping, JOINT_RANGE.damping));
	}
	if (kind === 'rope' && fin(patch.length)) set('length', clampTo(patch.length, JOINT_RANGE.length));
	if (typeof patch.contacts === 'boolean') set('contacts', patch.contacts ? undefined : false);
	return changed ? next : null;
}

// ---- a joint def from a file or a peer -----------------------------------------------------------
// The UI and the agent tools build joints through jointParamsFor / jointEditPatch, which clamp. A def
// that ARRIVES (a peer's jointcreate / joints snapshot, a .tpscene, the autosave) is checked here before
// anything stores it: every number the simulator reads must be finite and in range, an axis must have
// a length, and a malformed def is dropped. A valid def comes back as the SAME object, so an older
// scene's joints stay byte-identical.

const JOINT_SPACE = 10000; // metres: anchors and any limit beyond this mean nothing in a scene
const MOTOR_RANGE = {
	vel: [-1000, 1000],
	maxForce: [0, 1000000],
	pos: [-4 * Math.PI, 4 * Math.PI],
	stiffness: [0, 1000000],
	damping: [0, 100000]
};
const isRef = (/** @type {any} */ v) => typeof v === 'string' && v.length > 0 && v.length <= 64;

/** @param {any} v @returns {boolean} three finite numbers inside the scene */
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => fin(n) && Math.abs(n) <= JOINT_SPACE);

/**
 * A joint def as received, made safe for the simulator; null when it cannot be a joint.
 * @param {any} raw @returns {any|null}
 */
export function normalizeJointDef(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	if (!isRef(raw.id) || !isRef(raw.a) || !isRef(raw.b) || raw.a === raw.b) return null;
	if (raw.kind !== undefined && (typeof raw.kind !== 'string' || !/^[a-z][\w-]{0,31}$/i.test(raw.kind))) return null;
	const kind = raw.kind === undefined || raw.kind === 'weld' ? 'fixed' : jointKindOf(raw.kind);
	/** @type {any} */
	const next = { ...raw };
	let changed = false;
	const fix = (/** @type {string} */ key, /** @type {any} */ value) => {
		if (value === undefined) delete next[key];
		else next[key] = value;
		changed = true;
	};
	for (const key of ['anchorA', 'anchorB']) if (!isVec3(raw[key])) fix(key, [0, 0, 0]);
	if ('axisA' in raw) {
		// absent stays absent (the simulator's default is a's local y, as before)
		const v = raw.axisA;
		const len = isVec3(v) ? Math.hypot(v[0], v[1], v[2]) : 0;
		if (!(len > 1e-6)) fix('axisA', AXIS_KINDS.includes(/** @type {any} */ (kind)) ? [0, 1, 0] : undefined);
	}
	if ('limits' in raw) {
		const l = raw.limits;
		const ok = Array.isArray(l) && l.length === 2 && l.every((n) => fin(n) && Math.abs(n) <= JOINT_SPACE) && l[0] <= l[1];
		if (!ok) fix('limits', undefined);
	}
	if ('motor' in raw) {
		const m = raw.motor;
		if (!m || typeof m !== 'object' || Array.isArray(m)) fix('motor', undefined);
		else {
			/** @type {Record<string, number>} */
			const motor = {};
			let motorChanged = false;
			for (const key of Object.keys(m)) {
				const range = /** @type {Record<string, number[]>} */ (MOTOR_RANGE)[key];
				const v = m[key];
				if (!range || !fin(v)) {
					motorChanged = true;
					continue;
				}
				const c = clampTo(v, range);
				if (c !== v) motorChanged = true;
				motor[key] = c;
			}
			if (motorChanged) fix('motor', motor);
		}
	}
	/** @type {[string, number[]][]} */
	const ranged = [
		['rest', JOINT_RANGE.rest],
		['stiffness', JOINT_RANGE.stiffness],
		['damping', JOINT_RANGE.damping],
		['length', JOINT_RANGE.length]
	];
	for (const [key, range] of ranged) {
		if (!(key in raw)) continue;
		const v = raw[key];
		if (!fin(v)) fix(key, undefined);
		else if (clampTo(v, range) !== v) fix(key, clampTo(v, range));
	}
	for (const key of ['contacts', 'sparks']) if (key in raw && typeof raw[key] !== 'boolean') fix(key, undefined);
	return changed ? next : raw;
}

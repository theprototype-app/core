// 85b S6 — BODY-SCALE UNITS, the pure half: "a table at hip height", "as tall as me", "an arm's reach away".
// A person's body numbers come from their eye height above their floor (the one thing the wire carries), with
// adult proportions; the room is the WebXR bounded space when the headset has one. A size or position value may
// then be a string like "hip", "0.5 reach" or "2 eye". Imports nothing.

/** an adult, for when nobody's pose is known */
export const STANDARD_EYE = 1.6;
export const STANDARD_ROOM = 3;

/**
 * @param {number | null | undefined} eye eye height above the floor (m)
 * @param {number | null} [room] the bounded play area's smaller side (m), null = unknown
 * @returns {{eye: number, height: number, shoulder: number, hip: number, knee: number, reach: number, room: number, assumed: boolean}}
 */
export function bodyFrom(eye, room = null) {
	const ok = typeof eye === 'number' && Number.isFinite(eye) && eye >= 0.6 && eye <= 2.3;
	const e = ok ? eye : STANDARD_EYE;
	const height = e / 0.936;
	const r = (/** @type {number} */ v) => Math.round(v * 100) / 100;
	return {
		eye: r(e),
		height: r(height),
		shoulder: r(height * 0.82),
		hip: r(height * 0.53),
		knee: r(height * 0.285),
		reach: r(height * 0.44),
		room: r(typeof room === 'number' && Number.isFinite(room) && room > 0.5 ? room : STANDARD_ROOM),
		assumed: !ok
	};
}

export const UNIT_NAMES = ['eye', 'height', 'shoulder', 'hip', 'knee', 'reach', 'room'];
const UNIT = new RegExp('^\\s*(-?\\d*\\.?\\d+)?\\s*\\*?\\s*(' + UNIT_NAMES.join('|') + ')s?\\s*$', 'i');

/** @param {any} v */
export const isUnitValue = (v) => typeof v === 'string' && UNIT.test(v);

/**
 * "hip" → 0.91, "0.5 reach" → 0.37; anything else comes back as it was.
 * @param {any} v @param {ReturnType<typeof bodyFrom>} body
 */
export function resolveUnit(v, body) {
	if (typeof v !== 'string') return v;
	const m = UNIT.exec(v);
	if (!m) return v;
	const k = m[1] === undefined ? 1 : Number(m[1]);
	return Math.round(k * /** @type {any} */ (body)[m[2].toLowerCase()] * 1000) / 1000;
}

/** the spec fields that take numbers a unit may stand for */
const ARRAY_FIELDS = ['params', 'position', 'scale'];

/**
 * Does this spec use a body unit anywhere? @param {any} spec
 */
export function specUsesUnits(spec) {
	if (!spec || typeof spec !== 'object') return false;
	return ARRAY_FIELDS.some((f) => Array.isArray(spec[f]) && spec[f].some(isUnitValue)) || !!(spec.at && typeof spec.at === 'object' && ['ahead', 'right', 'up'].some((k) => isUnitValue(spec.at[k])));
}

/**
 * A copy of the spec with every unit string turned into metres.
 * @param {any} spec @param {ReturnType<typeof bodyFrom>} body
 */
export function resolveSpecUnits(spec, body) {
	const out = { ...spec };
	for (const f of ARRAY_FIELDS) if (Array.isArray(spec[f])) out[f] = spec[f].map((/** @type {any} */ v) => resolveUnit(v, body));
	if (spec.at && typeof spec.at === 'object') out.at = { ...spec.at, ...Object.fromEntries(['ahead', 'right', 'up'].filter((k) => spec.at[k] !== undefined).map((k) => [k, resolveUnit(spec.at[k], body)])) };
	return out;
}

// 102b-hud (row 4): PUBLISHED game values — the numbers and lines a game's own code knows and the HUD
// wants (coins collected, falls, the best run, an inventory line). A LEAF (imports nothing).
//
// The official games each registered an `info` value node whose only job was to hand one of those to
// a HUD Text. A module now PUBLISHES the raw value (`api.values.set('coins', 3, {max: 10})`) and the
// scene shows it with the core Game Value node (source "published", any format). LOCAL per peer,
// exactly like the info nodes were: each peer's own module computes its own answer (a coin count is
// yours), nothing goes on the wire, and nothing is saved. A module's values are cleared when it is
// disabled (sdk/values.js journals it).

/** @type {Map<string, {value: any, max: number | null, owner: string}>} */
const values = new Map();

/** @param {any} name */
const keyOf = (name) => String(name ?? '').trim().slice(0, 64);

/**
 * @param {string} name @param {any} value a number or a short text (capped at 200 characters)
 * @param {{max?: number}} [opts] @param {string} [owner] the module that wrote it
 * @returns {boolean}
 */
export function setGameValue(name, value, opts = {}, owner = '') {
	const key = keyOf(name);
	if (!key) return false;
	let v = value;
	if (typeof v === 'string') v = v.slice(0, 200);
	else if (typeof v === 'boolean') v = v ? 1 : 0;
	else if (typeof v !== 'number' || !Number.isFinite(v)) v = v === null || v === undefined ? 0 : String(v).slice(0, 200);
	const m = Number(opts?.max);
	values.set(key, { value: v, max: Number.isFinite(m) ? m : null, owner });
	return true;
}

/** @param {string} name @param {any} [fallback] */
export function gameValueOf(name, fallback = 0) {
	const row = values.get(keyOf(name));
	return row ? row.value : fallback;
}

/** @param {string} name @returns {number | null} the max published with it */
export function gameValueMax(name) {
	return values.get(keyOf(name))?.max ?? null;
}

/** @param {string} name */
export function clearGameValue(name) {
	values.delete(keyOf(name));
}

/** every value one module wrote (its teardown) @param {string} owner */
export function clearGameValuesOf(owner) {
	for (const [k, row] of values) if (row.owner === owner) values.delete(k);
}

/** the names published right now (the node card's picker, the suites) */
export function gameValueNames() {
	return [...values.keys()].sort();
}

/** suites only */
export function resetGameValues() {
	values.clear();
}

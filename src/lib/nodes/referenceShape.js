// 2.0-int (boot size): the SHAPE half of reference.js — which types convert and what sockets / params a
// converted node gets. The node menu asks it on every right-click, so it stays on the editor boot while the
// reference BODIES (reference.js, ~10 KB of source) load with Convert itself. A LEAF: imports nothing.

/** the node types that convert, in palette order @type {readonly string[]} */
export const REFERENCE_TYPES = Object.freeze(['math', 'compare', 'gate', 'select', 'maprange', 'random', 'hudtext']);

const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
/** the built-in's socket count rule (variadicNodes.socketCount) @param {any} d */
function socketCount(d) {
	const n = Math.round(Number(d?.sockets));
	return Number.isFinite(n) ? Math.min(Math.max(n, 2), 8) : 2;
}
/** @param {any} v */
function num(v) {
	if (Array.isArray(v)) return Number(v[0]) || 0;
	if (typeof v === 'boolean') return v ? 1 : 0;
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}

/**
 * @typedef {{ name: string, type: string, value?: any }} RefSocket
 * @typedef {{ params: Record<string, any>, inputs: RefSocket[], outputs: RefSocket[] }} RefShape
 */

/**
 * What a node of `type` with `data` becomes as a Script value node: the params the code reads,
 * the declared inputs (the built-in's socket names, with the node's dialled values) and outputs.
 * `wired` = the target handles that have a wire (Select's "slots this node uses" reads it, as the
 * built-in does). Null = the type does not convert.
 * @param {string} type @param {any} data @param {Set<string>} [wired]
 * @returns {RefShape | null}
 */
export function referenceShape(type, data, wired = new Set()) {
	const d = data ?? {};
	if (type === 'math' || type === 'gate') {
		const boolean = type === 'gate';
		const t = boolean ? 'boolean' : 'number';
		const extras = LETTERS.slice(2, socketCount(d));
		return {
			params: { op: d.op ?? (boolean ? 'and' : 'add'), extras },
			inputs: [
				{ name: 'a', type: t, value: d.a ?? (boolean ? false : 0) },
				{ name: 'b', type: t, value: d.b ?? (boolean ? false : 0) },
				...extras.map((name) => ({ name, type: 'any' }))
			],
			outputs: [{ name: 'out', type: boolean ? 'boolean' : 'number' }]
		};
	}
	if (type === 'compare')
		return {
			params: { op: d.op ?? 'gt' },
			inputs: [
				{ name: 'a', type: 'number', value: d.a ?? 0 },
				{ name: 'b', type: 'number', value: d.b ?? 0 }
			],
			outputs: [{ name: 'out', type: 'boolean' }]
		};
	if (type === 'select') {
		const keys = ['a', 'b', 'c', 'd'];
		let last = 1;
		for (let i = 2; i < keys.length; i++) if (d[keys[i]] !== undefined || wired.has(keys[i])) last = i;
		return {
			params: { last },
			inputs: [
				{ name: 'index', type: 'number', value: d.index ?? 0 },
				// planner Q5: 'any' slots and out, so a consumer gets EXACTLY what the built-in passes on (the raw
				// slot value: text, a list, a number), not a number-coerced copy
				...keys.slice(0, last + 1).map((k) => ({ name: k, type: 'any', value: d[k] ?? 0 }))
			],
			outputs: [{ name: 'out', type: 'any' }]
		};
	}
	if (type === 'maprange')
		return {
			params: {
				inMin: num(d.inMin ?? 0),
				inMax: num(d.inMax ?? 1),
				outMin: num(d.outMin ?? 0),
				outMax: num(d.outMax ?? 1),
				clamp: !!(d.clamp ?? true)
			},
			inputs: [{ name: 'a', type: 'number', value: d.a ?? 0 }],
			outputs: [{ name: 'out', type: 'number' }]
		};
	if (type === 'random')
		return {
			params: { min: num(d.min ?? 0), max: num(d.max ?? 1), interval: num(d.interval ?? 0), integer: !!d.integer },
			inputs: [
				{ name: 'seed', type: 'number', value: d.seed ?? 0 },
				{ name: 'reroll', type: 'event' }
			],
			outputs: [{ name: 'out', type: 'number' }]
		};
	if (type === 'hudtext')
		return {
			params: { format: d.format ?? '{v}', decimals: num(d.decimals), value: d.value ?? 0 },
			inputs: [
				{ name: 'value', type: 'any' },
				{ name: 'format', type: 'any' }
			],
			outputs: [{ name: 'text', type: 'any' }]
		};
	return null;
}

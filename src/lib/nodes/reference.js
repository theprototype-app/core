// 2.0-n3c (roadmap 2.0 N3c) — REFERENCE JAVASCRIPT for the pure value nodes: what the built-in
// computes, written as the body of a Script value node (`inputs`, `time`, `api` in, `return {…}`
// out — scriptIO's v2 contract). Each is the `referenceJs` half of its definition, and "Convert to
// code" (convertCode.js) puts it in a Script node behind `const params = {…}`: the node's own
// settings, inlined. The parity tests (tests/unit/referenceParity.test.js) run every body against the
// built-in eval over a fixture grid, so a body that drifts from its built-in fails CI.
//
// The tick model does not change: these are pure functions of inputs, params and time (+ two reads
// of replicated state for Random: its node id and its `reroll` stamp, through `api`). Nothing here
// owns state. A LEAF: imports nothing.
//
// SOCKETS. A converted node keeps the built-in's socket NAMES (so every wire stays where it was) and
// types. Two exceptions, both type `any` (the raw wired value, `undefined` when unwired): HUD Text's
// `value` (it shows text verbatim) and Math / Gate's extra sockets c..h (the built-in SKIPS an extra
// that is unwired or reads nothing, and only an `undefined` can say so).

/** the node types that convert, in palette order @type {readonly string[]} */
export const REFERENCE_TYPES = Object.freeze(['math', 'compare', 'gate', 'select', 'maprange', 'random', 'hudtext']);

/** the built-in num() rule (flowRuntime.num), for values that arrive raw (`any` sockets) */
const NUM =
	"const num = (v) => { if (Array.isArray(v)) return Number(v[0]) || 0; if (typeof v === 'boolean') return v ? 1 : 0; const n = Number(v); return Number.isFinite(n) ? n : 0; };";
/** the built-in bool() rule (flowRuntime.bool) */
const BOOL = "const bool = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'number' ? v !== 0 : !!v);";

export const MATH_JS = `// inputs a, b: numbers (a missing or non-finite one reads 0). params.op picks the operation.
${NUM}
const { a, b } = inputs;
// wired extra sockets c..h fold in for add, sub, mul, div, min and max (an unwired one is skipped)
const extras = params.extras.map((k) => inputs[k]).filter((v) => v !== undefined).map(num);
if (extras.length && ['add', 'sub', 'mul', 'div', 'min', 'max'].includes(params.op)) {
	let acc = a;
	for (const v of [b, ...extras]) {
		if (params.op === 'sub') acc -= v;
		else if (params.op === 'mul') acc *= v;
		else if (params.op === 'div') acc = v !== 0 ? acc / v : 0;
		else if (params.op === 'min') acc = Math.min(acc, v);
		else if (params.op === 'max') acc = Math.max(acc, v);
		else acc += v;
	}
	return { out: acc };
}
switch (params.op) {
	case 'sub': return { out: a - b };
	case 'mul': return { out: a * b };
	case 'div': return { out: b !== 0 ? a / b : 0 };
	case 'min': return { out: Math.min(a, b) };
	case 'max': return { out: Math.max(a, b) };
	case 'mod': return { out: b !== 0 ? ((a % b) + b) % b : 0 };
	case 'pow': return { out: Math.pow(a, b) };
	case 'sin': return { out: Math.sin(a) * (b || 1) };
	case 'cos': return { out: Math.cos(a) * (b || 1) };
	case 'abs': return { out: Math.abs(a) };
	case 'round': return { out: Math.round(a) };
	case 'floor': return { out: Math.floor(a) };
	case 'clamp': return { out: Math.min(Math.max(a, 0), b > 0 ? b : 1) };
	case 'neg': return { out: -a };
	default: return { out: a + b };
}
`;

export const COMPARE_JS = `// inputs a, b: numbers. params.op: gt, lt, eq, gte, lte or neq.
const { a, b } = inputs;
switch (params.op) {
	case 'lt': return { out: a < b };
	case 'eq': return { out: a === b };
	case 'gte': return { out: a >= b };
	case 'lte': return { out: a <= b };
	case 'neq': return { out: a !== b };
	default: return { out: a > b };
}
`;

export const GATE_JS = `// inputs a, b: true / false. params.op: and, or, not (of a) or xor.
${BOOL}
const { a, b } = inputs;
// wired extra sockets c..h join and, or and xor (xor = an odd number of them true)
const extras = params.extras.map((k) => inputs[k]).filter((v) => v !== undefined).map(bool);
if (extras.length && ['and', 'or', 'xor'].includes(params.op)) {
	const all = [a, b, ...extras];
	if (params.op === 'or') return { out: all.some(Boolean) };
	if (params.op === 'xor') return { out: all.filter(Boolean).length % 2 === 1 };
	return { out: all.every(Boolean) };
}
switch (params.op) {
	case 'or': return { out: a || b };
	case 'not': return { out: !a };
	case 'xor': return { out: a !== b };
	default: return { out: a && b };
}
`;

export const SELECT_JS = `// picks one of a, b (c, d) by index: rounded, and held inside the slots this node uses.
const slots = ['a', 'b', 'c', 'd'].slice(0, params.last + 1);
const at = Math.min(params.last, Math.max(0, Math.round(inputs.index)));
return { out: inputs[slots[at]] };
`;

export const MAPRANGE_JS = `// remaps a from [inMin, inMax] to [outMin, outMax]; params.clamp keeps it inside.
const span = params.inMax - params.inMin;
let t = span === 0 ? 0 : (inputs.a - params.inMin) / span;
if (params.clamp) t = Math.min(Math.max(t, 0), 1);
return { out: params.outMin + t * (params.outMax - params.outMin) };
`;

export const RANDOM_JS = `// the same number on every peer: seeded by this node's id, the synced clock (a new roll every
// params.interval seconds; 0 = never), the seed input and the last reroll pulse's time.
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h >>> 0; };
const mulberry32 = (seed) => { let t = (seed + 0x6d2b79f5) >>> 0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const roll = params.interval > 0 ? Math.floor(time / params.interval) : 0;
const stamp = api.stamp('reroll');
const rerolls = typeof stamp === 'number' ? Math.round(stamp * 1000) >>> 0 : 0;
const value = params.min + mulberry32(hash(api.self().id) + roll + inputs.seed + rerolls) * (params.max - params.min);
return { out: params.integer ? Math.floor(value) : value };
`;

export const HUDTEXT_JS = `// the HUD Text's words: {v} in the format becomes the value (a number with params.decimals
// places, or text as it is). The HUD Text node wired to \`text\` shows exactly this.
const format = inputs.format === undefined ? params.format : inputs.format;
const value = inputs.value === undefined ? params.value : inputs.value;
let n;
if (typeof value === 'string') { const t = value.trim(); n = t === '' ? 0 : Number.isFinite(Number(t)) ? Number(t) : null; }
else if (Array.isArray(value)) n = Number(value[0]) || 0;
else if (typeof value === 'boolean') n = value ? 1 : 0;
else n = Number.isFinite(Number(value)) ? Number(value) : 0;
const shown = n === null ? String(value) : n.toFixed(Math.max(0, Math.min(6, Math.round(Number(params.decimals) || 0))));
const pattern = String(format ?? '{v}');
return { text: pattern.includes('{v}') ? pattern.split('{v}').join(shown) : pattern || shown };
`;

/** a definition's `referenceJs` (a string, the registry's rule) @type {Record<string, string>} */
export const REFERENCE_JS = Object.freeze({
	math: MATH_JS,
	compare: COMPARE_JS,
	gate: GATE_JS,
	select: SELECT_JS,
	maprange: MAPRANGE_JS,
	random: RANDOM_JS,
	hudtext: HUDTEXT_JS
});

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
				...keys.slice(0, last + 1).map((k) => ({ name: k, type: 'number', value: d[k] ?? 0 }))
			],
			outputs: [{ name: 'out', type: 'number' }]
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

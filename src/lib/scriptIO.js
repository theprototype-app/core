// 34 D3 — SCRIPT NODE v2's sockets (plan 56.3): typed `inputs.*` in, `return {out}` out.
//
// A v1 Script node has three fixed number handles (a/b/c) read through `data`, and NO
// outputs — it can only push an object around. v2 lets a node DECLARE its sockets:
//   data.inputs  = [{name: 'hand', type: 'vector3', value?}]   -> `inputs.hand` in the code
//   data.outputs = [{name: 'allow', type: 'boolean'}]          -> `return { allow: … }`
// so a behaviour snippet (proposal §4.3 (d)) can live inside an existing graph.
//
// THE COMPATIBILITY LINE: a node with neither list is v1 and byte-identical — same handles,
// same `new Function` signature, no lint gate. Declaring either list opts the node in.
// A node WITH outputs is a VALUE node: other nodes pull its handles, so it runs as a pure
// function of (inputs, time) and gets no `object` to write to. A node with inputs and no
// outputs is still an EFFECT (it drives its object as before), with `inputs` beside `data`.
//
// A LEAF (imports nothing): the declarations, the coercions and the output harvest are what
// is easy to get subtly wrong, so they are testable with no runtime, no scene and no peer.

/** the socket types a script may declare (flowSockets' vocabulary, minus 'effect') */
export const SCRIPT_INPUT_TYPES = ['number', 'boolean', 'vector3', 'color', 'object', 'event'];
/** an output carries a value; an EVENT output would need a stamp, which a pure function
 * of (inputs, time) cannot mint — so outputs are values only */
export const SCRIPT_OUTPUT_TYPES = ['number', 'boolean', 'vector3', 'color', 'object'];

/** names the v2 function binds itself, plus the node-data keys an effect's \`data\` already
 * holds (a socket named `code` would read the script's own source), so a socket may not
 * take them */
export const RESERVED = new Set([
	'inputs', 'time', 'object', 'base', 'data', 'params', 'dist', 'lerp', 'clamp',
	'code', 'label', 'type', 'name', 'outputs',
	'api' // 36 (56.3): the script API object
]);
const IDENT = /^[A-Za-z_$][\w$]*$/;

/** @typedef {{ name: string, type: string, value?: any }} ScriptSocket */

/**
 * Normalize a declared socket list: keep entries with a valid, unique, non-reserved name and
 * a known type (an unknown type reads as 'number', the flowSockets fallback). Not an array =
 * not declared, which is how a v1 node is told apart.
 * @param {any} list @param {string[]} types
 * @returns {ScriptSocket[] | null}
 */
function normalizeSockets(list, types) {
	if (!Array.isArray(list)) return null;
	/** @type {ScriptSocket[]} */
	const out = [];
	const seen = new Set();
	for (const raw of list) {
		const name = String(raw?.name ?? '').trim();
		if (!IDENT.test(name) || RESERVED.has(name) || seen.has(name)) continue;
		seen.add(name);
		const type = types.includes(raw?.type) ? raw.type : 'number';
		/** @type {ScriptSocket} */
		const socket = { name, type };
		if (raw && 'value' in raw && raw.value !== undefined) socket.value = raw.value;
		out.push(socket);
	}
	return out;
}

/** @param {any} data @returns {ScriptSocket[] | null} declared inputs, or null for a v1 node */
export function scriptInputs(data) {
	return normalizeSockets(data?.inputs, SCRIPT_INPUT_TYPES);
}

/** @param {any} data @returns {ScriptSocket[]} declared outputs ([] when none) */
export function scriptOutputs(data) {
	return normalizeSockets(data?.outputs, SCRIPT_OUTPUT_TYPES) ?? [];
}

/** Has the node opted into v2 (either list declared)? @param {any} data */
export function isScriptV2(data) {
	return Array.isArray(data?.inputs) || Array.isArray(data?.outputs);
}

/** A v2 node with outputs is pulled as a value, never run as an effect. @param {any} data */
export function isScriptValue(data) {
	return scriptOutputs(data).length > 0;
}

/** @param {string} nodeType @param {any} data @param {string | null | undefined} handle
 * @returns {string | null} a declared socket's type, or null when the node does not declare it */
export function scriptSocketType(nodeType, data, handle, kind = 'input') {
	if (nodeType !== 'script' || !handle) return null;
	const list = kind === 'input' ? scriptInputs(data) : scriptOutputs(data);
	return list?.find((s) => s.name === handle)?.type ?? null;
}

/** the typed zero an unwired, undialled input reads @param {string} type */
export function typedZero(type) {
	if (type === 'boolean' || type === 'event') return false;
	if (type === 'vector3') return [0, 0, 0];
	if (type === 'color') return '#ffffff';
	if (type === 'object') return null;
	return 0;
}

/** @param {any} v */
const finite = (v) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
};

/**
 * Coerce a wired (or dialled) value to the declared type. Values arrive from every kind of
 * source — an event node's pulse is a number, a Compare is a boolean, a Vector3 an array — so
 * the script sees ONE shape per declared type and never has to guess.
 * An `object` input is resolved by the CALLER (it needs the scene); here it stays as given.
 * @param {string} type @param {any} v
 */
export function coerceInput(type, v) {
	if (v === undefined || v === null) return typedZero(type);
	if (type === 'number') return Array.isArray(v) ? finite(v[0]) : typeof v === 'boolean' ? (v ? 1 : 0) : finite(v);
	if (type === 'boolean' || type === 'event') return Array.isArray(v) ? v.length > 0 : typeof v === 'number' ? v !== 0 : !!v;
	if (type === 'vector3') {
		if (Array.isArray(v)) return [finite(v[0]), finite(v[1]), finite(v[2])];
		if (typeof v === 'object' && 'x' in v) return [finite(v.x), finite(v.y), finite(v.z)];
		const n = finite(v);
		return [n, n, n];
	}
	if (type === 'color') return typeof v === 'string' ? v : '#ffffff';
	return v;
}

/** Coerce a returned value to its output's declared type. Returns undefined for "nothing
 * usable", which a consumer treats as unwired (it keeps its own dialled value).
 * @param {string} type @param {any} v */
export function coerceOutput(type, v) {
	if (v === undefined) return undefined;
	if (type === 'object') return typeof v === 'string' ? v : typeof v?.uuid === 'string' ? v.uuid : undefined;
	return coerceInput(type, v);
}

/**
 * Turn a v2 function's return into the multi-output HANDLE MAP the runtime already knows
 * (`unwrapHandle`): `{__handles: {name: value}, __default: first output}`. A missing return,
 * a non-object return, or a missing key is reported, never thrown — the badge says which.
 * @param {any} result @param {ScriptSocket[]} outputs
 * @returns {{ value: { __handles: Record<string, any>, __default: any }, problems: string[] }}
 */
export function harvestOutputs(result, outputs) {
	/** @type {Record<string, any>} */
	const handles = {};
	/** @type {string[]} */
	const problems = [];
	const bag = result && typeof result === 'object' && !Array.isArray(result) ? result : null;
	if (!bag) problems.push('return an object like { ' + outputs.map((o) => o.name + ': …').join(', ') + ' }');
	for (const o of outputs) {
		if (bag && !(o.name in bag)) problems.push('missing output `' + o.name + '`');
		handles[o.name] = coerceOutput(o.type, bag?.[o.name]);
	}
	return { value: { __handles: handles, __default: outputs.length ? handles[outputs[0].name] : undefined }, problems };
}

/** A point out of whatever a script holds: [x,y,z], {x,y,z}, or an object view {position}. @param {any} p */
function pointOf(p) {
	if (Array.isArray(p)) return [finite(p[0]), finite(p[1]), finite(p[2])];
	if (p && Array.isArray(p.position)) return pointOf(p.position);
	if (p && typeof p === 'object' && 'x' in p) return [finite(p.x), finite(p.y), finite(p.z)];
	return [0, 0, 0];
}

/** the helpers a v2 script is handed (pure; no scene access) */
export const SCRIPT_HELPERS = {
	/** distance between two points / object views @param {any} a @param {any} b */
	dist(a, b) {
		const p = pointOf(a);
		const q = pointOf(b);
		return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
	},
	/** @param {number} a @param {number} b @param {number} t */
	lerp: (a, b, t) => a + (b - a) * t,
	/** @param {number} v @param {number} lo @param {number} hi */
	clamp: (v, lo, hi) => Math.min(Math.max(v, lo), hi)
};

/** The v2 template a new Script node starts from when it opts in. */
export const SCRIPT_V2_TEMPLATE =
	'// runs on every peer — a pure function of inputs and time\n' +
	'// inputs.<name>: your declared sockets; helpers: dist, lerp, clamp\n' +
	'return { out: inputs.a * 2 };\n';

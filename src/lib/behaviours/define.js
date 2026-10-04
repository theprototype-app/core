// 34 R3 (D1) — THE BEHAVIOUR FORMAT: `export default behaviour({params, state, on, …methods})`.
//
// A pure LEAF (imports nothing): the shape check and the normalisers every other behaviour file
// reads, so the runtime (core.js), the static analysis (analyze.js) and the logic sim agree on
// what a behaviour IS.
//
//   params   tunables. `reach: 1.2` or `reach: {value: 1.2, min: 0.5, max: 3, step: 0.1, unit: 'm'}`.
//            Read as `this.params.reach` (a number, a boolean or a string). The derived node view
//            draws each as a knob that rewrites the LITERAL in the source (analyze.js).
//   state    replicated game state, `{wave: 0, alive: 0}` — plain JSON. Written by handlers on the
//            ONE authority peer (kit/authority.js — the same peer the kit picks), copied to every
//            peer (`bhv` wire, latest-wins), so a joiner and a new authority carry on from it.
//   on       event handlers, `{roundStart() {…}, died({entity}) {…}, grabRequest({piece, refuse}) {…}}`
//            (events.js names them and types their payloads).
//   anything else that is a function is a METHOD, callable as `this.name(…)` and as an
//   `after` target by name (`this.after(3, 'startWave', 2)` survives the authority leaving).

/** keys of a behaviour object that are not methods */
export const RESERVED_KEYS = ['name', 'doc', 'params', 'state', 'on'];

/** names a method may not take (they are the handler `this`'s own members) */
export const CONTEXT_MEMBERS = [
	'params',
	'state',
	'kit',
	'after',
	'cancel',
	'rand',
	'randInt',
	'pick',
	'now',
	'time',
	'log',
	'isAuthority',
	'me',
	'object',
	'emit',
	'id',
	'find',
	'findAll'
];

/** the marker `behaviour()` puts on a definition */
export const BEHAVIOUR_MARK = '__tpBehaviour';

/**
 * Normalise one param declaration: a bare literal, or `{value, min?, max?, step?, unit?, label?,
 * options?}`. Numbers get a range (a knob needs one): the declared one, else around the value.
 * @param {any} raw
 * @returns {{value: any, type: 'number'|'boolean'|'string', min?: number, max?: number, step?: number,
 *   unit?: string, label?: string, options?: string[]} | null}
 */
export function normalizeParam(raw) {
	const decl = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : { value: raw };
	const value = decl.value;
	const extra = {
		...(typeof decl.unit === 'string' ? { unit: decl.unit } : {}),
		...(typeof decl.label === 'string' ? { label: decl.label } : {})
	};
	if (typeof value === 'number' && Number.isFinite(value)) {
		const span = Math.max(1, Math.abs(value));
		const min = Number.isFinite(decl.min) ? decl.min : Math.min(0, value);
		const max = Number.isFinite(decl.max) ? decl.max : value + span * 4;
		const step = Number.isFinite(decl.step) && decl.step > 0 ? decl.step : Number.isInteger(value) && Number.isInteger(min) ? 1 : 0.1;
		return { value, type: 'number', min, max: Math.max(min, max), step, ...extra };
	}
	if (typeof value === 'boolean') return { value, type: 'boolean', ...extra };
	if (typeof value === 'string') {
		const options = Array.isArray(decl.options) ? decl.options.map(String) : undefined;
		return { value, type: 'string', ...(options ? { options } : {}), ...extra };
	}
	return null;
}

/** every param of a definition, normalised (a param that is not a number/boolean/string is
 * dropped — `problems` names it) @param {any} def */
export function paramsOf(def) {
	/** @type {Record<string, NonNullable<ReturnType<typeof normalizeParam>>>} */
	const out = {};
	for (const [key, raw] of Object.entries(def?.params ?? {})) {
		const p = normalizeParam(raw);
		if (p) out[key] = p;
	}
	return out;
}

/** the initial state, deep-copied JSON @param {any} def */
export function initialState(def) {
	try {
		return JSON.parse(JSON.stringify(def?.state ?? {})) ?? {};
	} catch {
		return {};
	}
}

/** the method names of a definition @param {any} def */
export function methodsOf(def) {
	return Object.keys(def ?? {}).filter((k) => !RESERVED_KEYS.includes(k) && typeof def[k] === 'function');
}

/**
 * A definition's shape problems, as sentences (empty = fine).
 * @param {any} def @returns {string[]}
 */
export function problems(def) {
	/** @type {string[]} */
	const out = [];
	if (!def || typeof def !== 'object') return ['a behaviour must be an object: behaviour({params, state, on})'];
	for (const key of Object.keys(def)) {
		if (RESERVED_KEYS.includes(key)) continue;
		if (typeof def[key] !== 'function') out.push('"' + key + '" is neither params/state/on nor a method');
		else if (CONTEXT_MEMBERS.includes(key)) out.push('method "' + key + '" hides this.' + key);
	}
	if (def.params !== undefined && (typeof def.params !== 'object' || def.params === null)) out.push('params must be an object');
	for (const [key, raw] of Object.entries(def.params ?? {}))
		if (!normalizeParam(raw)) out.push('param "' + key + '" must be a number, boolean or string (or {value, min, max})');
	if (def.state !== undefined) {
		if (typeof def.state !== 'object' || def.state === null || Array.isArray(def.state)) out.push('state must be an object');
		else {
			try {
				JSON.stringify(def.state);
			} catch {
				out.push('state must be plain JSON');
			}
			for (const [key, v] of Object.entries(def.state)) if (typeof v === 'function') out.push('state "' + key + '" is a function');
		}
	}
	if (def.on !== undefined && (typeof def.on !== 'object' || def.on === null)) out.push('on must be an object of handlers');
	for (const [name, fn] of Object.entries(def.on ?? {})) if (typeof fn !== 'function') out.push('on.' + name + ' is not a function');
	return out;
}

/**
 * THE AUTHORING CALL. Returns the definition, marked; a malformed one throws with every problem
 * named (the loader shows it as the behaviour's error).
 * @template T @param {T} def @returns {T}
 */
export function behaviour(def) {
	const found = problems(def);
	if (found.length) throw new Error('behaviour: ' + found.join('; '));
	Object.defineProperty(def, BEHAVIOUR_MARK, { value: true, enumerable: false });
	return def;
}

/** @param {any} v */
export function isBehaviour(v) {
	return !!v && typeof v === 'object' && v[BEHAVIOUR_MARK] === true;
}

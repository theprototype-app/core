// Roadmap 86 B5 — EVERY RELAYED CALL IS CHECKED AGAINST THE TOOL'S OWN SCHEMA before it reaches
// tpAgent.exec. The schema is the one `tpAgent.tools()` hands a local agent (getAiTools' `parameters`,
// verbatim), so a remote caller is held to exactly the contract a local agent reads. Imports nothing.
//
// A JSON Schema SUBSET — the keywords the app's tool schemas use (type, properties, required, items,
// enum) plus the common bounds (minimum/maximum, min/maxItems, maxLength, additionalProperties,
// anyOf/oneOf). An unknown keyword is ignored, never a refusal. On top of the schema, hard caps on the
// SHAPE of what arrives (depth, node count, string length), so a hostile payload cannot make the tab
// walk a million-element structure before a tool even looks at it.

/** deepest nesting a call's args may have */
export const MAX_DEPTH = 24;
/** most values (objects + arrays + leaves) in one call's args */
export const MAX_NODES = 50000;
/** longest single string (a behaviour's source is the big one) */
export const MAX_STRING = 200000;
/** errors reported per call (enough to fix it, not a wall) */
const MAX_ERRORS = 8;

/** @param {any} v @returns {string} */
function typeOf(v) {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'array';
	return typeof v;
}

/** does `v` satisfy one JSON Schema type name? @param {any} v @param {string} t */
function isType(v, t) {
	switch (t) {
		case 'object':
			return typeOf(v) === 'object';
		case 'array':
			return Array.isArray(v);
		case 'string':
			return typeof v === 'string';
		case 'number':
			return typeof v === 'number' && Number.isFinite(v);
		case 'integer':
			return typeof v === 'number' && Number.isInteger(v);
		case 'boolean':
			return typeof v === 'boolean';
		case 'null':
			return v === null;
		default:
			return true; // a type this subset does not know: not ours to refuse
	}
}

/**
 * The shape caps alone (depth, node count, string length). Null = fine, else why not.
 * @param {any} value @returns {string|null}
 */
export function shapeProblem(value) {
	let nodes = 0;
	/** @param {any} v @param {number} depth @returns {string|null} */
	const walk = (v, depth) => {
		if (++nodes > MAX_NODES) return 'too many values (more than ' + MAX_NODES + ')';
		if (depth > MAX_DEPTH) return 'nested too deeply (more than ' + MAX_DEPTH + ' levels)';
		if (typeof v === 'string') return v.length > MAX_STRING ? 'a string longer than ' + MAX_STRING + ' characters' : null;
		if (typeof v === 'number') return Number.isFinite(v) ? null : 'a number that is not finite';
		if (Array.isArray(v)) {
			for (const x of v) {
				const p = walk(x, depth + 1);
				if (p) return p;
			}
			return null;
		}
		if (v && typeof v === 'object') {
			if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return 'a value that is not plain JSON';
			for (const k of Object.keys(v)) {
				if (k === '__proto__' || k === 'constructor' || k === 'prototype') return 'a forbidden key "' + k + '"';
				const p = walk(v[k], depth + 1);
				if (p) return p;
			}
		}
		return null;
	};
	return walk(value, 0);
}

/**
 * Validate `value` against `schema`. Returns the problems found (empty = valid), each `path: what`.
 * @param {any} schema @param {any} value @param {string} [path] @param {string[]} [errors]
 * @returns {string[]}
 */
export function schemaErrors(schema, value, path = 'args', errors = []) {
	if (errors.length >= MAX_ERRORS || !schema || typeof schema !== 'object') return errors;
	const push = (/** @type {string} */ msg) => {
		if (errors.length < MAX_ERRORS) errors.push(path + ': ' + msg);
	};

	const alts = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null;
	if (alts && alts.length && !alts.some((/** @type {any} */ s) => schemaErrors(s, value, path).length === 0)) {
		push('matches none of the allowed shapes');
		return errors;
	}

	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (!types.some((/** @type {string} */ t) => isType(value, t))) {
			push('expected ' + types.join(' or ') + ', got ' + typeOf(value));
			return errors;
		}
	}
	if (Array.isArray(schema.enum) && !schema.enum.some((/** @type {any} */ e) => e === value)) {
		push('must be one of ' + schema.enum.map((/** @type {any} */ e) => JSON.stringify(e)).join(', '));
		return errors;
	}
	if ('const' in schema && schema.const !== value) {
		push('must be ' + JSON.stringify(schema.const));
		return errors;
	}

	if (typeof value === 'number') {
		if (typeof schema.minimum === 'number' && value < schema.minimum) push('must be ≥ ' + schema.minimum);
		if (typeof schema.maximum === 'number' && value > schema.maximum) push('must be ≤ ' + schema.maximum);
	}
	if (typeof value === 'string') {
		if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) push('longer than ' + schema.maxLength + ' characters');
		if (typeof schema.minLength === 'number' && value.length < schema.minLength) push('shorter than ' + schema.minLength + ' characters');
	}
	if (Array.isArray(value)) {
		if (typeof schema.minItems === 'number' && value.length < schema.minItems) push('needs at least ' + schema.minItems + ' items');
		if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) push('at most ' + schema.maxItems + ' items');
		if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items))
			for (let i = 0; i < value.length && errors.length < MAX_ERRORS; i++) schemaErrors(schema.items, value[i], path + '[' + i + ']', errors);
	}
	if (typeOf(value) === 'object') {
		const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
		if (Array.isArray(schema.required))
			for (const k of schema.required) if (!(k in value)) push('missing required "' + k + '"');
		for (const k of Object.keys(value)) {
			if (errors.length >= MAX_ERRORS) break;
			if (Object.prototype.hasOwnProperty.call(props, k)) schemaErrors(props[k], value[k], path + '.' + k, errors);
			else if (schema.additionalProperties === false) push('unknown field "' + k + '"');
			else if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
				schemaErrors(schema.additionalProperties, value[k], path + '.' + k, errors);
		}
	}
	return errors;
}

/**
 * The whole check for one relayed call: shape caps first (cheap, bounded), then the schema.
 * @param {any} schema the tool's `parameters` (absent = an empty object schema)
 * @param {any} args
 * @returns {{ok: true} | {ok: false, problems: string[]}}
 */
export function validateArgs(schema, args) {
	const shape = shapeProblem(args);
	if (shape) return { ok: false, problems: ['args: ' + shape] };
	const problems = schemaErrors(schema && typeof schema === 'object' ? schema : { type: 'object' }, args);
	return problems.length ? { ok: false, problems } : { ok: true };
}

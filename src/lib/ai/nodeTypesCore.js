// 86 T1 (= 85 R9) — `describe_node_types`: what a flow node type takes and gives, so an agent wires
// `toHandle` / `fromHandle` right the FIRST time instead of learning the names from D24's edge errors.
// Imports NOTHING (the unit layer's entry rule): flowTools.js hands in the real catalog, docs and socket
// tables, so the answer is generated from the one source the editor draws from and cannot drift.
//
// Results stay SMALL (a voice conversation reads them): no arguments = the type names by group; a
// group = its types with their one-line docs; named types = the full card, at most MAX_TYPES per call.

/** Most types described in full per call (a card is ~300-600 characters). */
export const MAX_TYPES = 12;

/**
 * @typedef {{
 *   vocabulary: {group: string, types: string[]}[],
 *   spec: (type: string) => any,
 *   doc: (type: string) => string,
 *   inputs: (type: string) => {name: string, type: string}[],
 *   output: (type: string) => string,
 *   namedOutputs: (type: string) => {name: string, type: string}[],
 *   match: (raw: any) => string | null,
 *   codeView?: boolean
 * }} NodeTypeSource
 */

/** a param's value type, from its editor kind or its default @param {any} p @param {any} def */
function paramType(p, def) {
	const kind = p?.kind;
	if (kind === 'range' || kind === 'number') return 'number';
	if (kind === 'toggle') return 'boolean';
	if (kind === 'select') return 'choice';
	if (kind === 'color' || kind === 'vector3') return kind;
	if (kind === 'text' || kind === 'code') return 'text';
	if (Array.isArray(def)) return 'array';
	if (typeof def === 'string' && /^#[0-9a-f]{3,8}$/i.test(def)) return 'color';
	if (def === null || def === undefined) return 'any';
	return typeof def === 'object' ? 'object' : typeof def;
}

/**
 * The data params of a spec: every editor param (with its kind, range, options) plus every default
 * the editor does not draw (e.g. Path patrol's `points`). A `legacy: true` param is left out; a `legacy`
 * VALUE (On Enter `who`, Distance `to`, On Impact `direction`) is what a node without the key reads, so it
 * is that param's default here (2.0-n3b: these were hidden, so an agent never learnt `who: "player"`).
 * @param {any} spec @returns {any[]}
 */
export function paramsOf(spec) {
	const defaults = spec?.defaults && typeof spec.defaults === 'object' ? spec.defaults : {};
	/** @type {Map<string, any>} */
	const out = new Map();
	for (const p of Array.isArray(spec?.params) ? spec.params : []) {
		if (!p || typeof p.key !== 'string' || p.legacy === true || out.has(p.key)) continue;
		const def = p.key in defaults ? defaults[p.key] : 'legacy' in p ? p.legacy : undefined;
		/** @type {any} */
		const row = { key: p.key, type: paramType(p, def) };
		if (def !== undefined) row.default = def;
		if (Array.isArray(p.options)) row.options = p.options;
		if (Number.isFinite(p.min)) row.min = p.min;
		if (Number.isFinite(p.max)) row.max = p.max;
		if (typeof p.label === 'string' && p.label !== p.key) row.label = p.label;
		if (typeof p.doc === 'string') row.doc = p.doc; // 85 N1: units (degrees / metres) an agent cannot guess
		out.set(p.key, row);
	}
	for (const [key, value] of Object.entries(defaults)) {
		if (out.has(key) || key === 'label') continue;
		out.set(key, { key, type: paramType(null, value), default: value });
	}
	return [...out.values()];
}

/**
 * 2.0-n3b (N3a star-once): may an agent set `key` on a node of this spec, and to what? Every editor param
 * and every default is settable (create_flow_nodes used to take DEFAULT keys only, so `latch {perRound: true}`
 * arrived as false and On Enter's `who` was dropped). A choice outside its options and a toggle that is not a
 * boolean are refused with the valid values, so the node keeps its default instead of a value it ignores.
 * `null` = not a param of this type (the caller drops it, as before).
 * @param {any} spec @param {string} key @param {any} value
 * @returns {null | {ok: true, value: any} | {ok: false, error: string}}
 */
export function paramValue(spec, key, value) {
	const row = paramsOf(spec).find((p) => p.key === key);
	if (!row) return null;
	if (row.type === 'choice' && Array.isArray(row.options) && !row.options.includes(value))
		return { ok: false, error: key + ' must be one of ' + row.options.map((o) => JSON.stringify(o)).join(', ') };
	if (row.type === 'boolean' && typeof value !== 'boolean') {
		if (value === 'true' || value === 'false') return { ok: true, value: value === 'true' };
		return { ok: false, error: key + ' is true or false' };
	}
	return { ok: true, value };
}

/** the full card for one known type @param {string} type @param {string} group @param {NodeTypeSource} src */
export function describeType(type, group, src) {
	const spec = src.spec(type) ?? {};
	/** @type {any} */
	const card = { type, label: spec.label ?? type, group, doc: src.doc(type) || undefined };
	const inputs = src.inputs(type);
	if (inputs.length) card.inputs = inputs;
	card.output = src.output(type);
	const named = src.namedOutputs(type);
	if (named.length) card.namedOutputs = named;
	const params = paramsOf(spec);
	if (params.length) card.params = params;
	if (typeof spec.note === 'string') card.note = spec.note;
	// 2.0 N2 (flag codeView): how this type reads in the graph's code (list_scene {flow} → code)
	if (src.codeView) card.code = codeShape(type, params, inputs, card.output);
	return card;
}

/**
 * 2.0 N2: one type's statement shape in the code view — `type({ params? }, { input: type }) -> output`.
 * @param {string} type @param {any[]} params @param {{name: string, type: string}[]} inputs @param {string} output
 */
export function codeShape(type, params, inputs, output) {
	const callee = /^[A-Za-z_$][\w$]*$/.test(type) ? type : "use('" + type + "')";
	const p = params.length ? '{ ' + params.map((x) => x.key + '?').join(', ') + ' }' : '{}';
	const w = inputs.length ? ', { ' + inputs.map((i) => i.name + ': ' + i.type).join(', ') + ' }' : '';
	return callee + '(' + p + w + ') -> ' + output;
}

/**
 * The tool. `{}` = names by group; `{group}` = that group's types with docs; `{types:[…]}` = full cards.
 * Unknown names come back in `unknown` (with the near-miss the executor would take), never an error
 * for the whole call.
 * @param {any} args @param {NodeTypeSource} src
 */
export function describeNodeTypes(args, src) {
	const groupOf = new Map();
	for (const g of src.vocabulary) for (const t of g.types) groupOf.set(t, g.group);
	const raw = Array.isArray(args?.types) ? args.types : typeof args?.types === 'string' ? [args.types] : [];
	if (raw.length) {
		/** @type {any[]} */
		const cards = [];
		/** @type {string[]} */
		const unknown = [];
		/** @type {Record<string, string>} */
		const resolved = {};
		for (const r of raw.slice(0, MAX_TYPES)) {
			const hit = src.match(r);
			if (!hit || !groupOf.has(hit)) {
				unknown.push(String(r).slice(0, 64));
				continue;
			}
			if (hit !== r) resolved[String(r).slice(0, 64)] = hit;
			if (!cards.some((c) => c.type === hit)) cards.push(describeType(hit, groupOf.get(hit), src));
		}
		/** @type {any} */
		const out = { types: cards };
		if (Object.keys(resolved).length) out.resolved = resolved;
		if (unknown.length) out.unknown = unknown;
		if (raw.length > MAX_TYPES) out.note = `only the first ${MAX_TYPES} types are described per call; ask again for the rest`;
		if (src.codeView) out.code = 'code: how each type reads in list_scene {flow} → code — `const x = type({ params that differ from the defaults }, { input: source, input2: other.namedOutput })`; an unnamed input reads `in`; `// #id` = the node id.';
		out.wiring = 'edges: toHandle = an input name (or a param key, which a wire then drives); fromHandle only for namedOutputs (omit it for the plain output). Types must match, or number→boolean/vector3, boolean→number, event→number/boolean, vector3↔object.';
		return out;
	}
	const wanted = typeof args?.group === 'string' ? args.group.trim().toLowerCase() : '';
	if (wanted) {
		const g = src.vocabulary.find((x) => x.group.toLowerCase() === wanted);
		if (!g) return { error: 'no node group "' + args.group + '". Groups: ' + src.vocabulary.map((x) => x.group).join(', ') };
		return { group: g.group, types: g.types.map((t) => ({ type: t, doc: src.doc(t) || undefined })), next: 'pass types:[…] for inputs, outputs and params' };
	}
	return {
		groups: Object.fromEntries(src.vocabulary.map((g) => [g.group, g.types])),
		next: 'pass group:"<name>" for one-line docs, or types:[…] (up to ' + MAX_TYPES + ') for inputs, outputs and params'
	};
}

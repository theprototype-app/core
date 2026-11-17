// 2.0 N2 — A FLOW GRAPH AS CODE (read-only). The LOGIC reading of a graph: one statement per node,
// sources first, wires as arguments, the node id in a trailing `// #<id>` comment — what the Nodes
// editor's Code tab, the phone/VR sheet and the agent's `code` field all show (one generator).
// graphText (34 D4) stays the lossless DATA format; this one leaves out what is not logic
// (positions, classes, group frames, notes) and the parser (flowCodeParse.js) fills catalog
// defaults back in, so graph -> code -> graph is exact on ids, types, effective data and wires.
// See src/lib/nodes/DESIGN.md §2. A LEAF: imports nothing (the editor and the agent pass the
// catalog lookups in as options, graphText's TextOptions shape).
//
//   // Scene flow · generated from the graph · read-only
//   export default flow(({ onclick, latch, visibility }) => {
//   	const click = onclick(); // #6f1c
//   	const open = latch({ initial: false }, { set: click }); // #a03b
//   	visibility({}, { on: open }); // #c9e2
//   });

/** editor-only node kinds: not logic, never in the code (nodeGroups GROUP_TYPE / NOTE_TYPE) */
export const NOT_LOGIC = new Set(['group', 'note']);

/** the wires key an edge with no target handle reads as */
export const UNNAMED_IN = 'in';

/**
 * @typedef {{ defaults?: (type: string) => Record<string, any> | undefined, defaultLabel?: (type: string) => string, title?: string }} CodeOptions
 * @typedef {{ code: string, lineOf: Record<string, number>, nodeAt: Record<number, string> }} FlowCode
 */

const IDENT = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set(
	('break case catch class const continue debugger default delete do else enum export extends false finally for ' +
		'function if import in instanceof new null return super switch this throw true try typeof var void while with ' +
		'yield let static implements interface package private protected public await async of undefined NaN Infinity flow use')
		.split(' ')
);
const isIdent = (/** @type {string} */ s) => IDENT.test(s) && !RESERVED.has(s);

/** a string literal in single quotes @param {string} s */
function quote(s) {
	return "'" + JSON.stringify(s).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'") + "'";
}

/** an object key: bare when it can be @param {string} k */
const key = (k) => (IDENT.test(k) ? k : quote(k));

/** a JSON value as a JS literal (single-line) @param {any} v @returns {string} */
export function printLiteral(v) {
	if (v === null || v === undefined) return 'null';
	if (typeof v === 'string') return quote(v);
	if (typeof v === 'number') return Number.isFinite(v) ? (Object.is(v, -0) ? '-0' : String(v)) : 'null';
	if (typeof v === 'boolean') return String(v);
	if (Array.isArray(v)) return '[' + v.map(printLiteral).join(', ') + ']';
	if (typeof v === 'object') {
		const ks = Object.keys(v).filter((k) => v[k] !== undefined);
		return ks.length ? '{ ' + ks.map((k) => key(k) + ': ' + printLiteral(v[k])).join(', ') + ' }' : '{}';
	}
	return 'null';
}

/** what of `data` the code shows: no `type` (the callee says it), no default label, no value at its default
 * @param {any} n @param {CodeOptions} opts */
export function codeParams(n, opts) {
	const data = n.data ?? {};
	const defaults = opts.defaults?.(n.type);
	/** @type {Record<string, any>} */
	const out = {};
	for (const k of Object.keys(data)) {
		if (k === 'type' && data.type === n.type) continue;
		if (k === 'label' && opts.defaultLabel && opts.defaultLabel(n.type) === data.label) continue;
		if (defaults && k in defaults && JSON.stringify(defaults[k]) === JSON.stringify(data[k])) continue;
		if (data[k] === undefined) continue;
		out[k] = data[k];
	}
	return out;
}

/** a readable binding: the label in camelCase, else the type; never a type name, a keyword or a twin
 * @param {any} n @param {Set<string>} taken */
function bindingFor(n, taken) {
	const label = typeof n.data?.label === 'string' ? n.data.label : '';
	const words = label
		.normalize('NFKD')
		.replace(/[^\w\s]/g, ' ')
		.trim()
		.split(/[\s_]+/)
		.filter(Boolean);
	let base = words.map((/** @type {string} */ w, /** @type {number} */ i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
	let first = 2;
	if (!base || !/^[A-Za-z_$]/.test(base) || base.length > 24) {
		// no usable label: the type, numbered from 1 (`math1`, `math2` — a bare `math` is the node function)
		base = String(n.type).replace(/[^\w$]/g, '') || 'node';
		first = 1;
	}
	if (!/^[A-Za-z_$]/.test(base)) base = 'n' + base;
	let name = first === 1 ? base + 1 : base;
	for (let i = first + 1; !isIdent(name) || taken.has(name); i++) name = base + i;
	taken.add(name);
	return name;
}

/** sources first: Kahn over the edges, ties (and whatever a cycle leaves) in the graph's own order
 * @param {any[]} nodes @param {any[]} edges @returns {any[]} */
export function codeOrder(nodes, edges) {
	const index = new Map(nodes.map((n, i) => [n.id, i]));
	const indeg = new Map(nodes.map((n) => [n.id, 0]));
	/** @type {Map<string, string[]>} */
	const out = new Map();
	for (const e of edges) {
		if (!index.has(e.source) || !index.has(e.target) || e.source === e.target) continue;
		indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
		if (!out.has(e.source)) out.set(e.source, []);
		out.get(e.source)?.push(e.target);
	}
	const ready = nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id);
	/** @type {string[]} */
	const order = [];
	const done = new Set();
	const pick = () => {
		// the ready node earliest in the graph
		let best = 0;
		for (let i = 1; i < ready.length; i++) if ((index.get(ready[i]) ?? 0) < (index.get(ready[best]) ?? 0)) best = i;
		return ready.splice(best, 1)[0];
	};
	while (order.length < nodes.length) {
		if (!ready.length) {
			// a cycle: the earliest node not yet placed goes next (its inputs read as forward references)
			const next = nodes.find((n) => !done.has(n.id));
			ready.push(next.id);
			indeg.set(next.id, 0);
		}
		const id = pick();
		if (done.has(id)) continue;
		done.add(id);
		order.push(id);
		for (const t of out.get(id) ?? []) {
			if (done.has(t)) continue;
			const d = (indeg.get(t) ?? 0) - 1;
			indeg.set(t, d);
			if (d === 0) ready.push(t);
		}
	}
	return order.map((id) => nodes[/** @type {number} */ (index.get(id))]);
}

/**
 * The code for one graph, with the node <-> line map (1-based lines) the editor jumps by.
 * @param {{ nodes: any[], edges: any[] }} graph @param {CodeOptions} [opts] @returns {FlowCode}
 */
export function graphToCode(graph, opts = {}) {
	const nodes = (graph?.nodes ?? []).filter((n) => n && typeof n.id === 'string' && !NOT_LOGIC.has(n.type));
	const ids = new Set(nodes.map((n) => n.id));
	const edges = (graph?.edges ?? []).filter((e) => e && ids.has(e.source) && ids.has(e.target));
	const ordered = codeOrder(nodes, edges);
	const types = [...new Set(ordered.map((n) => String(n.type)))].filter(isIdent).sort();
	const taken = new Set(types);
	const consumed = new Set(edges.map((e) => e.source));
	/** @type {Map<string, string>} */
	const binding = new Map();
	for (const n of ordered) if (consumed.has(n.id)) binding.set(n.id, bindingFor(n, taken));
	/** @type {Map<string, any[]>} */
	const into = new Map();
	for (const e of edges) {
		if (!into.has(e.target)) into.set(e.target, []);
		into.get(e.target)?.push(e);
	}
	const ref = (/** @type {any} */ e) => {
		const v = /** @type {string} */ (binding.get(e.source));
		const h = e.sourceHandle;
		if (!h) return v;
		return IDENT.test(h) ? v + '.' + h : v + '[' + quote(h) + ']';
	};
	const lines = [
		'// ' + (opts.title ?? 'Flow') + ' · generated from the graph · read-only',
		'export default flow(({ ' + types.join(', ') + ' }) => {'
	];
	if (!types.length) lines[1] = 'export default flow(() => {';
	/** @type {Record<string, number>} */
	const lineOf = {};
	/** @type {Record<number, string>} */
	const nodeAt = {};
	for (const n of ordered) {
		const params = printLiteral(codeParams(n, opts));
		/** @type {Map<string, string[]>} */
		const wires = new Map();
		for (const e of into.get(n.id) ?? []) {
			const h = e.targetHandle || UNNAMED_IN;
			if (!wires.has(h)) wires.set(h, []);
			wires.get(h)?.push(ref(e));
		}
		const w = [...wires].map(([h, refs]) => key(h) + ': ' + (refs.length > 1 ? '[' + refs.join(', ') + ']' : refs[0]));
		const args = w.length ? params + ', { ' + w.join(', ') + ' }' : params === '{}' ? '' : params;
		const callee = isIdent(String(n.type)) ? String(n.type) : 'use(' + quote(String(n.type)) + ')';
		const decl = binding.has(n.id) ? 'const ' + binding.get(n.id) + ' = ' : '';
		lines.push('\t' + decl + callee + '(' + args + '); // #' + n.id);
		lineOf[n.id] = lines.length;
		nodeAt[lines.length] = n.id;
	}
	lines.push('});', '');
	return { code: lines.join('\n'), lineOf, nodeAt };
}

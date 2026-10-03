// 34 D4 — COMPACT GRAPH TEXT: a flow graph as lines a person (or a model) can read.
//
//   click = gamesound "Button click" {sound: "click"} @520,40
//   lvl1 = hudbutton "Level 1 button" {element: "lvl-1"} @40,40
//   lvl1 -> click.trigger
//   s1.show -> vis.on
//
// It is the SAME DATA as the graph JSON, not a language (proposal §2 D4): a node line is
// `id = type "label" {params} @x,y`, an edge line is `source[.handle] -> target[.handle]`,
// and everything the JSON spends on repetition is said once as a CONVENTION instead:
//   - `"label"`     data.label when it is data's FIRST key and a string (the editor's order)
//   - `type+`       data.type equal to the node type right after the label (editor-made nodes)
//   - `{params}`    the rest of data, in order — JSON values, keys bare when they can be
//   - `@x,y`        position
//   - (nothing)     class `w-[150px]`, the class every builder stamps; `class:"…"` / `noclass`
//                   say otherwise
//   - (no `#id`)    an edge id of the canonical shape `e-<src>[.<h>]-<tgt>[.<h>]` (Nodes.svelte
//                   and flowTools build exactly that); a different id is kept as `#id`
// Anything that fits no convention — an extra node key, keys in another order, an edge that
// carries `type`/`markerEnd` — is written as a RAW line holding its JSON (`id := {…}`,
// `~ {…}`), so the round trip is LOSSLESS by construction: `JSON.stringify(parse(print(g)))`
// equals `JSON.stringify(g)` byte for byte, which the unit test proves on the seven games.
//
// Several graphs (the scene + object flows) are sections under `@graph <key>` lines. `//`
// starts a comment line. MEASURED on the seven 1.19 games (scenes main): the lossless text is
// 2.11-2.38x smaller than their JSON (§4.2 measured 2.3-2.6x on the 1.17 graphs, which carried
// fewer default-valued params); the AI view (`positions: false` + catalog defaults) is smaller
// again — the table is in graphText.test.js's output and the lane handover.
//
// A LEAF (imports nothing): the printer and parser are what is easy to get subtly wrong.

export const DEFAULT_CLASS = 'w-[150px]';
const BARE_ID = /^[A-Za-z0-9_-]+$/;
const BARE_TYPE = /^[A-Za-z0-9_$.:-]+$/;
const BARE_KEY = /^[A-Za-z_$][\w$]*$/;
const NODE_KEYS = ['id', 'type', 'position', 'data', 'class'];
/** the parser's scanner per kind of name: the longest run of that kind's characters */
const SCAN = new Map([
	[BARE_ID, /^[A-Za-z0-9_-]+/],
	[BARE_TYPE, /^[A-Za-z0-9_$.:-]+/],
	[BARE_KEY, /^[A-Za-z_$][\w$]*/]
]);

/** @typedef {{ nodes: any[], edges: any[] }} Graph */

// ---------------------------------------------------------------- printing

/** JSON-faithful value printing: what JSON.stringify would keep, with bare object keys.
 * @param {any} v @returns {string | undefined} undefined = JSON would omit it */
function printValue(v) {
	if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return undefined;
	if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
	if (typeof v.toJSON === 'function') return printValue(v.toJSON());
	if (Array.isArray(v)) return '[' + v.map((x) => printValue(x) ?? 'null').join(', ') + ']';
	const parts = [];
	for (const k of Object.keys(v)) {
		const pv = printValue(v[k]);
		if (pv === undefined) continue;
		parts.push((BARE_KEY.test(k) ? k : JSON.stringify(k)) + ': ' + pv);
	}
	return '{' + parts.join(', ') + '}';
}

/** @param {string} s @param {RegExp} bare */
const name = (s, bare) => (bare.test(s) ? s : JSON.stringify(s));

/** the canonical edge id every builder in this app mints @param {any} e */
export function canonicalEdgeId(e) {
	return (
		'e-' + e.source + (e.sourceHandle ? '.' + e.sourceHandle : '') + '-' + e.target + (e.targetHandle ? '.' + e.targetHandle : '')
	);
}

/** does an object's key list run in the given canonical order (a subset, in order)? @param {any} o @param {string[]} order */
function inOrder(o, order) {
	let at = -1;
	for (const k of Object.keys(o)) {
		const i = order.indexOf(k);
		if (i <= at) return false;
		at = i;
	}
	return true;
}

/** @typedef {{ positions?: boolean, defaultLabel?: (type: string) => string, defaults?: (type: string) => Record<string, any> | undefined }} TextOptions */

/** @param {any} n @param {TextOptions} opts */
function printNode(n, opts) {
	const plain =
		n && typeof n === 'object' && typeof n.id === 'string' && typeof n.type === 'string' &&
		inOrder(n, NODE_KEYS) && n.data && typeof n.data === 'object' && !Array.isArray(n.data) &&
		(!('position' in n) || (n.position && typeof n.position === 'object' && inOrder(n.position, ['x', 'y']) &&
			Object.keys(n.position).length === 2 && Number.isFinite(n.position.x) && Number.isFinite(n.position.y))) &&
		(!('class' in n) || typeof n.class === 'string');
	if (!plain) return name(String(n?.id ?? ''), BARE_ID) + ' := ' + JSON.stringify(n);
	let line = name(n.id, BARE_ID) + ' = ' + name(n.type, BARE_TYPE);
	const keys = Object.keys(n.data);
	let k = 0;
	let label;
	if (keys[0] === 'label' && typeof n.data.label === 'string') {
		label = n.data.label;
		k = 1;
	}
	if (keys[k] === 'type' && n.data.type === n.type) {
		line += '+';
		k++;
	}
	if (label !== undefined && !(opts.positions === false && opts.defaultLabel?.(n.type) === label))
		line += ' ' + JSON.stringify(label);
	/** @type {Record<string, any>} */
	const rest = {};
	// the AI view also drops a param still at its catalog default (the reader knows the
	// defaults; a 1.19 HUD Text node spends a third of its line on `format: "", decimals: 0`)
	const defaults = opts.positions === false ? opts.defaults?.(n.type) : undefined;
	for (const key of keys.slice(k))
		if (!defaults || !(key in defaults) || JSON.stringify(defaults[key]) !== JSON.stringify(n.data[key]))
			rest[key] = n.data[key];
	const params = printValue(rest);
	if (params && params !== '{}') line += ' ' + params;
	if (opts.positions === false) return line;
	if (n.position) line += ' @' + JSON.stringify(n.position.x) + ',' + JSON.stringify(n.position.y);
	if (!('class' in n)) line += ' noclass';
	else if (n.class !== DEFAULT_CLASS) line += ' class:' + JSON.stringify(n.class);
	return line;
}

/** @param {any} e */
function printEdge(e) {
	const plain =
		e && typeof e === 'object' && typeof e.id === 'string' && typeof e.source === 'string' && typeof e.target === 'string' &&
		inOrder(e, ['id', 'source', 'target', 'sourceHandle', 'targetHandle']) &&
		(!('sourceHandle' in e) || (typeof e.sourceHandle === 'string' && e.sourceHandle)) &&
		(!('targetHandle' in e) || (typeof e.targetHandle === 'string' && e.targetHandle));
	if (!plain) return '~ ' + JSON.stringify(e);
	const end = (/** @type {string} */ id, /** @type {string | undefined} */ h) =>
		name(id, BARE_ID) + (h ? '.' + name(h, BARE_ID) : '');
	let line = end(e.source, e.sourceHandle) + ' -> ' + end(e.target, e.targetHandle);
	if (e.id !== canonicalEdgeId(e)) line += ' #' + name(e.id, BARE_ID);
	return line;
}

/**
 * One graph as compact text.
 * @param {Graph} graph
 * @param {TextOptions} [opts]
 *   positions:false = the AI view: no position, no class, a label equal to the node type's
 *   default label (opts.defaultLabel) and params equal to its defaults (opts.defaults) are
 *   dropped. LOSSY on purpose — never Apply it back over a graph; it is for reading, and for
 *   describing NEW nodes.
 */
export function graphToText(graph, opts = {}) {
	const lines = [];
	for (const n of graph?.nodes ?? []) lines.push(printNode(n, opts));
	for (const e of graph?.edges ?? []) lines.push(printEdge(e));
	return lines.join('\n') + (lines.length ? '\n' : '');
}

/**
 * Several graphs (a `{key: graph}` map) as sections under `@graph <key>`.
 * @param {Record<string, Graph>} graphs @param {Parameters<typeof graphToText>[1]} [opts]
 */
export function graphsToText(graphs, opts = {}) {
	return Object.keys(graphs ?? {})
		.map((key) => '@graph ' + name(key, BARE_ID) + '\n' + graphToText(graphs[key], opts))
		.join('');
}

// ---------------------------------------------------------------- parsing

export class GraphTextError extends Error {
	/** @param {string} message @param {number} line @param {number} col */
	constructor(message, line, col) {
		super('line ' + line + ':' + col + ' ' + message);
		this.line = line;
		this.col = col;
	}
}

/** A cursor over ONE line. Every reader skips leading blanks. */
class Cursor {
	/** @param {string} s @param {number} line */
	constructor(s, line) {
		this.s = s;
		this.i = 0;
		this.line = line;
	}
	ws() {
		while (this.i < this.s.length && (this.s[this.i] === ' ' || this.s[this.i] === '\t')) this.i++;
		return this;
	}
	done() {
		return this.ws().i >= this.s.length;
	}
	peek() {
		return this.ws().s[this.i];
	}
	/** @param {string} t */
	eat(t) {
		if (this.ws().s.startsWith(t, this.i)) {
			this.i += t.length;
			return true;
		}
		return false;
	}
	/** @param {string} t */
	expect(t) {
		if (!this.eat(t)) this.fail('expected ' + JSON.stringify(t));
	}
	/** @param {string} msg @returns {never} */
	fail(msg) {
		throw new GraphTextError(msg + (this.i < this.s.length ? ' at ' + JSON.stringify(this.s.slice(this.i, this.i + 12)) : ' at end of line'), this.line, this.i + 1);
	}
	/** a JSON string literal */
	string() {
		this.ws();
		if (this.s[this.i] !== '"') this.fail('expected a "string"');
		let j = this.i + 1;
		while (j < this.s.length && this.s[j] !== '"') j += this.s[j] === '\\' ? 2 : 1;
		if (j >= this.s.length) this.fail('unterminated string');
		const raw = this.s.slice(this.i, j + 1);
		this.i = j + 1;
		try {
			return JSON.parse(raw);
		} catch {
			return this.fail('bad string escape');
		}
	}
	/** a bare word of the kind `re` describes (its own charset, so `a.out` reads as the id
	 * `a` and leaves `.out`), or a "string" @param {RegExp} re */
	word(re) {
		if (this.peek() === '"') return this.string();
		const m = /** @type {RegExp} */ (SCAN.get(re)).exec(this.s.slice(this.i));
		const w = m ? m[0] : '';
		if (!w || !re.test(w)) this.fail('expected a name');
		this.i += w.length;
		return w;
	}
	number() {
		const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.ws().s.slice(this.i));
		if (!m) this.fail('expected a number');
		this.i += /** @type {RegExpExecArray} */ (m)[0].length;
		return Number(/** @type {RegExpExecArray} */ (m)[0]);
	}
	/** a value: JSON, with bare object keys and trailing commas allowed @returns {any} */
	value() {
		const c = this.peek();
		if (c === '{') {
			this.i++;
			/** @type {Record<string, any>} */
			const o = {};
			while (!this.eat('}')) {
				const key = this.peek() === '"' ? this.string() : this.word(BARE_KEY);
				this.expect(':');
				const v = this.value();
				if (key === '__proto__') Object.defineProperty(o, key, { value: v, enumerable: true, configurable: true, writable: true });
				else o[key] = v;
				if (!this.eat(',')) {
					this.expect('}');
					break;
				}
			}
			return o;
		}
		if (c === '[') {
			this.i++;
			const a = [];
			while (!this.eat(']')) {
				a.push(this.value());
				if (!this.eat(',')) {
					this.expect(']');
					break;
				}
			}
			return a;
		}
		if (c === '"') return this.string();
		if (this.eat('true')) return true;
		if (this.eat('false')) return false;
		if (this.eat('null')) return null;
		return this.number();
	}
	/** the rest of the line as JSON (a raw line) */
	json() {
		const rest = this.ws().s.slice(this.i);
		try {
			const v = JSON.parse(rest);
			this.i = this.s.length;
			return v;
		} catch (e) {
			return this.fail('bad JSON: ' + /** @type {any} */ (e).message);
		}
	}
}

/** @param {Cursor} c @param {string} id @param {TextOptions} opts */
function parseNodeRest(c, id, opts) {
	const type = c.word(BARE_TYPE);
	/** @type {Record<string, any>} */
	const data = {};
	let typed = false;
	if (c.s[c.i] === '+') {
		c.i++;
		typed = true;
	}
	let label;
	if (c.peek() === '"') label = c.string();
	else if (opts.defaultLabel) label = opts.defaultLabel(type) || undefined;
	if (label !== undefined) data.label = label;
	if (typed) data.type = type;
	const defaults = opts.defaults?.(type);
	if (defaults) for (const k of Object.keys(defaults)) data[k] = defaults[k];
	if (c.peek() === '{') {
		const params = c.value();
		for (const k of Object.keys(params)) data[k] = params[k];
	}
	/** @type {any} */
	const node = { id, type };
	let position = null;
	let cls = /** @type {string | null | undefined} */ (undefined);
	while (!c.done()) {
		if (c.eat('@')) {
			const x = c.number();
			c.expect(',');
			position = { x, y: c.number() };
		} else if (c.eat('noclass')) cls = null;
		else if (c.eat('class:')) cls = c.string();
		else c.fail('unexpected');
	}
	if (position) node.position = position;
	node.data = data;
	if (cls !== null) node.class = cls ?? DEFAULT_CLASS;
	return node;
}

/** @param {Cursor} c @param {string} source */
function parseEdgeRest(c, source) {
	/** @type {any} */
	const edge = { id: '', source };
	if (c.eat('.')) edge.sourceHandle = c.word(BARE_ID);
	c.expect('->');
	edge.target = c.word(BARE_ID);
	if (c.eat('.')) edge.targetHandle = c.word(BARE_ID);
	// key order as serializeEdge writes it: id, source, target, sourceHandle, targetHandle
	const ordered = { id: '', source: edge.source, target: edge.target };
	if (edge.sourceHandle) /** @type {any} */ (ordered).sourceHandle = edge.sourceHandle;
	if (edge.targetHandle) /** @type {any} */ (ordered).targetHandle = edge.targetHandle;
	ordered.id = c.eat('#') ? c.word(BARE_ID) : canonicalEdgeId(ordered);
	if (!c.done()) c.fail('unexpected');
	return ordered;
}

/**
 * Parse compact text. Collects every line's error instead of stopping at the first, so the
 * Code view (and a model's tool call) hears about all of them at once.
 * @param {string} text
 * @param {TextOptions} [opts] defaultLabel / defaults fill what the AI view left out (a
 *   missing "label", params at their default); without them a node is exactly its line
 * @returns {{ graphs: Record<string, Graph>, order: string[], errors: GraphTextError[] }}
 *   lines before any `@graph` header land in the section named '' (the "current" graph)
 */
export function parseGraphText(text, opts = {}) {
	/** @type {Record<string, Graph>} */
	const graphs = {};
	/** @type {string[]} */
	const order = [];
	/** @type {GraphTextError[]} */
	const errors = [];
	let current = '';
	const section = (/** @type {string} */ key) => {
		if (!graphs[key]) {
			graphs[key] = { nodes: [], edges: [] };
			order.push(key);
		}
		return graphs[key];
	};
	String(text ?? '')
		.split(/\r?\n/)
		.forEach((raw, i) => {
			const c = new Cursor(raw, i + 1);
			if (c.done() || c.s.slice(c.i).startsWith('//')) return;
			try {
				if (c.eat('@graph')) {
					current = c.word(BARE_ID);
					section(current);
					if (!c.done()) c.fail('unexpected');
					return;
				}
				const g = section(current);
				if (c.eat('~')) {
					g.edges.push(c.json());
					return;
				}
				const id = c.word(BARE_ID);
				if (c.eat(':=')) g.nodes.push(c.json());
				else if (c.eat('=')) g.nodes.push(parseNodeRest(c, id, opts));
				else g.edges.push(parseEdgeRest(c, id));
			} catch (e) {
				if (e instanceof GraphTextError) errors.push(e);
				else throw e;
			}
		});
	return { graphs, order, errors };
}

/**
 * Text holding ONE graph (no `@graph` header, or exactly one) back to `{nodes, edges}`.
 * Throws the first error — callers that want them all use parseGraphText.
 * @param {string} text @param {Parameters<typeof parseGraphText>[1]} [opts]
 * @returns {Graph}
 */
export function textToGraph(text, opts = {}) {
	const { graphs, order, errors } = parseGraphText(text, opts);
	if (errors.length) throw errors[0];
	const keys = order.filter((k) => graphs[k].nodes.length || graphs[k].edges.length || k !== '');
	if (keys.length > 1) throw new GraphTextError('expected one graph, found ' + keys.length + ' @graph sections', 1, 1);
	return graphs[keys[0] ?? ''] ?? { nodes: [], edges: [] };
}

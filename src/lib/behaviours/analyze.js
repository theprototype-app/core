// 34 R3 (D2) — WHAT A BEHAVIOUR'S SOURCE SAYS, read without running it (acorn: 8.18 is already
// in core's lockfile through Svelte — no new dependency in the bundle).
//
// A LEAF apart from acorn and its siblings. Three jobs:
//
//   analyze(source, specs)   the STRUCTURE: params (with the source range of each literal, for the
//                            knob write-back), state fields, handlers (resolved to their events),
//                            methods, and per function what it reads (params, state), writes
//                            (state), calls (methods, `after` timers, kit calls by their spec
//                            node, payload actions such as `refuse`) — plus the LINT
//   setParamLiteral(...)     ONE AST edit: rewrite the literal of one param in the source (the knob)
//   (graph.js turns the structure into the derived node view)
//
// A construct the analysis cannot follow (an event name computed at runtime, a kit call through
// a variable) shows up as nothing — the proposal's "opaque code node" fallback — and the lint
// can say so; the code still runs.
//
// THE LINT (proposal D5, fork F3): a behaviour runs in the page's own realm on the authority
// peer, so what would make peers DISAGREE or reach outside the game is an error that stops the
// load: Math.random / Date.now / performance.now (use this.rand / this.now), storage and the DOM,
// network, eval, bare timers (use this.after), `import`. Loops are allowed (the loop guard bounds
// them); `while (true)` without a break is a warning.

import { parse } from 'acorn';
import { resolveEvent } from './events.js';
import { RESERVED_KEYS, CONTEXT_MEMBERS } from './define.js';

/** globals a behaviour may not touch, with what to use instead */
export const BANNED = {
	'Math.random': 'use this.rand() (seeded, the same on every replay)',
	'Date.now': 'use this.now() (the session clock)',
	'performance.now': 'use this.now() (the session clock)',
	Date: 'use this.now() (the session clock)',
	localStorage: 'behaviour state replicates through this.state; device data is api.storage in a module',
	sessionStorage: 'use this.state',
	indexedDB: 'use this.state',
	document: 'a behaviour has no DOM (use the kit or a module)',
	window: 'a behaviour has no DOM (use the kit or a module)',
	globalThis: 'a behaviour reaches only its own scope',
	fetch: 'a behaviour does not use the network',
	XMLHttpRequest: 'a behaviour does not use the network',
	WebSocket: 'a behaviour does not use the network',
	eval: 'no eval',
	Function: 'no Function constructor',
	setTimeout: 'use this.after(seconds, "method")',
	setInterval: 'use this.after(seconds, "method") again from the method',
	requestAnimationFrame: 'use this.after'
};

/** @typedef {{message: string, line: number, col: number, level: 'error'|'warning'}} Finding */

/** @param {any} node */
const isNode = (node) => node && typeof node === 'object' && typeof node.type === 'string';

/** visit every node depth-first with its parent @param {any} node @param {(n: any, parent: any, key: string) => void | false} fn @param {any} [parent] @param {string} [key] */
function walk(node, fn, parent = null, key = '') {
	if (!isNode(node)) return;
	if (fn(node, parent, key) === false) return;
	for (const k of Object.keys(node)) {
		if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
		const v = node[k];
		if (Array.isArray(v)) {
			for (const c of v) if (isNode(c)) walk(c, fn, node, k);
		} else if (isNode(v)) walk(v, fn, node, k);
	}
}

/** a property's key as a string @param {any} prop */
function keyName(prop) {
	if (!prop || prop.computed) return null;
	if (prop.key?.type === 'Identifier') return prop.key.name;
	if (prop.key?.type === 'Literal') return String(prop.key.value);
	return null;
}

/** the literal value of a node (numbers, signed numbers, booleans, strings), else undefined @param {any} n */
function literalOf(n) {
	if (!n) return undefined;
	if (n.type === 'Literal' && (typeof n.value === 'number' || typeof n.value === 'boolean' || typeof n.value === 'string')) return n.value;
	if (n.type === 'UnaryExpression' && n.operator === '-' && n.argument?.type === 'Literal' && typeof n.argument.value === 'number') return -n.argument.value;
	if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0]?.value?.cooked ?? '';
	return undefined;
}

/** `a.b.c` member chain -> ['a','b','c'] (`this` as 'this'); null when not a plain chain @param {any} n */
function chainOf(n) {
	/** @type {string[]} */
	const out = [];
	let cur = n;
	while (cur?.type === 'MemberExpression') {
		if (cur.computed) {
			if (cur.property?.type === 'Literal' && typeof cur.property.value === 'string') out.unshift(cur.property.value);
			else return null;
		} else out.unshift(cur.property.name);
		cur = cur.object;
	}
	if (cur?.type === 'ThisExpression') out.unshift('this');
	else if (cur?.type === 'Identifier') out.unshift(cur.name);
	else return null;
	return out;
}

/** find the definition object: `export default behaviour({...})` (or a const holding it) @param {any} ast */
function findDefinition(ast) {
	/** @type {Record<string, any>} */
	const consts = {};
	for (const st of ast.body) {
		if (st.type === 'VariableDeclaration')
			for (const d of st.declarations) if (d.id?.type === 'Identifier' && d.init) consts[d.id.name] = d.init;
	}
	const unwrap = (/** @type {any} */ n) => {
		if (n?.type === 'Identifier' && consts[n.name]) n = consts[n.name];
		if (n?.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'behaviour' && n.arguments[0]?.type === 'ObjectExpression') return n.arguments[0];
		return null;
	};
	for (const st of ast.body) if (st.type === 'ExportDefaultDeclaration') return unwrap(st.declaration);
	return null;
}

/** a function node of a property (method shorthand, function, arrow) @param {any} prop */
function fnOf(prop) {
	const v = prop?.value;
	if (v && (v.type === 'FunctionExpression' || v.type === 'ArrowFunctionExpression')) return v;
	return null;
}

/**
 * What one function body reads, writes and calls.
 * @param {any} fn the function node @param {any[]} specs @param {string[]} methodNames
 */
function scanFunction(fn, specs, methodNames) {
	const reads = { params: /** @type {Set<string>} */ (new Set()), state: /** @type {Set<string>} */ (new Set()) };
	/** @type {Set<string>} */ const writes = new Set();
	/** @type {Set<string>} */ const calls = new Set();
	/** @type {{method: string | null, params: string[], line: number}[]} */ const timers = [];
	/** @type {Map<string, {piece: string, call: string, type: string | null, label: string, kind: string, line: number}>} */ const kit = new Map();
	/** @type {Set<string>} */ const actions = new Set();
	/** @type {Set<string>} */ const payload = new Set();
	let random = false;
	// the payload: the first parameter's destructured names
	const first = fn.params?.[0];
	/** @type {Set<string>} */
	const payloadNames = new Set();
	if (first?.type === 'ObjectPattern')
		for (const p of first.properties) {
			const k = keyName(p);
			if (k) {
				payload.add(k);
				payloadNames.add(p.value?.type === 'Identifier' ? p.value.name : k);
			}
		}
	// `const {reach, speed} = this.params` / `const p = this.params`
	/** @type {Set<string>} */
	const paramAliases = new Set();
	walk(fn.body, (n) => {
		if (n.type === 'VariableDeclarator' && n.init) {
			const c = chainOf(n.init);
			if (c && c[0] === 'this' && c[1] === 'params' && c.length === 2) {
				if (n.id.type === 'ObjectPattern') for (const p of n.id.properties) keyName(p) && reads.params.add(/** @type {string} */ (keyName(p)));
				else if (n.id.type === 'Identifier') paramAliases.add(n.id.name);
			}
			if (c && c[0] === 'this' && c[1] === 'state' && c.length === 2 && n.id.type === 'ObjectPattern')
				for (const p of n.id.properties) keyName(p) && reads.state.add(/** @type {string} */ (keyName(p)));
		}
	});
	const kitCall = (/** @type {string[]} */ c, /** @type {any} */ node) => {
		// this.kit.<piece>.<call>(…) or kit.<piece>.<call>(…)
		const at = c[0] === 'this' ? 2 : 1;
		const piece = c[at];
		const call = c[at + 1];
		if (!piece || !call) return;
		const spec = specs.find((s) => s.piece === piece);
		const sc = spec?.calls.find((/** @type {any} */ x) => x.name === call || 'on' + x.name.charAt(0).toUpperCase() + x.name.slice(1) === call);
		const key = piece + '.' + call;
		if (!kit.has(key))
			kit.set(key, {
				piece,
				call,
				type: sc ? 'kit-' + piece + '-' + sc.name : null,
				label: sc ? sc.label : 'kit.' + key,
				kind: sc ? sc.kind : 'code',
				line: node.loc?.start.line ?? 0
			});
	};
	walk(fn.body, (n, parent, key) => {
		if (n.type === 'MemberExpression') {
			const c = chainOf(n);
			if (!c) return;
			if (c[0] === 'this' && c[1] === 'params' && c[2]) reads.params.add(c[2]);
			if (paramAliases.has(c[0]) && c[1]) reads.params.add(c[1]);
			if (c[0] === 'this' && c[1] === 'state' && c[2] && c.length === 3) {
				const target =
					(parent?.type === 'AssignmentExpression' && key === 'left') ||
					(parent?.type === 'UpdateExpression' && key === 'argument') ||
					(parent?.type === 'UnaryExpression' && parent.operator === 'delete');
				if (target) {
					writes.add(c[2]);
					// `a += 1` / `a++` read too
					if (parent.type === 'UpdateExpression' || (parent.type === 'AssignmentExpression' && parent.operator !== '=')) reads.state.add(c[2]);
				} else reads.state.add(c[2]);
			}
			// `this.state.list.push(x)`: a mutation through the field
			if (c[0] === 'this' && c[1] === 'state' && c[2] && c.length >= 4 && parent?.type === 'CallExpression' && key === 'callee') writes.add(c[2]);
			return;
		}
		if (n.type === 'CallExpression') {
			const c = chainOf(n.callee);
			if (!c) {
				if (n.callee?.type === 'Identifier' && payloadNames.has(n.callee.name)) actions.add(n.callee.name);
				return;
			}
			if (c.length === 1 && payloadNames.has(c[0])) actions.add(c[0]);
			if (c[0] === 'this' && c.length === 2) {
				if (c[1] === 'after') {
					const target = n.arguments[1];
					const delay = n.arguments[0];
					/** @type {string[]} */
					const ps = [];
					walk(delay, (d) => {
						const dc = d.type === 'MemberExpression' ? chainOf(d) : null;
						if (dc && dc[0] === 'this' && dc[1] === 'params' && dc[2]) ps.push(dc[2]);
						if (dc && paramAliases.has(dc[0]) && dc[1]) ps.push(dc[1]);
					});
					let method = null;
					if (target?.type === 'Literal' && typeof target.value === 'string') method = target.value;
					else if (target?.type === 'ArrowFunctionExpression' || target?.type === 'FunctionExpression') {
						walk(target.body, (d) => {
							if (d.type === 'CallExpression') {
								const dc = chainOf(d.callee);
								if (dc && dc[0] === 'this' && dc.length === 2 && methodNames.includes(dc[1])) method ??= dc[1];
							}
						});
					}
					timers.push({ method, params: ps, line: n.loc?.start.line ?? 0 });
					if (method) calls.add(method);
				} else if (c[1] === 'rand' || c[1] === 'randInt' || c[1] === 'pick') random = true;
				else if (methodNames.includes(c[1])) calls.add(c[1]);
			}
			if ((c[0] === 'this' && c[1] === 'kit' && c.length >= 4) || (c[0] === 'kit' && c.length >= 3)) kitCall(c, n);
		}
	});
	return {
		reads: { params: [...reads.params], state: [...reads.state] },
		writes: [...writes],
		calls: [...calls],
		timers,
		kit: [...kit.values()],
		actions: [...actions],
		payload: [...payload],
		random
	};
}

/** @param {any} ast @param {Finding[]} out */
function lint(ast, out) {
	/** names declared anywhere (a local `document` is not the DOM) @type {Set<string>} */
	const declared = new Set();
	walk(ast, (n) => {
		if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier') declared.add(n.id.name);
		if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression') && n.id) declared.add(n.id.name);
		for (const p of n.params ?? []) if (p.type === 'Identifier') declared.add(p.name);
	});
	const at = (/** @type {any} */ n, /** @type {string} */ message, /** @type {'error'|'warning'} */ level = 'error') =>
		out.push({ message, line: n.loc?.start.line ?? 0, col: (n.loc?.start.column ?? 0) + 1, level });
	walk(ast, (n, parent, key) => {
		if (n.type === 'ImportDeclaration' || n.type === 'ImportExpression') at(n, 'a behaviour is one self-contained file: no import');
		if (n.type === 'MemberExpression') {
			const c = chainOf(n);
			if (c && c.length === 2) {
				const name = c.join('.');
				const why = /** @type {Record<string, string>} */ (BANNED)[name];
				if (why && !declared.has(c[0])) at(n, name + ' — ' + why);
			}
		}
		if (n.type === 'Identifier') {
			// a bare global reference (not a property name, not a declaration, not an object key)
			const isProp = parent?.type === 'MemberExpression' && key === 'property' && !parent.computed;
			const isKey = (parent?.type === 'Property' || parent?.type === 'MethodDefinition') && key === 'key' && !parent.computed;
			const isMemberObject = parent?.type === 'MemberExpression' && key === 'object';
			if (isProp || isKey || declared.has(n.name)) return;
			const why = /** @type {Record<string, string>} */ (BANNED)[n.name];
			if (!why) return;
			// Math / performance as objects are flagged on their member (Math.random), not here
			if (isMemberObject && (n.name === 'Date' || n.name === 'performance')) return;
			at(n, n.name + ' — ' + why);
		}
		if (n.type === 'WhileStatement' && literalOf(n.test) === true) {
			let breaks = false;
			walk(n.body, (b) => {
				if (b.type === 'BreakStatement' || b.type === 'ReturnStatement' || b.type === 'ThrowStatement') breaks = true;
			});
			if (!breaks) at(n, 'while (true) with no break never ends (the loop guard will stop it)', 'warning');
		}
	});
}

/**
 * Read a behaviour's source.
 * @param {string} source @param {any[]} [specs] the kit specs (kit.specs()), to name kit calls
 * @returns {any} the structure (see the file header); `errors` non-empty = it cannot load
 */
export function analyze(source, specs = []) {
	/** @type {Finding[]} */
	const errors = [];
	/** @type {Finding[]} */
	const lintOut = [];
	/** @type {any} */
	let ast;
	try {
		ast = parse(String(source ?? ''), { ecmaVersion: 'latest', sourceType: 'module', locations: true });
	} catch (error) {
		const e = /** @type {any} */ (error);
		return {
			ok: false,
			errors: [{ message: String(e.message ?? e), line: e.loc?.line ?? 0, col: (e.loc?.column ?? 0) + 1, level: 'error' }],
			lint: [],
			params: [],
			state: [],
			handlers: [],
			methods: []
		};
	}
	lint(ast, lintOut);
	const def = findDefinition(ast);
	if (!def) errors.push({ message: 'no `export default behaviour({...})` found', line: 1, col: 1, level: 'error' });
	/** @type {any[]} */ const params = [];
	/** @type {any[]} */ const state = [];
	/** @type {any[]} */ const handlers = [];
	/** @type {any[]} */ const methods = [];
	/** @type {string} */
	let name = '';
	if (def) {
		/** @type {string[]} */
		const methodNames = [];
		for (const prop of def.properties) {
			const k = keyName(prop);
			if (k && !RESERVED_KEYS.includes(k) && fnOf(prop)) methodNames.push(k);
		}
		for (const prop of def.properties) {
			const k = keyName(prop);
			if (!k) continue;
			const line = prop.loc?.start.line ?? 0;
			if (k === 'name') name = String(literalOf(prop.value) ?? '');
			else if (k === 'params' && prop.value?.type === 'ObjectExpression') {
				for (const p of prop.value.properties) {
					const pk = keyName(p);
					if (!pk) continue;
					/** @type {any} */
					let valueNode = p.value;
					/** @type {Record<string, any>} */
					const meta = {};
					if (p.value?.type === 'ObjectExpression') {
						valueNode = null;
						for (const q of p.value.properties) {
							const qk = keyName(q);
							if (qk === 'value') valueNode = q.value;
							else if (qk) meta[qk] = literalOf(q.value);
						}
					}
					const value = literalOf(valueNode);
					params.push({
						key: pk,
						value,
						type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : typeof value === 'string' ? 'string' : 'opaque',
						range: valueNode && value !== undefined ? [valueNode.start, valueNode.end] : null,
						...meta,
						line: p.loc?.start.line ?? line
					});
				}
			} else if (k === 'state' && prop.value?.type === 'ObjectExpression') {
				for (const p of prop.value.properties) {
					const sk = keyName(p);
					if (sk) state.push({ key: sk, init: literalOf(p.value) ?? String(source).slice(p.value.start, p.value.end), line: p.loc?.start.line ?? line });
				}
			} else if (k === 'on' && prop.value?.type === 'ObjectExpression') {
				for (const p of prop.value.properties) {
					const hk = keyName(p);
					const fn = fnOf(p);
					if (!hk || !fn) continue;
					const event = resolveEvent(hk, specs);
					if (!event) lintOut.push({ message: 'on.' + hk + ': no such event (it will never fire)', line: p.loc?.start.line ?? 0, col: (p.loc?.start.column ?? 0) + 1, level: 'warning' });
					handlers.push({ name: hk, event, line: p.loc?.start.line ?? 0, ...scanFunction(fn, specs, methodNames) });
				}
			} else if (fnOf(prop)) {
				if (CONTEXT_MEMBERS.includes(k)) errors.push({ message: 'method "' + k + '" hides this.' + k, line, col: 1, level: 'error' });
				methods.push({ name: k, line, ...scanFunction(fnOf(prop), specs, methodNames) });
			}
		}
	}
	for (const f of lintOut) if (f.level === 'error') errors.push(f);
	return {
		ok: errors.length === 0,
		name,
		errors,
		lint: lintOut,
		params,
		state,
		handlers,
		methods
	};
}

/** format a number for the source: at most the step's decimals, no trailing zeros @param {number} v @param {number} [step] */
export function formatNumber(v, step) {
	const decimals = step && step < 1 ? Math.min(6, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9))) : 0;
	const fixed = Number(v).toFixed(Math.max(decimals, Number.isInteger(v) ? 0 : decimals || 3));
	return String(Number(fixed));
}

/**
 * THE KNOB'S WRITE-BACK: one AST edit — the literal of `params.<key>` (its `value:` when it is an
 * object) replaced by `value`; everything else in the file (comments, formatting) untouched.
 * @param {string} source @param {string} key @param {any} value
 * @returns {{source: string, changed: boolean, error?: string}}
 */
export function setParamLiteral(source, key, value) {
	const model = analyze(source);
	const p = model.params.find((/** @type {any} */ x) => x.key === key);
	if (!p) return { source, changed: false, error: 'no param "' + key + '"' };
	if (!p.range) return { source, changed: false, error: 'param "' + key + '" is not a literal' };
	/** @type {string} */
	let text;
	if (p.type === 'number') {
		const n = Number(value);
		if (!Number.isFinite(n)) return { source, changed: false, error: 'not a number' };
		text = formatNumber(n, p.step);
	} else if (p.type === 'boolean') text = value ? 'true' : 'false';
	else if (p.type === 'string') {
		// keep the file's quote style
		const q = source[p.range[0]] === '"' ? '"' : "'";
		text = q + String(value).replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), '\\' + q).replace(/\n/g, '\\n') + q;
	} else return { source, changed: false, error: 'param "' + key + '" cannot be edited here' };
	const next = source.slice(0, p.range[0]) + text + source.slice(p.range[1]);
	return { source: next, changed: next !== source };
}

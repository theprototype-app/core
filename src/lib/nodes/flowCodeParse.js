// 2.0 N2 — the code view read BACK into a graph: the other half of flowCode.js, kept apart so the app
// bundle that only SHOWS code never loads a JS parser. Used by the round-trip proof and by N3 (an
// agent's `flow` statements). It reads only the declaration shape the generator writes — no code is
// ever executed: params and wires are LITERALS and references, anything else is an error.
import * as acorn from 'acorn';
import { UNNAMED_IN } from './flowCode.js';
import { canonicalEdgeId } from '../graphText.js';

/** @typedef {import('./flowCode.js').CodeOptions} CodeOptions */

/** a literal AST node -> its value; anything that is not a literal is refused @param {any} n @returns {any} */
function literal(n) {
	switch (n.type) {
		case 'Literal':
			if (n.regex || typeof n.value === 'bigint') throw new Error('not a JSON value');
			return n.value;
		case 'UnaryExpression':
			if (n.operator === '-' && n.argument.type === 'Literal' && typeof n.argument.value === 'number') return -n.argument.value;
			throw new Error('not a literal: ' + n.operator);
		case 'ArrayExpression':
			return n.elements.map((/** @type {any} */ e) => literal(e));
		case 'ObjectExpression': {
			/** @type {Record<string, any>} */
			const o = {};
			for (const p of n.properties) {
				if (p.type !== 'Property' || p.computed || p.kind !== 'init') throw new Error('not a plain property');
				o[p.key.type === 'Identifier' ? p.key.name : String(p.key.value)] = literal(p.value);
			}
			return o;
		}
		case 'Identifier':
			if (n.name === 'undefined') return undefined;
			throw new Error('a reference where a value belongs: ' + n.name);
		default:
			throw new Error('not a literal: ' + n.type);
	}
}

/**
 * Code -> graph. Ids come from the `// #<id>` comments; a statement with none gets `mint()`.
 * Data = `{label?, type, ...defaults, ...params}` (graphText's AI-view fill), edges get graphText's
 * canonical ids.
 * @param {string} code @param {CodeOptions & { mint?: () => string }} [opts]
 * @returns {{ nodes: { id: string, type: string, data: Record<string, any> }[], edges: { id: string, source: string, target: string, sourceHandle?: string, targetHandle?: string }[] }}
 */
export function codeToGraph(code, opts = {}) {
	/** @type {any[]} */
	const comments = [];
	const ast = /** @type {any} */ (
		acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true, onComment: comments })
	);
	const idOnLine = new Map();
	for (const c of comments) {
		const m = /^\s*#(\S+)\s*$/.exec(c.value);
		if (m && !c.block) idOnLine.set(c.loc.start.line, m[1]);
	}
	const exp = ast.body.find((/** @type {any} */ s) => s.type === 'ExportDefaultDeclaration');
	const call = exp?.declaration;
	if (!call || call.type !== 'CallExpression' || call.callee.name !== 'flow') throw new Error('expected export default flow(...)');
	const fn = call.arguments[0];
	if (!fn || fn.type !== 'ArrowFunctionExpression' || fn.body.type !== 'BlockStatement') throw new Error('expected flow(({ … }) => { … })');
	let minted = 0;
	const mint = opts.mint ?? (() => 'n' + ++minted);
	/** @type {Map<string, string>} binding -> node id */
	const ids = new Map();
	/** @type {{ id: string, type: string, args: any[] }[]} */
	const statements = [];
	for (const st of fn.body.body) {
		let name = null;
		let expr;
		if (st.type === 'VariableDeclaration' && st.declarations.length === 1 && st.declarations[0].id.type === 'Identifier') {
			name = st.declarations[0].id.name;
			expr = st.declarations[0].init;
		} else if (st.type === 'ExpressionStatement') expr = st.expression;
		if (!expr || expr.type !== 'CallExpression') throw new Error('line ' + st.loc.start.line + ': expected a node call');
		let type;
		if (expr.callee.type === 'Identifier') type = expr.callee.name;
		else if (expr.callee.type === 'CallExpression' && expr.callee.callee.name === 'use' && expr.callee.arguments[0]?.type === 'Literal')
			type = String(expr.callee.arguments[0].value);
		else throw new Error('line ' + st.loc.start.line + ': expected a node type');
		const id = idOnLine.get(st.loc.end.line) ?? mint();
		if (name) ids.set(name, id);
		statements.push({ id, type, args: expr.arguments });
	}
	const nodes = [];
	const edges = [];
	for (const s of statements) {
		/** @type {Record<string, any>} */
		const data = {};
		const label = opts.defaultLabel?.(s.type);
		if (label) data.label = label;
		data.type = s.type;
		Object.assign(data, structuredClone(opts.defaults?.(s.type) ?? {}));
		const [params, wires] = s.args;
		if (params) Object.assign(data, literal(params));
		nodes.push({ id: s.id, type: s.type, data });
		if (!wires) continue;
		if (wires.type !== 'ObjectExpression') throw new Error('wires must be an object');
		for (const p of wires.properties) {
			const handle = p.key.type === 'Identifier' ? p.key.name : String(p.key.value);
			const refs = p.value.type === 'ArrayExpression' ? p.value.elements : [p.value];
			for (const r of refs) {
				let src;
				let sh;
				if (r.type === 'Identifier') src = r.name;
				else if (r.type === 'MemberExpression' && r.object.type === 'Identifier') {
					src = r.object.name;
					sh = r.computed ? String(r.property.value) : r.property.name;
				} else throw new Error('a wire must name a node');
				const source = ids.get(src);
				if (!source) throw new Error('unknown node ' + src);
				/** @type {any} */
				const e = { source, target: s.id };
				if (sh) e.sourceHandle = sh;
				if (handle !== UNNAMED_IN) e.targetHandle = handle;
				e.id = canonicalEdgeId(e);
				edges.push(e);
			}
		}
	}
	return { nodes, edges };
}

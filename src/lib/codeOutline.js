// 36-fb-code (F7): THE OUTLINE of a source — what the right sidebar lists and jumps to. A LEAF
// (acorn only, already the workspace's parser), so it is testable with no store and no DOM.
//
// What a person scanning a game's code wants to find, by kind:
//   behaviour  `export default behaviour({params, state, on: {…}, …methods})` — its params,
//              its state keys, its handlers (`on.*`) and its methods
//   script     a Script node body — the `inputs.x` it reads, the keys its `return {…}` hands
//              out, and any functions it declares
//   module     ordinary JS — functions, classes and their methods, top-level constants
//   json       a graph tab — its nodes (type and label) by the line they start on
// Code that does not parse still gets an outline (a line scan for function shapes), marked
// `partial`, so the sidebar stays useful while the user is mid-edit.

import { parse } from 'acorn';

/**
 * @typedef {'function' | 'method' | 'handler' | 'param' | 'state' | 'input' | 'output' | 'class' |
 *   'const' | 'node'} OutlineKind
 * @typedef {{ name: string, kind: OutlineKind, line: number, depth: number, detail?: string }} OutlineItem
 * @typedef {{ items: OutlineItem[], partial: boolean }} Outline
 */

/** @param {any} key a Property key @returns {string} */
function keyName(key) {
	if (!key) return '';
	if (key.type === 'Identifier') return key.name;
	if (key.type === 'Literal') return String(key.value);
	return '';
}

/** @param {any} node */
const isFn = (node) => !!node && (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression');

/** a short parameter list, `(a, b)` @param {any} fn */
function paramsOf(fn) {
	const names = (fn?.params ?? []).map((/** @type {any} */ p) =>
		p.type === 'Identifier' ? p.name : p.type === 'AssignmentPattern' && p.left?.type === 'Identifier' ? p.left.name : p.type === 'RestElement' ? '…' + (p.argument?.name ?? '') : '{…}'
	);
	return '(' + names.join(', ') + ')';
}

/** visit every node of an ESTree (acorn) tree @param {any} node @param {(n: any, parent: any) => void} fn @param {any} [parent] */
function walk(node, fn, parent = null) {
	if (!node || typeof node.type !== 'string') return;
	fn(node, parent);
	for (const key in node) {
		if (key === 'loc' || key === 'start' || key === 'end') continue;
		const child = node[key];
		if (Array.isArray(child)) for (const c of child) walk(c, fn, node);
		else if (child && typeof child.type === 'string') walk(child, fn, node);
	}
}

/** @param {string} code @param {'script' | 'module'} sourceType */
function tryParse(code, sourceType) {
	try {
		return parse(code, { ecmaVersion: 'latest', sourceType, allowReturnOutsideFunction: sourceType === 'script', locations: true });
	} catch {
		return null;
	}
}

/** the object literal handed to `behaviour({…})`, if any @param {any} ast */
function behaviourObject(ast) {
	/** @type {any} */
	let found = null;
	walk(ast, (n) => {
		if (found || n.type !== 'CallExpression') return;
		if (n.callee?.type === 'Identifier' && n.callee.name === 'behaviour' && n.arguments?.[0]?.type === 'ObjectExpression') found = n.arguments[0];
	});
	return found;
}

/** @param {any} obj ObjectExpression @param {OutlineItem[]} out */
function behaviourItems(obj, out) {
	for (const prop of obj.properties ?? []) {
		if (prop.type !== 'Property') continue;
		const name = keyName(prop.key);
		const line = prop.loc.start.line;
		if ((name === 'params' || name === 'state') && prop.value?.type === 'ObjectExpression') {
			out.push({ name, kind: 'const', line, depth: 0 });
			for (const p of prop.value.properties ?? []) {
				if (p.type !== 'Property') continue;
				const v = p.value?.type === 'ObjectExpression' ? p.value.properties.find((/** @type {any} */ q) => keyName(q.key) === 'value')?.value : p.value;
				const detail = v?.type === 'Literal' ? String(v.raw ?? v.value) : undefined;
				out.push({ name: keyName(p.key), kind: name === 'params' ? 'param' : 'state', line: p.loc.start.line, depth: 1, ...(detail ? { detail } : {}) });
			}
		} else if (name === 'on' && prop.value?.type === 'ObjectExpression') {
			out.push({ name: 'on', kind: 'const', line, depth: 0 });
			for (const h of prop.value.properties ?? []) {
				if (h.type !== 'Property') continue;
				const fn = isFn(h.value) ? h.value : null;
				out.push({ name: keyName(h.key), kind: 'handler', line: h.loc.start.line, depth: 1, ...(fn ? { detail: paramsOf(fn) } : {}) });
			}
		} else if (isFn(prop.value) || prop.method) {
			out.push({ name, kind: 'method', line, depth: 0, detail: paramsOf(prop.value) });
		}
	}
}

/** functions, classes and constants at any depth (top-level consts only) @param {any} ast @param {OutlineItem[]} out */
function codeItems(ast, out) {
	walk(ast, (n, parent) => {
		if (n.type === 'FunctionDeclaration' && n.id) out.push({ name: n.id.name, kind: 'function', line: n.loc.start.line, depth: 0, detail: paramsOf(n) });
		else if (n.type === 'ClassDeclaration' && n.id) {
			out.push({ name: n.id.name, kind: 'class', line: n.loc.start.line, depth: 0 });
			for (const m of n.body?.body ?? [])
				if (m.type === 'MethodDefinition') out.push({ name: keyName(m.key), kind: 'method', line: m.loc.start.line, depth: 1, detail: paramsOf(m.value) });
		} else if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier') {
			if (isFn(n.init)) out.push({ name: n.id.name, kind: 'function', line: n.loc.start.line, depth: 0, detail: paramsOf(n.init) });
			else if (parent?.kind === 'const' && isTopLevel(ast, parent)) out.push({ name: n.id.name, kind: 'const', line: n.loc.start.line, depth: 0 });
		}
	});
}

/** @param {any} ast @param {any} decl a VariableDeclaration */
function isTopLevel(ast, decl) {
	return (ast.body ?? []).some((/** @type {any} */ s) => s === decl || (s.type === 'ExportNamedDeclaration' && s.declaration === decl));
}

/** a Script node body: inputs it reads, outputs it returns, functions @param {any} ast @param {OutlineItem[]} out */
function scriptItems(ast, out) {
	/** @type {Map<string, number>} */
	const inputs = new Map();
	walk(ast, (n) => {
		if (n.type === 'MemberExpression' && n.object?.type === 'Identifier' && n.object.name === 'inputs' && !n.computed && n.property?.type === 'Identifier')
			if (!inputs.has(n.property.name)) inputs.set(n.property.name, n.loc.start.line);
	});
	for (const [name, line] of inputs) out.push({ name, kind: 'input', line, depth: 0 });
	// the keys of a TOP-LEVEL return (a nested function's return is its own business)
	const seen = new Set();
	for (const stmt of ast.body ?? [])
		walk(stmt, (n) => {
			if (n.type === 'ReturnStatement' && n.argument?.type === 'ObjectExpression')
				for (const p of n.argument.properties)
					if (p.type === 'Property' && !seen.has(keyName(p.key))) {
						seen.add(keyName(p.key));
						out.push({ name: keyName(p.key), kind: 'output', line: p.loc.start.line, depth: 0 });
					}
		});
	codeItems(ast, out);
}

/** the line scan for code that does not parse @param {string} code @returns {OutlineItem[]} */
function scanItems(code) {
	/** @type {OutlineItem[]} */
	const out = [];
	const lines = String(code).split('\n');
	lines.forEach((text, i) => {
		let m = /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(\([^)]*\))?/.exec(text);
		if (m) return void out.push({ name: m[1], kind: 'function', line: i + 1, depth: 0, ...(m[2] ? { detail: m[2] } : {}) });
		m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.exec(text);
		if (m) return void out.push({ name: m[1], kind: 'function', line: i + 1, depth: 0 });
		m = /^\s+(?:async\s+)?([A-Za-z_$][\w$]*)\s*(\([^)]*\))\s*\{\s*$/.exec(text);
		if (m && !/^(if|for|while|switch|catch|function|return)$/.test(m[1])) out.push({ name: m[1], kind: 'method', line: i + 1, depth: 0, detail: m[2] });
	});
	return out;
}

/** the nodes of a graph JSON, by the line their id appears on @param {string} code @returns {Outline} */
function graphOutline(code) {
	/** @type {any} */
	let doc = null;
	try {
		doc = JSON.parse(code);
	} catch {
		return { items: [], partial: true };
	}
	/** @type {OutlineItem[]} */
	const items = [];
	for (const n of Array.isArray(doc?.nodes) ? doc.nodes : []) {
		if (!n || typeof n.id !== 'string') continue;
		const at = code.indexOf('"id": ' + JSON.stringify(n.id));
		const line = at < 0 ? 1 : code.slice(0, at).split('\n').length;
		const label = n.data?.label || n.data?.name || '';
		items.push({ name: label || n.id, kind: 'node', line, depth: 0, detail: String(n.type ?? '') });
	}
	return { items, partial: false };
}

/**
 * The outline of a source. `lang` 'json' = a graph tab; otherwise the code is read as a
 * behaviour module when it calls `behaviour({…})`, as a Script node body when `kind` says so,
 * and as plain JS otherwise. Items come out in source order.
 * @param {string} code @param {{lang?: string, kind?: string}} [hint] the tab (lang, kind)
 * @returns {Outline}
 */
export function outlineOf(code, hint = {}) {
	const src = String(code ?? '');
	if (hint.lang === 'json') return graphOutline(src);
	/** @type {OutlineItem[]} */
	const items = [];
	const asScript = hint.kind === 'node';
	const ast = asScript ? tryParse(src, 'script') : (tryParse(src, 'module') ?? tryParse(src, 'script'));
	if (!ast) return { items: scanItems(src), partial: true };
	const bhv = behaviourObject(ast);
	if (bhv) behaviourItems(bhv, items);
	else if (asScript) scriptItems(ast, items);
	else codeItems(ast, items);
	// source order, and one entry per (name, kind, line) — a walker can meet a node twice
	const seen = new Set();
	const unique = items.filter((i) => {
		const k = i.kind + '|' + i.name + '|' + i.line;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
	unique.sort((a, b) => a.line - b.line || a.depth - b.depth);
	return { items: unique, partial: false };
}

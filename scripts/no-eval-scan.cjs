#!/usr/bin/env node
// ktx2-noeval — does a vendored script evaluate strings as code?
//
// A build's CSP has no 'unsafe-eval' (csp.config.js), so a vendored wasm wrapper that builds
// functions from strings dies with an EvalError the moment it starts. Basis's embind glue did
// exactly that, and indirectly: `newFunc(Function, args)` hands the Function CONSTRUCTOR to a
// helper, so grepping for `new Function` finds nothing. This parses the file instead and reports
// every place the identifiers `eval` or `Function` are USED as values, which covers
// `new Function(...)`, `Function(...)`, `f(Function, ...)` and `return Function`. Left alone:
// `x instanceof Function` (a type test), `obj.Function` / `{ Function: … }` (names, not the
// global) and text inside strings or comments.
//
//   node scripts/no-eval-scan.cjs <file.js> [...]   → exit 1 and one line per hit
//
// Used by scripts/build-basis-transcoder.sh and tests/unit/basisNoEval.test.js.
const fs = require('fs');
const acorn = require('acorn');

/** @typedef {{ name: string, line: number, column: number }} EvalHit */

/**
 * @param {string} code
 * @returns {EvalHit[]}
 */
function scanNoEval(code) {
	/** @param {'script' | 'module'} sourceType */
	const parse = (sourceType) =>
		acorn.parse(code, { ecmaVersion: 'latest', sourceType, locations: true, allowHashBang: true });
	let ast;
	try {
		ast = parse('script');
	} catch {
		ast = parse('module'); // an ES module (import/export) — the classic-script parse refuses it
	}
	/** @type {EvalHit[]} */
	const hits = [];
	/** @param {any} node @param {any} parent @param {string} key */
	const visit = (node, parent, key) => {
		if (!node || typeof node.type !== 'string') return;
		if (node.type === 'Identifier' && (node.name === 'eval' || node.name === 'Function')) {
			const isName =
				(parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) ||
				((parent?.type === 'Property' ||
					parent?.type === 'MethodDefinition' ||
					parent?.type === 'PropertyDefinition') &&
					key === 'key' &&
					!parent.computed);
			const typeTest =
				parent?.type === 'BinaryExpression' && parent.operator === 'instanceof' && key === 'right';
			if (!isName && !typeTest)
				hits.push({ name: node.name, line: node.loc.start.line, column: node.loc.start.column });
		}
		for (const k of Object.keys(node)) {
			if (k === 'loc' || k === 'start' || k === 'end') continue;
			const v = node[k];
			if (Array.isArray(v)) for (const c of v) visit(c, node, k);
			else if (v && typeof v === 'object') visit(v, node, k);
		}
	};
	visit(ast, null, '');
	return hits;
}

module.exports = { scanNoEval };

if (require.main === module) {
	let bad = 0;
	for (const file of process.argv.slice(2)) {
		const code = fs.readFileSync(file, 'utf8');
		for (const hit of scanNoEval(code)) {
			bad++;
			const at = code
				.split('\n')
				[hit.line - 1].slice(Math.max(0, hit.column - 40), hit.column + 40);
			console.log(`${file}:${hit.line}:${hit.column + 1} ${hit.name} … ${at} …`);
		}
	}
	process.exit(bad ? 1 : 0);
}

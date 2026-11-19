// 2.0 N1 — THE CORE PALETTE AS SOURCE TEXT, for the node scripts that read the catalog without
// importing it (nodeCatalog pulls in stores and the module SDK). The core entries moved from
// nodeCatalog.js into the node definitions (src/lib/nodes/families/<group>.js, palette order =
// NODE_FAMILIES in src/lib/nodes/index.js), where each entry also carries its runtime halves
// (sockets, card, eval). This rebuilds the OLD literal's shape from them — one group block per
// family, each item the definition's SPEC keys only, sliced verbatim — so node-catalog-scan,
// graph-audit and scene-lint keep reading what they always read:
//
//   \t{\n\t\tgroup: 'Logic',\n\t\titems: [\n\t\t\t{ type: 'math', label: 'Math', … },\n … \t\t]\n\t},
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

/** the halves of a definition that are not its palette spec (registry.js HALVES) */
const HALVES = new Set(['sockets', 'card', 'eval', 'tick', 'trigger', 'wire', 'referenceJs']);

/** @param {string} root @returns {string[]} family file paths in palette order */
function familyFiles(root) {
	const dir = path.join(root, 'src', 'lib', 'nodes');
	const index = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
	/** @type {Record<string, string>} */
	const fileOf = {};
	for (const m of index.matchAll(/^import (\w+) from '\.\/families\/([\w.-]+)';/gm)) fileOf[m[1]] = m[2];
	const list = /NODE_FAMILIES = \[([^\]]*)\]/.exec(index);
	if (!list) throw new Error('node-catalog-source: NODE_FAMILIES not found in src/lib/nodes/index.js');
	return list[1]
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((name) => {
			if (!fileOf[name]) throw new Error('node-catalog-source: no import for family ' + name);
			return path.join(dir, 'families', fileOf[name]);
		});
}

/**
 * The core catalog as the old nodeCatalog literal's text.
 * @param {string} [root] the core checkout (default: this script's parent)
 * @returns {string}
 */
function catalogSource(root = path.join(__dirname, '..')) {
	let out = 'export const nodeCatalog = [\n';
	for (const file of familyFiles(root)) {
		const src = fs.readFileSync(file, 'utf8');
		const ast = /** @type {any} */ (acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' }));
		const exp = ast.body.find((/** @type {any} */ n) => n.type === 'ExportDefaultDeclaration');
		const obj = exp?.declaration;
		if (!obj || obj.type !== 'ObjectExpression') throw new Error('node-catalog-source: ' + file + ' has no default object');
		const prop = (/** @type {any} */ o, /** @type {string} */ k) => o.properties.find((/** @type {any} */ p) => p.key?.name === k);
		const group = prop(obj, 'group').value.value;
		out += `\t{\n\t\tgroup: '${group}',\n\t\titems: [\n`;
		const items = prop(obj, 'nodes').value.elements;
		out += items
			.filter((/** @type {any} */ it) => it.type === 'ObjectExpression')
			.map(
				(/** @type {any} */ it) =>
					'\t\t\t{ ' +
					it.properties
						.filter((/** @type {any} */ p) => p.type === 'Property' && !HALVES.has(p.key?.name))
						.map((/** @type {any} */ p) => src.slice(p.start, p.end))
						.join(', ') +
					' }'
			)
			.join(',\n');
		out += '\n\t\t]\n\t},\n';
	}
	return out + '];\n';
}

/**
 * The runtime halves per core type, read from the same definitions: the card key, the `out` type,
 * the typed input handles and whether the type has an evaluator (an `eval` that is not null).
 * @param {string} [root]
 * @returns {{ cards: Record<string, string>, out: Record<string, string>, ins: Record<string, string[]>, evaluated: Set<string> }}
 */
function definitionTables(root = path.join(__dirname, '..')) {
	/** @type {Record<string, string>} */ const cards = {};
	/** @type {Record<string, string>} */ const out = {};
	/** @type {Record<string, string[]>} */ const ins = {};
	const evaluated = new Set();
	for (const file of familyFiles(root)) {
		const src = fs.readFileSync(file, 'utf8');
		const ast = /** @type {any} */ (acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' }));
		const obj = ast.body.find((/** @type {any} */ n) => n.type === 'ExportDefaultDeclaration').declaration;
		const prop = (/** @type {any} */ o, /** @type {string} */ k) => o.properties.find((/** @type {any} */ p) => p.key?.name === k);
		for (const it of prop(obj, 'nodes').value.elements) {
			const type = prop(it, 'type')?.value.value;
			if (!type) continue;
			const card = prop(it, 'card');
			if (card) cards[type] = card.value.value;
			const sockets = prop(it, 'sockets')?.value;
			if (sockets) {
				const o = prop(sockets, 'out');
				if (o) out[type] = o.value.value;
				const i = prop(sockets, 'in');
				if (i) ins[type] = i.value.properties.map((/** @type {any} */ p) => p.key.name ?? p.key.value);
			}
			const ev = it.properties.find((/** @type {any} */ p) => p.key?.name === 'eval');
			if (ev && !(ev.value.type === 'Literal' && ev.value.value === null)) evaluated.add(type);
		}
	}
	return { cards, out, ins, evaluated };
}

module.exports = { catalogSource, familyFiles, definitionTables };

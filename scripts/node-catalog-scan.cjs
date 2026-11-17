// The flow node catalog's groups and items, read from SOURCE (the module itself pulls in stores, so a
// node script cannot import it) — 2.0 N1: the core entries live in the node definitions now, and
// node-catalog-source.cjs rebuilds the old literal's text from them. Shared by scripts/sync-node-docs.cjs and the
// no-browser guard tests/e2e/flow-node-docs.test.cjs, so the page generator and the guard can never
// read a different catalog — 49 J4: the generator kept a two-level object match after the guard had
// grown a third, and silently dropped every node whose defaults nest deeper (HUD Text, HUD Timer…).
const fs = require('fs');
const path = require('path');
const { catalogSource } = require('./node-catalog-source.cjs');

/**
 * @param {string} [root] the core checkout (default: this script's parent)
 * @returns {{group: string, items: {type: string, label: string, group: string}[]}[]}
 */
function catalogGroups(root = path.join(__dirname, '..')) {
	const src = catalogSource(root);
	/** @type {{group: string, items: {type: string, label: string, group: string}[]}[]} */
	const groups = [];
	const groupRe = /group: '([^']+)',\s*items: \[/g;
	let g;
	while ((g = groupRe.exec(src))) {
		// the items array runs to the matching bracket
		let depth = 1;
		let i = groupRe.lastIndex;
		while (i < src.length && depth > 0) {
			if (src[i] === '[') depth++;
			else if (src[i] === ']') depth--;
			i++;
		}
		const body = src.slice(groupRe.lastIndex, i - 1);
		// three levels: an item, its defaults, and braces inside a default STRING (Script's code)
		const objRe = /\{[^{}]*(?:\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}[^{}]*)*\}/g;
		/** @type {{type: string, label: string, group: string}[]} */
		const items = [];
		let m;
		while ((m = objRe.exec(body))) {
			const t = /\btype: '([a-z0-9]+)'/.exec(m[0]);
			const l = /\blabel: '([^']+)'/.exec(m[0]);
			if (t && l && !items.some((it) => it.type === t[1])) items.push({ type: t[1], label: l[1], group: g[1] });
		}
		groups.push({ group: g[1], items });
	}
	return groups;
}

module.exports = { catalogGroups };

// Regenerate the docs-site flow node reference (docs/nodes.md in the theprototype-docs
// checkout) from ONE source: src/lib/nodeDocs.js for the line per node, src/lib/nodeCatalog.js
// for the groups and labels - so the table and the editor's info pane can never disagree
// (the guard test asserts the page carries the exact text). Run after editing either:
//   DOCS_REPO=../theprototype-docs node scripts/sync-node-docs.cjs
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const DOCS = process.env.DOCS_REPO ? path.resolve(process.env.DOCS_REPO) : path.join(root, '..', 'theprototype-docs');

/** the catalog's groups and items, read from the SOURCE (the module pulls in stores) */
function catalogGroups() {
	const src = fs.readFileSync(path.join(root, 'src', 'lib', 'nodeCatalog.js'), 'utf8');
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
		const items = [];
		const objRe = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
		let m;
		while ((m = objRe.exec(body))) {
			const t = /\btype: '([a-z0-9]+)'/.exec(m[0]);
			const l = /\blabel: '([^']+)'/.exec(m[0]);
			if (t && l && !items.some((it) => it.type === t[1])) items.push({ type: t[1], label: l[1] });
		}
		if (items.length) groups.push({ group: g[1], items });
	}
	return groups;
}

(async () => {
	const { NODE_DOCS } = await import(pathToFileURL(path.join(root, 'src', 'lib', 'nodeDocs.js')).href);
	const groups = catalogGroups();
	let out = `# Flow Nodes

Every node the [Flow editor](node-system.md) offers, grouped exactly as the palette groups
them. Each node's one-line description is the same text the editor shows in its info pane
(and the palette's tooltip) when you select the node, so the two cannot disagree. Nodes with
their own page link to it.

`;
	const pages = new Set(fs.existsSync(path.join(DOCS, 'docs', 'nodes')) ? fs.readdirSync(path.join(DOCS, 'docs', 'nodes')).map((f) => f.replace(/\.md$/, '')) : []);
	for (const g of groups) {
		out += `## ${g.group}\n\n| Node | What it does |\n|---|---|\n`;
		for (const it of g.items) {
			const name = pages.has(it.type) ? `[**${it.label}**](nodes/${it.type}.md)` : `**${it.label}**`;
			out += `| ${name} | ${NODE_DOCS[it.type] ?? ''} |\n`;
		}
		out += '\n';
	}
	if (!fs.existsSync(path.join(DOCS, 'docs'))) {
		console.log('no docs checkout at ' + DOCS + ' - nothing written');
		process.exit(0);
	}
	fs.writeFileSync(path.join(DOCS, 'docs', 'nodes.md'), out);
	console.log(`Wrote ${path.join(DOCS, 'docs', 'nodes.md')} (${groups.reduce((n, g) => n + g.items.length, 0)} nodes in ${groups.length} groups)`);
})();

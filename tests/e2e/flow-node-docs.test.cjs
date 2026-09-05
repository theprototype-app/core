// The flow node MANUAL, and the guard that keeps it honest. No browser: nodeDocs.js is pure,
// and the catalog's groups are read from its source (the module pulls in stores).
//
// Documentation drifts by omission - someone adds a node and nobody notices it has no
// description until a user asks what it does. One line per node is the single source the
// palette tooltip, the info pane and the docs-site table read, so this suite asserts every
// node HAS one, that it says more than the label, and that the docs page lists every node
// with the same text. A new node cannot ship undocumented without turning this red.
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

let failures = 0;
function check(ok, label) {
	console.log((ok ? 'PASS ' : 'FAIL ') + label);
	if (!ok) failures++;
}
const ROOT = path.join(__dirname, '..', '..');
// the docs live in a SIBLING checkout (DOCS_REPO overrides); skip rather than fail when absent
const DOCS = process.env.DOCS_REPO ? path.resolve(process.env.DOCS_REPO) : path.join(ROOT, '..', 'theprototype-docs');

/** the catalog's items from the source, whichever order type/label appear in */
function catalogItems() {
	const src = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'nodeCatalog.js'), 'utf8');
	const groups = [];
	const groupRe = /group: '([^']+)',\s*items: \[/g;
	let g;
	while ((g = groupRe.exec(src))) {
		let depth = 1, i = groupRe.lastIndex;
		while (i < src.length && depth > 0) { if (src[i] === '[') depth++; else if (src[i] === ']') depth--; i++; }
		const body = src.slice(groupRe.lastIndex, i - 1);
		const objRe = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
		let m;
		const items = [];
		while ((m = objRe.exec(body))) {
			const t = /\btype: '([a-z0-9]+)'/.exec(m[0]);
			const l = /\blabel: '([^']+)'/.exec(m[0]);
			if (t && l && !items.some((it) => it.type === t[1])) items.push({ type: t[1], label: l[1], group: g[1] });
		}
		groups.push({ group: g[1], items });
	}
	return groups;
}

(async () => {
	const { NODE_DOCS, nodeDoc } = await import(pathToFileURL(path.join(ROOT, 'src', 'lib', 'nodeDocs.js')).href);
	const groups = catalogItems();
	const items = groups.flatMap((g) => g.items);
	check(items.length >= 80, 'the catalog scan found the nodes (' + items.length + ' in ' + groups.length + ' groups)');

	// ---- 1. every node is documented ----------------------------------------
	const undocumented = items.filter((it) => !NODE_DOCS[it.type] || NODE_DOCS[it.type].trim().length < 15);
	check(undocumented.length === 0, items.length + ' nodes all carry a manual line: ' + JSON.stringify(undocumented.map((d) => d.type)));
	check(typeof nodeDoc('time') === 'string' && nodeDoc('time').length > 20, 'the accessor returns one for a known node');
	check(nodeDoc('nope-not-a-node') === '' && nodeDoc(undefined) === '', 'and an empty string for an unknown one');
	const lazy = items.filter((it) => {
		const doc = (NODE_DOCS[it.type] ?? '').toLowerCase().replace(/[^a-z ]/g, '').trim();
		return doc === it.label.toLowerCase() || doc.length < 15;
	});
	check(lazy.length === 0, 'and none of them merely restates the node name: ' + JSON.stringify(lazy.map((d) => d.type)));
	const stale = Object.keys(NODE_DOCS).filter((t) => !items.some((it) => it.type === t));
	check(stale.length === 0, 'no line documents a node that no longer exists: ' + JSON.stringify(stale));
	const nonAscii = Object.entries(NODE_DOCS).filter(([, d]) => /[^\x00-\x7F]/.test(d)).map(([t]) => t);
	check(nonAscii.length === 0, 'plain ASCII (a tooltip attribute, an llms text): ' + JSON.stringify(nonAscii));
	// the four music nodes say what they are FOR (23-B3): a device, a pulse, the transport
	check(/device/i.test(nodeDoc('deviceparam')) && /device/i.test(nodeDoc('devicelevel')) && /pulse/i.test(nodeDoc('notetrigger')) && /transport/i.test(nodeDoc('transportbeat')), 'the music nodes name the device, the pulse and the transport');

	// ---- 2. the docs page covers every node with the SAME text ---------------
	if (!fs.existsSync(path.join(DOCS, 'docs'))) {
		console.log('SKIP: docs checkout not present at ' + DOCS);
	} else {
		const page = fs.readFileSync(path.join(DOCS, 'docs', 'nodes.md'), 'utf8');
		const missing = items.filter((it) => !page.includes('**' + it.label + '**'));
		check(missing.length === 0, 'the docs reference lists every node: ' + JSON.stringify(missing.map((d) => d.label)));
		const drifted = items.filter((it) => NODE_DOCS[it.type] && !page.includes(NODE_DOCS[it.type]));
		check(drifted.length === 0, 'with the same description the editor shows: ' + JSON.stringify(drifted.map((d) => d.type)));
		const missingGroups = groups.filter((g) => !page.includes('## ' + g.group)).map((g) => g.group);
		check(missingGroups.length === 0, 'grouped exactly as the palette groups them: ' + JSON.stringify(missingGroups));
		// the music nodes have their own pages, in the per-node style (the reference table above
		// is the deliverable for every node; 23 older nodes still lack a page - a docs backlog,
		// listed by name so it is visible, not a failure)
		const noPage = items.filter((it) => !fs.existsSync(path.join(DOCS, 'docs', 'nodes', it.type + '.md')));
		const musicNoPage = noPage.filter((it) => it.group === 'Music');
		check(musicNoPage.length === 0, 'the music nodes each have a page under docs/nodes (' + noPage.length + ' older nodes still without one: ' + noPage.map((d) => d.type).join(', ') + ')');
		// the music guide explains what a table cannot
		const guidePath = path.join(DOCS, 'docs', 'music.md');
		check(fs.existsSync(guidePath), 'the music playground guide exists');
		if (fs.existsSync(guidePath)) {
			const guide = fs.readFileSync(guidePath, 'utf8');
			const topics = [['devices as objects', /userData|device/i], ['cables', /cable/i], ['the shared transport', /transport/i], ['modules', /module/i], ['the purity rule', /pure/i], ['recording', /record/i]];
			const uncovered = topics.filter(([, re]) => !re.test(guide)).map(([n]) => n);
			check(uncovered.length === 0, 'the guide covers the behaviour a table cannot: ' + JSON.stringify(uncovered));
		}
		const nav = fs.readFileSync(path.join(DOCS, 'mkdocs.yml'), 'utf8');
		for (const entry of ['nodes.md', 'music.md', 'nodes/deviceparam.md', 'nodes/notetrigger.md'])
			check(nav.includes(entry), 'mkdocs nav lists ' + entry);
	}

	console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
	process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
	console.log('SCRIPT FAILED: ' + (err && err.stack ? err.stack : err));
	process.exit(1);
});

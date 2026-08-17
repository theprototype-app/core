// The node MANUAL, and the guard that keeps it honest. No browser: the catalog is pure.
//
// Documentation drifts by omission — someone adds a node and nobody notices it has no
// description until a user asks what it does. The catalog carries one line per node as the
// single source (the editor's info pane, the palette tooltip and the docs-site table all
// read it), so this suite asserts every node HAS one and that the docs page lists every
// node. A new node cannot ship undocumented without turning this red.
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

let failures = 0;
function check(ok, label) {
	console.log((ok ? 'PASS ' : 'FAIL ') + label);
	if (!ok) failures++;
}

const src = (f) => pathToFileURL(path.join(__dirname, '..', '..', 'src', 'lib', f)).href;
// the docs live in a SIBLING checkout; skip rather than fail when it is not there
const DOCS = path.join(__dirname, '..', '..', '..', 'theprototype-docs', 'docs');

(async () => {
	const { shaderNodeDefs, shaderNodeDoc, SURFACE_NODE } = await import(src('shaderCatalog.js'));
	const defs = shaderNodeDefs();

	// ---- 1. every node is documented ----------------------------------------
	const undocumented = defs.filter((d) => !d.doc || d.doc.trim().length < 12);
	check(
		undocumented.length === 0,
		defs.length + ' nodes all carry a manual line: ' + JSON.stringify(undocumented.map((d) => d.key))
	);
	check(
		typeof shaderNodeDoc('texture') === 'string' && shaderNodeDoc('texture').length > 20,
		'the accessor returns one for a known node'
	);
	check(shaderNodeDoc('nope-not-a-node') === '', 'and an empty string for an unknown one');

	// a line that only restates the label teaches nothing — demand it says something more
	const lazy = defs.filter((d) => {
		const doc = (d.doc ?? '').toLowerCase().replace(/[^a-z ]/g, '');
		return doc === d.label.toLowerCase() || doc.length < 15;
	});
	check(lazy.length === 0, 'and none of them merely restates the node name: ' + JSON.stringify(lazy.map((d) => d.key)));

	// ---- 2. the taps the Surface node exposes are all explained -------------
	const surface = defs.find((d) => d.key === SURFACE_NODE);
	const tapNames = (surface?.inputs ?? []).map((i) => i.name);
	const surfaceDoc = (surface?.doc ?? '').toLowerCase();
	const missingTaps = tapNames.filter((t) => !surfaceDoc.includes(t));
	check(
		missingTaps.length === 0,
		'the Surface node names all ' + tapNames.length + ' of its taps: ' + JSON.stringify(missingTaps)
	);

	// ---- 3. the docs page covers every node --------------------------------
	if (!fs.existsSync(DOCS)) {
		console.log('SKIP: ../theprototype-docs checkout not present');
	} else {
		const page = fs.readFileSync(path.join(DOCS, 'shader-nodes.md'), 'utf8');
		const missing = defs.filter((d) => !page.includes('**' + d.label + '**'));
		check(
			missing.length === 0,
			'the docs reference lists every node: ' + JSON.stringify(missing.map((d) => d.label))
		);
		// and the table text is the SAME text, so the two cannot drift apart
		const drifted = defs.filter((d) => d.doc && !page.includes(d.doc));
		check(
			drifted.length === 0,
			'with the same description the editor shows: ' + JSON.stringify(drifted.map((d) => d.key))
		);
		// the groups are the palette's groups, so the page is navigable the same way
		const groups = [...new Set(defs.map((d) => d.group))];
		const missingGroups = groups.filter((g) => !page.includes('## ' + g));
		check(
			missingGroups.length === 0,
			'grouped exactly as the palette groups them (' + groups.join(', ') + '): ' + JSON.stringify(missingGroups)
		);

		// the system page must explain the parts a table cannot
		const sys = fs.readFileSync(path.join(DOCS, 'shader-graph.md'), 'utf8');
		const topics = [
			['vertex displacement', /vertex displacement/i],
			['the shadow limitation', /shadow/i],
			['the shared clock', /shared clock/i],
			['content-hash textures', /content hash/i],
			['scene vs object scope', /scene default/i],
			['the glTF export honesty note', /glTF/i],
			['multi-slot refusal', /material slot/i]
		];
		const uncovered = topics.filter(([, re]) => !re.test(sys)).map(([name]) => name);
		check(uncovered.length === 0, 'the guide covers the behaviour a table cannot: ' + JSON.stringify(uncovered));

		// the flow node has its own page, in the per-node style the other flow nodes use
		const nodePage = path.join(DOCS, 'nodes', 'setuniform.md');
		check(fs.existsSync(nodePage), 'Set Shader Uniform has a flow-node page');
		if (fs.existsSync(nodePage)) {
			const np = fs.readFileSync(nodePage, 'utf8');
			check(/Object Selector/.test(np), 'which says what to wire it into');
			check(/numbers/i.test(np), 'and that it drives NUMBERS only, so nobody hunts for colour support');
		}

		// nav: an unlisted page is invisible on the site
		const nav = fs.readFileSync(path.join(DOCS, '..', 'mkdocs.yml'), 'utf8');
		for (const entry of ['shader-graph.md', 'shader-nodes.md', 'nodes/setuniform.md'])
			check(nav.includes(entry), 'mkdocs nav lists ' + entry);
	}

	console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
	process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
	console.error('SCRIPT FAILED: ' + (err && err.stack ? err.stack : err));
	process.exit(1);
});

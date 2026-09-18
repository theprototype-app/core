// P4 — THE POST DOMAIN: a shader graph that compiles to a post-processing effect.
//
// Two halves, for two different risks. The COMPILER half runs with no browser (the
// shader-compile precedent, importing the ESM directly) because the stage rules are pure
// and the way they fail is silent — a surface node in a post graph reads a varying that
// does not exist there and compiles to a wrong picture with no error, so the guard is
// that it is REFUSED BY NAME. The RUNTIME half needs a real GL context and measures
// PIXELS, because "the entry is in the stack" has never been the same question as "the
// frame changed".

const h = require('./helpers.cjs');
const { pathToFileURL } = require('url');
const path = require('path');

const src = (f) => pathToFileURL(path.join(__dirname, '..', '..', 'src', 'lib', f)).href;

/** the live scene stack */
const stackOf = (page) =>
	page.evaluate(() => {
		let state = null;
		window.__stores.scenePost.scenePost.subscribe((s) => (state = s))();
		return state.effects.map((e) => ({ id: e.id, kind: e.kind, params: e.params }));
	});

const postDebug = (page) => page.evaluate(() => window.__postDebug());

const graphsOn = (page) =>
	page.evaluate(() => {
		let map = null;
		window.__stores.shaderGraph.shaderGraphs.subscribe((m) => (map = m))();
		return Object.keys(map);
	});

h.run(async () => {
	// ================================================================ compiler
	console.log('\n=== 1. the compiler: stages, taps and refusals (no browser) ===');
	const catalog = await import(src('shaderCatalog.js'));
	const compile = await import(src('shaderCompile.js'));
	const presets = await import(src('postGraphPresets.js'));

	const postDefs = catalog.shaderNodeDefs().filter((d) => d.group === 'Post');
	h.check(postDefs.length >= 8, '1.1 the catalog has a Post group: ' + postDefs.map((d) => d.key).join(','));
	h.check(
		postDefs.every((d) => d.stages && d.stages.includes('post') && !d.stages.includes('fragment')),
		'1.2 ...and every one of them is post-ONLY (a screen buffer has no surface)'
	);
	h.check(catalog.outputNodeFor('post') === 'postOutput' && catalog.outputNodeFor('surface') === 'surface',
		'1.3 each domain names its own terminal node');

	for (const preset of presets.POST_PRESETS) {
		const r = compile.compilePostGraphToIR(preset.doc());
		h.check(r.ok, '1.4 preset "' + preset.key + '" compiles: ' + JSON.stringify(r.errors ?? []));
	}
	const edgesIr = compile.compilePostGraphToIR(presets.postPreset('edges').doc()).ir;
	h.check(edgesIr.readsDepth && edgesIr.readsNormals, '1.5 edge detect declares BOTH depth and normals');
	const posterIr = compile.compilePostGraphToIR(presets.postPreset('posterise').doc()).ir;
	h.check(
		!posterIr.readsDepth && !posterIr.readsNormals,
		'1.6 ...and posterise declares NEITHER (the buffers are opt-in, not ambient)'
	);
	h.check(
		presets.POST_PRESETS.every((p) => !/\bvUv\b/.test(compile.compilePostGraphToIR(p.doc()).ir.fragment)),
		'1.7 no post fragment mentions vUv — the surface default is TRANSLATED, not emitted'
	);
	// the counterfactual for that translation: `vUv` IS a real identifier in an
	// EffectPass's vertex shader, so emitting it would compile and read nothing
	const uvOnly = compile.compilePostGraphToIR({
		nodes: [
			{ id: 'o', type: 'postOutput', data: {} },
			{ id: 'n', type: 'noise', data: {} }
		],
		edges: [{ source: 'n', sourceHandle: 'out', target: 'o', targetHandle: 'color' }]
	});
	h.check(
		uvOnly.ok && /tpNoise\(uv/.test(uvOnly.ir.fragment),
		'1.8 an unwired uv socket reads the SCREEN uv in a post graph'
	);

	const refused = compile.compilePostGraphToIR({
		nodes: [
			{ id: 'o', type: 'postOutput', data: {} },
			{ id: 'f', type: 'fresnel', data: {} }
		],
		edges: [{ source: 'f', sourceHandle: 'out', target: 'o', targetHandle: 'color' }]
	});
	h.check(
		!refused.ok && /only works in the surface stage/.test(refused.errors[0] ?? ''),
		'1.9 a surface-only node in a post graph is refused BY NAME: ' + JSON.stringify(refused.errors)
	);
	const empty = compile.compilePostGraphToIR({ nodes: [{ id: 'o', type: 'postOutput', data: {} }], edges: [] });
	h.check(
		!empty.ok && /colour/.test(empty.errors[0] ?? ''),
		'1.10 an unwired output says the effect would change nothing: ' + JSON.stringify(empty.errors)
	);
	const noOut = compile.compilePostGraphToIR({ nodes: [{ id: 'c', type: 'sceneColor', data: {} }], edges: [] });
	h.check(!noOut.ok && /Post output/.test(noOut.errors[0] ?? ''), '1.11 a graph with no Post output says so');
	// the surface compiler is untouched by any of this
	const surface = compile.compileShaderGraphToIR({
		nodes: [
			{ id: 's', type: 'surface', data: {} },
			{ id: 'c', type: 'color', data: { value: '#ff0000' } }
		],
		edges: [{ source: 'c', sourceHandle: 'out', target: 's', targetHandle: 'albedo' }]
	});
	h.check(surface.ok && !!surface.ir.albedo, '1.12 the SURFACE compiler still compiles a surface graph');

	// ================================================================ runtime
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	console.log('\n=== 2. the kind, and a graph entering the scene look ===');
	const registered = await page.evaluate(() =>
		window.__stores.scenePost.postEffectKinds().find((d) => d.kind === 'graph')
	);
	h.check(
		!!registered && registered.group === 'graph',
		'2.1 postGraphs registers the `graph` kind: ' + JSON.stringify(registered)
	);

	// a lit box to look at, and a clean stack
	await page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 900));
		window.__stores.objectActions.deselectObject();
		window.__stores.viewMode.set('shaded');
		window.__stores.scenePost.postStacks.set({});
		await new Promise((r) => setTimeout(r, 900));
	});
	const clip = await h.centeredClip(A, [0, 0, 0], 420);
	const base = await h.grabFrame(A, clip);
	h.check((await postDebug(page)).stackPasses === 0, '2.2 premise: nothing in the stack to start with');

	const made = await page.evaluate(() => window.__stores.postGraphs.addPostGraphToLook({ preset: 'posterise' }));
	await page.waitForTimeout(1500);
	const stack = await stackOf(page);
	h.check(
		stack.length === 1 && stack[0].kind === 'graph' && stack[0].params.graph === made.key,
		'2.3 one menu action creates the document AND the stack entry that runs it: ' + JSON.stringify(stack)
	);
	h.check(
		(await graphsOn(page)).includes(made.key),
		'2.4 ...the document lives in shaderGraphs under its `post:` key (so it replicates and saves for free)'
	);
	const dbg = await postDebug(page);
	h.check(
		dbg.graphs.length === 1 && dbg.graphs[0].key === made.key,
		'2.5 ...and the composer holds a compiled effect for it: ' + JSON.stringify(dbg.graphs)
	);

	console.log('\n=== 3. every preset changes the picture, and differently ===');
	/** swap the look to one preset and return its frame */
	async function framePreset(preset) {
		const key = await page.evaluate((p) => {
			const pg = window.__stores.postGraphs;
			const post = window.__stores.scenePost;
			post.postStacks.set({});
			return pg.addPostGraphToLook({ preset: p }).key;
		}, preset);
		await page.waitForTimeout(1600);
		return { key, frame: await h.grabFrame(A, clip), debug: await postDebug(page) };
	}
	/** @type {Record<string, any>} */
	const shots = {};
	for (const preset of ['posterise', 'dither', 'edges', 'customao']) {
		shots[preset] = await framePreset(preset);
		const delta = await h.frameDelta(page, base, shots[preset].frame);
		h.check(
			delta.changed > 2000,
			'3.' + preset + ' changes the frame: ' + delta.changed + ' px changed, mean ' + delta.mean.toFixed(2)
		);
	}
	// PAIRWISE, because "each differs from the baseline" would pass for four copies of
	// one effect — the thing being proven is that the GRAPH decides the picture
	const pairs = [
		['posterise', 'dither'],
		['posterise', 'edges'],
		['edges', 'customao']
	];
	for (const [a, b] of pairs) {
		const delta = await h.frameDelta(page, shots[a].frame, shots[b].frame);
		h.check(delta.changed > 2000, '3.pair ' + a + ' vs ' + b + ' differ: ' + delta.changed + ' px');
	}

	console.log('\n=== 4. the buffers are opt-in ===');
	h.check(
		shots.posterise.debug.normals === false,
		'4.1 posterise adds NO normal pass (a second scene render is not an ambient cost)'
	);
	h.check(shots.edges.debug.normals === true, '4.2 edge detect adds ONE, on demand');
	h.check(
		shots.edges.debug.graphs[0]?.depth === true && shots.customao.debug.graphs[0]?.depth === true,
		'4.3 a depth-reading graph carries EffectAttribute.DEPTH, which is what binds the buffer'
	);
	h.check(
		shots.posterise.debug.graphs[0]?.depth === false,
		'4.4 ...and one that never reads depth does not ask for it'
	);

	console.log('\n=== 5. a value edit writes the uniform; a structural edit rebuilds ===');
	// back to posterise, and remember which chain we are on
	const poster = await framePreset('posterise');
	const before = await postDebug(page);
	const stepsNode = await page.evaluate((key) => {
		let map = null;
		window.__stores.shaderGraph.shaderGraphs.subscribe((m) => (map = m))();
		return (map[key]?.nodes ?? []).find((n) => n.type === 'posterize')?.id ?? '';
	}, poster.key);
	h.check(!!stepsNode, '5.1 premise: the preset has a Posterise node to retune');
	await page.evaluate(
		({ key, id }) => window.__stores.shaderGraph.setShaderParam(key, id, 'steps', 2),
		{ key: poster.key, id: stepsNode }
	);
	await page.waitForTimeout(1200);
	const afterValue = await postDebug(page);
	const valueDelta = await h.frameDelta(page, poster.frame, await h.grabFrame(A, clip));
	h.check(valueDelta.changed > 1000, '5.2 a param change changes the picture: ' + valueDelta.changed + ' px');
	h.check(
		afterValue.stackPasses === before.stackPasses && afterValue.graphs.length === before.graphs.length,
		'5.3 ...through the live uniform — the chain still holds one pass for one graph'
	);
	// a STRUCTURAL edit (a node removed) must recompile the shader, not just a uniform
	await page.evaluate(
		({ key, id }) => {
			let map = null;
			window.__stores.shaderGraph.shaderGraphs.subscribe((m) => (map = m))();
			const doc = map[key];
			window.__stores.shaderGraph.setShaderGraphFor(key, {
				nodes: doc.nodes.filter((n) => n.id !== id),
				edges: doc.edges.filter((e) => e.source !== id && e.target !== id)
			});
		},
		{ key: poster.key, id: stepsNode }
	);
	await page.waitForTimeout(1500);
	const broken = await postDebug(page);
	h.check(
		broken.graphs.length === 0 && broken.stackPasses === 0,
		'5.4 a structural edit that leaves the output unwired takes the pass OUT rather than rendering stale GLSL'
	);
	const errs = await page.evaluate((key) => {
		let map = null;
		window.__stores.shaderGraph.shaderErrors.subscribe((m) => (map = m))();
		return map[key] ?? [];
	}, poster.key);
	h.check(errs.length > 0, '5.5 ...and says why, under the graph key the editor reads: ' + JSON.stringify(errs));

	console.log('\n=== 6. the editor: one surface, two domains ===');
	await page.evaluate(() => {
		window.__stores.objectActions.deselectObject();
		window.__stores.postGraphs.shaderDomain.set('surface');
		window.__stores.shaderEditorClose.set(false);
		window.__stores.bottomDock.activateDock('shader');
	});
	await page.waitForTimeout(1200);
	const surfaceGroups = await page.evaluate(() =>
		[...document.querySelectorAll('#shader-palette .shader-palette-group')].map((el) => el.textContent.trim())
	);
	h.check(
		surfaceGroups.length > 0 && !surfaceGroups.includes('Post'),
		'6.1 the SURFACE palette offers no Post nodes: ' + JSON.stringify(surfaceGroups)
	);
	await page.evaluate(() => document.querySelector('#shader-domain-post').click());
	await page.waitForTimeout(1000);
	const postGroups = await page.evaluate(() =>
		[...document.querySelectorAll('#shader-palette .shader-palette-group')].map((el) => el.textContent.trim())
	);
	h.check(postGroups.includes('Post'), '6.2 the POST palette offers them: ' + JSON.stringify(postGroups));
	// neither terminal is addable in either domain — one comes with the graph, and a
	// second one in a document is a graph with two answers
	const terminals = await page.evaluate(() =>
		[...document.querySelectorAll('#shader-palette .shader-palette-item')]
			.map((el) => el.textContent.trim())
			.filter((name) => name === 'Surface' || name === 'Post output')
	);
	h.check(terminals.length === 0, '6.2b neither terminal node is in the palette: ' + JSON.stringify(terminals));
	const scopeText = await page.evaluate(() => document.querySelector('#shader-scope')?.textContent?.trim() ?? '');
	h.check(/post effect/i.test(scopeText), '6.3 the scope line names the post effect: "' + scopeText + '"');
	h.check(
		(await page.evaluate(() => document.querySelectorAll('#shader-editor .svelte-flow__node').length)) > 0,
		'6.4 ...and the graph is on the canvas'
	);
	await page.evaluate(() => document.querySelector('#shader-domain-surface').click());
	await page.waitForTimeout(800);
	const backText = await page.evaluate(() => document.querySelector('#shader-scope')?.textContent?.trim() ?? '');
	h.check(/scene default/i.test(backText), '6.5 switching back is the SURFACE scope again: "' + backText + '"');

	console.log('\n=== 7. two peers ===');
	const B = await h.setupPage(browser, 'B');
	await B.page.evaluate(() => {
		window.__stores.objectActions.deselectObject();
		window.__stores.viewMode.set('shaded');
	});
	// a clean, working look to replicate
	const shared = await framePreset('edges');
	await h.connect(B, A);
	await h.eventually(
		() => graphsOn(B.page),
		(keys) => keys.includes(shared.key),
		'7.1 the post graph DOCUMENT replicates (the shadergraph message, unchanged)',
		25000
	);
	await h.eventually(
		() => stackOf(B.page),
		(s) => s.length === 1 && s[0].kind === 'graph' && s[0].params.graph === shared.key,
		'7.2 ...and so does the stack entry that runs it',
		20000
	);
	await h.eventually(
		() => postDebug(B.page),
		(d) => d.graphs.length === 1 && d.normals === true,
		'7.3 B compiles it and adds its own normal pass',
		20000
	);

	console.log('\n=== 8. it saves like any other look ===');
	const saved = await page.evaluate(() => ({
		graphs: Object.keys(window.__stores.shaderGraph.shaderGraphsSnapshot()),
		post: window.__stores.scenePost.scenePostSnapshot()
	}));
	h.check(
		saved.graphs.includes(shared.key),
		'8.1 the document is in the shader snapshot: ' + JSON.stringify(saved.graphs)
	);
	h.check(
		saved.post?.effects?.[0]?.kind === 'graph' && saved.post.effects[0].params.graph === shared.key,
		'8.2 ...and the entry is in the look snapshot, pointing at it'
	);
	h.check(h.pageErrors(A).length === 0, '8.3 no page errors on A (' + JSON.stringify(h.pageErrors(A)) + ')');

	await h.finish(browser);
});

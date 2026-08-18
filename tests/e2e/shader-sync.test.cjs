// SH2: shader graph replication + history. Two peers + a late joiner.
// Run: $env:APP_URL='https://localhost:5197/'; $env:PEER_CONFIG='...'; npm run e2e -- shader-sync
const h = require('./helpers.cjs');

const GRAPH = (hex) => ({
	nodes: [
		{ id: 'c1', type: 'color', data: { value: hex } },
		{ id: 's1', type: 'surface', data: {} }
	],
	edges: [{ id: 'e1', source: 'c1', sourceHandle: 'out', target: 's1', targetHandle: 'albedo' }]
});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// A creates a cube; both peers must see it before we attach a graph to it
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await A.page.waitForTimeout(2500);
	const uuid = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					let mesh = null;
					g.traverse((n) => {
						if (n.isMesh && !mesh) mesh = n;
					});
					r(mesh?.uuid ?? null);
				})()
			)
	);
	h.check(!!uuid, 'premise — A has a cube: ' + uuid);
	await h.eventually(
		() => B.page.evaluate((u) => !!window.__stores.objectsGroup && new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(!!g?.getObjectByProperty('uuid', u)))()), uuid),
		(ok) => ok === true,
		'premise — B received the cube'
	);

	// ---- 1. an edit on A reaches B ---------------------------------------------
	await A.page.evaluate(
		([u, g]) => window.__stores.shaderGraph.setShaderGraphFor(u, g),
		[uuid, GRAPH('#e62610')]
	);
	await h.eventually(
		() =>
			B.page.evaluate(
				(u) =>
					new Promise((r) =>
						window.__stores.shaderGraph.shaderGraphs.subscribe((all) => r(all[u]?.nodes?.length ?? 0))()
					),
				uuid
			),
		(n) => n === 2,
		'A -> B: the graph document replicated'
	);
	await h.eventually(
		() => B.page.evaluate((u) => window.__stores.shaderGraph.isShaderDriven(u), uuid),
		(driven) => driven === true,
		'and B COMPILED it locally — the object is shader-driven on B too (the compile is debounced, so poll)'
	);
	const bDriven = await B.page.evaluate((u) => window.__stores.shaderGraph.isShaderDriven(u), uuid);

	// B must NOT have re-broadcast (golden rule 1). A's changedAt is unchanged by the
	// round trip, which is the observable consequence.
	const stamps = await Promise.all([
		A.page.evaluate((u) => new Promise((r) => window.__stores.shaderGraph.shaderGraphs.subscribe((a) => r(a[u]?.changedAt))()), uuid),
		B.page.evaluate((u) => new Promise((r) => window.__stores.shaderGraph.shaderGraphs.subscribe((a) => r(a[u]?.changedAt))()), uuid)
	]);
	h.check(stamps[0] === stamps[1], 'both peers hold the SAME changedAt (no re-broadcast loop): ' + JSON.stringify(stamps));

	// ---- 2. latest-wins on changedAt ------------------------------------------
	// on a THROWAWAY key: injecting a future changedAt on the cube would make every
	// later edit from A correctly OLDER, and sections 4-7 would fail for that reason
	const race = await B.page.evaluate(
		([u]) => {
			const S = window.__stores.shaderGraph;
			const sync = window.__stores.shaderSync;
			S.setShaderGraphFor(u, { nodes: [{ id: 'c1', type: 'color', data: { value: '#e62610' } }, { id: 's1', type: 'surface', data: {} }], edges: [{ id: 'e1', source: 'c1', sourceHandle: 'out', target: 's1', targetHandle: 'albedo' }] }, { silent: true });
			// an OLDER document must be refused
			const before = JSON.parse(JSON.stringify(S.shaderGraphOf(u)));
			sync.applyRemoteShaderGraph({
				key: u,
				doc: { nodes: [], edges: [], domain: 'surface', backend: 'inject', changedAt: 1 }
			});
			const afterOld = JSON.parse(JSON.stringify(S.shaderGraphOf(u)));
			// a NEWER one must win
			sync.applyRemoteShaderGraph({
				key: u,
				doc: {
					nodes: [
						{ id: 'c1', type: 'color', data: { value: '#10c020' } },
						{ id: 's1', type: 'surface', data: {} }
					],
					edges: [{ id: 'e1', source: 'c1', sourceHandle: 'out', target: 's1', targetHandle: 'albedo' }],
					domain: 'surface',
					backend: 'inject',
					changedAt: Date.now() + 60000
				}
			});
			const afterNew = JSON.parse(JSON.stringify(S.shaderGraphOf(u)));
			return { beforeNodes: before.nodes.length, afterOld: afterOld.nodes.length, newColour: afterNew.nodes[0]?.data?.value };
		},
		['probe:latestwins']
	);
	h.check(race.afterOld === race.beforeNodes && race.afterOld === 2, 'an OLDER remote document is refused: ' + race.afterOld + ' nodes kept');
	h.check(race.newColour === '#10c020', 'a NEWER remote document wins: ' + race.newColour);

	// ---- 3. an unknown field from a "newer peer" survives our edit ------------
	const survive = await B.page.evaluate(
		([u]) => {
			const S = window.__stores.shaderGraph;
			window.__stores.shaderSync.applyRemoteShaderGraph({
				key: u,
				doc: { ...S.shaderGraphOf(u), futureField: 'keep-me', changedAt: Date.now() + 120000 }
			});
			const got = S.shaderGraphOf(u)?.futureField;
			// now edit locally and check the field is still there
			S.setShaderGraphFor(u, { nodes: S.shaderGraphOf(u).nodes });
            return { afterApply: got, afterEdit: S.shaderGraphOf(u)?.futureField };
		},
		['probe:latestwins']
	);
	h.check(
		survive.afterApply === 'keep-me' && survive.afterEdit === 'keep-me',
		'a field only a NEWER peer knows survives normalize AND our own edit: ' + JSON.stringify(survive)
	);

	// ---- 4. history: one entry per gesture, and undo replicates --------------
	const undo = await A.page.evaluate(
		([u]) => {
			const S = window.__stores.shaderGraph;
			const sync = window.__stores.shaderSync;
			const H = window.__stores.history;
			const depth = () => new Promise((r) => H.undoStack.subscribe((s) => r(s.length))());
			return (async () => {
				const start = await depth();
				// a "drag": many writes inside one gesture
				sync.beginShaderGesture(u);
                for (let i = 0; i < 6; i++)
                    S.setShaderParam(u, 'c1', 'value', i % 2 ? '#00a0ff' : '#ff8800');
				const during = await depth();
				sync.endShaderGesture(u);
				const after = await depth();
				const colourAfter = S.shaderGraphOf(u).nodes[0].data.value;
				H.undo();
				const colourUndone = S.shaderGraphOf(u)?.nodes?.[0]?.data?.value;
				return { start, during, after, colourAfter, colourUndone };
			})();
		},
		[uuid]
	);
	h.check(undo.during === undo.start, 'six writes inside a gesture record NOTHING yet (' + undo.start + ' -> ' + undo.during + ')');
	h.check(undo.after === undo.start + 1, 'closing the gesture records exactly ONE entry (' + undo.after + ')');
	h.check(
		undo.colourUndone !== undo.colourAfter,
		'and ONE undo reverts the whole gesture: ' + undo.colourAfter + ' -> ' + undo.colourUndone
	);
	await h.eventually(
		() =>
			B.page.evaluate(
				(u) => new Promise((r) => window.__stores.shaderGraph.shaderGraphs.subscribe((a) => r(a[u]?.nodes?.[0]?.data?.value))()),
				uuid
			),
		(v) => v === undo.colourUndone,
		'the undo REPLICATED to B (' + undo.colourUndone + ')'
	);

	// ---- 5. the shared clock agrees across peers ----------------------------
	const clocks = await Promise.all([
		A.page.evaluate(() => window.__stores.shaderGraph.shaderClockNow()),
		B.page.evaluate(() => window.__stores.shaderGraph.shaderClockNow())
	]);
	h.check(
		Math.abs(clocks[0] - clocks[1]) < 2,
		'the Time node reads a SHARED wall clock, so peers agree: ' + clocks.map((c) => c.toFixed(2)).join(' vs ')
	);

	// ---- 6. a LATE JOINER pulls the whole map -------------------------------
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	await h.eventually(
		() =>
			C.page.evaluate(
				(u) => new Promise((r) => window.__stores.shaderGraph.shaderGraphs.subscribe((a) => r(a[u]?.nodes?.length ?? 0))()),
				uuid
			),
		(n) => n === 2,
		'a LATE JOINER receives the graph through the handshake'
	);
	await h.eventually(
		() => C.page.evaluate((u) => window.__stores.shaderGraph.isShaderDriven(u), uuid),
		(driven) => driven === true,
		'and compiles it locally too'
	);

	// ---- 7. delete replicates ----------------------------------------------
	await A.page.evaluate((u) => window.__stores.shaderGraph.setShaderGraphFor(u, null), uuid);
	await h.eventually(
		() =>
			B.page.evaluate(
				(u) => new Promise((r) => window.__stores.shaderGraph.shaderGraphs.subscribe((a) => r(!!a[u]))()),
				uuid
			),
		(present) => present === false,
		'deleting the graph replicates'
	);
	await h.eventually(
		() => B.page.evaluate((u) => window.__stores.shaderGraph.isShaderDriven(u), uuid),
		(driven) => driven === false,
		'and B puts the object back on its own material'
	);

	for (const peer of [A, B, C]) {
		const errs = h.pageErrors ? h.pageErrors(peer) : [];
		h.check(errs.length === 0, 'no page errors on that peer: ' + JSON.stringify(errs.slice(0, 2)));
	}
	await h.finish(browser);
});

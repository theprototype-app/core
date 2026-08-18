// SH4: the four save paths. A compiled material survives NONE of them, and each loses
// it differently — so the checks assert the SHAPE that crossed, never the appearance
// ("it still looks right" is not "it survived": a material array came back as a Group of
// single-material children with identical pixels, which is how that bug reached a user).
// Run: $env:APP_URL='https://localhost:5197/'; npm run e2e -- shader-persist
const h = require('./helpers.cjs');

const GRAPH = (hex) => ({
	nodes: [
		{ id: 'c1', type: 'color', position: { x: 60, y: 80 }, data: { value: hex } },
		{ id: 's1', type: 'surface', position: { x: 320, y: 80 }, data: {} }
	],
	edges: [{ id: 'e1', source: 'c1', sourceHandle: 'out', target: 's1', targetHandle: 'albedo' }]
});

h.run(async () => {
	const browser = await h.launch();
	const peer = await h.setupPage(browser, 'persist');
	const page = peer.page;
	await page.waitForFunction(() => !!window.__stores?.shaderGraph, { timeout: 30000 });

	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(1500);
	const uuid = await page.evaluate(async () => {
		const S = window.__stores;
		const group = await new Promise((r) => S.objectsGroup.subscribe((g) => r(g))());
		let mesh = null;
		group.traverse((n) => { if (n.isMesh && !mesh) mesh = n; });
		S.shaderGraph.startShaderGraphs();
		return mesh.uuid;
	});
	h.check(!!uuid, 'premise — a cube exists: ' + uuid);

	await page.evaluate(([u, g]) => window.__stores.shaderGraph.setShaderGraphFor(u, g), [uuid, GRAPH('#e62610')]);
	await h.eventually(
		() => page.evaluate((u) => window.__stores.shaderGraph.isShaderDriven(u), uuid),
		(d) => d === true,
		'premise — the object is shader-driven'
	);

	// ---- 1. PARK: every serializer must read the object's OWN material ----------
	const park = await page.evaluate(async (u) => {
		const S = window.__stores;
		const group = await new Promise((r) => S.objectsGroup.subscribe((g) => r(g))());
		const mesh = group.getObjectByProperty('uuid', u);
		const driven = mesh.material.type;
		const restore = S.flowRuntime.parkAnimatedAtBase();
		const parkedType = mesh.material.type;
		const parkedIsBase = mesh.material === S.shaderGraph.baseMaterialOf(u);
		// what a toJSON-based save would actually write while parked
		const json = mesh.toJSON();
		const parkedFlag = S.shaderGraph.shaderMaterialsParked();
		restore();
		return {
			driven,
			parkedType,
			parkedIsBase,
			afterRestore: mesh.material.type,
			restoredIsOurs: mesh.material !== S.shaderGraph.baseMaterialOf(u),
			parkedFlag,
			flagAfter: S.shaderGraph.shaderMaterialsParked(),
			// the injected material's marker: our uniforms record
			jsonHasOurUniforms: JSON.stringify(json).includes('shaderUniforms')
		};
	}, uuid);
	h.check(
		park.parkedIsBase && !park.jsonHasOurUniforms,
		'parkAnimatedAtBase swaps in the object\'s OWN material, so a toJSON save carries no injected material'
	);
	h.check(park.parkedFlag && !park.flagAfter, 'the park DEPTH opens and closes (a serializer may nest)');
	h.check(park.restoredIsOurs, 'and the shader material goes straight back afterwards');

	// ---- 2. AUTOSAVE (GLTF-based): save, RELOAD, restore -----------------------
	// The realistic path: the restore is offered as a sticky prompt at load and never
	// applied automatically, so this reloads and calls restoreSnapshot() explicitly.
	await page.evaluate(() => window.__stores.autosave.saveNow());
	await page.waitForTimeout(2500);
	await h.freshReload(peer);
	await page.waitForFunction(() => !!window.__stores?.shaderGraph, { timeout: 30000 });
	await page.waitForTimeout(1500);

	const offered = await page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.autosave.restoreAvailable.subscribe((offer) => {
					const snap = offer?.snapshot;
					r({
						has: !!snap,
						keys: Object.keys(snap?.shaderGraphs ?? {}),
						nodeCount: Object.values(snap?.shaderGraphs ?? {})[0]?.nodes?.length ?? -1,
						colour: Object.values(snap?.shaderGraphs ?? {})[0]?.nodes?.[0]?.data?.value ?? null,
						// the GLTF scene itself must carry NO injected material
						sceneHasOurs: JSON.stringify(snap?.scene ?? {}).includes('shaderUniforms')
					});
				})()
			)
	);
	h.check(offered.has, 'premise — after a reload the autosave is offered for restore');
	h.check(
		offered.keys.length === 1,
		'the snapshot carries the graph BESIDE the GLTF scene: ' + JSON.stringify(offered.keys)
	);
	h.check(offered.nodeCount === 2 && offered.colour === '#e62610', 'with its nodes and authored value intact: ' + offered.nodeCount + ' nodes, ' + offered.colour);
	h.check(!offered.sceneHasOurs, 'and the GLTF scene itself carries no injected material');

	// nothing is shader-driven yet — this is a fresh page that has not restored
	const beforeRestore = await page.evaluate(() => Object.keys(window.__stores.shaderGraph.shaderGraphsSnapshot()).length);
	h.check(beforeRestore === 0, 'premise — the fresh page holds no graphs before restoring');

	await page.evaluate(() => window.__stores.autosave.restoreSnapshot());
	await page.waitForTimeout(2500);
	const afterRestore = await page.evaluate(() => {
		const S = window.__stores.shaderGraph;
		const all = S.shaderGraphsSnapshot();
		const key = Object.keys(all)[0];
		return { key, nodes: all[key]?.nodes?.length ?? -1, colour: all[key]?.nodes?.[0]?.data?.value, driven: key ? S.isShaderDriven(key) : false };
	});
	h.check(
		afterRestore.nodes === 2 && afterRestore.colour === '#e62610',
		'restoring brings the graph back with its authored value: ' + JSON.stringify(afterRestore)
	);
	// the restore re-uuids objects through GLTF and puts them back via the __uuid stamp,
	// so the graph has to find its target again and RECOMPILE — the reconcile's real job
	await h.eventually(
		() => page.evaluate(() => {
			const S = window.__stores.shaderGraph;
			const key = Object.keys(S.shaderGraphsSnapshot())[0];
			return key ? S.isShaderDriven(key) : false;
		}),
		(d) => d === true,
		'and the object is shader-driven again (the graph found its restored target)'
	);
	// everything below works on the RESTORED uuid
	const liveUuid = await page.evaluate(() => Object.keys(window.__stores.shaderGraph.shaderGraphsSnapshot())[0]);

	// ---- 3. SESSIONS / .tpscene (toJSON-based) -------------------------------
	const session = await page.evaluate(async (u) => {
		const S = window.__stores;
		const payload = await S.sessions.buildSessionPayload?.('shader-persist-test');
		if (!payload) return { built: false };
		return {
			built: true,
			keys: Object.keys(payload.shaderGraphs ?? {}),
			nodeCount: Object.values(payload.shaderGraphs ?? {})[0]?.nodes?.length ?? -1,
			// the PARKED save is the whole point: no injected material in the objects
			objectsHaveOurs: JSON.stringify(payload.objects ?? []).includes('shaderUniforms')
		};
	}, liveUuid);
	if (!session.built) {
		h.check(false, 'buildSessionPayload is not exposed — add it to the debug hook');
	} else {
		h.check(
			session.keys.includes(liveUuid) && session.nodeCount === 2,
			'a session payload carries the graph too: ' + JSON.stringify(session.keys)
		);
		h.check(
			!session.objectsHaveOurs,
			'and its toJSON objects carry their OWN materials, not the injected one'
		);
	}

	// ---- 4. UNDO: attach/detach round trip ----------------------------------
	const undo = await page.evaluate(async (u) => {
		const S = window.__stores;
		const H = S.history;
		const driven = S.shaderGraph.isShaderDriven(u);
		S.shaderGraph.setShaderGraphFor(u, null); // detach, recorded
		await new Promise((r) => setTimeout(r, 200));
		const afterDelete = S.shaderGraph.shaderGraphOf(u);
		H.undo();
        await new Promise((r) => setTimeout(r, 250));
		return { driven, afterDelete, afterUndo: S.shaderGraph.shaderGraphOf(u) };
	}, liveUuid);
	h.check(undo.driven && undo.afterDelete === null, 'premise — deleting the graph removed it');
	h.check(
		undo.afterUndo?.nodes?.length === 2,
		'ONE undo brings the whole graph back: ' + (undo.afterUndo?.nodes?.length ?? 'gone')
	);
	await h.eventually(
		() => page.evaluate((u) => window.__stores.shaderGraph.isShaderDriven(u), liveUuid),
		(d) => d === true,
		'and it recompiles onto the object'
	);

	// ---- 5. the GLTF export path is HONEST about what it drops --------------
	const exportInfo = await page.evaluate(() => ({
		count: window.__stores.shaderGraph.shaderDrivenCount()
	}));
	h.check(
		exportInfo.count >= 1,
		'shaderDrivenCount reports what a GLTF export would leave behind: ' + exportInfo.count
	);

	const errs = h.pageErrors ? h.pageErrors(peer) : [];
	h.check(errs.length === 0, 'no page errors: ' + JSON.stringify(errs.slice(0, 3)));
	await h.finish(browser);
});

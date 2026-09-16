// 26-A — the scene budget, the meter and the desktop Statistics panel
// (roadmap 26 sections 2 and 3).
//
// THE FINDING: there was no scene-level budget at all, and `renderer.info` had exactly
// ONE reader in the whole app — the VR stats plate. On a desktop, where every heavy
// scene is built, there was no way to see draw calls, triangles, GPU object counts or a
// single frame-time number, and a diagnostics bundle carried none of them.
//
// What is asserted, in the order it matters:
//  1. the tier arithmetic, which is the part that has to be right and needs no browser;
//  2. the sampler actually reads the live renderer and the live scene;
//  3. the meter's dot changes tier when the scene crosses a budget — driven by REAL
//     objects, not by writing the store;
//  4. the panel opens from the burger menu (the real entry point) and renders the rows;
//  5. the wire counters count per type, and the numbers reach the diagnostics bundle.
const h = require('./helpers.cjs');

h.run(async () => {
	// GPU args: section 2 asserts a frame-time percentile over real frames, and a
	// SwiftShader page runs at ~2.5fps where "p95" is noise (the e2e skill's rule).
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');

	// ---- 1. the pure part ---------------------------------------------------
	const pure = await A.page.evaluate(() => {
		const b = window.__stores.sceneBudget;
		return {
			budgets: b.BUDGETS.length,
			// objects: desktop 1000 / 3000, vr 500 / 1500
			green: b.tierOf('objects', 900, 'desktop'),
			amber: b.tierOf('objects', 2000, 'desktop'),
			red: b.tierOf('objects', 4000, 'desktop'),
			// the SAME count is judged harder on a headset — that is the whole reason
			// there are two columns
			vrAmber: b.tierOf('objects', 900, 'vr'),
			vrRed: b.tierOf('objects', 2000, 'vr'),
			boundaryGreen: b.tierOf('objects', 1000, 'desktop'),
			boundaryAmber: b.tierOf('objects', 3000, 'desktop'),
			unknownKey: b.tierOf('not-a-budget', 5, 'desktop'),
			unknownValue: b.tierOf('objects', null, 'desktop'),
			nan: b.tierOf('objects', NaN, 'desktop'),
			// the meter takes the WORST, and an unmeasured reading never darkens it
			worstOfGreen: b.worstTier({ objects: 10, triangles: 10, calls: 1 }, 'desktop'),
			worstOfMixed: b.worstTier({ objects: 10, triangles: 10, calls: 5000 }, 'desktop'),
			worstOfNothing: b.worstTier({}, 'desktop'),
			rows: b.budgetRows({ objects: 4000 }, 'desktop').find((r) => r.key === 'objects')
		};
	});
	h.check(pure.budgets >= 7, `the budget table is data (${pure.budgets} rows)`);
	h.check(pure.green === 'green' && pure.amber === 'amber' && pure.red === 'red', 'the three tiers read as written');
	h.check(pure.vrAmber === 'amber' && pure.vrRed === 'red', '…and the VR column judges the same count harder');
	h.check(
		pure.boundaryGreen === 'green' && pure.boundaryAmber === 'amber',
		'a reading EXACTLY on a ceiling stays in the lower tier'
	);
	h.check(
		pure.unknownKey === 'unknown' && pure.unknownValue === 'unknown' && pure.nan === 'unknown',
		'an unknown budget, a missing reading and a NaN are all "unknown", never a tier'
	);
	h.check(pure.worstOfGreen === 'green' && pure.worstOfMixed === 'red', 'the meter takes the worst reading');
	h.check(pure.worstOfNothing === 'unknown', '…and nothing measured is not a warning');
	h.check(pure.rows?.tier === 'red' && pure.rows?.green === 1000, 'budgetRows carries the reading, the ceilings and the tier');

	// ---- 2. the sampler reads the LIVE renderer and scene --------------------
	const live = await A.page.evaluate(async () => {
		const { sceneBudget, THREE, objectsGroup, pokeScene } = window.__stores;
		let group; { const s = objectsGroup.subscribe((/** @type {any} */ g) => (group = g)); s(); }
		group.clear();
		const geo = new THREE.BoxGeometry(1, 1, 1);
		const mat = new THREE.MeshStandardMaterial();
		for (let i = 0; i < 24; i++) group.add(new THREE.Mesh(geo, mat));
		pokeScene();
		await new Promise((r) => setTimeout(r, 900));
		return sceneBudget.sampleSceneMetrics();
	});
	h.check(live.objects === 24, `the sampler walks the live scene (${live.objects} objects)`);
	h.check(live.meshes === 24, `…and counts meshes (${live.meshes})`);
	h.check(
		typeof live.triangles === 'number' && live.triangles > 0,
		`renderer.info reaches the desktop at last (${live.triangles} triangles, ${live.calls} draw calls)`
	);
	h.check(typeof live.geometries === 'number', `GPU object counts are read (${live.geometries} geometries, ${live.textures} textures)`);
	h.check(
		live.frameSamples > 10 && live.frameP95 != null && live.frameP95 >= live.frameP50,
		`frame percentiles come from real frames (${live.frameSamples} samples, p50 ${live.frameP50}, p95 ${live.frameP95})`
	);
	h.check(live.profile === 'desktop', `a desktop context is judged against the desktop budget (${live.profile})`);
	h.check(typeof live.ingestBacklog === 'number', 'a registered source (the ingest backlog) reaches the sample');

	// ---- 3. the meter's dot moves with the scene ----------------------------
	await A.page.waitForTimeout(700);
	const greenDot = await A.page.getAttribute('#object-budget-dot', 'data-tier');
	h.check(greenDot === 'green', `24 objects reads green in the status line (${greenDot})`);

	await A.page.evaluate(async () => {
		const { THREE, objectsGroup, pokeScene } = window.__stores;
		let group; { const s = objectsGroup.subscribe((/** @type {any} */ g) => (group = g)); s(); }
		const geo = new THREE.BoxGeometry(1, 1, 1);
		const mat = new THREE.MeshStandardMaterial();
		// past the desktop AMBER ceiling for objects (3000)
		for (let i = 0; i < 3200; i++) group.add(new THREE.Mesh(geo, mat));
		pokeScene();
	});
	await h.eventually(
		() => A.page.getAttribute('#object-budget-dot', 'data-tier'),
		(t) => t === 'red',
		'the status-line dot goes RED when the object budget is exceeded'
	);
	const title = await A.page.getAttribute('#object-count', 'title');
	h.check(
		/over on/.test(String(title)) && /object/i.test(String(title)),
		`…and the tooltip names WHAT is over budget (${title})`
	);

	// ---- 4. the panel, through its real entry point --------------------------
	await A.page.evaluate(() => {
		const { THREE, objectsGroup, pokeScene } = window.__stores;
		let group; { const s = objectsGroup.subscribe((/** @type {any} */ g) => (group = g)); s(); }
		group.clear();
		group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
		pokeScene();
	});
	h.check((await A.page.locator('#stats-window').count()) === 0, 'the Statistics window starts closed (premise)');
	// 94: the logo IS the menu button
	await A.page.locator('#logo-menu').click();
	await A.page.waitForTimeout(400);
	const menuRow = A.page.locator('#open-stats');
	if ((await menuRow.count()) === 0) {
		// the burger opener differs across layouts; fall back to the store, and SAY SO
		h.check(false, 'the burger menu offers a Statistics row (#open-stats not reachable — check the opener)');
		await A.page.evaluate(() => window.__stores.sceneBudget.statsOpen.set(true));
	} else {
		await menuRow.click();
		h.check(true, 'the burger menu offers a Statistics row and it opens the window');
	}
	await A.page.waitForSelector('#stats-window', { timeout: 8000 });
	h.check(true, 'the Statistics window is open');
	const panel = await A.page.evaluate(() => {
		const rows = [...document.querySelectorAll('#stats-budgets tr[data-budget]')];
		return {
			rows: rows.length,
			keys: rows.map((r) => r.getAttribute('data-budget')),
			tiers: rows.map((r) => r.getAttribute('data-tier')),
			frame: document.querySelector('#stats-frame')?.textContent ?? '',
			overall: document.querySelector('#stats-overall')?.getAttribute('data-tier')
		};
	});
	h.check(panel.rows >= 7, `every budget gets a row (${panel.rows})`);
	h.check(panel.keys.includes('triangles') && panel.keys.includes('calls'), 'including the two renderer.info readings the desktop never had');
	h.check(panel.tiers.every((t) => ['green', 'amber', 'red', 'unknown'].includes(String(t))), 'each row carries a tier');
	h.check(/p50/.test(panel.frame) && /ms/.test(panel.frame), 'the frame block shows the percentiles');
	h.check(['green', 'amber', 'red', 'unknown'].includes(String(panel.overall)), `the header carries the overall tier (${panel.overall})`);

	// ---- 5. wire counters + the diagnostics bundle ---------------------------
	const wire = await A.page.evaluate(() => {
		const b = window.__stores.sceneBudget;
		b.resetWireStats();
		for (let i = 0; i < 40; i++) b.noteWire('out', { type: 'camera', pos: [i, 0, 0] });
		for (let i = 0; i < 5; i++) b.noteWire('in', { type: 'move', uuid: 'x' });
		b.noteWire('in', null); // a malformed message still counts, as 'unknown'
		const stats = b.wireStats();
		return {
			busiest: stats.rows[0],
			second: stats.rows[1],
			types: stats.rows.map((r) => r.type),
			seconds: stats.seconds
		};
	});
	h.check(wire.busiest?.type === 'camera' && wire.busiest?.out === 40, `the busiest type is named and counted (${wire.busiest?.type} x${wire.busiest?.out})`);
	h.check(wire.second?.type === 'move' && wire.second?.in === 5, 'and the next one, by direction');
	h.check(wire.types.includes('unknown'), 'a message with no type counts as "unknown" rather than being dropped');
	h.check(typeof wire.busiest?.bytes === 'number', `bytes are estimated from a sample (≈${wire.busiest?.bytes})`);

	const bundle = await A.page.evaluate(() => {
		const text = window.__stores.diagnostics.bundleText();
		return { hasSection: /scene-budget/.test(text), hasTriangles: /triangles/.test(text) };
	});
	h.check(bundle.hasSection, 'the diagnostics bundle carries a scene-budget section');
	h.check(bundle.hasTriangles, '…with the numbers in it — a report can carry them now');

	// the panel closes from its own button
	await A.page.locator('#stats-close').click();
	await A.page.waitForTimeout(250);
	h.check((await A.page.locator('#stats-window').count()) === 0, 'the window closes from its own X');

	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A))})`);
	await h.finish(browser);
});

// 38 R1 — THE SCRUB LOCK, TWO PEERS (SPEC §0: "live peer sync"). A scrub in A's Inspector
// reaches B WHILE A is still dragging (not only on release), a typed value lands on B, and
// A's Ctrl+Z reaches B too. Same for a light's intensity, a shader vector component and an
// Animation field. Runs on the LOCAL signaling server (localSignal.cjs), never the shared box.
const h = require('./helpers.cjs');
const L = require('./lockHelpers.cjs');
const { LOCAL_PEER_STORAGE, ensureSignalServer, stopSignalServer } = require('./localSignal.cjs');

const near = (/** @type {number} */ a, /** @type {number} */ b, eps = 1e-4) => Math.abs(a - b) <= eps;

/** an object property on a peer @param {any} peer @param {string} uuid @param {string} expr */
const objVal = (peer, uuid, expr) =>
	peer.page.evaluate(
		({ uuid, expr }) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					r(o ? expr.split('.').reduce((v, k) => v?.[k], o) : null);
				})()
			),
		{ uuid, expr }
	);

h.run(async () => {
	const signal = await ensureSignalServer();
	const browser = await L.launch();
	const opts = { storage: LOCAL_PEER_STORAGE, context: { viewport: { width: 1440, height: 900 } } };
	const A = await h.setupPage(browser, 'A', opts);
	const B = await h.setupPage(browser, 'B', opts);
	await h.connect(A, B);
	await L.installUndoCounter(A.page);

	// A builds the scene, B receives it
	await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		window.__stores.commandsHandler.sceneCommand('/light directional');
	});
	await A.page.waitForTimeout(2500);
	const ids = await A.page.evaluate(async () => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = g.children.find((c) => c.name === 'Box');
		const light = g.children.find((c) => c.type === 'DirectionalLight');
		box.userData.physics = { ...(box.userData.physics ?? {}), mode: 'static' };
		return { box: box.uuid, light: light.uuid };
	});
	await h.eventually(() => objVal(B, ids.box, 'uuid'), (v) => v === ids.box, 'B has the box', 20000);
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), ids.box);
	await A.page.locator('#inspector-position').waitFor({ state: 'visible', timeout: 10000 });
	await A.page.waitForTimeout(500);

	// ---- position X: B sees it WHILE A drags --------------------------------------------------
	const x0 = await objVal(A, ids.box, 'position.x');
	const field = A.page.locator('#inspector-position .dn-wrap').first();
	const fb = await field.boundingBox();
	const fx = fb.x + 10;
	const fy = fb.y + fb.height / 2;
	await A.page.mouse.move(fx, fy);
	await A.page.mouse.down();
	await A.page.mouse.move(fx + 60, fy, { steps: 12 });
	// still holding the button: B must already have moved
	const midA = await objVal(A, ids.box, 'position.x');
	await h.eventually(() => objVal(B, ids.box, 'position.x'), (v) => near(v, midA, 0.03), `B follows A's scrub before release (A ${midA})`, 4000);
	const midB = await objVal(B, ids.box, 'position.x');
	h.check(near(midB, midA, 0.03) && !near(midB, x0, 0.05), `the scrub reaches B LIVE, mid-drag (button still held): A ${midA} / B ${midB}`);
	await A.page.mouse.move(fx + 100, fy, { steps: 8 });
	await A.page.mouse.up();
	const endA = await objVal(A, ids.box, 'position.x');
	await h.eventually(() => objVal(B, ids.box, 'position.x'), (v) => near(v, endA, 0.002), `B lands on A's final value ${endA}`, 6000);
	h.check(near(await objVal(B, ids.box, 'position.x'), endA, 0.002), `after release B matches A exactly (${endA})`);

	// ---- typed value + undo reach B ------------------------------------------------------------
	await A.page.waitForTimeout(700);
	await field.locator(L.DRAG_INPUT).click();
	await A.page.waitForTimeout(120);
	await A.page.keyboard.type('2.25', { delay: 30 });
	await A.page.keyboard.press('Enter');
	await h.eventually(() => objVal(B, ids.box, 'position.x'), (v) => near(v, 2.25, 0.001), 'B gets the typed 2.25', 6000);
	h.check(near(await objVal(B, ids.box, 'position.x'), 2.25, 0.001), 'a typed value replicates');
	await A.page.waitForTimeout(700);
	await A.page.evaluate(() => /** @type {any} */ (document.activeElement)?.blur?.());
	await A.page.keyboard.press('Control+z');
	await h.eventually(() => objVal(B, ids.box, 'position.x'), (v) => near(v, endA, 0.002), `A's Ctrl+Z reaches B (back to ${endA})`, 6000);
	h.check(near(await objVal(B, ids.box, 'position.x'), endA, 0.002), 'the undo of a typed edit replicates');

	// ---- light intensity -----------------------------------------------------------------------
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), ids.light);
	await A.page.locator('#inspector-intensity').waitFor({ state: 'visible', timeout: 10000 });
	await L.scrub(A.page, '#inspector-intensity', 0, 50);
	const iA = await objVal(A, ids.light, 'intensity');
	await h.eventually(() => objVal(B, ids.light, 'intensity'), (v) => near(v, iA, 0.001), `B gets the light intensity ${iA}`, 6000);
	h.check(near(await objVal(B, ids.light, 'intensity'), iA, 0.001), `a light intensity scrub replicates (${iA})`);

	// ---- shader vector component -----------------------------------------------------------------
	await A.page.evaluate((u) => {
		const S = window.__stores;
		S.objectActions.selectObject(u);
		S.shaderGraph.setShaderGraphFor(u, {
			nodes: [
				{ id: 'tl', type: 'tilingOffset', position: { x: 70, y: 60 }, data: {} },
				{ id: 'sf', type: 'surface', position: { x: 380, y: 90 }, data: {} }
			],
			edges: [{ id: 'e1', source: 'tl', sourceHandle: 'out', target: 'sf', targetHandle: 'albedo' }]
		});
		S.shaderEditorClose.set(false);
		S.bottomDock.activateDock('shader');
	}, ids.box);
	await A.page.locator('#shader-editor .shader-vec .dn-wrap').first().waitFor({ state: 'visible', timeout: 15000 });
	const tilingOn = (/** @type {any} */ peer) =>
		peer.page.evaluate(
			(u) => new Promise((r) => window.__stores.shaderGraph.shaderGraphs.subscribe((all) => r(Number((all[u]?.nodes ?? []).find((n) => n.type === 'tilingOffset')?.data?.tiling?.[0] ?? 1)))()),
			ids.box
		);
	await L.scrub(A.page, '#shader-editor .shader-vec', 0, 80);
	await A.page.waitForTimeout(400);
	const tA = await tilingOn(A);
	await h.eventually(() => tilingOn(B), (v) => near(v, tA, 0.001), `B gets the shader vector ${tA}`, 8000);
	h.check(!near(tA, 1, 0.01) && near(await tilingOn(B), tA, 0.001), `a shader vector scrub replicates (${tA})`);

	// ---- Animation length ----------------------------------------------------------------------------
	await A.page.evaluate((u) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', u);
		s.animationClose.set(false);
		s.bottomDock.activateDock('animation');
		const tid = s.animationPreview.addTrack(u, 'pos.y', obj);
		s.animationPreview.updateTrack(u, tid, { from: 0, to: 2 });
		s.animationPreview.updateAnim(u, { duration: 2, loop: 'loop' });
	}, ids.box);
	await A.page.locator('#animation-length').waitFor({ state: 'visible', timeout: 10000 });
	const lengthOn = (/** @type {any} */ peer) =>
		peer.page.evaluate((u) => {
			let set;
			window.__stores.animationPreview.animations.subscribe((v) => (set = v))();
			return Number(set?.[u]?.clips?.[set[u].active]?.duration ?? NaN);
		}, ids.box);
	await L.scrub(A.page, 'label:has(#animation-length)', 0, 50);
	await A.page.waitForTimeout(400);
	const dA = await lengthOn(A);
	await h.eventually(() => lengthOn(B), (v) => near(v, dA, 0.001), `B gets the clip length ${dA}`, 8000);
	h.check(!near(dA, 2, 0.01) && near(await lengthOn(B), dA, 0.001), `an Animation field scrub replicates (${dA})`);

	stopSignalServer(signal);
	await h.finish(browser);
});

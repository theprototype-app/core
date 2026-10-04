// 36 A5 — A FOG YOU SET STAYS SET. Configure Scene > Fog's Near/Far moved and the fog did not:
//   1. applyEnvironment() grew EVERY fog to 2.5x the scene radius, so a hand-set Far on a scene
//      bigger than it was replaced on the next apply;
//   2. the Inspector kept its own 0 / 50 / white and sent all three with every edit, so dragging
//      Near snapped Far and the colour to the slider's defaults;
//   3. the legacy `color` message for 'fog'/'background' wrote scene.fog directly on the
//      receiver, which the next applyEnvironment() reverted.
// Run: APP_URL=https://theprototype.app:5321/ npm run e2e -- env-fog-sticks
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	const fog = () =>
		page.evaluate(() => {
			let scene;
			window.__stores.globalScene.subscribe((x) => (scene = x))();
			const f = scene?.fog;
			return f ? { near: f.near, far: f.far, color: '#' + f.color.getHexString() } : null;
		});

	// a scene with reach: one box 40 m out, so a growing fog would reach >= 100 m
	await page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let o;
		s.selectedObject.subscribe((x) => (o = x))();
		o.position.set(40, 0.5, 0);
		o.updateMatrixWorld(true);
		s.selectedObjects?.set?.([]);
		s.sceneBounds.refreshSceneBounds();
	});
	const radius = await page.evaluate(() => window.__stores.sceneBounds.sceneRadius());
	h.check(radius > 40, `premise: the scene reaches past 40 m (radius ${radius.toFixed(1)})`);

	// ---- 1. an authored fog keeps its reach through applyEnvironment
	await page.evaluate(() => window.__stores.environment.editEnvSky({ fog: { color: '#888888', near: 2, far: 20 } }));
	await page.evaluate(() => window.__stores.environment.applyEnvironment());
	let f = await fog();
	h.check(f?.far === 20 && f?.near === 2, `1. a hand-set fog survives applyEnvironment (near ${f?.near}, far ${f?.far})`);

	// ---- 2. the Inspector reads the fog and edits ONE field
	await page.evaluate(() => window.__stores.showSidebar('scene'));
	await page.waitForSelector('#fog-far', { timeout: 10000 }).catch(() => {});
	const shown = await page.evaluate(() => ({
		near: /** @type {HTMLInputElement|null} */ (document.getElementById('fog-near'))?.value,
		far: /** @type {HTMLInputElement|null} */ (document.getElementById('fog-far'))?.value
	}));
	h.check(Number(shown.far) === 20 && Number(shown.near) === 2, `2. the Fog rows show the scene's fog (near ${shown.near}, far ${shown.far})`);
	await page.fill('#fog-near', '5');
	await page.press('#fog-near', 'Enter');
	await page.waitForTimeout(300);
	f = await fog();
	h.check(
		f?.near === 5 && f?.far === 20 && f?.color === '#888888',
		`2. editing Near changes Near only (near ${f?.near}, far ${f?.far}, ${f?.color})`
	);
	await page.fill('#fog-far', '30');
	await page.press('#fog-far', 'Enter');
	await page.waitForTimeout(300);
	await page.evaluate(() => window.__stores.environment.applyEnvironment());
	f = await fog();
	h.check(f?.far === 30 && f?.near === 5, `2. editing Far sticks through the next apply (far ${f?.far})`);

	// ---- 3. a preset's fog still grows with the scene (the rule is for presets only)
	await page.evaluate(() => window.__stores.environment.setEnvironment('daylight'));
	f = await fog();
	h.check(!!f && f.far >= radius * 2.5 - 0.01, `3. a preset's fog still reaches the scene (far ${f?.far?.toFixed(1)} >= ${(radius * 2.5).toFixed(1)})`);

	// ---- 4. the legacy receive path lands in the environment and is NOT sent on
	const sent = await page.evaluate(async () => {
		const s = window.__stores;
		let peer;
		s.peers.subscribe((x) => (peer = x))();
		/** @type {any[]} */
		const out = [];
		const orig = peer.send;
		peer.send = (/** @type {any} */ m) => {
			out.push(m.type);
			return orig.call(peer, m);
		};
		await s.commandsHandler.colorObject('fog', '#123456', 3, 12);
		s.environment.applyEnvironment();
		peer.send = orig;
		return out;
	});
	f = await fog();
	h.check(f?.near === 3 && f?.far === 12 && f?.color === '#123456', `4. a peer's fog survives applyEnvironment (near ${f?.near}, far ${f?.far}, ${f?.color})`);
	h.check(!sent.includes('environment'), `4. ...and the receiver does not send it on (${JSON.stringify(sent)})`);
	await h.finish(browser);
});

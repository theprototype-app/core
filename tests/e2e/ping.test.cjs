// Phase 28: Alt+click ping replicates with author + expires.
const h = require('./helpers.cjs');

const readPings = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				import('/src/lib/ping.js').then((mod) =>
					mod.pings.subscribe((list) => resolve(list.map((p) => ({ name: p.name, pos: p.pos }))))()
				);
			})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A, 8000);

	await A.page.keyboard.down('Alt');
	await A.page.mouse.click(400, 550);
	await A.page.keyboard.up('Alt');
	await A.page.waitForTimeout(1500);

	const aPings = await readPings(A.page);
	const bPings = await readPings(B.page);
	h.check(aPings.length === 1, 'local ping recorded');
	h.check(
		bPings.length === 1 &&
			Math.abs(bPings[0].pos[0] - aPings[0].pos[0]) < 0.001 &&
			Math.abs(bPings[0].pos[2] - aPings[0].pos[2]) < 0.001,
		'ping replicated at the same spot'
	);

	const markerOnB = await B.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					let rings = 0;
					scene?.traverse((o) => {
						if (o.geometry?.type === 'RingGeometry') rings++;
					});
					resolve(rings);
				})();
			})
	);
	h.check(markerOnB >= 1, 'marker rendered on B');

	await B.page.waitForTimeout(4500);
	const after = await readPings(B.page);
	h.check(after.length === 0, 'ping expires');

	await h.finish(browser);
});

// Phase 102: VR statistics card — the System toggle mounts a stats plate,
// values populate (FPS/draw/objects/peers), the plate rides the hand OPPOSITE
// the menu hand, and the preference persists. On-device pose is manual.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// toggle on via the radial action (as the sector would)
	await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		window.__stores.vrControls.executeVRMenuAction('stats');
	});
	await A.page.waitForTimeout(900);

	const card = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const node = scene?.getObjectByName('vr-stats-card');
					resolve(!!node);
				})();
			})
	);
	h.check(card, 'Statistics toggle mounts the card');

	const text = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const node = scene?.getObjectByName('vr-stats-card');
					let found = '';
					node?.traverse((o) => {
						if (o.text) found = o.text;
					});
					resolve(found);
				})();
			})
	);
	h.check(
		/FPS \d+/.test(text) && /objects 1 \(1 meshes\)/.test(text) && /peers 0/.test(text),
		`stats populate (${text.replace(/\n/g, ' | ')})`
	);

	// the card belongs to the hand opposite the menu hand
	const hands = await A.page.evaluate(() => ({
		menuRight: window.__stores.vrRadialMenu.statsHand('right'),
		menuLeft: window.__stores.vrRadialMenu.statsHand('left')
	}));
	h.check(hands.menuRight === 'left' && hands.menuLeft === 'right', 'stats hand swaps with the menu hand');

	// toggle off unmounts; preference persisted both ways
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('stats'));
	await A.page.waitForTimeout(400);
	const gone = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) =>
					resolve(!scene?.getObjectByName('vr-stats-card'))
				)();
			})
	);
	h.check(gone, 'toggle removes the card');
	const pref = await A.page.evaluate(() => localStorage.getItem('vrStats'));
	h.check(pref === 'false', 'preference persists');

	await h.finish(browser);
});

// Phase 33: dungeon module — identical seed-generated dungeon on peers + late joiner, clear syncs.
const h = require('./helpers.cjs');

const dungeonData = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const group = scene?.getObjectByName('dungeon-module');
					resolve(group ? { ...group.userData } : null);
				})();
			})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	// 17-A: dungeon lives in the modules repo now — install it on BOTH peers
	// (every peer needs the same modules for shared behaviour to match)
	if (!require('fs').existsSync(h.moduleZipPath('dungeon'))) {
		console.log('SKIP: ../theprototype.app-modules/dungeon.zip not built (npm run pack -- --all there)');
		await h.finish(browser);
		return;
	}
	await h.installModule(A, 'dungeon');
	await h.installModule(B, 'dungeon');

	// open the panel through the registered module menu action
	await A.page.evaluate(() => {
		return new Promise((resolve) => {
			window.__stores.moduleSDK.moduleMenuItems.subscribe((items) => {
				items.find((i) => i.label === 'Dungeon generator').action();
				resolve();
			})();
		});
	});
	await A.page.waitForTimeout(500);
	h.check(await A.page.locator('#dungeon-panel').isVisible(), 'dungeon panel opens from module menu');

	await A.page.locator('#dungeon-seed').fill('12345');
	await A.page.locator('#dungeon-panel input[type="range"]').first().fill('60');
	await A.page.locator('#dungeon-generate').click();
	await A.page.waitForTimeout(1500);

	const a = await dungeonData(A.page);
	h.check(!!a && a.rooms === 60, `dungeon generated on A (${a?.rooms} rooms)`);
	h.check(a && a.ms < 50, `60-room generation under 50 ms (${a?.ms} ms)`);

	await h.eventually(
		() => dungeonData(B.page),
		(b) => b && b.checksum === a.checksum,
		`identical dungeon on B (checksum ${a?.checksum})`
	);

	const C = await h.setupPage(browser, 'C');
	// the late joiner needs the module too - a peer without it cannot rebuild
	// the dungeon from the replicated {seed, params} (that IS the netcode)
	await h.installModule(C, 'dungeon');
	await h.connect(C, A, 12000);
	await h.eventually(
		() => dungeonData(C.page),
		(c) => c && c.checksum === a.checksum,
		'late joiner rebuilt the same dungeon from state sync',
		15000
	);

	await A.page.locator('#dungeon-panel button:has-text("Clear")').click();
	await h.eventually(() => dungeonData(A.page), (d) => d === null, 'clear removes it on A');
	await h.eventually(() => dungeonData(B.page), (d) => d === null, 'clear replicates to B');

	await h.finish(browser);
});

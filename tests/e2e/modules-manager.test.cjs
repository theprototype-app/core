// Phase 45: modules manager — cards with actions, disable persists on reload,
// live re-enable, download-as-example zip matches the package layout.
const h = require('./helpers.cjs');
const fs = require('fs');

const loadedIds = (page) =>
	page.evaluate(() => window.__stores.moduleSDK.loadedModules.map((m) => m.id));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// open the manager through the single sidebar button (drawer first)
	await A.page.evaluate(() => window.__stores.closeMenu.set(false));
	await A.page.waitForTimeout(500);
	await A.page.locator('#open-modules-manager').click();
	await A.page.waitForTimeout(500);
	h.check(await A.page.locator('#module-card-piano').isVisible(), 'manager opens with module cards');

	// module action runs from its card
	await A.page.locator('#module-card-piano').getByRole('button', { name: 'Piano: spawn / remove' }).click();
	await h.eventually(
		() =>
			A.page.evaluate(
				() =>
					new Promise((r) =>
						window.__stores.globalScene.subscribe((s) => r(!!s?.getObjectByName('piano-module')))()
					)
			),
		(v) => v === true,
		'piano spawns from its card'
	);

	// download-as-example: zip with manifest + module.js
	const downloadPromise = A.page.waitForEvent('download');
	await A.page.locator('#module-card-hello').getByRole('button', { name: /Download as example/ }).click();
	const download = await downloadPromise;
	const zipPath = await download.path();
	const { unzipSync } = require('fflate');
	const entries = Object.keys(unzipSync(new Uint8Array(fs.readFileSync(zipPath))));
	h.check(
		entries.includes('manifest.json') && entries.includes('module.js'),
		`example zip has the package layout (${entries.join(', ')})`
	);

	// disable dungeon -> persists -> gone after reload
	await A.page.locator('#module-card-dungeon input[type="checkbox"]').click({ force: true });
	await A.page.waitForTimeout(300);
	const disabled = await A.page.evaluate(() => localStorage.getItem('disabledModules'));
	h.check(disabled?.includes('dungeon'), 'disable persisted');
	h.check((await loadedIds(A.page)).includes('dungeon'), 'still loaded until reload');

	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForTimeout(4000);
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 30000 });
	let ids = await loadedIds(A.page);
	h.check(!ids.includes('dungeon') && ids.includes('hello'), `dungeon gone after reload (${ids.join(',')})`);

	// live re-enable (no reload needed)
	await A.page.evaluate(() => window.__stores.modulesOpen.set(true));
	await A.page.waitForTimeout(400);
	await A.page.locator('#module-card-dungeon input[type="checkbox"]').click({ force: true });
	await A.page.waitForTimeout(500);
	ids = await loadedIds(A.page);
	h.check(ids.includes('dungeon'), 'live re-enable registers the module again');
	const menuHasDungeon = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.moduleSDK.moduleMenuItems.subscribe((items) =>
					r(items.some((i) => i.label === 'Dungeon generator'))
				)()
			)
	);
	h.check(menuHasDungeon, 'its actions are back');

	await h.finish(browser);
});

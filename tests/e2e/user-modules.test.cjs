// Phase 46: user modules — zip install activates live, persists across reload,
// disable respected on boot, github URL normalization, bad URL fails gracefully.
const h = require('./helpers.cjs');
const { zipSync, strToU8 } = require('fflate');

const MODULE_SOURCE = `
export default {
	id: 'testmod',
	name: 'Test Mod',
	version: '2.0.0',
	description: 'installed from a zip in the e2e suite',
	register(api) {
		api.registerMenu('Testmod ping', () => api.toast('testmod alive'));
		window.__testmodLoaded = (window.__testmodLoaded ?? 0) + 1;
	}
};
`;

function makeZip() {
	return Buffer.from(
		zipSync({
			'manifest.json': strToU8(
				JSON.stringify({ id: 'testmod', name: 'Test Mod', version: '2.0.0', entry: 'module.js' })
			),
			'module.js': strToU8(MODULE_SOURCE),
			'assets/readme.txt': strToU8('hello asset')
		})
	);
}

const loadedIds = (page) =>
	page.evaluate(() => window.__stores.moduleSDK.loadedModules.map((m) => m.id));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// install via the manager's file input
	await A.page.evaluate(() => window.__stores.modulesOpen.set(true));
	await A.page.waitForTimeout(400);
	await A.page.getByRole('button', { name: 'User', exact: true }).click();
	await A.page.waitForTimeout(200);
	await A.page.locator('#install-module-zip').setInputFiles({
		name: 'testmod.module.zip',
		mimeType: 'application/zip',
		buffer: makeZip()
	});
	await h.eventually(() => loadedIds(A.page), (ids) => ids.includes('testmod'), 'zip module activates live');
	h.check(
		(await A.page.evaluate(() => window.__testmodLoaded)) === 1,
		'module code actually ran'
	);
	h.check(
		await A.page.locator('#user-module-card-testmod').isVisible(),
		'card appears in the User tab'
	);
	await A.page.locator('#user-module-card-testmod').getByRole('button', { name: 'Testmod ping' }).click();
	await h.eventually(
		() =>
			A.page.evaluate(
				() => new Promise((r) => window.__stores.toastStore.subscribe((t) => r(JSON.stringify(t)))())
			),
		(t) => t.includes('testmod alive'),
		'its menu action works from the card'
	);

	// persists + auto-activates on reload
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForTimeout(4500);
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 30000 });
	await h.eventually(() => loadedIds(A.page), (ids) => ids.includes('testmod'), 'auto-activates after reload', 15000);

	// disable -> reload -> not loaded (but still installed)
	await A.page.evaluate(() => {
		window.__stores.moduleSDK.disabledModules.update((l) => [...l, 'testmod']);
	});
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForTimeout(4500);
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 30000 });
	const ids = await loadedIds(A.page);
	const stillInstalled = await A.page.evaluate(
		() => new Promise((r) => window.__stores.userModules.userModules.subscribe((l) => r(l.length))())
	);
	h.check(!ids.includes('testmod'), 'disabled module does not activate on boot');
	h.check(stillInstalled === 1, 'record stays installed while disabled');

	// URL helpers: github tree link normalizes to raw; unreachable URL fails with a toast
	const normalized = await A.page.evaluate(() =>
		window.__stores.userModules.normalizeRepoUrl('https://github.com/user/repo/tree/main/mymod/')
	);
	h.check(
		normalized === 'https://raw.githubusercontent.com/user/repo/main/mymod',
		`github link normalized (${normalized})`
	);
	const badInstall = await A.page.evaluate(() =>
		window.__stores.userModules.installUrl('https://theprototype.app:5173/definitely-not-a-module')
	);
	h.check(badInstall === false, 'unreachable URL fails gracefully');

	await h.finish(browser);
});

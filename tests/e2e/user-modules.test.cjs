// Phase 46: user modules — zip install activates live, persists across reload,
// disable respected on boot, github URL normalization, bad URL fails gracefully.
// 17-A2: dev-mode live reload — install by URL (page.route-served), mutate the
// served body, Reload swaps the new code in WITHOUT page.reload(); teardown is
// genuine (old menu entry/effect/frame task/click handler gone); a broken body
// keeps the old instance running; auto-poll picks up changes; live disable.
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
	// the manager tabs are role="tab" (real tabs since the mobile polish) — a
	// button-role query never matches and was the suite's known failure
	await A.page.getByRole('tab', { name: 'User', exact: true }).click();
	await A.page.waitForTimeout(200);
	// install row: ONE primary Install driven by the URL field (it used to be a
	// permanently grey color="alternative" button that read as disabled)
	const installBtn = A.page.locator('#user-modules-tab').getByRole('button', { name: 'Install', exact: true });
	h.check(await installBtn.isDisabled(), 'Install is disabled while the URL field is empty');
	await A.page.locator('#install-module-url').fill('https://example.invalid/mod');
	await A.page.waitForTimeout(150);
	h.check(await installBtn.isEnabled(), 'Install enables as soon as a URL is typed');
	await A.page.locator('#install-module-url').fill('');

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

	// --- 17-A2: dev-mode live reload -----------------------------------------
	let servedVersion = 1;
	let serveBroken = false;
	const devSource = () =>
		serveBroken
			? 'export default { this is not javascript'
			: `
export default {
	id: 'devmod', name: 'Dev Mod', version: '${servedVersion}.0.0',
	description: 'dev reload test',
	register(api) {
		window.__devmodVersion = ${servedVersion};
		api.registerMenu('Devmod v${servedVersion}', () => api.toast('devmod v${servedVersion}'));
		api.registerEffect('devmod-effect-v${servedVersion}', () => {});
		api.registerFrameTask(() => {
			window.__devmodTicks${servedVersion} = (window.__devmodTicks${servedVersion} ?? 0) + 1;
		});
		api.registerClickHandler(() => false);
		api.onInput((kind, code) => {
			if (kind === 'down' && code === 'KeyJ')
				window.__devmodKeys = (window.__devmodKeys ?? 0) + 1;
		});
	}
};`;
	// mind the packs-e2e trap: the URL carries a ?t= cache-buster, so match with
	// includes(), never endsWith()
	await A.page.route('**/devmod/**', (route) => {
		const url = route.request().url();
		if (url.includes('manifest.json'))
			return route.fulfill({
				contentType: 'application/json',
				body: JSON.stringify({
					id: 'devmod', name: 'Dev Mod', version: servedVersion + '.0.0', entry: 'module.js'
				})
			});
		return route.fulfill({ contentType: 'text/javascript', body: devSource() });
	});

	const sdkCounts = (page) =>
		page.evaluate(() => {
			const sdk = window.__stores.moduleSDK;
			return new Promise((resolve) =>
				sdk.moduleMenuItems.subscribe((items) =>
					resolve({
						menu: items.filter((i) => i.moduleId === 'devmod').length,
						effects: Object.keys(sdk.moduleEffects).filter((t) => t.startsWith('devmod-effect')).join(','),
						clicks: sdk.moduleClickHandlers.length,
						frames: sdk.moduleFrameTasks.length
					})
				)()
			);
		});

	const clicksBefore = (await sdkCounts(A.page)).clicks;
	const installedDev = await A.page.evaluate(() =>
		window.__stores.userModules.installUrl('https://dev.local/devmod')
	);
	h.check(installedDev === true, 'dev module installs from the routed URL');
	h.check((await A.page.evaluate(() => window.__devmodVersion)) === 1, 'v1 code ran');
	// DEVX #8: an onInput registered during register() must catch a key pressed
	// IMMEDIATELY after install (the old import().then() subscription dropped it)
	await A.page.evaluate(() => {
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', key: 'j' }));
		window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyJ', key: 'j' }));
	});
	h.check(
		(await A.page.evaluate(() => window.__devmodKeys ?? 0)) === 1,
		'onInput is live from the first keypress after install (DEVX #8)'
	);
	const afterInstall = await sdkCounts(A.page);
	h.check(afterInstall.menu === 1 && afterInstall.effects === 'devmod-effect-v1', 'v1 registered one menu entry + effect');

	// mutate the served body, click Reload in the manager — new code live, NO page.reload()
	servedVersion = 2;
	await A.page.evaluate(() => window.__stores.modulesOpen.set(true));
	await A.page.waitForTimeout(400);
	// the manager tabs are role="tab" (real tabs since the mobile polish) — a
	// button-role query never matches and was the suite's known failure
	await A.page.getByRole('tab', { name: 'User', exact: true }).click();
	await A.page.waitForTimeout(200);
	await A.page.locator('#dev-reload-devmod').click();
	await h.eventually(
		() => A.page.evaluate(() => window.__devmodVersion),
		(v) => v === 2,
		'Reload swaps v2 in without a page reload'
	);
	const afterReload = await sdkCounts(A.page);
	h.check(afterReload.menu === 1, 'single menu entry after reload (old one torn down)');
	h.check(afterReload.effects === 'devmod-effect-v2', 'old effect unregistered, new one live');
	h.check(afterReload.clicks === clicksBefore + 1, 'old click handler gone (no accumulation)');
	const t1a = await A.page.evaluate(() => window.__devmodTicks1 ?? 0);
	const t2a = await A.page.evaluate(() => window.__devmodTicks2 ?? 0);
	await A.page.waitForTimeout(600);
	const t1b = await A.page.evaluate(() => window.__devmodTicks1 ?? 0);
	const t2b = await A.page.evaluate(() => window.__devmodTicks2 ?? 0);
	h.check(t1b === t1a, 'old frame task no longer ticks');
	h.check(t2b > t2a, 'new frame task ticks');

	// a broken served body keeps the old instance running
	serveBroken = true;
	const brokenReload = await A.page.evaluate(() =>
		window.__stores.userModules.reloadUserModule({ id: 'devmod' })
	);
	h.check(brokenReload === false, 'broken body reports failure');
	h.check((await A.page.evaluate(() => window.__devmodVersion)) === 2, 'v2 keeps running after a broken reload');
	h.check((await loadedIds(A.page)).includes('devmod'), 'module still loaded after a broken reload');
	serveBroken = false;

	// auto-poll: enable, mutate the source, the change lands without any click
	servedVersion = 3;
	await A.page.evaluate(() => {
		const um = window.__stores.userModules;
		return new Promise((resolve) =>
			um.userModules.subscribe((list) => {
				um.setDevPoll(list.find((m) => m.id === 'devmod'), true);
				resolve();
			})()
		);
	});
	await h.eventually(
		() => A.page.evaluate(() => window.__devmodVersion),
		(v) => v === 3,
		'auto-poll picks the change up',
		15000
	);
	await A.page.evaluate(() => {
		const um = window.__stores.userModules;
		um.setDevPoll({ id: 'devmod' }, false);
	});

	// live disable genuinely deactivates (no page reload needed anymore) —
	// flowbite's Toggle checkbox is sr-only, so click the label wrapping THIS
	// toggle (the card also carries the Auto-poll toggle now)
	await A.page.locator('label:has(#enable-user-module-devmod)').click();
	await h.eventually(() => loadedIds(A.page), (ids) => !ids.includes('devmod'), 'disable deactivates live');
	const afterDisable = await sdkCounts(A.page);
	h.check(afterDisable.menu === 0 && afterDisable.effects === '', 'disable tears the registries down');
	const keysBefore = await A.page.evaluate(() => window.__devmodKeys ?? 0);
	await A.page.evaluate(() => {
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', key: 'j' }));
		window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyJ', key: 'j' }));
	});
	h.check(
		(await A.page.evaluate(() => window.__devmodKeys ?? 0)) === keysBefore,
		'disable also unsubscribes onInput'
	);

	await h.finish(browser);
});

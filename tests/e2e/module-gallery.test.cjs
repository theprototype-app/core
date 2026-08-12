// 17-A3: module gallery — the Browse tab lists the modules-repo index.json
// (CDN mocked via page.route, DISCRIMINATED BY REPO PATH — packs.js also
// fetches cdn.jsdelivr.net at boot), one-click Install activates live,
// installed dims the card, a newer index version grows an Update button, and
// a dead CDN renders the quiet empty state.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	let indexVersion = '1.0.0';
	let indexDown = false;
	const moduleSource = (version) => `
export default {
	id: 'gallerymod', name: 'Gallery Mod', version: '${version}',
	description: 'installed from the Browse tab',
	register(api) {
		window.__gallerymodVersion = '${version}';
		api.registerMenu('Gallerymod ping', () => api.toast('gallerymod alive'));
	}
};`;
	// only the modules repo — the packs/scenes CDN fetches must fall through
	await A.page.route('**/gh/theprototype-app/modules@main/**', (route) => {
		const url = route.request().url();
		if (indexDown) return route.abort();
		if (url.includes('index.json'))
			return route.fulfill({
				contentType: 'application/json',
				body: JSON.stringify([
					{
						id: 'gallerymod',
						name: 'Gallery Mod',
						version: indexVersion,
						description: 'installed from the Browse tab',
						author: 'e2e',
						source: 'modules/gallerymod',
						zip: 'gallerymod.zip'
					}
				])
			});
		if (url.includes('manifest.json'))
			return route.fulfill({
				contentType: 'application/json',
				body: JSON.stringify({
					id: 'gallerymod', name: 'Gallery Mod', version: indexVersion,
					description: 'installed from the Browse tab', entry: 'module.js'
				})
			});
		return route.fulfill({ contentType: 'text/javascript', body: moduleSource(indexVersion) });
	});

	// open the manager, Browse tab
	await A.page.evaluate(() => window.__stores.modulesOpen.set(true));
	await A.page.waitForTimeout(400);
	await A.page.getByRole('tab', { name: 'Browse', exact: true }).click();
	await h.eventually(
		() => A.page.locator('#gallery-card-gallerymod').count(),
		(n) => n === 1,
		'gallery card renders from the mocked index'
	);
	h.check(
		(await A.page.locator('#module-gallery-tab').textContent()).includes('unsandboxed'),
		'trust note shows'
	);
	h.check(
		(await A.page.locator('#gallery-card-gallerymod').textContent()).includes('by e2e'),
		'card carries the author'
	);

	// one-click install activates live
	await A.page.locator('#gallery-card-gallerymod').getByRole('button', { name: 'Install' }).click();
	await h.eventually(
		() => A.page.evaluate(() => window.__gallerymodVersion),
		(v) => v === '1.0.0',
		'Install runs the module live'
	);
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.moduleSDK.loadedModules.map((m) => m.id)),
		(ids) => ids.includes('gallerymod'),
		'module registered with the SDK'
	);
	await h.eventually(
		() => A.page.locator('#gallery-card-gallerymod').textContent(),
		(text) => text.includes('Installed'),
		'card flips to Installed'
	);
	const dimmed = await A.page.evaluate(() => {
		const card = document.getElementById('gallery-card-gallerymod');
		return card.className.includes('opacity-60');
	});
	h.check(dimmed, 'installed card is dimmed');
	const record = await A.page.evaluate(
		() =>
			new Promise((resolve) =>
				window.__stores.userModules.userModules.subscribe((list) =>
					resolve(list.find((m) => m.id === 'gallerymod'))
				)()
			)
	);
	h.check(
		typeof record.source === 'string' && record.source.includes('modules@main/modules/gallerymod'),
		'record keeps the CDN source URL (Update + dev reload keep working)'
	);

	// a newer index version grows an Update button; clicking it updates live
	indexVersion = '1.1.0';
	await A.page.evaluate(() => window.__stores.moduleGallery.loadModuleGallery(true));
	await h.eventually(
		() => A.page.locator('#gallery-card-gallerymod').textContent(),
		(text) => text.includes('Update to v1.1.0'),
		'newer index version offers Update'
	);
	await A.page.locator('#gallery-card-gallerymod').getByRole('button', { name: /Update to/ }).click();
	await h.eventually(
		() => A.page.evaluate(() => window.__gallerymodVersion),
		(v) => v === '1.1.0',
		'Update hot-swaps the new version live'
	);
	await h.eventually(
		() => A.page.locator('#gallery-card-gallerymod').textContent(),
		(text) => text.includes('Installed'),
		'card settles back to Installed'
	);

	// dead CDN = quiet empty state, never a blocking error
	indexDown = true;
	await A.page.evaluate(() => window.__stores.moduleGallery.loadModuleGallery(true));
	await h.eventually(
		() => A.page.locator('#module-gallery-tab').textContent(),
		(text) => text.includes('unavailable'),
		'offline CDN renders the quiet empty state'
	);
	h.check(
		await A.page.evaluate(() => !!window.__stores),
		'app still alive after the CDN failure'
	);

	await h.finish(browser);
});

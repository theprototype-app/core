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
					},
					// C5.1: rows carrying the new gallery metadata. These were DROPPED by
					// normalizeEntry, so a module could not say it is a game or which scene
					// goes with it — and the Browse list had nothing to filter on.
					{
						id: 'gamemod',
						name: 'Game Mod',
						version: '2.0.0',
						description: 'a game, with a scene',
						author: 'e2e',
						source: 'modules/gamemod',
						zip: 'gamemod.zip',
						category: 'game',
						tags: ['vr', 'co-op'],
						template: 'games/gamemod'
					},
					{
						id: 'exmod',
						name: 'Example Mod',
						version: '1.0.0',
						description: 'a worked example',
						author: 'e2e',
						source: 'modules/exmod',
						zip: 'exmod.zip',
						category: 'example',
						tags: ['nodes']
					},
					// an UNKNOWN category must be preserved verbatim, not coerced — a newer
					// repo's value has to survive our reader (the normalizeAnnotation rule)
					{
						id: 'futuremod',
						name: 'Future Mod',
						version: '1.0.0',
						description: 'a category this build has never heard of',
						author: 'e2e',
						source: 'modules/futuremod',
						zip: 'futuremod.zip',
						category: 'sequencer'
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

	// ---- C5.1: category + tags + template survive normalizeEntry ----------------
	// They were dropped, so Browse had nothing to filter on and a game could not point
	// at the scene that goes with it.
	indexDown = false;
	await A.page.evaluate(() => window.__stores.moduleGallery.loadModuleGallery(true));
	await h.eventually(
		() => A.page.locator('#gallery-card-gamemod').count(),
		(n) => n === 1,
		'premise: the extra rows load'
	);
	const normalized = await A.page.evaluate(
		() =>
			new Promise((resolve) =>
				window.__stores.moduleGallery.galleryModules.subscribe((list) => {
					const by = {};
					for (const e of list) by[e.id] = e;
					resolve(by);
				})()
			)
	);
	h.check(normalized.gamemod?.category === 'game', 'category survives normalizeEntry (' + normalized.gamemod?.category + ')');
	h.check(
		JSON.stringify(normalized.gamemod?.tags) === JSON.stringify(['vr', 'co-op']),
		'tags survive (' + JSON.stringify(normalized.gamemod?.tags) + ')'
	);
	h.check(normalized.gamemod?.template === 'games/gamemod', 'and so does the template path');
	// a row with NO category is a tool, so every existing entry keeps working unchanged
	h.check(normalized.gallerymod?.category === 'tool', 'a row with no category defaults to tool');
	// an unknown one is kept verbatim rather than coerced to the default
	h.check(
		normalized.futuremod?.category === 'sequencer',
		'an UNKNOWN category is preserved verbatim (' + normalized.futuremod?.category + ')'
	);

	// ---- C5.1: the Browse filter -----------------------------------------------
	h.check(await A.page.locator('#gallery-filters').count() === 1, 'Browse grows a category filter row');
	h.check(
		await A.page.locator('[data-gal-cat="game"]').count() === 1,
		'with a chip per category'
	);
	await A.page.locator('[data-gal-cat="game"]').click();
	await A.page.waitForTimeout(350);
	h.check(await A.page.locator('#gallery-card-gamemod').count() === 1, 'picking Games keeps the games');
	h.check(await A.page.locator('#gallery-card-exmod').count() === 0, 'and hides the examples');
	h.check(await A.page.locator('#gallery-card-gallerymod').count() === 0, 'and the tools');
	// the game card SAYS it is a game and that it brings a scene
	const gameCard = await A.page.locator('#gallery-card-gamemod').innerText();
	h.check(/game/i.test(gameCard), 'the game card carries a game badge');
	h.check(/\+ scene/i.test(gameCard), 'and says it brings a scene: ' + JSON.stringify(gameCard.slice(0, 80)));
	h.check(/vr/.test(gameCard) && /co-op/.test(gameCard), 'and shows its tags');

	// chips are scoped to the entries the CATEGORY left, so they can never filter to
	// nothing — and switching category drops them, or the next list is silently empty
	const gameTags = await A.page.locator('#gallery-filters [data-gal-tag]').allInnerTexts();
	h.check(
		gameTags.includes('vr') && !gameTags.includes('nodes'),
		'tag chips are scoped to the visible category (' + gameTags.join(',') + ')'
	);
	await A.page.locator('[data-gal-tag="vr"]').click();
	await A.page.waitForTimeout(300);
	h.check(await A.page.locator('#gallery-card-gamemod').count() === 1, 'a tag chip narrows within the category');
	await A.page.locator('[data-gal-cat="example"]').click();
	await A.page.waitForTimeout(350);
	h.check(
		await A.page.locator('#gallery-card-exmod').count() === 1,
		'switching category CLEARS the tags, so the next list is not silently empty'
	);
	await A.page.locator('[data-gal-cat="all"]').click();
	await A.page.waitForTimeout(350);
	const allCards = await A.page.locator('[id^="gallery-card-"]').count();
	h.check(allCards === 4, 'All shows every row again (' + allCards + ')');

	// ---- C5: an installed-but-DIFFERENT module version is visible --------------
	// The gallery index floats on @main while a scene is pinned to a tag, so a player
	// can end up on a version the game was not built against. Module code runs the
	// simulation, so that is a desync nobody could diagnose from the symptom — it is
	// surfaced rather than prevented.
	const skew = await A.page.evaluate(() => {
		const s = window.__stores;
		const installed = s.moduleSDK.loadedModules.find((m) => m.id === 'gallerymod');
		return {
			have: installed?.version ?? null,
			same: s.moduleRequirements.classifyRequirements([{ id: 'gallerymod', version: installed?.version }]),
			other: s.moduleRequirements.classifyRequirements([{ id: 'gallerymod', version: '9.9.9' }]),
			noVersion: s.moduleRequirements.classifyRequirements([{ id: 'gallerymod' }])
		};
	});
	h.check(!!skew.have, 'premise: gallerymod is installed (v' + skew.have + ')');
	h.check(skew.same.mismatched.length === 0, 'the same version reports no skew');
	h.check(
		skew.other.mismatched.length === 1 && skew.other.mismatched[0].want === '9.9.9',
		'a different version is reported as a skew (want ' + skew.other.mismatched[0]?.want + ', have ' + skew.other.mismatched[0]?.have + ')'
	);
	// still SATISFIED: a skew is a warning, not a refusal — the module is there
	h.check(skew.other.satisfied, 'but the requirement is still satisfied — a skew warns, it does not block');
	h.check(skew.noVersion.mismatched.length === 0, 'a requirement with no version pinned cannot skew');

	await h.finish(browser);
});

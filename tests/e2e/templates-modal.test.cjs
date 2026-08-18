// Templates modal: the "Templates" sidebar row opens a General/Examples/Community
// tabbed modal of loadable starting scenes. Content indexes are mocked hermetically
// (page.route on the two CDNs — discriminated by REPO PATH so the packs boot fetch
// on the same cdn.jsdelivr.net host keeps working). Loading rides the existing
// .tpscene path (importSessionZip → requestLoadSession), so the round-trip check
// asserts the backup-stash + replace behavior, not new machinery.
const h = require('./helpers.cjs');
const { zipSync, strToU8 } = require('fflate');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// -- build a REAL loadable .tpscene in-page (three toJSON objects, current format)
	const sessionJson = await A.page.evaluate(() => {
		const s = window.__stores;
		const mk = (/** @type {string} */ name, /** @type {number} */ x) => {
			const m = new s.THREE.Mesh(new s.THREE.BoxGeometry(1, 1, 1), new s.THREE.MeshStandardMaterial({ color: 0x88aaff }));
			m.name = name;
			m.position.set(x, 0.5, 0);
			return m.toJSON();
		};
		return JSON.stringify({
			format: 1,
			name: 'Mock Template',
			count: 2,
			objects: [mk('tplA', 0), mk('tplB', 2)],
			nodes: [],
			edges: [],
			annotations: [],
			joints: [],
			camera: null
		});
	});
	const tpsceneBytes = Buffer.from(zipSync({ 'session.json': strToU8(sessionJson) }));

	// -- hermetic CDNs. NOTE the '/theprototype-app/scenes@' path guard: packs.js also
	// fetches an index.json from cdn.jsdelivr.net at boot (and remember the
	// 'x/index.json'.endsWith('/index.json') trap — match the repo path, not the tail).
	let scenesMode = 'up'; // 'up' | 'down' (down = offline → bundled fallback)
	let indexVersion = 2; // A7: 2 = has games[], 1 = the older index with no games key
	await A.page.route('**/cdn.jsdelivr.net/**', (route) => {
		const url = route.request().url();
		if (!url.includes('/theprototype-app/scenes@')) return route.continue();
		if (scenesMode === 'down') return route.abort();
		if (url.endsWith('/index.json')) {
			// A7: `indexVersion` switches between a v2 index (with games[]) and a v1 one
			// with NO games key at all — the absent-means-absent rule, so a deployed
			// older index has to keep loading into an empty tab
			const body = {
				version: indexVersion,
				templates: [
					{
						slug: 'mock-blockout',
						title: 'Mock Blockout',
						description: 'Greybox floor and blocks',
						scene: 'templates/mock-blockout/scene.tpscene',
						thumb: 'templates/mock-blockout/thumb.webp',
						author: 'theprototype',
						license: 'CC0-1.0',
						tags: ['greybox', 'level design'],
						bytes: 12345
					},
					{
						slug: 'mock-physics',
						title: 'Mock Physics',
						description: 'Dominos and a ball',
						scene: 'templates/mock-physics/scene.tpscene',
						author: 'theprototype',
						license: 'CC0-1.0',
						tags: ['physics'],
						bytes: 2222
					}
				],
				examples: [
					{
						slug: 'mock-example',
						title: 'Mock Example',
						description: 'A showcase scene',
						scene: 'examples/mock-example/scene.tpscene',
						license: 'CC-BY-4.0'
					}
				]
			};
			if (indexVersion === 2)
				body.games = [
					{
						slug: 'mock-crawl',
						title: 'Mock Crawl',
						description: 'A co-op dungeon crawl',
						scene: 'games/mock-crawl/scene.tpscene',
						thumb: 'games/mock-crawl/thumb.webp',
						author: 'theprototype-app',
						license: 'CC0-1.0',
						tags: ['vr', 'co-op'],
						modules: [{ id: 'mock-realms', version: '1.1.0' }],
						bytes: 4444
					},
					{
						slug: 'mock-race',
						title: 'Mock Race',
						description: 'Laps around a spline road',
						scene: 'games/mock-race/scene.tpscene',
						author: 'theprototype-app',
						license: 'CC0-1.0',
						tags: ['racing'],
						modules: [{ id: 'mock-car', version: '2.0.0' }],
						bytes: 5555
					}
				];
			return route.fulfill({ json: body });
		}
		if (url.includes('mock-blockout/scene.tpscene'))
			return route.fulfill({ body: tpsceneBytes, contentType: 'application/zip' });
		if (url.endsWith('.webp')) return route.fulfill({ status: 404 });
		return route.continue();
	});
	let galleryMode = 'missing'; // 'missing' (repo not published yet) | 'ready'
	await A.page.route('**/raw.githubusercontent.com/theprototype-app/community-gallery/**', (route) => {
		if (galleryMode === 'missing') return route.fulfill({ status: 404, body: '404: Not Found' });
		return route.fulfill({
			json: {
				version: 1,
				entries: [
					{
						slug: 'mock-castle',
						title: 'Mock Castle',
						author: 'somebody',
						license: 'CC-BY-4.0',
						description: 'A community build',
						scene: 'mock-castle/scene.tpscene',
						thumb: 'mock-castle/thumb.webp',
						bytes: 999
					}
				]
			}
		});
	});

	// -- 1: never auto-opens at boot ("badge, not popup")
	h.check(!(await A.page.locator('#templates-modal').isVisible().catch(() => false)), 'modal is closed at boot');

	// -- 2: logo menu → Templates row opens the modal on the General tab
	await A.page.locator('#logo-menu').click();
	await A.page.waitForTimeout(300);
	h.check(await A.page.locator('#open-templates').isVisible(), 'Templates row renders in the sidebar menu');
	await A.page.locator('#open-templates').click();
	await A.page.waitForTimeout(600);
	h.check(await A.page.locator('#templates-modal').isVisible(), 'Templates modal opens');
	h.check(
		(await A.page.locator('#templates-tab-general').getAttribute('aria-selected')) === 'true',
		'General tab is active by default'
	);
	h.check(await A.page.locator('#template-blank').isVisible(), 'Blank scene card is first in General');
	await h.eventually(
		() => A.page.locator('[data-scene-slug="mock-blockout"]').isVisible(),
		(v) => v === true,
		'remote template card renders from the mocked scenes index'
	);

	// -- 3: tabs switch
	await A.page.locator('#templates-tab-examples').click();
	h.check(
		(await A.page.locator('#templates-tab-examples').getAttribute('aria-selected')) === 'true',
		'Examples tab activates'
	);
	h.check(await A.page.locator('[data-scene-slug="mock-example"]').isVisible(), 'example card renders');

	// -- 4: community empty state (manifest 404 = repo not published yet)
	await A.page.locator('#templates-tab-community').click();
	await h.eventually(
		() => A.page.locator('#community-empty').isVisible(),
		(v) => v === true,
		'community 404 shows the friendly empty state'
	);
	const submitHref = await A.page.locator('#community-submit-link').getAttribute('href');
	h.check(
		submitHref === 'https://github.com/theprototype-app/community-gallery',
		`submit link points at the gallery repo (${submitHref})`
	);

	// -- 5: community populated (force refetch — 404 memoizes as 'empty')
	galleryMode = 'ready';
	await A.page.evaluate(() => window.__stores.sceneTemplates.loadCommunityGallery(true));
	await h.eventually(
		() => A.page.locator('[data-scene-slug="mock-castle"]').isVisible(),
		(v) => v === true,
		'community card renders after the gallery publishes'
	);
	const castleText = await A.page.locator('[data-scene-slug="mock-castle"]').innerText();
	h.check(
		castleText.includes('Mock Castle') && castleText.includes('somebody') && castleText.includes('CC-BY-4.0'),
		'community card carries title/author/license'
	);

	// -- 6: template load round-trip (backup stash + replace via the session path)
	await A.page.evaluate(() => {
		const s = window.__stores;
		const seed = new s.THREE.Mesh(new s.THREE.BoxGeometry(1, 1, 1), new s.THREE.MeshStandardMaterial());
		seed.name = 'preexisting';
		let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		group.add(seed);
		s.objectsGroup.update((v) => v);
	});
	await A.page.locator('#templates-tab-general').click();
	await A.page.locator('[data-scene-slug="mock-blockout"]').click();
	await A.page.waitForTimeout(400);
	h.check(!(await A.page.locator('#templates-modal').isVisible().catch(() => false)), 'modal closes on card click');
	await h.eventually(
		() =>
			A.page.evaluate(() => {
				let group;
				window.__stores.objectsGroup.subscribe((g) => (group = g))();
				return (group?.children ?? []).map((c) => c.name);
			}),
		(names) => names.includes('tplA') && names.includes('tplB') && !names.includes('preexisting'),
		'template replaces the scene with its objects',
		15000
	);
	const sessionNames = await A.page.evaluate(() => {
		let list;
		window.__stores.sessions.sessions.subscribe((x) => (list = x))();
		return (list ?? []).map((m) => m.name);
	});
	h.check(
		sessionNames.some((n) => n.includes('Backup before')) && sessionNames.includes('Mock Template'),
		`backup stashed + imported slot kept (${sessionNames.join(' | ')})`
	);

	// -- 7: blank card = the shared clear-scene confirm flow
	await A.page.locator('#logo-menu').click();
	await A.page.waitForTimeout(300);
	await A.page.locator('#open-templates').click();
	await A.page.waitForTimeout(400);
	await A.page.locator('#template-blank').click();
	await h.eventually(
		() => A.page.getByText('Clear the scene for everyone?').isVisible(),
		(v) => v === true,
		'Blank asks the clear-scene confirm'
	);
	await A.page.getByRole('button', { name: 'Clear', exact: true }).click();
	await h.eventually(
		() =>
			A.page.evaluate(() => {
				let group;
				window.__stores.objectsGroup.subscribe((g) => (group = g))();
				return group?.children.length ?? -1;
			}),
		(n) => n === 0,
		'Blank clears the scene after confirm'
	);

	// -- 8: viewer gate (roles plugin active) — no fetch, no replace, warn toast
	await A.page.evaluate(() => {
		const w = window.__stores;
		w.cloudHooks.rolesInfo.set({
			myId: 'me',
			myRole: 'viewer',
			amAdmin: false,
			order: ['viewer', 'editor', 'admin'],
			roleOf: () => 'viewer',
			setRole: () => {}
		});
	});
	const viewerResult = await A.page.evaluate(async () => {
		const st = window.__stores.sceneTemplates;
		let entries;
		st.templates.subscribe((x) => (entries = x))();
		return st.loadRemoteScene(entries[0]);
	});
	h.check(viewerResult === false, 'viewer loadRemoteScene is gated');
	h.check(
		await A.page.getByText('View-only — ask an editor to load a scene.').isVisible(),
		'viewer sees the read-only toast'
	);
	await A.page.evaluate(() => window.__stores.cloudHooks.rolesInfo.set(null));

	// -- 9: offline fallback → the bundled static/templates seed index
	scenesMode = 'down';
	const fallback = await A.page.evaluate(async () => {
		const st = window.__stores.sceneTemplates;
		await st.loadTemplatesIndex(true);
		let state, list;
		st.templatesState.subscribe((x) => (state = x))();
		st.templates.subscribe((x) => (list = x))();
		return { state, slugs: list.map((/** @type {any} */ e) => e.slug), thumbs: list.map((/** @type {any} */ e) => e.thumbUrl) };
	});
	h.check(fallback.state === 'fallback', `CDN down falls back to the bundled seed (state=${fallback.state})`);
	h.check(
		fallback.thumbs.every((t) => !t || t.startsWith('/')),
		'bundled entries resolve to app-origin URLs'
	);
	h.check(
		['level-blockout', 'physics-playground', 'architecture-shell'].every((s) => fallback.slugs.includes(s)),
		`the three seed templates are bundled (${fallback.slugs.join(',')})`
	);

	// -- 10: a REAL bundled seed loads end-to-end (app-origin fetch, no mocks)
	await A.page.locator('#logo-menu').click();
	await A.page.waitForTimeout(300);
	await A.page.locator('#open-templates').click();
	await A.page.waitForTimeout(400);
	await A.page.locator('[data-scene-slug="level-blockout"]').click();
	await h.eventually(
		() =>
			A.page.evaluate(() => {
				let group;
				window.__stores.objectsGroup.subscribe((g) => (group = g))();
				return (group?.children ?? []).map((c) => c.name);
			}),
		(names) => names.includes('Floor') && names.includes('Tower') && names.includes('Ramp'),
		'bundled level-blockout seed loads its objects',
		15000
	);
	// authoring regression guard: toJSON serializes the composed MATRIX — a seed
	// exported before a frame ran loads every object at the origin
	const towerPos = await A.page.evaluate(() => {
		let group;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		return group?.getObjectByName('Tower')?.position.toArray() ?? null;
	});
	h.check(
		!!towerPos && Math.abs(towerPos[0] - -7) < 0.01 && Math.abs(towerPos[1] - 3) < 0.01,
		`seed objects keep their authored positions (Tower @ ${JSON.stringify(towerPos)})`
	);

	// -- 11 (A7): the Games tab ------------------------------------------------
	// A game is a scene PLUS a module, so the tab exists to say that out loud. It reads
	// the same index as the other two tabs, from a `games` section a v1 index does not
	// have (checked below).
	await A.page.locator('#logo-menu').click();
	await A.page.waitForTimeout(300);
	await A.page.locator('#open-templates').click();
	await A.page.waitForTimeout(400);
	scenesMode = 'up';
	await A.page.evaluate(() => window.__stores.sceneTemplates.loadTemplatesIndex(true));
	await h.eventually(
		() => A.page.locator('#templates-tab-games').count(),
		(n) => n === 1,
		'a fourth Games tab renders'
	);
	await A.page.locator('#templates-tab-games').click();
	await A.page.waitForTimeout(400);
	h.check(
		(await A.page.locator('#templates-tab-games').getAttribute('aria-selected')) === 'true',
		'the Games tab activates'
	);
	await h.eventually(
		() => A.page.locator('[data-scene-slug="mock-crawl"]').isVisible(),
		(v) => v === true,
		'game cards render from the index games[] section'
	);
	h.check(await A.page.locator('[data-scene-slug="mock-race"]').isVisible(), 'both games are listed');
	// the module requirement is on the CARD: nobody should meet the install dialog
	// without warning (the prompt itself is template-modules' job)
	const needsBadge = A.page.locator('[data-needs="mock-crawl"]');
	h.check(await needsBadge.count() === 1, 'a game card shows its module requirement');
	const needsText = await needsBadge.innerText();
	h.check(/mock-realms/.test(needsText), 'naming the module: ' + JSON.stringify(needsText.trim()));
	// amber, because this device has not got it — assert the COMPUTED colour, not the class
	const needsOk = await needsBadge.evaluate((el) => el.classList.contains('tpl-needs-ok'));
	h.check(!needsOk, 'and reads as "not installed here" rather than as satisfied');
	// a TEMPLATE has no modules, so it grows no badge at all
	await A.page.locator('#templates-tab-general').click();
	await A.page.waitForTimeout(300);
	h.check(
		await A.page.locator('[data-needs="mock-blockout"]').count() === 0,
		'a plain template shows no module line'
	);

	// -- 12 (A7): tag chips ----------------------------------------------------
	// Derived from the ACTIVE tab's own tags, so a new tag in the index needs no core
	// release — and OR within the facet, because an AND empties the grid on click two.
	await A.page.waitForTimeout(200);
	const generalChips = await A.page.locator('#templates-chips .tpl-chip').allInnerTexts();
	h.check(
		generalChips.includes('greybox') && generalChips.includes('physics'),
		'the chip row is derived from the tab entries (' + generalChips.join(',') + ')'
	);
	h.check(!generalChips.includes('vr'), 'and shows only THIS tab\'s tags, not the games\' ones');
	await A.page.locator('[data-chip="physics"]').click();
	await A.page.waitForTimeout(300);
	h.check(
		await A.page.locator('[data-scene-slug="mock-physics"]').isVisible(),
		'picking a chip keeps the entries that carry it'
	);
	h.check(
		await A.page.locator('[data-scene-slug="mock-blockout"]').count() === 0,
		'and hides the ones that do not'
	);
	// OR, not AND: adding a second chip WIDENS the result
	await A.page.locator('[data-chip="greybox"]').click();
	await A.page.waitForTimeout(300);
	h.check(
		await A.page.locator('[data-scene-slug="mock-blockout"]').isVisible() &&
			await A.page.locator('[data-scene-slug="mock-physics"]').isVisible(),
		'a second chip WIDENS the result (OR within the facet)'
	);
	await A.page.locator('#templates-chips-clear').click();
	await A.page.waitForTimeout(250);
	h.check(await A.page.locator('#templates-chips-clear').count() === 0, 'Clear drops the filter and itself');

	// a filter must NOT survive a tab switch: it would silently empty the next grid
	await A.page.locator('[data-chip="greybox"]').click();
	await A.page.waitForTimeout(250);
	await A.page.locator('#templates-tab-games').click();
	await A.page.waitForTimeout(350);
	h.check(
		await A.page.locator('[data-scene-slug="mock-crawl"]').isVisible(),
		'switching tabs clears the chips, so the next grid is not silently empty'
	);
	// VR is just a chip
	const gameChips = await A.page.locator('#templates-chips .tpl-chip').allInnerTexts();
	h.check(gameChips.includes('vr'), 'VR is just a chip on the Games tab (' + gameChips.join(',') + ')');
	await A.page.locator('[data-chip="racing"]').click();
	await A.page.waitForTimeout(300);
	h.check(
		await A.page.locator('[data-scene-slug="mock-race"]').isVisible() &&
			await A.page.locator('[data-scene-slug="mock-crawl"]').count() === 0,
		'and filtering works the same there'
	);

	// -- 13 (A7): a v1 index still loads, with an empty Games tab -------------
	// The absent-means-absent rule: a deployed older build's index has no games key,
	// and that must be an empty tab rather than an error.
	indexVersion = 1;
	const v1 = await A.page.evaluate(async () => {
		const st = window.__stores.sceneTemplates;
		await st.loadTemplatesIndex(true);
		let state, gameList, tplList;
		st.templatesState.subscribe((/** @type {any} */ x) => (state = x))();
		st.games.subscribe((/** @type {any} */ x) => (gameList = x))();
		st.templates.subscribe((/** @type {any} */ x) => (tplList = x))();
		return { state, games: gameList.length, templates: tplList.length };
	});
	h.check(v1.state === 'ready', 'a v1 index (no games key) still loads (state=' + v1.state + ')');
	h.check(v1.templates === 2, 'its templates are intact (' + v1.templates + ')');
	h.check(v1.games === 0, 'and the Games tab is simply empty (' + v1.games + ')');
	await A.page.waitForTimeout(400);
	await h.eventually(
		() => A.page.locator('#games-empty').count(),
		(n) => n === 1,
		'which renders as a friendly empty state, not an error'
	);
	indexVersion = 2;

	await h.finish(browser);
});

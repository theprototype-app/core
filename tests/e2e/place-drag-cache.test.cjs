// Roadmap 39 P3 + P5 (+ the touch half of P1):
//   · hovering the viewport during a drag downloads the item; the Explorer marks it Downloaded
//     with its size, the Packs filter "Downloaded" shows only those, and the item menu's
//     "Delete cache" frees the bytes (CacheStorage) while the item STAYS in its pack
//   · Storage lists the pack downloads and "Clear all pack downloads" empties them
//   · Settings ▸ Scene ▸ Performance ▸ Placement preview: Full model / Within budget / Box only
//     and the triangle budget decide the ghost tier (the budget is checked before anything builds)
//   · a touch long-press drag at 390 × 844 places the item, with the Explorer tucked away
//
//   APP_URL=https://theprototype.app:5390/ node tests/e2e/place-drag-cache.test.cjs
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');
const STATIC = path.join(__dirname, '../../static/library');

async function routeStarterPack(peer) {
	await peer.ctx.route(/cdn\.jsdelivr\.net\/gh\/theprototype-app\/packs@[^/]+\/(.*)$/, (route) => {
		const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^.*packs@[^/]+\//, ''));
		if (rel === 'index.json')
			return route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ name: 'default', title: 'The Prototype', value: 'default/default.json', attribution: 'default/attribution.html', copyright: '', license: '', source: 'https://github.com/theprototype-app/packs' }]) });
		const file = path.join(STATIC, rel);
		if (!file.startsWith(STATIC) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
		const type = /\.json$/.test(file) ? 'application/json' : /\.glb$/.test(file) ? 'model/gltf-binary' : /\.png$/.test(file) ? 'image/png' : 'text/html';
		return route.fulfill({ contentType: type, body: fs.readFileSync(file) });
	});
	await peer.page.evaluate(() => window.__stores.packs.loadPacks());
}

async function openStarterPack(page) {
	await page.evaluate(() => window.__stores.explorerClose.set(false));
	await page.waitForTimeout(500);
	await page.evaluate(() => window.__stores.explorer.activeFolder.set('pack:default'));
	const card = page.locator('.explorer-card', { hasText: 'Duck' }).first();
	await card.waitFor({ timeout: 15000 });
	return card;
}

async function freeCanvasPoint(page, spots = [[0.5, 0.62], [0.42, 0.55], [0.6, 0.5], [0.35, 0.7], [0.65, 0.68], [0.5, 0.4], [0.5, 0.25]]) {
	return page.evaluate((spots) => {
		let renderer;
		window.__stores.globalRenderer.subscribe((v) => (renderer = v))();
		const r = renderer.domElement.getBoundingClientRect();
		for (const [fx, fy] of spots) {
			const x = Math.round(r.left + r.width * fx);
			const y = Math.round(r.top + r.height * fy);
			if (document.elementFromPoint(x, y) === renderer.domElement) return { x, y };
		}
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), blocked: true };
	}, spots);
}

const pd = (page) => page.evaluate(() => window.__stores.placeDrag.state());
const ghost = (page) => page.evaluate(() => window.__stores.placeDrag.ghostInfo());
const DUCK_URL = 'https://cdn.jsdelivr.net/gh/theprototype-app/packs@format-1/default/Duck/glTF-Binary/Duck.glb';
const cacheFacts = (page) =>
	page.evaluate(async (url) => {
		const s = window.__stores;
		let index;
		s.packCache.packCacheIndex.subscribe((v) => (index = v))();
		const urls = [...index.keys()];
		const duck = urls.find((u) => /Duck\.glb$/.test(u)) ?? null;
		const match = duck ? await (await caches.open(s.packCache.PACK_CACHE_NAME)).match(duck) : null;
		return { urls, duck, bytes: duck ? index.get(duck) : 0, inCache: !!match, wanted: url };
	}, DUCK_URL);

async function pickUp(page, card, to) {
	const box = await card.boundingBox();
	const sx = box.x + box.width / 2;
	const sy = box.y + box.height / 2;
	await page.mouse.move(sx, sy);
	await page.mouse.down();
	await page.mouse.move(sx + 12, sy + 6, { steps: 4 });
	await page.mouse.move(sx + 30, sy + 10, { steps: 4 });
	if (to) await page.mouse.move(to.x, to.y, { steps: 12 });
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	await routeStarterPack(A);
	await A.page.evaluate(async () => {
		await window.__stores.packCache.clearPackCache();
		window.__stores.placementPrefs.placementPreview.set('budget');
		window.__stores.placementPrefs.placementTriBudget.set(50000);
	});
	const card = await openStarterPack(A.page);
	const spot = await freeCanvasPoint(A.page);

	// ---- 1. a drag over the viewport downloads it; the card says Downloaded + its size ----------
	h.check((await cacheFacts(A.page)).urls.length === 0, 'premise: no pack downloads yet');
	h.check((await A.page.locator('.explorer-cached').count()) === 0, 'premise: no card carries the Downloaded badge');
	await pickUp(A.page, card, spot);
	await h.eventually(() => cacheFacts(A.page), (c) => c.inCache, 'hovering the viewport downloads the item into the pack cache', 15000);
	await A.page.keyboard.press('Escape');
	await A.page.mouse.up();
	let c = await cacheFacts(A.page);
	h.check(c.bytes === 120484, 'the cache knows its size: 120484 bytes (' + c.bytes + ')');
	await h.eventually(() => A.page.locator('.explorer-cached').count(), (n) => n === 1, 'the Duck card now carries the Downloaded badge');
	const title = await A.page.locator('.explorer-cached').first().getAttribute('title');
	h.check(/Downloaded · 118 KB/.test(title || ''), 'its title says the size: "' + title + '"');

	// ---- 2. the Downloaded filter ------------------------------------------------------------
	const cardsShown = () => A.page.locator('.explorer-card').count();
	const all = await cardsShown();
	await A.page.locator('#explorer-filter').click();
	await A.page.getByRole('menuitem', { name: /Downloaded/ }).click();
	await A.page.waitForTimeout(300);
	const only = await cardsShown();
	h.check(all >= 2 && only === 1, 'the Packs filter "Downloaded" shows only the downloaded item (' + all + ' → ' + only + ')');
	await A.page.locator('#explorer-filter').click();
	await A.page.getByRole('menuitem', { name: /Downloaded/ }).click();
	await A.page.waitForTimeout(300);
	await A.page.keyboard.press('Escape');
	h.check((await cardsShown()) === all, 'and off again shows every item');

	// ---- 3. Delete cache frees the bytes, the item stays listed --------------------------------
	await card.click({ button: 'right' });
	const del = A.page.getByRole('menuitem', { name: /Delete cache \(118 KB\)/ });
	h.check((await del.count()) === 1, 'the pack item menu offers "Delete cache (118 KB)" in place of Delete');
	h.check((await A.page.getByRole('menuitem', { name: /^Delete$/ }).count()) === 0, 'and no plain Delete');
	await del.click();
	await A.page.waitForTimeout(600);
	c = await cacheFacts(A.page);
	h.check(!c.inCache && !c.duck, 'Delete cache freed the bytes (gone from CacheStorage and the index)');
	h.check((await A.page.locator('.explorer-card', { hasText: 'Duck' }).count()) === 1, 'and the Duck is still listed in its pack');
	h.check((await A.page.locator('.explorer-cached').count()) === 0, 'without the Downloaded badge');
	await card.click({ button: 'right' });
	const off = A.page.getByRole('menuitem', { name: /^Delete cache$/ });
	h.check((await off.count()) === 1 && (await off.getAttribute('aria-disabled')) !== 'false', 'a not-downloaded item offers Delete cache disabled');
	await A.page.keyboard.press('Escape');
	// a menu left open would eat the next press (its backdrop closes it instead of the card dragging)
	if (await A.page.locator('[role=menu]').count()) await A.page.mouse.click(spot.x, spot.y);
	await A.page.waitForTimeout(200);
	h.check((await A.page.locator('[role=menu]').count()) === 0, 'premise: the menu is closed');

	// ---- 4. the preview setting decides the tier (the template is decoded by now) -----------------
	const tierWith = async (mode, budget) => {
		await A.page.evaluate(({ mode, budget }) => {
			window.__stores.placementPrefs.placementPreview.set(mode);
			window.__stores.placementPrefs.placementTriBudget.set(budget);
		}, { mode, budget });
		await pickUp(A.page, card, spot);
		// the swap is async (never inside the pointer event): give the expected tier a moment
		let g = await ghost(A.page);
		for (let i = 0; i < 15 && g.items[0]?.tier !== (mode === 'box' || (mode === 'budget' && budget < 4212) ? 'box' : 'model'); i++) {
			await A.page.waitForTimeout(200);
			g = await ghost(A.page);
		}
		await A.page.waitForTimeout(300);
		g = await ghost(A.page);
		await A.page.keyboard.press('Escape');
		await A.page.mouse.up();
		await A.page.waitForTimeout(200);
		return g.items[0]?.tier;
	};
	h.check((await tierWith('budget', 50000)) === 'model', 'Within budget, 4212 tris under 50k: the real model');
	h.check((await tierWith('budget', 1000)) === 'box', 'Within budget, over a 1000-tri budget: the box');
	h.check((await tierWith('full', 1000)) === 'model', 'Full model ignores the budget');
	h.check((await tierWith('box', 50000)) === 'box', 'Box only: always the box');
	await A.page.evaluate(() => {
		window.__stores.placementPrefs.placementPreview.set('budget');
		window.__stores.placementPrefs.placementTriBudget.set(50000);
	});

	// ---- 5. Settings ▸ Scene ▸ Performance rows drive the same stores --------------------------
	await A.page.evaluate(() => {
		window.__stores.settingsSection.set('scene');
		window.__stores.settingsOpen.set(true);
	});
	const row = A.page.locator('#row-placement-preview');
	await row.waitFor({ timeout: 10000 });
	await row.getByText('Box only').click();
	await A.page.waitForTimeout(200);
	h.check((await A.page.evaluate(() => { let v; window.__stores.placementPrefs.placementPreview.subscribe((x) => (v = x))(); return v; })) === 'box', 'the Placement preview row sets the mode (Box only)');
	h.check(await A.page.locator('#placement-tri-budget').isDisabled(), 'the budget field is off unless the mode is Within budget');
	await row.getByText('Within budget').click();
	await A.page.locator('#placement-tri-budget').fill('20000');
	await A.page.locator('#placement-tri-budget').press('Enter');
	await A.page.waitForTimeout(200);
	h.check((await A.page.evaluate(() => { let v; window.__stores.placementPrefs.placementTriBudget.subscribe((x) => (v = x))(); return v; })) === 20000, 'the budget field writes the triangle budget');
	h.check((await A.page.evaluate(() => localStorage.getItem('placement:triBudget'))) === '20000', 'persisted (safeStorage)');
	await A.page.evaluate(() => window.__stores.settingsOpen.set(null));
	await A.page.waitForTimeout(300);

	// ---- 6. Storage: the pack downloads and "Clear all pack downloads" ---------------------------
	await pickUp(A.page, card, spot);
	await A.page.waitForTimeout(300);
	await A.page.mouse.up();
	await h.eventually(() => cacheFacts(A.page), (x) => x.inCache, 'placing it again downloads it again (its cache was deleted)', 15000);
	await A.page.evaluate(() => window.__stores.storageUsage.openStorageModal());
	await h.eventually(
		() => A.page.evaluate(() => { let s; window.__stores.storageUsage.storageScan.subscribe((v) => (s = v))(); const cat = s?.categories?.find((c) => c.key === 'packcache'); return cat ? { rows: cat.rows.length, bytes: cat.bytes } : null; }),
		(x) => !!x && x.rows >= 1 && x.bytes >= 120484,
		'Storage lists the pack downloads (a row per pack, with the bytes)'
	);
	await A.page.locator('#storage-group-toggle-packcache').click();
	await A.page.locator('#storage-clear-pack-downloads').click();
	await A.page.waitForTimeout(800);
	c = await cacheFacts(A.page);
	h.check(c.urls.length === 0 && !c.inCache, '"Clear all pack downloads" empties the pack cache');
	await A.page.evaluate(() => window.__stores.storageUsage.storageModalOpen.set(false));

	// ---- 7. touch: a long-press drag at 390 × 844 --------------------------------------------
	const T = await h.setupPage(browser, 'T', { context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.7 } });
	await routeStarterPack(T);
	const tcard = await openStarterPack(T.page);
	const before = await T.page.evaluate(() => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return g.children.length; });
	const b = await tcard.boundingBox();
	const cdp = await T.ctx.newCDPSession(T.page);
	const sx = b.x + b.width / 2;
	const sy = b.y + b.height / 2;
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy }] });
	await T.page.waitForTimeout(700); // 40 F3: the shared touch hold is HOLD_MS = 450 (1.31's card hold was 300)
	// 40 F3 (long-press-explorer-file): a still hold opens the card's action sheet; the hold that
	// then MOVES picks the card up (the sheet gives way) — 1.31 picked it up on the hold itself
	h.check(!(await pd(T.page)), '40 F3: a still hold is not a place drag yet (it opens the action sheet)');
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx, y: sy - 24 }] });
	await T.page.waitForTimeout(150);
	h.check(!!(await pd(T.page)), 'a long-press on a pack card that then moves picks it up as a place drag');
	h.check(await T.page.evaluate(() => document.documentElement.classList.contains('tp-place-collapse')), 'the Explorer is tucked away while the finger drags');
	// the viewport point is taken WITH the Explorer collapsed
	await T.page.waitForTimeout(250);
	const tspot = await freeCanvasPoint(T.page, [[0.5, 0.75], [0.5, 0.85], [0.4, 0.7], [0.6, 0.65], [0.5, 0.55]]);
	h.check(!tspot.blocked, 'premise: with the sheet tucked away the viewport is there to drop on');
	for (let i = 1; i <= 10; i++)
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx + ((tspot.x - sx) * i) / 10, y: sy + ((tspot.y - sy) * i) / 10 }] });
	await T.page.waitForTimeout(300);
	const ts = await pd(T.page);
	if (!ts) console.log('  touch drag ended: ' + JSON.stringify(await T.page.evaluate(() => window.__stores.placeDrag.last())));
	h.check(ts?.over === 'viewport' && ts?.items?.[0]?.dims?.source === 'row', 'the finger over the viewport shows the Duck ghost sized from its row');
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await h.eventually(
		() => T.page.evaluate(() => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return g.children.length; }),
		(n) => n === before + 1,
		'lifting the finger over the viewport places it'
	);
	h.check(!(await T.page.evaluate(() => document.documentElement.classList.contains('tp-place-collapse'))), 'and the Explorer comes back');

	await h.finish(browser);
});

// 60 Q6 — THE LOCAL ASSET CACHE (OPFS):
//  §1 a pack file and a sky are downloaded ONCE: after a reload the second load reads them from
//     OPFS and the network sees no request for either (counted on the wire, not believed)
//  §2 navigator.storage.persist() is asked exactly once, from the toast that says why — not on
//     boot, not again after a reload
//  §3 the app shell is never kept: only content keys are in the index
//  §4 Settings ▸ Storage shows what it holds and Clear empties it (index and OPFS files)
//  §5 39 P5's CacheStorage pack copies are moved over and that cache deleted
//
//   APP_URL=https://localhost:5452/ node tests/e2e/asset-cache-opfs.test.cjs
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const STATIC = path.join(__dirname, '../../static/library');
const DUCK =
	'https://cdn.jsdelivr.net/gh/theprototype-app/packs@format-1/default/Duck/glTF-Binary/Duck.glb';
const DUCK_BYTES = fs.statSync(path.join(STATIC, 'default/Duck/glTF-Binary/Duck.glb')).size;
const SKY = 'hdri/meadow_2_1k.hdr';
const LEGACY =
	'https://cdn.jsdelivr.net/gh/theprototype-app/packs@format-1/default/legacy-probe.glb';

/** counts persist() calls across reloads (sessionStorage survives a reload in one tab) and
 * makes persisted() answer false, so the app has a reason to ask */
function persistSpy() {
	const storage = navigator.storage;
	storage.persist = async () => {
		sessionStorage.setItem(
			'e2e:persist',
			String(Number(sessionStorage.getItem('e2e:persist') || 0) + 1)
		);
		return true;
	};
	storage.persisted = async () => Number(sessionStorage.getItem('e2e:persist') || 0) > 0;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { init: persistSpy });
	const hits = { duck: 0, sky: 0 };
	A.page.on('request', (req) => {
		const u = req.url();
		if (/Duck\.glb$/.test(u)) hits.duck++;
		if (u.endsWith('/' + SKY)) hits.sky++;
	});
	await A.ctx.route(/cdn\.jsdelivr\.net\/gh\/theprototype-app\/packs@[^/]+\/.*\.glb$/, (route) =>
		route.fulfill({
			contentType: 'model/gltf-binary',
			body: fs.readFileSync(path.join(STATIC, 'default/Duck/glTF-Binary/Duck.glb'))
		})
	);

	const facts = () =>
		A.page.evaluate(async () => {
			const s = window.__stores;
			await s.assetCache.assetCacheReady();
			let idx;
			s.assetCache.assetCacheIndex.subscribe((v) => (idx = v))();
			return {
				stats: s.assetCache.assetCacheStats(),
				keys: Object.keys(idx.entries),
				persist: Number(sessionStorage.getItem('e2e:persist') || 0)
			};
		});

	// ---- §5 first: a 39 P5 CacheStorage copy is waiting from an older build ----------------------
	await A.page.evaluate(async (url) => {
		const c = await caches.open('tp-pack-files-v1');
		await c.put(
			url,
			new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {
				headers: { 'content-type': 'model/gltf-binary' }
			})
		);
	}, LEGACY);

	let f = await facts();
	h.check(f.stats.backend === 'opfs', 'the cache runs on OPFS (' + f.stats.backend + ')');
	h.check(f.persist === 0, '§2 premise: persist() was not asked on boot');

	// ---- §1 first load: downloads -----------------------------------------------------------------
	const first = await A.page.evaluate(
		async ({ duck, sky }) => {
			const s = window.__stores;
			const a = await s.packCache.fetchPackBuffer(duck);
			const b = await s.assetCache.fetchCached(new URL(sky, document.baseURI).href, {
				kind: 'sky',
				version: 'e2e'
			});
			return { duck: a.byteLength, sky: b.byteLength };
		},
		{ duck: DUCK, sky: SKY }
	);
	h.check(
		first.duck === DUCK_BYTES && hits.duck === 1,
		`first load fetched the pack file once (${first.duck} bytes, ${hits.duck} request)`
	);
	h.check(
		first.sky > 100000 && hits.sky === 1,
		`first load fetched the sky once (${first.sky} bytes, ${hits.sky} request)`
	);
	await h.eventually(facts, (x) => x.keys.length >= 2, 'both are in the cache index');

	// §5: the legacy copy moved over and the old cache is gone
	await A.page.evaluate(() => window.__stores.packCache.loadPackCacheIndex());
	const legacy = await A.page.evaluate(
		async (url) => ({
			old: await caches.has('tp-pack-files-v1'),
			held: !!(await window.__stores.packCache.cachedPackBuffer(url))
		}),
		LEGACY
	);
	h.check(
		!legacy.old && legacy.held,
		'§5 the 39 P5 CacheStorage copy moved into the asset cache and that cache is deleted'
	);

	// ---- §2 the question, once ----------------------------------------------------------------------
	const toast = A.page.locator('.tp-toast', { hasText: 'kept on this device' }).first();
	await toast.waitFor({ timeout: 10000 });
	h.check(true, '§2 the toast says why it wants to keep the cache');
	await toast.getByRole('button', { name: 'Keep them' }).click();
	await h.eventually(
		facts,
		(x) => x.persist === 1,
		'§2 "Keep them" asked navigator.storage.persist() once'
	);

	// ---- reload: the second load is served from OPFS ---------------------------------------------
	await A.page.waitForTimeout(800); // the index flush (400 ms debounce)
	await h.freshReload(A);
	await h.answerRestore(A).catch(() => {});
	const second = await A.page.evaluate(
		async ({ duck, sky }) => {
			const s = window.__stores;
			const a = await s.packCache.fetchPackBuffer(duck);
			const b = await s.assetCache.fetchCached(new URL(sky, document.baseURI).href, {
				kind: 'sky',
				version: 'e2e'
			});
			return { duck: a.byteLength, sky: b.byteLength, stats: s.assetCache.assetCacheStats() };
		},
		{ duck: DUCK, sky: SKY }
	);
	h.check(
		second.duck === DUCK_BYTES && second.sky === first.sky,
		'§1 the second load has the same bytes'
	);
	h.check(
		hits.duck === 1 && hits.sky === 1,
		`§1 the second load made NO request: pack ${hits.duck}, sky ${hits.sky} (total since boot)`
	);
	h.check(
		second.stats.hits >= 2 && second.stats.fetches === 0,
		`§1 both came from the cache (hits ${second.stats.hits}, fetches ${second.stats.fetches})`
	);
	await A.page.waitForTimeout(1500);
	f = await facts();
	h.check(
		f.persist === 1,
		'§2 persist() still asked exactly once after the reload (' + f.persist + ')'
	);
	h.check(
		(await A.page.locator('.tp-toast', { hasText: 'kept on this device' }).count()) === 0,
		'§2 and the toast does not come back'
	);

	// ---- §3 content only ----------------------------------------------------------------------------
	const shell = f.keys.filter((k) => /\.(js|css|html)(#|$)|\/_app\/|sw\.js|version\.json/.test(k));
	h.check(
		shell.length === 0,
		'§3 nothing of the app shell is in the cache (' + JSON.stringify(f.keys) + ')'
	);

	// ---- §4 Settings ▸ Storage -----------------------------------------------------------------------
	await A.page.evaluate(() => {
		window.__stores.settingsSection.set('storage');
		window.__stores.settingsOpen.set(true);
	});
	const usage = A.page.locator('#asset-cache-usage');
	await usage.waitFor({ timeout: 15000 });
	const text = await usage.innerText();
	h.check(
		/packs/.test(text) && /skies/.test(text) && /\d/.test(text),
		'§4 Settings ▸ Storage shows the use by kind: "' + text.slice(0, 90) + '…"'
	);
	await A.page.locator('#asset-cache-clear').click();
	await h.eventually(facts, (x) => x.keys.length === 0, '§4 Clear empties the index');
	const files = await A.page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const dir = await root.getDirectoryHandle('tp-asset-cache');
		const blobs = await dir.getDirectoryHandle('blobs');
		let n = 0;
		for await (const _ of blobs.keys()) n++;
		return n;
	});
	h.check(files === 0, '§4 and the OPFS blob files (' + files + ' left)');
	h.check(/Freed/.test(await usage.innerText()), '§4 it says what it freed');

	await h.finish(browser);
});

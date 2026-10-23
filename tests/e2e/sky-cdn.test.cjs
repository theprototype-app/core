// 59 T3 — THE BUNDLED SKIES COME FROM THE CDN, ONCE:
//   1. picking Meadow fetches `hdri/meadow_2_1k.hdr` from the packs base (not the app's origin)
//      exactly once, and the sky is ready
//   2. Cache Storage (`tp-skies-v1`) holds it; after a RELOAD picking Meadow again fetches nothing
//      (counterfactual: a sky never picked — Sunrise — IS fetched, so the counter is live)
//   3. CDN BLOCKED (fresh profile): Starlight shows the preset's FLAT colours — status
//      `unavailable`, no IBL on the scene, no error text, no page error — and back online it loads
//   4. against a BUILT app (export-manifest.json present): an export of a Meadow scene carries
//      `hdri/meadow_2_1k.hdr` byte-identical to the CDN's; on a dev server this part SKIPS
//
// The skies are served from a local packs checkout by h.routeSkies (SKIES_DIR, ../packs/hdri or a
// packs-lane-59-* worktree) — E2E_SKIES_CDN=1 lets them through to the real jsDelivr (post-tag).
// Deployed (PROD) builds: E2E_BLOCK_SW=1, or the service worker hides the requests from the route.
// Run: APP_URL=https://theprototype.app:5442/ npm run e2e -- sky-cdn
const h = require('./helpers.cjs');

const GET = `(s) => { let v; s.subscribe((x) => (v = x))(); return v; }`;
/** @param {any} page */
const status = (page) => page.evaluate(`(${GET})(window.__stores.hdriStores.hdriStatus)`);
/** @param {any} page */
const sceneSky = (page) =>
	page.evaluate(`(() => {
		const get = ${GET};
		const st = window.__stores;
		const scene = get(st.globalScene);
		return {
			environment: scene.environment?.name ?? null,
			background: scene.background?.isColor ? '#' + scene.background.getHexString() : (scene.background?.name ?? null),
			flat: st.environment.presetPayload().background ?? null
		};
	})()`);
/** @param {any} page @param {string} key */
const pick = (page, key) => page.evaluate((k) => window.__stores.environment.setEnvironment(k), key);
/** @param {any} page */
const settle = (page) => page.evaluate(() => window.__stores.hdri.hdriDebug.settle());

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const opts = { context: { viewport: { width: 1280, height: 720 } } };
	const A = await h.setupPage(browser, 'A', opts);
	const skies = await h.routeSkies(A.page);
	console.log(`skies from ${process.env.E2E_SKIES_CDN ? 'the real CDN' : (skies.dir ?? 'the real CDN (no local packs checkout)')}`);
	const base = await A.page.evaluate(() => window.__stores.hdriSky.SKY_BASE);
	const appOrigin = new URL(h.URL).origin;

	// ---- 1. first pick downloads --------------------------------------------------------------
	h.check(skies.count() === 0, `no sky is fetched at boot (${skies.count()})`);
	await pick(A.page, 'meadow');
	h.check((await settle(A.page)) === 'ready', 'Meadow is ready');
	h.check(skies.count() === 1, `Meadow was fetched once (${skies.count()}: ${skies.hits.join(', ')})`);
	const url = skies.hits[0] ?? '';
	h.check(url === base + '/hdri/meadow_2_1k.hdr' && !url.startsWith(appOrigin), `from the packs base, not the app (${url})`);
	const sky = await sceneSky(A.page);
	h.check(sky.environment === 'hdri:bundled:meadow|full', `the HDRI lights the scene (${sky.environment})`);
	const appHdr = await A.page.evaluate(async () => (await fetch(new URL('hdri/meadow_2_1k.hdr', document.baseURI))).status);
	h.check(appHdr === 404 || appHdr >= 400, `the app itself no longer serves hdri/*.hdr (HTTP ${appHdr})`);

	// ---- 2. Cache Storage keeps it across a reload -------------------------------------------
	const cached = await A.page.evaluate(() => window.__stores.hdriSky.cachedSkies());
	h.check(cached.includes(url), `Cache Storage holds the sky (${cached.join(', ')})`);
	await h.freshReload(A);
	await h.answerRestore(A);
	await A.page.evaluate(() => window.__stores.environment.setEnvironment('studio'));
	await pick(A.page, 'meadow');
	h.check((await settle(A.page)) === 'ready', 'after a reload Meadow is ready again');
	h.check(skies.count() === 1, `…and was NOT fetched again (${skies.count()} sky requests in all)`);
	await pick(A.page, 'sunrise');
	h.check((await settle(A.page)) === 'ready', 'Sunrise is ready');
	h.check(skies.count() === 2 && /\/hdri\/spruit_sunrise_1k\.hdr$/.test(skies.hits[1] ?? ''), `counterfactual: a sky never picked IS fetched (${skies.count()})`);

	// ---- 4. an export embeds the chosen sky (built app only) ---------------------------------
	await pick(A.page, 'meadow');
	await settle(A.page);
	const exp = await A.page.evaluate(async () => {
		const b = window.__stores.exportBuilder;
		try {
			await b.loadExportManifest();
		} catch (e) {
			return { skip: String(e?.message ?? e), zip: '', cdn: '' };
		}
		const b64 = (/** @type {Uint8Array} */ buf) => {
			let s = '';
			for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
			return btoa(s);
		};
		const out = await b.buildExport({ preset: 'static', title: 'Sky check', thumbnail: false, startFullscreen: false, showFps: false, quality: 'auto', vrButton: false, useCdnForPacks: false });
		const cdn = new Uint8Array(await (await fetch(window.__stores.hdriSky.skyUrl('hdri/meadow_2_1k.hdr'))).arrayBuffer());
		return { skip: '', zip: b64(new Uint8Array(await out.blob.arrayBuffer())), cdn: b64(cdn) };
	});
	if (exp.skip) console.log('SKIP export check (not a built app): ' + exp.skip);
	else {
		const { unzipSync } = require('fflate');
		const files = unzipSync(new Uint8Array(Buffer.from(exp.zip, 'base64')));
		const hdr = files['hdri/meadow_2_1k.hdr'];
		const cdn = Buffer.from(exp.cdn, 'base64');
		h.check(!!hdr && Buffer.compare(Buffer.from(hdr), cdn) === 0, `the export carries hdri/meadow_2_1k.hdr byte-identical to the CDN's (${hdr?.length ?? 0} bytes)`);
		const others = Object.keys(files).filter((n) => /\.hdr$/.test(n) && n !== 'hdri/meadow_2_1k.hdr');
		h.check(others.length === 0, `…and no other sky (${others.join(', ') || 'none'})`);
	}
	await A.ctx.close();

	// ---- 3. CDN blocked: the flat preset, no error -------------------------------------------
	const B = await h.setupPage(browser, 'B', opts);
	const blocked = await h.routeSkies(B.page, { block: true });
	await pick(B.page, 'starlight');
	h.check((await settle(B.page)) === 'unavailable', `CDN blocked: the sky is unavailable, not an error (${(await status(B.page)).state})`);
	h.check(blocked.count() >= 1, `the sky was asked for (${blocked.count()})`);
	const flat = await sceneSky(B.page);
	h.check(flat.environment === null, `no HDRI on the scene (${flat.environment})`);
	h.check(!!flat.flat && flat.background === String(flat.flat).toLowerCase(), `the preset's flat sky shows (${flat.background} = ${flat.flat})`);
	const st = await status(B.page);
	h.check(st.error === '', `no error recorded (${JSON.stringify(st.error)})`);
	h.check(h.pageErrors(B).length === 0, `no page error (${h.pageErrors(B).join(' | ')})`);
	// back online: the next `online` event loads it
	await B.page.unrouteAll({ behavior: 'ignoreErrors' });
	const back = await h.routeSkies(B.page);
	await B.page.evaluate(() => window.dispatchEvent(new Event('online')));
	await h.eventually(() => status(B.page), (v) => v.state === 'ready' && v.src === 'bundled:starlight', 'back online, Starlight loads', 20000);
	h.check(back.count() === 1, `…with one fetch (${back.count()})`);

	await h.finish(browser);
});

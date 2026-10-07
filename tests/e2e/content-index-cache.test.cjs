// 1.19.1: the General tab / packs / module gallery kept a WEEK-OLD list.
//
// jsDelivr answers a branch ref (`scenes@format-2`, `packs@format-1`, `modules@format-1`)
// with `cache-control: public, max-age=604800`, and every index fetch used the default
// cache mode — so after 1.19.0 shipped three new General levels, any device that had
// opened the tab in the last week kept showing the old list (a fresh browser saw the new
// one, which is why the release's production proof passed).
//
// page.route CANNOT test this: Playwright turns the HTTP cache off while routing is on.
// So this suite runs a REAL local HTTPS "CDN" and points the browser's cdn.jsdelivr.net
// at it (--host-resolver-rules), trusting its throwaway cert by SPKI pin — a pinned cert
// is VALID, not an ignored error, and Chromium does not cache responses with cert
// errors. The app's own code fetches its own SCENES_BASE/PACKS_BASE/MODULES_BASE
// untouched. Every response carries jsDelivr's real headers (max-age=604800 + ETag, 304
// on If-None-Match); paths this suite does not own pass through to the real CDN.
//
// Sections: 1 seed the old lists through the real UI · 2 PREMISE: the browser really
// holds the old copy (a default-mode fetch after the swap still reads v1) · 3 a tab that
// outlived a deploy re-fetches once updateCheck marks content stale · 4 the app opened
// again (a new tab, same browser cache) shows the NEW lists · 5 revalidation is cheap
// (an unchanged index is a 304).
const h = require('./helpers.cjs');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_AGE = 'public, max-age=604800, s-maxage=43200'; // what jsDelivr sends for a branch ref

h.run(async () => {
	// -- a throwaway cert for cdn.jsdelivr.net and its SPKI pin
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-cdn-cache-'));
	try {
		execFileSync(
			'openssl',
			['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', dir + '/key.pem', '-out', dir + '/cert.pem', '-days', '2', '-subj', '/CN=cdn.jsdelivr.net', '-addext', 'subjectAltName=DNS:cdn.jsdelivr.net'],
			{ stdio: 'ignore' }
		);
	} catch {
		console.log('SKIP: openssl is not available to mint the local CDN certificate');
		return;
	}
	const crypto = require('crypto');
	const publicKey = crypto.createPublicKey(fs.readFileSync(dir + '/cert.pem'));
	const spki = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64');

	// -- the served content, by version. v1 = what the device saw last week.
	let version = 1;
	const level = (slug, title) => ({ slug, title, description: title, scene: 'templates/' + slug + '/scene.tpscene', license: 'CC0-1.0' });
	const scenesIndex = () => ({
		version: 2,
		templates: [
			level('cache-old-level', 'Cache Old Level'),
			...(version >= 2 ? [level('cache-new-level', 'Cache New Level')] : []),
			...(version >= 3 ? [level('cache-newer-level', 'Cache Newer Level')] : [])
		],
		examples: [],
		games: []
	});
	const kit = (name) => ({ name, title: name, value: name + '/list.json' });
	const packsIndex = () => [kit('cache-old-kit'), ...(version >= 2 ? [kit('cache-new-kit')] : []), ...(version >= 3 ? [kit('cache-newer-kit')] : [])];
	const item = (name) => ({ name, variants: { 'glTF-Binary': name + '.glb' } });
	// the old kit GROWS an item in place per version (a kit's item list is a list too)
	const kitList = () => Array.from({ length: version }, (_, i) => item('piece-' + (i + 1)));
	const mod = (id) => ({ id, name: id, version: '1.0.0', source: id });
	const galleryIndex = () => [mod('cache-old-mod'), ...(version >= 2 ? [mod('cache-new-mod')] : []), ...(version >= 3 ? [mod('cache-newer-mod')] : [])];

	// the lists this CDN owns, by REPO (any ref), claimed before the app boots so even the
	// boot-time packs fetch is ours; everything else passes through
	/** @type {[RegExp, () => any][]} */
	const OWNED = [
		[/^\/gh\/theprototype-app\/scenes@[^/]+\/index\.json$/, () => scenesIndex()],
		[/^\/gh\/theprototype-app\/packs@[^/]+\/index\.json$/, () => packsIndex()],
		[/^\/gh\/theprototype-app\/packs@[^/]+\/cache-old-kit\/list\.json$/, () => kitList()],
		[/^\/gh\/theprototype-app\/modules@[^/]+\/index\.json$/, () => galleryIndex()]
	];
	const SCENES_INDEX = OWNED[0][0];
	/** every request for an owned path: {path, conditional, status} */
	const hits = /** @type {{path: string, conditional: boolean, status: number}[]} */ ([]);
	const server = https.createServer({ key: fs.readFileSync(dir + '/key.pem'), cert: fs.readFileSync(dir + '/cert.pem') }, async (req, res) => {
		const p = (req.url || '').split('?')[0];
		const make = OWNED.find(([re]) => re.test(p))?.[1];
		if (!make) {
			// not ours (the app may load other things off jsDelivr): pass through to the real CDN
			try {
				const upstream = await fetch('https://cdn.jsdelivr.net' + req.url);
				const headers = {};
				for (const k of ['content-type', 'cache-control', 'etag', 'access-control-allow-origin']) {
					const v = upstream.headers.get(k);
					if (v) headers[k] = v;
				}
				res.writeHead(upstream.status, headers);
				res.end(Buffer.from(await upstream.arrayBuffer()));
			} catch {
				res.writeHead(502, { 'access-control-allow-origin': '*' });
				res.end();
			}
			return;
		}
		const body = JSON.stringify(make());
		const etag = '"' + crypto.createHash('sha1').update(body).digest('hex') + '"';
		const headers = { 'access-control-allow-origin': '*', 'cache-control': MAX_AGE, etag, 'content-type': 'application/json; charset=utf-8' };
		const conditional = !!req.headers['if-none-match'];
		if (req.headers['if-none-match'] === etag) {
			hits.push({ path: p, conditional, status: 304 });
			res.writeHead(304, headers);
			return res.end();
		}
		hits.push({ path: p, conditional, status: 200 });
		res.writeHead(200, headers);
		res.end(body);
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const port = /** @type {any} */ (server.address()).port;

	const browser = await h.launch({
		args: ['--host-resolver-rules=MAP cdn.jsdelivr.net 127.0.0.1:' + port, '--ignore-certificate-errors-spki-list=' + spki]
	});
	try {
		const A = await h.setupPage(browser, 'A');
		const bases = await A.page.evaluate(() => ({
			scenes: window.__stores.sceneTemplates.SCENES_BASE,
			packs: window.__stores.packs.PACKS_BASE,
			modules: window.__stores.moduleGallery.MODULES_BASE
		}));
		console.log('bases: ' + JSON.stringify(bases));
		const onCdn = (/** @type {string} */ base) => base.startsWith('https://cdn.jsdelivr.net/gh/theprototype-app/');
		if (!onCdn(bases.scenes) || !onCdn(bases.packs) || !onCdn(bases.modules)) {
			console.log('SKIP: this build points a content base off jsDelivr (VITE_*_BASE set) — nothing here to cache-test');
			await browser.close();
			return;
		}

		/** the General tab's remote slugs, through the real modal */
		async function openGeneral(/** @type {any} */ page) {
			await page.evaluate(() => window.__stores.templatesModalOpen.set(false));
			await page.waitForTimeout(200);
			await page.locator('#logo-menu').click();
			await page.waitForTimeout(300);
			await page.locator('#open-templates').click();
			await page.waitForTimeout(400);
		}
		const generalSlugs = (/** @type {any} */ page) =>
			page.evaluate(() =>
				[...document.querySelectorAll('#templates-modal [data-scene-slug]')].map((e) => e.getAttribute('data-scene-slug')).filter((s) => s?.startsWith('cache-'))
			);
		const readStore = (/** @type {any} */ page, /** @type {string} */ expr) =>
			page.evaluate((expr) => {
				const store = expr.split('.').reduce((o, k) => o[k], window.__stores);
				let v;
				store.subscribe((x) => (v = x))();
				return v;
			}, expr);
		const packNames = async (/** @type {any} */ page) => (await readStore(page, 'packs.packs')).map((/** @type {any} */ p) => p.name).filter((n) => n.startsWith('cache-'));
		const kitItemCount = (/** @type {any} */ page) =>
			page.evaluate(async () => {
				const s = window.__stores.packs;
				let list = [];
				s.packs.subscribe((x) => (list = x))();
				const pack = list.find((p) => p.name === 'cache-old-kit');
				return pack ? (await s.loadPackItems(pack)).length : -1;
			});
		const galleryIds = async (/** @type {any} */ page) => {
			await page.evaluate(() => window.__stores.moduleGallery.loadModuleGallery());
			return (await readStore(page, 'moduleGallery.galleryModules')).map((/** @type {any} */ m) => m.id).filter((n) => n.startsWith('cache-'));
		};

		// -- 1: seed last week's lists through the real UI (Explorer loads the packs list
		// when it mounts; ask once more so the read does not depend on that timing)
		await A.page.evaluate(() => window.__stores.packs.loadPacks());
		await openGeneral(A.page);
		await h.eventually(() => generalSlugs(A.page), (v) => JSON.stringify(v) === '["cache-old-level"]', '1: General shows the v1 list (Cache Old Level only)');
		h.check(JSON.stringify(await packNames(A.page)) === '["cache-old-kit"]', '1: packs list = v1 (cache-old-kit)');
		h.check((await kitItemCount(A.page)) === 1, '1: the old kit lists 1 item');
		h.check(JSON.stringify(await galleryIds(A.page)) === '["cache-old-mod"]', '1: module gallery = v1 (cache-old-mod)');
		h.check(hits.some((x) => SCENES_INDEX.test(x.path)), '1: premise — the app read the scenes index from the local CDN');

		// -- 2: PREMISE. The release happens; the browser still holds v1 for a week. Without
		// this, section 4 would be green on a browser that never cached anything.
		version = 2;
		const defaultMode = await A.page.evaluate(async (url) => (await (await fetch(url)).json()).templates.map((/** @type {any} */ t) => t.slug), bases.scenes + '/index.json');
		h.check(JSON.stringify(defaultMode) === '["cache-old-level"]', '2: premise — a default-mode fetch after the swap still reads the CACHED v1 (got ' + JSON.stringify(defaultMode) + ')');

		// -- 3: the same tab, across the deploy. The per-session memo keeps v1 until an app
		// update is noticed (updateCheck -> markContentStale); then reopening re-fetches.
		await openGeneral(A.page);
		await A.page.waitForTimeout(600);
		h.check(JSON.stringify(await generalSlugs(A.page)) === '["cache-old-level"]', '3: before the update notice the memo still shows v1 (no refetch on every open)');
		const marked = await A.page.evaluate(async () => {
			// import the URL the APP imported: after an HMR vite rewrites importers to
			// `contentBase.js?t=…`, and a bare path would bind a SECOND instance with no
			// handlers registered (the resource-timing buffer is too small to list it)
			const importer = await (await fetch('/src/lib/sceneTemplates.js')).text();
			const url = importer.match(/["'](\/src\/lib\/contentBase\.js(?:\?[^"']*)?)["']/)?.[1] ?? '/src/lib/contentBase.js';
			const m = await import(url);
			if (typeof m.markContentStale !== 'function') return false;
			m.markContentStale();
			return true;
		});
		h.check(marked, '3: contentBase.markContentStale exists (what updateCheck calls on a new version)');
		await openGeneral(A.page);
		await h.eventually(() => generalSlugs(A.page), (v) => JSON.stringify(v) === '["cache-old-level","cache-new-level"]', '3: after the update notice, reopening General shows v2 (Cache New Level)');
		h.check(JSON.stringify(await galleryIds(A.page)) === '["cache-old-mod","cache-new-mod"]', '3: after the update notice, Browse re-fetches v2 (no force)');
		h.check((await kitItemCount(A.page)) === 2, '3: after the update notice, the old kit re-fetches its grown item list (2)');

		// -- 4: the device opens the app again (a new tab, SAME browser cache) after the next
		// release: every list is the new one — this is the owner's bug.
		version = 3;
		const B = await A.ctx.newPage();
		await B.goto(h.URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
		await B.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 30000 });
		await B.waitForTimeout(1500);
		await openGeneral(B);
		await h.eventually(
			() => generalSlugs(B),
			(v) => JSON.stringify(v) === '["cache-old-level","cache-new-level","cache-newer-level"]',
			'4: a reopened app shows the NEW General list (Cache Newer Level) despite max-age=604800'
		);
		await h.eventually(() => packNames(B), (v) => JSON.stringify(v) === '["cache-old-kit","cache-new-kit","cache-newer-kit"]', '4: the packs list is the new one (cache-newer-kit)');
		h.check((await kitItemCount(B)) === 3, '4: the old kit lists its 3 items');
		h.check(JSON.stringify(await galleryIds(B)) === '["cache-old-mod","cache-new-mod","cache-newer-mod"]', '4: the module gallery is the new one (cache-newer-mod)');

		// -- 5: revalidation, not re-download: the index was asked conditionally, and an
		// unchanged one comes back 304
		const before = hits.length;
		await B.evaluate(() => window.__stores.sceneTemplates.loadTemplatesIndex(true));
		const after = hits.slice(before).filter((x) => SCENES_INDEX.test(x.path));
		h.check(after.length === 1 && after[0].conditional && after[0].status === 304, '5: an unchanged index revalidates to a 304 (got ' + JSON.stringify(after) + ')');
		h.check(hits.filter((x) => SCENES_INDEX.test(x.path) && x.conditional).length >= 2, '5: the scenes index was revalidated with If-None-Match, not re-downloaded blind');
		await B.close();
	} finally {
		server.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
	return h.finish(browser);
});

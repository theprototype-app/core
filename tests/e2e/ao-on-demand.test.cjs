// 102-boot-diet-2 (Row 2) — AMBIENT OCCLUSION LOADS ON DEMAND. n8ao (N8AOPostPass, ~75 KB gz: most of it an
// inlined noise texture) was on the boot of both pages through postEffects.js. It is a lazy chunk now: Outline
// starts the fetch as soon as the WARMED post stack would draw AO (the 10-frame warm-up already kept the first
// frames without post), the compile skips the AO entry until it lands, and `n8aoReady` recompiles the chain once.
//
//   0. the build: n8ao is its own chunk and in NEITHER page's static boot closure;            (built app)
//   1. a player in plain Shaded never fetches it (/play, view mode 'shaded');                (built app)
//   2. the desktop editor (default Shaded + AO) fetches it AFTER its first paint;            (built app)
//   3. a page that starts in Shaded has no AO pass and fetched nothing; switching to Shaded + AO fetches it and the
//      chain is rebuilt WITH the AO pass; Shaded drops it again and Shaded + AO brings it back (no refetch).
// Counterfactual (v1.78.0): n8ao is in a boot chunk of both pages — 0, 1 and 3's "fetched nothing" are red.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const { check } = h;
const ROOT = path.resolve(__dirname, '../..');
const MANIFEST = path.join(ROOT, '.svelte-kit/output/client/.vite/manifest.json');

/** a fresh context without the debug hooks; every request's path */
async function plainPage(browser, query, storage = {}) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
	await ctx.addInitScript((s) => {
		try {
			localStorage.setItem('hasSeenDisclaimer', 'true');
			localStorage.setItem('hasSeenWelcome', 'true');
			for (const [k, v] of Object.entries(s)) localStorage.setItem(k, String(v));
		} catch {
			/* no storage */
		}
	}, storage);
	const page = await ctx.newPage();
	/** @type {string[]} */
	const requests = [];
	page.on('request', (r) => requests.push(new globalThis.URL(r.url()).pathname));
	const res = await page.goto(h.URL + query, { waitUntil: 'domcontentloaded', timeout: 90000 });
	return { ctx, page, requests, status: res?.status() ?? 0 };
}

h.run(async () => {
	const html = await new Promise((resolve) => {
		const mod = h.URL.startsWith('https:') ? require('https') : require('http');
		mod.get(h.URL, { rejectUnauthorized: false }, (res) => {
			let body = '';
			res.on('data', (c) => (body += c));
			res.on('end', () => resolve(body));
		}).on('error', () => resolve(''));
	});
	const built = /_app\/immutable\//.test(html) && !/@vite\/client/.test(html) && fs.existsSync(MANIFEST);
	const browser = await h.launch();
	/** the n8ao request test: the chunk's path on a build, the module path on a dev server */
	let isN8ao = (/** @type {string} */ p) => /n8ao/i.test(p);

	if (!built) console.log('SKIP 0-2: not a built app (npm run build, then serve it with scripts/serve-build.cjs)');
	else {
		const bs = require('../../scripts/boot-size.cjs');
		const m = bs.loadManifest();
		const key = Object.keys(m.m).find((k) => /node_modules\/n8ao\//.test(k));
		const file = key ? m.m[key].file : null;
		check(!!file && fs.existsSync(path.join(ROOT, 'build', file)), `0a n8ao is a chunk of its own in build/ (${file})`);
		for (const [name, htmlFile] of [['play', 'play.html'], ['editor', 'index.html']]) {
			const r = bs.measurePage(htmlFile, m);
			check(!!file && !(file in r.chunks), `0b the ${name} page's boot does not carry it (${(r.jsGz / 1024).toFixed(1)} KB gz)`);
		}
		const chunk = '/' + file;
		isN8ao = (p) => p === chunk;

		const P = await plainPage(browser, 'play', { viewMode: 'shaded' });
		check(P.status === 200, `1a /play answers 200 (${P.status})`);
		await P.page.waitForFunction(() => !!window.tpPlay, null, { timeout: 90000 });
		const ready = await P.page.evaluate(() => Promise.race([window.tpPlay.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 90000))]));
		check(ready, '1b /play renders a first frame');
		await P.page.waitForTimeout(8000);
		check(!P.requests.some(isN8ao), `1c a player in plain Shaded never fetched N8AO (${P.requests.filter(isN8ao).length})`);
		await P.ctx.close();

		const E = await plainPage(browser, '');
		const t = await E.page.evaluate(async (c) => {
			const deadline = performance.now() + 60000;
			let entry = null;
			while (performance.now() < deadline && !(entry = performance.getEntriesByType('resource').find((e) => new URL(e.name).pathname === c))) await new Promise((r) => setTimeout(r, 250));
			const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
			return { start: entry ? entry.startTime : null, duration: entry ? entry.duration : null, fcp };
		}, chunk);
		check(t.start != null, `2a the desktop editor (Shaded + AO) fetched it (${t.start == null ? 'never' : Math.round(t.start) + ' ms'})`);
		check(t.fcp != null && t.start != null && t.start > t.fcp, `2b ...after its first contentful paint (fcp ${t.fcp == null ? '?' : Math.round(t.fcp)} ms, fetch ${t.start == null ? '?' : Math.round(t.start)} ms, ${t.duration == null ? '?' : Math.round(t.duration)} ms long)`);
		await E.ctx.close();
	}

	// ---- 3. on a page that starts in plain Shaded -------------------------------------------------------
	const A = await h.setupPage(browser, 'A', { storage: { viewMode: 'shaded' } });
	/** @type {string[]} */
	const later = [];
	A.page.on('request', (r) => later.push(new globalThis.URL(r.url()).pathname));
	const chain = () => A.page.evaluate(() => window.__postDebug?.().chain ?? []);
	await A.page.waitForFunction(() => typeof window.__postDebug === 'function', null, { timeout: 30000 }).catch(() => {});
	await A.page.waitForTimeout(3000); // past the 10-frame warm-up
	const before = await chain();
	check(!before.some((p) => /\bao\b/.test(p)), `3a starting in Shaded: no AO pass (${before.join(' > ')})`);
	const n8aoEarly = await A.page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /n8ao/i.test(e.name)).length);
	if (!built) check(n8aoEarly === 0, `3b ...and the N8AO module was never fetched (${n8aoEarly})`);
	else check(!later.some(isN8ao), '3b ...and the N8AO chunk was not fetched since the page settled');

	await A.page.evaluate(() => window.__tp.test.v1.viewMode.set('shaded-ao'));
	await A.page.waitForFunction(() => (window.__postDebug?.().chain ?? []).some((p) => /\bao\b/.test(p)), null, { timeout: 30000 }).catch(() => {});
	const withAo = await chain();
	check(withAo.some((p) => /\bao\b/.test(p)), `3c Shaded + AO: the chain is rebuilt WITH the AO pass once it loads (${withAo.join(' > ')})`);

	await A.page.evaluate(() => window.__tp.test.v1.viewMode.set('shaded'));
	await A.page.waitForTimeout(800);
	const off = await chain();
	check(!off.some((p) => /\bao\b/.test(p)), `3d back to Shaded: the AO pass is gone (${off.join(' > ')})`);
	const fetchesBefore = later.filter(isN8ao).length;
	await A.page.evaluate(() => window.__tp.test.v1.viewMode.set('shaded-ao'));
	await A.page.waitForFunction(() => (window.__postDebug?.().chain ?? []).some((p) => /\bao\b/.test(p)), null, { timeout: 10000 }).catch(() => {});
	const again = await chain();
	check(again.some((p) => /\bao\b/.test(p)) && later.filter(isN8ao).length === fetchesBefore, `3e Shaded + AO again: AO is back with no second fetch (${again.join(' > ')})`);
	check(!(A.page.__errors ?? []).length, `3f no page errors (${(A.page.__errors ?? []).slice(0, 2).join(' | ')})`);
	await h.closePeer(A);
	await h.finish(browser);
});

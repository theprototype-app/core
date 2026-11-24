// 102-boot-diet-2 (phase 2) — THE MESH EDITOR'S FACE / EDGE HALF LOADS ON DEMAND. src/lib/faceEdit.js
// (~30 KB gz) left BOTH boots: the boot keeps faceEditState.js (stores, prefs, registries), meshGeoApply.js
// (a peer's / an undo's geometry swap) and meshSoup.js (the triangle helpers); faceEditLazy.js loads the rest.
//
// What this suite holds (BUILT app: `npm run build`, served by scripts/serve-build.cjs):
//   0. the build: faceEdit is its own chunk and is in NEITHER page's static boot closure (play.html, index.html);
//   1. a player never fetches it: `/play` boots, renders, idles, and the chunk is not requested;
//   2. the editor fetches it AFTER its first paint (the idle prefetch), so the first double-click is not a
//      download — and reports the fetch time, the worst-case first-use delay;
//   3. every way into a session still works the same tick it is called (the chunk is loaded on a test page):
//      a double-click with "Edit mesh" set, the vertex mode, a custom-collider session; and leaving them.
// Counterfactual (v1.78.0): faceEdit sits in a boot chunk of both pages — 0, 1 and 2's "after first paint" are red.
// Dev server: 0-2 SKIP (a dev server serves modules, not chunks); 3 runs.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const { check } = h;
const ROOT = path.resolve(__dirname, '../..');
const MANIFEST = path.join(ROOT, '.svelte-kit/output/client/.vite/manifest.json');
const read = `(s) => { let v; s.subscribe((x) => (v = x))(); return v; }`;

/** a fresh context without the debug hooks (they load faceEdit on purpose); every request's path + time */
async function plainPage(browser, query) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
	await ctx.addInitScript(() => {
		try {
			// the Resource Timing buffer (250) is full long before a lazy chunk loads: make the fetch visible
			performance.setResourceTimingBufferSize?.(200000);
			localStorage.setItem('hasSeenDisclaimer', 'true');
			localStorage.setItem('hasSeenWelcome', 'true');
		} catch {
			/* no storage */
		}
	});
	const page = await ctx.newPage();
	/** @type {{path: string, at: number}[]} */
	const requests = [];
	const t0 = Date.now();
	page.on('request', (r) => requests.push({ path: new globalThis.URL(r.url()).pathname, at: Date.now() - t0 }));
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

	if (!built) console.log('SKIP 0-2: not a built app (npm run build, then serve it with scripts/serve-build.cjs)');
	else {
		// ---- 0. the build -----------------------------------------------------------------------------------
		const bs = require('../../scripts/boot-size.cjs');
		const m = bs.loadManifest();
		// a dynamic entry when only import() reaches it; a shared chunk named after it when the lazy meshBoolean /
		// meshPaint import it statically too (the build does that) -- either way ONE file holds faceEdit
		const rec = m.m['src/lib/faceEdit.js'] ?? Object.values(m.m).find((r) => r.name === 'faceEdit' && !r.isEntry);
		const file = rec?.file;
		check(!!file && fs.existsSync(path.join(ROOT, 'build', file)), `0a faceEdit.js is a chunk of its own in build/ (${file})`);
		for (const [name, htmlFile] of [['play', 'play.html'], ['editor', 'index.html']]) {
			const r = bs.measurePage(htmlFile, m);
			check(!!file && !(file in r.chunks), `0b the ${name} page's boot does not carry it (${Object.keys(r.chunks).length} boot chunks, ${(r.jsGz / 1024).toFixed(1)} KB gz)`);
		}
		const chunk = '/' + file;

		// ---- 1. a player never fetches it -------------------------------------------------------------------
		const P = await plainPage(browser, 'play');
		check(P.status === 200, `1a /play answers 200 (${P.status})`);
		await P.page.waitForFunction(() => !!window.tpPlay, null, { timeout: 90000 });
		const ready = await P.page.evaluate(() => Promise.race([window.tpPlay.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 90000))]));
		check(ready, '1b /play renders a first frame');
		await P.page.waitForTimeout(8000); // past any idle callback
		const playHits = P.requests.filter((r) => r.path === chunk);
		check(playHits.length === 0, `1c /play never fetched the face editor (${playHits.length} requests in ${P.requests.length})`);
		await P.ctx.close();

		// ---- 2. the editor fetches it after its first paint -------------------------------------------------
		const E = await plainPage(browser, '');
		check(E.status === 200, `2a the editor answers 200 (${E.status})`);
		const t = await E.page.evaluate(async (c) => {
			const deadline = performance.now() + 60000;
			let entry = null;
			while (performance.now() < deadline && !(entry = performance.getEntriesByType('resource').find((e) => new URL(e.name).pathname === c))) await new Promise((r) => setTimeout(r, 250));
			const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
			return entry ? { start: entry.startTime, duration: entry.duration, fcp } : { start: null, duration: null, fcp };
		}, chunk);
		check(t.start != null, `2b the idle prefetch fetched it (${t.start == null ? 'never' : Math.round(t.start) + ' ms after navigation'})`);
		check(t.fcp != null && t.start != null && t.start > t.fcp, `2c ...AFTER the first contentful paint (fcp ${t.fcp == null ? '?' : Math.round(t.fcp)} ms, fetch start ${t.start == null ? '?' : Math.round(t.start)} ms)`);
		console.log(`face editor chunk fetch: ${t.duration == null ? '?' : Math.round(t.duration)} ms (the worst-case first-use delay on this machine)`);
		await E.ctx.close();
	}

	// ---- 3. the ways into a session (debug page: the hook loads the module) ------------------------------
	const A = await h.setupPage(browser, 'A');
	const box = await A.page.evaluate(async () => {
		const w = window.__tp.test.v1;
		w.commandsHandler.sceneCommand('/create box 1 1 1');
		await new Promise((r) => setTimeout(r, 600));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const o = g.children[g.children.length - 1];
		o.position.set(0, 0, 0);
		w.objectsGroup.update((v) => v);
		w.objectActions.deselectObject();
		return { uuid: o.uuid };
	});
	check(!!box.uuid, 'premise: a box in the scene');

	await A.page.evaluate(() => window.__tp.test.v1.selectionPrefs.doubleClickAction.set('meshedit'));
	const point = await h.projectPoint(A.page, [0, 0, 0]);
	await A.page.mouse.click(point.x, point.y);
	await A.page.waitForTimeout(90);
	await A.page.mouse.click(point.x, point.y);
	await A.page.waitForFunction(`(${read})(window.__tp.test.v1.faceEdit.faceEditObject) !== null`, null, { timeout: 5000 }).catch(() => {});
	const face = await A.page.evaluate(`(${read})(window.__tp.test.v1.faceEdit.faceEditObject)`);
	check(face === box.uuid, `3a a double-click with "Edit mesh" set opens the face editor on the box (${face})`);

	const sync = await A.page.evaluate((uuid) => {
		const w = window.__tp.test.v1;
		const r = /** @type {any} */ ({});
		const val = (s) => {
			let v;
			s.subscribe((x) => (v = x))();
			return v;
		};
		w.faceEdit.exitFaceEdit();
		r.exited = val(w.faceEdit.faceEditObject) === null;
		// vertex mode: entered the same tick it is called (the module is loaded)
		w.meshEdit.enterEditMode(uuid);
		r.vertex = val(w.meshEdit.editingObject);
		w.meshEdit.exitEditMode();
		// a custom-collider session runs the real face editor on a proxy: true, not a Promise
		const entered = w.colliderEdit.enterColliderEdit(uuid);
		r.collider = entered === true;
		r.colliderFace = !!val(w.faceEdit.faceEditObject);
		w.colliderEdit.exitColliderEdit(false);
		r.colliderOut = val(w.faceEdit.faceEditObject) === null;
		return r;
	}, box.uuid);
	check(sync.exited, '3b leaving the face editor clears the session');
	check(sync.vertex === box.uuid, `3c the vertex mode opens the same tick it is called (${sync.vertex})`);
	check(sync.collider && sync.colliderFace, `3d a custom-collider session opens synchronously (${JSON.stringify(sync)})`);
	check(sync.colliderOut, '3e ...and closes');
	check(A.page.__errors?.length ? false : true, `3f no page errors (${(A.page.__errors ?? []).slice(0, 2).join(' | ')})`);
	await h.closePeer(A);
	await h.finish(browser);
});

// The import-wild page: shared by tests/e2e/import-wild.test.cjs and tools/bench/wild-assets-app.cjs.
//   · the dev server is WARMED first (a cold vite SSR answers the first goto with a dependency
//     re-optimise reload — net::ERR_ABORTED — which killed the first app-bench run), and the
//     first navigation is retried once on ERR_ABORTED;
//   · the fixtures are served on the app's own origin (no CORS) from the cache, by route;
//   · every dialog is answered from a table (anything unexpected is cancelled) and LOGGED to the
//     console, so the node side still knows what the page was asked if the tab crashes;
//   · `crashed` says whether the renderer died (a 7M-triangle file can take the tab with it).
const fs = require('fs');
const https = require('https');
const h = require('./helpers.cjs');

/** GET the app until it answers 200 twice (SSR compiled), at most `ms` @param {string} url @param {number} ms */
async function warm(url, ms = 180000) {
	const t0 = Date.now();
	let ok = 0;
	while (Date.now() - t0 < ms && ok < 2) {
		const status = await new Promise((resolve) => {
			const req = https.get(url, { rejectUnauthorized: false, timeout: 60000 }, (res) => {
				res.resume();
				res.on('end', () => resolve(res.statusCode));
			});
			req.on('error', () => resolve(0));
			req.on('timeout', () => {
				req.destroy();
				resolve(0);
			});
		});
		if (status === 200) ok++;
		else await new Promise((r) => setTimeout(r, 2000));
	}
	return ok >= 2;
}

/**
 * A ready page: warmed server, routes, the dialog answerer.
 * @param {any} browser @param {(rel: string) => string | null} locate @param {Record<string, string | false>} answers
 * @param {any} [options] setupPage options
 */
async function openWildPage(browser, locate, answers, options = {}) {
	await warm(h.URL);
	/** @type {any} */
	let A;
	try {
		A = await h.setupPage(browser, 'A', options);
	} catch (error) {
		if (!/ERR_ABORTED/.test(String(/** @type {any} */ (error)?.message))) throw error;
		console.log('  (first navigation aborted by a dev-server reload — retrying once)');
		await new Promise((r) => setTimeout(r, 5000));
		A = await h.setupPage(browser, 'A', options);
	}
	A.crashed = false;
	A.page.on('crash', () => {
		A.crashed = true;
		console.log('[A crash] the tab crashed');
	});
	await A.page.route('**/__wild/**', (/** @type {any} */ route) => {
		const rel = decodeURIComponent(new URL(route.request().url()).pathname.split('/__wild/')[1] ?? '');
		const file = locate(rel);
		return file ? route.fulfill({ body: fs.readFileSync(file), contentType: 'application/octet-stream' }) : route.fulfill({ status: 404 });
	});
	await A.page.evaluate((answers) => {
		const s = window.__stores;
		/** @type {any} */
		const w = window;
		w.__wild = { dialogs: [], answers };
		s.confirmDialog.confirmDialog.subscribe((/** @type {any} */ d) => {
			if (!d) return;
			const answer = answers[d.id] ?? answers[d.title] ?? false;
			w.__wild.dialogs.push({ id: d.id ?? '', title: d.title, message: d.message, items: d.items ?? [], answer });
			console.log('[wild] dialog "' + (d.id || d.title) + '" → ' + answer);
			setTimeout(() => s.confirmDialog.resolveConfirm(answer), 0);
		});
	}, answers);
	return A;
}

module.exports = { warm, openWildPage };

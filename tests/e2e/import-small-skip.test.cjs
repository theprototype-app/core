// 48 F4 — A SMALL MODEL SKIPS THE IMPORT OPTIMIZER. 46 P2's auto-optimize loaded its module (importOptimize.js, which
// pulls the glTF engine and its worker) and SHA-hashed the whole file on EVERY import — even a model far under both
// thresholds, which it then placed untouched. fileHandler now measures first (the parse is already in hand): under
// 50k triangles and 2048 px textures nothing can optimize it except an asset override saying `always`, so it is
// placed as parsed — no optimizer chunk on the wire, no hash.
//
// What is asserted, on a page WITHOUT the debug hook (the hook imports every module at boot, the optimizer
// included, so only a plain session can show what an import fetches):
//  1. premise: the boot fetched no optimizer module
//  2. a 1k-triangle model dropped on the viewport is placed (the object list lists it)…
//  3. …and the network log holds no importOptimize / gltfOptimize engine / worker request, and nothing hashed the file
//  4. control: a 61k-triangle model (over the threshold) DOES load the optimizer — the gate is not just closed
//
// Counterfactual (base v1.38.0): 3 is red (importOptimize.js is fetched and the file's bytes are digested).
const h = require('./helpers.cjs');

const URL = process.env.APP_URL || h.URL;
const EVIDENCE = process.env.EVIDENCE || null;

/** an OBJ grid of n×n quads (2n² triangles) @param {number} n @param {string} name */
function gridObj(n, name) {
	const lines = ['o ' + name];
	for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++) lines.push(`v ${(x / n - 0.5).toFixed(4)} 0 ${(z / n - 0.5).toFixed(4)}`);
	const at = (x, z) => z * (n + 1) + x + 1;
	for (let z = 0; z < n; z++)
		for (let x = 0; x < n; x++) {
			lines.push(`f ${at(x, z)} ${at(x + 1, z)} ${at(x + 1, z + 1)}`);
			lines.push(`f ${at(x, z)} ${at(x + 1, z + 1)} ${at(x, z + 1)}`);
		}
	return lines.join('\n') + '\n';
}
// the optimizer = importOptimize + the engine (gltfOptimize.js, its core and worker); gltfOptimize/glbPost.js is the
// small KTX2-twin reader fileHandler has always loaded at boot (ktx2Twins), not part of it
const OPTIMIZER = /\/(importOptimize\.js|gltfOptimize\.js|gltfOptimize\/(core|optimizeWorker)\.js)|importOptimize-[\w-]+\.js|gltfOptimize-[\w-]+\.js|optimizeWorker-[\w-]+\.js/;

h.run(async () => {
	const browser = await h.launch();
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
	await ctx.addInitScript(() => {
		localStorage.setItem('hasSeenDisclaimer', 'true');
		localStorage.setItem('hasSeenWelcome', 'true');
		localStorage.setItem('toursSeen', '{"editor":true,"editor-touch":true}');
		// what the app hashes: every SHA digest's input size, from the first frame
		window.__diag = [];
		window.addEventListener('unhandledrejection', (e) => window.__diag.push('rejection: ' + (e.reason?.stack ?? e.reason)));
		window.addEventListener('drop', (e) => window.__diag.push('drop seen, files ' + (e.dataTransfer?.files?.length ?? -1) + ', default prevented ' + e.defaultPrevented), true);
		window.__digests = [];
		const orig = crypto.subtle.digest.bind(crypto.subtle);
		crypto.subtle.digest = (alg, data) => {
			window.__digests.push(data?.byteLength ?? -1);
			return orig(alg, data);
		};
	});
	const page = await ctx.newPage();
	const requests = [];
	page.on('request', (r) => requests.push(r.url()));
	page.on('response', (r) => {
		if (r.status() >= 400) console.log(`  [http ${r.status()}] ${r.url().slice(0, 200)}`);
	});
	page.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
	page.on('console', (m) => {
		if (m.type() === 'error' || m.type() === 'warning') console.log(`[console ${m.type()}] ` + m.text().slice(0, 300));
	});
	// a dev server that just started re-optimizes a dependency on first use and RELOADS the page (vite) — that wipes
	// the scene and the digest log, so an attempt only counts when no navigation happened during it
	let navigations = 0;
	page.on('framenavigated', (f) => {
		if (f === page.mainFrame()) navigations++;
	});
	await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.locator('#controls-pill').waitFor({ timeout: 90000 });
	await page.waitForTimeout(5000);
	await page.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});
	h.check(!(await page.evaluate(() => !!window.__stores)), 'premise: this is a plain session (no debug hook)');
	const boot = requests.filter((u) => OPTIMIZER.test(u));
	h.check(boot.length === 0, `premise: the boot fetched no optimizer module (${boot.join(', ') || 'none'})`);

	/** drop a model file on the viewport the way a person does (App.svelte's window drop) */
	const drop = (name, text) =>
		page.evaluate(
			({ name, text }) => {
				const file = new File([text], name, { type: 'text/plain' });
				const dt = new DataTransfer();
				dt.items.add(file);
				const canvas = document.querySelector('canvas');
				const r = canvas.getBoundingClientRect();
				canvas.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
				return file.size;
			},
			{ name, text }
		);
	const listed = async (name) => {
		if (!(await page.locator('#object-list').isVisible().catch(() => false))) {
			await page.locator('#controls-pill [title="Object list (O)"]').first().click().catch(() => {});
			await page.waitForTimeout(800);
		}
		return page.evaluate((n) => [...document.querySelectorAll('#object-list .obj-row')].some((r) => r.textContent.includes(n)), name);
	};

	// ---------- 2 + 3. a 1k-triangle model ----------
	const small = gridObj(23, 'SmallGrid'); // 1058 triangles
	let attempt = null;
	for (let i = 0; i < 3 && !attempt; i++) {
		const nav0 = navigations;
		const before = requests.length;
		await page.evaluate(() => (window.__digests.length = 0));
		// diagnostic: open the list FIRST, then sample its rows every 200 ms through the import
		await listed('nothing-yet');
		await page.evaluate(() => {
			window.__rows = [];
			const t = performance.now();
			const iv = setInterval(() => {
				const n = document.querySelectorAll('#object-list .obj-row').length;
				const last = window.__rows[window.__rows.length - 1];
				if (!last || last[1] !== n) window.__rows.push([Math.round(performance.now() - t), n]);
			}, 200);
			setTimeout(() => clearInterval(iv), 20000);
		});
		const t0 = Date.now();
		const size = await drop('SmallGrid.obj', small);
		let placed = false;
		for (let t = 0; t < 60 && !placed && navigations === nav0; t++) {
			placed = await listed('SmallGrid');
			if (!placed) await page.waitForTimeout(1000);
		}
		await page.waitForTimeout(1500);
		if (navigations !== nav0) {
			console.log('  the page reloaded during the attempt (a fresh dev server re-optimizing) — again on the settled page');
			await page.locator('#controls-pill').waitFor({ timeout: 90000 });
			await page.waitForTimeout(5000);
			continue;
		}
		if (placed) console.log('  placed after ~' + (Date.now() - t0) + ' ms');
		attempt = { placed, size, after: requests.slice(before).filter((u) => OPTIMIZER.test(u)), digests: await page.evaluate(() => window.__digests.slice()) };
	}
	console.log('  diag: ' + JSON.stringify(await page.evaluate(() => window.__diag)) + ' rows over time: ' + JSON.stringify(await page.evaluate(() => window.__rows)));
	if (!attempt?.placed) {
		await drop('SmallAgain.obj', gridObj(23, 'SmallAgain'));
		await page.waitForTimeout(8000);
		console.log('  diag: a second drop placed: ' + (await listed('SmallAgain')) + ' / the first now: ' + (await listed('SmallGrid')) + ' / ' + JSON.stringify(await page.evaluate(() => window.__diag)));
	}
	h.check(!!attempt?.placed, 'F4: a 1k-triangle model dropped on the viewport is placed (the object list lists it)');
	h.check(!!attempt && attempt.after.length === 0, `F4: …without fetching the optimizer (network log: ${attempt?.after.join(', ') || 'no optimizer request'})`);
	h.check(!!attempt && !attempt.digests.includes(attempt.size), `F4: …and without hashing the file (${attempt?.size} bytes; digests seen: ${JSON.stringify(attempt?.digests)})`);
	if (EVIDENCE) await page.screenshot({ path: EVIDENCE + '/01-small-placed.png' }).catch(() => {});

	// ---------- 4. control: over the threshold the optimizer is loaded ----------
	const big = gridObj(175, 'BigGrid'); // 61250 triangles
	const before2 = requests.length;
	await drop('BigGrid.obj', big);
	await h.eventually(() => Promise.resolve(requests.slice(before2).filter((u) => OPTIMIZER.test(u))), (v) => v.length > 0, 'F4 control: a 61k-triangle model (over the 50k threshold) does load the optimizer', 30000);

	await browser.close();
});

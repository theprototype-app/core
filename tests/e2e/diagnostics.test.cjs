// 27-B (hardening audit H4) — A FAILURE LEAVES A TRACE, AND THE USER CAN HAND IT OVER.
//
// Before this, `src/lib` held 135 `console.log` calls against 17 console.error/warn, and
// there was no `window.onerror` or `unhandledrejection` handler anywhere in src. So an
// uncaught error inside a store subscriber silently broke that subscriber chain, and a
// user had no way to say what happened beyond "it stopped working".
//
// What this suite pins:
//   1. the ring holds the LAST 300 lines (oldest dropped, newest kept)
//   2. the bundle carries version/time/agent AND the session section that App.svelte
//      registers — the seam that keeps diagnostics.js a zero-store leaf
//   3. an uncaught ERROR reaches the ring, the `lastUncaught` store and ONE sticky toast
//   4. an unhandled REJECTION takes the same path
//   5. the toast's "Copy diagnostics" button is wired (it answers either way: the
//      clipboard is not granted in headless, and the fallback path still reports)
//   6. Settings ▸ About offers the same button
//
// The deliberate throws are safe for the runner: helpers' FATAL_ERROR only matches
// svelte RENDER crashes (each_key_duplicate, effect_update_depth_exceeded, …), and a
// plain Error message matches none of them.
//
// Run: APP_URL=https://theprototype.app:5175/ npm run e2e -- diagnostics
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const peer = await h.setupPage(browser, 'diagnostics');
	const page = peer.page;
	await page.waitForFunction(() => !!window.__stores?.diagnostics, { timeout: 30000 });
	h.check(true, 'premise: the diagnostics module is live in the app');

	// ---- 1. the ring caps, dropping the OLDEST ------------------------------------
	const ring = await page.evaluate(() => {
		const d = window.__stores.diagnostics;
		d.clearDiagnostics();
		for (let i = 0; i < 320; i++) d.log('info', 'test', 'line ' + i);
		const lines = d.lines();
		return { n: lines.length, first: lines[0], last: lines[lines.length - 1] };
	});
	h.check(ring.n === 300, `the ring holds 300 lines, not 320 (${ring.n})`);
	h.check(/line 20\b/.test(ring.first), `the OLDEST line is dropped first: ${ring.first}`);
	h.check(/line 319\b/.test(ring.last), `the NEWEST line is kept: ${ring.last}`);

	// ---- 2. the bundle, and the registered section --------------------------------
	const bundle = await page.evaluate(() => window.__stores.diagnostics.bundle());
	h.check(
		!!bundle.version && !!bundle.at && typeof bundle.ua === 'string',
		`the bundle carries version (${bundle.version}), time and user agent`
	);
	h.check(Array.isArray(bundle.lines) && bundle.lines.length === 300, 'the bundle carries the ring');
	const session = bundle.sections?.session;
	h.check(
		!!session && 'peerId' in session && 'objects' in session && 'roster' in session,
		`App.svelte's session section is registered and readable: ${JSON.stringify(session)}`
	);
	h.check(
		session && typeof session.peerId === 'string' && session.peerId.length > 0,
		'the section reads the live peer id through the store, not an import of it'
	);

	// a section that throws must not be able to break the bundle
	const resilient = await page.evaluate(() => {
		const d = window.__stores.diagnostics;
		const off = d.registerDiagnosticsSection('broken', () => {
			throw new Error('section-boom');
		});
		const b = d.bundle();
		off();
		return { broken: b.sections.broken, stillHasSession: !!b.sections.session };
	});
	h.check(
		JSON.stringify(resilient.broken ?? '').includes('section-boom') && resilient.stillHasSession,
		'a section that throws is recorded as failed and the rest of the bundle survives'
	);

	// ---- 3. an uncaught error ------------------------------------------------------
	await page.evaluate(() => {
		window.__stores.diagnostics.clearDiagnostics();
		setTimeout(() => {
			throw new Error('boom-diagnostics');
		}, 0);
	});
	await page.waitForTimeout(800);
	const caught = await page.evaluate(() => {
		const d = window.__stores.diagnostics;
		let last = null;
		d.lastUncaught.subscribe((/** @type {any} */ v) => (last = v))();
		return { lines: d.lines(), last };
	});
	h.check(
		caught.lines.some((/** @type {string} */ l) => l.includes('boom-diagnostics')),
		'an uncaught error lands in the ring'
	);
	h.check(
		!!caught.last && String(caught.last.message).includes('boom-diagnostics'),
		'…and in the lastUncaught store the toast mirrors'
	);
	const toast = page.locator('text=Something went wrong').first();
	await toast.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
	h.check(await toast.isVisible().catch(() => false), 'one sticky toast says something went wrong');

	// ---- 4. an unhandled rejection takes the same path -----------------------------
	await page.evaluate(() => {
		window.__stores.diagnostics.clearDiagnostics();
		Promise.reject(new Error('rejected-diagnostics'));
	});
	await page.waitForTimeout(600);
	const rejected = await page.evaluate(() => window.__stores.diagnostics.lines());
	h.check(
		rejected.some((/** @type {string} */ l) => l.includes('rejected-diagnostics') && l.includes('[promise]')),
		'an unhandled rejection lands in the ring, scoped to promise'
	);

	// ---- 5. the toast's button is wired --------------------------------------------
	// Headless grants no clipboard permission, so the honest assertion is that pressing
	// it REPORTS — copied, or could not copy. Either proves the action ran.
	const copyButton = page.getByRole('button', { name: 'Copy diagnostics' }).first();
	if (await copyButton.isVisible().catch(() => false)) {
		await copyButton.click();
		await page.waitForTimeout(500);
		const reported = await page.evaluate(() =>
			document.body.innerText.includes('Diagnostics copied') || document.body.innerText.includes('Could not copy')
		);
		h.check(reported, 'the toast button assembles the bundle and reports the outcome');
	} else {
		h.check(false, 'the sticky toast offers a Copy diagnostics button');
	}

	// the bundle text is valid JSON a user can paste into an issue
	const text = await page.evaluate(() => window.__stores.diagnostics.bundleText());
	let parsed = null;
	try {
		parsed = JSON.parse(text);
	} catch {
		/* left null */
	}
	h.check(!!parsed && !!parsed.version, 'the clipboard payload is valid JSON carrying the version');

	// ---- 6. Settings ▸ About offers it too ------------------------------------------
	await page.evaluate(() => window.__stores.settingsOpen.set(true));
	await page.waitForTimeout(700);
	await page.getByText('About', { exact: true }).first().click().catch(() => {});
	await page.waitForTimeout(500);
	h.check(
		await page.locator('#about-copy-diagnostics').isVisible().catch(() => false),
		'Settings ▸ About offers Copy diagnostics'
	);
	await page.evaluate(() => window.__stores.settingsOpen.set(false));

	await h.finish(browser);
});

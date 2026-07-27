// RW (ship-qa B1/B4) — the first-visit welcome overlay and the what's-new badge.
// Single page, no signaling needed. This suite deliberately does NOT use
// h.setupPage: that helper pre-sets `hasSeenWelcome` so every OTHER suite runs
// without the overlay in the way, and the whole point here is the first-visit path.
const h = require('./helpers.cjs');

/** Fresh context with debug stores but a virgin first-run state. */
async function firstVisitPage(browser, seed) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
	await ctx.addInitScript((seed) => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
		// seeds are INITIAL values only: addInitScript re-runs on every navigation, so
		// overwriting here would undo what the app itself wrote before a reload.
		if (seed)
			for (const [k, v] of Object.entries(seed)) {
				if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
			}
	}, seed || null);
	const page = await ctx.newPage();
	page.on('pageerror', (err) => console.log('[pageerror] ' + err.stack));
	await page.goto(h.URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForFunction(() => window.__stores && !!window.__stores.whatsNew, { timeout: 30000 });
	await page.waitForTimeout(600);
	return { ctx, page };
}

h.run(async () => {
	const browser = await h.launch();

	// --- first visit: the welcome overlay --------------------------------------
	const A = await firstVisitPage(browser);
	h.check(await A.page.locator('#welcome-overlay').isVisible(), 'RW: first visit opens the welcome overlay');
	h.check(
		(await A.page.locator('#welcome-overlay').innerText()).includes('peer'),
		'RW: overlay explains the peer-to-peer pitch'
	);

	// the version line comes from the V1 vite define (…-dev off the dev server)
	const verText = await A.page.locator('#welcome-overlay .welcome-ver').innerText();
	h.check(/\d+\.\d+\.\d+(-dev)? \(([0-9a-f]{7,}|unknown)\)/.test(verText), 'RW: overlay shows the baked version (' + verText + ')');

	// "Start building" closes it and remembers that
	await A.page.locator('#welcome-start').click();
	await A.page.waitForTimeout(300);
	h.check(!(await A.page.locator('#welcome-overlay').isVisible()), 'RW: Start building closes the overlay');
	h.check(
		(await A.page.evaluate(() => localStorage.getItem('hasSeenWelcome'))) === 'true',
		'RW: closing records hasSeenWelcome'
	);

	// first visit also counts the current version as seen, so no update badge can
	// fire on top of the welcome
	const seenAfterWelcome = await A.page.evaluate(() => localStorage.getItem('lastSeenVersion'));
	h.check(!!seenAfterWelcome, 'RW: first visit marks the current version seen (' + seenAfterWelcome + ')');
	h.check(
		!(await A.page.locator('#logo-menu .update-dot').isVisible().catch(() => false)),
		'RW: no update dot on a first visit'
	);

	// --- second visit: nothing greets the user ---------------------------------
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.whatsNew, { timeout: 30000 });
	await A.page.waitForTimeout(600);
	h.check(!(await A.page.locator('#welcome-overlay').isVisible()), 'RW: a returning user gets no overlay');
	await A.ctx.close();

	// --- a returning user on a NEW version: badge + toast, never a modal -------
	const B = await firstVisitPage(browser, { hasSeenWelcome: 'true', lastSeenVersion: '0.0.0-old' });
	h.check(!(await B.page.locator('#welcome-overlay').isVisible()), 'RW: version change shows no boot modal');
	h.check(await B.page.locator('#logo-menu .update-dot').isVisible(), 'RW: version change dots the logo menu');
	h.check(
		(await B.page.locator('.tp-toast-text').first().innerText()).includes('Updated to'),
		'RW: version change toasts once'
	);

	// the toast action opens the changelog window and clears the badge. Target the
	// toast's own action button — the sidebar has a "What's new" row with the same label.
	await B.page.locator('.tp-toast .tp-toast-action', { hasText: "What's new" }).first().click();
	await B.page.waitForTimeout(400);
	h.check(await B.page.locator('#whats-new-window').isVisible(), 'RW: the toast action opens the changelog window');
	const body = await B.page.locator('#whats-new-window .wn-body').innerText();
	h.check(body.includes('1.0.0'), 'RW: changelog renders the release heading');
	h.check(body.length > 400, 'RW: changelog renders real content (' + body.length + ' chars)');
	// markdown was parsed into real elements, not dumped raw
	const wn = B.page.locator('#whats-new-window .wn-body');
	h.check(
		(await wn.locator('li').count()) > 3 &&
			(await wn.locator('h2').count()) >= 1 &&
			(await wn.locator('strong').count()) >= 1 &&
			!body.includes('**'),
		'RW: markdown is rendered (headings, bullets, bold — no raw ** left)'
	);
	// maintainer HTML comments never reach the user-facing window
	h.check(!body.includes('<!--') && !body.includes('maintainer notes'), 'RW: HTML comments are stripped');
	h.check(
		!(await B.page.locator('#logo-menu .update-dot').isVisible().catch(() => false)),
		'RW: opening the changelog clears the dot'
	);
	const seen = await B.page.evaluate(() => localStorage.getItem('lastSeenVersion'));
	h.check(seen && seen !== '0.0.0-old', 'RW: opening the changelog marks this version seen (' + seen + ')');

	// Esc closes the window
	await B.page.locator('#whats-new-window').press('Escape');
	await B.page.waitForTimeout(250);
	h.check(!(await B.page.locator('#whats-new-window').isVisible()), 'RW: Esc closes the changelog window');

	// a reload no longer nags
	await B.page.reload({ waitUntil: 'domcontentloaded' });
	await B.page.waitForFunction(() => window.__stores && !!window.__stores.whatsNew, { timeout: 30000 });
	await B.page.waitForTimeout(600);
	h.check(
		!(await B.page.locator('#logo-menu .update-dot').isVisible().catch(() => false)),
		'RW: the update cue does not come back after being seen'
	);

	// --- the logo menu always has a way back ----------------------------------
	await B.page.locator('#logo-menu').click();
	await B.page.waitForTimeout(250);
	await B.page.locator('#open-whats-new').click();
	await B.page.waitForTimeout(350);
	h.check(await B.page.locator('#whats-new-window').isVisible(), 'RW: the logo menu reopens the changelog');

	// --- the "announce new versions" setting silences the cue -----------------
	const C = await firstVisitPage(browser, {
		hasSeenWelcome: 'true',
		lastSeenVersion: '0.0.0-old',
		showWhatsNewNotice: 'false'
	});
	h.check(
		!(await C.page.locator('#logo-menu .update-dot').isVisible().catch(() => false)),
		'RW: announce-off means no dot on a new version'
	);
	// no UPDATE toast (unrelated toasts, e.g. a signaling-server warning in headless,
	// are none of this feature's business)
	h.check(
		(await C.page.locator('.tp-toast-text', { hasText: 'Updated to' }).count()) === 0,
		'RW: announce-off means no update toast'
	);

	// --- "show welcome on start" brings the overlay back ----------------------
	const D = await firstVisitPage(browser, { hasSeenWelcome: 'true', showWelcomeOnStart: 'true' });
	h.check(await D.page.locator('#welcome-overlay').isVisible(), 'RW: show-on-start reopens the overlay for a returning user');

	await h.finish(browser);
});

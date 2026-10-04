// 36 I4 — THE SETTINGS SEARCH: label + group + section + keywords, highlights what matched,
// Esc clears (a second Esc closes), and a section added in its own file is searchable by the
// words on its root (`data-keywords`) with no line of Settings.svelte naming it.
// Run: APP_URL=https://theprototype.app:5321/ npm run e2e -- settings-search-36
const h = require('./helpers.cjs');
const path = require('node:path');

const SHOTS = process.env.EVIDENCE_DIR || '/home/deck/.code/lanes-30/after-36/36-ui-polish';

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 860 } } });
	const page = A.page;
	await page.evaluate(() => window.__stores.settingsOpen.set(true));
	await page.waitForSelector('#settings-search', { timeout: 10000 });

	/** visible setting rows' first line of text */
	const visibleRows = () =>
		page.evaluate(() =>
			[...document.querySelectorAll('.setting-row')]
				.filter((r) => /** @type {HTMLElement} */ (r).offsetParent !== null)
				.map((r) => (r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50))
		);
	const search = async (q) => {
		await page.fill('#settings-search', q);
		await page.waitForTimeout(600); // the sections expand + the observer re-applies
	};

	// a search expands every section, so this is the number of rows that exist
	const mounted = () => page.evaluate(() => document.querySelectorAll('.setting-row').length);
	// ---- a keyword the labels never say: "dark" -> the Theme row (and not all of Interface)
	await search('dark');
	let rows = await visibleRows();
	let all = await mounted();
	h.check(rows.some((r) => /^Theme\b/i.test(r) || /UI theme/i.test(r)), `"dark" finds the Theme row through its keywords (${JSON.stringify(rows.map((r) => r.slice(0, 20)))})`);
	h.check(rows.length > 0 && rows.length <= 4, `...and only rows it describes (${rows.length} of ${all})`);

	// ---- a direct word does NOT drag in a whole section ("shadow" = the shadow rows)
	await search('shadow');
	rows = await visibleRows();
	h.check(rows.length > 0 && rows.length <= 4, `"shadow" lists the shadow rows, not all of Scene (${rows.length})`);

	// ---- every word must match: "snap comfort" (the Snap turn row's keyword + its label)
	await search('snap comfort');
	rows = await visibleRows();
	h.check(rows.length === 1 && /Snap turn/.test(rows[0]), `"snap comfort" narrows to Snap turn (${JSON.stringify(rows)})`);

	// ---- a section-wide word is a FALLBACK: "headset" names no row, so VR's rows answer
	// the RULE, checked whichever way the word falls: rows that say it are the answer; when none
	// does, the section that declares it answers (VR's own words: headset / quest / xr)
	for (const word of ['headset', 'xr']) {
		await search(word);
		const r = await page.evaluate((word) => {
			const vr = [...document.querySelectorAll('h2')].find((x) => /^\s*VR\s*$/.test(x.textContent || ''))?.nextElementSibling;
			const rowsAll = [...document.querySelectorAll('.setting-row')];
			const saying = rowsAll.filter((r) => (r.textContent || '').toLowerCase().includes(word));
			const vis = rowsAll.filter((r) => /** @type {HTMLElement} */ (r).offsetParent !== null);
			return {
				saying: saying.length,
				vis: vis.length,
				visSay: vis.every((r) => (r.textContent || '').toLowerCase().includes(word)),
				allVr: !!vr && vis.every((r) => vr.contains(r))
			};
		}, word);
		h.check(
			r.vis > 0 && (r.saying ? r.visSay : r.allVr),
			`"${word}": ${r.saying ? 'the rows that say it, and only those' : "no row says it, so VR's own words answer"} (${r.vis} shown, ${r.saying} say it)`
		);
	}

	// ---- highlight: the label words are marked through the Custom Highlight API
	await search('grid');
	const marks = await page.evaluate(() => {
		const hl = /** @type {any} */ (CSS).highlights?.get('settings-match');
		if (!hl) return { n: 0, texts: [] };
		const texts = [...hl].map((/** @type {Range} */ r) => r.toString().toLowerCase());
		return { n: texts.length, texts: [...new Set(texts)] };
	});
	h.check(marks.n > 0 && marks.texts.every((t) => t === 'grid'), `matches are highlighted (${marks.n} ranges: ${marks.texts.join(',')})`);
	await page.screenshot({ path: path.join(SHOTS, 'settings-search-grid.png') }).catch(() => {});

	// ---- a section another lane adds, in its own file: the words on its ROOT are searched
	// (searching keeps every section's body mounted while the stand-in is injected)
	await search('e');
	await page.evaluate(() => {
		// stand-in for e.g. 36-preload's LoadingSettings: one row under a root with data-keywords,
		// mounted inside an existing section's body (what a one-line mount in Settings.svelte does)
		const body = [...document.querySelectorAll('h2')].find((x) => /Scene/.test(x.textContent || ''))?.nextElementSibling;
		const root = document.createElement('div');
		root.id = 'zz-lane-section';
		root.setAttribute('data-keywords', 'hologram placeholder stuck');
		root.innerHTML = '<p class="ui-section-label">Loading</p><div class="setting-row">Loading placeholders</div>';
		body?.appendChild(root);
	});
	await search('hologram');
	rows = await visibleRows();
	h.check(rows.length === 1 && /Loading placeholders/.test(rows[0]), `a lane's section is found by the words on its root (${JSON.stringify(rows)})`);

	// ---- Esc clears the search and keeps Settings open; the next Esc closes it
	await page.focus('#settings-search');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);
	const after = await page.evaluate(() => ({
		q: /** @type {HTMLInputElement} */ (document.getElementById('settings-search'))?.value,
		open: !!document.getElementById('settings-search')
	}));
	h.check(after.q === '' && after.open, `Esc clears the search and keeps Settings open (q="${after.q}", open ${after.open})`);
	h.check(
		await page.evaluate(() => [...document.querySelectorAll('.setting-row')].every((r) => /** @type {HTMLElement} */ (r).style.display !== 'none')),
		'no row is left hidden'
	);
	const cleared = await page.evaluate(() => /** @type {any} */ (CSS).highlights?.get('settings-match')?.size ?? 0);
	h.check(cleared === 0, `the highlight is gone with the query (${cleared})`);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);
	const closed = await page.evaluate(() => {
		let v;
		window.__stores.settingsOpen.subscribe((x) => (v = x))();
		return v;
	});
	h.check(!closed, `the second Esc closes Settings (${closed})`);
	await h.finish(browser);
});

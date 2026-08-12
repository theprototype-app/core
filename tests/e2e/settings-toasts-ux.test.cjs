// U-3: toast robustness + settings search. Duplicate plain-string toasts
// collapse to one; the settings modal has a search box that filters rows.
// (The broader visual restructure of Settings/Toasts is screenshot-driven and
// left to the design loop.)
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- toast dedupe: identical strings collapse; action toasts don't --------
	const counts = await A.page.evaluate(() => {
		const { showToast } = window.__stores;
		showToast('same message');
		showToast('same message');
		showToast('same message');
		showToast('action one', [{ label: 'A', action: () => {} }]);
		showToast('action one', [{ label: 'A', action: () => {} }]);
		let store = [];
		window.__stores.toastStore.subscribe((l) => (store = l))();
		return {
			dupStrings: store.filter((t) => t === 'same message').length,
			actionToasts: store.filter((t) => typeof t !== 'string' && t.text === 'action one').length
		};
	});
	h.check(counts.dupStrings === 1, `duplicate string toasts collapse to one (${counts.dupStrings})`);
	h.check(counts.actionToasts === 2, `action toasts are not deduped (${counts.actionToasts})`);

	// --- settings search filters rows -----------------------------------------
	await A.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await A.page.waitForTimeout(500);
	h.check(await A.page.locator('#settings-search').isVisible(), 'settings search box is present');

	// expand the Scene section (holds the "Shadow quality" row) then search
	await A.page.getByText('Scene', { exact: true }).first().click();
	await A.page.waitForTimeout(300);
	await A.page.locator('#settings-search').fill('shadow');
	await A.page.waitForTimeout(300);

	const filtered = await A.page.evaluate(() => {
		const rows = [...document.querySelectorAll('.setting-row')];
		const shown = rows.filter((r) => r.style.display !== 'none');
		const hidden = rows.filter((r) => r.style.display === 'none');
		return {
			shown: shown.length,
			hidden: hidden.length,
			shownAllMatch: shown.every((r) => (r.textContent || '').toLowerCase().includes('shadow'))
		};
	});
	h.check(filtered.hidden > 0, `search hides non-matching rows (${filtered.hidden} hidden)`);
	h.check(filtered.shown > 0 && filtered.shownAllMatch, `only rows matching "shadow" remain (${filtered.shown} shown)`);

	// clearing via the X button restores the rows (the button only exists with a query)
	h.check(await A.page.locator('#settings-search-clear').isVisible(), 'a clear (X) button shows while a query is entered');
	await A.page.locator('#settings-search-clear').click();
	await A.page.waitForTimeout(300);
	const restored = await A.page.evaluate(() => ({
		hidden: [...document.querySelectorAll('.setting-row')].filter((r) => r.style.display === 'none').length,
		query: document.querySelector('#settings-search').value,
		clearGone: !document.querySelector('#settings-search-clear')
	}));
	h.check(restored.query === '' && restored.hidden === 0, `the X clears the query and restores every row (${restored.hidden} still hidden)`);
	h.check(restored.clearGone, 'and the X button disappears once the box is empty');

	await h.finish(browser);
});

// Phase 197: Explorer grid keyboard nav + folder selection highlight + Scene
// double-click expand. Arrows move the selection (highlight), Enter opens a
// folder, Backspace goes up a level, Esc closes the window.
const h = require('./helpers.cjs');

const activeFolder = (A) => A.page.evaluate(() => { let v; window.__stores.explorer.activeFolder.subscribe((x) => (v = x))(); return v; });
const selName = (A) =>
	A.page.evaluate(() => document.querySelector('#explorer-list .border-primary-600')?.textContent?.trim() ?? null);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(async () => {
		const s = window.__stores;
		s.explorer.createFolder('Models', null);
		s.explorer.createFolder('Textures', null);
		s.explorer.createFolder('Audio', null);
		localStorage.setItem('explorerHeight', '470');
		try { s.bottomDock.bottomDockActive.set('explorer'); } catch {}
		try { s.explorerClose.set(false); } catch {}
	});
	await A.page.evaluate(() => { try { window.__stores.explorerClose.set(true); window.__stores.explorerClose.set(false); } catch {} });
	await A.page.waitForTimeout(900);

	// click the first folder card -> selected (highlight) + grid focused
	await A.page.locator('#explorer-list .explorer-folder-card').first().click();
	await A.page.waitForTimeout(200);
	const first = await selName(A);
	h.check(!!first, `single-click selects + highlights a folder (${first})`);

	// ArrowRight moves the selection to a different entry
	await A.page.keyboard.press('ArrowRight');
	await A.page.waitForTimeout(150);
	const second = await selName(A);
	h.check(!!second && second !== first, `ArrowRight moves the selection (${first} -> ${second})`);

	// Enter opens the selected folder (navigates into it)
	await A.page.keyboard.press('Enter');
	await A.page.waitForTimeout(200);
	const inside = await activeFolder(A);
	h.check(typeof inside === 'string' && inside !== null && inside !== 'prefabs', `Enter opens the selected folder (activeFolder=${inside})`);

	// Backspace goes up one level (back to Library root = null)
	await A.page.locator('#explorer-list [role="region"]').first().focus();
	await A.page.keyboard.press('Backspace');
	await A.page.waitForTimeout(200);
	const up = await activeFolder(A);
	h.check(up === null, `Backspace goes up to the Library root (activeFolder=${up})`);

	// Esc closes the Explorer window
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(300);
	const closed = await A.page.evaluate(() => { let v; window.__stores.explorerClose.subscribe((x) => (v = x))(); return v; });
	h.check(closed === true, 'Esc closes the Explorer');

	await h.finish(browser);
});

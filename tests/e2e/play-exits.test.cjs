// Phase 42: Esc leaves play mode (even when pointer lock never engaged); Exit VR tile resets.
const h = require('./helpers.cjs');

const lockedState = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.isLocked.subscribe((v) => r(v))()));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// enter play mode via the play button
	await A.page.locator('i.fa-play').click();
	await h.eventually(() => lockedState(A.page), (v) => v === true, 'play mode engaged');

	// menu hides in play mode
	const menuHidden = await A.page.evaluate(
		() => document.querySelector('.burger')?.closest('div.hidden') != null ||
			[...document.querySelectorAll('div')].some((d) => d.className === 'hidden' && d.querySelector('.burger'))
	);
	h.check(menuHidden, 'editor menu hidden in play mode');

	// Esc exits back to edit mode (works with or without a real pointer lock)
	await A.page.keyboard.press('Escape');
	await h.eventually(() => lockedState(A.page), (v) => v !== true, 'Escape leaves play mode');
	await A.page.waitForTimeout(300);
	const menuBack = await A.page.evaluate(() => {
		const burger = document.querySelector('.burger');
		return !!burger && !burger.closest('div.hidden');
	});
	h.check(menuBack, 'editor UI restored after Escape');

	// round-trip again after the 2s re-entry guard
	await A.page.waitForTimeout(2200);
	await A.page.locator('i.fa-play').click();
	await h.eventually(() => lockedState(A.page), (v) => v === true, 'play re-enters after the guard');
	await A.page.keyboard.press('Escape');
	await h.eventually(() => lockedState(A.page), (v) => v !== true, 'second Escape works too');

	// Exit VR action resets the VR flag (session end is a no-op outside XR)
	const vrReset = await A.page.evaluate(() => {
		window.__stores.isVRMode.set(true);
		window.__stores.vrControls.executeVRMenuAction('exitvr');
		return new Promise((r) => window.__stores.isVRMode.subscribe((v) => r(v))());
	});
	h.check(vrReset === false, 'Exit VR tile resets VR mode');

	await h.finish(browser);
});

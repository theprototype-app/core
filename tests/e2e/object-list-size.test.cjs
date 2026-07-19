// The Object List floating window used to be capped at 50% width / 70% height (a CSS
// max-width/max-height the other floating windows don't have). That cap is removed, so
// it can grow as large as the Node editor (up to the viewport). The cap was also why a
// grouped Object List rendered smaller than its shared tab-group rect.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.setViewportSize({ width: 1200, height: 800 });
	await A.page.evaluate(() => window.__stores.objectListClose.set(false));
	await A.page.waitForTimeout(400);

	const resized = await A.page.evaluate(async () => {
		const win = document.getElementById('object-list');
		const grip = win.querySelector('.resize-handle');
		const r = grip.getBoundingClientRect();
		// grab the corner grip and drag it toward the bottom-right corner of the viewport
		grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 2, clientY: r.top + 2, pointerId: 4, pointerType: 'mouse' }));
		window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 1150, clientY: 760, pointerId: 4, pointerType: 'mouse' }));
		window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 1150, clientY: 760, pointerId: 4, pointerType: 'mouse' }));
		await new Promise((res) => setTimeout(res, 150));
		const b = win.getBoundingClientRect();
		return { w: Math.round(b.width), h: Math.round(b.height), vw: window.innerWidth, vh: window.innerHeight };
	});
	h.check(resized.w > resized.vw * 0.6, `Object List resizes wider than the old 50% cap (w=${resized.w}, vw=${resized.vw})`);
	h.check(resized.h > resized.vh * 0.72, `Object List resizes taller than the old 70% cap (h=${resized.h}, vh=${resized.vh})`);

	await h.finish(browser);
});

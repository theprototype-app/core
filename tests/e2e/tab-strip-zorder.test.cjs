// A tab group's strip used to be pinned at the top of the window z-band (z-index 44),
// so another floating window dragged in front of the group still had its strip painted
// on top. The strip now tracks its group's active-member z, so a raised window covers it.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// three floating windows: Object List + Flow Code (to be grouped) + Animation
	await A.page.evaluate(() => {
		localStorage.setItem('flowCodeDocked', 'false');
		localStorage.setItem('animationDocked', 'false');
	});
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		s.objectActions.selectObject(g.children[g.children.length - 1].uuid);
		s.objectListClose.set(false);
		s.flowCodeClose.set(false);
		s.animationClose.set(false);
	});
	await A.page.waitForTimeout(700);

	// merge Object List + Flow Code into a tab group (forms a strip)
	const merged = await A.page.evaluate(async () => {
		const ol = document.getElementById('object-list');
		const fc = document.getElementById('flow-code-window');
		const olr = ol.getBoundingClientRect();
		const handle = fc.querySelector('.move-handle');
		const fr = handle.getBoundingClientRect();
		const ev = (t, type, x, y) => t.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 5 }));
		ev(handle, 'pointerdown', fr.left + 40, fr.top + 8);
		ev(window, 'pointermove', olr.left + olr.width / 2, olr.top + 10);
		ev(window, 'pointerup', olr.left + olr.width / 2, olr.top + 10);
		await new Promise((r) => setTimeout(r, 250));
		return !!document.querySelector('.tab-strip');
	});
	h.check(merged, 'merging two windows forms a tab group with a strip');

	// raise the SEPARATE Animation window (click its header) -> it should cover the strip
	const z = await A.page.evaluate(async () => {
		const anim = document.getElementById('animation-window');
		const ar = anim.getBoundingClientRect();
		anim.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: ar.left + 30, clientY: ar.top + 5, pointerId: 6 }));
		anim.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 6 }));
		await new Promise((r) => setTimeout(r, 150));
		const strip = document.querySelector('.tab-strip');
		return {
			strip: parseInt(strip.style.zIndex || getComputedStyle(strip).zIndex),
			anim: parseInt(getComputedStyle(anim).zIndex)
		};
	});
	h.check(z.anim >= z.strip, `a floating window raised over a tab group covers its strip (anim z=${z.anim} >= strip z=${z.strip})`);

	await h.finish(browser);
});

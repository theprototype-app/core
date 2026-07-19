// Bug fix: moving a tab GROUP (multiple floating windows merged into one) used to
// leave the window behind while the tab strip flew off — the member's reactive
// style="width/height" attribute wiped the left/top that windowTabs sets. With
// style:width/height directives the member keeps its position, so the strip and its
// window move together.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// open the Object List + an undocked Flow Code window
	await A.page.evaluate(() => {
		localStorage.setItem('flowCodeDocked', 'false');
	});
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.evaluate(() => {
		window.__stores.objectListClose.set(false);
		window.__stores.flowCodeClose.set(false);
	});
	await A.page.waitForTimeout(700);

	// merge: drag the Flow Code header onto the Object List header (windowTabs drag-merge)
	const merged = await A.page.evaluate(async () => {
		const ol = document.getElementById('object-list');
		const fc = document.getElementById('flow-code-window');
		if (!ol || !fc) return { ok: false };
		const olr = ol.getBoundingClientRect();
		const handle = fc.querySelector('.move-handle');
		const fr = handle.getBoundingClientRect();
		const ev = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 5 }));
		ev(handle, 'pointerdown', fr.left + 40, fr.top + 8);
		ev(window, 'pointermove', olr.left + olr.width / 2, olr.top + 10); // over the OL header
		ev(window, 'pointerup', olr.left + olr.width / 2, olr.top + 10);
		await new Promise((r) => setTimeout(r, 250));
		return { ok: true, strip: !!document.querySelector('.tab-strip') };
	});
	h.check(merged.ok, 'both windows are present to merge');
	h.check(merged.strip, 'dragging one window onto another forms a tab group with a tab strip');

	// move the group by dragging the strip background; the visible member must follow
	const moved = await A.page.evaluate(async () => {
		const strip = document.querySelector('.tab-strip');
		const sr = strip.getBoundingClientRect();
		const ev = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 6 }));
		// pointerdown on the strip background (not a tab/button), then move on window
		ev(strip, 'pointerdown', sr.left + 6, sr.top + 16);
		ev(window, 'pointermove', sr.left + 86, sr.top + 66);
		ev(window, 'pointerup', sr.left + 86, sr.top + 66);
		await new Promise((r) => setTimeout(r, 200));
		const strip2 = document.querySelector('.tab-strip').getBoundingClientRect();
		// the active member is the visible one (not display:none)
		const members = ['#object-list', '#flow-code-window']
			.map((s) => document.querySelector(s))
			.filter((n) => n && getComputedStyle(n).display !== 'none');
		const win = members[0]?.getBoundingClientRect();
		return { stripLeft: Math.round(strip2.left), stripTop: Math.round(strip2.top), winLeft: Math.round(win?.left), winTop: Math.round(win?.top), moved: Math.round(strip2.left - sr.left) };
	});
	h.check(moved.moved > 40, `dragging the strip moves the group (dx=${moved.moved})`);
	h.check(
		Math.abs(moved.winLeft - moved.stripLeft) < 6 && Math.abs(moved.winTop - moved.stripTop) < 6,
		`the window stays aligned under its tab strip after moving (strip ${moved.stripLeft},${moved.stripTop} vs window ${moved.winLeft},${moved.winTop})`
	);

	await h.finish(browser);
});

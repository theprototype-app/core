// Clicking the Object List toolbar button raises the (floating) window to the front
// instead of just toggling it closed, so calling it when it is behind other windows
// brings it forward. Clicking it again while it is already at the front closes it.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// two floating windows: the Object List + an undocked Flow Code
	await A.page.evaluate(() => localStorage.setItem('flowCodeDocked', 'false'));
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.evaluate(() => {
		window.__stores.objectListClose.set(false);
		window.__stores.flowCodeClose.set(false);
	});
	await A.page.waitForTimeout(600);

	// bring Flow Code to the front so the Object List is behind it
	await A.page.evaluate(() => {
		const fc = document.getElementById('flow-code-window');
		const r = fc.getBoundingClientRect();
		fc.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 30, clientY: r.top + 5, pointerId: 1 }));
		fc.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
	});
	await A.page.waitForTimeout(150);
	const before = await A.page.evaluate(() => ({
		ol: +getComputedStyle(document.getElementById('object-list')).zIndex,
		fc: +getComputedStyle(document.getElementById('flow-code-window')).zIndex
	}));
	h.check(before.fc >= before.ol, `Flow Code sits above the Object List to start (ol=${before.ol}, fc=${before.fc})`);

	// click the Object List toolbar button -> it raises to the front (does NOT close)
	await A.page.evaluate(() => document.querySelector('p[title="Object list (O)"]').click());
	await A.page.waitForTimeout(200);
	const after = await A.page.evaluate(() => {
		let closed;
		window.__stores.objectListClose.subscribe((v) => (closed = v))();
		return {
			ol: +getComputedStyle(document.getElementById('object-list')).zIndex,
			fc: +getComputedStyle(document.getElementById('flow-code-window')).zIndex,
			closed
		};
	});
	h.check(!after.closed && after.ol >= after.fc, `clicking Object List raises it to the front, not close (ol=${after.ol}, fc=${after.fc}, closed=${after.closed})`);

	// clicking again while it is already at the front closes it
	await A.page.evaluate(() => document.querySelector('p[title="Object list (O)"]').click());
	await A.page.waitForTimeout(200);
	const closed = await A.page.evaluate(() => {
		let v;
		window.__stores.objectListClose.subscribe((x) => (v = x))();
		return v;
	});
	h.check(closed === true, 'clicking Object List again while it is at the front closes it');

	await h.finish(browser);
});

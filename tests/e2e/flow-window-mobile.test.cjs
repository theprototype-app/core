// Roadmap #9 fix: the Flow floating window (undocked) was persisted at 760px wide,
// so on a narrow (mobile) viewport its header Dock/X buttons ran off the right edge
// and couldn't be reached. It now clamps to the viewport on load + on resize.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// preset an over-wide undocked window, then open the flow on a narrow viewport
	await A.page.evaluate(() => {
		localStorage.setItem('flowWinW', '760');
		localStorage.setItem('flowWinH', '480');
		localStorage.setItem('flowDocked', 'false');
	});
	await A.page.setViewportSize({ width: 420, height: 780 });
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.objectActions, { timeout: 30000 });
	await A.page.evaluate(() => window.__stores.flowGraphClose.set(false));
	await A.page.waitForTimeout(600);

	const r = await A.page.evaluate(() => {
		const win = document.querySelector('#flow-window');
		const dock = document.querySelector('#flow-dock');
		if (!win || !dock) return { ok: false };
		const w = win.getBoundingClientRect();
		const d = dock.getBoundingClientRect();
		return { ok: true, winRight: w.right, winW: w.width, dockRight: d.right, dockLeft: d.left, vw: window.innerWidth };
	});
	h.check(r.ok, 'the floating flow window is present');
	h.check(r.winW <= r.vw, `window width clamped to the viewport (${Math.round(r.winW)} <= ${r.vw})`);
	h.check(r.dockRight <= r.vw + 1 && r.dockLeft >= 0, `the Dock button is on-screen (right=${Math.round(r.dockRight)}, vw=${r.vw})`);

	// resizing the viewport smaller re-clamps
	await A.page.setViewportSize({ width: 340, height: 700 });
	await A.page.waitForTimeout(300);
	const r2 = await A.page.evaluate(() => {
		const w = document.querySelector('#flow-window').getBoundingClientRect();
		return { winW: w.width, vw: window.innerWidth };
	});
	h.check(r2.winW <= r2.vw, `window re-clamps on viewport resize (${Math.round(r2.winW)} <= ${r2.vw})`);

	await h.finish(browser);
});

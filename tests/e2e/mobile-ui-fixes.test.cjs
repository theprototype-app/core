// Roadmap #9 small fixes: the object-list window clamps to the viewport (its
// subgroups were clipped off-screen on a narrow window), and context menus portal
// to <body> so the Flow menu escapes the flow window's stacking context (was
// trapped below other windows).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// #5: a rect persisted wide reopens clamped inside a narrow viewport
	await A.page.evaluate(() => localStorage.setItem('objectListRect', JSON.stringify({ left: 900, top: 80, width: 600, height: 400 })));
	await A.page.setViewportSize({ width: 520, height: 420 });
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.objectActions, { timeout: 30000 });
	await A.page.evaluate(() => window.__stores.objectListClose.set(false));
	await A.page.waitForTimeout(500);
	const r = await A.page.evaluate(() => {
		const w = document.querySelector('#object-list').getBoundingClientRect();
		return { left: w.left, top: w.top, right: w.right, bottom: w.bottom, vw: window.innerWidth, vh: window.innerHeight };
	});
	h.check(
		r.left >= -1 && r.top >= -1 && r.right <= r.vw + 1 && r.bottom <= r.vh + 1,
		`object-list window clamps into the viewport (right=${Math.round(r.right)}/${r.vw}, bottom=${Math.round(r.bottom)}/${r.vh})`
	);

	// #6: context menus portal to <body> (so the Flow menu isn't trapped below windows)
	await A.page.evaluate(() => window.__stores.viewportMenu.set({ x: 60, y: 60, point: [0, 0, 0] }));
	await A.page.waitForTimeout(200);
	const portal = await A.page.evaluate(() => {
		const m = document.querySelector('[role="menu"]');
		return { inBody: !!m && m.parentElement === document.body, z: m ? parseInt(getComputedStyle(m).zIndex) : 0 };
	});
	h.check(portal.inBody, 'context menu is portaled to <body>');
	h.check(portal.z >= 1000, `context menu z is above the window tiers (z=${portal.z})`);
	await A.page.evaluate(() => window.__stores.viewportMenu.set(null));

	await h.finish(browser);
});

// Roadmap #9 fixes: flowbite modals (settings/modules/sessions) sit on the modal
// tier ABOVE the persistent avatar/Connect chrome (their X was covered), and the
// export-settings panel renders viewport-centered (not off the left edge — it used
// to be trapped by .app-sidebar's backdrop-filter containing block).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// Settings modal is on the modal tier (>= 1100, above the ~998 avatar chrome)
	await A.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await A.page.waitForTimeout(500);
	const z = await A.page.evaluate(() => {
		const d = document.querySelector('[role="dialog"][aria-modal="true"]');
		return d ? parseInt(getComputedStyle(d).zIndex) : null;
	});
	h.check(z !== null && z >= 1100, `settings modal is on the modal tier, above the avatar (z=${z})`);
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));
	await A.page.waitForTimeout(200);

	// export-settings panel opens viewport-centered + fully on-screen
	await A.page.evaluate(() => window.__stores.closeMenu.set(false)); // open the sidebar
	await A.page.waitForTimeout(400);
	await A.page.locator('#export-settings-cog').click();
	await A.page.waitForTimeout(300);
	const rect = await A.page.evaluate(() => {
		const el = document.querySelector('#export-settings-modal');
		const r = el.getBoundingClientRect();
		return { left: r.left, right: r.right, vw: window.innerWidth, cx: (r.left + r.right) / 2 };
	});
	h.check(rect.left >= 0 && rect.right <= rect.vw, `export settings fully on-screen (left=${Math.round(rect.left)}, right=${Math.round(rect.right)}, vw=${rect.vw})`);
	h.check(Math.abs(rect.cx - rect.vw / 2) < 6, `export settings centered on the viewport (cx=${Math.round(rect.cx)}, half=${rect.vw / 2})`);

	await h.finish(browser);
});

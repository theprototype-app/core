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
		const cog = document.querySelector('#export-settings-cog').getBoundingClientRect();
		const m = document.querySelector('#export-settings-modal').getBoundingClientRect();
		return { cogBottom: cog.bottom, cogLeft: cog.left, top: m.top, left: m.left, right: m.right, bottom: m.bottom, vw: window.innerWidth, vh: window.innerHeight };
	});
	h.check(rect.left >= 0 && rect.right <= rect.vw && rect.bottom <= rect.vh, `export settings fully on-screen (left=${Math.round(rect.left)}, right=${Math.round(rect.right)}, bottom=${Math.round(rect.bottom)})`);
	h.check(rect.top >= rect.cogBottom - 1, `export settings opens below the cog (top=${Math.round(rect.top)} >= cogBottom=${Math.round(rect.cogBottom)})`);
	h.check(Math.abs(rect.left - rect.cogLeft) < 24, `export settings anchors to the cog, not centered (mLeft=${Math.round(rect.left)}, cogLeft=${Math.round(rect.cogLeft)})`);

	await h.finish(browser);
});

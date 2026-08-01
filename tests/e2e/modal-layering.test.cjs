// Roadmap #9 fixes: flowbite modals (settings/modules/sessions) sit on the modal
// tier ABOVE the persistent avatar/Connect chrome (their X was covered), and the
// export-settings panel renders viewport-centered (not off the left edge — it used
// to be trapped by .app-sidebar's backdrop-filter containing block).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// Settings modal renders in the browser TOP LAYER (flowbite 1.x = native <dialog>
	// + showModal) - above ALL page chrome by definition; z-index tiers no longer apply
	await A.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await A.page.waitForTimeout(500);
	const modal = await A.page.evaluate(() => {
		const d = document.querySelector('dialog.tp-modal-frame');
		return { exists: !!d, topLayer: !!d && d.matches(':modal') };
	});
	h.check(modal.exists && modal.topLayer, 'settings modal is a native top-layer dialog (above all chrome)');
	// E1 guarantee survives top layer: a pending approval's container is a MANUAL
	// POPOVER shown after the dialog, so it stacks above the modal
	const approvalAbove = await A.page.evaluate(async () => {
		const s = window.__stores;
		let before;
		s.pendingApprovals.subscribe((v) => (before = v))();
		s.pendingApprovals.set([{ peerId: 'e2etest', status: 'new' }]);
		await new Promise((r) => setTimeout(r, 300));
		const el = document.querySelector('.toasts-critical');
		const open = !!el && el.matches(':popover-open');
		s.pendingApprovals.set(before ?? []);
		return open;
	});
	h.check(approvalAbove, 'pending approval popover enters the top layer above the open modal');
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

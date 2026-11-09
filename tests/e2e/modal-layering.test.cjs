// Roadmap #9 fixes: flowbite modals (settings/modules/sessions) sit on the modal
// tier ABOVE the persistent avatar/Connect chrome (their X was covered), and the
// export-settings panel renders viewport-centered (not off the left edge — it used
// to be trapped by .app-sidebar's backdrop-filter containing block). 41b H14: that panel is the
// Save options modal now.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// App modals are NON-MODAL native dialogs (modal={false} -> dialog.show()):
	// no top layer, no inertness — they sit on the --z-modal tier (1100) so the
	// chrome ABOVE that tier (approval toasts 1200, logo menu 1300, ThemedSelect
	// portals 9999) stays visible AND clickable while a modal is open.
	await A.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await A.page.waitForTimeout(500);
	const modal = await A.page.evaluate(() => {
		const d = document.querySelector('dialog.tp-modal-frame');
		return {
			exists: !!d,
			nonModal: !!d && !d.matches(':modal'),
			z: d ? parseInt(getComputedStyle(d).zIndex) : null
		};
	});
	h.check(modal.exists && modal.nonModal && modal.z >= 1100, `settings modal is a NON-modal dialog on the modal tier (z=${modal.z})`);
	// the E1 guarantee, now with CLICKABILITY: an approval toast renders above the
	// open modal and its Approve button takes a REAL mouse click
	const approvalClickable = await A.page.evaluate(async () => {
		const s = window.__stores;
		let before;
		s.pendingApprovals.subscribe((v) => (before = v))();
		s.pendingApprovals.set([{ peerId: 'e2etest', status: 'new' }]);
		await new Promise((r) => setTimeout(r, 300));
		const btn = [...document.querySelectorAll('.toasts-critical button')].find((b) => /approve/i.test(b.textContent));
		if (!btn) { s.pendingApprovals.set(before ?? []); return { found: false }; }
		const r = btn.getBoundingClientRect();
		const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
		const clickable = !!hit && (hit === btn || btn.contains(hit));
		s.pendingApprovals.set(before ?? []);
		return { found: true, clickable };
	});
	h.check(approvalClickable.found && approvalClickable.clickable, 'approval toast is hit-testable ABOVE the open modal');
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));
	await A.page.waitForTimeout(200);

	// 41b H14: Save options (the burger's Save ▾ — it replaced the cog's anchored popup) opens as an
	// app modal, fully on-screen — rendered at the Sidebar ROOT, never trapped by .app-sidebar's
	// backdrop-filter containing block
	await A.page.evaluate(() => window.__stores.closeMenu.set(false)); // open the sidebar
	await A.page.waitForTimeout(400);
	// showhide-v8 §6: Save options is the last item of the burger's Save as… menu
	await A.page.waitForSelector('#project-save-as', { timeout: 5000 });
	await A.page.locator('#project-save-as').click();
	await A.page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Save options…' }).click();
	await A.page.waitForSelector('#save-options-modal', { state: 'visible', timeout: 5000 });
	const rect = await A.page.evaluate(() => {
		const m = document.querySelector('#save-options-modal .wc, #save-options-modal > *')?.getBoundingClientRect() ?? document.querySelector('#save-options-modal').getBoundingClientRect();
		return { top: m.top, left: m.left, right: m.right, bottom: m.bottom, vw: window.innerWidth, vh: window.innerHeight, inSidebar: !!document.querySelector('#sidebar70 #save-options-modal') };
	});
	h.check(rect.left >= 0 && rect.right <= rect.vw && rect.top >= 0 && rect.bottom <= rect.vh, `Save options fully on-screen (left=${Math.round(rect.left)}, right=${Math.round(rect.right)}, bottom=${Math.round(rect.bottom)})`);
	h.check(!rect.inSidebar, 'Save options is not rendered inside the blurred sidebar');
	await A.page.locator('#save-options-cancel').click();

	await h.finish(browser);
});

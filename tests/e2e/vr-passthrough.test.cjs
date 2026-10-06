// Phase 90: VR passthrough — the preference persists, the hidden XR button
// requests immersive-ar when it's on, the quick-menu tile toggles it with a
// heads-up toast, and passthroughActive lifts the local sky (background+fog)
// while the replicated environment state stays untouched. The actual
// passthrough look on a headset is the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// 4a: BOTH hidden XR buttons mount permanently (they used to swap on the
	// preference, a remount that races a same-gesture mode pick), so a label no longer
	// says which mode is aimed — `#vrButton[data-aim]` does. The labels still prove
	// each button asks for the session KIND it is supposed to ask for.
	const labelOf = (sel) =>
		A.page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? '', sel);
	const aim = () =>
		A.page.evaluate(() => document.getElementById('vrButton')?.dataset.aim ?? '');

	const vrLabel = await labelOf('#vrButtonVr button');
	const arLabel = await labelOf('#vrButtonAr button');
	h.check(
		vrLabel.includes('VR') && arLabel.includes('AR'),
		`both hidden buttons are mounted, one per mode (vr:"${vrLabel}" ar:"${arLabel}")`
	);
	h.check((await aim()) === 'vr', 'immersive-vr is aimed by default');

	// the quick-menu tile flips the preference (real VR user path)
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('settings:passthrough')); // 187: moved into the VR settings panel
	await A.page.waitForTimeout(400);
	const toastShown = await A.page.getByText(/takes effect on the next VR entry/).first().isVisible().catch(() => false);
	h.check(toastShown, 'tile toggle explains it applies next session');
	const persisted = await A.page.evaluate(() => localStorage.getItem('vrPassthrough'));
	h.check(persisted === 'true', 'preference persisted');
	h.check((await aim()) === 'ar', 'the aim moves to immersive-ar');
	h.check(
		(await labelOf('#vrButtonAr button')).includes('AR'),
		'the aimed button is the immersive-ar one'
	);

	// passthroughActive is a LOCAL view mode: sky+fog lift, env state untouched
	const envBefore = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.environment.environment.subscribe((e) => resolve(JSON.stringify(e)))();
			})
	);
	const lifted = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.passthroughActive.set(true);
				window.__stores.globalScene.subscribe((scene) => {
					resolve({ background: scene.background, fog: scene.fog });
				})();
			})
	);
	h.check(lifted.background === null && lifted.fog === null, 'passthrough lifts background and fog');
	const restored = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.passthroughActive.set(false);
				window.__stores.globalScene.subscribe((scene) => {
					resolve(scene.background ? scene.background.getHexString() : null);
				})();
			})
	);
	h.check(restored === '3b4048', `exiting restores the preset sky (#${restored})`);
	const envAfter = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.environment.environment.subscribe((e) => resolve(JSON.stringify(e)))();
			})
	);
	h.check(envBefore === envAfter, 'replicated environment state untouched');

	// 98: the Settings row is a RED switch and flipping it toasts the heads-up
	await A.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await A.page.waitForTimeout(500);
	// 111: the passthrough switch lives in the VR section (first accordion) now
	await A.page.locator('#settings-nav .sn-row', { hasText: 'VR' }).first().click();
	await A.page.waitForTimeout(400);
	// 37-settings: the kit Toggle (a real <button aria-pressed>); the red "armed" colour gave way
	// to the one accent every toggle uses (docs/settings-inventory.md, VR row 19)
	const toggle = A.page.locator('#passthrough-toggle');
	h.check((await toggle.count()) === 1, 'passthrough renders as a Toggle switch');
	const pressed = await toggle.getAttribute('aria-pressed');
	h.check(pressed === 'true' || pressed === 'false', `the switch says its state (aria-pressed=${pressed})`);
	await toggle.click();
	await A.page.waitForTimeout(400);
	const toastAfterToggle = await A.page
		.getByText(/takes effect on the next VR entry/)
		.first()
		.isVisible()
		.catch(() => false);
	h.check(toastAfterToggle, 'flipping the switch explains the deferred apply');
	const nowOff = await A.page.evaluate(() => localStorage.getItem('vrPassthrough'));
	h.check(nowOff === 'false', 'switch writes the preference');
	await toggle.click({ force: true }); // back on for the reload check
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));
	await A.page.waitForTimeout(300);

	// survives a reload (localStorage-backed store + button swap)
	await A.page.reload();
	// wait for the debug hook, not a timer: it loads after boot and missed a fixed 2.5 s once
	await A.page.waitForFunction(() => !!(/** @type {any} */ (window).__stores?.vrPassthrough), null, { timeout: 30000 });
	await A.page.waitForTimeout(500);
	const aimAfterReload = await aim();
	const still = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.vrPassthrough.subscribe((v) => resolve(v))();
			})
	);
	h.check(
		still === true && aimAfterReload === 'ar',
		`passthrough preference survives reload (aim=${aimAfterReload})`
	);

	await h.finish(browser);
});

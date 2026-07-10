// Phase 90: VR passthrough — the preference persists, the hidden XR button
// requests immersive-ar when it's on, the quick-menu tile toggles it with a
// heads-up toast, and passthroughActive lifts the local sky (background+fog)
// while the replicated environment state stays untouched. The actual
// passthrough look on a headset is the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const buttonLabel = () =>
		A.page.evaluate(() => document.querySelector('#vrButton button')?.textContent?.trim() ?? '');

	let label = await buttonLabel();
	h.check(label.includes('VR'), `hidden button requests immersive-vr by default (${label})`);

	// the quick-menu tile flips the preference (real VR user path)
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('passthru'));
	await A.page.waitForTimeout(400);
	const toastShown = await A.page.getByText(/takes effect on the next VR entry/).first().isVisible().catch(() => false);
	h.check(toastShown, 'tile toggle explains it applies next session');
	const persisted = await A.page.evaluate(() => localStorage.getItem('vrPassthrough'));
	h.check(persisted === 'true', 'preference persisted');
	label = await buttonLabel();
	h.check(label.includes('AR'), `button now requests immersive-ar (${label})`);

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

	// survives a reload (localStorage-backed store + button swap)
	await A.page.reload();
	await A.page.waitForTimeout(2500);
	label = await buttonLabel();
	const still = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.vrPassthrough.subscribe((v) => resolve(v))();
			})
	);
	h.check(still === true && label.includes('AR'), `passthrough preference survives reload (${label})`);

	await h.finish(browser);
});

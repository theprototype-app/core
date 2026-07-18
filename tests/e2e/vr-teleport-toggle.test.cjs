// Phase 157: teleport locomotion can be turned off. The pure teleportArms
// helper decides the arc arms on an up-flick; the vrTeleportEnabled setting
// gates updateTeleport so that when off, engaging the stick never arms the arc.
// Persists across reload. On-device feel is manual.
const h = require('./helpers.cjs');

// a right-stick-UP flick session (arms teleport when enabled)
const UP = { inputSources: [{ handedness: 'right', gamepad: { axes: [0, 0, 0, -0.9] } }] };

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- pure arm decision ---
	const arms = await A.page.evaluate(() => {
		const f = window.__stores.vrControls.teleportArms;
		return { up: f(0, -0.9), sideways: f(0.9, -0.5), down: f(0, 0.5) };
	});
	h.check(arms.up === true, 'an up-flick arms the arc');
	h.check(arms.sideways === false && arms.down === false, 'sideways / down do not arm');

	// --- enabled (default): engaging the stick arms + shows the arc ---
	const on = await A.page.evaluate((up) => {
		const s = window.__stores;
		s.vrTeleportEnabled.set(true);
		s.vrControls.updateTeleport(up);
		let scene; s.globalScene.subscribe((v) => (scene = v))();
		return { engaged: s.vrControls.teleportState().engaged, arc: !!scene?.getObjectByName('teleport-arc')?.visible };
	}, UP);
	h.check(on.engaged === true, 'with teleport ON, an up-flick arms the arc');
	h.check(on.arc === true, 'the teleport arc shows when armed');

	// --- disabled: engaging the stick does NOT arm; arc hidden ---
	const off = await A.page.evaluate((up) => {
		const s = window.__stores;
		s.vrTeleportEnabled.set(false);
		s.vrControls.updateTeleport(up);
		let scene; s.globalScene.subscribe((v) => (scene = v))();
		return { engaged: s.vrControls.teleportState().engaged, arc: !!scene?.getObjectByName('teleport-arc')?.visible };
	}, UP);
	h.check(off.engaged === false, 'with teleport OFF, an up-flick does not arm');
	h.check(off.arc === false, 'the arc stays hidden when teleport is off');

	// --- persists across reload ---
	await A.page.evaluate(() => localStorage.setItem('vrTeleportEnabled', 'false'));
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => !!window.__stores && !!window.__stores.vrControls, { timeout: 30000 });
	await A.page.waitForTimeout(400);
	const persisted = await A.page.evaluate(() => {
		let v; window.__stores.vrTeleportEnabled.subscribe((x) => (v = x))();
		return v;
	});
	h.check(persisted === false, 'the teleport setting persists across reload');

	await h.finish(browser);
});

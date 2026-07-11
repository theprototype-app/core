// Phase 111: VR window grab — the anchor-relative offset math (compose /
// inverse round-trip), the grab-hold timer, applyWindowPose (including the
// adjust-mode bypass), persistence across reloads, and the Settings ▸ VR
// section with its reset button. The in-headset grip feel is the user's
// manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- pure math: compose ∘ inverse round-trips, identity without offset ---
	const math = await A.page.evaluate(() => {
		const w = window.__stores.vrWindowPoses;
		const THREE = window.__stores.THREE;
		const anchor = {
			position: new THREE.Vector3(1, 1.4, -0.6),
			quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7)
		};
		const identity = w.composePose(anchor, null);
		// a world pose the user dragged the window to
		const worldPos = new THREE.Vector3(1.3, 1.2, -0.9);
		const worldQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.4);
		const offset = w.offsetFromWorld(anchor, worldPos, worldQuat, 1.6);
		const back = w.composePose(anchor, offset);
		// the SAME offset follows a moved anchor (the window keeps riding the hand)
		const anchor2 = {
			position: new THREE.Vector3(-2, 1.0, 0.4),
			quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -1.2)
		};
		const moved = w.composePose(anchor2, offset);
		const localOffsetLength = new THREE.Vector3().fromArray(offset.pos).length();
		const movedDistance = moved.position.distanceTo(anchor2.position);
		return {
			identityPos: identity.position.toArray(),
			identityScale: identity.scale,
			backPos: back.position.toArray(),
			backQuat: back.quaternion.toArray(),
			backScale: back.scale,
			worldPos: worldPos.toArray(),
			worldQuat: worldQuat.toArray(),
			offsetKeepsDistance: Math.abs(localOffsetLength - movedDistance) < 1e-6,
			hold: [w.holdProgress(1000, 1000), w.holdProgress(1000, 1300), w.holdProgress(1000, 2000)]
		};
	});
	h.check(
		math.identityPos.join(',') === '1,1.4,-0.6' && math.identityScale === 1,
		'no offset composes to the bare anchor'
	);
	const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
	h.check(
		near(math.backPos, math.worldPos) && near(math.backQuat, math.worldQuat) && math.backScale === 1.6,
		'offsetFromWorld ∘ composePose round-trips the dragged pose'
	);
	h.check(math.offsetKeepsDistance, 'the stored offset rides a moved anchor rigidly');
	h.check(
		math.hold[0] === 0 && math.hold[1] === 0.5 && math.hold[2] === 1,
		`hold timer maps 600ms to 0..1 clamped (${math.hold.join('/')})`
	);

	// --- applyWindowPose: applies composed pose, skips while adjusting ---
	const apply = await A.page.evaluate(() => {
		const w = window.__stores.vrWindowPoses;
		const THREE = window.__stores.THREE;
		const group = new THREE.Group();
		const anchor = {
			position: new THREE.Vector3(0, 1, 0),
			quaternion: new THREE.Quaternion()
		};
		w.saveWindowPose('testwin', { pos: [0.2, 0.1, 0], quat: [0, 0, 0, 1], scale: 1.5 });
		const applied = w.applyWindowPose(group, 'testwin', anchor);
		const pos = group.position.toArray();
		const scale = group.scale.x;
		// detached windows are driven by vrControls — the follower must not fight
		w.vrWindowAdjust.set({ id: 'testwin', index: 0 });
		group.position.set(9, 9, 9);
		const skipped = w.applyWindowPose(group, 'testwin', anchor);
		const posWhileAdjust = group.position.toArray();
		w.vrWindowAdjust.set(null);
		return { applied, pos, scale, skipped, posWhileAdjust };
	});
	h.check(
		apply.applied === true && near(apply.pos, [0.2, 1.1, 0]) && apply.scale === 1.5,
		`applyWindowPose composes the saved offset (${apply.pos.map((v) => v.toFixed(2))} ×${apply.scale})`
	);
	h.check(
		apply.skipped === false && apply.posWhileAdjust.join(',') === '9,9,9',
		'the follower skips while that window is being adjusted'
	);

	// --- persistence: survives a reload, reset clears ---
	const stored = await A.page.evaluate(() => localStorage.getItem('vrWindowPoses'));
	h.check(!!stored && stored.includes('testwin'), 'poses persist to localStorage');
	await A.page.reload();
	await A.page.waitForFunction(() => !!window.__stores?.vrWindowPoses, { timeout: 20000 });
	await A.page.waitForTimeout(500);
	const rehydrated = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.vrWindowPoses.windowPoses.subscribe((p) => resolve(p?.testwin?.scale))();
			})
	);
	h.check(rehydrated === 1.5, `saved poses rehydrate on boot (${rehydrated})`);

	// --- Settings ▸ VR: first accordion, reset button clears poses ---
	await A.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await A.page.waitForTimeout(500);
	const firstHeader = await A.page.evaluate(() => {
		const buttons = [...document.querySelectorAll('.modal-content button')];
		return buttons.find((b) => /VR|Scene|Shortcuts|About/.test(b.textContent))?.textContent.trim();
	});
	h.check(firstHeader === 'VR', `the VR section leads the settings accordion (${firstHeader})`);
	await A.page.locator('.modal-content button', { hasText: 'VR' }).first().click();
	await A.page.waitForTimeout(300);
	await A.page.locator('#vr-reset-poses').click();
	await A.page.waitForTimeout(300);
	const afterReset = await A.page.evaluate(() => ({
		storage: localStorage.getItem('vrWindowPoses'),
		poses: (() => {
			let p;
			window.__stores.vrWindowPoses.windowPoses.subscribe((x) => (p = x))();
			return Object.keys(p ?? {}).length;
		})()
	}));
	h.check(
		afterReset.storage === null && afterReset.poses === 0,
		'Reset positions clears the stored window poses'
	);
	const toastShown = await A.page.evaluate(() =>
		document.body.textContent.includes('VR menu positions reset')
	);
	h.check(toastShown, 'reset confirms with a toast');

	await h.finish(browser);
});

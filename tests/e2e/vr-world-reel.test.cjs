// 33 (G2): THE STICK REELS WHAT YOU HOLD, the world included. The Quest report (Untangle):
// "I can make bigger/smaller the globe but cannot use up/down on stick to move it further/
// closer ... just as in edit mode for objects". Two core seams:
//
//   1. the one-hand world PAN (a right grip on scenery/air in Edit, or in Interact when the play
//      block says `locomotion.worldGrab`): that hand's stick Y now reels the world along the
//      hand's ray with Edit's own object reel (grabStickAdjust) — forward pushes it away, back
//      pulls it in — starting from the distance to the gripped spot;
//   2. `api.claimInput('sticks')`: a module that reads the sticks itself (Untangle's held globe:
//      Y reels, X scales) stands BOTH sticks' navigation down — left-stick move, right-stick
//      snap turn and teleport — and the call answers true (an older core: undefined).
//
// Driven through the REAL per-frame path with a fake XR session (fakeXR.cjs) and a spec-accurate
// reference space (installSpace), so the head pose is what a headset would report.
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');

const grip = async (page, hand, down) => {
	await xr.button(page, hand, 1, down);
	await page.waitForTimeout(250);
};
/**
 * A SPEC-ACCURATE right hand: a headset reports controller poses IN the current reference space,
 * so when the world pan offsets that space the controller's world pose moves with it (that is
 * what lets the pan self-correct). fakeXR writes controller matrices directly; this re-derives
 * the hand from its BASE-space pose on every setReferenceSpace, synchronously, as a runtime would.
 * @param {any} page */
const specHands = (page) =>
	page.evaluate(() => {
		const r = window.__fakeXR.renderer;
		window.__specHands = {};
		window.__specSync = () => {
			const space = r.xr.getReferenceSpace();
			if (!space?.__m) return;
			const inv = space.__m.clone().invert();
			for (const [slot, base] of Object.entries(window.__specHands)) {
				const c = r.xr.getController(Number(slot));
				c.matrix.copy(inv.clone().multiply(base));
				c.updateMatrixWorld(true);
			}
		};
		const set = r.xr.setReferenceSpace.bind(r.xr);
		r.xr.setReferenceSpace = (space) => {
			set(space);
			window.__specSync();
		};
	});
/** pose the right hand in BASE space (yaw 0 aims -Z) @param {any} page @param {number[]} pos @param {{pitch?: number}} [aim] */
const specRight = (page, pos, aim = {}) =>
	page.evaluate(({ pos, aim }) => {
		const THREE = window.__stores.THREE;
		const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(aim.pitch ?? 0, 0, 0, 'YXZ'));
		window.__specHands[1] = new THREE.Matrix4().compose(new THREE.Vector3(...pos), q, new THREE.Vector3(1, 1, 1));
		window.__specSync();
	}, { pos, aim });
const debug = (page) => page.evaluate(() => window.__stores.vrControls.vrGripDebug());
/** hold a stick for `ms`, then centre it */
const hold = async (page, hand, x, y, ms) => {
	await xr.stick(page, hand, x, y);
	await page.waitForTimeout(ms);
	await xr.stick(page, hand, 0, 0);
	await page.waitForTimeout(150);
};

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');

	// ---- 0. the pure step: Edit's object reel on the reach -----------------------------------------
	const pure = await A.page.evaluate(() => {
		const v = window.__stores.vrControls;
		return { push: v.worldReelStep(2, -1), pull: v.worldReelStep(2, 1), dead: v.worldReelStep(2, 0.1), far: v.worldReelStep(60, -1), near: v.worldReelStep(0.05, 1) };
	});
	h.check(pure.push.push > 0.05 && Math.abs(pure.push.reach - 2.06) < 1e-9, `stick forward pushes the gripped spot away (2 m -> ${pure.push.reach.toFixed(3)} m, the grabStickAdjust share)`);
	h.check(pure.pull.push < -0.05 && Math.abs(pure.pull.reach - 1.94) < 1e-9, `stick back pulls it in (2 m -> ${pure.pull.reach.toFixed(3)} m)`);
	h.check(pure.dead.push === 0, 'inside the dead zone nothing moves');
	h.check(pure.far.push === 0 && pure.near.push === 0, 'clamped like an object reel (60 m out, 5 cm in)');

	// ---- the room: a floor and a wall 3 m ahead --------------------------------------------------------
	await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 600));
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const [floor, wall] = g.children.filter((c) => c.name === 'Box').slice(-2);
		floor.scale.set(20, 0.5, 20);
		floor.position.set(0, -0.25, 0);
		floor.userData.physics = { mode: 'static' };
		floor.updateMatrixWorld(true);
		wall.scale.set(10, 4, 0.5);
		wall.position.set(0, 2, -3);
		wall.userData.physics = { mode: 'static' };
		wall.updateMatrixWorld(true);
		s.objectActions.deselectObject();
		s.isVRMode.set(true);
		s.vrSnapAngle.set(45);
	});
	await A.page.waitForTimeout(500);
	await xr.install(A.page);
	await xr.installSpace(A.page, { head: [0, 1.6, 0], yaw: 0 });
	await specHands(A.page);
	await A.page.waitForTimeout(300);

	// ---- 1. EDIT: a right grip on the wall pans; its stick reels the world ---------------------------
	await specRight(A.page, [0.3, 1.6, 0]); // aims -Z at the wall's face (z -2.75)
	await grip(A.page, 'right', true);
	let d = await debug(A.page);
	h.check(d.worldPan && d.grab === null, `premise: Edit, a right grip on the wall is the world pan (${JSON.stringify(d)})`);
	h.check(Math.abs(d.panReach - 2.75) < 0.05, `the reel starts at the gripped spot: the wall's face 2.75 m along the ray (${d.panReach})`);
	let head0 = await xr.head(A.page);
	await hold(A.page, 'right', 0, -1, 500);
	let head1 = await xr.head(A.page);
	d = await debug(A.page);
	h.check(head1.z - head0.z > 0.3, `stick FORWARD pushes the world away: you end up farther from the wall (head z ${head0.z.toFixed(2)} -> ${head1.z.toFixed(2)})`);
	h.check(d.panReach > 3, `...the reach grew with it (${d.panReach.toFixed(2)} m)`);
	h.check(Math.abs(head1.z - head0.z - (d.panReach - 2.75)) < 0.05, `...by exactly the reel: the world moved what the reach grew (${(head1.z - head0.z).toFixed(3)} vs ${(d.panReach - 2.75).toFixed(3)} m)`);
	const reach1 = d.panReach;
	h.check(Math.abs(head1.yaw - head0.yaw) < 1e-6 && Math.abs(head1.x - head0.x) < 0.01 && Math.abs(head1.y - head0.y) < 0.01, `...straight along the hand's ray: no turn, no sideways or vertical drift (${JSON.stringify(head1)})`);
	await hold(A.page, 'right', 0, 1, 500);
	const head2 = await xr.head(A.page);
	d = await debug(A.page);
	h.check(head2.z < head1.z - 0.3 && d.panReach < reach1, `stick BACK pulls it closer (head z ${head1.z.toFixed(2)} -> ${head2.z.toFixed(2)}, reach ${reach1.toFixed(2)} -> ${d.panReach.toFixed(2)} m)`);
	await hold(A.page, 'right', 0, 0, 300);
	const head2b = await xr.head(A.page);
	h.check(Math.abs(head2b.z - head2.z) < 1e-6, 'the stick at rest: the world stays where the reel left it (no drift)');
	await grip(A.page, 'right', false);
	d = await debug(A.page);
	h.check(!d.worldPan && d.panReach === null, 'releasing the grip ends the pan (and its reel)');

	// ---- 2. INTERACT + locomotion.worldGrab: the same reel during a game ----------------------------
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.scenePhysics.setScenePhysics({ play: { locomotion: { worldGrab: true } } });
		s.objectActions.setEditorMode('interact');
	});
	await A.page.waitForTimeout(400);
	await grip(A.page, 'right', true);
	d = await debug(A.page);
	h.check(d.worldPan, `premise: Interact with worldGrab, the right grip pans the world (${JSON.stringify(d)})`);
	head0 = await xr.head(A.page);
	await hold(A.page, 'right', 0, -1, 400);
	head1 = await xr.head(A.page);
	h.check(head1.z - head0.z > 0.2, `Interact (worldGrab): stick forward pushes the world away too (head z ${head0.z.toFixed(2)} -> ${head1.z.toFixed(2)})`);
	await grip(A.page, 'right', false);
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.objectActions.setEditorMode('edit');
		s.scenePhysics.setScenePhysics({ play: { locomotion: null } });
	});
	await A.page.waitForTimeout(300);

	// ---- 3. api.claimInput('sticks'): both sticks' navigation stands down ----------------------------
	const claimed = await A.page.evaluate(async () => {
		const s = window.__stores;
		window.__sticks = {};
		await s.moduleSDK.initModules([
			{
				id: 'sticks-probe',
				name: 'Sticks probe',
				version: '1.0.0',
				description: 'claims the sticks',
				register(api) {
					window.__sticks.api = api;
				}
			}
		]);
		const api = window.__sticks.api;
		return { sticks: api.claimInput('sticks'), unknown: api.claimInput('nonsense'), suppressed: s.vrControls.vrNavigationSuppressed() };
	});
	h.check(claimed.sticks === true && claimed.unknown === false, `claimInput answers whether this core knows the scope ('sticks' ${claimed.sticks}, 'nonsense' ${claimed.unknown})`);
	h.check(claimed.suppressed === true, 'a claimed "sticks" stands stick navigation down (vrNavigationSuppressed)');
	await A.page.evaluate(() => window.__sticks.api.releaseInput('nonsense'));
	head0 = await xr.head(A.page);
	await hold(A.page, 'right', 1, 0, 300); // a snap turn, if the stick were free
	await hold(A.page, 'left', 0, -1, 500); // a flight forward, if the stick were free
	head1 = await xr.head(A.page);
	h.check(Math.abs(head1.yaw - head0.yaw) < 1e-6, `claimed: the right stick does not snap-turn (yaw ${head0.yaw.toFixed(3)} -> ${head1.yaw.toFixed(3)})`);
	h.check(Math.hypot(head1.x - head0.x, head1.z - head0.z) < 0.01, `claimed: the left stick does not move you (${JSON.stringify(head0)} -> ${JSON.stringify(head1)})`);
	await A.page.evaluate(() => window.__sticks.api.releaseInput('sticks'));
	await A.page.waitForTimeout(200);
	await hold(A.page, 'right', 1, 0, 300);
	await hold(A.page, 'left', 0, -1, 500);
	const head3 = await xr.head(A.page);
	h.check(Math.abs(head3.yaw - head1.yaw) > 0.5, `released: the right stick snap-turns again (yaw ${head1.yaw.toFixed(3)} -> ${head3.yaw.toFixed(3)})`);
	h.check(Math.hypot(head3.x - head1.x, head3.z - head1.z) > 0.2, 'released: the left stick moves you again');

	await A.page.evaluate(() => window.__stores.moduleSDK.deactivateModule('sticks-probe'));
	await xr.uninstall(A.page);
	await A.page.evaluate(() => window.__stores.isVRMode.set(false));
	await h.finish(browser);
});

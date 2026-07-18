// Phase 100: rigid grip grab — controller-as-handle pose math, stick
// reel/scale adjustments, inside-object containment pick, grab-hand stick
// gating and the grab-style cycle. On-device feel is the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const math = await A.page.evaluate(() => {
		const v = window.__stores.vrControls;
		const THREE = window.__stores.THREE;

		// rigid pose: rel offset rides the controller pose 1:1
		const pPos = new THREE.Vector3(1, 1, 0);
		const pQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
		const relPos = new THREE.Vector3(0, 0, -2); // grabbed 2m ahead
		const relQuat = new THREE.Quaternion();
		const pose = v.rigidGrabPose(pPos, pQuat, relPos, relQuat);

		// yaw 90°: local (0,0,-2) -> world (-2, 0, 0)
		const poseOk =
			Math.abs(pose.position.x - -1) < 0.001 &&
			Math.abs(pose.position.y - 1) < 0.001 &&
			Math.abs(pose.position.z - 0) < 0.001;

		// stick adjust: forward pushes away, right grows; deadzone ignores drift
		const push = v.grabStickAdjust({ length: 2, scale: 1, x: 0, y: -1 });
		const pull = v.grabStickAdjust({ length: 2, scale: 1, x: 0, y: 1 });
		const grow = v.grabStickAdjust({ length: 2, scale: 1, x: 1, y: 0 });
		const shrink = v.grabStickAdjust({ length: 2, scale: 1, x: -1, y: 0 });
		const drift = v.grabStickAdjust({ length: 2, scale: 1, x: 0.05, y: -0.05 });
		const clampLo = v.grabStickAdjust({ length: 0.01, scale: 0.001, x: -1, y: 1 });

		return {
			poseOk,
			pose: [pose.position.x, pose.position.y, pose.position.z],
			push: push.length,
			pull: pull.length,
			grow: grow.scale,
			shrink: shrink.scale,
			driftSame: drift.length === 2 && drift.scale === 1,
			clampLo: [clampLo.length, clampLo.scale]
		};
	});
	h.check(math.poseOk, `rigid pose rides the controller (${math.pose.map((v) => v.toFixed(2))})`);
	h.check(
		math.push > 2 && math.pull < 2 && math.grow > 1 && math.shrink < 1,
		`stick reels and scales the right way (push ${math.push.toFixed(2)}, pull ${math.pull.toFixed(2)}, grow ${math.grow.toFixed(3)}, shrink ${math.shrink.toFixed(3)})`
	);
	h.check(math.driftSame, 'deadzone ignores stick drift');
	h.check(math.clampLo[0] >= 0.05 && math.clampLo[1] >= 0.02, 'reel and scale clamp at their floors');

	// containment pick: a point inside a box finds it, outside finds nothing
	const contained = await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		box.position.set(3, 1, -2);
		box.updateMatrixWorld(true);
		const THREE = window.__stores.THREE;
		const inside = window.__stores.vrControls.containedTopLevel(new THREE.Vector3(3, 1.2, -2), group);
		const outside = window.__stores.vrControls.containedTopLevel(new THREE.Vector3(9, 9, 9), group);
		return { inside: inside?.uuid === box.uuid, outside: outside === null };
	});
	h.check(contained.inside && contained.outside, 'containment pick finds the surrounding object only');

	// grab-hand stick gating: a right-hand grab flags the store
	const gate = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.vrGrabbedHand.set('right');
				let hand;
				window.__stores.vrGrabbedHand.subscribe((v) => (hand = v))();
				window.__stores.vrGrabbedHand.set(null);
				resolve(hand);
			})
	);
	h.check(gate === 'right', 'grabbed-hand store gates the sticks');

	// grab style cycles rigid -> move -> rotate -> rigid and persists
	const styles = await A.page.evaluate(async () => {
		const seen = [];
		for (let i = 0; i < 3; i++) {
			window.__stores.vrControls.executeVRMenuAction('grabmode');
			seen.push(localStorage.getItem('vrGrabStyle'));
		}
		return seen;
	});
	h.check(styles.join(',') === 'move,rotate,rigid', `grab style cycles (${styles.join(' → ')})`);

	await h.finish(browser);
});

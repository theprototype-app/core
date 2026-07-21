// D6 (roadmap 13): VR ping accuracy. The radial Ping used to fire IMMEDIATELY
// from the pointer hand — on a trigger activation that ray was parked on the
// radial itself, so the ping landed wherever the menu floated. Now the sector
// ARMS a one-shot (vrPingArmed): the next trigger pings the exact pointed
// x,y,z from the firing controller; a sky-miss keeps the arm; re-opening the
// radial cancels it. The right-stick ping also resolves the POINTER hand, not
// a raw right slot. On-device feel is the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		let r;
		s.globalRenderer.subscribe((v) => (r = v))();
		if (!r) return { noRenderer: true };
		const c0 = r.xr.getController(0);
		const c1 = r.xr.getController(1);
		c0.userData.handedness = 'left';
		c1.userData.handedness = 'right';

		// pointer-hand resolution follows the menu hand
		s.vrMenuHand.set('left');
		const pointerWithLeftMenu = s.vrControls.pointerHandIndex();
		s.vrMenuHand.set('right');
		const pointerWithRightMenu = s.vrControls.pointerHandIndex();
		s.vrMenuHand.set('left');

		// --- radial Ping ARMS instead of firing ---
		s.vrMenuOpen.set(true);
		s.vrControls.executeVRMenuAction('ping');
		const armed = {
			armed: read(s.vrControls.vrPingArmed),
			menuClosed: read(s.vrMenuOpen) === false,
			pings: read(s.ping.pings).length
		};

		// --- the next trigger pings the exact pointed spot ---
		// aim the RIGHT controller 45 degrees down from (0, 1.6, 0): the ray
		// meets the ground plane at (0, 0, -1.6)
		const pose = new THREE.Matrix4().compose(
			new THREE.Vector3(0, 1.6, 0),
			new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 4),
			new THREE.Vector3(1, 1, 1)
		);
		c1.matrix.copy(pose);
		c1.updateMatrixWorld(true);
		const consumed = s.vrControls.firePingIfArmed(1);
		const fired = read(s.ping.pings);
		const last = fired[fired.length - 1];
		const disarmed = read(s.vrControls.vrPingArmed) === false;

		// --- a sky miss keeps the arm; reopening the radial cancels it ---
		s.vrControls.vrPingArmed.set(true);
		const up = new THREE.Matrix4().compose(
			new THREE.Vector3(0, 1.6, 0),
			new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
			new THREE.Vector3(1, 1, 1)
		);
		c1.matrix.copy(up);
		c1.updateMatrixWorld(true);
		const skyConsumed = s.vrControls.firePingIfArmed(1);
		const skyState = {
			consumed: skyConsumed,
			stillArmed: read(s.vrControls.vrPingArmed),
			pings: read(s.ping.pings).length
		};
		s.vrMenuOpen.set(true);
		const cancelled = read(s.vrControls.vrPingArmed) === false;
		s.vrMenuOpen.set(false);
		const idle = s.vrControls.firePingIfArmed(1);

		return {
			pointerWithLeftMenu,
			pointerWithRightMenu,
			armed,
			consumed,
			last: last && { pos: last.pos.map((v) => Math.round(v * 100) / 100) },
			disarmed,
			skyState,
			cancelled,
			idle
		};
	});

	h.check(!res.noRenderer, 'renderer is available');
	h.check(
		res.pointerWithLeftMenu === 1 && res.pointerWithRightMenu === 0,
		`pointer hand follows the menu hand (left menu -> slot 1, right menu -> slot 0)`
	);
	h.check(
		res.armed.armed && res.armed.menuClosed && res.armed.pings === 0,
		'radial Ping ARMS a one-shot and closes the ring without firing'
	);
	h.check(
		res.consumed &&
			res.last &&
			Math.abs(res.last.pos[0]) < 0.01 &&
			Math.abs(res.last.pos[1]) < 0.01 &&
			Math.abs(res.last.pos[2] + 1.6) < 0.01,
		`armed trigger pings the exact pointed spot on the ground (${JSON.stringify(res.last?.pos)})`
	);
	h.check(res.disarmed, 'a landed ping disarms the one-shot');
	h.check(
		res.skyState.consumed && res.skyState.stillArmed && res.skyState.pings === 1,
		'a sky miss consumes the trigger but keeps the arm'
	);
	h.check(res.cancelled, 'reopening the radial cancels a pending ping');
	h.check(res.idle === false, 'an unarmed trigger is never consumed');

	await h.finish(browser);
});

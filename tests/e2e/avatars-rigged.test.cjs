// 36-avatars (plan 76): rigged avatars between two REAL peers — A on a desktop, B in VR emulation.
//  1. B picks a character in the customise panel (real UI) and applies: A draws B as that rigged body
//     (userdata slot 5 is the only carrier — 76.5).
//  2. B walks (its camera moves): A's copy of B plays the walk clip, then settles back to idle (76.2,
//     derived from the camera stream on A — no message of its own).
//  3. B enters VR (fakeXR controllers) and streams its hands: A's copy reaches them with two-bone IK,
//     the floating controller box for a held side is not drawn, an out-of-reach hand falls back to it
//     (76.3).
//  4. B leaves VR: the IK lets go.
//  5. B picks Classic: A draws the floating head again and drops the rigged body.
//  6. 76.4: everything above crossed the wire as camera / vrhands / userdata — no new message type.
// Visual feel (gait, elbows, faces) is the user's on-device check; screenshots go to the evidence dir.
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');

const SHOTS = process.env.AVATAR_SHOTS || '';

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 720 } } });
	await h.connect(B, A);

	// A records every message TYPE it receives (the 76.4 budget check)
	await A.page.evaluate(() => {
		window.__types = {};
		let p;
		window.__stores.peers.subscribe((x) => (p = x))();
		Object.values(p.connections).forEach((conn) =>
			conn.on('data', (d) => {
				if (d && d.type) window.__types[d.type] = (window.__types[d.type] ?? 0) + 1;
			})
		);
	});

	const stateOn = (page, id) => page.evaluate((id) => window.__stores.avatars.avatarsDebug()[id] ?? null, id);
	const camTo = (page, pos, target) => page.evaluate(({ pos, target }) => window.__stores.objectActions.flyTo(pos, target, 0), { pos, target });

	// ---- 1. B picks the Knight in the customise panel -------------------------------------------
	await camTo(B.page, [0, 1.6, 0], [0, 1.6, -5]);
	await B.page.waitForTimeout(500);
	await B.page.evaluate(() => window.__stores.characterModalOpen.set(true));
	await B.page.waitForSelector('#character-panel');
	await B.page.click('[data-character="knight"]');
	await B.page.click('[data-hat="cap"]');
	await B.page.click('#character-apply');
	await B.page.waitForSelector('#character-panel', { state: 'detached' });
	await camTo(B.page, [0, 1.6, 0], [0, 1.6, -5]);
	await h.eventually(
		() => stateOn(A.page, B.id),
		(s) => s && s.ready && s.character === 'knight',
		"1.1 A draws B as the rigged Knight B picked (userdata slot 5)",
		20000
	);
	const s1 = await stateOn(A.page, B.id);
	h.check(s1.visible, '1.2 the body is visible once B has a camera pose');
	h.check(Math.abs(s1.feet[1] - (1.6 - 1.977)) < 0.25, `1.3 the feet hang a body-height under B's head (feet y ${s1.feet[1].toFixed(2)})`);
	const hat = await A.page.evaluate((id) => {
		let scene;
		window.__stores.globalScene.subscribe((x) => (scene = x))();
		return !!scene.getObjectByName(id + '-avatar-head');
	}, B.id);
	h.check(hat, '1.4 B\'s cap rides the rigged head');

	// ---- 2. B walks ----------------------------------------------------------------------------
	await camTo(A.page, [3, 1.5, 3], [0, 0.9, -2]);
	/** walk B forward along -Z at ~1.3 m/s, sampling A's view of B mid-stride */
	const walked = await B.page.evaluate(async () => {
		for (let i = 0; i < 40; i++) {
			const z = -i * 0.065;
			window.__stores.objectActions.flyTo([0, 1.6, z], [0, 1.6, z - 5], 0);
			await new Promise((r) => setTimeout(r, 50));
		}
		return true;
	});
	h.check(walked, '2.0 (premise) B walked 2.6 m');
	await h.eventually(
		() => stateOn(A.page, B.id),
		(s) => s && (s.top === 'walk' || s.top === 'idle'),
		'2.1 (premise) A still tracks B',
		3000
	);
	// a second stride, sampled while it happens
	const midStride = await Promise.all([
		B.page.evaluate(async () => {
			for (let i = 40; i < 80; i++) {
				const z = -i * 0.065;
				window.__stores.objectActions.flyTo([0, 1.6, z], [0, 1.6, z - 5], 0);
				await new Promise((r) => setTimeout(r, 50));
			}
		}),
		(async () => {
			await A.page.waitForTimeout(1200);
			return stateOn(A.page, B.id);
		})()
	]).then((r) => r[1]);
	h.check(midStride.top === 'walk', `2.2 A plays B's WALK clip while B moves (top ${midStride.top}, ${midStride.speed.toFixed(2)} m/s)`);
	h.check(midStride.speed > 0.8 && midStride.speed < 2.2, `2.3 the speed A derives matches B's pace (${midStride.speed.toFixed(2)} m/s)`);
	await h.eventually(
		() => stateOn(A.page, B.id),
		(s) => s && s.top === 'idle' && s.speed < 0.2,
		'2.4 ...and settles back to IDLE once B stops',
		6000
	);

	// ---- 3. B in VR: hands drive A's IK --------------------------------------------------------
	const head = [0, 1.6, -5.2];
	await camTo(B.page, head, [head[0], head[1], head[2] - 5]);
	await B.page.waitForTimeout(400);
	await xr.install(B.page);
	await B.page.evaluate(() => window.__stores.isVRMode.set(true));
	// left hand forward at chest height (reachable), right hand held far out (NOT reachable)
	const left = [head[0] + 0.25, 1.2, head[2] - 0.35];
	const right = [head[0] - 1.6, 1.4, head[2] - 0.2];
	await xr.pose(B.page, 'left', left, { yaw: 0 });
	await xr.pose(B.page, 'right', right, { yaw: 0 });
	// stream the controller poses exactly as Scene's broadcastVRHands builds them (controller branch)
	await B.page.evaluate(() => {
		const THREE = window.__stores.THREE;
		const r = window.__fakeXR.renderer;
		const pose = (i) => {
			const c = r.xr.getController(i);
			const p = new THREE.Vector3();
			const q = new THREE.Quaternion();
			c.matrixWorld.decompose(p, q, new THREE.Vector3());
			const e = new THREE.Euler().setFromQuaternion(q);
			return { pos: p.toArray(), rot: [e.x, e.y, e.z] };
		};
		window.__handsTimer = setInterval(() => {
			let peer;
			window.__stores.peers.subscribe((x) => (peer = x))();
			peer.send({ type: 'vrhands', peerId: peer.peer.id, left: pose(0), right: pose(1), active: true });
		}, 33);
	});
	await camTo(A.page, [-1.6, 1.5, head[2] - 4.2], [-0.4, 1.0, head[2]]);
	await h.eventually(
		() => stateOn(A.page, B.id),
		(s) => s && s.ik.left > 0.9,
		"3.1 A's copy of B takes B's LEFT hand with its IK (confidence > 0.9)",
		8000
	);
	const s3 = await stateOn(A.page, B.id);
	const dl = Math.hypot(s3.wrist.left[0] - left[0], s3.wrist.left[1] - left[1], s3.wrist.left[2] - left[2]);
	h.check(dl < 0.03, `3.2 the left wrist lands on B's controller (${(dl * 100).toFixed(1)} cm off)`);
	h.check(s3.ik.right < 0.3, `3.3 the out-of-reach RIGHT hand stays with the floating marker (confidence ${s3.ik.right.toFixed(2)})`);
	const markers = await A.page.evaluate((id) => {
		let scene;
		window.__stores.globalScene.subscribe((x) => (scene = x))();
		const count = (n) => {
			let k = 0;
			scene.getObjectByName(n)?.traverse((o) => o.isMesh && k++);
			return k;
		};
		let ik;
		window.__stores.avatars.avatarIkPeers.subscribe((x) => (ik = x))();
		return { left: count(id + '-hand-left'), right: count(id + '-hand-right'), flags: ik[id] ?? null };
	}, B.id);
	h.check(markers.flags?.left === true && !markers.flags?.right, `3.4 avatarIkPeers says the body holds the left hand only (${JSON.stringify(markers.flags)})`);
	h.check(markers.left === 0, `3.5 no floating box for the held left hand (${markers.left} meshes)`);
	h.check(markers.right === 2, `3.6 the right hand keeps its box + pointer (${markers.right} meshes)`);
	if (SHOTS) await A.page.screenshot({ path: SHOTS + '/04-two-peer-vr-ik.png' });

	// ---- 4. B leaves VR ------------------------------------------------------------------------
	await B.page.evaluate(() => {
		clearInterval(window.__handsTimer);
		let peer;
		window.__stores.peers.subscribe((x) => (peer = x))();
		peer.send({ type: 'vrhands', peerId: peer.peer.id, left: null, right: null, active: false });
		window.__stores.isVRMode.set(false);
	});
	await xr.uninstall(B.page);
	await h.eventually(
		() => stateOn(A.page, B.id),
		(s) => s && s.ik.left < 0.05,
		'4.1 the IK lets go when B leaves VR',
		6000
	);

	// ---- 5. Classic ----------------------------------------------------------------------------
	await B.page.evaluate(() => window.__stores.characterModalOpen.set(true));
	await B.page.waitForSelector('#character-panel');
	await B.page.click('[data-character="classic"]');
	await B.page.click('#character-apply');
	await h.eventually(
		() =>
			A.page.evaluate((id) => {
				let scene;
				window.__stores.globalScene.subscribe((x) => (scene = x))();
				return { classic: !!scene.getObjectByName(id + '-body'), rigged: !!window.__stores.avatars.avatarsDebug()[id] };
			}, B.id),
		(v) => v.classic && !v.rigged,
		'5.1 B picks Classic: A draws the floating head and drops the rigged body',
		10000
	);

	// ---- 6. the wire ---------------------------------------------------------------------------
	const types = await A.page.evaluate(() => window.__types);
	const avatarish = Object.keys(types).filter((t) => /avatar|rig|pose|ik/i.test(t) && t !== 'vrhands');
	h.check(types.camera > 20 && types.vrhands > 5 && types.userdata >= 1, `6.1 the avatar rode camera (${types.camera}) + vrhands (${types.vrhands}) + userdata (${types.userdata})`);
	h.check(avatarish.length === 0, `6.2 no avatar message type exists on the wire (${avatarish.join(',') || 'none'})`);

	await h.finish(browser);
});
